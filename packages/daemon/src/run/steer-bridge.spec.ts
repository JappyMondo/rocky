import { expect, it, vi } from 'vitest';
import type { AgentContinuation } from './agent.js';
import { createAgentSteerBridge } from './steer-bridge.js';
import type { BootRequest } from './worker.js';

const conversation: AgentContinuation = {
  identity: '3/0/2',
  label: 'implementer',
  group: '3',
  steer: async () => undefined,
};

it('maps a parent-owned Steer batch onto one durable Agent continuation', async () => {
  const request = vi.fn(async (message: BootRequest) => {
    if (message.kind === 'agent-steer-take') {
      return {
        ids: ['linear:activity-1', 'local:request-2'],
        message: 'Keep the existing branch.',
      };
    }
    return undefined;
  });
  const bridge = createAgentSteerBridge(request);
  const unregister = await bridge.register(conversation);
  if (!bridge.take || !bridge.delivered) {
    throw new Error(
      'Agent Steer bridge must support taking and acknowledging turns',
    );
  }
  const turns = await bridge.take(conversation);
  expect(turns).toEqual([
    {
      id: '["linear:activity-1","local:request-2"]',
      ids: ['linear:activity-1', 'local:request-2'],
      note: 'Keep the existing branch.',
    },
  ]);
  await bridge.delivered(conversation, turns);
  await unregister();
  expect(request.mock.calls.map(([message]) => message)).toEqual([
    {
      kind: 'agent-steer-open',
      stepKey: '3/0/2',
      label: 'implementer',
      group: '3',
    },
    { kind: 'agent-steer-take', stepKey: '3/0/2' },
    {
      kind: 'agent-steer-delivered',
      stepKey: '3/0/2',
      ids: ['linear:activity-1', 'local:request-2'],
    },
    { kind: 'agent-steer-close', stepKey: '3/0/2' },
  ]);
});

it('refuses malformed parent Steer batches before they reach an Agent', async () => {
  const bridge = createAgentSteerBridge(async () => ({ ids: [], message: 42 }));
  if (!bridge.take) {
    throw new Error('Agent Steer bridge must support taking turns');
  }
  await expect(bridge.take(conversation)).rejects.toThrow(
    'Parent returned an invalid Agent Steer batch',
  );
});
