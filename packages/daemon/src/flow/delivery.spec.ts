import { expect, it, vi } from 'vitest';
import { defaultFlowSettings } from '@rocky/local-contracts';
import type { WorkflowContext } from '@rocky/sdk';
import { createDeliveryOperations } from './delivery.js';
import type { DeliveryAgents } from './agents.js';

it('confirms a Linear comment and closes the issue before the recap', async () => {
  const calls: string[] = [];
  const visualRecap = vi.fn(async () => {
    calls.push('recap');
    return { id: 'recap', url: 'http://rocky.test/recap' };
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
    defaultFlowSettings(),
    '/tmp/rocky-delivery-test/snapshot',
  );

  expect(await delivery('clarify', agents)).toBe('comment');
  expect(await delivery('deliverable', agents)).toBe('completed');
  expect(writer).toHaveBeenCalledTimes(1);
  expect(ctx.comment).toHaveBeenCalledWith('Explanation.');
  expect(ctx.linear.setState).toHaveBeenCalledWith('Done');
  expect(calls).toEqual(['state', 'comment', 'state', 'recap']);
});
