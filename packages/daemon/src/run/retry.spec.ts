import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { runBoot, type BootContext } from './replay.js';
import { readJournal, JOURNAL_FORMAT_VERSION } from './journal.js';
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
it('retries only failed parallel work, retaining completed Steps and the original failure history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rocky-retry-'));
  roots.push(root);
  const path = join(root, 'journal.jsonl');
  let fail = true,
    before = 0,
    good = 0,
    failed = 0;
  const workflow = async (ctx: BootContext) => {
    await ctx.step('exec', {}, async () => {
      before++;
      return { status: 'done', result: 'prepared' };
    });
    await ctx.parallel('review', [0, 1], {}, async (branch, index) => {
      await branch.step('agent', {}, async () => {
        if (!index) {
          failed++;
          if (fail) throw new Error('database is locked');
        } else good++;
        return { status: 'done', result: 'reviewed' };
      });
    });
    return 'completed' as const;
  };
  expect((await runBoot({ journalPath: path, workflow })).status).toBe(
    'failed',
  );
  const original = await readFile(path, 'utf8');
  await appendFile(
    path,
    JSON.stringify({
      v: JOURNAL_FORMAT_VERSION,
      kind: 'retry',
      requestId: 'retry-1',
      stepKey: '1',
      recordedAt: new Date().toISOString(),
    }) + '\n',
  );
  fail = false;
  expect((await runBoot({ journalPath: path, workflow })).status).toBe(
    'finished',
  );
  expect({ before, good, failed }).toEqual({ before: 1, good: 1, failed: 2 });
  expect((await readFile(path, 'utf8')).startsWith(original)).toBe(true);
  expect((await readJournal(path)).getControl('retry:retry-1')).toMatchObject({
    stepKey: '1',
  });
});

it('rejects retries of completed Steps, unsafe effects, structural failures, and Steps with downstream work', async () => {
  const { retryStepKey } = await import('./retry.js');
  const base = {
    v: 1,
    seq: 0,
    step: 'agent',
    status: 'failed' as const,
    boot: 1,
    startedAt: '2026-09-11T10:00:00Z',
    error: { name: 'Error', message: 'failed' },
  };
  const end = { ...base, seq: 2, step: '$end', result: { status: 'failed' } };
  expect(retryStepKey([base, end])).toBe('0');
  for (const change of [
    { status: 'done' as const },
    { step: 'scm:merge' },
    { error: { name: 'FatalStepError', message: 'no' } },
  ])
    expect(retryStepKey([{ ...base, ...change }, end])).toBeUndefined();
  expect(
    retryStepKey([base, { ...base, seq: 1, status: 'done' }, end]),
  ).toBeUndefined();
  expect(retryStepKey([base])).toBeUndefined();
  expect(
    retryStepKey([base, { ...end, result: { status: 'finished' } }]),
  ).toBeUndefined();
});
it('writer retries are durable, idempotent, and recover a stale terminal header', async () => {
  const { JournalWriter } = await import('./writer.js');
  const { newRunHeader, reconcileHeader } = await import('./header.js');
  const root = await mkdtemp(join(tmpdir(), 'rocky-retry-'));
  roots.push(root);
  const path = join(root, 'journal.jsonl');
  await runBoot({
    journalPath: path,
    workflow: async (ctx) => {
      await ctx.step('exec', {}, async () => {
        throw new Error('transient');
      });
      return 'completed';
    },
  });
  const writer = await JournalWriter.open(path);
  await writer.retry('retry-request', '0');
  const bytes = await readFile(path, 'utf8');
  await writer.retry('retry-request', '0');
  expect(await readFile(path, 'utf8')).toBe(bytes);
  await writer.put('after-retry', true);
  const journal = await readJournal(path);
  expect(journal.end).toBeUndefined();
  expect(journal.getControl('after-retry')).toBe(true);
  const header = newRunHeader({
    runId: 'NG-1-1',
    repo: 'repo',
    branch: 'branch',
    issue: {
      identifier: 'NG-1',
      title: '',
      description: '',
      url: '',
      labels: [],
    },
    now: '2026-09-11T10:00:00Z',
  });
  expect(
    reconcileHeader(
      { ...header, status: 'failed', error: { name: 'Error', message: 'old' } },
      journal,
    ),
  ).toMatchObject({ status: 'queued', error: undefined });
});
