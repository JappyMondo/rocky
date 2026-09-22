import { createHash } from 'node:crypto';
import {
  validateConfiguration,
  automationSettings,
} from '@rocky/local-contracts';
import type { WorkflowContext } from '@rocky/sdk';
import type {
  EnvironmentBlocker,
  EnvironmentCapability,
  EnvironmentResult,
  VerifiedEnvironment,
} from '@rocky/local-contracts';
import {
  catalogEntries,
  serviceEntries,
  dependencyOrder,
  WorkspaceExecution,
  StaleServiceError,
  ServiceStartupError,
} from '../flow/workspace-execution.js';

export class EnvironmentBlocked extends Error {
  constructor(readonly blocker: EnvironmentBlocker) {
    super(`${blocker.capability}: ${blocker.action}`);
    this.name = 'EnvironmentBlocked';
  }
}
const blocked = (
  capability: string,
  code: EnvironmentBlocker['code'],
  action: string,
  kind: EnvironmentBlocker['kind'] = 'environment',
): EnvironmentResult => ({
  status: 'blocked',
  blocker: { capability, code, action, kind },
});

/** The shared onboarding/run boundary. Configuration authorizes recipes; discovery does not.
 * All branches use journaled receipts. Live checks run again on working Boots, while a
 * replayed receipt selects the original path. A stale success fails closed, without
 * changing that path or invalidating implementation Steps. Poll Boots only replay
 * receipts; their background processes are not restarted.
 */
