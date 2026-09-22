import { expect, it, vi } from 'vitest';
import { defaultFlowSettings } from '@rocky/local-contracts';
import type { WorkflowContext } from '@rocky/sdk';
import { createDeliveryOperations } from './delivery.js';
import type { DeliveryAgents } from './agents.js';

it('returns a recap audit finding to a Linear-comment deliverable writer', async () => {
  const visualRecap = vi
    .fn()
    .mockRejectedValueOnce(
      Object.assign(
        new Error('Visual recap failed its evidence audit after two passes.'),
        {
          name: 'RecapAuditError',
          problems: ['The overview diagram still gives the wrong path.'],
        },
      ),
    )
    .mockResolvedValue({ id: 'recap', url: 'http://rocky.test/recap' });
  const writer = vi
    .fn()
    .mockResolvedValueOnce({ body: 'Initial explanation.' })
    .mockResolvedValueOnce({ body: 'Corrected explanation.' });
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
    comment: vi.fn(),
    visualRecap,
    linear: { setState: vi.fn() },
  } as unknown as WorkflowContext;
  const agents = {
    call: vi.fn(async (role: string, options?: { input?: unknown }) => {
      if (role === 'refiner')
        return {
          status: 'clear',
          delivery: { kind: 'linear-comment', stateChanges: false },
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
  expect(writer).toHaveBeenCalledTimes(2);
  expect(writer.mock.calls[1][0]).toMatchObject({
    previous: {
      body: 'Initial explanation.',
      problems: ['The overview diagram still gives the wrong path.'],
    },
  });
  expect(ctx.comment).toHaveBeenCalledWith('Corrected explanation.');
});
