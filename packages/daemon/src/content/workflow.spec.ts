import { flowBindings } from '../flow/runtime.js';
import { parseFlow } from '@rocky/local-contracts';
import { createJiti } from 'jiti';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentCallOpts,
  ScmOps,
  Triggers,
  WorkflowContext,
} from '@rocky/sdk';
import { z } from '@rocky/sdk';
import { newRepositoryProfile } from '../config/profiles.js';
import { createWorkflowContext } from '../run/context.js';
import { runBoot } from '../run/replay.js';

const { default: legacyTriggers, addressPrConversations: legacyConversations } =
  await createJiti(import.meta.url, {
    alias: {
      '@rocky/sdk': new URL('../../../sdk/src/index.ts', import.meta.url)
        .pathname,
    },
  }).import<{
    default: Triggers;
    addressPrConversations: (ctx: unknown) => Promise<string>;
  }>(new URL('../../content/.rocky/workflow.ts', import.meta.url).pathname);

type RawCheckpointAnswer =
  | { decision: 'approve' }
  | { decision: 'reject'; reason?: string }
  | { decision: 'steer'; message: string };

const flowSource = await readFile(
  new URL('../../content/.rocky/workflow.json', import.meta.url),
  'utf8',
);
const flowTriggers = (source: string, snapshot: string): Triggers =>
  flowBindings(source, snapshot).map(({ descriptor, workflow }) => ({
    ...descriptor,
    workflow,
  }));
