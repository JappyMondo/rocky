import {
  linear,
  manual,
  type WorkflowContext,
  type Pr,
  type ScmRefusal,
  type AgentCallOpts,
} from '@rocky/sdk';
import { readdir, readFile } from 'node:fs/promises';
import {
  Plan,
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
const commands = {"install":"pnpm install","test":"","lint":"","build":""};
const ui: { start: string; url: string } | null = null;
const states = {"started":"In Progress","review":"In Review","done":"Done"};
const reviewCap = 5;
const ciCap = 3;
const agent = { harness: 'claude-code', model: 'sonnet' };
const fastAgent = { harness: 'claude-code', model: 'haiku' };
const readiness = { attempts: 30, intervalMs: 1000 };
const ciLogLines = 200;
// END ROCKY CONFIG

async function shell(ctx: WorkflowContext, command: string) {
  const result = await ctx.exec(command);
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
  pr: Pr,
  complaints: readonly Complaint[],
) {
  requireScm(await ctx.scm.markDraft(pr, true));
  await ctx.post(
    `Unresolved Complaints:\n${JSON.stringify(complaints, null, 2)}`,
  );
  return 'exhausted' as const;
}

type ReviewState = {
  complaints: Complaint[];
  resolutions: Resolution[];
};

export async function main(
  ctx: WorkflowContext,
): Promise<'merged' | 'rejected' | 'exhausted'> {
  const read: AgentCallOpts = { ...agent, tools: ['read'] };
  const edit: AgentCallOpts = { ...agent, tools: ['read', 'edit', 'bash'] };
  const ticket = `${ctx.issue.title}\n${ctx.issue.description}`;
  const diff = () => shell(ctx, 'git diff origin/HEAD...HEAD');
  ctx.stage('Plan');
  await ctx.linear.setState(states.started);
  const plan = await ctx.agent('planner', {
    ...read,
    input: { issue: ctx.issue, diff: await diff() },
    schema: Plan,
  });
  await ctx.post(
    `${plan.summary}\n\n${plan.steps.map((step, index) => `${index + 1}. ${step}`).join('\n')}`,
  );
  ctx.stage('Implement');
  const implementation = await ctx.agent('implementer', {
    ...edit,
    input: { issue: ctx.issue, plan, commands },
  });
  await shell(ctx, 'git push origin HEAD');
  const description = `${ctx.issue.url}\n\n${plan.summary}`;
  let pr = requireScm(
    await ctx.scm.openPr({
      title: `${ctx.issue.identifier}: ${ctx.issue.title}`,
      body: description,
      draft: true,
    }),
  );
  const changes = [implementation.summary];
  let ciAttempts = 0;
  let checks: Check[] | undefined;
  let uiSummary = 'No frontend change.';
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
        issue: ctx.issue,
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
      input: { issue: ctx.issue, complaints, commands },
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
        input: { issue: ctx.issue, failedJobs: ci.failedJobs, commands },
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
          input: { issue: ctx.issue, diff: await diff(), rules },
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
      input: { issue: ctx.issue, complaints, commands },
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
    const validatedHead = pr.headSha;
    pr = requireScm(
      await ctx.scm.markDraft(pr, false, {
        body: `${description}\n\n${changes.join('\n\n')}\n\n## UI sweep\n${uiSummary}`,
      }),
    );
    if (pr.headSha !== validatedHead)
      throw new Error(
        'The PR head changed during the ready-flip. Start validation again for the new head.',
      );
    await ctx.linear.setState(states.review);
    ctx.stage('Checkpoint');
    const answer = await ctx.checkpoint({
      title: 'Approve this change?',
      body: `${pr.url}\n\n${changes.join('\n\n')}\n\n${uiSummary}`,
    });
    if (answer.decision === 'reject') {
      requireScm(await ctx.scm.markDraft(pr, true));
      return 'rejected';
    }
    if (answer.decision === 'steer') {
      pr = requireScm(await ctx.scm.markDraft(pr, true));
      const fix = await ctx.agent('fixer', {
        ...edit,
        input: { issue: ctx.issue, steer: answer.message, commands },
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
        `git merge --no-edit -- ${quote(`refs/remotes/origin/${adoptSource ? pr.sourceBranch : pr.baseBranch}`)}`,
      );
      const conflicts = await shell(
        ctx,
        'git diff --name-only --diff-filter=U',
      );
      if (update.status === 'conflict' || conflicts) {
        const fixed = await ctx.agent('merger', {
          ...edit,
          input: { issue: ctx.issue, update, conflicts, commands },
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
    const result = await ctx.scm.armAutoMerge(pr);
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
      await ctx.linear.setState(states.done);
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
  return 'completed';
}

export default [
  linear.onDelegate(main),
  manual('address-pr-conversations', addressPrConversations),
];
