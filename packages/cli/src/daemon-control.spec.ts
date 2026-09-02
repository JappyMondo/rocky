/**
 * AC1: "`rocky start -d` then `rocky status` reports a healthy daemon;
 * `rocky stop` ends it and removes the pidfile; a stale pidfile is detected,
 * not obeyed."
 *
 * These spawn a **real detached process**, because every part of that
 * sentence is about one process talking to another: an in-process fake would
 * pass while `start -d` left the terminal hanging, or while `stop` killed a
 * daemon whose pidfile it never cleaned up.
 *
 * The child runs the built daemon rather than the CLI's own entry point, so
 * the suite does not need the CLI compiled to test the CLI's control flow.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  pidIsAlive,
  readPidFile,
  rockyPaths,
  writeInstanceConfig,
  writePidFile,
  type RockyPaths,
} from '@rocky/daemon';

import {
  daemonStatus,
  resolveAddress,
  startDetached,
  stopDaemon,
  StartFailedError,
} from './daemon-control.js';

let root: string;
let paths: RockyPaths;
/** The stand-in `rocky` the detached child runs. */
let entry: string;

/** The built daemon, which `nx test` guarantees by depending on `^build`. */
const DAEMON_DIST = join(import.meta.dirname, '../../daemon/dist/index.js');

/**
 * A minimal `rocky start`: it takes the same `start --host --port` the real
 * one is spawned with, and runs the same `runDaemon`.
 */
const CHILD = `
import { pathToFileURL } from 'node:url';
const { runDaemon, rockyPaths } = await import(
  pathToFileURL(${JSON.stringify(DAEMON_DIST)}).href
);

const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};

const port = flag('--port');
await runDaemon({
  paths: rockyPaths(process.env.ROCKY_HOME),
  webRoot: false,
  ...(flag('--host') === undefined ? {} : { host: flag('--host') }),
  ...(port === undefined ? {} : { port: Number(port) }),
});
`;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'rocky-ctl-'));
  paths = rockyPaths(root);
  entry = join(root, 'fake-rocky.mjs');
  await writeFile(entry, CHILD);
});

afterEach(async () => {
  // Whatever a test left running, so a failure never leaks a daemon.
  await stopDaemon(paths, {}, control()).catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
});

/** Ephemeral ports throughout; the child is told its root through the env. */
function control() {
  return {
    entry,
    timeoutMs: 15_000,
    intervalMs: 25,
    env: { ...process.env, ROCKY_HOME: root },
  };
}

const started = () => startDetached(paths, { port: 0 }, control());

describe('`rocky start -d`', () => {
  it('leaves a daemon running after the CLI has returned', async () => {
    const address = await started();

    const response = await fetch(`${address.url}/api/health`);

    expect(response.status).toBe(200);
  });

  it('starts a daemon in another process, not this one', async () => {
    await started();

    const record = await readPidFile(paths);

    expect(record?.pid).not.toBe(process.pid);
    expect(pidIsAlive(record?.pid ?? -1)).toBe(true);
  });

  it('reports the port the daemon actually bound', async () => {
    // `--port 0` asks the kernel to choose, so the CLI cannot know it up front.
    const address = await started();

    expect(address.port).toBeGreaterThan(0);
    expect((await readPidFile(paths))?.port).toBe(address.port);
  });

  it('refuses to start a second daemon over a live one', async () => {
    await started();

    await expect(started()).rejects.toThrow(StartFailedError);
    await expect(started()).rejects.toThrow(/already running/i);
  });
});

describe('`rocky status`', () => {
  it('reports a healthy daemon once one is up', async () => {
    await started();

    const status = await daemonStatus(paths, {}, control());

    expect(status.running).toBe(true);
    expect(status.version).toBeTruthy();
    expect(status.record?.pid).toBeGreaterThan(0);
  });

  it('finds the daemon through the pidfile, with no flags to help it', async () => {
    // The port was ephemeral, so the pidfile is the only way to know it.
    const address = await started();

    expect((await daemonStatus(paths, {}, control())).address.url).toBe(
      address.url,
    );
  });

  it('reports no daemon when none is running', async () => {
    expect((await daemonStatus(paths, {}, control())).running).toBe(false);
  });
});

