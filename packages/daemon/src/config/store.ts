/**
 * Reading and writing the two files (NG-578).
 *
 * Cyrus's lesson is the whole design brief here: it had no hot reload, tokens
 * inline in one file, and a graveyard of hand-made `.bak` copies because a
 * half-written config was a real way to lose a machine's setup. So every write
 * here is atomic — temp file, then rename, in `../atomic-write.ts` — and
 * `credentials.json` is 0600 from the moment it exists, temp file included.
 */
import { chmod, lstat, mkdir, readFile } from 'node:fs/promises';
import lockfile from 'proper-lockfile';

import {
  PUBLIC_MODE as CONFIG_MODE,
  ROOT_MODE,
  SECRET_MODE,
  serializeJson as serialize,
  writeAtomic,
} from '../atomic-write.js';
import type { RockyPaths } from './paths.js';
import {
  ConfigError,
  parseCredentials,
  parseInstanceConfig,
  type Credentials,
  type InstanceConfig,
} from './schema.js';

const POSIX = process.platform !== 'win32';

export interface ReadOptions {
  /** Where a fixed-at-boot warning goes. The daemon log, in production. */
  warn?(message: string): void;
}

/** Creates `~/.rocky` and the directories NG-578's layout names. */
export async function ensureInstanceLayout(paths: RockyPaths): Promise<void> {
  await mkdir(paths.root, { recursive: true, mode: ROOT_MODE });
  // `mkdir` only applies the mode when it creates, so an existing root that
  // predates this rule is tightened rather than left as it was found.
  if (POSIX) {
    await chmod(paths.root, ROOT_MODE);
  }

  for (const dir of [paths.logsDir, paths.reposDir, paths.runsDir]) {
    await mkdir(dir, { recursive: true });
  }
}

async function readJson(
  path: string,
  file: string,
): Promise<unknown | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new ConfigError(
      file,
      `is not valid JSON — ${withoutQuotedInput((error as Error).message)}`,
    );
  }
}

/**
 * Node quotes the offending input back at you — `Unexpected token 'o',
 * "sk-live-…" is not valid JSON`. This error reaches the daemon log, and
 * `credentials.json` comes through the same function, so the snippet goes and
 * the locator stays.
 */
function withoutQuotedInput(message: string): string {
  return message.replace(/"[^"]*"/g, '…');
}

export async function readInstanceConfig(
  paths: RockyPaths,
): Promise<InstanceConfig> {
  const raw = await readJson(paths.configFile, 'config.json');
  return parseInstanceConfig(raw ?? {});
}

export async function writeInstanceConfig(
  paths: RockyPaths,
  config: unknown,
): Promise<InstanceConfig> {
  const parsed = parseInstanceConfig(config);
  await writeAtomic(paths.configFile, serialize(parsed), CONFIG_MODE);
  return parsed;
}

/**
 * Reads `credentials.json`, tightening its mode first if a hand-edit, an
 * editor's save-by-copy or a restore from backup widened it. Fixing beats
 * warning: a warning in a log nobody reads leaves the tokens readable.
 */
export async function readCredentials(
  paths: RockyPaths,
  options: ReadOptions = {},
): Promise<Credentials> {
  await enforceSecretMode(paths.credentialsFile, options.warn);

  const raw = await readJson(paths.credentialsFile, 'credentials.json');
  return parseCredentials(raw ?? {});
}

export async function writeCredentials(
  paths: RockyPaths,
  credentials: unknown,
): Promise<Credentials> {
  return updateCredentials(paths, () => credentials);
}

/** All read-modify-write callers must use this, including rotating OAuth tokens.
 * The lock spans processes (CLI and Boots), and covers the refresh request too.
 * Never wait for human input inside the callback.
 */
export async function updateCredentials(
  paths: RockyPaths,
  update: (current: Credentials) => unknown | Promise<unknown>,
): Promise<Credentials> {
  await mkdir(paths.root, { recursive: true, mode: ROOT_MODE });
  if (POSIX) await chmod(paths.root, ROOT_MODE);
  let compromised = false;
  const release = await lockfile.lock(paths.credentialsFile, {
    realpath: false,
    stale: 30_000,
    update: 10_000,
    retries: { retries: 200, minTimeout: 25, maxTimeout: 100, factor: 1.2 },
    onCompromised: () => {
      compromised = true;
    },
  });
  try {
    const current = await readCredentials(paths);
    const before = serialize(current);
    const next = await update(current);
    const parsed = parseCredentials(next);
    if (compromised)
      throw new ConfigError(
        'credentials.json',
        'update lock was lost; retry the command.',
      );
    if (next !== current || serialize(parsed) !== before)
      await writeAtomic(paths.credentialsFile, serialize(parsed), SECRET_MODE);
    return parsed;
  } finally {
    await release();
  }
}

async function enforceSecretMode(
  path: string,
  warn?: (message: string) => void,
): Promise<void> {
  if (!POSIX) {
    return;
  }

  let mode: number;
  try {
    const info = await lstat(path);
    if (!info.isFile())
      throw new ConfigError(
        'credentials.json',
        'must be a regular file, not a symlink.',
      );
    mode = info.mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }

  if (mode === SECRET_MODE) {
    return;
  }

  await chmod(path, SECRET_MODE);
  warn?.(
    `credentials.json was mode 0${mode.toString(8).padStart(3, '0')} — tightened to 0600. It holds Linear tokens and per-repo secrets.`,
  );
}
