/**
 * AC3: a webhook with a bad signature is rejected; a valid `prompted` event
 * reaches the Run router.
 *
 * The router is the `AgentSessionEventHandler` seam (see `events.ts`), so the
 * assertion is that a verified event arrives there intact.
 */
import { createHmac } from 'node:crypto';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentSessionEvent } from './events.js';
import { registerLinearWebhook } from './webhook.js';

const SECRET = 'whsec-testing';

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

function sign(body: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

function agentSessionEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: 'AgentSessionEvent',
    action: 'prompted',
    createdAt: new Date().toISOString(),
    webhookId: 'wh-1',
    webhookTimestamp: Date.now(),
    appUserId: 'app-user-1',
    oauthClientId: 'oauth-1',
    organizationId: 'org-1',
    agentSession: {
      id: 'sess-1',
      appUserId: 'app-user-1',
      organizationId: 'org-1',
      issueId: 'issue-1',
      status: 'active',
      type: 'commentThread',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    agentActivity: {
      id: 'act-1',
      agentSessionId: 'sess-1',
      content: { type: 'prompt', body: 'try the other approach' },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      userId: 'human-1',
      user: { id: 'human-1' },
    },
    ...overrides,
  };
}

interface Harness {
  received: AgentSessionEvent[];
  post(body: unknown, options?: { signature?: string }): Promise<Response>;
  url: string;
}

async function startReceiver(
  options: {
    webhookSecret?: string | undefined;
    onEvent?: (event: AgentSessionEvent) => void | Promise<void>;
    logError?: (message: string) => void;
  } = {},
): Promise<Harness> {
  const received: AgentSessionEvent[] = [];

  app = Fastify();
  await registerLinearWebhook(app, {
    webhookSecret: async () =>
      'webhookSecret' in options ? options.webhookSecret : SECRET,
    onEvent:
      options.onEvent ??
      ((event) => {
        received.push(event);
      }),
    logError: options.logError,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });

  const address = app.server.address();
  const url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/api/linear/webhook`;

  return {
    received,
    url,
    post: (body, postOptions = {}) => {
      const raw = JSON.stringify(body);
      return fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'linear-signature': postOptions.signature ?? sign(raw),
        },
        body: raw,
      });
    },
  };
}

/** The handler runs after the response, so a test has to let the tick land. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('a webhook with a bad signature', () => {
  it('is rejected and never reaches the Run router', async () => {
    const harness = await startReceiver();

    const response = await harness.post(agentSessionEvent(), {
      signature: sign(JSON.stringify(agentSessionEvent()), 'the-wrong-secret'),
    });
    await settle();

    expect(response.status).toBe(401);
    expect(harness.received).toEqual([]);
  });

  it('is rejected when the body was tampered with after signing', async () => {
    const harness = await startReceiver();
    const signed = JSON.stringify(agentSessionEvent());

    const response = await fetch(harness.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'linear-signature': sign(signed),
      },
      body: signed.replace('sess-1', 'sess-2'),
    });
    await settle();

    expect(response.status).toBe(401);
    expect(harness.received).toEqual([]);
  });

  it('is rejected when the body is not JSON, signature or no signature', async () => {
    const harness = await startReceiver();
    const raw = 'not json at all';

    const response = await fetch(harness.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'linear-signature': sign(raw),
      },
      body: raw,
    });
    await settle();

    expect(response.status).toBe(401);
    expect(harness.received).toEqual([]);
  });

  it('is rejected when the signature header is missing entirely', async () => {
    const harness = await startReceiver();

    const response = await fetch(harness.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(agentSessionEvent()),
    });

    expect(response.status).toBe(401);
    expect(harness.received).toEqual([]);
  });

  it('is rejected when it is a replay from outside the timestamp window', async () => {
    const harness = await startReceiver();

    const response = await harness.post(
      agentSessionEvent({ webhookTimestamp: Date.now() - 10 * 60 * 1000 }),
    );
    await settle();

    expect(response.status).toBe(401);
    expect(harness.received).toEqual([]);
  });
});

describe('a valid prompted event', () => {
  it('reaches the Run router with the human`s words intact', async () => {
    const harness = await startReceiver();

    const response = await harness.post(agentSessionEvent());
    await settle();

    expect(response.status).toBe(200);
    expect(harness.received).toHaveLength(1);

    const event = harness.received[0];
    expect(event.action).toBe('prompted');
    expect(event.sessionId).toBe('sess-1');
    expect(event.issueId).toBe('issue-1');
    expect(event.appUserId).toBe('app-user-1');
    expect(event.prompt).toEqual({
      activityId: 'act-1',
      body: 'try the other approach',
      signal: undefined,
    });
  });

  it('carries a stop signal through, which a Run must honour', async () => {
    const harness = await startReceiver();

    await harness.post(
      agentSessionEvent({
        agentActivity: {
          id: 'act-2',
          agentSessionId: 'sess-1',
          content: { type: 'prompt', body: 'stop' },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          userId: 'human-1',
          user: { id: 'human-1' },
          signal: 'stop',
        },
      }),
    );
    await settle();

    expect(harness.received[0].prompt?.signal).toBe('stop');
  });
});

