import {
  prepareUiFixtures,
  uiFixturesSchema,
  verifyUiFixtureCredentialFile,
} from './ui-fixtures.js';
import { bindChecksToEndpoint, isRelativeUiPath } from './ui-checks.js';
import {
  ensureEnvironment,
  EnvironmentBlocked,
} from '../environment/ensure.js';
import type {
  EnvironmentResult,
  VerifiedEnvironment,
  EnvironmentBlocker,
} from '@rocky/local-contracts';
import { DeliveryRepositories, UncommittedWorkError } from './repositories.js';
import {
  WorkspaceExecution,
  catalogEntries,
  serviceEntries,
  dependencyOrder,
} from './workspace-execution.js';
import { ReviewHistory, reviewPolicy } from './review-history.js';
import type { DeliveryAgents } from './agents.js';
import {
  type WorkflowContext,
  type AgentCallOpts,
  type ScmPr,
  type ScmRefusal,
  type ReviewThread,
  type WorkflowInput,
  type CheckpointAnswer,
  z,
} from '@rocky/sdk';
import { mkdir, readdir, readFile, realpath, stat } from 'node:fs/promises';
import {
  Plan,
  Refinement,
  Deliverable,
  DeliverableReviewFor,
  DiagramValidation,
  ReviewFor,
  FixReportFor,
  UiTriage,
  CiFix,
  Checks,
  CheckResultsFor,
  ComplaintFor,
  type Check,
  Complaint,
  type Observation,
  type Resolution,
} from './schemas.js';

import { dirname, join, relative, isAbsolute, sep } from 'node:path';
import type { FlowSettings, UiEndpoint } from '@rocky/local-contracts';
import { resolveUiEndpoint } from './ui-endpoint.js';
import { isRecapAuditError, RecapAuditError } from '../review-report/recap.js';
async function shell(ctx: WorkflowContext, command: string) {
  const result = await ctx.exec(`cd -- "$ROCKY_LEAD_REPO" && ${command}`);
  if (result.exitCode !== 0)
    throw new Error(`Command failed: ${command}\n${result.stderr}`);
  return result.stdout.trim();
}

function requireScm<T>(result: T | ScmRefusal): T {
  if (result && typeof result === 'object' && 'refused' in result)
    throw new Error(`${result.message}\n${result.fix}`);
  return result as T;
}

class UiFixtureBlocked extends EnvironmentBlocked {}
class UiFixtureSourceChanged extends Error {}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

async function loadRules(ctx: WorkflowContext, snapshotDir: string) {
  // Every file is prompt text. Delete this call to opt out; no README belongs here.
  return ctx.step('load rules', async () => {
    const directory = join(snapshotDir, 'rules');
    const files = await readdir(directory).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      },
    );
    const rules = [];
    for (const file of files.sort())
      rules.push(await readFile(join(directory, file), 'utf8'));
    return rules.join('\n\n');
  });
}

