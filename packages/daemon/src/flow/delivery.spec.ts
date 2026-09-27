import { expect, it, vi } from 'vitest';
import { defaultFlowSettings } from '@rocky/local-contracts';
import type { VisualRecapResult, WorkflowContext } from '@rocky/sdk';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBoot } from '../run/replay.js';
import { createDeliveryOperations, uiReadiness } from './delivery.js';
import type { DeliveryAgents } from './agents.js';

it('replays a pre-change UI receipt on a CI poll without probing its stopped service', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rocky-ui-poll-'));
  let serviceRunning = true;
  const fetcher = vi.fn(async () => {
    if (!serviceRunning)
      throw new Error('The service stopped while CI waited.');
    return new Response('', { status: 200 });
  });
  vi.stubGlobal('fetch', fetcher);
  let ciCalls = 0;
  try {
    const boot = (poll: boolean) =>
      runBoot({
        journalPath: join(directory, 'journal.jsonl'),
        poll,
        workflow: async (runner) => {
          const ctx = {
            polling: runner.polling,
            ports: [4200],
            step: <T>(label: string, work: () => T | Promise<T>) =>
              runner.step('step', { label }, async () => ({
                status: 'done',
                result: await work(),
              })),
          } as Pick<WorkflowContext, 'step' | 'polling' | 'ports'>;
          if (poll) {
            const replayed = await uiReadiness(
              ctx,
              { kind: 'fixed', url: 'http://127.0.0.1:4200/' },
              directory,
              join(directory, 'service.log'),
              { attempts: 1, intervalMs: 1 },
              1,
            );
            expect(replayed).toMatchObject({
              ready: true,
              boot: { ready: true },
            });
          } else {
            // The first Boot uses the receipt format written before this fix.
            await ctx.step('UI readiness 1/1', async () => ({
              ready: (await fetch('http://127.0.0.1:4200/')).ok,
              log: '',
            }));
          }
          await runner.step('scm:waitForCi', {}, async () =>
            ++ciCalls === 1
              ? { status: 'waiting' }
              : { status: 'done', result: null },
          );
          return 'merged';
        },
      });
    expect(await boot(false)).toMatchObject({
      status: 'parked',
      reason: 'scm:waitForCi',
    });
    serviceRunning = false;
    expect(await boot(true)).toMatchObject({ status: 'ready' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(ciCalls).toBe(2);
  } finally {
    vi.unstubAllGlobals();
    await rm(directory, { recursive: true, force: true });
  }
});

it('confirms a Linear comment and closes the issue before the recap', async () => {
  const calls: string[] = [];
  const visualRecap = vi.fn(async (): Promise<VisualRecapResult> => {
    calls.push('recap');
    return {
      id: 'recap',
      url: 'http://rocky.test/recap',
      decision: {
        status: 'ready' as const,
        summary: 'Delivered.',
        actions: [],
      },
    };
  });
  const writer = vi.fn().mockResolvedValue({ body: 'Explanation.' });
  const ctx = {
    issue: {
      identifier: 'TEST-1',
      title: 'Explain the change',
      description: '',
      url: 'http://linear.test/TEST-1',
      labels: [],
    },
    stage: vi.fn(),
    parallel: async <T, R>(items: T[], work: (item: T) => Promise<R>) =>
      Promise.all(items.map(work)),
    exec: vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ ok: true, rendered: false, diagrams: [] }),
      stderr: '',
    }),
    post: vi.fn(),
    comment: vi.fn(async () => {
      calls.push('comment');
    }),
    visualRecap,
    step: vi.fn(async (_label: string, fn: () => Promise<unknown>) => fn()),
    linear: {
      setState: vi.fn(async () => {
        calls.push('state');
      }),
    },
  } as unknown as WorkflowContext;
  const agents = {
    call: vi.fn(async (role: string, options?: { input?: unknown }) => {
      if (role === 'refiner')
        return {
          status: 'clear',
          delivery: { kind: 'linear-comment', stateChanges: true },
          scope: 'Explain the change.',
          decisions: [],
          acceptanceCriteria: [],
          outOfScope: [],
        };
      if (role === 'deliverable-writer') return writer(options?.input);
      if (role === 'deliverable-reviewer')
        return { problems: [], assessments: [] };
      throw new Error(`Unexpected role: ${role}`);
    }),
    recap: vi.fn(() => ({})),
  } as unknown as DeliveryAgents;
  const delivery = createDeliveryOperations(
    ctx,
    { members: [] },
    { ...defaultFlowSettings(), commentDeliveryVersion: 1 },
    '/tmp/rocky-delivery-test/snapshot',
  );

  expect(await delivery('clarify', agents)).toBe('comment');
  expect(await delivery('deliverable', agents)).toBe('completed');
  expect(writer).toHaveBeenCalledTimes(1);
  expect(ctx.comment).toHaveBeenCalledWith('Explanation.');
  expect(ctx.linear.setState).toHaveBeenCalledWith('Done');
  expect(ctx.comment).toHaveBeenNthCalledWith(
    1,
    expect.stringContaining('Scope decision record'),
  );
  expect(calls).toEqual(['comment', 'state', 'comment', 'recap', 'state']);

  // A new journal may resume inside recap generation after the comment and
  // state change were already recorded. Its next Step is still reviewReport.*.
  Object.assign(ctx, {
    replaying: true,
    replayStep: 'reviewReport.save',
    replayedStep: (key: string) => key === 'linear.comment',
  });
  calls.length = 0;
  expect(await delivery('deliverable', agents)).toBe('completed');
  expect(calls).toEqual(['comment', 'recap', 'state']);

  // A recorded run that already saved its recap must finish its old order.
  // Reordering its next comment Step would make its journal diverge.
  const oldSettings = defaultFlowSettings();
  delete oldSettings.commentDeliveryVersion;
  const oldDelivery = createDeliveryOperations(
    ctx,
    { members: [] },
    oldSettings,
    '/tmp/rocky-delivery-test/snapshot',
  );
  Object.assign(ctx, {
    replaying: true,
    replayStep: 'linear.comment',
    replayedStep: (key: string) => key === 'reviewReport.save',
  });
  calls.length = 0;
  expect(await oldDelivery('clarify', agents)).toBe('comment');
  calls.length = 0;
  expect(await oldDelivery('deliverable', agents)).toBe('completed');
  expect(calls).toEqual(['recap', 'comment', 'state']);
  expect(ctx.linear.setState).toHaveBeenCalledWith('In Review');

  Object.assign(ctx, { replaying: false });
  calls.length = 0;
  visualRecap.mockRejectedValueOnce(new Error('Recap audit failed'));
  await expect(delivery('deliverable', agents)).rejects.toThrow(
    'Recap audit failed',
  );
  expect(calls).toEqual(['comment']);
  expect(visualRecap).toHaveBeenCalledTimes(4);
  expect(writer).toHaveBeenCalledTimes(4);

  visualRecap.mockImplementationOnce(async () => {
    calls.push('recap');
    return {
      id: 'attention',
      url: 'http://rocky.test/attention',
      decision: {
        status: 'needs-attention',
        summary: 'The issue remains open.',
        actions: ['Verify closure.'],
      },
    };
  });
  calls.length = 0;
  const stateCallsBeforeAttention = vi.mocked(ctx.linear.setState).mock.calls
    .length;
  expect(await delivery('deliverable', agents)).toBe('exhausted');
  expect(calls).toEqual(['comment', 'recap']);
  expect(ctx.linear.setState).toHaveBeenCalledTimes(stateCallsBeforeAttention);
  expect(ctx.post).toHaveBeenCalledWith(
    expect.stringContaining('Verify closure.'),
  );
});
