import type { LinearRunControl } from './control.js';
import type { AgentSessionEventHandler } from './events.js';

export interface LinearControlHandlerOptions {
  appUserId: string;
  organizationId: string;
  /** NG-598's persisted session-to-Run association, including queued Runs. */
  find(sessionId: string): Promise<LinearRunControl | undefined>;
  /** Acknowledge before slow loading; execution owns admission and Refusals. */
  created: AgentSessionEventHandler;
}

export function createLinearControlHandler(
  options: LinearControlHandlerOptions,
): AgentSessionEventHandler {
  return async (event) => {
    if (
      event.appUserId !== options.appUserId ||
      event.organizationId !== options.organizationId
    ) {
      throw new Error(
        'Linear event does not belong to this installed app and workspace',
      );
    }
    if (event.action === 'created') {
      await options.created(event);
      return;
    }
    const control = await options.find(event.sessionId);
    if (!control)
      throw new Error(
        `No Run owns Linear session ${event.sessionId}; recover the persisted session association`,
      );
    await control.prompted(event);
  };
}
