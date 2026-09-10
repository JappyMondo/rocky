import { createJiti } from 'jiti';
import {
  cp,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type {
  AgentCallOpts,
  ScmOps,
  Triggers,
  WorkflowContext,
} from '@rocky/sdk';
import { z } from '@rocky/sdk';
import { createWorkflowContext } from '../run/context.js';
import { runBoot } from '../run/replay.js';

const { default: triggers, addressPrConversations } = await createJiti(
  import.meta.url,
  {
    alias: {
      '@rocky/sdk': new URL('../../../sdk/src/index.ts', import.meta.url)
        .pathname,
    },
  },
).import<{
  default: Triggers;
  addressPrConversations: (ctx: unknown) => Promise<string>;
}>(new URL('../../content/.rocky/workflow.ts', import.meta.url).pathname);

type RawCheckpointAnswer =
  | { decision: 'approve' }
  | { decision: 'reject'; reason?: string }
  | { decision: 'steer'; message: string };

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rocky-content-trace-'));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

it('ships the complete editable default tree without default Rules', async () => {
  const shipped = new URL('../../content/.rocky/', import.meta.url);
  const agents = await readdir(new URL('./agents/', shipped));
  expect(agents.sort()).toEqual([
    'ci-fixer.md',
    'compliance-reviewer.md',
    'fixer.md',
    'implementer.md',
    'merger.md',
    'planner.md',
    'refiner.md',
    'reviewer.md',
    'ui-complaint-writer.md',
    'ui-inspector.md',
    'ui-planner.md',
    'ui-triage.md',
  ]);
  for (const agent of agents) {
    expect(
      await readFile(new URL(`./agents/${agent}`, shipped), 'utf8'),
    ).not.toMatch(/^---(?:\r?\n)/);
  }
  await expect(readdir(new URL('./rules/', shipped))).rejects.toThrow();
  const workflow = await readFile(new URL('./workflow.ts', shipped), 'utf8');
  expect(workflow.match(/^\/\/ BEGIN ROCKY CONFIG$/gm)).toHaveLength(1);
  expect(workflow.match(/^\/\/ END ROCKY CONFIG$/gm)).toHaveLength(1);
  expect(await readFile(new URL('./mcp.json', shipped), 'utf8')).toBe(
    '{\n  "mcpServers": {}\n}\n',
  );
});

function fixture(
  options: {
    agent?: (
      name: string,
      input: Record<string, unknown>,
      count: number,
    ) => Record<string, unknown> | undefined;
    scm?: (operation: string, count: number) => unknown;
    triggers?: Triggers;
  } = {},
) {
  const trace: string[] = [];
  const calls: {
    name: string;
    input: Record<string, unknown>;
    options?: AgentCallOpts;
  }[] = [];
  const scmCalls: { operation: string; args: unknown[] }[] = [];
  const answers: RawCheckpointAnswer[] = [];
  let merged = false;
  const pr = {
    repo: 'fixture',
    id: 'pr-1',
    number: 1,
    url: 'https://example.test/pr/1',
    sourceBranch: 'test-1',
    baseBranch: 'main',
    headSha: 'abc',
    state: 'open',
    draft: true,
  };
  const boot = () =>
    runBoot({
      journalPath: join(dir, 'journal.jsonl'),
      workflow: async (runner) => {
        const ctx = createWorkflowContext(
          runner,
          {
            issue: {
              identifier: 'TEST-1',
              title: 'Handle empty input',
              description: 'Return an empty list.',
              url: 'https://example.test/issue/1',
              labels: [],
            },
            branch: 'test-1',
            ports: [12345],
          },
          {
            exec: async (command, background) => {
              trace.push(command.startsWith('git push') ? 'push' : command);
              return background
                ? { pid: 123 }
                : {
                    exitCode: 0,
                    stdout: command.includes('rev-parse') ? 'abc\n' : 'diff',
                    stderr: '',
                  };
            },
            changedFiles: async () => ['src/a.ts'],
            external: (steps, _approvals) => ({
              agent: async <S extends z.ZodType>(
                name: string | { prompt: string },
                opts?: AgentCallOpts<S>,
              ) =>
                steps.step('agent', { label: opts?.label }, async () => {
                  const n =
                    typeof name === 'string' ? name : (opts?.label ?? 'inline');
                  trace.push(n);
                  const input = (opts?.input ?? {}) as Record<string, unknown>;
                  calls.push({ name: n, input, options: opts });
                  const data =
                    options.agent?.(
                      n,
                      input,
                      calls.filter((call) => call.name === n).length,
                    ) ??
                    (n === 'refiner'
                      ? {
                          status: 'clear',
                          scope: 'Handle empty input.',
                          decisions: ['Return an empty list as requested.'],
                          acceptanceCriteria: ['Return an empty list.'],
                          outOfScope: [],
                        }
                      : n === 'planner'
                        ? { steps: ['Handle empty input.'] }
                        : n === 'ui-triage'
                          ? { isFrontend: false }
                          : n.includes('reviewer')
                            ? { complaints: [] }
                            : {});
                  return {
                    status: 'done',
                    result: Object.assign(opts?.schema?.parse(data) ?? data, {
                      summary: 'Fixture summary.',
                    }),
                  };
                }),
              checkpoint: async (checkpoint) => {
                trace.push('checkpoint');
                const answer = answers.shift();
                return answer
                  ? { status: 'done', result: answer }
                  : { status: 'waiting', detail: checkpoint };
              },
              comment: (body) =>
                steps.step('linear.comment', {}, async () => {
                  trace.push(`comment:${body}`);
                  return { status: 'done', result: undefined };
                }),
              post: (body) =>
                steps
                  .step('post', {}, async () => {
                    trace.push(`post:${body}`);
                    return { status: 'done', result: null };
                  })
                  .then(() => undefined),
              linear: {
                setState: (state) =>
                  steps
                    .step('linear', {}, async () => {
                      trace.push(state);
                      return { status: 'done', result: null };
                    })
                    .then(() => undefined),
              },
              // External SCM fixture, not a substitute for SDK/platform integration.
              scm: new Proxy({} as ScmOps, {
                get:
                  (_, operation: string) =>
                  (...args: unknown[]) =>
                    steps.step(`scm:${operation}`, {}, async () => {
                      trace.push(operation);
                      scmCalls.push({ operation, args });
                      if (operation === 'armAutoMerge' && !merged)
                        return { status: 'waiting' };
                      const result =
                        options.scm?.(
                          operation,
                          scmCalls.filter(
                            (call) => call.operation === operation,
                          ).length,
                        ) ??
                        (operation === 'openPr' || operation === 'markDraft'
                          ? pr
                          : operation === 'waitForCi'
                            ? {
                                status: 'passed',
                                headSha: 'abc',
                                failedJobs: [],
                              }
                            : operation === 'updateBranch'
                              ? { status: 'clean', pr }
                              : operation === 'armAutoMerge'
                                ? { status: 'merged', pr }
                                : null);
                      return { status: 'done', result };
                    }),
              }),
            }),
          },
        );
        const binding = (options.triggers ?? triggers).find(
          (trigger) => trigger.kind === 'linear.onDelegate',
        );
        if (!binding) throw new Error('Missing delegation Trigger');
        return binding.workflow(ctx as WorkflowContext, { members: [] });
      },
    });
  return {
    trace,
    calls,
    scmCalls,
    boot,
    answer: (answer: RawCheckpointAnswer) => answers.push(answer),
    approve: () => {
      answers.push({ decision: 'approve' });
    },
    merge: () => {
      merged = true;
    },
  };
}

it('opens a draft before reviews, parks at the final Checkpoint, and records Done only after actual merge', async () => {
  const f = fixture();
  expect((await f.boot()).status).toBe('parked');
  expect(f.trace.indexOf('push')).toBeLessThan(f.trace.indexOf('openPr'));
  expect(f.trace.indexOf('openPr')).toBeLessThan(
    f.trace.indexOf('compliance-reviewer'),
  );
  expect(f.trace).not.toContain('armAutoMerge');
  const agentsBefore = f.calls.length;
  f.approve();
  expect((await f.boot()).status).toBe('parked');
  expect(f.calls).toHaveLength(agentsBefore);
  expect(f.trace).not.toContain('Done');
  f.merge();
  expect(await f.boot()).toMatchObject({
    status: 'finished',
    outcome: 'merged',
  });
  expect(f.trace.at(-1)).toBe('Done');
});

it('bounds a disagreement loop, keeps compliance rule-free, and exposes unresolved blocking Complaints', async () => {
  const f = fixture({
    agent: (name, input) => {
      if (name === 'compliance-reviewer')
        return {
          complaints: [
            {
              id: `${input.namespace}/c1`,
              file: 'src/a.ts',
              text: 'Empty input crashes.',
              quote: 'Return an empty list.',
              ...(Array.isArray(input.disagreements) &&
              input.disagreements.length
                ? { rebuttal: 'The empty case still crashes.' }
                : {}),
            },
          ],
        };
      if (name === 'fixer')
        return {
          resolutions: (input.complaints as { id: string }[]).map(({ id }) => ({
            id,
            status: 'disagreed',
            note: 'Not required.',
          })),
        };
      return undefined;
    },
  });
  expect(await f.boot()).toMatchObject({
    status: 'finished',
    outcome: 'exhausted',
  });
  const reviews = f.calls.filter(({ name }) => name === 'compliance-reviewer');
  expect(reviews).toHaveLength(5);
  expect(reviews.every(({ input }) => !('rules' in input))).toBe(true);
  expect(reviews[1].input.disagreements).toEqual([
    {
      id: 'compliance-reviewer/1/1/c1',
      text: 'Empty input crashes.',
      why: 'Not required.',
    },
  ]);
  expect(f.trace).not.toContain('checkpoint');
  expect(f.scmCalls.at(-1)).toMatchObject({
    operation: 'markDraft',
    args: [expect.anything(), true],
  });
  expect(f.trace.at(-1)).toContain('compliance-reviewer/5/1/c1');
});

it('revalidates every gate after a Checkpoint Steer and drafts on rejection', async () => {
  const f = fixture();
  f.answer({ decision: 'steer', message: 'Also handle whitespace.' });
  f.answer({ decision: 'reject', reason: 'Not ready.' });
  expect(await f.boot()).toMatchObject({
    status: 'finished',
    outcome: 'rejected',
  });
  const fixer = f.calls.find(({ name }) => name === 'fixer');
  expect(fixer?.input.steer).toBe('Also handle whitespace.');
  expect(
    f.calls.filter(({ name }) => name === 'compliance-reviewer'),
  ).toHaveLength(2);
  expect(f.calls.filter(({ name }) => name === 'ui-triage')).toHaveLength(2);
  expect(f.calls.filter(({ name }) => name === 'reviewer')).toHaveLength(2);
  expect(
    f.scmCalls.filter(({ operation }) => operation === 'waitForCi'),
  ).toHaveLength(2);
  expect(f.trace).not.toContain('armAutoMerge');
});

it('spends at most three CI repair attempts and never readies failed CI', async () => {
  const f = fixture({
    agent: (name) => (name === 'ci-fixer' ? { action: 'retry' } : undefined),
    scm: (operation) =>
      operation === 'waitForCi'
        ? {
            status: 'failed',
            headSha: 'abc',
            failedJobs: [
              { name: 'test', failedSteps: ['unit'], logTail: 'Timeout' },
            ],
          }
        : undefined,
  });
  expect(await f.boot()).toMatchObject({
    status: 'finished',
    outcome: 'exhausted',
  });
  expect(f.calls.filter(({ name }) => name === 'ci-fixer')).toHaveLength(3);
  expect(
    f.scmCalls.filter(({ operation }) => operation === 'retryFailedJobs'),
  ).toHaveLength(3);
  expect(f.trace).not.toContain('checkpoint');
  expect(
    f.scmCalls.filter(
      ({ operation, args }) => operation === 'markDraft' && args[1] === false,
    ),
  ).toEqual([]);
});

async function visualTemplate() {
  const snapshot = join(dir, 'snapshot');
  await cp(new URL('../../content/.rocky/', import.meta.url), snapshot, {
    recursive: true,
  });
  const path = join(snapshot, 'workflow.ts');
  const source = await readFile(path, 'utf8');
  await writeFile(
    path,
    source
      .replace(
        '= null;',
        '= { start: "test-server", url: "http://127.0.0.1" };',
      )
      .replace('attempts: 30, intervalMs: 1000', 'attempts: 2, intervalMs: 0'),
  );
  vi.stubEnv('ROCKY_SCREENSHOT_DIR', dir);
  vi.stubEnv('ROCKY_RUN_DIR', dir);
  return (
    await createJiti(import.meta.url, {
      alias: {
        '@rocky/sdk': new URL('../../../sdk/src/index.ts', import.meta.url)
          .pathname,
      },
    }).import<{ default: Triggers }>(path)
  ).default;
}

it('writes Checks once, sweeps all of them each pass, and anchors Observations in parallel before fixing', async () => {
  vi.stubGlobal('fetch', async () => ({ ok: true }));
  const checks = [
    {
      id: 'desktop',
      url: '/',
      action: 'Open desktop.',
      expected: 'Button visible.',
    },
    {
      id: 'mobile',
      url: '/',
      action: 'Open mobile.',
      expected: 'Button visible.',
    },
  ];
  const f = fixture({
    triggers: await visualTemplate(),
    agent: (name, input, count) => {
      if (name === 'ui-triage') return { isFrontend: true };
      if (name === 'ui-planner') return { checks };
      if (name === 'ui-inspector')
        return {
          results: checks.map(({ id }) => ({
            id,
            verdict: count === 1 ? 'problem' : 'ok',
            note: 'Fixture UI result.',
            screenshots: [],
            observations:
              count === 1
                ? [
                    {
                      url: 'http://127.0.0.1:12345/',
                      text: 'Button clipped.',
                      screenshots: [],
                    },
                  ]
                : [],
          })),
        };
      if (name === 'ui-complaint-writer')
        return {
          id: `${input.namespace}/c1`,
          file: 'src/button.ts',
          text: 'Button clipped.',
        };
      if (name === 'fixer')
        return {
          resolutions: (input.complaints as { id: string }[]).map(({ id }) => ({
            id,
            status: 'disagreed',
            note: 'No route exists.',
          })),
        };
      return undefined;
    },
  });
  expect((await f.boot()).status).toBe('parked');
  expect(f.calls.filter(({ name }) => name === 'ui-planner')).toHaveLength(1);
  const inspections = f.calls.filter(({ name }) => name === 'ui-inspector');
  expect(inspections).toHaveLength(2);
  expect(inspections.map(({ input }) => input.checks)).toEqual([
    checks,
    checks,
  ]);
  expect(inspections[1].input.previousExplanations).toEqual([
    'No route exists.',
    'No route exists.',
  ]);
  expect(inspections[0].options).toMatchObject({
    tools: ['read'],
    mcp: ['playwright'],
  });
  expect(
    f.calls.filter(({ name }) => name === 'ui-complaint-writer'),
  ).toHaveLength(2);
  expect(
    inspections.every(
      ({ input }) => !('diff' in input) && !('complaints' in input),
    ),
  ).toBe(true);
});

it('treats a dev server that never becomes ready as an anchored Complaint, not a skipped UI gate', async () => {
  vi.stubGlobal('fetch', async () => {
    throw new Error('connection refused');
  });
  const f = fixture({
    triggers: await visualTemplate(),
    agent: (name, input) => {
      if (name === 'ui-triage') return { isFrontend: true };
      if (name === 'ui-planner')
        return {
          checks: [
            { id: 'boot', url: '/', action: 'Open.', expected: 'Renders.' },
          ],
        };
      if (name === 'ui-complaint-writer')
        return {
          id: `${input.namespace}/boot`,
          file: 'vite.config.ts',
          text: 'Invalid import prevents startup.',
        };
      if (name === 'fixer')
        return {
          resolutions: (input.complaints as { id: string }[]).map(({ id }) => ({
            id,
            status: 'fixed',
            note: 'Attempted repair.',
          })),
        };
      return undefined;
    },
  });
  expect(await f.boot()).toMatchObject({
    status: 'finished',
    outcome: 'exhausted',
  });
  expect(
    f.calls.filter(({ name }) => name === 'ui-complaint-writer'),
  ).toHaveLength(5);
  expect(f.calls.filter(({ name }) => name === 'ui-inspector')).toHaveLength(0);
  expect(f.trace.at(-1)).toContain('vite.config.ts');
  expect(f.trace).not.toContain('checkpoint');
});

it('runs the merger only for reported conflicts, then revalidates before asking again and arming', async () => {
  const pr = {
    repo: 'fixture',
    id: 'pr-1',
    number: 1,
    url: 'https://example.test/pr/1',
    sourceBranch: 'test-1',
    baseBranch: 'main',
    headSha: 'abc',
    state: 'open',
    draft: true,
  };
  const f = fixture({
    scm: (operation, count) =>
      operation === 'updateBranch' && count === 1
        ? { status: 'conflict', pr }
        : undefined,
  });
  f.approve();
  f.approve();
  f.merge();
  expect(await f.boot()).toMatchObject({
    status: 'finished',
    outcome: 'merged',
  });
  expect(f.calls.filter(({ name }) => name === 'merger')).toHaveLength(1);
  expect(
    f.calls.filter(({ name }) => name === 'compliance-reviewer'),
  ).toHaveLength(2);
  expect(
    f.scmCalls.filter(({ operation }) => operation === 'waitForCi'),
  ).toHaveLength(2);
  expect(f.trace.indexOf('merger')).toBeLessThan(
    f.trace.lastIndexOf('checkpoint'),
  );
  expect(f.trace.lastIndexOf('checkpoint')).toBeLessThan(
    f.trace.indexOf('armAutoMerge'),
  );
});

it('does not accept green CI for another head', async () => {
  const f = fixture({
    scm: (operation) =>
      operation === 'waitForCi'
        ? { status: 'passed', headSha: 'stale', failedJobs: [] }
        : undefined,
  });
  expect((await f.boot()).status).toBe('failed');
  expect(f.trace).not.toContain('checkpoint');
});

it('fails a refused ready-flip instead of presenting a ready Checkpoint', async () => {
  const f = fixture({
    scm: (operation) =>
      operation === 'markDraft'
        ? {
            refused: true,
            reason: 'permission_denied',
            message: 'Cannot make the PR ready.',
            fix: 'Grant PR write access.',
          }
        : undefined,
  });
  expect(await f.boot()).toMatchObject({
    status: 'failed',
    error: { message: expect.stringContaining('Grant PR write access.') },
  });
  expect(f.trace).not.toContain('checkpoint');
});

it('rechecks earlier gates when the final review fixes code and preserves fixes on the PR', async () => {
  const f = fixture({
    agent: (name, input, count) => {
      if (name === 'reviewer' && count === 1)
        return {
          complaints: [
            {
              id: `${input.namespace}/c1`,
              file: 'src/a.ts',
              text: 'Regression.',
            },
          ],
        };
      if (name === 'fixer')
        return {
          resolutions: (input.complaints as { id: string }[]).map(({ id }) => ({
            id,
            status: 'fixed',
            note: 'Fixed the regression.',
          })),
        };
      return undefined;
    },
  });
  expect((await f.boot()).status).toBe('parked');
  expect(
    f.calls.filter(({ name }) => name === 'compliance-reviewer'),
  ).toHaveLength(2);
  expect(f.calls.filter(({ name }) => name === 'ui-triage')).toHaveLength(2);
  expect(f.trace.indexOf('push', f.trace.indexOf('fixer'))).toBeLessThan(
    f.trace.lastIndexOf('reviewer'),
  );
});

it('addresses unresolved PR conversations once each without prior Run hand-over state', async () => {
  const replies: { id: string; body: string }[] = [];
  const threads = [
    {
      id: 'a',
      path: 'src/a.ts',
      line: 10,
      body: 'Handle empty input.',
      resolved: false,
    },
    {
      id: 'b',
      path: 'src/b.ts',
      body: 'This should be removed.',
      resolved: false,
    },
    { id: 'done', path: 'src/c.ts', body: 'Already fixed.', resolved: true },
  ];
  const result = await addressPrConversations({
    issue: {
      identifier: 'TEST-1',
      title: 'Fix it',
      url: 'https://example.test/issue/1',
    },
    exec: async () => ({ exitCode: 0, stdout: 'abc', stderr: '' }),
    scm: {
      openPr: async () => ({ id: 'pr', state: 'open' }),
      reviewThreads: async () => threads,
      replyToThread: async (thread: { id: string }, body: string) => {
        replies.push({ id: thread.id, body });
      },
    },
    agent: async (
      _name: string,
      opts: {
        input: { complaints: { id: string; file: string; line?: number }[] };
        schema: z.ZodType;
      },
    ) => {
      expect(opts.input.complaints).toHaveLength(2);
      expect(opts.input.complaints[0]).toMatchObject({
        file: 'src/a.ts',
        line: 10,
      });
      return Object.assign(
        {},
        opts.schema.parse({
          resolutions: opts.input.complaints.map(({ id }, index) => ({
            id,
            status: index ? 'disagreed' : 'fixed',
            note: index ? 'It is needed for callers.' : 'Added a guard.',
          })),
        }),
        { summary: 'Addressed both threads.' },
      );
    },
  });
  expect(result).toBe('completed');
  expect(replies).toEqual([
    { id: 'a', body: 'Fixed in abc. Added a guard.' },
    { id: 'b', body: 'It is needed for callers.' },
  ]);
});

it('clarifies repeatedly before planning and carries the complete decision record downstream', async () => {
  const f = fixture({
    agent: (name, _input, count) =>
      name === 'refiner'
        ? count < 3
          ? {
              status: 'questions',
              reason: 'Repository scope is ambiguous.',
              questions: [
                count === 1
                  ? 'Which repository?'
                  : 'What should empty input return?',
              ],
            }
          : {
              status: 'clear',
              scope: 'App only. Empty input returns an empty list.',
              decisions: ['User chose app only.', 'User chose an empty list.'],
              acceptanceCriteria: [
                'An empty list is returned for empty input.',
              ],
              outOfScope: ['Other repositories.'],
            }
        : undefined,
  });
  expect(await f.boot()).toMatchObject({ status: 'parked' });
  expect(f.calls.some((call) => call.name === 'planner')).toBe(false);
  f.answer({ decision: 'steer', message: 'App only.' });
  expect(await f.boot()).toMatchObject({ status: 'parked' });
  expect(f.calls.some((call) => call.name === 'implementer')).toBe(false);
  f.answer({ decision: 'steer', message: 'An empty list.' });
  expect(await f.boot()).toMatchObject({ status: 'parked' });
  const planner = f.calls.find((call) => call.name === 'planner');
  expect(JSON.stringify(planner?.input)).toContain(
    'App only. Empty input returns an empty list.',
  );
  expect(f.trace.find((line) => line.startsWith('comment:'))).toContain(
    'Scope decision record',
  );
  expect(
    JSON.stringify(
      f.calls.filter((call) => call.name === 'refiner').at(-1)?.input,
    ),
  ).toContain('An empty list.');
});
