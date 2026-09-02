/**
 * The pidfile is what `stop`, `status` and `restart` find the daemon through,
 * and NG-595's first acceptance criterion is about the case where it lies: "a
 * stale pidfile is detected, not obeyed."
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  inspectPidFile,
  readPidFile,
  removePidFile,
  writePidFile,
  type DaemonRecord,
} from './pidfile.js';
import { rockyPaths, type RockyPaths } from '../config/paths.js';

let root: string;
let paths: RockyPaths;

const RECORD: DaemonRecord = {
  pid: 4242,
  host: '127.0.0.1',
  port: 7625,
  url: 'http://127.0.0.1:7625',
  version: '0.0.0',
  startedAt: '2026-09-02T12:00:00.000Z',
};

/** Neither alive nor dead by default — each test says which it wants. */
const alive = () => true;
const dead = () => false;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rocky-pid-'));
  paths = rockyPaths(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('writing the pidfile', () => {
  it('round-trips the whole record', async () => {
    await writePidFile(paths, RECORD);

    expect(await readPidFile(paths)).toEqual(RECORD);
  });

  it('records the bound address, not the requested one', async () => {
    // `--port 0` is a real way to start a daemon, and `rocky stop` has to be
    // able to reach whatever it actually got.
    await writePidFile(paths, { ...RECORD, port: 51234 });

    expect((await readPidFile(paths))?.port).toBe(51234);
  });

  it('creates the root when it does not exist yet', async () => {
    rmSync(root, { recursive: true, force: true });

    await writePidFile(paths, RECORD);

    expect(await readPidFile(paths)).toEqual(RECORD);
  });
});

describe('reading a pidfile that is not one', () => {
  it('is undefined rather than a throw when the file is absent', async () => {
    expect(await readPidFile(paths)).toBeUndefined();
  });

  it('is undefined when the contents are not JSON', async () => {
    await writeFile(paths.pidFile, 'not json at all');

    expect(await readPidFile(paths)).toBeUndefined();
  });

  it('is undefined when the JSON is missing a pid', async () => {
    await writeFile(paths.pidFile, JSON.stringify({ host: 'x', port: 1 }));

    expect(await readPidFile(paths)).toBeUndefined();
  });
});

describe('inspecting the pidfile', () => {
  it('reports no daemon when there is no file', async () => {
    expect(await inspectPidFile(paths, { isAlive: alive })).toEqual({
      state: 'none',
    });
  });

  it('reports a running daemon when the pid is alive', async () => {
    await writePidFile(paths, RECORD);

    expect(await inspectPidFile(paths, { isAlive: alive })).toEqual({
      state: 'running',
      record: RECORD,
    });
  });

  it('reports stale — not running — when the pid is gone', async () => {
    await writePidFile(paths, RECORD);

    const found = await inspectPidFile(paths, { isAlive: dead });

    expect(found.state).toBe('stale');
    // The message is what a human acts on, so it names the pid and the file.
    expect(found.state === 'stale' && found.reason).toContain('4242');
    expect(found.state === 'stale' && found.reason).toContain(paths.pidFile);
  });

  it('reports unreadable for a file it cannot make sense of', async () => {
    await writeFile(paths.pidFile, 'garbage');

    const found = await inspectPidFile(paths, { isAlive: alive });

    expect(found.state).toBe('unreadable');
    expect(found.state === 'unreadable' && found.reason).toContain(
      paths.pidFile,
    );
  });

  it('asks about the pid the file names, and no other', async () => {
    await writePidFile(paths, RECORD);
    const asked: number[] = [];

    await inspectPidFile(paths, {
      isAlive: (pid) => {
        asked.push(pid);
        return true;
      },
    });

    expect(asked).toEqual([4242]);
  });
});

describe('the default liveness probe', () => {
  it('finds this very process alive', async () => {
    await writePidFile(paths, { ...RECORD, pid: process.pid });

    expect((await inspectPidFile(paths)).state).toBe('running');
  });

  it('does not mistake an unusable pid for a live process', async () => {
    // Pid 0 is the caller's own process group for `kill(2)`, which would make
    // a naive `process.kill(pid, 0)` answer "alive" for a nonsense record.
    await writePidFile(paths, { ...RECORD, pid: 0 });

    expect((await inspectPidFile(paths)).state).toBe('stale');
  });
});

describe('removing the pidfile', () => {
  it('removes it', async () => {
    await writePidFile(paths, RECORD);

    await removePidFile(paths);

    expect(await readPidFile(paths)).toBeUndefined();
  });

  it('is quiet when there is nothing to remove', async () => {
    await expect(removePidFile(paths)).resolves.toBeUndefined();
  });

  it('leaves a pidfile that belongs to a different daemon alone', async () => {
    // A slow `stop` must not delete the pidfile a `restart` has already
    // written for the daemon that replaced it.
    await writePidFile(paths, { ...RECORD, pid: 999 });

    await removePidFile(paths, { pid: 4242 });

    expect((await readPidFile(paths))?.pid).toBe(999);
  });

  it('removes one that does belong to the named pid', async () => {
    await writePidFile(paths, RECORD);

    await removePidFile(paths, { pid: 4242 });

    expect(await readPidFile(paths)).toBeUndefined();
  });
});

describe('the file on disk', () => {
  it('is JSON a human can read, ending in a newline', async () => {
    await writePidFile(paths, RECORD);

    const written = await readFile(paths.pidFile, 'utf8');

    expect(written.endsWith('\n')).toBe(true);
    expect(JSON.parse(written)).toEqual(RECORD);
  });
});
