import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expandHarness } from '../config/expand.js';
import type { RockyPaths } from '../config/paths.js';
import type { InstanceConfig } from '../config/schema.js';
import { readCredentials } from '../config/store.js';
import { LinearRunMirror } from '../linear/mirror.js';
import { RockyLinearClient } from '../linear/client.js';
import { preflightMcp, readMcpConfig, type McpConfig } from '../mcp/index.js';
import {
  createGitHubScm,
  createGitLabScm,
  createScm,
  runPreflight,
} from '../scm/index.js';
import { createAgent, type AgentOptions } from './agent.js';
import { readJournal } from './journal.js';
import { loadSnapshotWorkflow } from './loading/loader.js';
import { validateSnapshotTriggers } from './loading/validate.js';
import { loadMcpRuntime, type McpRuntime } from './mcp-contract.js';
import { WorkflowRuntime, type WorkflowRuntimeOptions } from './lifecycle.js';
import type { BootRequest } from './worker.js';

function scmProject(url: string): {
  platform: 'github' | 'gitlab';
  project: string;
} {
  const match = url.match(
    /(?:github|gitlab)\.com[/:]([^/]+\/[^/#]+?)(?:\.git)?$/i,
  );
  if (!match)
    throw new Error(
      `Unsupported SCM remote ${url}; configure a GitHub or GitLab repository URL.`,
    );
  const platform = /gitlab\.com/i.test(url) ? 'gitlab' : 'github';
  return { platform, project: match[1] };
}

/** Profile-owned environment: repository config cannot inject a Run variable. */
function profileEnv(
  run: {
    profile?: {
      settings: { env: Record<string, string>; secretEnv: string[] };
    };
    repo: string;
  },
  credentials: Awaited<ReturnType<typeof readCredentials>>,
): Record<string, string> {
  const profile = run.profile;
  if (!profile)
    throw new Error(
      `${run.repo}: missing local profile snapshot; re-delegate after assigning a profile.`,
    );
  const stored = credentials.repos[run.repo] ?? {};
  return {
    ...profile.settings.env,
    ...Object.fromEntries(
      profile.settings.secretEnv.flatMap((name) => {
        const value = stored[name] ?? process.env[name];
        return value === undefined ? [] : [[name, value]];
      }),
    ),
  };
}

const effectId = (value: string) =>
  createHash('sha256').update(value).digest('hex').slice(0, 32);

function shippedContentUrl(path: string): URL {
  // Source Boots run from src/run; the packed esbuild entry runs from dist.
  // The raw content tree is deliberately copied beside the latter, rather
  // than bundled, so seeded files remain inspectable TypeScript.
  const source = new URL(`../../content/${path}`, import.meta.url);
  if (existsSync(fileURLToPath(source))) return source;
  return new URL(`../content/${path}`, import.meta.url);
}

function onboardingModuleUrl(): URL {
  // Node deliberately will not type-strip a .ts file below node_modules.
  // The package bundles this daemon-owned runner, while source Boots retain
  // the inspectable TypeScript module during development.
  const packed = new URL('../dist/onboarding.js', import.meta.url);
  return existsSync(fileURLToPath(packed))
    ? packed
    : shippedContentUrl('onboarding.ts');
}

export interface ProductionRuntimeOptions {
  paths: RockyPaths;
  config(): InstanceConfig;
  request(request: BootRequest): Promise<unknown>;
  onEvent?: AgentOptions['onEvent'];
  steer?: AgentOptions['steer'];
  /** Harness #20 is injectable for production-seam tests and future adapters. */
  adapterFor?: AgentOptions['adapterFor'];
  /** SCM and Linear adapters receive branch-local Steps and cancellation unchanged. */
  external?: WorkflowRuntimeOptions['external'];
  preflight?: WorkflowRuntimeOptions['beforeWorkflow'];
}

/** Created only inside an owned Boot process; no Workflow import reaches HTTP. */
export function createProductionRuntime(
  options: ProductionRuntimeOptions,
): WorkflowRuntime {
  let env: NodeJS.ProcessEnv = {};
  // A direct Runtime construction is useful for isolated Workflow tests. A
  // real admitted Linear Run has an access token (hydration could not happen
  // otherwise), so only those Runs receive network-backed production services.
  let servicesEnabled = false;
  let mcp: Promise<{ runtime: McpRuntime; config: unknown }> | undefined;
  const linearClient = new RockyLinearClient({
    auth: async () => (await readCredentials(options.paths)).linear ?? {},
    save: async () => undefined,
  });
  const mirrorFor = (
    run: Parameters<NonNullable<WorkflowRuntimeOptions['external']>>[0],
  ) => {
    if (!run.linear) throw new Error(`${run.runId}: missing Linear identity`);
    return new LinearRunMirror({
      runId: run.runId,
      issueId: run.linear.issueId,
      sessionId: run.linear.sessionId,
      teamId: run.linear.teamId,
      localOrigin: `http://localhost:${options.config().server.port}`,
      platform: {
        terminalComments: 'one',
        elicitationComments: 'none',
        evidence: 'Linear Agent Session qualification recorded by Rocky.',
      },
      client: linearClient,
      store: {
        get: async (key) => options.request({ kind: 'control-get', key }),
        put: async (key, value) => {
          await options.request({ kind: 'control-put', key, value });
        },
      },
    });
  };
  const scmFor = (
    run: Parameters<NonNullable<WorkflowRuntimeOptions['external']>>[0],
    signal: AbortSignal,
  ) => {
    if (!run.execution) throw new Error(`${run.runId}: missing frozen members`);
    return run.execution.members.map((member) => {
      const source = scmProject(member.url);
      const token =
        source.platform === 'github'
          ? (env.GITHUB_TOKEN ?? env.GH_TOKEN)
          : env.GITLAB_TOKEN;
      if (!token)
        throw new Error(
          `${member.name}: missing ${source.platform === 'github' ? 'GITHUB_TOKEN (or GH_TOKEN)' : 'GITLAB_TOKEN'} in this repository's secret environment.`,
        );
      const input = {
        repo: {
          id: member.name,
          project: source.project,
          baseBranch: member.baseBranch,
        },
        branch: run.branch,
        token,
        signal,
      };
      return source.platform === 'github'
        ? createGitHubScm(input)
        : createGitLabScm(input);
    });
  };
  return new WorkflowRuntime({
    paths: options.paths,
    read: readJournal,
    append: async (_path, entry, appendOptions) => {
      await options.request({ kind: 'append', entry, options: appendOptions });
    },
    loadWorkflow: async (run, signal) => {
      if (!run.execution || !run.linear)
        throw new Error(
          `${run.runId}: missing immutable execution/Linear identity; re-delegate through the production admission service`,
        );
      signal.throwIfAborted();
      const credentials = await readCredentials(options.paths);
      servicesEnabled = Boolean(credentials.linear?.accessToken);
      env = {
        ...process.env,
        ...profileEnv(run, credentials),
        ROCKY_RUN_DIR: options.paths.run(run.runId).dir,
        ROCKY_SCREENSHOT_DIR: options.paths.run(run.runId).screenshotsDir,
        ROCKY_PORT: String(run.ports[0] ?? ''),
      };
      mcp = undefined;
      if (run.execution.source === 'onboarding') {
        // Content intentionally remains a shipped, inspectable tree rather
        // than part of the daemon's import graph.  Keeping the specifier in a
        // value also prevents TypeScript from folding that tree into dist.
        const onboardingModule = onboardingModuleUrl().href;
        const { createOnboarding } = await import(onboardingModule);
        const shippedDir = fileURLToPath(shippedContentUrl('.rocky/'));
        const lead = run.execution.members.find((member) => member.lead);
        if (!lead)
          throw new Error(
            `${run.runId}: onboarding has no frozen lead repository`,
          );
        const linear = run.linear;
        if (!linear)
          throw new Error(`${run.runId}: onboarding has no Linear identity`);
        return createOnboarding({
          repo: join(options.paths.run(run.runId).workspaceDir, lead.path),
          shippedDir,
          teamStates: async () => {
            const { RockyLinearClient } = await import('../linear/client.js');
            const client = new RockyLinearClient({
              auth: async () =>
                (await readCredentials(options.paths)).linear ?? {},
              save: async () => undefined,
            });
            return client.workflowStates(linear.teamId);
          },
          validate: async (directory: string) => {
            await validateSnapshotTriggers(directory, { signal });
          },
        });
      }
      return loadSnapshotWorkflow(
        options.paths.run(run.runId).snapshotDir,
        run.execution.trigger,
      );
    },
    beforeWorkflow: async (run, steps, signal) => {
      await steps.step('workspace', {}, async () => ({
        status: 'done',
        result: await options.request({ kind: 'workspace' }),
      }));
      if (servicesEnabled) {
        // Onboarding is already an acknowledged Agent Session and reports its
        // seed PR through ctx.post.  Do not add a second comment before the
        // seed exists: Linear may have rendered historical session comments
        // that cannot safely be attributed by the strict two-comment gate.
        if (run.execution?.source !== 'onboarding') {
          const mirror = mirrorFor(run);
          await steps.step('linear.start', {}, async () => {
            await mirror.start();
            return { status: 'done' as const, result: null };
          });
        }
        // The seed Workflow deliberately leaves merging to the human. Its
        // branch does not exist until the Workflow pushes it, so the ordinary
        // merge/rebase preflight would reject onboarding before it can create
        // its non-draft PR. Its SCM operations still fail closed at the exact
        // push/PR/CI boundary if the configured token lacks authority.
        if (run.execution?.source !== 'onboarding') {
          const members = scmFor(run, signal);
          await runPreflight(steps, {
            members,
            signal,
            refreshMcp: async (refreshSignal) =>
              preflightMcp(
                (await readMcpConfig(
                  join(options.paths.run(run.runId).snapshotDir, 'mcp.json'),
                )) as McpConfig,
                { paths: options.paths, signal: refreshSignal },
              ),
          });
        }
      }
      await options.preflight?.(run, steps, signal);
    },
    env: () => env,
    external: (run, steps, signal, approvals) => {
      const resolveHarness = (name: 'claude-code' | 'opencode') => {
        const settings = expandHarness(
          name,
          options.config().harnesses[name] ?? {},
          env,
        );
        return {
          command:
            settings.command ??
            (name === 'claude-code' ? 'claude' : 'opencode'),
          env: { ...env, ...settings.env },
          sessionStorage:
            settings.sessionStorage === 'opencode'
              ? ('opencode' as const)
              : ('rocky' as const),
        };
      };
      return {
        ...options.external?.(run, steps, signal, approvals),
        ...(servicesEnabled
          ? {
              post: async (markdown: string) =>
                mirrorFor(run).post(effectId(`post:${markdown}`), markdown),
              linear: {
                setState: async (name: string) =>
                  mirrorFor(run).setState(`state:${name}`, name),
              },
              scm: createScm(steps, {
                runId: run.runId,
                lead: run.repo,
                members: scmFor(run, signal),
                signal,
                approvals,
                onRefusal: async ({ key, refusal }) =>
                  mirrorFor(run).post(
                    key,
                    `${refusal.message}\n\n${refusal.fix}`,
                  ),
              }),
            }
          : {}),
        agent: createAgent(steps, {
          snapshotDir: options.paths.run(run.runId).snapshotDir,
          cwd: options.paths.run(run.runId).workspaceDir,
          sessionDir: options.paths.run(run.runId).sessionsDir,
          harness: 'claude-code',
          harnesses: {
            get 'claude-code'() {
              return resolveHarness('claude-code');
            },
            get opencode() {
              return resolveHarness('opencode');
            },
          },
          resolveServers: async (names, attemptSignal) => {
            const prepared = await (mcp ??= (async () => {
              const runtime = await loadMcpRuntime();
              const declarations = await runtime.readMcpConfig(
                join(options.paths.run(run.runId).snapshotDir, 'mcp.json'),
              );
              return {
                runtime,
                config: runtime.expandMcpConfig(declarations, {
                  env,
                  run: {
                    runDir: options.paths.run(run.runId).dir,
                    screenshotDir: options.paths.run(run.runId).screenshotsDir,
                    port: run.ports[0] ?? 0,
                  },
                }),
              };
            })());
            return prepared.runtime.resolveMcpServers(prepared.config, names, {
              paths: options.paths,
              signal: attemptSignal,
            });
          },
          adapterFor: options.adapterFor,
          onEvent: options.onEvent,
          steer: options.steer,
        }),
      };
    },
  });
}
