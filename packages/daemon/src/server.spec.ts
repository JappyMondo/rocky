/**
 * AC1: the daemon serves a health endpoint and the web shell on one port,
 * `127.0.0.1:7625` by default.
 *
 * These drive a listening socket rather than Fastify's `inject`, because the
 * bind address and the port are half of what the AC asserts.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_HOST, DEFAULT_PORT, startDaemon } from './server.js';
import type { RunningDaemon } from './server.js';
import { DAEMON_VERSION, VERSION_HEADER } from './version.js';

/** What a browser sends when a human navigates, as opposed to fetching JSON. */
const NAVIGATION = { accept: 'text/html,application/xhtml+xml' };

/** A stand-in for `apps/web/dist`, so the static path is genuinely covered. */
let webRoot: string;

beforeAll(() => {
  webRoot = mkdtempSync(join(tmpdir(), 'rocky-web-'));
  writeFileSync(
    join(webRoot, 'index.html'),
    '<!doctype html><title>Rocky</title>',
  );
});

afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
});

let daemon: RunningDaemon | undefined;

afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
});

describe('the defaults', () => {
  it('are the loopback address and the port that spells ROCK', () => {
    expect(DEFAULT_HOST).toBe('127.0.0.1');
    expect(DEFAULT_PORT).toBe(7625);
  });

  it('are what an unconfigured daemon actually binds', async () => {
    daemon = await startDaemon({ webRoot });

    expect(daemon.url).toBe('http://127.0.0.1:7625');

    const response = await fetch('http://127.0.0.1:7625/api/health');
    expect(response.status).toBe(200);
  });
});

describe('a daemon serving the web shell', () => {
  it('reports health, its version, and that the shell is present', async () => {
    daemon = await startDaemon({ port: 0, webRoot });

    const response = await fetch(`${daemon.url}/api/health`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'ok',
      version: DAEMON_VERSION,
      web: true,
    });
  });

  it('stamps its version on every response, not just the health route', async () => {
    daemon = await startDaemon({ port: 0, webRoot });

    const health = await fetch(`${daemon.url}/api/health`);
    const shell = await fetch(`${daemon.url}/`);

    expect(health.headers.get(VERSION_HEADER)).toBe(DAEMON_VERSION);
    expect(shell.headers.get(VERSION_HEADER)).toBe(DAEMON_VERSION);
  });

  it('serves the shell at the root and on a deep link', async () => {
    daemon = await startDaemon({ port: 0, webRoot });

    for (const path of ['/', '/runs/NG-515-1']) {
      const response = await fetch(`${daemon.url}${path}`, {
        headers: NAVIGATION,
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('<title>Rocky</title>');
    }
  });

  it('still 404s an unknown API path rather than answering with the shell', async () => {
    daemon = await startDaemon({ port: 0, webRoot });

    const response = await fetch(`${daemon.url}/api/nope`, {
      headers: NAVIGATION,
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found' });
  });

  it('404s a missing asset instead of handing it the shell', async () => {
    daemon = await startDaemon({ port: 0, webRoot });

    // What a browser sends for the favicon it fetches unprompted. Answering
    // that with an HTML body labelled as an icon is worse than a 404.
    const response = await fetch(`${daemon.url}/favicon.ico`, {
      headers: { accept: 'image/avif,image/webp,*/*' },
    });

    expect(response.status).toBe(404);
  });
});

describe('a daemon with no web shell beside it', () => {
  it('serves the API alone and says so', async () => {
    daemon = await startDaemon({ port: 0, webRoot: false });

    const health = await fetch(`${daemon.url}/api/health`);
    const shell = await fetch(`${daemon.url}/`);

    expect(await health.json()).toEqual({
      status: 'ok',
      version: DAEMON_VERSION,
      web: false,
    });
    expect(shell.status).toBe(404);
  });
});

describe('the bind address and port', () => {
  it('are configurable, so the docs can carry the exposure warning', async () => {
    daemon = await startDaemon({ host: '127.0.0.1', port: 7626, webRoot });

    expect(daemon.port).toBe(7626);

    const response = await fetch('http://127.0.0.1:7626/api/health');
    expect(response.status).toBe(200);
  });
});
