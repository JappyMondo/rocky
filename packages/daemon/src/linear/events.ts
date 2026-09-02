/**
 * The seam between Linear's webhook and Rocky's Run engine (NG-600).
 *
 * The Run engine does not exist yet — the journal is NG-596's, the Run states
 * are NG-540's — so the receiver delivers to this interface rather than to a
 * router. That is not a placeholder: it is the shape the router has to have
 * either way, because a wake-up must be indistinguishable to a Run whether it
 * arrived on the webhook or was found by boot reconciliation. NG-576 §6 is
 * explicit that the webhook is an optimisation and never the delivery
 * mechanism, so nothing downstream may depend on having been called from here.
 */
import type { AgentSessionEventWebhookPayload } from '@linear/sdk/webhooks';

/** The two actions Linear sends for an agent session. */
export type AgentSessionAction = 'created' | 'prompted';

/** A human's message into a live session, from a `prompted` event. */
export interface AgentPrompt {
  activityId: string;
  /** The human's words, verbatim. A Steer is delivered exactly as typed. */
  body?: string;
  /**
   * `stop` means halt immediately and emit one terminal activity; Linear's
   * Agent Interaction Guidelines require it. NG-576 §3 resolves a `stop` at a
   * Checkpoint as a reject.
   */
  signal?: string;
}

/**
 * One agent-session event, flattened to what a Run needs. The verified payload
 * rides along whole, so a later ticket can reach a field this shape has not
 * had to name yet without re-verifying anything.
 */
export interface AgentSessionEvent {
  action: AgentSessionAction;
  /**
   * The session id. Rocky must persist this per Run: there is no public query
   * mapping an issue back to its agent sessions (NG-567 §7), so losing it costs
   * the Run its only handle on the thread.
   */
  sessionId: string;
  issueId?: string;
  appUserId: string;
  organizationId: string;
  /** `created` only: Linear's pre-formatted issue, comments and guidance. */
  promptContext?: string;
  /** `prompted` only. */
  prompt?: AgentPrompt;
  payload: AgentSessionEventWebhookPayload;
}

/**
 * What the Run engine will implement. It is called after the response has
 * already been sent, so it may take as long as it needs — but a throw is only
 * logged, because a lost webhook costs latency and nothing else.
 */
export type AgentSessionEventHandler = (
  event: AgentSessionEvent,
) => void | Promise<void>;
