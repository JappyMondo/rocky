/**
 * Size-rotated `logs/daemon.log` (NG-595).
 *
 * Rocky's daemon is meant to run for months on a laptop, so the log needs a
 * ceiling rather than a policy — hence rotation by size with a fixed number of
 * files kept, which bounds disk use at `(keep + 1) * maxBytes` no matter what
 * the daemon does.
 *
 * Rotation happens *between* writes, never inside one: pino writes one JSON
 * record per `write`, and a record split across two files parses in neither.
 * The NG-594 redacting stream sits on top of this one, so what lands here is
 * already redacted.
 */
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { Writable } from 'node:stream';

/** Big enough to hold a real debugging session, small enough to spare. */
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

/** "Keep a handful" — NG-578. */
export const DEFAULT_KEEP = 5;

export interface RotationOptions {
  /** Roll once the live file would grow past this. */
  maxBytes?: number;
  /** How many rolled files to keep beside the live one. */
  keep?: number;
}

/**
 * The live file first, then `.1` … `.keep` — oldest last, which is the order
 * `rocky logs` wants to print them in reverse.
 */
export function rotatedLogFiles(file: string, keep: number): string[] {
  return [
    file,
    ...Array.from(
      { length: keep },
      (_, index) => `${file}.${String(index + 1)}`,
    ),
  ];
}

function sizeOf(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * `daemon.log.2` becomes `.3`, `.1` becomes `.2`, the live file becomes `.1`.
 * Walked from the oldest down so nothing is overwritten before it has moved,
 * and the one that would become `.keep + 1` is dropped instead.
 */
function roll(file: string, keep: number): void {
  if (keep < 1) {
    rmSync(file, { force: true });
    return;
  }

  rmSync(`${file}.${String(keep)}`, { force: true });

  for (let index = keep - 1; index >= 1; index -= 1) {
    const from = `${file}.${String(index)}`;
    if (sizeOf(from) > 0) {
      renameSync(from, `${file}.${String(index + 1)}`);
    }
  }

  renameSync(file, `${file}.1`);
}

/**
 * A log destination that rolls itself. Synchronous `fs` inside the write
 * callback on purpose: the ordering between "how big is it" and "write this"
 * is the whole correctness argument, and an `await` between them would let a
 * second write interleave and defeat the cap.
 */
export function rotatingLogStream(
  file: string,
  options: RotationOptions = {},
): Writable {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const keep = options.keep ?? DEFAULT_KEEP;

  mkdirSync(dirname(file), { recursive: true });

  let size = sizeOf(file);
  let out: WriteStream;

  const open = (): void => {
    out = createWriteStream(file, { flags: 'a' });
    // Every file this stream ever opens needs the guard, not just the first:
    // an unhandled 'error' on a log file would take the daemon down with it,
    // and a daemon that dies because its log filled is worse than one that
    // limps.
    out.on('error', (error: Error) => {
      if (!stream.destroyed) {
        stream.destroy(error);
      }
    });
  };

  const reopen = (): void => {
    out.end();
    roll(file, keep);
    size = 0;
    open();
  };

  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      const bytes = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(String(chunk), 'utf8');

      // `size > 0` keeps a single write that is bigger than the cap on its own
      // from rolling an empty file and then still exceeding it — it goes out
      // whole, and the next write rolls.
      if (size > 0 && size + bytes.length > maxBytes) {
        reopen();
      }

      size += bytes.length;
      out.write(bytes, callback);
    },

    final(callback) {
      out.end(() => {
        callback();
      });
    },
  });

  open();

  return stream;
}
