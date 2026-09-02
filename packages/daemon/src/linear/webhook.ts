/**
 * The webhook receiver for agent-session events (NG-600).
 *
 * Two of Linear's numbers shape this route (NG-567 §7). The receiver has
 * **5 seconds** to answer, and a delivery that fails is retried after 1 minute,
 * then 1 hour, then 6 hours, after which Linear may disable the webhook
 * outright. So the response goes out before the Run engine is touched, and the
 * engine throwing does not turn into a non-200: a webhook is an optimisation
 * (NG-576 §6), and re-delivering it six hours later helps nobody, while a
 * disabled webhook is the one endpoint failure Rocky cannot recover from.
 *
 * Verification is `@linear/sdk`'s `LinearWebhooks.parseData`, which does the
 * documented thing — HMAC-SHA256 over the **raw** body, compared in constant
 * time, plus the replay window on the timestamp. The raw body is why this route
 * gets its own content-type parser: re-stringifying a parsed body changes the
 * bytes and with them the signature.
 */
import { LinearWebhooks } from '@linear/sdk';
import type { AgentSessionEventWebhookPayload } from '@linear/sdk/webhooks';
import type { FastifyInstance } from 'fastify';

import type {
  AgentSessionAction,
  AgentSessionEvent,
  AgentSessionEventHandler,
} from './events.js';
import { WEBHOOK_PATH } from './manifest.js';

/** Linear's header, lower-cased as Node delivers it. */
const SIGNATURE_HEADER = 'linear-signature';

/** The two actions Rocky acts on. Anything else is acknowledged and dropped. */
const HANDLED_ACTIONS: readonly string[] = [
  'created',
  'prompted',
] satisfies readonly AgentSessionAction[];

export interface LinearWebhookOptions {
  /**
   * Read on demand rather than captured: `credentials.json` is re-read on
   * demand by design (NG-578), so a `rocky setup` run while the daemon is up
   * takes effect on the next delivery.
   */
  webhookSecret(): Promise<string | undefined>;
  /** The Run router. See `events.ts` for why this is a seam. */
  onEvent: AgentSessionEventHandler;
  logError?(message: string): void;
}

interface RawWebhookBody {
  type?: string;
  action?: string;
  agentSession?: { id?: string; issueId?: string };
  agentActivity?: {
    id?: string;
    content?: { body?: unknown };
    signal?: string;
  };
  appUserId?: string;
  organizationId?: string;
  promptContext?: string;
  webhookTimestamp?: number;
}

/**
 * `webhookTimestamp` out of the unverified bytes, purely so it can be handed
 * back for the replay check. `undefined` leaves `parseData` to reject the
 * delivery on the signature alone.
 */
function timestampOf(raw: Buffer): number | undefined {
  try {
    const parsed = JSON.parse(raw.toString('utf8')) as RawWebhookBody;
    return typeof parsed.webhookTimestamp === 'number'
      ? parsed.webhookTimestamp
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Flattens a verified payload into what a Run needs, keeping the whole payload
 * so a later ticket can reach a field this shape has not had to name yet.
 */
function toEvent(body: RawWebhookBody): AgentSessionEvent | undefined {
  const sessionId = body.agentSession?.id;
  if (!sessionId || !HANDLED_ACTIONS.includes(body.action ?? '')) {
    return undefined;
  }

  const activity = body.agentActivity;

  return {
    action: body.action as AgentSessionAction,
    sessionId,
    issueId: body.agentSession?.issueId,
    appUserId: body.appUserId ?? '',
    organizationId: body.organizationId ?? '',
    promptContext: body.promptContext,
    prompt:
      body.action === 'prompted' && activity?.id
        ? {
            activityId: activity.id,
            body:
              typeof activity.content?.body === 'string'
                ? activity.content.body
                : undefined,
            signal: activity.signal,
          }
        : undefined,
    payload: body as unknown as AgentSessionEventWebhookPayload,
  };
}

export async function registerLinearWebhook(
  app: FastifyInstance,
  options: LinearWebhookOptions,
): Promise<void> {
  const logError =
    options.logError ?? ((message: string) => app.log.error(message));

  // Encapsulated, so the raw-buffer parser applies to this route and leaves the
  // rest of the API parsing JSON into objects as usual.
  await app.register(async (scope) => {
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (_request, body, done) => {
        done(null, body);
      },
    );

    scope.post(WEBHOOK_PATH, async (request, reply) => {
      const secret = await options.webhookSecret();
      if (!secret) {
        return reply.status(503).send({
          error: 'Rocky has no Linear webhook secret yet — run `rocky setup`.',
        });
      }

      const signature = request.headers[SIGNATURE_HEADER];
      const raw = request.body;
      if (typeof signature !== 'string' || !Buffer.isBuffer(raw)) {
        return reply.status(401).send({ error: 'Invalid webhook signature' });
      }

      let body: RawWebhookBody;
      try {
        // The timestamp has to be handed over explicitly — `parseData` skips
        // the replay check without it, and skipping it would accept a captured
        // delivery replayed days later, signature and all. Reading it means
        // parsing the body before verifying, which is safe: nothing is trusted
        // until `parseData` returns, and it parses the raw bytes itself.
        body = new LinearWebhooks(secret).parseData(
          raw,
          signature,
          timestampOf(raw),
        ) as RawWebhookBody;
      } catch {
        // Deliberately no detail: the only reader of a rejection is whoever
        // sent it, and it is not Linear.
        return reply.status(401).send({ error: 'Invalid webhook signature' });
      }

      const event =
        body.type === 'AgentSessionEvent' ? toEvent(body) : undefined;

      // 200 first. The handler runs after the reply is on the wire, so a Run
      // that takes a minute to wake cannot cost Rocky the delivery.
      void reply.status(200).send({ ok: true });

      if (event) {
        void Promise.resolve()
          .then(() => options.onEvent(event))
          .catch((error: unknown) => {
            logError(
              `the Linear webhook for session ${event.sessionId} could not be handled — ${String(error)}. Boot reconciliation will pick it up.`,
            );
          });
      }

      return reply;
    });
  });
}
