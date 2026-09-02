/**
 * Reading and writing the two files (NG-578).
 *
 * Cyrus's lesson is the whole design brief here: it had no hot reload, tokens
 * inline in one file, and a graveyard of hand-made `.bak` copies because a
 * half-written config was a real way to lose a machine's setup. So every write
 * here is atomic — temp file, then rename — and `credentials.json` is 0600
 * from the moment it exists, temp file included.
 */
import {
  chmod,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import type { RockyPaths } from './paths.js';
import {
  ConfigError,
  parseCredentials,
  parseInstanceConfig,
  type Credentials,
  type InstanceConfig,
} from './schema.js';

/** `credentials.json`, and the temp file it is renamed from. */
const SECRET_MODE = 0o600;
/** `config.json` — no secrets in it, and the web UI shows it. */
const CONFIG_MODE = 0o644;
/** The root holds `credentials.json`, so it is nobody else's business. */
const ROOT_MODE = 0o700;

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

/**
 * Write, then rename over the target. The rename is atomic within a
 * directory, so a reader sees either the old file or the new one and never a
 * half-written one — which is what the `.bak` habit was working around.
 */
async function writeAtomic(
  path: string,
  contents: string,
  mode: number,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: ROOT_MODE });

  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  try {
    // The mode goes on at creation: a rename keeps the temp file's mode, so a
    // 0644 temp file would leak the secrets for as long as it existed.
    await writeFile(temp, contents, { mode });
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }

  if (POSIX) {
    // `writeFile`'s mode applies only when it creates the file, so a reused
    // temp name would otherwise keep whatever mode it had before.
    await chmod(path, mode);
  }
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
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
  const parsed = parseCredentials(credentials);
  await writeAtomic(paths.credentialsFile, serialize(parsed), SECRET_MODE);
  return parsed;
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
    mode = (await stat(path)).mode & 0o777;
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
