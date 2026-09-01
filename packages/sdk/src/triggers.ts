/**
 * Trigger builders (NG-580).
 *
 * A Trigger binds an event source to a Workflow. `workflow.ts` default-exports
 * a table of them, and the daemon learns the table by importing the module —
 * so these builders run at load time, outside any Run, with no `ctx`.
 *
 * They are therefore descriptors and nothing else: each returns a frozen plain
 * object and never calls the Workflow it is handed. Resolving a table, refusing
 * a delegation when no `linear.onDelegate` is registered, and rejecting
 * duplicate registrations are all the daemon's job.
 */
import type { Workflow } from './ctx.js';

export interface LinearDelegateTrigger {
  readonly kind: 'linear.onDelegate';
  readonly workflow: Workflow;
}

export interface ManualTrigger {
  readonly kind: 'manual';
  /** What a human names when firing it from the web UI or the CLI. */
  readonly name: string;
  readonly workflow: Workflow;
}

export type Trigger = LinearDelegateTrigger | ManualTrigger;

/** The table `.rocky/workflow.ts` default-exports. */
export type Triggers = readonly Trigger[];

export const linear = {
  /** Fires when a Linear issue routed to this repo is delegated to Rocky. */
  onDelegate(workflow: Workflow): LinearDelegateTrigger {
    return Object.freeze({ kind: 'linear.onDelegate' as const, workflow });
  },
};

/** Fires only when a human asks for it, from the web UI or `rocky trigger`. */
export function manual(name: string, workflow: Workflow): ManualTrigger {
  return Object.freeze({ kind: 'manual' as const, name, workflow });
}