export async function ensureEnvironment(
  ctx: Pick<WorkflowContext, 'step' | 'stage' | 'replaying'>,
  execution: WorkspaceExecution,
  request: {
    label: string;
    capabilities?: string[];
    services?: string[];
    setup?: string[];
    requiredKinds?: EnvironmentCapability['kind'][];
    allowSetup: boolean;
    /** A separate, deliberately small recovery allowance. */
    maxRepairs?: number;
    timeoutMs?: number;
  },
): Promise<EnvironmentResult> {
  ctx.stage('Environment: discovering');
  try {
    validateConfiguration({
      repos: execution.repos,
      automation: automationSettings(),
    });
  } catch {
    return blocked(
      'configuration',
      'configuration',
      'Correct missing catalog references, dependency cycles, source references or endpoint settings before provisioning.',
    );
  }
  const catalog = catalogEntries(execution.repos);
  const all = execution.repos.flatMap((repo) =>
    (repo.environment?.capabilities ?? []).map((recipe) => ({
      id: `${repo.id}/${recipe.id}`,
      repository: repo.name,
      recipe,
    })),
  );
  const requested = new Set(request.capabilities ?? []);
  const selected = all.filter(
    ({ id, recipe }) =>
      recipe.baseline ||
      requested.has(id) ||
      recipe.services.some((id) => request.services?.includes(id)),
  );
  const unknown = [...requested].find((id) => !all.some((c) => c.id === id));
  if (unknown)
    return blocked(
      unknown,
      'unsupported',
      'Configure a source-backed capability and executable verifier.',
    );
  const missingKind = request.requiredKinds?.find(
    (kind) => !selected.some(({ recipe }) => recipe.kind === kind),
  );
  if (missingKind)
    return blocked(
      missingKind,
      'unsupported',
      `Configure an executable ${missingKind} capability before this validation.`,
    );
  if (!selected.length && !request.services?.length)
    return blocked(
      'baseline',
      'unsupported',
      'Discover and configure baseline capabilities with executable checks before running implementation.',
    );
  const services = [
    ...new Set([
      ...(request.services ?? []),
      ...selected.flatMap(({ recipe }) => recipe.services),
      ...selected.flatMap(({ recipe }) =>
        Object.values(
          catalog.find((entry) => entry.id === recipe.verify)?.command
            .endpointEnv ?? {},
        ).map((reference) => reference.service),
      ),
    ]),
  ];
  const setup = dependencyOrder(
    catalog,
    [
      ...new Set([
        ...(request.setup ?? []),
        ...selected.flatMap(({ recipe }) => recipe.setup),
        ...selected.flatMap(
          ({ recipe }) =>
            catalog.find((entry) => entry.id === recipe.verify)?.command
              .dependsOn ?? [],
        ),
      ]),
    ],
    ({ command }) => command.dependsOn,
  );
  if (
    setup.length &&
    (!request.allowSetup ||
      setup.some(({ command }) => command.policy === 'manual'))
  )
    return blocked(
      'setup',
      'authorization',
      'Authorize the named isolated setup commands in the profile before provisioning.',
      'human',
    );
  if (
    selected.some(
      ({ recipe }) =>
        catalog.find((c) => c.id === recipe.verify)?.command.policy ===
        'manual',
    )
  )
    return blocked(
      'verification',
      'authorization',
      'Authorize the configured environment verifier.',
      'human',
    );
  if (
    dependencyOrder(
      serviceEntries(execution.repos),
      [
        ...services,
        ...setup.flatMap(({ command }) =>
          Object.values(command.endpointEnv ?? {}).map(
            (reference) => reference.service,
          ),
        ),
      ],
      ({ service }) => service.dependsOn,
    ).some(({ service }) => service.policy === 'manual')
  )
    return blocked(
      'services',
      'authorization',
      'Authorize the required service dependencies before provisioning.',
      'human',
    );
  const budget = Math.min(600_000, Math.max(1, request.timeoutMs ?? 120_000));
  const maxRepairs = Math.min(2, Math.max(0, request.maxRepairs ?? 1));
  const started = Date.now();
  let previous = '';
  for (let attempt = 0; attempt <= maxRepairs; attempt++) {
    const label = `${request.label}: environment v1/${attempt}`;
    ctx.stage(attempt ? 'Environment: repairing' : 'Environment: provisioning');
    // Replay consumes the same setup receipts. Commands are confined to the Run's
    // worktrees and explicitly selected catalog; this is not a product-code fixer.
    let live: EnvironmentResult | undefined;
    for (const entry of setup) {
      const dependencies = [
        ...new Set(
          Object.values(entry.command.endpointEnv ?? {}).map(
            (reference) => reference.service,
          ),
        ),
      ];
      if (dependencies.length) {
        try {
          await execution.start(
            dependencies,
            `${label}: prerequisites ${entry.id}`,
            Math.max(1, budget - (Date.now() - started)),
          );
        } catch (error) {
          if (error instanceof StaleServiceError)
            throw new EnvironmentBlocked({
              kind: 'environment',
              code: 'service',
              capability: entry.id,
              action:
                'A setup service is unavailable on this Boot. Repair its prerequisites and retry.',
            });
          live = blocked(
            entry.id,
            'service',
            'A service required by this setup command did not become ready. Correct its dependency and endpoint configuration.',
          );
          break;
        }
      }
      const allowance = await ctx.step(
        `${label}: setup allowance ${entry.id}`,
        () => Math.max(0, budget - (Date.now() - started)),
      );
      if (!allowance) {
        live = blocked(
          entry.id,
          'budget',
          'Environment provisioning reached its time limit. Inspect the verifier and repair the recipe.',
        );
        break;
      }
      let current: { exitCode: number };
      try {
        current = await execution.probe(
          entry.id,
          Math.max(1, Math.min(allowance, budget - (Date.now() - started))),
          [],
        );
      } catch {
        current = { exitCode: 124 };
      }
      const result = await ctx.step(
        `${label}: setup ${entry.id}`,
        async () => ({ exitCode: current.exitCode }),
      );
      if (result.exitCode === 0 && current.exitCode !== 0)
        throw new EnvironmentBlocked({
          kind: 'environment',
          code: 'configuration',
          capability: entry.id,
          action:
            'Previously verified setup failed on this Boot. Repair its prerequisites and retry.',
        });
      if (result.exitCode !== 0) {
        live = blocked(
          entry.id,
          'configuration',
          'The configured setup command failed. Correct its runtime/dependency recipe; product code was not changed.',
        );
        break;
      }
    }
    ctx.stage('Environment: verifying');
    const capabilities: VerifiedEnvironment['capabilities'] = [];
    let endpoints: VerifiedEnvironment['endpoints'] = {};
    if (!live) {
      try {
        endpoints = await execution.start(
          services,
          label,
          Math.max(1, budget - (Date.now() - started)),
        );
      } catch (error) {
        if (error instanceof StaleServiceError)
          throw new EnvironmentBlocked({
            kind: 'environment',
            code: 'service',
            capability: 'services',
            action:
              'A previously verified service is unavailable on this Boot. Repair its prerequisites and retry.',
          });
        live = blocked(
          error instanceof ServiceStartupError ? error.serviceId : 'services',
          'service',
          'A required service did not start or restart. Check its runtime, dependencies and endpoint configuration.',
        );
      }
    }
    if (!live)
      for (const { id, repository, recipe } of selected) {
        let check: EnvironmentResult | undefined;
        try {
          const remaining = budget - (Date.now() - started);
          const result = await execution.probe(
            recipe.verify,
            Math.max(1, remaining),
            recipe.checks,
            recipe.authentication?.kind === 'secret-env'
              ? [recipe.authentication.reference]
              : [],
          );
          await execution.checkSources(
            repository,
            recipe.sources.map((source) => source.path),
          );
          check = execution.polling
            ? undefined
            : remaining <= 0
              ? blocked(
                  id,
                  'budget',
                  'Environment verification reached its time limit.',
                )
              : interpretVerification(id, recipe, result);
        } catch {
          // Never serialize arbitrary exceptions, command output, credentials or URLs.
          check = blocked(
            id,
            'verification',
            'The verifier failed or timed out. Repair its prerequisites and rerun it.',
          );
        }
        const checked = await ctx.step(
          `${label}: verify ${id}`,
          async () => check ?? { status: 'verified' as const },
        );
        if (checked.status === 'blocked') {
          live = checked;
          break;
        }
        if (check?.status === 'blocked') {
          await execution.stop(label);
          throw new EnvironmentBlocked(check.blocker);
        }
        capabilities.push({
          id,
          repository,
          kind: recipe.kind,
          sources: recipe.sources,
          checks: recipe.checks,
          ...(recipe.authentication
            ? { authentication: recipe.authentication }
            : {}),
          ...(recipe.fixture ? { fixture: recipe.fixture } : {}),
        });
      }
    live ??= {
      status: 'ready',
      context: {
        version: 1,
        endpoints,
        capabilities,
        limitations: all
          .filter(({ id }) => !selected.some((c) => c.id === id))
          .map(({ id }) => `${id}: not verified`),
      },
    };
    const evidence = live;
    const { result: receipt } = await ctx.step(
      `${label}: evidence`,
      async () => ({
        version: 1,
        attempt,
        recipeRevision: createHash('sha256')
          .update(
            JSON.stringify({
              repos: execution.repos,
              requested: [...requested],
            }),
          )
          .digest('hex'),
        result: evidence,
      }),
    );
    if (receipt.status === 'ready') {
      if (live.status !== 'ready') {
        await execution.stop(label);
        // No new branch is inserted into the old history. Retry rechecks live state.
        throw new EnvironmentBlocked(live.blocker);
      }
      ctx.stage('Environment: ready');
      return live;
    }
    await execution.stop(label);
    const fingerprint = JSON.stringify(receipt.blocker);
    if (
      receipt.blocker.kind !== 'environment' ||
      receipt.blocker.code === 'budget' ||
      fingerprint === previous ||
      attempt === maxRepairs
    ) {
      ctx.stage('Environment: blocked');
      return receipt;
    }
    previous = fingerprint;
  }
  return blocked(
    'environment',
    'budget',
    'Environment repair allowance exhausted.',
  );
}

