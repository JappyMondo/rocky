/**
 * AC3: a CLI/daemon version mismatch prints the exact upgrade hint, and
 * nothing auto-restarts.
 */
import { describe, expect, it, vi } from 'vitest';

import { DaemonClient } from './client.js';
import { versionMismatchHint } from './version-handshake.js';

describe('the hint', () => {
  it('is exactly the wording NG-578 pinned', () => {
    expect(versionMismatchHint('0.4.0', '0.5.1')).toBe(
      "daemon is v0.4.0, you're v0.5.1 — `rocky restart` to upgrade",
    );
  });

  it('is absent when the two agree', () => {
    expect(versionMismatchHint('0.5.1', '0.5.1')).toBeNull();
  });

  it('appears whichever side is behind', () => {
    expect(versionMismatchHint('0.6.0', '0.5.1')).toBe(
      "daemon is v0.6.0, you're v0.5.1 — `rocky restart` to upgrade",
    );
  });
});

/** A daemon that answers `/api/health` with the version it is told to claim. */
function daemonClaiming(version: string, warn: (m: string) => void) {
  const doFetch = vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ status: 'ok', version, web: true }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-rocky-version': version,
        },
      }),
  );

  return {
    doFetch,
    client: new DaemonClient({
      cliVersion: '0.5.1',
      warn,
      fetch: doFetch as unknown as typeof fetch,
    }),
  };
}

describe('the handshake on an API call', () => {
  it('warns when the daemon is a different version', async () => {
    const warn = vi.fn();
    const { client } = daemonClaiming('0.4.0', warn);

    await client.health();

    expect(warn).toHaveBeenCalledWith(
      "daemon is v0.4.0, you're v0.5.1 — `rocky restart` to upgrade",
    );
  });

  it('says nothing when they agree', async () => {
    const warn = vi.fn();
    const { client } = daemonClaiming('0.5.1', warn);

    await client.health();

    expect(warn).not.toHaveBeenCalled();
  });

  it('returns the response rather than restarting anything', async () => {
    const warn = vi.fn();
    const { client, doFetch } = daemonClaiming('0.4.0', warn);

    const health = await client.health();

    // One call out, and it is the health read — no restart, no second attempt.
    expect(health.status).toBe('ok');
    expect(doFetch).toHaveBeenCalledTimes(1);
    expect(doFetch.mock.calls[0][0]).toBe('http://127.0.0.1:7625/api/health');
  });

  it('sends the CLI version up on every request', async () => {
    const warn = vi.fn();
    const { client, doFetch } = daemonClaiming('0.5.1', warn);

    await client.health();

    const init = doFetch.mock.calls[0][1] as RequestInit;
    expect(
      (init.headers as Record<string, string>)['x-rocky-client-version'],
    ).toBe('0.5.1');
  });
});
