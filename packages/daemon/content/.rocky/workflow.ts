import {
  linear,
  manual,
  type WorkflowContext,
  type ScmPr,
  type ScmRefusal,
  type AgentCallOpts,
  type WorkflowInput,
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

// BEGIN ROCKY CONFIG
const commands = { install: '', test: '', lint: '', build: '' };
const ui: { start: string; url: string } | null = null;
const states = { started: 'In Progress', review: 'In Review', done: 'Done' };
const reviewCap = 5;
const ciCap = 3;
// OpenCode owns provider and model selection. Its configured OpenAI model is
// therefore used without baking a Claude model name into local profiles.
const agent = { harness: 'opencode' };
const fastAgent = { harness: 'opencode' };
const readiness = { attempts: 30, intervalMs: 1000 };
const ciLogLines = 200;
// END ROCKY CONFIG

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

async function loadRules(ctx: WorkflowContext) {
  // Every file is prompt text. Delete this call to opt out; no README belongs here.
  return ctx.step('load rules', async () => {
    const directory = new URL('./rules/', import.meta.url);
    const files = await readdir(directory).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      },
    );
    const rules = [];
    for (const file of files.sort())
      rules.push(
        await readFile(new URL(encodeURIComponent(file), directory), 'utf8'),
      );
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

export async function main(
  ctx: WorkflowContext,
  workspace: WorkflowInput = { members: [] },
): Promise<'merged' | 'completed' | 'rejected' | 'exhausted'> {
  const read: AgentCallOpts = { ...agent, tools: ['read'] };
  const edit: AgentCallOpts = { ...agent, tools: ['read', 'edit', 'bash'] };
  ctx.stage('Clarify');
  const conversation: { questions: string[]; answer: string }[] = [];
  let scope;
  for (;;) {
    const refinement = await ctx.agent('refiner', {
      ...fastAgent,
      tools: ['read'],
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
  const delivery = scope.delivery;
  let issue = {
    ...ctx.issue,
    description: `${ctx.issue.description}\n\n${decisions}`,
  };
  if (delivery.stateChanges) await ctx.linear.setState(states.started);
  if (delivery.kind === 'linear-comment') {
    // Check installed validation support before spending any drafting/review turns.
    await validateDiagrams(ctx, '');
    const inspect: AgentCallOpts = { ...read, tools: ['read', 'bash'] };
    let previous: { body: string; problems: string[] } | undefined;
    for (let revision = 1; revision <= reviewCap; revision++) {
      ctx.stage('Prepare deliverable');
      const draft = await ctx.agent('deliverable-writer', {
        ...inspect,
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
          ctx.agent('deliverable-reviewer', {
            ...inspect,
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
          agent,
        });
        ctx.stage('Deliver');
        // Publishing belongs to the Workflow, not an Agent's tools or summary.
        await ctx.comment(draft.body);
        if (delivery.stateChanges) await ctx.linear.setState(states.review);
        return 'completed';
      }
      previous = { body: draft.body, problems };
    }
    await ctx.post(
      `Deliverable review exhausted; nothing published.\n${previous?.problems.join('\n')}`,
    );
    return 'exhausted';
  }
  let ticket = `${issue.title}\n${issue.description}`;
  const diff = () => shell(ctx, 'git diff origin/HEAD...HEAD');
  ctx.stage('Plan');
  const plan = await ctx.agent('planner', {
    ...read,
    input: { issue, workspace, delivery, diff: await diff() },
    schema: Plan,
  });
  await ctx.post(
    `${plan.summary}\n\n${plan.steps.map((step, index) => `${index + 1}. ${step}`).join('\n')}`,
  );
  ctx.stage('Implement');
  const implementation = await ctx.agent('implementer', {
    ...edit,
    input: { issue, workspace, delivery, plan, commands },
  });
  await shell(ctx, 'git push origin HEAD');
  const description = `${issue.url}\n\n${plan.summary}`;
  let pr = requireScm(
    await ctx.scm.openPr({
      title: `${issue.identifier}: ${issue.title}`,
      body: description,
      draft: true,
    }),
  );
  const changes = [implementation.summary];
  let ciAttempts = 0;
  let checks: Check[] | undefined;
  let uiSummary = 'No frontend change.';
  let validationSummary =
    'No local validation commands configured; see CI and review evidence.';
  let server: { pid: number } | undefined;

  async function push() {
    await shell(ctx, 'git push origin HEAD');
    pr = { ...pr, headSha: await shell(ctx, 'git rev-parse HEAD') };
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
    const result = await ctx.agent(name, {
      ...read,
      label: `${name} ${revision}/${reviewCap}`,
      input: {
        issue,
        delivery,
        diff: await diff(),
        namespace,
        disagreements,
        ...(rules === undefined ? {} : { rules }),
      },
      schema: ReviewFor(
        namespace,
        name === 'compliance-reviewer' ? ticket : undefined,
      ),
    });
    const complaints = result.complaints;
    if (!complaints.length) return { complaints, resolutions: [] };
    if (revision === reviewCap) return { complaints, resolutions: [] };
    const fixed = await ctx.agent('fixer', {
      ...edit,
      label: `${name} fixer ${revision}/${reviewCap}`,
      input: { issue, delivery, complaints, commands },
      schema: FixReportFor(complaints),
    });
    changes.push(fixed.summary);
    if (fixed.resolutions.some(({ status }) => status === 'fixed'))
      await push();
    return { complaints, resolutions: fixed.resolutions };
  }

  async function checkCi() {
    let ci = requireScm(
      await ctx.scm.waitForCi(pr, { logTailLines: ciLogLines }),
    );
    if (ci.headSha !== pr.headSha)
      throw new Error(
        'CI returned another head. Refresh the branch and run validation again.',
      );
    while (ci.status === 'failed' && ciAttempts < ciCap) {
      ciAttempts++;
      const fix = await ctx.agent('ci-fixer', {
        ...edit,
        label: `ci-fixer ${ciAttempts}/${ciCap}`,
        input: { issue, delivery, failedJobs: ci.failedJobs, commands },
        schema: CiFix,
      });
      changes.push(fix.summary);
      if (fix.action === 'unresolved') break;
      if (fix.action === 'fixed') {
        await push();
        return { changed: true, complaints: [] };
      }
      requireScm(await ctx.scm.retryFailedJobs(pr));
      ci = requireScm(
        await ctx.scm.waitForCi(pr, { logTailLines: ciLogLines }),
      );
      if (ci.headSha !== pr.headSha)
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
                file: '.',
                text: `CI did not pass: ${JSON.stringify(ci)}`,
              },
            ],
    };
  }

  async function inspectUi(revision: number, previousExplanations: string[]) {
    const rules = await loadRules(ctx);
    if (!checks) {
      checks = (
        await ctx.agent('ui-planner', {
          ...read,
          input: { issue, delivery, diff: await diff(), rules },
          schema: Checks,
        })
      ).checks;
    }
    const namespace = `ui/${revision}/1`;
    let complaints: Complaint[];
    if (!ui) {
      complaints = [
        {
          id: `${namespace}/config`,
          file: '.rocky/workflow.ts',
          text: 'The change involves a frontend but ui is not configured. Set its start command and URL in the Config block, then start a new Run.',
        },
      ];
    } else {
      const url = new URL(ui.url);
      if (!ctx.ports[0])
        throw new Error('The UI stage needs a reserved ctx.ports[0].');
      url.port = String(ctx.ports[0]);
      if (!server)
        server = await ctx.exec(
          `export PORT=${ctx.ports[0]}; ${ui.start} > "$ROCKY_RUN_DIR/dev-server.log" 2>&1`,
          { background: true, label: 'dev server' },
        );
      // Probe again on every Boot; only the recorded result chooses the replay path.
      let ready = false;
      for (let attempt = 0; attempt < readiness.attempts; attempt++) {
        try {
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
            url: url.href,
            text: `Dev server failed to become ready.\n${boot.log}`,
            screenshots: [],
          },
        ];
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
        const result = await ctx.agent('ui-inspector', {
          ...agent,
          tools: ['read'],
          mcp: ['playwright'],
          label: `ui-inspector ${revision}/${reviewCap}`,
          input: { baseUrl: url.href, checks, rules, previousExplanations },
          schema: CheckResultsFor(checks, screenshotDir),
        });
        observations = result.results.flatMap((result) => result.observations);
        uiSummary = `${result.summary}\n${result.results.map((check) => `- ${check.id}: ${check.verdict}. ${check.note}`).join('\n')}`;
      }
      complaints = await ctx.parallel(
        observations,
        async (observation, index) =>
          ctx.agent('ui-complaint-writer', {
            ...read,
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
    if (!complaints.length) return { complaints, resolutions: [] };
    if (revision === reviewCap) return { complaints, resolutions: [] };
    const fixed = await ctx.agent('fixer', {
      ...edit,
      label: `UI fixer ${revision}/${reviewCap}`,
      input: { issue, delivery, complaints, commands },
      schema: FixReportFor(complaints),
    });
    changes.push(fixed.summary);
    if (fixed.resolutions.some(({ status }) => status === 'fixed'))
      await push();
    return { complaints, resolutions: fixed.resolutions };
  }

  // A human Steer starts another validation cycle, never a shortcut to arming.
  let complianceState: ReviewState = { complaints: [], resolutions: [] };
  let reviewerState: ReviewState = { complaints: [], resolutions: [] };
  let uiExplanations: string[] = [];
  for (let revision = 1; revision <= reviewCap; revision++) {
    ctx.stage('Validate');
    const validationProblems: Complaint[] = [];
    const validations: string[] = [];
    for (const [name, command] of Object.entries(commands)) {
      if (name === 'install' || !command.trim()) continue;
      const result = await ctx.exec(`cd -- "$ROCKY_LEAD_REPO" && ${command}`, {
        label: `Validate ${name} ${revision}/${reviewCap}`,
      });
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
      if (revision === reviewCap) return giveUp(ctx, pr, validationProblems);
      const fixed = await ctx.agent('fixer', {
        ...edit,
        label: `Validation fixer ${revision}/${reviewCap}`,
        input: { issue, delivery, complaints: validationProblems, commands },
        schema: FixReportFor(validationProblems),
      });
      changes.push(fixed.summary);
      await push();
      continue;
    }
    ctx.stage('Compliance');
    const compliance = await review(
      'compliance-reviewer',
      revision,
      complianceState,
    );
    if (compliance.complaints.length) {
      if (revision === reviewCap) return giveUp(ctx, pr, compliance.complaints);
      complianceState = compliance;
      continue;
    }
    complianceState = { complaints: [], resolutions: [] };
    ctx.stage('UI');
    const triage = await ctx.agent('ui-triage', {
      ...fastAgent,
      tools: ['read'],
      input: { changedFiles: await ctx.changedFiles(), diff: await diff() },
      schema: UiTriage,
    });
    if (triage.isFrontend) {
      const ui = await inspectUi(revision, uiExplanations);
      if (ui.complaints.length) {
        if (revision === reviewCap) return giveUp(ctx, pr, ui.complaints);
        uiExplanations = ui.resolutions
          .filter(({ status }) => status === 'disagreed')
          .map(({ id, note }) => {
            const complaint = ui.complaints.find(
              (complaint) => complaint.id === id,
            );
            if (!complaint) throw new Error(`Missing UI complaint ${id}.`);
            return note
              .replaceAll(id, 'the previous concern')
              .replaceAll(complaint.file, 'the implementation');
          });
        continue;
      }
      uiExplanations = [];
    }
    ctx.stage('Review');
    const reviewResult = await review(
      'reviewer',
      revision,
      reviewerState,
      await loadRules(ctx),
    );
    if (reviewResult.complaints.length) {
      if (revision === reviewCap)
        return giveUp(ctx, pr, reviewResult.complaints);
      reviewerState = reviewResult;
      continue;
    }
    reviewerState = { complaints: [], resolutions: [] };
    await push();
    ctx.stage('CI');
    const ci = await checkCi();
    if (ci.complaints.length) return giveUp(ctx, pr, ci.complaints);
    if (ci.changed) continue;
    ctx.stage('Visual recap');
    const recap = await ctx.visualRecap({
      pr,
      scope: { issue, validationSummary, uiSummary },
      agent: { ...agent, ...(ui ? { mcp: ['playwright'] } : {}) },
    });
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
    if (!delivery.merge) {
      await ctx.comment(
        `Ready for review: ${pr.url}\n\n${changes.join('\n\n')}\n\n${validationSummary}\n\n${uiSummary}`,
      );
      return 'completed';
    }
    ctx.stage('Checkpoint');
    const answer = await ctx.checkpoint({
      title: 'Approve this change?',
      body: `${pr.url}\n\n[Visual recap](${recap.url})\n\n${changes.join('\n\n')}\n\n${validationSummary}\n\n${uiSummary}`,
    });
    if (answer.decision === 'reject') {
      requireScm(await ctx.scm.markDraft(pr, true));
      return 'rejected';
    }
    if (answer.decision === 'steer') {
      pr = requireScm(await ctx.scm.markDraft(pr, true));
      issue = {
        ...issue,
        description: `${issue.description}\n\n### Human steering\n${answer.message}`,
      };
      ticket = `${issue.title}\n${issue.description}`;
      checks = undefined;
      const fix = await ctx.agent('fixer', {
        ...edit,
        input: { issue, delivery, steer: answer.message, commands },
      });
      changes.push(fix.summary);
      continue;
    }
    ctx.stage('Merge');
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
        const fixed = await ctx.agent('merger', {
          ...edit,
          input: { issue, delivery, update, conflicts, commands },
        });
        changes.push(fixed.summary);
      } else if (merge.exitCode !== 0) {
        throw new Error(
          `Could not adopt the platform branch update: ${merge.stderr}`,
        );
      }
      await push();
      continue;
    }
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
        continue;
      }
      requireScm(result);
    } else if (result.status === 'merged') {
      if (delivery.stateChanges) await ctx.linear.setState(states.done);
      return 'merged';
    }
  }
  return giveUp(ctx, pr, [
    {
      id: 'checkpoint/cap',
      file: '.',
      text: 'The validation cycle cap was exhausted.',
    },
  ]);
}

export async function addressPrConversations(
  ctx: WorkflowContext,
): Promise<'completed'> {
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
  const report = await ctx.agent('fixer', {
    ...agent,
    tools: ['read', 'edit', 'bash'],
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
    agent: { ...agent, ...(ui ? { mcp: ['playwright'] } : {}) },
  });
  return 'completed';
}

export default [
  linear.onDelegate(main),
  manual('address-pr-conversations', addressPrConversations),
];
