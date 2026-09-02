/**
 * "size-rotated `logs/daemon.log` (keep a handful)" — NG-595, and its
 * acceptance criterion "rotation caps disk use".
 *
 * The cap is the claim worth testing: a daemon that runs for months must not
 * be able to fill a laptop's disk, however much it logs.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_KEEP,
  DEFAULT_MAX_BYTES,
  rotatedLogFiles,
  rotatingLogStream,
} from './log-rotation.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rocky-rotate-'));
  file = join(dir, 'daemon.log');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Writes every line, then ends the stream and waits for the flush. */
async function writeLines(
  stream: ReturnType<typeof rotatingLogStream>,
  lines: string[],
): Promise<void> {
  for (const line of lines) {
    stream.write(`${line}\n`);
  }
  await new Promise<void>((resolve) => stream.end(resolve));
}

function filesInDir(): string[] {
  return readdirSync(dir).sort();
}

describe('the rotating log', () => {
  it('writes plainly while it is under the cap', async () => {
    const stream = rotatingLogStream(file, { maxBytes: 1024, keep: 3 });

    await writeLines(stream, ['one', 'two', 'three']);

    expect(readFileSync(file, 'utf8')).toBe('one\ntwo\nthree\n');
    expect(filesInDir()).toEqual(['daemon.log']);
  });

  it('creates the directory it logs into', async () => {
    const nested = join(dir, 'logs', 'daemon.log');
    const stream = rotatingLogStream(nested, { maxBytes: 1024, keep: 3 });

    await writeLines(stream, ['hello']);

    expect(readFileSync(nested, 'utf8')).toBe('hello\n');
  });

  it('appends to a log that is already there', async () => {
    await writeFile(file, 'from a previous run\n');
    const stream = rotatingLogStream(file, { maxBytes: 1024, keep: 3 });

    await writeLines(stream, ['from this one']);

    expect(readFileSync(file, 'utf8')).toBe(
      'from a previous run\nfrom this one\n',
    );
  });

  it('rolls the live file aside once it passes the cap', async () => {
    const stream = rotatingLogStream(file, { maxBytes: 20, keep: 3 });

    // Each line is 10 bytes, so the third crosses a 20-byte cap.
    await writeLines(stream, ['123456789', '123456789', 'after roll']);

    expect(filesInDir()).toEqual(['daemon.log', 'daemon.log.1']);
    expect(readFileSync(file, 'utf8')).toBe('after roll\n');
    expect(readFileSync(`${file}.1`, 'utf8')).toBe('123456789\n123456789\n');
  });

  it('ages older files down the numbers as it rolls', async () => {
    const stream = rotatingLogStream(file, { maxBytes: 10, keep: 3 });

    await writeLines(stream, ['aaaaaaaaa', 'bbbbbbbbb', 'ccccccccc']);

    // Newest rolled file is always .1, so the numbers read as "how far back".
    expect(readFileSync(`${file}.1`, 'utf8')).toBe('bbbbbbbbb\n');
    expect(readFileSync(`${file}.2`, 'utf8')).toBe('aaaaaaaaa\n');
    expect(readFileSync(file, 'utf8')).toBe('ccccccccc\n');
  });

  it('caps disk use: never more than `keep` files survive', async () => {
    const stream = rotatingLogStream(file, { maxBytes: 10, keep: 3 });

    // Twenty rolls' worth against a keep of three.
    await writeLines(
      stream,
      Array.from({ length: 20 }, (_, index) => `line-${String(index)}____`),
    );

    // The live file plus exactly `keep` rolled ones, and nothing else.
    expect(filesInDir()).toEqual([
      'daemon.log',
      'daemon.log.1',
      'daemon.log.2',
      'daemon.log.3',
    ]);
  });

  it('keeps the newest lines, dropping the oldest', async () => {
    const stream = rotatingLogStream(file, { maxBytes: 10, keep: 2 });

    await writeLines(stream, ['aaaaaaaaa', 'bbbbbbbbb', 'ccccccccc']);

    const everything = [file, `${file}.1`, `${file}.2`]
      .filter((path) => readdirSync(dir).includes(path.slice(dir.length + 1)))
      .map((path) => readFileSync(path, 'utf8'))
      .join('');

    expect(everything).toContain('ccccccccc');
    expect(everything).toContain('bbbbbbbbb');
  });

  it('never splits a write across two files', async () => {
    // A rotation mid-line would leave half a JSON log record in each file,
    // and neither half would parse.
    const stream = rotatingLogStream(file, { maxBytes: 5, keep: 5 });

    await writeLines(stream, ['a-whole-line-much-longer-than-the-cap']);

    expect(readFileSync(file, 'utf8')).toBe(
      'a-whole-line-much-longer-than-the-cap\n',
    );
  });

  it('rolls a log that was already oversized before this daemon started', async () => {
    await writeFile(file, `${'x'.repeat(100)}\n`);
    const stream = rotatingLogStream(file, { maxBytes: 20, keep: 3 });

    await writeLines(stream, ['fresh']);

    expect(readFileSync(file, 'utf8')).toBe('fresh\n');
    expect(readFileSync(`${file}.1`, 'utf8')).toBe(`${'x'.repeat(100)}\n`);
  });
});

describe('keeping nothing at all', () => {
  it('drops the old file rather than numbering it', async () => {
    // `keep: 0` is a legitimate "I only ever want the current log": the cap
    // still has to hold, and there is nowhere to move the old file to.
    const stream = rotatingLogStream(file, { maxBytes: 10, keep: 0 });

    await writeLines(stream, ['aaaaaaaaa', 'bbbbbbbbb']);

    expect(filesInDir()).toEqual(['daemon.log']);
    expect(readFileSync(file, 'utf8')).toBe('bbbbbbbbb\n');
  });
});

describe('a log destination that goes wrong', () => {
  it('surfaces the error on the stream rather than crashing the daemon', async () => {
    // The directory is removed underneath a rotation, so reopening fails.
    const stream = rotatingLogStream(file, { maxBytes: 10, keep: 2 });
    const failed = new Promise<Error>((resolve) => stream.on('error', resolve));

    stream.write('aaaaaaaaa\n');
    rmSync(dir, { recursive: true, force: true });
    stream.write('bbbbbbbbb\n');
    stream.write('ccccccccc\n');

    // An unhandled 'error' would take the process down instead of arriving.
    expect(await failed).toBeInstanceOf(Error);
  });
});

describe('the defaults', () => {
  it('keep a handful of files of a few megabytes', () => {
    expect(DEFAULT_KEEP).toBe(5);
    expect(DEFAULT_MAX_BYTES).toBe(5 * 1024 * 1024);
  });

  it('bound the daemon log to something a laptop can spare', () => {
    expect((DEFAULT_KEEP + 1) * DEFAULT_MAX_BYTES).toBeLessThanOrEqual(
      64 * 1024 * 1024,
    );
  });
});

describe('naming the rotated files', () => {
  it('lists the live file first, then oldest-last', () => {
    expect(rotatedLogFiles('/tmp/daemon.log', 3)).toEqual([
      '/tmp/daemon.log',
      '/tmp/daemon.log.1',
      '/tmp/daemon.log.2',
      '/tmp/daemon.log.3',
    ]);
  });
});
