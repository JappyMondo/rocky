/**
 * The daemon as a *process*, rather than as a Fastify instance (NG-595): it
 * owns the pidfile, the rotated log, and its own clean end.
 *
 * "The daemon just must not corrupt state on SIGTERM/sleep" is the load-
 * bearing sentence — so the tests here are mostly about what survives a stop.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readPidFile, writePidFile } from './pidfile.js';
import { runDaemon, type DaemonProcess } from './run-daemon.js';
import { rockyPaths, type RockyPaths } from '../config/paths.js';
import { writeCredentials, writeInstanceConfig } from '../config/store.js';
import { DAEMON_VERSION } from '../version.js';

let root: string;
let paths: RockyPaths;
let daemon: DaemonProcess | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rocky-run-'));
  paths = rockyPaths(root);
});

afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  rmSync(root, { recursive: true, force: true });
});

/** Every test binds an ephemeral port; only the config tests care which. */
const EPHEMERAL = { port: 0, webRoot: false as const };

describe('a running daemon', () => {
  it('answers on the port it reports', async () => {
    daemon = await runDaemon({ paths, ...EPHEMERAL });

    const response = await fetch(`${daemon.url}/api/health`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ok' });
  });

  it('lays out ~/.rocky before it needs any of it', async () => {
    daemon = await runDaemon({ paths, ...EPHEMERAL });

    expect(existsSync(paths.logsDir)).toBe(true);
    expect(existsSync(paths.reposDir)).toBe(true);
    expect(existsSync(paths.runsDir)).toBe(true);
  });

  it('writes a pidfile naming itself and the address it actually bound', async () => {
    daemon = await runDaemon({ paths, ...EPHEMERAL });

    const record = await readPidFile(paths);

    expect(record).toMatchObject({
      pid: process.pid,
      host: '127.0.0.1',
      port: daemon.port,
      url: daemon.url,
      version: DAEMON_VERSION,
    });
    // `port: 0` asked the kernel to choose, so a recorded 0 would be useless.
    expect(record?.port).toBeGreaterThan(0);
  });

  it('logs to logs/daemon.log', async () => {
    daemon = await runDaemon({ paths, ...EPHEMERAL });

    await fetch(`${daemon.url}/api/health`);
    await daemon.stop();
    daemon = undefined;

    expect(await readFile(paths.daemonLog, 'utf8')).toContain('/api/health');
  });
});

describe('the address it binds', () => {
  it('comes from config.json when no flag overrides it', async () => {
    await writeInstanceConfig(paths, {
      server: { host: '127.0.0.1', port: 7627 },
    });

    daemon = await runDaemon({ paths, webRoot: false });

    expect(daemon.port).toBe(7627);
  });

  it('takes the flag over config.json, so a busy port has an escape', async () => {
    await writeInstanceConfig(paths, {
      server: { host: '127.0.0.1', port: 7627 },
    });

    daemon = await runDaemon({ paths, port: 0, webRoot: false });

    expect(daemon.port).not.toBe(7627);
  });
});

describe('stopping', () => {
  it('removes the pidfile, so nothing is left claiming a daemon', async () => {
    daemon = await runDaemon({ paths, ...EPHEMERAL });

    await daemon.stop();
    daemon = undefined;

    expect(await readPidFile(paths)).toBeUndefined();
  });

  it('closes the socket', async () => {
    daemon = await runDaemon({ paths, ...EPHEMERAL });
    const url = daemon.url;

    await daemon.stop();
    daemon = undefined;

    await expect(fetch(`${url}/api/health`)).rejects.toThrow();
  });

  it('settles `stopped` so a foreground `rocky start` returns', async () => {
    daemon = await runDaemon({ paths, ...EPHEMERAL });

    await daemon.stop();
    const settled = await Promise.race([
      daemon.stopped.then(() => 'stopped'),
      new Promise((resolve) => setTimeout(() => resolve('hung'), 2000)),
    ]);
    daemon = undefined;

    expect(settled).toBe('stopped');
  });

  it('is safe to ask for twice', async () => {
    daemon = await runDaemon({ paths, ...EPHEMERAL });

    await daemon.stop();
    await expect(daemon.stop()).resolves.toBeUndefined();
    daemon = undefined;
  });

  it('flushes the log before the process would exit', async () => {
    daemon = await runDaemon({ paths, ...EPHEMERAL });
    daemon.log.info('a line that must survive the stop');

    await daemon.stop();
    daemon = undefined;

    expect(readFileSync(paths.daemonLog, 'utf8')).toContain(
      'a line that must survive the stop',
    );
  });
});

describe('the signals a service manager sends', () => {
  /**
   * The handler is registered rather than raised: a real SIGTERM at this
   * process is the test runner's business, not ours. What it does once it
   * fires is `stop()`, which the tests above cover end to end.
   */
  const listeners = (signal: NodeJS.Signals) => process.listenerCount(signal);

  it('are listened for, so launchd and systemd get a clean end', async () => {
    const before = { term: listeners('SIGTERM'), int: listeners('SIGINT') };

    daemon = await runDaemon({ paths, ...EPHEMERAL });

    expect(listeners('SIGTERM')).toBe(before.term + 1);
    expect(listeners('SIGINT')).toBe(before.int + 1);
  });

  it('are unlistened on stop, so a stopped daemon leaks no handler', async () => {
    const before = { term: listeners('SIGTERM'), int: listeners('SIGINT') };

    daemon = await runDaemon({ paths, ...EPHEMERAL });
    await daemon.stop();
    daemon = undefined;

    expect(listeners('SIGTERM')).toBe(before.term);
    expect(listeners('SIGINT')).toBe(before.int);
  });

  it('can be left alone by a caller that owns them itself', async () => {
    const before = listeners('SIGTERM');

    daemon = await runDaemon({ paths, ...EPHEMERAL, handleSignals: false });

    expect(listeners('SIGTERM')).toBe(before);
  });
});

describe('being asked to stop over the local API', () => {
  it('answers first, then goes away', async () => {
    daemon = await runDaemon({ paths, ...EPHEMERAL });

    const response = await fetch(`${daemon.url}/api/shutdown`, {
      method: 'POST',
    });

    // The answer arrives intact rather than as a dropped socket.
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'stopping' });

    await daemon.stopped;
    expect(await readPidFile(paths)).toBeUndefined();
    daemon = undefined;
  });
});