function unresolvedPost(complaints: readonly Complaint[], recovery = false) {
  const json = JSON.stringify(complaints, null, 2);
  if (!recovery) return `Unresolved Complaints:\n${json}`;
  // Arbitrary log text must not become Markdown links or formatting. Choose a
  // fence longer than any embedded backticks so the evidence stays literal.
  const fence = '`'.repeat(
    Math.max(
      3,
      ...[...json.matchAll(/`+/g)].map(([match]) => match.length + 1),
    ),
  );
  return `Unresolved Complaints:\n\n${fence}json\n${json}\n${fence}`;
}

async function giveUp(
  ctx: WorkflowContext,
  pr: ScmPr,
  complaints: readonly Complaint[],
  recovery = false,
) {
  requireScm(await ctx.scm.markDraft(pr, true));
  await ctx.post(unresolvedPost(complaints, recovery));
  return 'exhausted' as const;
}

async function validateDiagrams(ctx: WorkflowContext, body: string) {
  const result = await ctx.exec(
    `printf '%s' ${quote(body)} | "$ROCKY_NODE" "$ROCKY_MERMAID_CHECK"`,
  );
  if (result.exitCode !== 0 && result.exitCode !== 1)
    throw new Error(
      `Required Mermaid validator is unavailable. Upgrade/restart Rocky to provide ROCKY_NODE and ROCKY_MERMAID_CHECK. ${result.stderr}`,
    );
  const evidence = DiagramValidation.parse(JSON.parse(result.stdout));
  if (
    evidence.ok !== (result.exitCode === 0) ||
    evidence.ok !== evidence.diagrams.every((item) => item.valid)
  )
    throw new Error(
      'Mermaid validator returned inconsistent evidence; repair the validator before continuing.',
    );
  return evidence;
}

const reviewContract = {
  phase: 'before-publication',
  publisher: 'workflow',
  publication: 'pending content approval',
  instruction:
    'Assess whether this exact body is ready to publish. For criteria phrased as a comment is published, assess the required contents and destination now. Publication and exact-body verification happen afterwards in ctx.comment; absence of a publication receipt at this stage is expected and cannot be repaired by the writer. Never claim it is already published.',
};

type ReviewState = {
  complaints: Complaint[];
  resolutions: Resolution[];
};

/** Packaged delivery operations. Graph edges, not this module, choose the next stage.
 * State is rebuilt on every boot from journaled ctx results, exactly like a legacy workflow.
 */
export function createDeliveryOperations(
  ctx: WorkflowContext,
  workspace: WorkflowInput,
  settings: FlowSettings,
  snapshotDir: string,
  continuations = 0,
  repairs: import('@rocky/local-contracts').FlowRepairRevision[] = [],
) {
  settings = structuredClone(settings);
  // Run-specific environment is supplied to child commands, not this process.
  const runDir = dirname(snapshotDir);
  const workspaceDir = join(runDir, 'workspace');
  const evidenceDirectory = join(workspaceDir, '.rocky-evidence');
  const leadDir = join(
    workspaceDir,
    (workspace.members.find((member) => member.lead) ?? workspace.members[0])
      ?.path ?? '',
  );
  const serverLog = join(runDir, 'dev-server.log');
  let { commands, ui, readiness } = settings;
  const { states, ciCap, ciLogLines } = settings;
  let { reviewCap } = settings;
  let environmentAgentRepairs = 0;
  const environmentRepairHistory: {
    blocker: EnvironmentBlocker;
    commands: string[];
    summary: string;
  }[] = [];
  let deliveryRepairs = 0;
  const recoverySetup = new Set<string>();
  const failedValidationChecks = new Set<string>();
  const requestedValidationChecks = new Set<string>();
  let continuation = 0;
  let repairedUi = false;
  let repairedInstall = false;
  let execution = settings.execution
    ? new WorkspaceExecution(
        ctx,
        workspace,
        settings.execution,
        dirname(snapshotDir),
        settings.environmentVersion === 1,
      )
    : undefined;
  let environmentUiRepairs = 0;
  let uiFixtureSourceRepairs = 0;
  let recapServices: string[] = [];
  let recapCapabilities: string[] = [];
  let environmentContext: VerifiedEnvironment | undefined;
  async function ensure(
    services: string[],
    label: string,
    capabilities: string[] = [],
    setup: string[] = [],
    browser = true,
  ): Promise<EnvironmentResult> {
    if (!execution) throw Error('Environment catalog is unavailable.');
    const result = await ensureEnvironment(ctx, execution, {
      label,
      services,
      capabilities,
      setup: [...new Set([...setup, ...recoverySetup])],
      allowSetup: settings.workspaceSetup === true,
      ...(services.length && browser
        ? { requiredKinds: ['browser' as const] }
        : {}),
    });
    if (result.status === 'ready') environmentContext = result.context;
    return result;
  }
  function applyExecutionRepair(repos: NonNullable<FlowSettings['execution']>) {
    // A repair may amend recipes, never substitute a repository or escape the Run.
    const old = settings.execution ?? [];
    if (
      repos.length !== old.length ||
      repos.some(
        (repo) =>
          !old.some(
            (member) =>
              member.id === repo.id &&
              member.name === repo.name &&
              member.url === repo.url &&
              member.baseBranch === repo.baseBranch,
          ),
      )
    )
      throw Error(
        'Environment repair must preserve the Run repository identities.',
      );
    settings.execution = structuredClone(repos);
    validationResponsibility.repositoryCatalog = settings.execution;
    environmentUiRepairs = 0;
    settings.environmentVersion = 1;
    execution = new WorkspaceExecution(
      ctx,
      workspace,
      settings.execution,
      runDir,
      true,
    );
    environmentContext = undefined;
    serviceChecks.clear();
  }
  async function environmentFailure(
    blocker: EnvironmentBlocker,
    resume: () => Promise<string>,
    recover = true,
  ): Promise<string> {
    ctx.stage('Environment: blocked');
    // This snapshot version is the migration boundary. Never insert new agent
    // Steps into immutable journals created before autonomous recovery existed.
    if (
      recover &&
      settings.recoveryVersion &&
      execution &&
      settings.execution?.length &&
      environmentAgentRepairs < 2 &&
      settings.workspaceSetup &&
      (blocker.kind === 'environment' || blocker.code === 'credentials') &&
      blocker.code !== 'authorization'
    ) {
      environmentAgentRepairs++;
      await execution.stop('Before environment repair');
      const available = catalogEntries(settings.execution ?? []).filter(
        ({ command }) => command.policy !== 'manual',
      );
      const role = resume === operations.implement ? 'implementer' : 'fixer';
      const repair = await actors.call(role, {
        label: `Environment diagnosis and repair ${environmentAgentRepairs}/2`,
        input: {
          issue,
          delivery,
          plan,
          workspace,
          blocker,
          previousRepairs: [...environmentRepairHistory],
          commands,
          environment: environmentContext,
          validationResponsibility,
          availableCommands: available,
          instruction:
            'This call is environment recovery. Diagnose the supplied blocker in the assigned isolated worktrees. Read repository instructions, setup scripts and actual check evidence. The current blocker survived previousRepairs; use that history to change the diagnosis instead of repeating an ineffective setup command. Repair missing local dependencies, fixtures, documented development authentication or preview reachability. A seed command exit or HTTP 200 does not prove that login or the blocked user transition works: probe the failed transition and inspect its response. Where supported, create distinct authorized local test identities instead of relying on an account whose password or enrollment may have changed. For required component states without an existing preview, implement a development/test-only fixture using repository conventions; preserve production behavior and exercise the real component. Do not substitute such a preview for a required real integration. Select existing non-manual catalog command IDs for the Workflow to execute on the host when sandbox execution is insufficient. Do not weaken checks, invent credentials, claim coverage you did not execute, or change external systems. Preserve prior work and commit any source fixes locally. Return repaired only when a concrete repair was made or selected; state exactly what still needs host verification. Otherwise explain the precise remaining blocker. The Workflow reruns validation and the complete UI sweep after repair.',
        },
        schema: z.object({
          action: z.enum(['repaired', 'blocked']),
          commands: z.array(z.enum(available.map((entry) => entry.id))),
          summary: z.string(),
        }),
      });
      // Agent selection does not grant authority to execute manual commands or
      // manual prerequisites. Check the complete dependency closure first.
      const catalog = catalogEntries(settings.execution ?? []);
      const services = new Set(
        serviceEntries(settings.execution ?? []).map((entry) => entry.id),
      );
      // Older repair receipts allowed arbitrary strings, including service IDs.
      // Services are already started and verified by ensureEnvironment; they
      // must never be looked up as commands or inserted into setup receipts.
      // Keep command IDs authoritative when both catalogs use the same ID.
      const requested = repair.commands.filter(
        (id) => catalog.some((entry) => entry.id === id) || !services.has(id),
      );
      const selected = dependencyOrder(
        catalog,
        requested,
        ({ command }) => command.dependsOn,
      );
      if (selected.some(({ command }) => command.policy === 'manual'))
        throw new Error('Environment recovery cannot execute manual commands.');
      if (repair.action === 'repaired') {
        environmentRepairHistory.push({
          blocker,
          commands: selected.map((entry) => entry.id),
          summary: repair.summary,
        });
        for (const entry of selected) recoverySetup.add(entry.id);
        // The next ensureEnvironment executes the selected setup with endpoint
        // dependencies and live verifiers; no agent assertion replaces evidence.
        changes.push(repair.summary);
        if (resume === operations.implement) return resume();
        await push();
        // Environment recovery has its own bounded allowance. Revalidate any
        // source changes without stealing the last product-review iteration.
        reviewCap++;
        return 'retry';
      }
    }
    // Environment blockers do not enter review/fixer history or consume its cap.
    await ctx.post(
      `Environment blocked (${blocker.kind}/${blocker.code}): ${blocker.capability}. ${blocker.action}`,
    );
    if (!continuations) return 'exhausted';
    continuations--;
    continuation++;
    const repair = repairs.find(
      (item) => item.continuation === continuation,
    )?.settings;
    if (repair?.execution) applyExecutionRepair(repair.execution);
    return resume();
  }
  async function selectedCommands(purpose: 'install' | 'validate') {
    const catalog = catalogEntries(settings.execution ?? []);
    const available = catalog.filter(
      ({ command }) =>
        (purpose === 'install'
          ? command.purpose === 'install'
          : command.purpose !== 'install') && command.policy !== 'manual',
    );
    const optional = available.filter(
      ({ command }) => command.policy === 'agent',
    );
    if (optional.length && !actors.selectCommands)
      throw Error(
        'This workflow adapter cannot select repository commands. Configure the selection helper or use explicit required/manual policies.',
      );
    const selection = optional.length
      ? await actors.selectCommands!(
          {
            issue,
            changedFiles:
              purpose === 'validate' ? await ctx.changedFiles() : [],
            purpose,
            scope,
            changes,
            previousValidation: validationSummary,
            requiredValidationCommands: [...requestedValidationChecks],
            catalog: optional.map(({ id, repository, command }) => ({
              id,
              repository: repository.name,
              command,
            })),
          },
          optional.map((entry) => entry.id),
        )
      : { selected: [], reason: 'Only required commands are configured.' };
    const failedBefore =
      purpose === 'validate' && settings.validationRecheckVersion
        ? [...failedValidationChecks]
        : [];
    const requested =
      purpose === 'validate' ? [...requestedValidationChecks] : [];
    const ids = [
      ...available
        .filter(({ command }) => command.policy === 'required')
        .map((entry) => entry.id),
      ...selection.selected,
      ...failedBefore,
      ...requested,
    ];
    const ordered = dependencyOrder(
      catalog,
      ids,
      ({ command }) => command.dependsOn,
    );
    await ctx.step(`Command selection ${purpose} ${revision}`, async () => ({
      selected: ordered.map((entry) => entry.id),
      skipped: available
        .filter((entry) => !ordered.includes(entry))
        .map((entry) => entry.id),
      reason: [
        selection.reason,
        ...(failedBefore.length
          ? [
              `Retesting previously failed commands: ${failedBefore.join(', ')}.`,
            ]
          : []),
        ...(requested.length
          ? [`Running agent-deferred host checks: ${requested.join(', ')}.`]
          : []),
      ].join(' '),
    }));
    return ordered;
  }
  const repositories =
    settings.pullRequests === 'all-changed' && workspace.members.length
      ? new DeliveryRepositories(ctx, workspace)
      : undefined;
  const reviewedRepositoryHeads = new Map<string, Record<string, string>>();
  const recaps = new Map<string, { url: string }>();
  let actors: DeliveryAgents;
  const history = new ReviewHistory();
  const reviewedHeads = new Map<string, string>();
  let scope!: Extract<z.infer<typeof Refinement>, { status: 'clear' }>;
  let delivery!: typeof scope.delivery;
  let issue = ctx.issue;
  let ticket = '';
  let plan!: z.infer<typeof Plan> & { summary: string };
  let pr!: ScmPr;
  let description = '';
  const changes: string[] = [];
  let ciAttempts = 0;
  let mergeReadiness = settings.mergeReadinessVersion === 1;
  let pendingThreads: ReviewThread[] = [];
  let threadReplies: {
    thread: ReviewThread;
    body: string;
    resolve: boolean;
  }[] = [];

  async function retryMerge() {
    answer = undefined;
    if (repositories) await repositories.markDraft(true);
    else pr = requireScm(await ctx.scm.markDraft(pr, true));
    return 'retry';
  }

  // These are new journaled reads after the approval, not replay of pre-approval CI.
  // Inspect the entire delivery set before any repository is allowed to merge.
  async function readyAfterApproval() {
    if (!mergeReadiness) return true;
    let ready = true;
    for (const candidate of repositories?.open ?? [pr]) {
      const threads = requireScm(await ctx.scm.reviewThreads(candidate));
      pendingThreads.push(
        ...threads.filter(
          (thread) => !thread.resolved && thread.resolvable !== false,
        ),
      );
      if (!settings.ciSkipRepositories?.includes(candidate.repo)) {
        const ci = await ctx.scm.waitForCi(candidate, {
          logTailLines: ciLogLines,
        });
        if ('refused' in ci) {
          if (ci.reason !== 'head_changed') requireScm(ci);
          passedCiHeads.delete(`${candidate.repo}\0${candidate.headSha}`);
          ready = false;
        } else if (ci.status !== 'passed' || ci.headSha !== candidate.headSha) {
          passedCiHeads.delete(`${candidate.repo}\0${candidate.headSha}`);
          ready = false;
        }
      }
    }
    if (ready && !pendingThreads.length) {
      for (const candidate of repositories?.open ?? [pr]) {
        const platform = await ctx.scm.checkMergeReady(candidate);
        if ('refused' in platform) {
          ready = false;
          if (
            platform.reason === 'discussions_not_resolved' ||
            platform.reason === 'requested_changes'
          ) {
            pendingThreads.push(
              ...requireScm(
                await ctx.scm.reviewThreads(platform.pr ?? candidate),
              ).filter(
                (thread) => !thread.resolved && thread.resolvable !== false,
              ),
            );
          } else if (
            ![
              'ci_must_pass',
              'ci_still_running',
              'head_changed',
              'need_rebase',
              'conflict',
            ].includes(platform.reason)
          ) {
            const response = await ctx.question({
              title: 'Platform merge requirement needs attention',
              body: `${candidate.url}\n\n${platform.message}\n\n${platform.fix}\n\nSatisfy this requirement on the platform, then reply. Rocky will revalidate and request new approval.`,
            });
            if ('cancelled' in response)
              throw new Error('Platform readiness repair was cancelled.');
          }
        }
      }
    }
    return ready && !pendingThreads.length;
  }

  async function repairMergeThreads() {
    if (!pendingThreads.length) return;
    const complaints = pendingThreads.map((thread, index) =>
      Complaint.parse({
        id: `merge-threads/${revision}/${index}`,
        file: repositories
          ? `${thread.pr.repo}/${thread.path ?? '.'}`
          : (thread.path ?? '.'),
        ...(thread.line === undefined ? {} : { line: thread.line }),
        text: thread.body,
      }),
    );
    const fixed = await actors.call('fixer', {
      label: `Address merge conversations ${revision}`,
      input: {
        issue,
        delivery,
        complaints,
        commands,
        instruction:
          'Address every review conversation. Commit fixes locally. Explain each fix with evidence; do not resolve threads or merge through shell tools.',
      },
      schema: FixReportFor(complaints),
    });
    changes.push(fixed.summary);
    await push();
    threadReplies = pendingThreads.map((thread, index) => {
      const resolution = fixed.resolutions.find(
        (r) => r.id === complaints[index].id,
      )!;
      const current =
        repositories?.current.find((p) => p.repo === thread.pr.repo) ?? pr;
      return {
        thread: { ...thread, pr: current },
        body:
          resolution.status === 'fixed'
            ? `Fixed in ${current.headSha}. ${resolution.note}`
            : resolution.note,
        resolve: resolution.status === 'fixed',
      };
    });
    pendingThreads = [];
  }

  async function finishMergeThreads() {
    for (const reply of threadReplies) {
      const current =
        repositories?.current.find((p) => p.repo === reply.thread.pr.repo) ??
        pr;
      const result = await ctx.scm.replyToThread(
        { ...reply.thread, pr: current },
        reply.body,
        { resolve: reply.resolve },
      );
      if (result && 'refused' in result) {
        if (!['blocked_status', 'head_changed'].includes(result.reason))
          requireScm(result);
        // A new review or head arrived during repair. Read it afresh after approval.
      }
      if (!reply.resolve) {
        await ctx.question({
          title: 'Review conversation needs a decision',
          body: `${current.url}\n\n${reply.thread.body}\n\n${reply.body}\n\nResolve this conversation on the platform if you accept the explanation, or provide the required correction.`,
        });
      }
    }
    threadReplies = [];
  }
  const serviceChecks = new Map<string, Check[]>();
  let uiSummary = repositories ? '' : 'No frontend change.';
  let validationSummary =
    'No local validation commands configured; see CI and review evidence.';
  let server: { pid: number } | undefined;
  let revision = 0;
  let recap!: { url: string };
  let answer: CheckpointAnswer | undefined;
  const diff = () =>
    repositories
      ? repositories.diff()
      : shell(ctx, 'git diff origin/HEAD...HEAD');
  async function setupWorkspace() {
    if (execution && !repairedInstall) {
      if (!settings.workspaceSetup) return;
      for (const entry of await selectedCommands('install')) {
        const result = await execution.command(entry.id, `Install ${entry.id}`);
        if (result.exitCode !== 0)
          throw Error(
            `Workspace setup failed: ${entry.id} (exit ${result.exitCode}). ${result.stderr.slice(-12000)}`,
          );
      }
      return;
    }
    if (!settings.workspaceSetup || !commands.install.trim()) return;
    ctx.stage('Setup workspace');
    const result = await ctx.exec(
      `cd -- "$ROCKY_LEAD_REPO" && ${commands.install}`,
      { label: 'Install workspace dependencies' },
    );
    if (result.exitCode !== 0)
      throw new Error(
        `Workspace setup failed (exit ${result.exitCode}): ${commands.install}\n${`${result.stdout}\n${result.stderr}`.slice(-12000)}`,
      );
  }
  const evidenceInstruction = `Retain generated diagnostic logs in ${evidenceDirectory}, outside every Git worktree. Create that directory when needed, use distinct names for each repository/check, and report the paths. Do not commit diagnostic logs or leave them as untracked files inside a Git worktree.`;
  const validationResponsibility = {
    commands,
    repositoryCatalog: settings.execution,
    instruction:
      'The supplied verified environment records setup already completed by the Workflow. Reuse it; do not rerun installers inside the Agent unless concrete evidence shows dependencies are missing or stale. The Workflow owns execution of the supplied repositoryCatalog commands on the host, including configured checks beyond test, lint and build. Required commands run automatically; agent-policy commands are selected from the issue and changed files, with their dependency closure. Manual commands are not authorized. If a matching non-manual catalog command covers a required check that your sandbox cannot execute, identify that exact command ID in your result, report its evidence as pending host validation, and complete the assigned source repair without repeating the denied operation or claiming it passed. This is a handoff to an existing authorized Workflow step, not permission to bypass the sandbox. Implementation and repair agents own acceptance tests and benchmarks not covered by that catalog or other explicitly configured validation, including local dependencies and disposable test services needed to run them. Produce and retain the required evidence in this workspace; there is no separate later agent that will supply it. Use the cache paths Rocky provides; do not create repository-local Nx, npm, or Electron caches. Reuse passing full-check results when subsequent edits cannot affect them; repair an unrelated commit-hook or environment failure without repeating an already passing full repository check. Check documented setup and available container runtimes before declaring infrastructure unavailable. Report actual external access requirements precisely when local setup cannot resolve them.' +
      ` ${evidenceInstruction}`,
  };
  async function push(role = 'fixer') {
    if (repositories) {
      let repaired = false;
      for (;;) {
        try {
          await repositories.sync(
            `${issue.identifier}: ${issue.title}`,
            description,
          );
          break;
        } catch (error) {
          if (
            !(error instanceof UncommittedWorkError) ||
            !settings.recoveryVersion ||
            deliveryRepairs >= 2
          )
            throw error;
          deliveryRepairs++;
          repaired = true;
          const fixed = await actors.call(role, {
            label: `Complete uncommitted work ${deliveryRepairs}/2`,
            input: {
              issue,
              delivery,
              plan,
              commands,
              validationResponsibility,
              recovery: {
                kind: 'uncommitted-work',
                repository: error.repository,
              },
              instruction:
                'The preceding agent left uncommitted work. Inspect the current branch and repository instructions, complete the requested implementation, repair local prerequisites and commit completed changes. Preserve all prior work. Do not merely commit an incomplete fragment or discard changes to make status clean. Run repository checks, report evidence and any remaining blocker. Keep commits local; the Workflow owns PR delivery.' +
                ` ${evidenceInstruction}`,
            },
            schema: z.object({ summary: z.string() }),
          });
          changes.push(fixed.summary);
        }
      }
      pr = repositories.current[0];
      return repaired;
    }
    await shell(ctx, 'git push origin HEAD');
    pr = { ...pr, headSha: await shell(ctx, 'git rev-parse HEAD') };
    return false;
  }

  async function exhaust(complaints: readonly Complaint[]) {
    // Replay the original exhaustion effects before consuming a new allowance.
    // This keeps old journals positional and preserves their published receipts.
    const outcome = repositories
      ? await (async () => {
          await repositories.markDraft(true);
          await ctx.post(
            unresolvedPost(complaints, settings.recoveryVersion === 1),
          );
          return 'exhausted' as const;
        })()
      : await giveUp(ctx, pr, complaints, settings.recoveryVersion === 1);
    if (continuations === 0) return outcome;
    continuations--;
    continuation++;
    const repair = repairs.find(
      (item) => item.continuation === continuation,
    )?.settings;
    if (repair) {
      if (repair.execution) applyExecutionRepair(repair.execution);
      if (repair.readiness) readiness = settings.readiness = repair.readiness;
      // Apply only after the original stop effects have replayed. Never rewrite
      // the snapshot or reinterpret completed commands using new configuration.
      if (repair.ui) {
        ui = settings.ui = repair.ui;
        repairedUi = true;
      }
      if (repair.commands) {
        commands = settings.commands = { ...commands, ...repair.commands };
        validationResponsibility.commands = commands;
        repairedInstall ||= repair.commands.install !== undefined;
      }
      serviceChecks.clear();
      server = undefined;
      revision = 1;
      if (
        complaints.length &&
        complaints.every(({ id }) => id.startsWith('ui/'))
      ) {
        await setupWorkspace();
        return operations.ui();
      }
      if (
        complaints.length &&
        complaints.every(({ id }) => id.startsWith('validation/'))
      ) {
        await setupWorkspace();
        return operations.validate();
      }
    }
    revision = 0;
    ciAttempts = 0;
    // Terminal exhaustion can release clean worktrees, including ignored dependencies.
    await setupWorkspace();
    ctx.stage('Continue review');
    // Restored worktrees can include commits made after the initial workspace
    // Step. Refresh the PR revision even if the fixer disagrees with all complaints.
    if (repositories) await push();
    else pr = { ...pr, headSha: await shell(ctx, 'git rev-parse HEAD') };
    // CI nodes bind ci-fixer, not the review fixer. Revalidate the current head
    // and poll fresh CI before asking for repairs; the old failure may already
    // be fixed and its journaled logs must not drive another blind edit.
    if (complaints.length && complaints.every(({ id }) => id.startsWith('ci/')))
      return 'retry';
    const fixed = await actors.call('fixer', {
      label: 'Repair outstanding complaints before the next review batch',
      input: {
        issue,
        delivery,
        complaints,
        commands,
        validationResponsibility,
      },
      schema: FixReportFor(complaints),
    });
    changes.push(fixed.summary);
    if (fixed.resolutions.some(({ status }) => status === 'fixed'))
      await push();
    complianceState = {
      complaints: [...complaints],
      resolutions: fixed.resolutions,
    };
    reviewerState = complianceState;
    return 'retry';
  }

  async function review(
    name: 'compliance-reviewer' | 'reviewer',
    revision: number,
    previous: ReviewState,
    rules?: string,
  ) {
    const namespace = `${name}/${revision}/1`;
    const disagreements = previous.resolutions
      .filter(({ status }) => status === 'disagreed')
      .map(({ id, note }) => {
        const complaint = previous.complaints.find(
          (complaint) => complaint.id === id,
        );
        if (!complaint) throw new Error(`Missing complaint ${id}.`);
        return { id, text: complaint.text, why: note };
      });
    const previousHead = reviewedHeads.get(name);
    const reviewHistory = history.snapshot();
    const result = await actors.call(name, {
      label: `${name} ${revision}/${reviewCap}`,
      input: {
        issue,
        delivery,
        diff: repositories
          ? await repositories.diff(reviewedRepositoryHeads.get(name))
          : previousHead
            ? await shell(ctx, `git diff ${quote(previousHead)}..HEAD`)
            : await diff(),
        reviewScope: {
          kind: previousHead ? 'incremental' : 'initial',
          base:
            previousHead ??
            (repositories
              ? 'Each repository’s configured target branch'
              : 'origin/HEAD'),
          head: repositories?.revision ?? pr.headSha,
          ...(repositories ? { repositories: repositories.heads } : {}),
        },
        namespace,
        disagreements,
        validation: { summary: validationSummary, ...validationResponsibility },
        ...(rules === undefined ? {} : { rules }),
      },
      schema: ReviewFor(
        namespace,
        name === 'compliance-reviewer' ? ticket : undefined,
        reviewHistory.filter((issue) => issue.status !== 'ignored'),
      ),
    });
    reviewedHeads.set(name, repositories?.revision ?? pr.headSha);
    if (repositories) reviewedRepositoryHeads.set(name, repositories.heads);
    const complaints = history.review(
      result,
      name,
      repositories?.revision ?? pr.headSha,
    );
    if (!complaints.length) return { complaints, resolutions: [] };
    if (revision === reviewCap) return { complaints, resolutions: [] };
    const fixed = await actors.call('fixer', {
      label: `${name} fixer ${revision}/${reviewCap}`,
      input: {
        issue,
        delivery,
        complaints,
        commands,
        validationResponsibility,
      },
      schema: FixReportFor(complaints),
    });
    changes.push(fixed.summary);
    if (fixed.resolutions.some(({ status }) => status === 'fixed'))
      await push();
    return { complaints, resolutions: fixed.resolutions };
  }

  const passedCiHeads = new Set<string>();
  async function checkCi(candidate: ScmPr = pr) {
    const key = `${candidate.repo}\0${candidate.headSha}`;
    if (passedCiHeads.has(key)) return { changed: false, complaints: [] };
    let ci = requireScm(
      await ctx.scm.waitForCi(candidate, { logTailLines: ciLogLines }),
    );
    if (ci.headSha !== candidate.headSha)
      throw new Error(
        'CI returned another head. Refresh the branch and run validation again.',
      );
    let retryRefusal: ScmRefusal | undefined;
    while (ci.status === 'failed' && ciAttempts < ciCap) {
      ciAttempts++;
      const fix = await actors.call('ci-fixer', {
        label: `ci-fixer ${ciAttempts}/${ciCap}`,
        input: {
          issue,
          delivery,
          failedJobs: ci.failedJobs,
          ...(retryRefusal ? { retryRefusal } : {}),
          pullRequest: candidate,
          ciRepairPolicy:
            'This runtime policy overrides older prompt text where it conflicts. Follow the repository’s own instructions and failed-check evidence. The supplied logs are bounded excerpts, not complete job logs. If they lack the original diagnostic, retrieve the failed job’s full log with the configured platform CLI using its supplied job ID before declaring the repair unresolved; inspect the failed step and run the affected repository check locally when feasible. A committed repair with passing relevant local checks is action fixed: the Workflow pushes it, reruns validation, and verifies CI on the new PR head. Do not mark it unresolved merely because you cannot push or observe that future CI yet. You may update metadata only on the supplied PR when a failed check requires it. If CI needs a branch event after that change, create a repository-compliant empty commit locally; the Workflow pushes it. Never merge or weaken a check.',
          commands,
          ...(repositories ? { repository: candidate.repo } : {}),
        },
        schema: CiFix,
      });
      changes.push(fix.summary);
      if (fix.action === 'unresolved') {
        if (settings.ciUnresolvedCommitVersion) {
          // The verdict can describe remote CI as pending even after the
          // fixer committed a tested repair. Reconcile its local branch
          // before treating the failure as terminal. This adds Steps only
          // for new snapshots; old journals keep their original suffix.
          const before = repositories?.revision ?? pr.headSha;
          await push('ci-fixer');
          if ((repositories?.revision ?? pr.headSha) !== before)
            return { changed: true, complaints: [] };
        }
        break;
      }
      if (fix.action === 'fixed') {
        await push('ci-fixer');
        return { changed: true, complaints: [] };
      }
      if (settings.ciRetryVersion) {
        // A retry label is advisory: agents may have created commits or left
        // uncommitted repairs. Reconcile the complete delivery and revalidate
        // changed heads before consuming a retry against the old remote SHA.
        const before = repositories?.revision ?? pr.headSha;
        await push('ci-fixer');
        if ((repositories?.revision ?? pr.headSha) !== before)
          return { changed: true, complaints: [] };
      }
      // The fixer has already received this refusal. Repeating the same
      // request against an unchanged head supplies no new evidence.
      if (settings.ciRetryRefusalVersion && retryRefusal) break;
      const retry = await ctx.scm.retryFailedJobs(candidate);
      if (settings.ciRetryVersion && retry && 'refused' in retry) {
        retryRefusal = retry;
        // Retry refusal is evidence for the fixer, not a successful retry.
        // The existing CI allowance bounds integration recovery attempts.
        if (retry.reason === 'head_changed' || retry.reason === 'not_open')
          requireScm(retry);
        continue;
      }
      requireScm(retry);
      retryRefusal = undefined;
      ci = requireScm(
        await ctx.scm.waitForCi(candidate, { logTailLines: ciLogLines }),
      );
      if (ci.headSha !== candidate.headSha)
        throw new Error(
          'CI returned another head. Refresh the branch and run validation again.',
        );
    }
    if (ci.status === 'passed') passedCiHeads.add(key);
    return {
      changed: false,
      complaints:
        ci.status === 'passed'
          ? []
          : [
              {
                id: `ci/${ciAttempts}/failed`,
                file: repositories ? candidate.repo : '.',
                text: `CI did not pass: ${JSON.stringify(ci)}`,
              },
            ],
    };
  }

  async function inspectUi(
    configuredUi: {
      start: string;
      endpoint: UiEndpoint;
      workspace: string;
      external?: boolean;
      key?: string;
    } | null,
    revision: number,
    previousExplanations: string[],
  ) {
    const rules = await loadRules(ctx, snapshotDir);
    const serviceKey = configuredUi?.key ?? '1';
    let checks = serviceChecks.get(serviceKey);
    if (!checks) {
      checks = (
        await actors.call('ui-planner', {
          input: {
            issue,
            delivery,
            diff: await diff(),
            rules,
            ...(settings.environmentVersion
              ? {
                  environment: environmentContext,
                  environmentInstruction:
                    'Use verified endpoints and authentication references, resolving document references relative to the named repository in the workspace. An ok result requires executed: true. Never mark an unexecuted or unreachable check ok. Report blocked coverage using the blocked verdict, without inventing a product defect or weakening acceptance criteria. A documented-local authentication reference may be read only for local login instructions; never reproduce credentials in output.',
                }
              : {}),
            ...(settings.uiPlanEndpointVersion
              ? {
                  endpointInstruction:
                    'Every check URL must be a path beginning with one slash, relative to the supplied live UI base URL. Do not embed localhost, a port, or an absolute service URL in a check URL or action. The service may move to a different port on another Boot.',
                }
              : {}),
          },
          schema: settings.uiPlanEndpointVersion
            ? Checks.refine(
                ({ checks }) =>
                  checks.every(({ url }) => isRelativeUiPath(url)),
                'Each UI check URL must be a path relative to the verified service',
              )
            : Checks,
        })
      ).checks;
      serviceChecks.set(serviceKey, checks);
    }
    const namespace = `ui/${revision}/${serviceKey}`;
    let complaints: Complaint[];
    if (!configuredUi) {
      // Frozen pre-versioned flows recorded planner/fixer steps here. Preserve
      // their sequence and complaint identity instead of inserting exhaustion effects.
      complaints = [
        {
          id: `${namespace}/config`,
          file: 'workflow.json',
          text: 'The change involves a frontend but ui is not configured. Set its start command and URL in Flow settings, then start a new Run.',
        },
      ];
    } else {
      if (!ctx.ports[0] && !configuredUi.external)
        throw new Error('The UI stage needs a reserved ctx.ports[0].');
      if (!server && !configuredUi.external)
        server = await ctx.exec(
          `{ cd -- ${quote(configuredUi.workspace)} && export PORT=${ctx.ports[0]} && { ${configuredUi.start}\n}; } > ${quote(serverLog)} 2>&1`,
          { background: true, label: 'dev server' },
        );
      // Probe again on every Boot; only the recorded result chooses the replay path.
      let ready = false;
      let url: string | undefined;
      for (let attempt = 0; attempt < readiness.attempts; attempt++) {
        try {
          const log = await readFile(serverLog, 'utf8').catch(() => '');
          url = await resolveUiEndpoint(configuredUi.endpoint, {
            port: ctx.ports[0],
            log,
            workspace: configuredUi.workspace,
          });
          if (!url) throw new Error('endpoint not reported yet');
          const response = await fetch(url, {
            signal: AbortSignal.timeout(Math.max(1, readiness.intervalMs)),
          });
          ready = response.ok;
          await response.body?.cancel();
        } catch {
          /* A booting server commonly refuses connections. */
        }
        if (ready) break;
        await new Promise((resolve) =>
          setTimeout(resolve, readiness.intervalMs),
        );
      }
      const boot = await ctx.step(`UI readiness ${revision}/1`, async () => ({
        ready,
        log: ready
          ? ''
          : await readFile(serverLog, 'utf8').catch(
              (error: NodeJS.ErrnoException) => {
                if (error.code === 'ENOENT')
                  return 'The dev server did not become ready and produced no log.';
                throw error;
              },
            ),
      }));
      if (settings.environmentVersion && (!boot.ready || !ready))
        throw new EnvironmentBlocked({
          kind: 'environment',
          code: 'service',
          capability: serviceKey,
          action:
            'The UI endpoint is unreachable on this Boot. Repair its service configuration and resume.',
        });
      if (url) checks = bindChecksToEndpoint(checks, url);
      let observations: Observation[];
      if (!boot.ready) {
        observations = [
          {
            url: url ?? 'http://127.0.0.1/',
            text: `Dev server failed to become ready.\n${boot.log}`,
            screenshots: [],
          },
        ];
        if (server)
          await ctx.exec(`kill -TERM -${server.pid} 2>/dev/null || true`, {
            label: 'stop failed dev server',
          });
        server = undefined;
      } else {
        let fixtures;
        if (settings.uiFixtureVersion && execution && configuredUi.external) {
          const fixtureEvidenceDirectory = join(
            runDir,
            'workspace',
            '.rocky-evidence',
          );
          await mkdir(fixtureEvidenceDirectory, {
            recursive: true,
            mode: 0o700,
          });
          const available = catalogEntries(settings.execution ?? []).filter(
            ({ command }) => command.policy !== 'manual',
          );
          const schema = uiFixturesSchema(
            checks,
            available.map((entry) => entry.id),
          );
          const sourceRevision = async (phase: string) => {
            const revisions = [];
            for (const member of workspace.members) {
              const result = await ctx.exec(
                `cd -- ${quote(join(runDir, 'workspace', member.path))} && git rev-parse HEAD && git diff --no-ext-diff HEAD -- | git hash-object --stdin`,
                {
                  label: `UI fixture source ${phase} ${revision}/${serviceKey}/${member.name}`,
                },
              );
              if (result.exitCode !== 0)
                throw new Error(
                  'Cannot verify source state around UI fixture preparation.',
                );
              revisions.push(result.stdout);
            }
            return revisions.join('\n');
          };
          const sourceBefore = await sourceRevision('before');
          const prepared = await prepareUiFixtures({
            prepare: (attempt, previous) =>
              actors.call('fixer', {
                label: `Prepare UI fixtures ${revision}/${serviceKey}/${attempt}`,
                screenshotWrite: true,
                blockedAsResult: !!settings.uiFixtureRecoveryVersion,
                input: {
                  issue,
                  workspace,
                  checks,
                  baseUrl: url!,
                  screenshotDirectory: join(runDir, 'screenshots'),
                  fixtureEvidenceDirectory,
                  environment: environmentContext,
                  availableCommands: available,
                  validationResponsibility,
                  validationSummary,
                  previousRepairs: [...environmentRepairHistory],
                  previous,
                  instruction:
                    "Prepare the local prerequisites for EVERY supplied browser check before visual inspection. Read repository instructions and actual component/route usage. Consult validationSummary and previousRepairs for setup already executed; inspect its local results before requesting the same seed or install again. A passed setup command is evidence to investigate, not proof of fixture readiness. Locate or create authorized local seed data, role/session states, and documented component previews where needed. A reachable server alone is not fixture readiness. Establish each check's access, data and initial conditions, then exercise its entry route or action in the browser. This is not acceptance review: after those prerequisites are verified, an application error, endless loading state, or missing/broken control is product evidence for the inspector, not a reason to demand more setup. Hand off repeatable steps and an honest screenshot of the actual defective state; do not claim the expected behavior passed. Return executed:true only for entry/actions you actually exercised. A tool failure or unavailable prerequisite still blocks readiness. Supply its concrete URL path relative to baseUrl (never a cached host/port), repeatable navigation/setup instructions, and source as an array of existing repository-relative file paths documenting the route or fixture (one exact path per element, without line numbers, prose, or joined path lists), and a browser screenshot captured in screenshotDirectory proving the intended state is reachable. If a check needs locally generated login credentials, save them in a private mode 0600 file inside fixtureEvidenceDirectory, return its absolute path as credentialFile for that check, and name the matching account role in instructions. The independent inspector can read the supplied credential file and operate the browser, but cannot run seed commands, edit files or the database, or repair source. Every returned fixture must be repeatable with those capabilities. After proving a state, restore its initial conditions or create a separate unused fixture for inspection. Do not hand off consumed one-time links, an already-enrolled setup account, or mutually incompatible global settings unless the instructions restore them through supported browser controls. Use distinct local identities when checks change account state. Do not return credential values. Keep fixture data ephemeral; do not modify tracked application or test sources during preparation. Search only targeted repository paths, not the entire host. Bound browser and shell commands; if navigation or a tool stalls, stop or reconcile it before returning a blocked result. An unfinished tool call cannot be accepted as a fixture result. Preserve all check IDs and acceptance criteria. Do not invent inaccessible variants, waive coverage, change production behavior just to manufacture a preview, fabricate evidence, or include credentials in results. If a state has no product route, use a repository-supported local component preview or test fixture; explain its provenance. Choose setup only for commands in availableCommands; the host executes them and calls you again to verify readiness. Repair local fixture problems within this task. Missing external credentials, authorization, or unavailable external infrastructure must be reported as blocked. This is environment preparation, not a product review.",
                },
                schema,
              }),
            setup: async (ids, attempt) => {
              const selected = dependencyOrder(
                catalogEntries(settings.execution ?? []),
                ids,
                ({ command }) => command.dependsOn,
              );
              if (selected.some(({ command }) => command.policy === 'manual'))
                throw new Error(
                  'UI fixture setup cannot execute manual commands.',
                );
              const provisioned = await ensure(
                [serviceKey],
                `UI fixture setup ${revision}/${serviceKey}/${attempt}`,
                [],
                selected.map((entry) => entry.id),
              );
              if (provisioned.status === 'blocked')
                throw new UiFixtureBlocked(provisioned.blocker, true);
            },
            verify: async (items) => {
              const receipt = await ctx.step(
                `UI fixture readiness ${revision}/${serviceKey}/${items.map((item) => item.id).join(',')}`,
                async () => {
                  try {
                    for (const fixture of items) {
                      if (fixture.credentialFile)
                        await verifyUiFixtureCredentialFile(
                          fixtureEvidenceDirectory,
                          fixture.credentialFile,
                        );
                      await execution!.checkSources(
                        fixture.repository,
                        Array.isArray(fixture.source)
                          ? fixture.source
                          : [fixture.source],
                      );
                      const target = new URL(fixture.url, url!);
                      const origins = new Set(
                        Object.values(
                          environmentContext?.endpoints ?? {},
                        ).flatMap((endpoints) =>
                          Object.values(endpoints).map(
                            (endpoint) => new URL(endpoint).origin,
                          ),
                        ),
                      );
                      origins.add(new URL(url!).origin);
                      if (
                        !origins.has(target.origin) ||
                        target.username ||
                        target.password
                      )
                        throw new Error(
                          `Fixture ${fixture.id} must use a verified local service endpoint.`,
                        );
                      const evidence = await realpath(fixture.screenshot);
                      const inside = relative(
                        await realpath(join(runDir, 'screenshots')),
                        evidence,
                      );
                      if (
                        !inside ||
                        inside === '..' ||
                        inside.startsWith(`..${sep}`) ||
                        isAbsolute(inside) ||
                        !(await stat(evidence)).isFile()
                      )
                        throw new Error(
                          `Fixture ${fixture.id} needs browser evidence inside this Run's screenshot directory.`,
                        );
                      // A cookie-free host request cannot verify an authenticated
                      // state. The preparer's browser evidence is followed by an
                      // independent inspector using the repeatable instructions.
                    }
                    return { ready: true, error: '' };
                  } catch (error) {
                    return {
                      ready: false,
                      error:
                        error instanceof Error
                          ? error.message
                          : 'Fixture probe failed',
                    };
                  }
                },
              );
              if (!receipt.ready) throw new Error(receipt.error);
            },
          });
          if (prepared.status !== 'ready') {
            const reason =
              prepared.status === 'blocked' ? prepared.reason : 'environment';
            throw new UiFixtureBlocked(
              {
                kind: reason === 'environment' ? 'environment' : 'human',
                code: reason === 'environment' ? 'verification' : reason,
                capability: serviceKey,
                action: prepared.summary,
              },
              true,
            );
          }
          if ((await sourceRevision('after')) !== sourceBefore)
            throw new UiFixtureSourceChanged(
              'Fixture preparation changed tracked source; validation must run again.',
            );
          fixtures = prepared.fixtures;
        }
        const screenshotDir = join(runDir, 'screenshots');
        const result = await actors.call('ui-inspector', {
          label: `ui-inspector ${revision}/${reviewCap}`,
          input: {
            baseUrl: url!,
            checks,
            rules,
            endpointInstruction:
              "The supplied baseUrl is this Boot's verified frontend. Resolve relative check URLs against it; use the supplied rebound URL for older plans. Never follow a port mentioned in earlier prose when it differs from baseUrl.",
            previousExplanations,
            ...(fixtures
              ? {
                  fixtures,
                  fixtureInstruction:
                    'Use the supplied prepared fixtures and their repeatable instructions for every check. If a fixture supplies credentialFile, read that private local file with your read_file tool, select the account role named in instructions, and use it only for local browser login. Never copy credential values into results, screenshots, notes, or comments. Verify the actual state in the browser; readiness evidence is not a visual pass. Preserve all checks and report any regressed prerequisite as blocked.',
                }
              : {}),
            ...(settings.environmentVersion
              ? {
                  environment: environmentContext,
                  environmentInstruction:
                    'Use verified endpoints and authentication references, resolving document references relative to the named repository in the workspace. An ok result requires executed: true. Never mark an unexecuted or unreachable check ok. Report blocked coverage using the blocked verdict, without inventing a product defect or weakening acceptance criteria. A documented-local authentication reference may be read only for local login instructions; never reproduce credentials in output.',
                }
              : {}),
          },
          schema: CheckResultsFor(
            checks,
            screenshotDir,
            settings.environmentVersion,
          ),
        });
        const blocked = result.results.find(
          (check) => check.verdict === 'blocked',
        );
        if (blocked?.verdict === 'blocked')
          throw new EnvironmentBlocked(
            {
              kind: ['credentials', 'permission', 'external'].includes(
                blocked.reason,
              )
                ? 'human'
                : 'environment',
              code:
                blocked.reason === 'environment'
                  ? 'verification'
                  : blocked.reason,
              capability: blocked.id,
              action: `UI inspection could not execute required coverage. ${result.results
                .filter((check) => check.verdict === 'blocked')
                .map((check) => `${check.id}: ${check.note}`)
                .join(
                  '\n',
                )}. Repair local prerequisites or supply required access; do not waive checks.`,
            },
            true,
          );
        observations = result.results.flatMap((result) => result.observations);
        uiSummary = `${result.summary}\n${result.results.map((check) => `- ${check.id}: ${check.verdict}. ${check.note}`).join('\n')}`;
      }
      complaints = await ctx.parallel(
        observations,
        async (observation, index) =>
          actors.call('ui-complaint-writer', {
            label: `ui-complaint-writer ${revision}/${reviewCap} ${index + 1}`,
            input: {
              observation,
              changedFiles: await ctx.changedFiles(),
              namespace: `${namespace}/${index}`,
            },
            schema: ComplaintFor(`${namespace}/${index}`),
          }),
      );
    }
    history.add(complaints, 'ui', pr.headSha);
    complaints = complaints.filter(
      (complaint) => complaint.severity !== 'nit-pick',
    );
    if (!complaints.length) return { complaints, resolutions: [] };
    if (revision === reviewCap) return { complaints, resolutions: [] };
    const fixed = await actors.call('fixer', {
      label: `UI fixer ${revision}/${reviewCap}`,
      input: { issue, delivery, complaints, commands },
      schema: FixReportFor(complaints),
    });
    changes.push(fixed.summary);
    if (fixed.resolutions.some(({ status }) => status === 'fixed'))
      await push();
    return { complaints, resolutions: fixed.resolutions };
  }

  async function repositoryConversations() {
    if (!repositories)
      throw new Error('Repository delivery is not configured.');
    await repositories.sync(ctx.issue.title, ctx.issue.url);
    const threads = [];
    for (const candidate of repositories.open) {
      const found = requireScm(await ctx.scm.reviewThreads(candidate));
      threads.push(
        ...found
          .filter((thread) => !thread.resolved && thread.resolvable !== false)
          .map((thread) => ({ thread, repo: candidate.repo })),
      );
    }
    const complaints = threads.map(({ thread, repo }, index) =>
      Complaint.parse({
        id: `threads/${index}/c1`,
        file: thread.path ? `${repo}/${thread.path}` : repo,
        ...(thread.line === undefined ? {} : { line: thread.line }),
        text: thread.body,
      }),
    );
    if (!complaints.length) return 'completed';
    const fixed = await actors.call('fixer', {
      input: { issue: ctx.issue, complaints, commands },
      schema: FixReportFor(complaints),
    });
    await repositories.sync(ctx.issue.title, ctx.issue.url);
    for (const [index, { thread, repo }] of threads.entries()) {
      const resolution = fixed.resolutions.find(
        (r) => r.id === complaints[index].id,
      );
      if (!resolution)
        throw new Error(`Missing resolution for ${complaints[index].id}`);
      requireScm(
        await ctx.scm.replyToThread(
          thread,
          resolution.status === 'fixed'
            ? `Fixed in ${repositories.heads[repo]}. ${resolution.note}`
            : resolution.note,
        ),
      );
    }
    for (const candidate of repositories.open)
      await ctx.visualRecap({
        pr: candidate,
        scope: {
          issue: ctx.issue,
          resolutions: fixed.resolutions,
          pullRequests: repositories.current,
        },
        agents: actors.recap(),
      });
    return 'completed';
  }

  async function mergeRepositories() {
    if (!repositories || answer?.decision !== 'approve')
      throw new Error('Merge requires approval of the complete PR set.');
    let revalidate = false;
    // Check all branches before asking any platform to merge one.
    for (const candidate of repositories.open) {
      const update = requireScm(await ctx.scm.updateBranch(candidate));
      const adoptSource =
        update.status === 'updated' || update.pr.headSha !== candidate.headSha;
      repositories.set(update.pr);
      if (update.status === 'clean' && !adoptSource) continue;
      revalidate = true;
      await repositories.markDraft(true);
      await repositories.shell(candidate.repo, 'git fetch origin');
      const result = await repositories.exec(
        candidate.repo,
        `git merge --no-edit -- ${quote(`refs/remotes/origin/${adoptSource ? update.pr.sourceBranch : update.pr.baseBranch}`)}`,
      );
      const conflicts = await repositories.shell(
        candidate.repo,
        'git diff --name-only --diff-filter=U',
      );
      if (update.status === 'conflict' || conflicts) {
        const fixed = await actors.call('merger', {
          input: {
            issue,
            delivery,
            repository: candidate.repo,
            update,
            conflicts,
            commands,
          },
        });
        changes.push(fixed.summary);
      } else if (result.exitCode !== 0)
        throw new Error(
          `${candidate.repo}: could not adopt the branch update: ${result.stderr}`,
        );
    }
    if (revalidate) {
      await push('merger');
      return 'retry';
    }
    if (!(await readyAfterApproval())) return retryMerge();
    for (const candidate of repositories.open) {
      const result = await ctx.scm.armAutoMerge(candidate, answer);
      if ('refused' in result) {
        await ctx.post(`${result.message}\n${result.fix}`);
        if (
          result.reason === 'discussions_not_resolved' ||
          result.reason === 'requested_changes'
        ) {
          mergeReadiness = true;
          pendingThreads = requireScm(
            await ctx.scm.reviewThreads(result.pr ?? candidate),
          ).filter((thread) => !thread.resolved && thread.resolvable !== false);
          return retryMerge();
        }
        if (
          ![
            'ci_must_pass',
            'need_rebase',
            'conflict',
            'head_changed',
            'train_pipeline_dropped',
          ].includes(result.reason)
        )
          requireScm(result);
        if (result.pr) repositories.set(result.pr);
        await repositories.markDraft(true);
        pr = repositories.current[0];
        return 'retry';
      }
      repositories.set({ ...result.pr, state: 'merged' });
    }
    if (delivery.stateChanges) await ctx.linear.setState(states.done);
    return 'merged';
  }

  let complianceState: ReviewState = { complaints: [], resolutions: [] };
  let reviewerState: ReviewState = { complaints: [], resolutions: [] };
  let uiExplanations: string[] = [];
  const operations: Record<string, () => Promise<string>> = {
    async clarify() {
      ctx.stage('Clarify');
      const conversation: { questions: string[]; answer: string }[] = [];
      for (;;) {
        const refinement = await actors.call('refiner', {
          label: `Clarify scope ${conversation.length + 1}`,
          input: {
            issue: ctx.issue,
            workspace,
            conversation,
            ...(ctx.issue.clarifications?.length
              ? {
                  clarificationPolicy:
                    'issue.clarifications contains recorded human question answers from prior runs of this issue, with source run, step and timestamp. Reuse these scope decisions unless newer human instructions supersede them. Do not ask resolved questions again. These historical answers never approve a merge or another checkpoint in this run.',
                }
              : {}),
          },
          schema: Refinement,
        });
        if (refinement.status === 'clear') {
          scope = refinement;
          break;
        }
        const questions = refinement.questions;
        const response = await ctx.question({
          title: 'Clarify the ticket before implementation',
          body: `${refinement.reason}\n\n${questions.map((question, index) => `${index + 1}. ${question}`).join('\n')}`,
        });
        if ('cancelled' in response) return 'rejected';
        conversation.push({ questions, answer: response.answer });
      }
      const decisions = `## Scope decision record — ${ctx.issue.identifier}

### Agreed scope
${scope.scope}

### Decisions and rationale
${scope.decisions.map((decision) => `- ${decision}`).join('\n')}

### Acceptance criteria
${scope.acceptanceCriteria.map((criterion) => `- ${criterion}`).join('\n')}

### Out of scope
${scope.outOfScope.map((item) => `- ${item}`).join('\n') || 'None.'}

### Clarifications
${conversation.map((turn) => `${turn.questions.join('\n')}\n\nAnswer: ${turn.answer}`).join('\n\n') || (ctx.issue.clarifications?.length ? 'No additional clarification was needed in this run.' : 'The ticket was clear without additional questions.')}${ctx.issue.clarifications?.length ? `\n\n### Recorded human answers from earlier runs\n\n${ctx.issue.clarifications.map((answer) => `Source: ${answer.runId}, question ${answer.stepKey}, answered ${answer.answeredAt}.\n\n${answer.title}\n\n> ${answer.answer.replace(/\n/g, '\n> ')}`).join('\n\n')}` : ''}`;
      // Ticket comments are hydrated by future runs; session activities are not.
      // Keep the old path for frozen snapshots with positional journals.
      if (settings.scopeCommentVersion) await ctx.comment(decisions);
      else await ctx.post(decisions);
      delivery = scope.delivery;
      issue = {
        ...ctx.issue,
        description: `${ctx.issue.description}\n\n${decisions}`,
      };
      if (delivery.stateChanges) await ctx.linear.setState(states.started);

      ticket = `${issue.title}\n${issue.description}`;
      return delivery.kind === 'linear-comment' ? 'comment' : 'pr';
    },
    async deliverable() {
      // Check installed validation support before spending any drafting/review turns.
      await validateDiagrams(ctx, '');
      let previous: { body: string; problems: string[] } | undefined;
      for (let revision = 1; ; revision++) {
        if (revision > reviewCap) {
          await ctx.post(
            `Deliverable review exhausted; nothing published.\n${previous?.problems.join('\n')}`,
          );
          if (continuations === 0) return 'exhausted';
          continuations--;
          revision = 1;
        }
        ctx.stage('Prepare deliverable');
        const draft = await actors.call('deliverable-writer', {
          input: {
            issue,
            workspace,
            delivery,
            acceptanceCriteria: scope.acceptanceCriteria,
            previous,
            reviewContract,
          },
          schema: Deliverable,
        });
        ctx.stage('Validate deliverable');
        const validation = await validateDiagrams(ctx, draft.body);
        if (!validation.ok) {
          previous = {
            body: draft.body,
            problems: validation.diagrams
              .filter((item) => !item.valid)
              .map(
                (item) =>
                  `Mermaid diagram ${item.index}: ${item.error ?? 'syntax is invalid'}`,
              ),
          };
          continue;
        }
        ctx.stage('Review deliverable');
        const reviews = await ctx.parallel(
          ['acceptance', 'accuracy'],
          async (focus) =>
            actors.call('deliverable-reviewer', {
              label: `Deliverable ${focus} ${revision}/${reviewCap}`,
              input: {
                issue,
                workspace,
                delivery,
                body: draft.body,
                reviewContract,
                validation,
                acceptanceCriteria: scope.acceptanceCriteria,
                focus,
              },
              schema: DeliverableReviewFor(scope.acceptanceCriteria),
            }),
        );
        const problems = reviews.flatMap((review) => [
          ...review.problems,
          ...review.assessments.flatMap((item) => item.problems),
        ]);
        if (!problems.length) {
          const recap = () =>
            ctx.visualRecap({
              deliverable: draft.body,
              title: issue.title,
              scope: settings.recapDecisionVersion
                ? {
                    ...scope,
                    handoffPhase: {
                      stage: 'before-close',
                      instruction:
                        'The reviewed comment is published. Assess whether its content fulfills the agreed scope. Rocky closes the issue only after this recap succeeds. The pending workflow-owned closure alone is not a gap. Required content or evidence gaps still need attention.',
                    },
                  }
                : scope,
              agents: actors.recap(),
            });
          // Old snapshots recorded the recap before publication. Choose the
          // sequence from the frozen snapshot, never from the next replay Step:
          // a new Run can also resume inside reviewReport after publication.
          if (!settings.commentDeliveryVersion) {
            ctx.stage('Visual recap');
            try {
              await recap();
            } catch (error) {
              if (!isRecapAuditError(error)) throw error;
              previous = { body: draft.body, problems: error.problems };
              continue;
            }
            ctx.stage('Deliver');
            await ctx.comment(draft.body);
            if (delivery.stateChanges) await ctx.linear.setState(states.review);
            return 'completed';
          }
          ctx.stage('Deliver');
          // Publishing belongs to the Workflow, not an Agent's tools or summary.
          await ctx.comment(draft.body);
          ctx.stage('Visual recap');
          // This recap sees the published comment. Closure follows its verdict.
          // A recap audit failure must not redraft and post a second comment.
          const report = await recap();
          if (
            settings.recapDecisionVersion &&
            report.decision?.status !== 'ready'
          ) {
            await ctx.post(
              `The delivered comment's recap still requires attention: ${report.decision?.summary ?? 'No decision was returned.'}\n${report.decision?.actions.join('\n') ?? ''}`,
            );
            return 'exhausted';
          }
          if (delivery.stateChanges) {
            await ctx.linear.setState(states.done);
            await ctx.step('Confirm delivered issue state', () => ({
              state: states.done,
            }));
          }
          return 'completed';
        }
        previous = { body: draft.body, problems };
      }
    },
    async plan() {
      ctx.stage('Plan');
      plan = await actors.call('planner', {
        input: { issue, workspace, delivery, diff: await diff() },
        schema: Plan,
      });
      await ctx.post(
        `${plan.summary}\n\n${plan.steps.map((step, index) => `${index + 1}. ${step}`).join('\n')}`,
      );

      return 'next';
    },
    async implement() {
      if (!(settings.environmentVersion && execution)) await setupWorkspace();
      if (settings.environmentVersion && execution) {
        let result: EnvironmentResult;
        try {
          result = await ensure(
            [],
            'Baseline',
            [],
            settings.workspaceSetup
              ? (await selectedCommands('install')).map((entry) => entry.id)
              : [],
          );
        } finally {
          await execution.stop('Baseline');
        }
        if (result.status === 'blocked')
          return environmentFailure(result.blocker, operations.implement);
      }
      ctx.stage('Implement');
      const implementation = await actors.call('implementer', {
        input: {
          issue,
          workspace,
          delivery,
          plan,
          commands,
          environment: environmentContext,
          validationResponsibility,
        },
      });
      if (!repositories) await shell(ctx, 'git push origin HEAD');
      description = `${issue.url}\n\n${plan.summary}`;
      if (repositories) await push('implementer');
      else
        pr = requireScm(
          await ctx.scm.openPr({
            title: `${issue.identifier}: ${issue.title}`,
            body: description,
            draft: true,
          }),
        );

      changes.push(implementation.summary);
      return 'next';
    },
    async validate() {
      revision++;
      passedCiHeads.clear();
      if (revision > reviewCap)
        return exhaust([
          {
            id: 'checkpoint/cap',
            file: '.',
            text: 'The validation cycle cap was exhausted.',
          },
        ]);
      ctx.stage('Validate');
      await repairMergeThreads();
      const validationProblems: Complaint[] = [];
      const validations: string[] = [];
      if (execution) {
        const failed = new Set<string>();
        const selected = await selectedCommands('validate');
        const services = settings.validationEnvironmentVersion
          ? [
              ...new Set(
                selected.flatMap(({ command }) =>
                  Object.values(command.endpointEnv ?? {}).map(
                    ({ service }) => service,
                  ),
                ),
              ),
            ]
          : [];
        const label = `Validation services ${revision}`;
        try {
          if (services.length) {
            const result = await ensure(services, label, [], [], false);
            if (result.status === 'blocked')
              return await environmentFailure(
                result.blocker,
                operations.validate,
              );
            ctx.stage('Validate');
          }
          for (const entry of selected) {
            if (entry.command.dependsOn.some((id) => failed.has(id))) {
              failed.add(entry.id);
              failedValidationChecks.add(entry.id);
              validations.push(
                `${entry.id}: skipped because a prerequisite failed`,
              );
              continue;
            }
            const result = await execution.command(
              entry.id,
              `Validate ${entry.id} ${revision}/${reviewCap}`,
            );
            validations.push(
              `${entry.id}: ${result.exitCode === 0 ? 'passed' : 'failed'} (${entry.command.command})`,
            );
            if (result.exitCode !== 0) {
              failed.add(entry.id);
              failedValidationChecks.add(entry.id);
              validationProblems.push({
                id: `validation/${revision}/${entry.id}`,
                file: entry.repository.name,
                text: `${entry.command.name} failed (exit ${result.exitCode}): ${entry.command.command}\n${`${result.stdout}\n${result.stderr}`.slice(-12000)}`,
              });
            } else failedValidationChecks.delete(entry.id);
          }
        } finally {
          if (services.length) await execution.stop(label);
        }
      }
      for (const [name, command] of Object.entries(commands)) {
        if (name === 'install' || !command.trim()) continue;
        const result = await ctx.exec(
          `cd -- "$ROCKY_LEAD_REPO" && ${command}`,
          {
            label: `Validate ${name} ${revision}/${reviewCap}`,
          },
        );
        validations.push(
          `${name}: ${result.exitCode === 0 ? 'passed' : 'failed'} (${command})`,
        );
        if (result.exitCode !== 0)
          validationProblems.push({
            id: `validation/${revision}/${name}`,
            file: '.',
            text: `${name} failed (exit ${result.exitCode}): ${command}\n${`${result.stdout}\n${result.stderr}`.slice(-12000)}`,
          });
      }
      validationSummary =
        validations.join('\n') ||
        'No local validation commands configured; see CI and review evidence.';
      if (validationProblems.length) {
        if (revision === reviewCap) return exhaust(validationProblems);
        const fixed = await actors.call('fixer', {
          label: `Validation fixer ${revision}/${reviewCap}`,
          input: { issue, delivery, complaints: validationProblems, commands },
          schema: FixReportFor(validationProblems),
        });
        changes.push(fixed.summary);
        await push();
        return 'retry';
      }

      return 'next';
    },
    async compliance() {
      ctx.stage('Compliance');
      // Observe CI as soon as a draft exists. A review may use its entire
      // retry budget, so the later CI gate alone cannot hand failures to its fixer.
      // Recorded pre-watcher reviews retain their original step order on replay.
      if (
        !ctx.replaying ||
        ctx.replayStep === 'scm:waitForCi' ||
        ctx.replayStep?.startsWith('scm.waitForCi:')
      ) {
        for (const candidate of repositories?.open ?? [pr]) {
          if (settings.ciSkipRepositories?.includes(candidate.repo)) continue;
          const ci = await checkCi(candidate);
          if (ci.complaints.length) return exhaust(ci.complaints);
          if (ci.changed) return 'retry';
        }
      }
      const compliance = await review(
        'compliance-reviewer',
        revision,
        complianceState,
      );
      if (compliance.complaints.length) {
        if (revision === reviewCap) return exhaust(compliance.complaints);
        complianceState = compliance;
        return 'retry';
      }
      complianceState = { complaints: [], resolutions: [] };

      return 'next';
    },
    async ui() {
      ctx.stage('UI');
      if (execution && !repairedUi) {
        const catalog = serviceEntries(settings.execution ?? []);
        const available = catalog.filter(
          ({ service }) => service.policy !== 'manual',
        );
        const triage = await actors.call('ui-triage', {
          input: {
            changedFiles: await ctx.changedFiles(),
            diff: await diff(),
            services: available,
            ...(settings.environmentVersion
              ? {
                  capabilities: (settings.execution ?? []).flatMap((repo) =>
                    (repo.environment?.capabilities ?? []).map(
                      (capability) => ({
                        id: `${repo.id}/${capability.id}`,
                        kind: capability.kind,
                        sources: capability.sources,
                        services: capability.services,
                      }),
                    ),
                  ),
                  environmentInstruction:
                    'Select additional task-specific capability IDs for required fixtures, authentication and feature reachability. Do not weaken Checks when a capability is unavailable.',
                }
              : {}),
            instruction:
              'Identify frontend changes and select all relevant service IDs for UI inspection. Dependencies start automatically. Choose none for non-UI work. Explain your selection. Do not start processes yourself.',
          },
          schema: z.object({
            isFrontend: z.boolean(),
            selected: available.length
              ? z.array(z.enum(available.map((entry) => entry.id)))
              : z.array(z.string()).max(0),
            reason: z.string(),
            capabilities: z.array(z.string()).optional(),
          }),
        });
        const selected = [
          ...new Set([
            ...triage.selected,
            ...available
              .filter(({ service }) => service.policy === 'required')
              .map((entry) => entry.id),
          ]),
        ];
        await ctx.step(`Service selection ${revision}`, async () => ({
          ...triage,
          selected,
          skipped: available
            .filter((entry) => !selected.includes(entry.id))
            .map((entry) => entry.id),
        }));
        if (
          triage.isFrontend &&
          !selected.length &&
          settings.environmentVersion
        )
          return environmentFailure(
            {
              kind: 'environment',
              code: 'configuration',
              capability: 'ui',
              action:
                'Configure a UI service and its backend dependencies, then repair this Run configuration.',
            },
            operations.ui,
          );
        if (triage.isFrontend && !selected.length)
          return exhaust([
            {
              id: 'ui/config',
              file: 'Flow settings',
              text: 'UI changes need a dev service. Use Repair configuration and resume, and configure a service in the profile for future Runs.',
            },
          ]);
        recapServices = selected;
        recapCapabilities = triage.capabilities ?? [];
        if (!selected.length) return 'next';
        const label = `UI services ${revision}`;
        let retry: Complaint[] | undefined;
        try {
          let endpoints: Record<string, Record<string, string>>;
          if (settings.environmentVersion) {
            const result = await ensure(
              selected,
              label,
              triage.capabilities ?? [],
            );
            if (result.status === 'blocked')
              return await environmentFailure(result.blocker, operations.ui);
            endpoints = result.context.endpoints;
          } else endpoints = await execution.start(selected, label);
          for (const id of selected) {
            const service = catalog.find((entry) => entry.id === id)!.service;
            const inspection = await inspectUi(
              {
                start: '',
                endpoint: {
                  kind: 'fixed',
                  url: endpoints[id][service.readiness.endpoint],
                },
                workspace: '',
                external: true,
                key: id,
              },
              revision,
              uiExplanations,
            );
            if (inspection.complaints.length) {
              retry = inspection.complaints;
              uiExplanations = inspection.resolutions
                .filter(({ status }) => status === 'disagreed')
                .map(({ note }) => note);
              break;
            }
          }
        } catch (error) {
          if (error instanceof UiFixtureSourceChanged) {
            if (uiFixtureSourceRepairs >= 2)
              return environmentFailure(
                {
                  kind: 'environment',
                  code: 'verification',
                  capability: 'ui-fixtures',
                  action:
                    'Fixture preparation repeatedly changed tracked source. Repair the fixture recipe before continuing.',
                },
                operations.ui,
                false,
              );
            uiFixtureSourceRepairs++;
            await push();
            reviewCap++;
            return 'retry';
          }
          if (
            !(error instanceof EnvironmentBlocked) ||
            (ctx.replaying && !(settings.recoveryVersion && error.recorded))
          )
            throw error;
          if (settings.recoveryVersion)
            return await environmentFailure(
              error.blocker,
              operations.ui,
              !(error instanceof UiFixtureBlocked) ||
                !!settings.uiFixtureRecoveryVersion,
            );
          await execution.stop(label);
          if (
            error.blocker.kind === 'environment' &&
            environmentUiRepairs < 1
          ) {
            environmentUiRepairs++;
            ctx.stage('Environment: repairing');
            await ctx.step(
              `Environment repair ${environmentUiRepairs}`,
              async () => ({
                version: 1,
                scope: 'ui',
                action: 'restart-and-reverify',
                blocker: error.blocker,
              }),
            );
            return operations.ui();
          }
          return environmentFailure(error.blocker, operations.ui);
        } finally {
          await execution.stop(label);
        }
        if (retry) return revision === reviewCap ? exhaust(retry) : 'retry';
        uiExplanations = [];
        return 'next';
      }
      const triage = await actors.call('ui-triage', {
        input: {
          changedFiles: repositories
            ? await repositories.changedFiles()
            : await ctx.changedFiles(),
          diff: await diff(),
          recipes: Object.entries(
            repairedUi ? {} : (settings.repositories ?? {}),
          ).flatMap(([repository, recipes]) =>
            (recipes.ui ?? []).map(({ id }) => ({ repository, id })),
          ),
        },
        schema: UiTriage,
      });
      if (triage.isFrontend) {
        const candidates = Object.entries(
          repairedUi ? {} : (settings.repositories ?? {}),
        ).flatMap(([repository, recipes]) =>
          (recipes.ui ?? []).map((recipe) => ({ repository, recipe })),
        );
        const selected = triage.recipe
          ? candidates.find(
              ({ repository, recipe }) =>
                repository === triage.recipe?.repository &&
                recipe.id === triage.recipe.id,
            )
          : candidates.length === 1
            ? candidates[0]
            : undefined;
        const historicalMissingUi =
          settings.uiConfigurationVersion === undefined &&
          settings.repositories === undefined;
        if (
          !selected &&
          !ui &&
          !historicalMissingUi &&
          ctx.replayStep !== 'step'
        )
          return exhaust([
            {
              id: 'ui/config',
              file: 'Flow settings',
              text: 'UI inspection is required, but this Run has no UI start command or URL. Use Repair configuration and resume to supply them and continue this Run.',
            },
          ]);
        if (!selected && candidates.length)
          return exhaust([
            {
              id: 'ui/recipe',
              file: 'Flow settings',
              text: 'UI triage did not select one configured repository recipe. Select a recipe matching the changed frontend and start a new Run.',
            },
          ]);
        const inspection = await inspectUi(
          selected
            ? {
                start: selected.recipe.start,
                endpoint: selected.recipe.endpoint,
                workspace: join(
                  runDir,
                  'workspace',
                  workspace.members.find(
                    ({ name }) => name === selected.repository,
                  )?.path ?? selected.repository,
                ),
              }
            : ui
              ? {
                  start: ui.start,
                  endpoint: { kind: 'assigned-port', url: ui.url },
                  workspace: leadDir,
                }
              : null,
          revision,
          uiExplanations,
        );
        if (inspection.complaints.length) {
          if (revision === reviewCap) return exhaust(inspection.complaints);
          uiExplanations = inspection.resolutions
            .filter(({ status }) => status === 'disagreed')
            .map(({ id, note }) => {
              const complaint = inspection.complaints.find(
                (complaint) => complaint.id === id,
              );
              if (!complaint) throw new Error(`Missing UI complaint ${id}.`);
              return note
                .replaceAll(id, 'the previous concern')
                .replaceAll(complaint.file, 'the implementation');
            });
          return 'retry';
        }
        uiExplanations = [];
      }

      return 'next';
    },
    async review() {
      ctx.stage('Review');
      const reviewResult = await review(
        'reviewer',
        revision,
        reviewerState,
        await loadRules(ctx, snapshotDir),
      );
      if (reviewResult.complaints.length) {
        if (revision === reviewCap) return exhaust(reviewResult.complaints);
        reviewerState = reviewResult;
        return 'retry';
      }
      reviewerState = { complaints: [], resolutions: [] };
      if (await push()) {
        // A repair after a passing review changes its subject. Validate and
        // review that new head before CI, publication or approval.
        reviewCap++;
        return 'retry';
      }

      return 'next';
    },
    async ci() {
      ctx.stage('CI');
      for (const candidate of repositories?.open ?? [pr]) {
        if (
          repositories &&
          settings.ciSkipRepositories?.includes(candidate.repo)
        ) {
          const note = `${candidate.repo}: no CI pipeline configured (profile setting).`;
          if (!validationSummary.includes(note))
            validationSummary += `\n${note}`;
          continue;
        }
        const ci = await checkCi(candidate);
        if (ci.complaints.length) return exhaust(ci.complaints);
        if (ci.changed) return 'retry';
      }

      return 'next';
    },
    async recap() {
      ctx.stage('Visual recap');
      // Resolve only after the repair passed validation, reviews, and CI.
      await finishMergeThreads();
      const provision =
        settings.recapEnvironmentVersion &&
        execution &&
        recapServices.length > 0;
      const label = `Recap services ${revision}`;
      let recapEnvironment: VerifiedEnvironment | undefined;
      try {
        if (provision && execution) {
          if (settings.environmentVersion) {
            const result = await ensure(
              recapServices,
              label,
              recapCapabilities,
            );
            if (result.status === 'blocked')
              return await environmentFailure(result.blocker, operations.recap);
            recapEnvironment = result.context;
          } else {
            recapEnvironment = {
              version: 1,
              endpoints: await execution.start(recapServices, label),
              capabilities: [],
              limitations: [],
            };
          }
        }
        for (const candidate of repositories?.open ?? [pr]) {
          try {
            const result = await ctx.visualRecap({
              pr: candidate,
              scope: {
                issue,
                validationSummary,
                uiSummary,
                ...(settings.recapDecisionVersion
                  ? {
                      handoffPhase: {
                        stage: 'before-ready',
                        instruction:
                          'Assess whether the validated change is ready for review now. Rocky marks the PR ready, updates the issue to its review state, and posts the handoff only after this recap succeeds. Those pending workflow-owned effects alone are not a gap. Product, check, and evidence gaps still require attention.',
                      },
                    }
                  : {}),
                ...(recapEnvironment ? { environment: recapEnvironment } : {}),
                ...(repositories
                  ? { ...scope, pullRequests: repositories.current }
                  : {}),
              },
              agents: actors.recap(),
            });
            if (
              settings.recapDecisionVersion &&
              result.decision?.status !== 'ready'
            )
              throw new RecapAuditError([
                result.decision?.summary ?? 'The recap returned no decision.',
                ...(result.decision?.actions ?? []),
              ]);
            recaps.set(candidate.repo, result);
            if (candidate.repo === pr.repo) recap = result;
          } catch (error) {
            if (!isRecapAuditError(error)) throw error;
            const complaints = error.problems.map((text, index) =>
              Complaint.parse({
                id: `recap/${revision}/${candidate.repo}/${index + 1}`,
                file: candidate.repo,
                text,
                severity: 'must-fix',
              }),
            );
            const fixed = await actors.call('fixer', {
              label: `Repair visual recap evidence ${revision}/${reviewCap}`,
              input: {
                issue,
                workspace,
                delivery,
                complaints,
                commands,
                validationResponsibility,
                instruction:
                  'Address every recap evidence complaint in the deliverable. Commit and push only the scoped correction. The workflow will revalidate, review, and generate a fresh recap.',
              },
              schema: FixReportFor(complaints),
            });
            changes.push(fixed.summary);
            if (!fixed.resolutions.some(({ status }) => status === 'fixed'))
              return exhaust(complaints);
            await push();
            reviewerState = { complaints, resolutions: fixed.resolutions };
            return 'retry';
          }
        }
        if (!recap) {
          const first = recaps.values().next().value;
          if (!first)
            throw new Error(
              'No review report was generated for this delivery.',
            );
          recap = first;
        }

        return 'next';
      } catch (error) {
        if (
          !(error instanceof EnvironmentBlocked) ||
          (ctx.replaying && !(settings.recoveryVersion && error.recorded))
        )
          throw error;
        return await environmentFailure(error.blocker, operations.recap);
      } finally {
        if (provision && execution) await execution.stop(label);
      }
    },
    async publish() {
      if (repositories) {
        await repositories.markDraft(false, (candidate) =>
          [
            description,
            repositories.links(),
            `[Visual recap](${recaps.get(candidate.repo)!.url})`,
            changes.join('\n\n'),
            `## Validation\n${validationSummary}`,
            ...(uiSummary ? [`## UI sweep\n${uiSummary}`] : []),
          ].join('\n\n'),
        );
        pr = repositories.current[0];
        if (delivery.stateChanges) await ctx.linear.setState(states.review);
        if (delivery.kind !== 'pull-request' || !delivery.merge) {
          await ctx.comment(`Ready for review:\n${repositories.links()}`);
          return 'completed';
        }
        return 'next';
      }
      const validatedHead = pr.headSha;
      pr = requireScm(
        await ctx.scm.markDraft(pr, false, {
          body: `${description}\n\n[Visual recap](${recap.url})\n\n${changes.join('\n\n')}\n\n## Validation\n${validationSummary}\n\n## UI sweep\n${uiSummary}`,
        }),
      );
      if (pr.headSha !== validatedHead)
        throw new Error(
          'The PR head changed during the ready-flip. Start validation again for the new head.',
        );
      if (delivery.stateChanges) await ctx.linear.setState(states.review);
      if (delivery.kind !== 'pull-request' || !delivery.merge) {
        await ctx.comment(
          `Ready for review: ${pr.url}\n\n${changes.join('\n\n')}\n\n${validationSummary}\n\n${uiSummary}`,
        );
        return 'completed';
      }

      return 'next';
    },
    async approval() {
      ctx.stage('Checkpoint');
      answer = await ctx.checkpoint({
        title: 'Approve this change?',
        body: repositories
          ? [
              repositories.links(),
              ...repositories.open.map(
                (p) => `[${p.repo} recap](${recaps.get(p.repo)!.url})`,
              ),
              validationSummary,
              ...(uiSummary ? [uiSummary] : []),
            ].join('\n\n')
          : `${pr.url}\n\n[Visual recap](${recap.url})\n\n${changes.join('\n\n')}\n\n${validationSummary}\n\n${uiSummary}`,
      });
      if (answer.decision === 'reject') {
        if (repositories) await repositories.markDraft(true);
        else requireScm(await ctx.scm.markDraft(pr, true));
        return 'rejected';
      }
      if (answer.decision === 'steer') {
        if (repositories) await repositories.markDraft(true);
        else pr = requireScm(await ctx.scm.markDraft(pr, true));
        issue = {
          ...issue,
          description: `${issue.description}\n\n### Human steering\n${answer.message}`,
        };
        ticket = `${issue.title}\n${issue.description}`;
        serviceChecks.clear();
        const fix = await actors.call('fixer', {
          input: { issue, delivery, steer: answer.message, commands },
        });
        changes.push(fix.summary);
        if (repositories) await push();
        return 'retry';
      }

      return 'approved';
    },
    async merge() {
      ctx.stage('Merge');
      if (repositories) return mergeRepositories();
      const update = requireScm(await ctx.scm.updateBranch(pr));
      const adoptSource =
        update.status === 'updated' || update.pr.headSha !== pr.headSha;
      pr = update.pr;
      if (update.status !== 'clean' || adoptSource) {
        pr = requireScm(await ctx.scm.markDraft(pr, true));
        await shell(ctx, 'git fetch origin');
        const merge = await ctx.exec(
          `cd -- "$ROCKY_LEAD_REPO" && git merge --no-edit -- ${quote(`refs/remotes/origin/${adoptSource ? pr.sourceBranch : pr.baseBranch}`)}`,
        );
        const conflicts = await shell(
          ctx,
          'git diff --name-only --diff-filter=U',
        );
        if (update.status === 'conflict' || conflicts) {
          const fixed = await actors.call('merger', {
            input: { issue, delivery, update, conflicts, commands },
          });
          changes.push(fixed.summary);
        } else if (merge.exitCode !== 0) {
          throw new Error(
            `Could not adopt the platform branch update: ${merge.stderr}`,
          );
        }
        await push('merger');
        return 'retry';
      }
      if (answer?.decision !== 'approve')
        throw new Error('Merge requires the approval node to run first.');
      if (!(await readyAfterApproval())) return retryMerge();
      const result = await ctx.scm.armAutoMerge(pr, answer);
      if ('refused' in result) {
        await ctx.post(`${result.message}\n${result.fix}`);
        if (
          result.reason === 'discussions_not_resolved' ||
          result.reason === 'requested_changes'
        ) {
          mergeReadiness = true;
          pendingThreads = requireScm(
            await ctx.scm.reviewThreads(result.pr ?? pr),
          ).filter((thread) => !thread.resolved && thread.resolvable !== false);
          return retryMerge();
        }
        if (
          [
            'ci_must_pass',
            'need_rebase',
            'conflict',
            'head_changed',
            'train_pipeline_dropped',
          ].includes(result.reason)
        ) {
          pr = result.pr ?? pr;
          pr = requireScm(await ctx.scm.markDraft(pr, true));
          return 'retry';
        }
        requireScm(result);
      } else if (result.status === 'merged') {
        if (delivery.stateChanges) await ctx.linear.setState(states.done);
        return 'merged';
      }

      return 'retry';
    },
    async conversations() {
      if (repositories) return repositoryConversations();
      const pr = requireScm(
        await ctx.scm.openPr({ title: ctx.issue.title, body: ctx.issue.url }),
      );
      if (pr.state !== 'open')
        throw new Error(
          'PR conversations require an open PR on this issue branch.',
        );
      const threads = requireScm(await ctx.scm.reviewThreads(pr)).filter(
        (thread) => !thread.resolved,
      );
      const complaints = threads.map((thread, index) =>
        Complaint.parse({
          id: `threads/${index}/c1`,
          file: thread.path,
          ...(thread.line === undefined ? {} : { line: thread.line }),
          text: thread.body,
        }),
      );
      if (!complaints.length) return 'completed';
      const report = await actors.call('fixer', {
        input: { issue: ctx.issue, complaints, commands },
        schema: FixReportFor(complaints),
      });
      if (report.resolutions.some(({ status }) => status === 'fixed'))
        await shell(ctx, 'git push origin HEAD');
      const sha = await shell(ctx, 'git rev-parse HEAD');
      for (const [index, thread] of threads.entries()) {
        const resolution = report.resolutions.find(
          ({ id }) => id === complaints[index].id,
        );
        if (!resolution)
          throw new Error(`Missing resolution for ${complaints[index].id}.`);
        requireScm(
          await ctx.scm.replyToThread(
            thread,
            resolution.status === 'fixed'
              ? `Fixed in ${sha}. ${resolution.note}`
              : resolution.note,
          ),
        );
      }
      ctx.stage('Visual recap');
      await ctx.visualRecap({
        pr: { ...pr, headSha: sha },
        scope: { issue: ctx.issue, resolutions: report.resolutions },
        agents: actors.recap(),
      });
      return 'completed';
    },
  };
  return async (
    operation: string,
    connectedAgents: DeliveryAgents,
  ): Promise<string> => {
    actors = {
      ...connectedAgents,
      call: (async (role: string, options: AgentCallOpts = {}) => {
        const needsHistory =
          /reviewer|fixer|ui-inspector|ui-complaint-writer/.test(role);
        const input =
          options.input &&
          typeof options.input === 'object' &&
          !Array.isArray(options.input)
            ? { ...(options.input as Record<string, unknown>) }
            : {};
        const sourceAgent = [
          'implementer',
          'fixer',
          'ci-fixer',
          'merger',
        ].includes(role);
        const validationIds = catalogEntries(settings.execution ?? [])
          .filter(
            ({ command }) =>
              command.policy !== 'manual' && command.purpose !== 'install',
          )
          .map(({ id }) => id);
        const requests =
          settings.validationRequestVersion &&
          sourceAgent &&
          validationIds.length &&
          (!options.schema || options.schema instanceof z.ZodObject)
            ? z.array(z.enum(validationIds)).default([])
            : undefined;
        const schema = requests
          ? (options.schema instanceof z.ZodObject
              ? options.schema
              : z.object({})
            ).safeExtend({ requiredValidationCommands: requests })
          : options.schema;
        if (requests) {
          input.validationResponsibility = validationResponsibility;
          input.validationRequestInstruction =
            'List every configured check you defer to host validation in requiredValidationCommands, using only supplied non-manual catalog IDs. Use an empty array only when none are pending. The Workflow keeps these commands mandatory in every later validation round, even if the optional selector omits them. Naming a pending check only in summary is not a validation request. Report pending evidence honestly; unconfigured acceptance checks remain your responsibility.';
        }
        if (role === 'fixer' && Array.isArray(input.complaints))
          history.forFixer(
            input.complaints as Complaint[],
            options.label ?? role,
          );
        const result = await connectedAgents.call(role, {
          ...options,
          ...(requests ? { schema, input } : {}),
          ...(repositories
            ? {
                input: {
                  ...input,
                  workspace,
                  pullRequests: repositories.current,
                  repositoryPaths:
                    'Diff and complaint paths include the repository name. Review the delivery across all changed repositories. Keep commits local; the Workflow pushes and opens each PR. Do not change repositories whose PR is already merged.',
                },
              }
            : {}),
          ...(needsHistory
            ? {
                input: {
                  ...input,
                  ...(repositories
                    ? {
                        workspace,
                        pullRequests: repositories.current,
                        repositoryPaths:
                          'Paths include the repository name. Assess all changed repositories together; do not change repositories whose PR is already merged.',
                      }
                    : {}),
                  reviewHistory: history.snapshot(),
                  reviewPolicy,
                },
              }
            : {}),
        });
        if (requests) {
          const ids = requests.parse(
            'requiredValidationCommands' in result
              ? result.requiredValidationCommands
              : [],
          );
          for (const id of ids) requestedValidationChecks.add(id);
        }
        if (
          role === 'fixer' &&
          'resolutions' in result &&
          Array.isArray(result.resolutions)
        )
          history.resolved(result.resolutions as Resolution[]);
        return result;
      }) as DeliveryAgents['call'],
    };
    const run = operations[operation];
    if (!run) throw new Error(`Unknown delivery operation: ${operation}`);
    if (!['clarify', 'conversations'].includes(operation) && !scope)
      throw new Error(`${operation} requires Clarify scope to run first.`);
    if (
      ![
        'clarify',
        'conversations',
        'deliverable',
        'plan',
        'implement',
      ].includes(operation) &&
      !pr
    )
      throw new Error(
        `${operation} requires Implement & open draft to run first.`,
      );
    if (operation === 'implement' && !plan)
      throw new Error('Implementation requires a plan.');
    if (['publish', 'approval'].includes(operation) && !recap)
      throw new Error(`${operation} requires a visual recap.`);
    return run();
  };
}
