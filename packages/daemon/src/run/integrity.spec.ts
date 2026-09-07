import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { appendEntry, openJournal, type JournalEntry } from './journal.js';
import { runBoot } from './replay.js';

let dir: string;
let path: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rocky-integrity-'));
  path = join(dir, 'journal.jsonl');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const end: JournalEntry = {
  v: 1,
  seq: 1,
  step: '$end',
  status: 'done',
  boot: 1,
  startedAt: '2026-09-07T10:00:00.000Z',
  result: { status: 'finished', outcome: 'merged' },
};

it.each([
  { ...end, result: undefined },
  { ...end, status: 'running' },
  { ...end, status: 'waiting' },
  { ...end, result: { status: 'finished', outcome: 'invented' } },
  { ...end, result: { status: 'cancelled', extra: true } },
  { ...end, status: 'failed' },
])('rejects malformed terminal state before trusting it: %j', async (entry) => {
  const text = `${JSON.stringify(entry)}\n`;
  await writeFile(path, text);
  await expect(
    runBoot({ journalPath: path, workflow: async () => 'merged' }),
  ).rejects.toThrow(/\$end/);
  expect(await readFile(path, 'utf8')).toBe(text);
});

it('rejects any complete entry after the terminal record', async () => {
  await writeFile(
    path,
    [end, { ...end, seq: 2, step: 'exec' }]
      .map((e) => JSON.stringify(e) + '\n')
      .join(''),
  );
  await expect(openJournal(path)).rejects.toThrow(/after.*\$end/);
});

it('rejects terminal records inside a parallel branch', async () => {
  await expect(
    appendEntry(
      path,
      {
        ...end,
        step: '$parallel',
        parallel: { count: 1, branches: [[end]] },
      },
      { runner: true },
    ),
  ).rejects.toThrow(/\$end/);
});

it('rejects raw concurrent Steps and waits for the in-flight effect before writing $end', async () => {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let touched = false;
  let entered!: () => void;
  const entering = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const boot = runBoot({
    journalPath: path,
    workflow: async (ctx) => {
      const one = ctx.step('one', {}, async () => {
        entered();
        await waiting;
        touched = true;
        return { status: 'done', result: null };
      });
      await entering;
      try {
        await ctx.step('two', {}, async () => ({
          status: 'done',
          result: null,
        }));
      } finally {
        release();
        await one;
      }
      return 'merged';
    },
  });
  expect(await boot).toMatchObject({
    status: 'failed',
    error: { name: 'DivergenceError' },
  });
  expect(touched).toBe(true);
  expect((await openJournal(path)).entries.at(-1)?.step).toBe('$end');
});
