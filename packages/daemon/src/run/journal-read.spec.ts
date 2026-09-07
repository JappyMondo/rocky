import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { readJournal } from './journal.js';

it("reads complete records without repairing a live writer's unfinished tail", async () => {
  const root = await mkdtemp(join(tmpdir(), 'rocky-journal-reader-'));
  const path = join(root, 'journal.jsonl');
  try {
    const text =
      '{"v":1,"seq":0,"step":"agent","status":"running","boot":1,"startedAt":"2026-09-07T12:00:00Z"}\n{"v":1';
    await writeFile(path, text);
    const journal = await readJournal(path);
    expect(journal.entries).toHaveLength(1);
    expect(journal.truncated).toBe(true);
    expect(await readFile(path, 'utf8')).toBe(text);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
