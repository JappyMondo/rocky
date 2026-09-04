/**
 * The self-ping against a real daemon, end to end (AC4).
 *
 * The "public URL" here is the daemon's own loopback address, which is exactly
 * what a working tunnel amounts to: a round trip that leaves and comes back.
 * Killing it is then a matter of pointing the URL somewhere dead.
 */
import { createHmac } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { startDaemon, type RunningDaemon } from '../server.js';
import type { HealthStatus } from '../server.js';

let daemon: RunningDaemon | undefined;

afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
});

async function health(url: string): Promise<HealthStatus> {
  return (await (await fetch(`${url}/api/health`)).json()) as HealthStatus;
}

/**
 * The public URL cannot be known until the daemon has bound a port, and the
 * daemon needs the URL at construction — so it is read through a box the test
 * fills in afterwards. Standing in for a tunnel, that is exactly right: the
 * tunnel's address is decided elsewhere and can change under a running daemon.
 */
function endpointBox(): { url: string | undefined } {
  return { url: undefined };
}

describe('a daemon reachable through its public URL', () => {
  it('pings itself on boot and reports the endpoint healthy', async () => {
    const endpoint = endpointBox();
    daemon = await startDaemon({
      port: 0,
      webRoot: false,
      publicUrl: () => endpoint.url,
    });
    endpoint.url = daemon.url;

    expect(await daemon.endpoint.check()).toMatchObject({
      configured: true,
      ok: true,
    });
    expect((await health(daemon.url)).endpoint.ok).toBe(true);
  });

  it('answers the ping with its own instance id and nothing else', async () => {
    daemon = await startDaemon({
      port: 0,
      webRoot: false,
      instanceId: 'instance-under-test',
    });

    const response = await fetch(`${daemon.url}/api/ping`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      instanceId: 'instance-under-test',
    });
  });
});

describe('killing the tunnel', () => {
  it('turns the endpoint flag off, with the reason on it', async () => {
    const endpoint = endpointBox();
    daemon = await startDaemon({
      port: 0,
      webRoot: false,
      publicUrl: () => endpoint.url,
    });
    endpoint.url = daemon.url;

    await daemon.endpoint.check();
    expect((await health(daemon.url)).endpoint.ok).toBe(true);

    // The tunnel dies: the public URL now resolves to nothing listening.
    endpoint.url = 'http://127.0.0.1:1';
    await daemon.endpoint.check();

    const after = (await health(daemon.url)).endpoint;
    expect(after).toMatchObject({ configured: true, ok: false });
    expect(after.detail).toBeTruthy();
    // The daemon itself is untouched — a dead endpoint costs latency, not the
    // local API, and nothing was restarted to make that true.
    expect((await fetch(`${daemon.url}/api/ping`)).status).toBe(200);
  });

  it('is caught even when the URL answers 200 from another machine', async () => {
    const other = await startDaemon({ port: 0, webRoot: false });
    try {
      daemon = await startDaemon({
        port: 0,
        webRoot: false,
        publicUrl: () => other.url,
      });

      await daemon.endpoint.check();

      const endpoint = (await health(daemon.url)).endpoint;
      expect(endpoint.ok).toBe(false);
      expect(endpoint.detail).toMatch(/another daemon/);
    } finally {
      await other.close();
    }
  });
});

describe('the webhook on a daemon nobody wired up', () => {
  it('says Rocky is not set up rather than accepting the delivery', async () => {
    daemon = await startDaemon({ port: 0, webRoot: false });

    const response = await fetch(`${daemon.url}/api/linear/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'linear-signature': 'whatever',
      },
      body: JSON.stringify({ type: 'AgentSessionEvent' }),
    });

    expect(response.status).toBe(503);
  });

  it('accepts a verified event with no Run engine behind it', async () => {
    // The seam's default is a no-op, so a daemon started before the Run engine
    // exists still answers Linear correctly instead of failing the delivery.
    daemon = await startDaemon({
      port: 0,
      webRoot: false,
      webhookSecret: async () => 'whsec-testing',
    });

    const body = JSON.stringify({
      type: 'AgentSessionEvent',
      action: 'prompted',
      webhookTimestamp: Date.now(),
      appUserId: 'app-user-1',
      organizationId: 'org-1',
      agentSession: { id: 'sess-1', issueId: 'issue-1' },
      agentActivity: { id: 'act-1', content: { type: 'prompt', body: 'hi' } },
    });

    const response = await fetch(`${daemon.url}/api/linear/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'linear-signature': createHmac('sha256', 'whsec-testing')
          .update(body)
          .digest('hex'),
      },
      body,
    });

    expect(response.status).toBe(200);
  });
});

describe('the OAuth callback', () => {
  it('hands the code to whoever is waiting for that state', async () => {
    daemon = await startDaemon({ port: 0, webRoot: false });

    const waiting = daemon.oauth.expect('state-1');
    const response = await fetch(
      `${daemon.url}/api/linear/oauth/callback?code=the-code&state=state-1`,
    );

    expect(response.status).toBe(200);
    expect(await waiting).toBe('the-code');
  });

  it('refuses a callback nobody asked for', async () => {
    daemon = await startDaemon({ port: 0, webRoot: false });

    const response = await fetch(
      `${daemon.url}/api/linear/oauth/callback?code=x&state=unknown`,
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain('rocky setup');
  });

  it('passes Linear`s refusal back to the waiting wizard', async () => {
    daemon = await startDaemon({ port: 0, webRoot: false });

    // Asserted before the callback arrives: the wizard is already awaiting
    // this promise when Linear answers, and attaching afterwards would leave
    // the rejection briefly unhandled.
    const waiting = expect(daemon.oauth.expect('state-2')).rejects.toThrow(
      /access_denied/,
    );
    await fetch(
      `${daemon.url}/api/linear/oauth/callback?error=access_denied&state=state-2`,
    );

    await waiting;
  });
});
