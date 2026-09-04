/**
 * `rocky logs [-f]` (NG-595).
 *
 * The log is a file rather than something the daemon streams, so this reads it
 * directly: a developer must be able to read why the daemon would not start,
 * which is exactly the moment there is no daemon to ask.
 */
import { createReadStream, watch, type FSWatcher } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';

import { DEFAULT_KEEP, rotatedLogFiles, type RockyPaths } from '@rocky/daemon';

export interface LogsOptions {
  /** How many lines of history to print. */
  lines?: number;
  /** Keep printing as the daemon writes. */
  follow?: boolean;
  keep?: number;
  /** Resolves to stop following. The CLI ties this to SIGINT. */
  until?: Promise<void>;
  /** How often to look for new bytes. */
  intervalMs?: number;
}

const DEFAULT_LINES = 200;
const DEFAULT_INTERVAL_MS = 200;

/** Size and identity together: a rotation changes the second, not always the first. */
async function statOf(file: string): Promise<{ size: number; ino: number }> {
  try {
    const found = await stat(file);
    return { size: found.size, ino: found.ino };
  } catch {
    return { size: 0, ino: 0 };
  }
}

async function sizeOf(file: string): Promise<number> {
  return (await statOf(file)).size;
}

async function linesOf(file: string): Promise<string[]> {
  if ((await sizeOf(file)) === 0) {
    return [];
  }

  const collected: string[] = [];
  const reader = createInterface({
    input: createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of reader) {
    collected.push(line);
  }
  return collected;
}

/**
 * The tail of the log, reaching back into the rotated files when the live one
 * is shorter than what was asked for — the rotation must not swallow the
 * context a developer came looking for.
 */
export async function readTail(
  paths: RockyPaths,
  options: LogsOptions = {},
): Promise<string[]> {
  const wanted = options.lines ?? DEFAULT_LINES;
  const files = rotatedLogFiles(paths.daemonLog, options.keep ?? DEFAULT_KEEP);

  const collected: string[] = [];
  // Newest first, walking back through the rotations until we have enough.
  for (const file of files) {
    collected.unshift(...(await linesOf(file)));
    if (collected.length >= wanted) {
      break;
    }
  }

  return collected.slice(-wanted);
}

/**
 * Follows the live file. Reopens from the start when it shrinks, which is what
 * a rotation looks like from here — otherwise `-f` goes silent the moment the
 * log rolls, exactly when something interesting is happening.
 */
export async function followLog(
  paths: RockyPaths,
  emit: (line: string) => void,
  options: LogsOptions = {},
): Promise<void> {
  const start = await statOf(paths.daemonLog);
  let offset = start.size;
  let ino = start.ino;
  let pending = '';

  const drain = async (): Promise<void> => {
    const { size, ino: current } = await statOf(paths.daemonLog);

    // A rotation renames the live file aside and creates a new one, so the
    // inode changes even when the replacement is already longer than what we
    // had read. Size alone would resume mid-line in the new file.
    if (current !== ino || size < offset) {
      offset = 0;
      pending = '';
      ino = current;
    }
    if (size === offset) {
      return;
    }

    let handle;
    try {
      handle = await open(paths.daemonLog, 'r');
    } catch {
      return;
    }

    try {
      const buffer = Buffer.alloc(size - offset);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      offset += bytesRead;
      pending += buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }

    const complete = pending.lastIndexOf('\n') + 1;
    if (complete === 0) {
      return;
    }
    for (const line of pending.slice(0, complete).split('\n')) {
      if (line !== '') {
        emit(line);
      }
    }
    pending = pending.slice(complete);
  };

  // The watcher and the poll both ask for a drain, and `drain` awaits inside.
  // Run concurrently they would both read from the same offset and emit every
  // line twice, so they are chained instead of fired.
  let chain = Promise.resolve();
  const schedule = (): Promise<void> => {
    chain = chain.then(drain, () => undefined);
    return chain;
  };

  let watcher: FSWatcher | undefined;
  try {
    // Watching the directory, not the file: a rotation replaces the inode, and
    // a watch on the old one stops seeing anything.
    watcher = watch(paths.logsDir, () => void schedule());
  } catch {
    // No directory to watch yet; the poll below still finds the file when the
    // daemon creates it.
  }

  const timer = setInterval(
    () => void schedule(),
    options.intervalMs ?? DEFAULT_INTERVAL_MS,
  );

  try {
    await (options.until ?? new Promise<void>(() => undefined));
  } finally {
    clearInterval(timer);
    watcher?.close();
    // Whatever landed between the last poll and the stop.
    await schedule();
  }
}
