/**
 * Write, then rename over the target.
 *
 * Cyrus's graveyard of hand-made `.bak` copies is the design brief: a
 * half-written file under `~/.rocky` is a real way to lose a machine's setup,
 * or a Run's header. The rename is atomic within a directory, so a reader sees
 * either the old file or the new one and never a partial one.
 *
 * Extracted from `config/store.ts` when `run.json` became the second caller
 * (NG-596) — this is one correctness-critical primitive, not two.
 */
import { chmod, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/** `credentials.json`, and the temp file it is renamed from. */
export const SECRET_MODE = 0o600;
/** `config.json` and `run.json` — no secrets in them, and the web UI shows them. */
export const PUBLIC_MODE = 0o644;
/** The root holds `credentials.json`, so it is nobody else's business. */
export const ROOT_MODE = 0o700;

const POSIX = process.platform !== 'win32';

export async function writeAtomic(
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

/** `JSON.stringify` with the trailing newline a hand-editable file wants. */
export function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
