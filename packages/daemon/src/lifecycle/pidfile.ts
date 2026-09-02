/**
 * `~/.rocky/daemon.pid` (NG-595).
 *
 * It holds JSON rather than the bare number the name suggests, because a bare
 * number is not enough to talk to the daemon: `--port 0` is a real way to
 * start one, and `rocky stop` has to reach whatever it actually bound. The
 * name stays `daemon.pid` because NG-578's layout names it that.
 *
 * The file is a hint, never an authority. Every reader goes through
 * `inspectPidFile`, which asks the operating system whether the pid is still a
 * process before believing a word of it — NG-595's "a stale pidfile is
 * detected, not obeyed".
 */
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import type { RockyPaths } from '../config/paths.js';

/** What a running daemon records about itself. */
export interface DaemonRecord {
  pid: number;
  host: string;
  /** The port actually bound, which differs from the request when it was 0. */
  port: number;
  url: string;
  version: string;
  startedAt: string;
}

export type PidFileState =
  | { state: 'none' }
  /** A file that is not a record this version can read. */
  | { state: 'unreadable'; reason: string }
  /** A record whose process is gone. */
  | { state: 'stale'; record: DaemonRecord; reason: string }
  | { state: 'running'; record: DaemonRecord };

export interface InspectOptions {
  /** Injected by the tests; production asks the kernel. */
  isAlive?(pid: number): boolean;
}

/**
 * Signal 0 performs the permission and existence checks without delivering
 * anything. `EPERM` means the process exists and belongs to somebody else,
 * which for our purposes is still "alive" — a stop will fail loudly rather
 * than the pidfile being silently overwritten.
 */
export function pidIsAlive(pid: number): boolean {
  // `kill(0, …)` addresses the caller's whole process group and `kill(-1, …)`
  // every process it may signal, so neither is a pid we can probe.
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isRecord(value: unknown): value is DaemonRecord {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<DaemonRecord>;
  return (
    typeof candidate.pid === 'number' &&
    typeof candidate.host === 'string' &&
    typeof candidate.port === 'number' &&
    typeof candidate.url === 'string'
  );
}

/**
 * The record, or `undefined` for anything that is not one. A pidfile left by a
 * killed daemon, a half-written one, or one from a version that wrote a bare
 * number are all the same to a caller: there is nothing here to obey.
 */
export async function readPidFile(
  paths: RockyPaths,
): Promise<DaemonRecord | undefined> {
  let text: string;
  try {
    text = await readFile(paths.pidFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }

  return isRecord(parsed) ? parsed : undefined;
}

/**
 * Written atomically, like the config files: `rocky status` running while a
 * daemon boots must see either no pidfile or a complete one, never a prefix
 * that happens to parse.
 */
export async function writePidFile(
  paths: RockyPaths,
  record: DaemonRecord,
): Promise<void> {
  await mkdir(dirname(paths.pidFile), { recursive: true, mode: 0o700 });

  const temp = join(
    dirname(paths.pidFile),
    `.${basename(paths.pidFile)}.${process.pid}.tmp`,
  );
  try {
    await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`);
    await rename(temp, paths.pidFile);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

export interface RemoveOptions {
  /**
   * Remove only if the file still names this pid. A slow `stop` must not
   * delete the pidfile a `restart` has already written for the daemon that
   * replaced it.
   */
  pid?: number;
}

export async function removePidFile(
  paths: RockyPaths,
  options: RemoveOptions = {},
): Promise<void> {
  if (options.pid !== undefined) {
    const record = await readPidFile(paths);
    if (record !== undefined && record.pid !== options.pid) {
      return;
    }
  }

  await unlink(paths.pidFile).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  });
}

/** The pidfile checked against the process table. */
export async function inspectPidFile(
  paths: RockyPaths,
  options: InspectOptions = {},
): Promise<PidFileState> {
  const isAlive = options.isAlive ?? pidIsAlive;
  const record = await readPidFile(paths);

  if (record === undefined) {
    // Telling "never written" from "written but unusable" matters: the second
    // is a file a human may need to delete by hand.
    try {
      await readFile(paths.pidFile, 'utf8');
    } catch {
      return { state: 'none' };
    }
    return {
      state: 'unreadable',
      reason: `${paths.pidFile} is not a pidfile Rocky wrote — delete it and run \`rocky start -d\``,
    };
  }

  if (!isAlive(record.pid)) {
    return {
      state: 'stale',
      record,
      reason: `${paths.pidFile} names pid ${record.pid}, which is not running — the daemon died without cleaning up. \`rocky start -d\` will replace it.`,
    };
  }

  return { state: 'running', record };
}
