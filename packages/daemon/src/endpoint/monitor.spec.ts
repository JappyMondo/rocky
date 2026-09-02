/**
 * AC4: killing the tunnel triggers the hourly ping's failure path — a log line
 * and a flag the web UI banners and `rocky status` warns from. No
 * auto-remediation: NG-578 rejected a managed tunnel process outright, so the
 * only thing a failure does is become visible.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PING_PATH,
  SELF_PING_INTERVAL_MS,
  createEndpointMonitor,
} from './monitor.js';

const INSTANCE = 'instance-abc';

function pingResponse(instanceId: string, status = 200): Response {
  return new Response(JSON.stringify({ instanceId }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('an endpoint that is not configured', () => {
  it('is not a failure — it is a machine that has not run `rocky setup`', async () => {
    const doFetch = vi.fn();
    const monitor = createEndpointMonitor({
      publicUrl: () => undefined,
      instanceId: INSTANCE,
      fetch: doFetch as unknown as typeof fetch,
    });

    await monitor.check();

    expect(monitor.health).toEqual({ configured: false, ok: false });
    expect(doFetch).not.toHaveBeenCalled();
  });
});

describe('a live endpoint', () => {
  it('is pinged through the public URL, not through the loopback bind', async () => {
    const doFetch = vi.fn(async () => pingResponse(INSTANCE));
    const monitor = createEndpointMonitor({
      publicUrl: () => 'https://rocky.example.com',
      instanceId: INSTANCE,
      fetch: doFetch as unknown as typeof fetch,
      now: () => new Date('2026-09-02T10:00:00.000Z').getTime(),
    });

    await monitor.check();

    expect(doFetch).toHaveBeenCalledWith(
      `https://rocky.example.com${PING_PATH}`,
      expect.anything(),
    );
    expect(monitor.health).toEqual({
      configured: true,
      ok: true,
      checkedAt: '2026-09-02T10:00:00.000Z',
    });
  });
});

describe('a dead endpoint', () => {
  it('records the failure and logs it once', async () => {
    const logWarn = vi.fn();
    const monitor = createEndpointMonitor({
      publicUrl: () => 'https://rocky.example.com',
      instanceId: INSTANCE,
      fetch: (async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch,
      logWarn,
    });

    await monitor.check();

    expect(monitor.health.configured).toBe(true);
    expect(monitor.health.ok).toBe(false);
    expect(monitor.health.detail).toContain('ECONNREFUSED');
    expect(logWarn).toHaveBeenCalledWith(
      expect.stringContaining('https://rocky.example.com'),
    );
  });

  it('never tries to fix it — a dead endpoint costs latency, not correctness', async () => {
    const doFetch = vi.fn(async () => {
      throw new Error('down');
    });
    const monitor = createEndpointMonitor({
      publicUrl: () => 'https://rocky.example.com',
      instanceId: INSTANCE,
      fetch: doFetch as unknown as typeof fetch,
      logWarn: vi.fn(),
    });

    await monitor.check();

    // One ping, one failure, nothing else. No retry storm, no tunnel restart.
    expect(doFetch).toHaveBeenCalledTimes(1);
  });

  it('reports a non-200 as a failure', async () => {
    const monitor = createEndpointMonitor({
      publicUrl: () => 'https://rocky.example.com',
      instanceId: INSTANCE,
      fetch: (async () =>
        new Response('gone', { status: 502 })) as unknown as typeof fetch,
      logWarn: vi.fn(),
    });

    await monitor.check();

    expect(monitor.health.ok).toBe(false);
    expect(monitor.health.detail).toContain('502');
  });

  it('reports a URL fronted by something that is not Rocky at all', async () => {
    const monitor = createEndpointMonitor({
      publicUrl: () => 'https://rocky.example.com',
      instanceId: INSTANCE,
      // A tunnel provider's own "not configured" page, say: a cheerful 200
      // that is not JSON.
      fetch: (async () =>
        new Response('<html>tunnel not found</html>', {
          status: 200,
        })) as unknown as typeof fetch,
      logWarn: vi.fn(),
    });

    await monitor.check();

    expect(monitor.health.ok).toBe(false);
    expect(monitor.health.detail).toMatch(/not this daemon|tunnel/i);
  });

  it('reports a URL that reaches somebody else`s daemon', async () => {
    const monitor = createEndpointMonitor({
      publicUrl: () => 'https://rocky.example.com',
      instanceId: INSTANCE,
      fetch: (async () =>
        pingResponse('someone-elses-daemon')) as unknown as typeof fetch,
      logWarn: vi.fn(),
    });

    await monitor.check();

    expect(monitor.health.ok).toBe(false);
    expect(monitor.health.detail).toMatch(/another daemon|different/i);
  });
});

describe('a monitor given no logger', () => {
  it('still records the failure and the recovery, silently', async () => {
    let alive = false;
    const monitor = createEndpointMonitor({
      publicUrl: () => 'https://rocky.example.com',
      instanceId: INSTANCE,
      fetch: (async () => {
        if (!alive) throw new Error('down');
        return pingResponse(INSTANCE);
      }) as unknown as typeof fetch,
    });

    expect((await monitor.check()).ok).toBe(false);

    alive = true;
    expect((await monitor.check()).ok).toBe(true);
  });
});

describe('recovery', () => {
  it('clears the flag and says so, without anything having been restarted', async () => {
    const logWarn = vi.fn();
    const logInfo = vi.fn();
    let alive = false;
    const monitor = createEndpointMonitor({
      publicUrl: () => 'https://rocky.example.com',
      instanceId: INSTANCE,
      fetch: (async () => {
        if (!alive) throw new Error('down');
        return pingResponse(INSTANCE);
      }) as unknown as typeof fetch,
      logWarn,
      logInfo,
    });

    await monitor.check();
    expect(monitor.health.ok).toBe(false);

    alive = true;
    await monitor.check();

    expect(monitor.health.ok).toBe(true);
    expect(monitor.health.detail).toBeUndefined();
    expect(logInfo).toHaveBeenCalledWith(expect.stringContaining('reachable'));
  });

  it('does not repeat the same warning on every hourly ping', async () => {
    const logWarn = vi.fn();
    const monitor = createEndpointMonitor({
      publicUrl: () => 'https://rocky.example.com',
      instanceId: INSTANCE,
      fetch: (async () => {
        throw new Error('down');
      }) as unknown as typeof fetch,
      logWarn,
    });

    await monitor.check();
    await monitor.check();
    await monitor.check();

    expect(logWarn).toHaveBeenCalledTimes(1);
  });
});

describe('the schedule', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is boot and then hourly', async () => {
    const doFetch = vi.fn(async () => pingResponse(INSTANCE));
    const monitor = createEndpointMonitor({
      publicUrl: () => 'https://rocky.example.com',
      instanceId: INSTANCE,
      fetch: doFetch as unknown as typeof fetch,
    });

    expect(SELF_PING_INTERVAL_MS).toBe(60 * 60 * 1000);

    monitor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(doFetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(SELF_PING_INTERVAL_MS);
    expect(doFetch).toHaveBeenCalledTimes(2);

    monitor.stop();
    await vi.advanceTimersByTimeAsync(SELF_PING_INTERVAL_MS * 2);
    expect(doFetch).toHaveBeenCalledTimes(2);
  });
});