describe('a second daemon on the same ~/.rocky', () => {
  it('refuses rather than fighting the first for the pidfile', async () => {
    daemon = await runDaemon({ paths, ...EPHEMERAL });

    await expect(runDaemon({ paths, ...EPHEMERAL })).rejects.toThrow(
      /already running/i,
    );
  });

  it('names the running daemon so the human knows what to stop', async () => {
    daemon = await runDaemon({ paths, ...EPHEMERAL });

    await expect(runDaemon({ paths, ...EPHEMERAL })).rejects.toThrow(
      new RegExp(String(process.pid)),
    );
  });

  it('starts anyway when the pidfile is merely stale', async () => {
    // A daemon that was killed leaves its pidfile behind; obeying it would
    // make Rocky unstartable until a human deleted a file.
    await writePidFile(paths, {
      pid: 2 ** 22,
      host: '127.0.0.1',
      port: 7625,
      url: 'http://127.0.0.1:7625',
      version: DAEMON_VERSION,
      startedAt: new Date().toISOString(),
    });

    daemon = await runDaemon({ paths, ...EPHEMERAL });

    expect((await readPidFile(paths))?.pid).toBe(process.pid);
  });
});

describe('a foreground daemon', () => {
  it('echoes its log to the terminal as well as writing it', async () => {
    // `rocky start` without `-d` should not be a silent process, and what it
    // shows must still end up where `rocky logs` will find it.
    const shown: string[] = [];
    const echo = new Writable({
      write(chunk: Buffer | string, _encoding, callback) {
        shown.push(chunk.toString());
        callback();
      },
    });

    daemon = await runDaemon({ paths, ...EPHEMERAL, echo });
    daemon.log.info('a line for both');

    await daemon.stop();
    daemon = undefined;

    expect(shown.join('')).toContain('a line for both');
    expect(readFileSync(paths.daemonLog, 'utf8')).toContain('a line for both');
  });

  it('redacts the echo too — a secret must not reach the terminal', async () => {
    await writeCredentials(paths, {
      linear: { accessToken: 'lin_PLANTED_FOR_THE_TERMINAL' },
    });
    const shown: string[] = [];
    const echo = new Writable({
      write(chunk: Buffer | string, _encoding, callback) {
        shown.push(chunk.toString());
        callback();
      },
    });

    daemon = await runDaemon({ paths, ...EPHEMERAL, echo });
    daemon.log.info('token is lin_PLANTED_FOR_THE_TERMINAL');

    await daemon.stop();
    daemon = undefined;

    expect(shown.join('')).not.toContain('lin_PLANTED_FOR_THE_TERMINAL');
    expect(shown.join('')).toContain('[redacted]');
  });

  it('leaves the terminal open when it ends, having only borrowed it', async () => {
    let ended = false;
    const echo = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
      final(callback) {
        ended = true;
        callback();
      },
    });

    daemon = await runDaemon({ paths, ...EPHEMERAL, echo });
    await daemon.stop();
    daemon = undefined;

    // Closing the developer's stdout on the way out would be a rude daemon.
    expect(ended).toBe(false);
  });
});

