import type { AgentSteerRegistry } from './agent.js';
import type { BootRequest } from './worker.js';

type Request = (request: BootRequest) => Promise<unknown>;

function steerBatch(
  value: unknown,
): { ids: string[]; message: string } | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object')
    throw new Error('Parent returned an invalid Agent Steer batch');
  const candidate = value as { ids?: unknown; message?: unknown };
  if (
    !Array.isArray(candidate.ids) ||
    candidate.ids.length === 0 ||
    !candidate.ids.every((id) => typeof id === 'string' && id.length > 0) ||
    typeof candidate.message !== 'string'
  ) {
    throw new Error('Parent returned an invalid Agent Steer batch');
  }
  return { ids: [...candidate.ids], message: candidate.message };
}

/** Child-side adapter over the parent-owned Linear control service. */
export function createAgentSteerBridge(request: Request): AgentSteerRegistry {
  return {
    async register(handle) {
      await request({
        kind: 'agent-steer-open',
        stepKey: handle.identity,
        label: handle.label,
        ...(handle.group === undefined ? {} : { group: handle.group }),
      });
      return async () => {
        await request({ kind: 'agent-steer-close', stepKey: handle.identity });
      };
    },
    async take(handle) {
      const batch = steerBatch(
        await request({ kind: 'agent-steer-take', stepKey: handle.identity }),
      );
      return batch
        ? [
            {
              id: JSON.stringify(batch.ids),
              ids: batch.ids,
              note: batch.message,
            },
          ]
        : [];
    },
    async delivered(handle, turns) {
      for (const turn of turns) {
        await request({
          kind: 'agent-steer-delivered',
          stepKey: handle.identity,
          ids: turn.ids ?? [turn.id],
        });
      }
    },
  };
}
