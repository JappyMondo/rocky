import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { runBoot, type BootContext } from './replay.js';
import { readJournal, JOURNAL_FORMAT_VERSION } from './journal.js';
const roots: string[] = [];
it('retries failed UI startup rather than its blocked complaint writer, retaining earlier work and journal bytes', async () => {
  const { JournalWriter } = await import('./writer.js');
  const { retryStepKey } = await import('./retry.js');
  const root = await mkdtemp(join(tmpdir(), 'rocky-ui-retry-'));
  roots.push(root);
  const path = join(root, 'journal.jsonl');
  let ready = false,
    implementations = 0,
    launches = 0,
    inspections = 0;
  const workflow = async (ctx: BootContext) => {
    await ctx.step('agent', { label: 'implementation' }, async () => {
      implementations++;
      return { status: 'done', result: null };
    });
    await ctx.step(
      'exec:background',
      { label: 'dev server', replay: 'restart' },
      async () => {
        launches++;
        return { status: 'done', result: { pid: 123 } };
      },
    );
    const boot = await ctx.step(
      'step',
      { label: 'UI readiness 1/1' },
      async () => ({ status: 'done', result: { ready } }),
    );
    if (!boot.ready) {
      await ctx.step('exec', { label: 'stop failed dev server' }, async () => ({
        status: 'done',
        result: { exitCode: 0 },
      }));
      await ctx.parallel('parallel', [0], {}, async (branch) => {
        await branch.step('agent', {}, async () => {
          throw new Error('Cannot attribute infrastructure failure to code');
        });
      });
    } else {
      await ctx.step('agent', { label: 'inspect UI' }, async () => {
        inspections++;
        return { status: 'done', result: null };
      });
    }
    return 'completed' as const;
  };
  expect(await runBoot({ journalPath: path, workflow })).toMatchObject({
    status: 'failed',
  });
  const original = await readFile(path, 'utf8');
  expect(retryStepKey((await readJournal(path)).entries)).toBe('1');
  await (await JournalWriter.open(path)).retry('repair-startup', '1');
  ready = true;
  expect(await runBoot({ journalPath: path, workflow })).toMatchObject({
    status: 'finished',
  });
  expect({ implementations, launches, inspections }).toEqual({
    implementations: 1,
    launches: 2,
    inspections: 1,
  });
  expect((await readFile(path, 'utf8')).startsWith(original)).toBe(true);
});
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
it('reruns a final nonzero exec result instead of replaying its cached failure, retaining legacy finalization retries', async () => {
  const { JournalWriter } = await import('./writer.js');
  const { retryStepKey } = await import('./retry.js');
  const root = await mkdtemp(join(tmpdir(), 'rocky-retry-exit-'));
  roots.push(root);
  const path = join(root, 'journal.jsonl');
  let commands = 0;
  let prepared = 0;
  let fixed = false;
  const workflow = async (ctx: BootContext) => {
    await ctx.step('agent', {}, async () => {
      prepared++;
      return { status: 'done', result: 'commit ready' };
    });
    const result = await ctx.step('exec', {}, async () => {
      commands++;
      return {
        status: 'done',
        result: {
          exitCode: fixed ? 0 : 1,
          stdout: '',
          stderr: fixed ? '' : 'push rejected',
        },
      };
    });
    if (result.exitCode !== 0) throw new Error(result.stderr);
    return 'completed' as const;
  };
  expect((await runBoot({ journalPath: path, workflow })).status).toBe(
    'failed',
  );
  // Old versions retried only $end, leaving the cached exitCode: 1 intact.
  await appendFile(
    path,
    JSON.stringify({
      v: JOURNAL_FORMAT_VERSION,
      kind: 'retry',
      requestId: 'legacy',
      stepKey: '2',
      recordedAt: new Date().toISOString(),
    }) + '\n',
  );
  expect((await runBoot({ journalPath: path, workflow })).status).toBe(
    'failed',
  );
  expect(commands).toBe(1);
  const history = await readFile(path, 'utf8');
  expect(retryStepKey((await readJournal(path)).entries)).toBe('1');
  await (await JournalWriter.open(path)).retry('retry-command', '1');
  fixed = true;
  expect((await runBoot({ journalPath: path, workflow })).status).toBe(
    'finished',
  );
  expect({ commands, prepared }).toEqual({ commands: 2, prepared: 1 });
  expect((await readFile(path, 'utf8')).startsWith(history)).toBe(true);
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

it('offers explicit retries for failed Steps and finalization, without invalidating downstream work', async () => {
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
    { step: 'scm:merge' },
    { status: 'running' as const },
    { error: { name: 'FatalStepError', message: 'no' } },
  ])
    expect(retryStepKey([{ ...base, ...change }, end])).toBe('0');
  expect(retryStepKey([{ ...base, status: 'done' }, end])).toBe('2');
  expect(retryStepKey([end])).toBe('2');
  expect(
    retryStepKey([
      { ...base, step: 'exec', status: 'done', result: { exitCode: 1 } },
      { ...base, seq: 1, status: 'done' },
      end,
    ]),
  ).toBe('2');
  expect(
    retryStepKey([base, { ...base, seq: 1, status: 'done' }, end]),
  ).toBeUndefined();
  expect(retryStepKey([base])).toBeUndefined();
  expect(
    retryStepKey([base, { ...end, result: { status: 'finished' } }]),
  ).toBeUndefined();
});
it('retries an unjournaled delivery failure repeatedly, preserving completed work and history', async () => {
  const { JournalWriter } = await import('./writer.js');
  const { retryStepKey } = await import('./retry.js');
  const root = await mkdtemp(join(tmpdir(), 'rocky-retry-'));
  roots.push(root);
  const path = join(root, 'journal.jsonl');
  let prepared = 0;
  let deliveries = 0;
  const workflow = async (ctx: BootContext) => {
    await ctx.step('exec', {}, async () => {
      prepared++;
      return { status: 'done', result: 'prepared' };
    });
    if (++deliveries < 3) throw new Error('push rejected');
    return 'completed' as const;
  };
  expect((await runBoot({ journalPath: path, workflow })).status).toBe(
    'failed',
  );
  const original = await readFile(path, 'utf8');
  for (let attempt = 1; attempt <= 2; attempt++) {
    const journal = await readJournal(path);
    expect(retryStepKey(journal.entries)).toBe(String(journal.end?.seq));
    const writer = await JournalWriter.open(path);
    await writer.retry(`delivery-${attempt}`, String(journal.end?.seq));
    await writer.retry(`delivery-${attempt}`, String(journal.end?.seq));
    expect((await readJournal(path)).end).toBeUndefined();
    expect((await readJournal(path)).nextBoot).toBe(attempt + 1);
    expect((await runBoot({ journalPath: path, workflow })).status).toBe(
      attempt === 1 ? 'failed' : 'finished',
    );
  }
  expect({ prepared, deliveries }).toEqual({ prepared: 1, deliveries: 3 });
  expect((await readFile(path, 'utf8')).startsWith(original)).toBe(true);
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