describe('a port that is already taken', () => {
  it('fails without leaving a pidfile claiming the daemon started', async () => {
    daemon = await runDaemon({ paths, ...EPHEMERAL });
    const taken = daemon.port;
    const second = rockyPaths(mkdtempSync(join(tmpdir(), 'rocky-busy-')));

    await expect(
      runDaemon({ paths: second, port: taken, webRoot: false }),
    ).rejects.toThrow();

    expect(await readPidFile(second)).toBeUndefined();
    rmSync(second.root, { recursive: true, force: true });
  });
});

describe('a warning raised before the log exists', () => {
  it('reaches the log once there is one', async () => {
    // The stale-pidfile notice is raised while the redaction set is still
    // being built, so it has nowhere to go yet. Losing it would make a
    // replaced pidfile invisible after the fact.
    await writePidFile(paths, {
      pid: 2 ** 22,
      host: '127.0.0.1',
      port: 7625,
      url: 'http://127.0.0.1:7625',
      version: DAEMON_VERSION,
      startedAt: new Date().toISOString(),
    });

    daemon = await runDaemon({ paths, ...EPHEMERAL });
    await daemon.stop();
    daemon = undefined;

    expect(readFileSync(paths.daemonLog, 'utf8')).toContain('is not running');
  });
});

describe('the signal handler itself', () => {
  it('stops the daemon when it fires', async () => {
    daemon = await runDaemon({ paths, ...EPHEMERAL });
    // Invoked directly rather than by raising a real SIGTERM, which would
    // reach the test runner's own handlers too.
    const ours = process.listeners('SIGTERM').at(-1) as () => void;

    ours();
    await daemon.stopped;

    expect(await readPidFile(paths)).toBeUndefined();
    daemon = undefined;
  });
});

describe('the log', () => {
  it('carries no secret from either ~/.rocky file', async () => {
    // NG-594 built the redacting stream; this is the wiring that has to keep
    // using it once the log also rotates.
    await writeCredentials(paths, {
      linear: { accessToken: 'lin_PLANTED_IN_THE_DAEMON_LOG' },
    });

    daemon = await runDaemon({ paths, ...EPHEMERAL });
    daemon.log.info('token is lin_PLANTED_IN_THE_DAEMON_LOG');

    await daemon.stop();
    daemon = undefined;

    const written = readFileSync(paths.daemonLog, 'utf8');
    expect(written).not.toContain('lin_PLANTED_IN_THE_DAEMON_LOG');
    expect(written).toContain('[redacted]');
  });
});