describe('`rocky stop`', () => {
  it('ends the daemon', async () => {
    const address = await started();

    const outcome = await stopDaemon(paths, {}, control());

    expect(outcome.stopped).toBe(true);
    await expect(fetch(`${address.url}/api/health`)).rejects.toThrow();
  });

  it('removes the pidfile', async () => {
    await started();

    await stopDaemon(paths, {}, control());

    expect(await readPidFile(paths)).toBeUndefined();
    expect(existsSync(paths.pidFile)).toBe(false);
  });

  it('really ends the process, not just the socket', async () => {
    await started();
    const pid = (await readPidFile(paths))?.pid ?? -1;

    await stopDaemon(paths, {}, control());

    expect(pidIsAlive(pid)).toBe(false);
  });

  it('asks over the local API rather than reaching for a signal', async () => {
    await started();

    expect(await stopDaemon(paths, {}, control())).toMatchObject({
      stopped: true,
      how: 'api',
    });
  });

  it('says so, without failing, when nothing is running', async () => {
    expect(await stopDaemon(paths, {}, control())).toMatchObject({
      stopped: false,
      reason: 'not-running',
    });
  });
});

describe('a pidfile naming the process doing the stopping', () => {
  it('is never signalled, whatever else happens', async () => {
    // `rocky stop` and the daemon are different processes in production, so
    // this is a guard rather than a path. It is worth having: the fallback
    // sends SIGTERM to the recorded pid, and sending it to *ourselves* would
    // take down the process that was only trying to be helpful.
    await writePidFile(paths, {
      pid: process.pid,
      host: '127.0.0.1',
      // Nothing is listening here, so the API ask fails and the code takes
      // exactly the fallback path this guard sits on.
      port: 9,
      url: 'http://127.0.0.1:9',
      version: '0.0.0',
      startedAt: new Date().toISOString(),
    });

    const outcome = await stopDaemon(paths, {}, { ...control(), timeoutMs: 200 });

    // Still alive to make the assertion at all, which is most of the point.
    expect(pidIsAlive(process.pid)).toBe(true);
    expect(outcome.stopped).toBe(false);
  });
});

describe('a stale pidfile', () => {
  /** A pid high enough to be nobody, which is what "stale" looks like. */
  const DEAD_PID = 2 ** 22;

  const leaveStale = () =>
    writePidFile(paths, {
      pid: DEAD_PID,
      host: '127.0.0.1',
      port: 7625,
      url: 'http://127.0.0.1:7625',
      version: '0.0.0',
      startedAt: new Date().toISOString(),
    });

  it('is not obeyed by `status`', async () => {
    await leaveStale();

    const status = await daemonStatus(paths, {}, control());

    expect(status.running).toBe(false);
    expect(status.staleReason).toContain(String(DEAD_PID));
  });

  it('does not stop `start -d`', async () => {
    // Otherwise a daemon that was killed leaves Rocky unstartable until a
    // human deletes a file.
    await leaveStale();

    const address = await started();

    expect((await fetch(`${address.url}/api/health`)).status).toBe(200);
  });

  it('is cleaned up by `stop` rather than reported as a running daemon', async () => {
    await leaveStale();

    const outcome = await stopDaemon(paths, {}, control());

    expect(outcome).toMatchObject({
      stopped: false,
      reason: 'not-running',
      cleanedStalePidfile: true,
    });
    expect(existsSync(paths.pidFile)).toBe(false);
  });

  it('is replaced by the pidfile of the daemon that starts over it', async () => {
    await leaveStale();

    await started();

    expect((await readPidFile(paths))?.pid).not.toBe(DEAD_PID);
  });
});

describe('resolving which daemon to talk to', () => {
  it('prefers an explicit flag over everything', async () => {
    await writePidFile(paths, {
      pid: process.pid,
      host: '127.0.0.1',
      port: 9999,
      url: 'http://127.0.0.1:9999',
      version: '0.0.0',
      startedAt: new Date().toISOString(),
    });

    expect(
      await resolveAddress(paths, { host: '127.0.0.1', port: 1234 }),
    ).toMatchObject({ port: 1234 });
  });

  it('falls back to the running daemon’s own pidfile', async () => {
    const address = await started();

    expect((await resolveAddress(paths, {})).port).toBe(address.port);
  });

  it('falls back to config.json when no daemon is running', async () => {
    await writeInstanceConfig(paths, {
      server: { host: '127.0.0.1', port: 7699 },
    });

    expect((await resolveAddress(paths, {})).port).toBe(7699);
  });

  it('falls back to the default port when there is nothing else', async () => {
    expect((await resolveAddress(paths, {})).port).toBe(7625);
  });
});