describe('a valid created event', () => {
  it('reaches the Run router with Linear`s prompt context', async () => {
    const harness = await startReceiver();

    await harness.post(
      agentSessionEvent({
        action: 'created',
        agentActivity: undefined,
        promptContext: '<issue identifier="NG-600">…</issue>',
      }),
    );
    await settle();

    const event = harness.received[0];
    expect(event.action).toBe('created');
    expect(event.promptContext).toBe('<issue identifier="NG-600">…</issue>');
    expect(event.prompt).toBeUndefined();
  });
});

describe('the response', () => {
  it('is sent before the router runs, so a slow Run never fails a delivery', async () => {
    let releaseHandler: () => void = () => undefined;
    const handlerRan = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });

    const harness = await startReceiver({
      onEvent: async () => {
        await handlerRan;
      },
    });

    // Linear disables a webhook whose receiver keeps taking longer than 5s, so
    // this resolving while the handler is still parked is the whole point.
    const response = await harness.post(agentSessionEvent());
    expect(response.status).toBe(200);

    releaseHandler();
  });

  it('is still a 200 when the router throws, because a retry would not help', async () => {
    const logError = vi.fn();
    const harness = await startReceiver({
      onEvent: () => {
        throw new Error('the run engine fell over');
      },
      logError,
    });

    const response = await harness.post(agentSessionEvent());
    await settle();

    expect(response.status).toBe(200);
    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining('the run engine fell over'),
    );
  });
});

describe('events Rocky does not act on', () => {
  it('are acknowledged rather than retried', async () => {
    const harness = await startReceiver();

    const response = await harness.post({
      type: 'PermissionChange',
      action: 'teamAccessChanged',
      createdAt: new Date().toISOString(),
      webhookTimestamp: Date.now(),
      webhookId: 'wh-2',
      organizationId: 'org-1',
    });
    await settle();

    expect(response.status).toBe(200);
    expect(harness.received).toEqual([]);
  });

  it('include agent-session actions beyond created and prompted', async () => {
    const harness = await startReceiver();

    const response = await harness.post(
      agentSessionEvent({ action: 'somethingNew' }),
    );
    await settle();

    expect(response.status).toBe(200);
    expect(harness.received).toEqual([]);
  });
});

describe('a daemon that has not been set up', () => {
  it('says so rather than pretending the delivery succeeded', async () => {
    const harness = await startReceiver({ webhookSecret: undefined });

    const response = await harness.post(agentSessionEvent());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: 'Rocky has no Linear webhook secret yet — run `rocky setup`.',
    });
  });
});

describe('the rest of the daemon', () => {
  it('still parses JSON bodies as objects, not as the webhook`s raw buffer', async () => {
    app = Fastify();
    await registerLinearWebhook(app, {
      webhookSecret: async () => SECRET,
      onEvent: () => undefined,
    });
    app.post('/api/echo', async (request) => request.body);
    await app.listen({ host: '127.0.0.1', port: 0 });

    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const response = await fetch(`http://127.0.0.1:${port}/api/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    });

    expect(await response.json()).toEqual({ hello: 'world' });
  });
});