describe.each(['legacy', 'flow'])('%s default workflow', (mode) => {
  const triggers =
    mode === 'flow'
      ? flowTriggers(
          flowSource,
          new URL('../../content/.rocky/', import.meta.url).pathname,
        )
      : legacyTriggers;
  const addressPrConversations =
    mode === 'flow'
      ? (ctx: unknown) =>
          triggers
            .find((t) => t.kind === 'manual')!
            .workflow(ctx as WorkflowContext, { members: [] })
      : legacyConversations;
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
      'deliverable-reviewer.md',
      'deliverable-writer.md',
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
      comments?: import('@rocky/sdk').IssueComment[];
      agent?: (
        name: string,
        input: Record<string, unknown>,
        count: number,
      ) => Record<string, unknown> | undefined;
      exec?: (
        command: string,
      ) => { exitCode: number; stdout: string; stderr: string } | undefined;
      comment?: (body: string) => void;
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
                ...(options.comments ? { comments: options.comments } : {}),
              },
              profile: {
                ...newRepositoryProfile({
                  id: 'fixture',
                  remote: 'github.com/acme/app',
                }),
                models: {
                  review: {
                    harness: 'opencode',
                    model: 'review-model',
                    effort: 'high',
                  },
                  implementation: {
                    harness: 'claude-code',
                    model: 'implementation-model',
                    effort: 'high',
                  },
                  planner: {
                    harness: 'opencode',
                    model: 'planning-model',
                    effort: 'low',
                  },
                },
              },
              branch: 'test-1',
              ports: [12345],
            },
            {
              exec: async (command, background) => {
                trace.push(
                  command.includes('git push origin HEAD') ? 'push' : command,
                );
                const result = options.exec?.(command);
                if (result) return result;
                if (command.includes('ROCKY_MERMAID_CHECK'))
                  return {
                    exitCode: 0,
                    stdout: JSON.stringify({
                      ok: true,
                      rendered: false,
                      diagrams: [],
                    }),
                    stderr: '',
                  };
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
                      typeof name === 'string'
                        ? name
                        : (opts?.label ?? 'inline');
                    trace.push(n);
                    const input = (opts?.input ?? {}) as Record<
                      string,
                      unknown
                    >;
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
                            delivery: {
                              kind: 'pull-request',
                              merge: true,
                              stateChanges: true,
                            },
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
                visualRecap: () =>
                  steps.step('visualRecap', {}, async () => {
                    trace.push('visualRecap');
                    return {
                      status: 'done',
                      result: {
                        id: 'r_fixture',
                        url: 'https://rocky.test/recap',
                      },
                    };
                  }),
                comment: (body) =>
                  steps.step('linear.comment', {}, async () => {
                    options.comment?.(body);
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
    for (const name of ['refiner', 'planner'])
      expect(f.calls.find((call) => call.name === name)?.options).toMatchObject(
        {
          harness: 'opencode',
          model: 'planning-model',
          effort: 'low',
        },
      );
    expect(
      f.calls.find((call) => call.name === 'implementer')?.options,
    ).toMatchObject({
      harness: 'claude-code',
      model: 'implementation-model',
      effort: 'high',
    });
    expect(
      f.calls.find((call) => call.name === 'reviewer')?.options,
    ).toMatchObject({
      harness: 'opencode',
      model: 'review-model',
      effort: 'high',
    });
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
            resolutions: (input.complaints as { id: string }[]).map(
              ({ id }) => ({
                id,
                status: 'disagreed',
                note: 'Not required.',
              }),
            ),
          };
        return undefined;
      },
    });
    expect(await f.boot()).toMatchObject({
      status: 'finished',
      outcome: 'exhausted',
    });
    const reviews = f.calls.filter(
      ({ name }) => name === 'compliance-reviewer',
    );
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
    if (mode === 'flow') {
      const flow = parseFlow(flowSource);
      flow.settings.ui = { start: 'test-server', url: 'http://127.0.0.1' };
      flow.settings.readiness = { attempts: 2, intervalMs: 1 };
      vi.stubEnv('ROCKY_SCREENSHOT_DIR', dir);
      vi.stubEnv('ROCKY_RUN_DIR', dir);
      return flowTriggers(JSON.stringify(flow), snapshot);
    }
    const path = join(snapshot, 'workflow.ts');
    const source = await readFile(path, 'utf8');
    await writeFile(
      path,
      source
        .replace(
          '= null;',
          '= { start: "test-server", url: "http://127.0.0.1" };',
        )
        .replace(
          'attempts: 30, intervalMs: 1000',
          'attempts: 2, intervalMs: 0',
        ),
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
            resolutions: (input.complaints as { id: string }[]).map(
              ({ id }) => ({
                id,
                status: 'disagreed',
                note: 'No route exists.',
              }),
            ),
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
            resolutions: (input.complaints as { id: string }[]).map(
              ({ id }) => ({
                id,
                status: 'fixed',
                note: 'Attempted repair.',
              }),
            ),
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
    expect(f.calls.filter(({ name }) => name === 'ui-inspector')).toHaveLength(
      0,
    );
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
    expect(f.trace.filter((command) => command.includes('git merge'))).toEqual([
      'cd -- "$ROCKY_LEAD_REPO" && git merge --no-edit -- \'refs/remotes/origin/main\'',
    ]);
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
            resolutions: (input.complaints as { id: string }[]).map(
              ({ id }) => ({
                id,
                status: 'fixed',
                note: 'Fixed the regression.',
              }),
            ),
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
    const recap = vi.fn(async () => ({
      id: 'r_fixture',
      url: 'https://rocky.test/recap',
    }));
    const result = await addressPrConversations({
      models: {
        review: { harness: 'opencode', model: 'review-model', effort: 'high' },
        implementation: {
          harness: 'claude-code',
          model: 'implementation-model',
          effort: 'high',
        },
      },
      visualRecap: recap,
      stage: () => undefined,
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
    expect(recap).toHaveBeenCalledWith(
      expect.objectContaining({
        pr: expect.objectContaining({ headSha: 'abc' }),
      }),
    );
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
                delivery: {
                  kind: 'pull-request',
                  merge: true,
                  stateChanges: true,
                },
                scope: 'App only. Empty input returns an empty list.',
                decisions: [
                  'User chose app only.',
                  'User chose an empty list.',
                ],
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
    expect(
      f.trace.find(
        (line) =>
          line.startsWith('post:') && line.includes('Scope decision record'),
      ),
    ).toContain('Scope decision record');
    expect(
      JSON.stringify(
        f.calls.filter((call) => call.name === 'refiner').at(-1)?.input,
      ),
    ).toContain('An empty list.');
  });

  it('delivers a no-PR ticket as a reviewed Linear comment without SCM or editing', async () => {
    const body = '## Architecture\n```mermaid\nflowchart LR\n  API --> DB\n```';
    const f = fixture({
      agent: (name) => {
        if (name === 'refiner')
          return {
            status: 'clear',
            scope:
              'Inspect repositories and return a Linear comment. No PR or edits.',
            decisions: [
              'The user explicitly requests a Linear comment and no PR.',
            ],
            acceptanceCriteria: ['Explain the architecture.'],
            outOfScope: ['Repository changes.'],
            delivery: { kind: 'linear-comment', stateChanges: false },
          };
        if (name === 'deliverable-writer') return { body };
        if (name === 'deliverable-reviewer')
          return {
            assessments: [
              {
                criterion: 'Explain the architecture.',
                evidence: 'The diagram explains the architecture.',
                problems: [],
              },
            ],
            problems: [],
          };
        return undefined;
      },
    });
    expect(await f.boot()).toMatchObject({
      status: 'finished',
      outcome: 'completed',
    });
    expect(f.scmCalls).toEqual([]);
    expect(f.trace).not.toContain('implementer');
    for (const call of f.calls.filter(({ name }) =>
      name.startsWith('deliverable-'),
    )) {
      expect(call.options?.tools).toEqual(['read', 'bash']);
    }
    expect(f.trace.some((line) => line.includes('git push'))).toBe(false);
    expect(f.trace).toContain(`comment:${body}`);
    expect(f.trace.filter((line) => line.startsWith('comment:'))).toHaveLength(
      1,
    );
    expect(f.trace).not.toContain('Done');
    const calls = f.calls.length;
    expect(await f.boot()).toMatchObject({
      status: 'finished',
      outcome: 'completed',
    });
    expect(f.calls).toHaveLength(calls);
    expect(f.trace.filter((line) => line === `comment:${body}`)).toHaveLength(
      1,
    );
  });

  const commentScope = {
    status: 'clear',
    scope: 'Explain the architecture in a Linear comment.',
    decisions: ['Deliver in Linear; no PR or repository edits.'],
    acceptanceCriteria: ['Explain the architecture.'],
    outOfScope: ['Repository changes.'],
    delivery: { kind: 'linear-comment', stateChanges: true },
  };

  it('repairs a rejected comment and reviews the replacement before publishing', async () => {
    const f = fixture({
      agent: (name, input, count) => {
        if (name === 'refiner') return commentScope;
        if (name === 'deliverable-writer')
          return { body: count === 1 ? 'Incomplete' : 'Complete architecture' };
        if (name === 'deliverable-reviewer')
          return {
            assessments: [
              {
                criterion: 'Explain the architecture.',
                evidence: 'Checked repository entrypoints.',
                problems:
                  input.body === 'Incomplete'
                    ? ['Missing the storage connection.']
                    : [],
              },
            ],
            problems: [],
          };
        return undefined;
      },
    });
    expect(await f.boot()).toMatchObject({
      status: 'finished',
      outcome: 'completed',
    });
    expect(
      f.calls.filter(({ name }) => name === 'deliverable-reviewer'),
    ).toHaveLength(4);
    expect(
      f.calls.filter(({ name }) => name === 'deliverable-writer')[1].input
        .previous,
    ).toMatchObject({
      body: 'Incomplete',
      problems: expect.arrayContaining(['Missing the storage connection.']),
    });
    expect(f.trace.filter((line) => line.startsWith('comment:'))).toEqual([
      'comment:Complete architecture',
    ]);
    expect(f.trace.at(-1)).toBe('In Review');
    expect(f.scmCalls).toEqual([]);
  });

  it('exhausts comment review without publishing an unapproved deliverable', async () => {
    const f = fixture({
      agent: (name) => {
        if (name === 'refiner') return commentScope;
        if (name === 'deliverable-writer') return { body: 'Incomplete' };
        if (name === 'deliverable-reviewer')
          return {
            assessments: [
              {
                criterion: 'Explain the architecture.',
                evidence: 'No architecture in the body.',
                problems: ['Missing architecture.'],
              },
            ],
            problems: [],
          };
        return undefined;
      },
    });
    expect(await f.boot()).toMatchObject({
      status: 'finished',
      outcome: 'exhausted',
    });
    expect(
      f.calls.filter(({ name }) => name === 'deliverable-writer'),
    ).toHaveLength(5);
    expect(f.trace.filter((line) => line.startsWith('comment:'))).toEqual([]);
    expect(f.trace).not.toContain('In Review');
    expect(f.scmCalls).toEqual([]);
  });

  it('does not complete or advance state when comment delivery fails', async () => {
    const f = fixture({
      comment: () => {
        throw new Error('Linear unavailable');
      },
      agent: (name) => {
        if (name === 'refiner') return commentScope;
        if (name === 'deliverable-writer') return { body: 'Architecture' };
        if (name === 'deliverable-reviewer')
          return {
            assessments: [
              {
                criterion: 'Explain the architecture.',
                evidence: 'Source-backed architecture.',
                problems: [],
              },
            ],
            problems: [],
          };
        return undefined;
      },
    });
    expect(await f.boot()).toMatchObject({ status: 'failed' });
    expect(f.trace).not.toContain('In Review');
    expect(f.trace).not.toContain('Done');
  });

  it('hands off a validated PR without approval or merge when the ticket forbids Rocky merging', async () => {
    const f = fixture({
      agent: (name) =>
        name === 'refiner'
          ? {
              ...commentScope,
              scope: 'Implement empty input and hand off a PR without merging.',
              decisions: [
                'The user requests a PR for human handling, without automatic merge.',
              ],
              outOfScope: ['Automatic merge.'],
              delivery: {
                kind: 'pull-request',
                merge: false,
                stateChanges: false,
              },
            }
          : undefined,
    });
    expect(await f.boot()).toMatchObject({
      status: 'finished',
      outcome: 'completed',
    });
    expect(f.trace).toContain('waitForCi');
    expect(f.trace).not.toContain('checkpoint');
    expect(f.trace).not.toContain('updateBranch');
    expect(f.trace).not.toContain('armAutoMerge');
    expect(f.trace).not.toContain('In Progress');
    expect(f.trace).not.toContain('In Review');
    expect(f.trace.at(-1)).toContain(
      'comment:Ready for review: https://example.test/pr/1',
    );
  });

  it('passes human steering to subsequent compliance review', async () => {
    const f = fixture();
    f.answer({ decision: 'steer', message: 'Also handle whitespace.' });
    f.answer({ decision: 'reject' });
    await f.boot();
    const reviews = f.calls.filter(
      ({ name }) => name === 'compliance-reviewer',
    );
    expect(JSON.stringify(reviews[1].input.issue)).toContain(
      'Also handle whitespace.',
    );
  });

  it('runs configured checks and blocks handoff after repeated failures even when agents claim success', async () => {
    const snapshot = join(dir, 'validation-snapshot');
    await cp(new URL('../../content/.rocky/', import.meta.url), snapshot, {
      recursive: true,
    });
    const path = join(snapshot, 'workflow.ts');
    await writeFile(
      path,
      (await readFile(path, 'utf8')).replace(
        "test: ''",
        "test: 'fixture-test'",
      ),
    );
    const loaded = await createJiti(import.meta.url, {
      alias: {
        '@rocky/sdk': new URL('../../../sdk/src/index.ts', import.meta.url)
          .pathname,
      },
    }).import<{ default: Triggers }>(path);
    const f = fixture({
      triggers:
        mode === 'flow'
          ? flowTriggers(
              JSON.stringify({
                ...parseFlow(flowSource),
                settings: {
                  ...parseFlow(flowSource).settings,
                  commands: {
                    install: '',
                    test: 'fixture-test',
                    lint: '',
                    build: '',
                  },
                },
              }),
              snapshot,
            )
          : loaded.default,
      exec: (command) =>
        command.includes('fixture-test')
          ? { exitCode: 1, stdout: 'empty case still fails', stderr: '' }
          : undefined,
      agent: (name, input) =>
        name === 'fixer'
          ? {
              resolutions: (input.complaints as { id: string }[]).map(
                ({ id }) => ({ id, status: 'fixed', note: 'Claimed success.' }),
              ),
            }
          : undefined,
    });
    expect(await f.boot()).toMatchObject({
      status: 'finished',
      outcome: 'exhausted',
    });
    expect(f.calls.filter(({ name }) => name === 'fixer')).toHaveLength(4);
    expect(f.trace).not.toContain('checkpoint');
    expect(f.trace).not.toContain('armAutoMerge');
    expect(f.trace.at(-1)).toContain('empty case still fails');
  });

  it('typechecks the shipped workflow against the public SDK', async () => {
    await promisify(execFile)(process.execPath, [
      createRequire(import.meta.url).resolve('typescript/bin/tsc'),
      '--ignoreConfig',
      '--noEmit',
      '--strict',
      '--module',
      'NodeNext',
      '--target',
      'ES2022',
      '--skipLibCheck',
      '--types',
      'node',
      new URL('../../content/.rocky/workflow.ts', import.meta.url).pathname,
    ]);
  });

  it('creates the visual recap after validation and before readying or asking the human', async () => {
    const f = fixture();
    expect((await f.boot()).status).toBe('parked');
    expect(f.trace.indexOf('visualRecap')).toBeGreaterThan(
      f.trace.indexOf('waitForCi'),
    );
    expect(f.trace.indexOf('visualRecap')).toBeLessThan(
      f.trace.indexOf('markDraft'),
    );
    expect(f.trace.indexOf('visualRecap')).toBeLessThan(
      f.trace.indexOf('checkpoint'),
    );
    const ready = f.scmCalls.find(
      ({ operation, args }) => operation === 'markDraft' && args[1] === false,
    );
    expect(JSON.stringify(ready)).toContain('https://rocky.test/recap');
  });

  it('feeds previous-session answers to refinement and downstream planning', async () => {
    const comments = [
      {
        id: 'prior-answer',
        body: 'Return an empty list.',
        createdAt: '2026-09-01T00:00:00Z',
        userId: 'human',
        sessionId: null,
        parentId: 'old-session-thread',
      },
    ];
    const f = fixture({ comments });
    await f.boot();
    for (const name of ['refiner', 'planner']) {
      expect(
        f.calls.find((call) => call.name === name)?.input.issue,
      ).toMatchObject({ comments });
    }
  });

  it('reviews publication criteria as readiness, validates diagrams, and publishes only after approval', async () => {
    const criterion =
      'A comment is published on the issue containing the architecture diagram.';
    const body = '```mermaid\nflowchart LR\nA --> B\n```';
    const f = fixture({
      exec: (command) =>
        command.includes('ROCKY_MERMAID_CHECK')
          ? {
              exitCode: 0,
              stdout: JSON.stringify({
                ok: true,
                diagrams: [{ index: 1, valid: true }],
                rendered: false,
              }),
              stderr: '',
            }
          : undefined,
      agent: (name, input) => {
        if (name === 'refiner')
          return { ...commentScope, acceptanceCriteria: [criterion] };
        if (name === 'deliverable-writer') return { body };
        if (name === 'deliverable-reviewer') {
          expect(input.reviewContract).toMatchObject({
            phase: 'before-publication',
            publisher: 'workflow',
          });
          expect(input.validation).toMatchObject({ ok: true, rendered: false });
          return {
            assessments: [
              {
                criterion,
                evidence:
                  'The exact candidate body is ready; the workflow confirms publication afterwards.',
                problems: [],
              },
            ],
            problems: [],
          };
        }
        return undefined;
      },
    });
    expect(await f.boot()).toMatchObject({
      status: 'finished',
      outcome: 'completed',
    });
    expect(f.calls.filter((c) => c.name === 'deliverable-writer')).toHaveLength(
      1,
    );
    expect(f.trace.filter((t) => t === `comment:${body}`)).toHaveLength(1);
  });

  it('stops before drafting when the required validator is unavailable', async () => {
    const f = fixture({
      agent: (name) => (name === 'refiner' ? commentScope : undefined),
      exec: (command) =>
        command.includes('ROCKY_MERMAID_CHECK')
          ? { exitCode: 127, stdout: '', stderr: 'missing validator' }
          : undefined,
    });
    expect(await f.boot()).toMatchObject({
      status: 'failed',
      error: {
        message: expect.stringContaining(
          'Required Mermaid validator is unavailable',
        ),
      },
    });
    expect(f.calls.some((c) => c.name === 'deliverable-writer')).toBe(false);
  });
  it('repairs parser failures before review and never publishes an invalid diagram', async () => {
    let validations = 0;
    const f = fixture({
      exec: (command) => {
        if (!command.includes('ROCKY_MERMAID_CHECK')) return;
        const invalid = ++validations === 2;
        return {
          exitCode: invalid ? 1 : 0,
          stdout: JSON.stringify({
            ok: !invalid,
            rendered: false,
            diagrams: invalid
              ? [{ index: 1, valid: false, error: 'Parse error' }]
              : [],
          }),
          stderr: '',
        };
      },
      agent: (name, input, count) => {
        if (name === 'refiner') return commentScope;
        if (name === 'deliverable-writer') {
          if (count === 2)
            expect(input.previous).toMatchObject({
              problems: ['Mermaid diagram 1: Parse error'],
            });
          return { body: count === 1 ? 'Broken diagram' : 'Valid diagram' };
        }
        if (name === 'deliverable-reviewer')
          return {
            assessments: [
              {
                criterion: 'Explain the architecture.',
                evidence: 'Verified',
                problems: [],
              },
            ],
            problems: [],
          };
        return;
      },
    });
    expect(await f.boot()).toMatchObject({
      status: 'finished',
      outcome: 'completed',
    });
    expect(
      f.calls.filter((c) => c.name === 'deliverable-reviewer'),
    ).toHaveLength(2);
    expect(f.trace.filter((t) => t.startsWith('comment:'))).toEqual([
      'comment:Valid diagram',
    ]);
  });
});