/** Exit zero alone is not verification. Missing, skipped and unsupported assertions fail closed. */
export function interpretVerification(
  id: string,
  recipe: EnvironmentCapability,
  result: { exitCode: number; stdout: string },
): EnvironmentResult | undefined {
  let value: { status?: unknown; reason?: unknown; checks?: unknown };
  try {
    value = JSON.parse(result.stdout);
  } catch {
    return blocked(
      id,
      'verification',
      'Verifier must return JSON with executed assertions.',
    );
  }
  if (!value || typeof value !== 'object')
    return blocked(id, 'verification', 'Verifier returned no evidence.');
  if (
    value.status === 'blocked' &&
    ['credentials', 'permission', 'external'].includes(String(value.reason))
  )
    return blocked(
      id,
      value.reason as 'credentials' | 'permission' | 'external',
      `Provide the required ${value.reason} through machine configuration, then resume.`,
      'human',
    );
  if (value.status === 'blocked' && value.reason === 'unsupported')
    return blocked(
      id,
      'unsupported',
      'This capability has no supported executable verification. Configure one before continuing.',
    );
  if (value.status === 'failed' && value.reason === 'product')
    return blocked(
      id,
      'verification',
      'The executable capability check reports a product defect. Retain the failed check and repair product behavior.',
      'product',
    );
  const checks = Array.isArray(value.checks) ? value.checks : [];
  if (
    result.exitCode !== 0 ||
    value.status !== 'passed' ||
    !recipe.checks.every((id) => {
      const matching = checks.filter((c) => c && c.id === id);
      return (
        matching.length === 1 &&
        matching[0].executed === true &&
        matching[0].passed === true
      );
    })
  )
    return blocked(
      id,
      'verification',
      'A required assertion was not executed successfully. Repair prerequisites or supply a working verifier; do not waive the check.',
    );
  return undefined;
}
