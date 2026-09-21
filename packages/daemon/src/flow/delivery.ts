import { DeliveryRepositories } from './repositories.js';
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
  type WorkflowInput,
  type CheckpointAnswer,
  z,
} from '@rocky/sdk';
import { readdir, readFile } from 'node:fs/promises';
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

import { dirname, join } from 'node:path';
import type { FlowSettings, UiEndpoint } from '@rocky/local-contracts';
import { resolveUiEndpoint } from './ui-endpoint.js';
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

async function giveUp(
  ctx: WorkflowContext,
  pr: ScmPr,
  complaints: readonly Complaint[],
) {
  requireScm(await ctx.scm.markDraft(pr, true));
  await ctx.post(
    `Unresolved Complaints:\n${JSON.stringify(complaints, null, 2)}`,
  );
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
  let { commands, ui, readiness } = settings;
  const { states, reviewCap, ciCap, ciLogLines } = settings;
  let continuation = 0;
  let repairedUi = false;
  let repairedInstall = false;
  const execution = settings.execution
    ? new WorkspaceExecution(
        ctx,
        workspace,
        settings.execution,
        dirname(snapshotDir),
      )
    : undefined;
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
            catalog: optional.map(({ id, repository, command }) => ({
              id,
              repository: repository.name,
              command,
            })),
          },
          optional.map((entry) => entry.id),
        )
      : { selected: [], reason: 'Only required commands are configured.' };
    const ids = [
      ...available
        .filter(({ command }) => command.policy === 'required')
        .map((entry) => entry.id),
      ...selection.selected,
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
      reason: selection.reason,
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
  const serviceChecks = new Map<string, Check[]>();
  let uiSummary = repositories ? '' : 'No frontend change.';
  let validationSummary =
    'No local validation commands configured; see CI and review evidence.';
  let server: { pid: number } | undefined;
  let revision = 0;
  let recap!: { url: string };
  let answer!: CheckpointAnswer;
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
  const validationResponsibility = {
    commands,
    repositoryCatalog: settings.execution,
    instruction:
      'The Workflow only runs the configured test, lint and build commands. Implementation and repair agents own additional acceptance tests and benchmarks, including local dependencies and disposable test services needed to run them. Produce and retain the required evidence in this workspace; there is no separate later agent that will supply it. Check documented setup and available container runtimes before declaring infrastructure unavailable. Report actual external access requirements precisely when local setup cannot resolve them.',
  };
  async function push() {
    if (repositories) {
      await repositories.sync(
        `${issue.identifier}: ${issue.title}`,
        description,
      );
      pr = repositories.current[0];
      return;
    }
    await shell(ctx, 'git push origin HEAD');
    pr = { ...pr, headSha: await shell(ctx, 'git rev-parse HEAD') };
  }

  async function exhaust(complaints: readonly Complaint[]) {
    // Replay the original exhaustion effects before consuming a new allowance.
    // This keeps old journals positional and preserves their published receipts.
    const outcome = repositories
      ? await (async () => {
          await repositories.markDraft(true);
          await ctx.post(
            `Unresolved Complaints:\n${JSON.stringify(complaints, null, 2)}`,
          );
          return 'exhausted' as const;
        })()
      : await giveUp(ctx, pr, complaints);
    if (continuations === 0) return outcome;
    continuations--;
    continuation++;
    const repair = repairs.find(
      (item) => item.continuation === continuation,
    )?.settings;
    if (repair) {
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

  async function checkCi(candidate: ScmPr = pr) {
    let ci = requireScm(
      await ctx.scm.waitForCi(candidate, { logTailLines: ciLogLines }),
    );
    if (ci.headSha !== candidate.headSha)
      throw new Error(
        'CI returned another head. Refresh the branch and run validation again.',
      );
    while (ci.status === 'failed' && ciAttempts < ciCap) {
      ciAttempts++;
      const fix = await actors.call('ci-fixer', {
        label: `ci-fixer ${ciAttempts}/${ciCap}`,
        input: {
          issue,
          delivery,
          failedJobs: ci.failedJobs,
          commands,
          ...(repositories ? { repository: candidate.repo } : {}),
        },
        schema: CiFix,
      });
      changes.push(fix.summary);
      if (fix.action === 'unresolved') break;
      if (fix.action === 'fixed') {
        await push();
        return { changed: true, complaints: [] };
      }
      requireScm(await ctx.scm.retryFailedJobs(candidate));
      ci = requireScm(
        await ctx.scm.waitForCi(candidate, { logTailLines: ciLogLines }),
      );
      if (ci.headSha !== candidate.headSha)
        throw new Error(
          'CI returned another head. Refresh the branch and run validation again.',
        );
    }
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
          input: { issue, delivery, diff: await diff(), rules },
          schema: Checks,
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
          `cd -- ${quote(configuredUi.workspace)} && export PORT=${ctx.ports[0]}; ${configuredUi.start} > "$ROCKY_RUN_DIR/dev-server.log" 2>&1`,
          { background: true, label: 'dev server' },
        );
      // Probe again on every Boot; only the recorded result chooses the replay path.
      let ready = false;
      let url: string | undefined;
      for (let attempt = 0; attempt < readiness.attempts; attempt++) {
        try {
          const log = await readFile(
            `${process.env.ROCKY_RUN_DIR}/dev-server.log`,
            'utf8',
          ).catch(() => '');
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
          : await readFile(
              `${process.env.ROCKY_RUN_DIR}/dev-server.log`,
              'utf8',
            ).catch((error: NodeJS.ErrnoException) => {
              if (error.code === 'ENOENT')
                return 'The dev server did not become ready and produced no log.';
              throw error;
            }),
      }));
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
        const screenshotDir = process.env.ROCKY_SCREENSHOT_DIR;
        if (!screenshotDir)
          throw new Error(
            'The UI stage requires ROCKY_SCREENSHOT_DIR from the Run runtime.',
          );
        const result = await actors.call('ui-inspector', {
          label: `ui-inspector ${revision}/${reviewCap}`,
          input: { baseUrl: url!, checks, rules, previousExplanations },
          schema: CheckResultsFor(checks, screenshotDir),
        });
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
          .filter((thread) => !thread.resolved)
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
      await push();
      return 'retry';
    }
    for (const candidate of repositories.open) {
      const result = await ctx.scm.armAutoMerge(candidate, answer);
      if ('refused' in result) {
        await ctx.post(`${result.message}\n${result.fix}`);
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
          input: { issue: ctx.issue, workspace, conversation },
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
${conversation.map((turn) => `${turn.questions.join('\n')}\n\nAnswer: ${turn.answer}`).join('\n\n') || 'The ticket was clear without additional questions.'}`;
      await ctx.post(decisions);
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
          ctx.stage('Visual recap');
          await ctx.visualRecap({
            deliverable: draft.body,
            title: issue.title,
            scope,
            agents: actors.recap(),
          });
          ctx.stage('Deliver');
          // Publishing belongs to the Workflow, not an Agent's tools or summary.
          await ctx.comment(draft.body);
          if (delivery.stateChanges) await ctx.linear.setState(states.review);
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
      await setupWorkspace();
      ctx.stage('Implement');
      const implementation = await actors.call('implementer', {
        input: {
          issue,
          workspace,
          delivery,
          plan,
          commands,
          validationResponsibility,
        },
      });
      if (!repositories) await shell(ctx, 'git push origin HEAD');
      description = `${issue.url}\n\n${plan.summary}`;
      if (repositories) await push();
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
      if (revision > reviewCap)
        return exhaust([
          {
            id: 'checkpoint/cap',
            file: '.',
            text: 'The validation cycle cap was exhausted.',
          },
        ]);
      ctx.stage('Validate');
      const validationProblems: Complaint[] = [];
      const validations: string[] = [];
      if (execution) {
        const failed = new Set<string>();
        for (const entry of await selectedCommands('validate')) {
          if (entry.command.dependsOn.some((id) => failed.has(id))) {
            failed.add(entry.id);
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
            validationProblems.push({
              id: `validation/${revision}/${entry.id}`,
              file: entry.repository.name,
              text: `${entry.command.name} failed (exit ${result.exitCode}): ${entry.command.command}\n${`${result.stdout}\n${result.stderr}`.slice(-12000)}`,
            });
          }
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
            instruction:
              'Identify frontend changes and select all relevant service IDs for UI inspection. Dependencies start automatically. Choose none for non-UI work. Explain your selection. Do not start processes yourself.',
          },
          schema: z.object({
            isFrontend: z.boolean(),
            selected: available.length
              ? z.array(z.enum(available.map((entry) => entry.id)))
              : z.array(z.string()).max(0),
            reason: z.string(),
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
        if (triage.isFrontend && !selected.length)
          return exhaust([
            {
              id: 'ui/config',
              file: 'Flow settings',
              text: 'UI changes need a dev service. Use Repair configuration and resume, and configure a service in the profile for future Runs.',
            },
          ]);
        if (!selected.length) return 'next';
        const label = `UI services ${revision}`;
        let retry: Complaint[] | undefined;
        try {
          const endpoints = await execution.start(selected, label);
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
                  process.env.ROCKY_RUN_DIR ?? '',
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
                  workspace: process.env.ROCKY_LEAD_REPO ?? '',
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
      await push();

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
      for (const candidate of repositories?.open ?? [pr]) {
        const result = await ctx.visualRecap({
          pr: candidate,
          scope: {
            issue,
            validationSummary,
            uiSummary,
            ...(repositories
              ? { ...scope, pullRequests: repositories.current }
              : {}),
          },
          agents: actors.recap(),
        });
        recaps.set(candidate.repo, result);
        if (candidate.repo === pr.repo) recap = result;
      }
      if (!recap) {
        const first = recaps.values().next().value;
        if (!first)
          throw new Error('No review report was generated for this delivery.');
        recap = first;
      }

      return 'next';
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
        await push();
        return 'retry';
      }
      if (answer?.decision !== 'approve')
        throw new Error('Merge requires the approval node to run first.');
      const result = await ctx.scm.armAutoMerge(pr, answer);
      if ('refused' in result) {
        await ctx.post(`${result.message}\n${result.fix}`);
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
            ? (options.input as Record<string, unknown>)
            : {};
        if (role === 'fixer' && Array.isArray(input.complaints))
          history.forFixer(
            input.complaints as Complaint[],
            options.label ?? role,
          );
        const result = await connectedAgents.call(role, {
          ...options,
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
