import { createHmac } from 'node:crypto';
import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { LinearRunControl } from './control.js';
import type { AgentSessionEvent } from './events.js';
import { createLinearControlHandler } from './intake.js';
import { registerLinearWebhook } from './webhook.js';

it('routes a verified HTTP prompt and a local Answer through the same generation CAS', async () => {
  const values = new Map<string, unknown>();
  const control = new LinearRunControl({
    runId: 'FIXTURE-1-1',
    sessionId: 'session',
    issueId: 'issue',
    appUserId: 'app',
    runUrl: 'http://localhost:7625/runs/FIXTURE-1-1',
    store: {
      get: async (key) => structuredClone(values.get(key)),
      put: async (key, value) => {
        values.set(key, structuredClone(value));
      },
    },
    client: {
      ensureActivity: async ({ id }) => ({ id, success: true }),
      postActivity: async ({ id }) => ({
        id: id ?? 'ephemeral',
        success: true,
      }),
      session: async () => ({
        id: 'session',
        issueId: 'issue',
        appUserId: 'app',
        delegateId: 'app',
        dismissedAt: null,
        status: 'stale',
      }),
      activities: async () => [],
    },
    beforeElicitation: async () => undefined,
  });
  await control.checkpoint('0', {
    title: 'Approve?',
    body: 'Test only.',
    digest: { ci: 'passed', diffStat: '1 file', unresolved: 0 },
  });
  const checkpoint = (await control.waiting())!;
  const errors: string[] = [];
  const app = Fastify();
  const handler = createLinearControlHandler({
    appUserId: 'app',
    organizationId: 'org',
    find: async (sessionId) => (sessionId === 'session' ? control : undefined),
    created: async () => {
      throw new Error('not a delegation');
    },
  });
  await registerLinearWebhook(app, {
    webhookSecret: async () => 'fixture-secret',
    onEvent: handler,
    logError: (message) => {
      errors.push(message);
    },
  });
  try {
    const body = JSON.stringify({
      type: 'AgentSessionEvent',
      action: 'prompted',
      appUserId: 'app',
      organizationId: 'org',
      webhookTimestamp: Date.now(),
      agentSession: { id: 'session', issueId: 'issue' },
      agentActivity: {
        id: 'prompt-1',
        content: { type: 'prompt', body: checkpoint.approveValue },
        createdAt: new Date().toISOString(),
      },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/linear/webhook',
      payload: body,
      headers: {
        'content-type': 'application/json',
        'linear-signature': createHmac('sha256', 'fixture-secret')
          .update(body)
          .digest('hex'),
      },
    });
    expect(response.statusCode).toBe(200);
    await expect
      .poll(async () => (await control.waiting()) === undefined)
      .toBe(true);
    expect(
      await control.intake({
        source: 'local',
        id: 'answer-2',
        generation: checkpoint.generation,
        answer: { decision: 'reject' },
      }),
    ).toBe('already answered');
    expect(errors).toEqual([]);
    expect(
      await control.checkpoint('0', {
        title: 'ignored replay',
        body: '',
        digest: { ci: '', diffStat: '', unresolved: 0 },
      }),
    ).toEqual({ status: 'done', result: { decision: 'approve' } });
  } finally {
    await app.close();
  }
});

it('accepts only the installed app and workspace before routing created or prompted events', async () => {
  const created: string[] = [];
  const handler = createLinearControlHandler({
    appUserId: 'app',
    organizationId: 'org',
    find: async () => undefined,
    created: async (event) => {
      created.push(event.sessionId);
    },
  });
  const event: AgentSessionEvent = {
    action: 'created',
    sessionId: 'session',
    issueId: 'issue',
    appUserId: 'app',
    organizationId: 'org',
    payload: {} as AgentSessionEvent['payload'],
  };

  await handler(event);
  expect(created).toEqual(['session']);
  await expect(handler({ ...event, appUserId: 'other' })).rejects.toThrow(
    /installed app and workspace/,
  );
  await expect(handler({ ...event, organizationId: 'other' })).rejects.toThrow(
    /installed app and workspace/,
  );
  await expect(handler({ ...event, action: 'prompted' })).rejects.toThrow(
    /No Run owns Linear session/,
  );
});
