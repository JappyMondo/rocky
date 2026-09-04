/**
 * AC2: "`rocky logs -f` follows the live log; rotation caps disk use."
 *
 * The rotation half is `log-rotation.spec.ts` in the daemon. This is the
 * reading half, and the case worth the most care is the seam between them: a
 * `-f` that goes quiet the moment the log rolls is a `-f` that fails exactly
 * when something interesting is happening.
 */
import { mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { appendFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { rockyPaths, type RockyPaths } from '@rocky/daemon';

import { followLog, readTail } from './logs.js';

let root: string;
let paths: RockyPaths;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rocky-logs-'));
  paths = rockyPaths(root);
  mkdirSync(paths.logsDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Waits for `check` to hold, so the tests never race the watcher. */
async function eventually(check: () => boolean, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error('timed out waiting for the follower');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('printing the log', () => {
  it('is empty, not an error, before the daemon has ever run', async () => {
    expect(await readTail(paths)).toEqual([]);
  });

  it('prints what is there', async () => {
    await writeFile(paths.daemonLog, 'one\ntwo\nthree\n');

    expect(await readTail(paths)).toEqual(['one', 'two', 'three']);
  });

  it('prints the last n lines, newest last', async () => {
    await writeFile(paths.daemonLog, 'one\ntwo\nthree\n');

    expect(await readTail(paths, { lines: 2 })).toEqual(['two', 'three']);
  });

  it('reaches back into the rotated files when the live one is short', async () => {
    // Otherwise a rotation that just happened swallows the context the
    // developer came looking for.
    await writeFile(`${paths.daemonLog}.1`, 'older-1\nolder-2\n');
    await writeFile(paths.daemonLog, 'newest\n');

    expect(await readTail(paths, { lines: 3, keep: 2 })).toEqual([
      'older-1',
      'older-2',
      'newest',
    ]);
  });

  it('does not reach further back than it was asked to', async () => {
    await writeFile(`${paths.daemonLog}.1`, 'older\n');
    await writeFile(paths.daemonLog, 'newest\n');

    expect(await readTail(paths, { lines: 1, keep: 2 })).toEqual(['newest']);
  });
});

describe('following the log', () => {
  it('prints lines the daemon writes after it started following', async () => {
    await writeFile(paths.daemonLog, 'before\n');
    const seen: string[] = [];
    let stop!: () => void;
    const until = new Promise<void>((resolve) => {
      stop = resolve;
    });

    const following = followLog(paths, (line) => seen.push(line), {
      until,
      intervalMs: 10,
    });
    await appendFile(paths.daemonLog, 'after\n');
    await eventually(() => seen.includes('after'));
    stop();
    await following;

    // History is `readTail`'s job; `-f` picks up from the end.
    expect(seen).toEqual(['after']);
  });

  it('keeps following across a rotation', async () => {
    await writeFile(paths.daemonLog, 'before\n');
    const seen: string[] = [];
    let stop!: () => void;
    const until = new Promise<void>((resolve) => {
      stop = resolve;
    });

    const following = followLog(paths, (line) => seen.push(line), {
      until,
      intervalMs: 10,
    });

    // What a rotation looks like from here: the file is moved aside and a
    // shorter one takes its place.
    renameSync(paths.daemonLog, `${paths.daemonLog}.1`);
    await writeFile(paths.daemonLog, 'after the roll\n');

    await eventually(() => seen.includes('after the roll'));
    stop();
    await following;

    expect(seen).toContain('after the roll');
  });

  it('waits for a log that does not exist yet', async () => {
    const seen: string[] = [];
    let stop!: () => void;
    const until = new Promise<void>((resolve) => {
      stop = resolve;
    });

    const following = followLog(paths, (line) => seen.push(line), {
      until,
      intervalMs: 10,
    });
    await writeFile(paths.daemonLog, 'the daemon started\n');

    await eventually(() => seen.includes('the daemon started'));
    stop();
    await following;

    expect(seen).toEqual(['the daemon started']);
  });

  it('never emits half a line', async () => {
    // A pino record split across two reads parses in neither half.
    const seen: string[] = [];
    let stop!: () => void;
    const until = new Promise<void>((resolve) => {
      stop = resolve;
    });

    const following = followLog(paths, (line) => seen.push(line), {
      until,
      intervalMs: 10,
    });

    await writeFile(paths.daemonLog, '{"msg":"half');
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(seen).toEqual([]);

    await appendFile(paths.daemonLog, ' a line"}\n');
    await eventually(() => seen.length === 1);
    stop();
    await following;

    expect(seen).toEqual(['{"msg":"half a line"}']);
  });

  it('stops when it is told to', async () => {
    let stop!: () => void;
    const until = new Promise<void>((resolve) => {
      stop = resolve;
    });

    const following = followLog(paths, () => undefined, {
      until,
      intervalMs: 10,
    });
    stop();

    await expect(following).resolves.toBeUndefined();
  });
});
