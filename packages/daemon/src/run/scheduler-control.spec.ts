import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { rockyPaths, type RockyPaths } from '../config/paths.js';
import { parseInstanceConfig } from '../config/schema.js';
import { newRunHeader, readRunHeader, writeRunHeader } from './header.js';
import { openJournal } from './journal.js';
import { WorkflowRuntime } from './lifecycle.js';
import { runBoot } from './replay.js';
import { RunScheduler, nextPoll } from './scheduler.js';

let dir: string;
let paths: RockyPaths;
let runtime: WorkflowRuntime | undefined;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rocky-scheduler-control-'));
  paths = rockyPaths(dir);
});
afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
  await rm(dir, { recursive: true, force: true });
});
function input(id: string) {
  return {
    repo: 'rocky',
    branch: id.toLowerCase(),
    issue: { identifier: id, title: '', description: '', url: '', labels: [] },
  };
}
function stored(id: string) {
  return newRunHeader({
    ...input(id),
    runId: `${id}-1`,
    now: '2026-09-07T10:00:00Z',
  });
}

it('uses default cap 3 and refuses invalid caps', async () => {
  expect(parseInstanceConfig({}).concurrency).toEqual({ maxRuns: 3 });
  for (const maxRuns of [0, -1, 1.5, NaN])
    await expect(
      RunScheduler.open({
        paths,
        maxRuns,
        boot: async () => {
          throw new Error();
        },
      }),
    ).rejects.toThrow(/maxRuns/);
});

it('refuses a manual Trigger while any older live Run exists', async () => {
  await writeRunHeader(paths, {
    ...stored('NG-540'),
    status: 'parked',
    reason: 'checkpoint',
  });
  await writeRunHeader(paths, {
    ...stored('NG-540'),
    runId: 'NG-540-2',
    status: 'finished',
    outcome: 'merged',
  });
  const scheduler = await RunScheduler.open({
    paths,
    boot: async () => {
      throw new Error('unexpected');
    },
  });
  await expect(
    scheduler.manual({ ...input('NG-540'), trigger: 'repair' }),
  ).rejects.toThrow(/NG-540-1/);
  expect(await scheduler.get('NG-540-3')).toBeUndefined();
});

it('polls a real waiting Step outside a saturated cap and requeues behind an existing waiter', async () => {
  let answered = false;
  const later: string[] = [];
  const release = new Map<string, () => void>();
  runtime = new WorkflowRuntime({
    paths,
    workspace: () => dir,
    loadWorkflow: async (run) => async (ctx) => {
      if (run.issue.identifier === 'NG-1')
        await ctx.checkpoint({ title: '', body: '' });
      await ctx.step('working', async () => {
        later.push(run.runId);
        await new Promise<void>((resolve) => release.set(run.runId, resolve));
        return null;
      });
      return 'merged';
    },
    external: (_run, steps) => ({
      checkpoint: () =>
        steps.step<{ decision: 'approve' }>('checkpoint', {}, async () =>
          answered
            ? { status: 'done', result: { decision: 'approve' } }
            : { status: 'waiting' },
        ),
    }),
  });
  const scheduler = await RunScheduler.open({
    paths,
    maxRuns: 3,
    boot: runtime.boot,
  });
  await scheduler.delegate(input('NG-1'));
  await scheduler.drain();
  await vi.waitFor(async () =>
    expect((await scheduler.get('NG-1-1'))?.status).toBe('parked'),
  );
  for (const id of ['NG-2', 'NG-3', 'NG-4', 'NG-5'])
    await scheduler.delegate(input(id));
  await scheduler.drain();
  await vi.waitFor(() => expect(later).toHaveLength(3));
  answered = true;
  await Promise.all([scheduler.poll('NG-1-1'), scheduler.poll('NG-1-1')]);
  expect((await scheduler.get('NG-1-1'))?.status).toBe('queued');
  expect(
    (await openJournal(paths.run('NG-1-1').journal)).latest(0)?.status,
  ).toBe('done');
  expect(later).not.toContain('NG-1-1');
  release.get('NG-2-1')!();
  await vi.waitFor(() => expect(later[3]).toBe('NG-5-1'));
  release.get('NG-3-1')!();
  await vi.waitFor(() => expect(later[4]).toBe('NG-1-1'));
  for (const resume of release.values()) resume();
  await vi.waitFor(async () =>
    expect((await scheduler.get('NG-1-1'))?.status).toBe('finished'),
  );
});

it('persists cancellation intent, kills a real child, preserves work, then records one cancelled end', async () => {
  const events: string[] = [];
  let cleanupFails = true;
  runtime = new WorkflowRuntime({
    paths,
    workspace: () => dir,
    loadWorkflow: async () => async (ctx) => {
      await ctx.exec('sleep 600');
      return 'merged';
    },
  });
  const scheduler = await RunScheduler.open({
    paths,
    boot: runtime.boot,
    cancellation: {
      kill: async (run) => {
        events.push('kill');
        await runtime!.kill(run);
      },
      cleanup: async () => {
        events.push('push');
        if (cleanupFails) throw new Error('push failed');
        events.push('draft+comment', 'remove-worktree');
      },
    },
  });
  await scheduler.delegate(input('NG-1'));
  await scheduler.drain();
  await vi.waitFor(async () =>
    expect(await readFile(paths.run('NG-1-1').journal, 'utf8')).toContain(
      '"running"',
    ),
  );
  await expect(scheduler.stop('NG-1-1')).rejects.toThrow('push failed');
  expect(
    (await readRunHeader(paths, 'NG-1-1')).cancelRequestedAt,
  ).toBeDefined();
  expect((await openJournal(paths.run('NG-1-1').journal)).end).toBeUndefined();
  cleanupFails = false;
  await Promise.all([scheduler.stop('NG-1-1'), scheduler.stop('NG-1-1')]);
  expect(events).toEqual([
    'kill',
    'push',
    'kill',
    'push',
    'draft+comment',
    'remove-worktree',
  ]);
  expect((await scheduler.get('NG-1-1'))?.status).toBe('cancelled');
  expect((await openJournal(paths.run('NG-1-1').journal)).end?.result).toEqual({
    status: 'cancelled',
  });
  await expect(
    (await RunScheduler.open({ paths, boot: runtime.boot })).get('NG-1-1'),
  ).resolves.toMatchObject({ status: 'cancelled' });
});

it('routes stop at a Checkpoint to the Answer owner without cleanup', async () => {
  await writeRunHeader(paths, {
    ...stored('NG-1'),
    status: 'parked',
    reason: 'checkpoint',
  });
  const cleanup = vi.fn();
  const scheduler = await RunScheduler.open({
    paths,
    boot: async () => {
      throw new Error();
    },
    cancellation: { kill: cleanup, cleanup },
  });
  await expect(scheduler.stop('NG-1-1')).rejects.toThrow(/Answer/);
  expect(cleanup).not.toHaveBeenCalled();
});

it('retains live directories byte-for-byte and prunes terminal tiers by lead repo without reusing ids', async () => {
  const live = {
    ...stored('NG-1'),
    status: 'parked' as const,
    reason: 'checkpoint',
  };
  await writeRunHeader(paths, live);
  const liveBefore = await readFile(paths.run(live.runId).runJson, 'utf8');
  for (const [id, repo, time] of [
    ['NG-2', 'rocky', 1],
    ['NG-3', 'rocky', 2],
    ['NG-4', 'rocky', 3],
    ['NG-5', 'other', 1],
  ] as const) {
    const run = {
      ...stored(id),
      repo,
      status: 'finished' as const,
      outcome: 'merged' as const,
      endedAt: `2026-09-07T10:00:0${time}Z`,
    };
    await writeRunHeader(paths, run);
    for (const folder of ['sessions', 'screenshots', 'snapshot']) {
      const path = join(paths.run(run.runId).dir, folder);
      await mkdir(path);
      await writeFile(join(path, 'evidence'), 'kept');
    }
  }
  const scheduler = await RunScheduler.open({
    paths,
    boot: async () => {
      throw new Error();
    },
  });
  await scheduler.sweepRetention({
    keepTerminalRuns: 2,
    keepSessionsAndScreenshots: 1,
  });
  expect(await readFile(paths.run(live.runId).runJson, 'utf8')).toBe(
    liveBefore,
  );
  await expect(stat(paths.run('NG-2-1').dir)).rejects.toMatchObject({
    code: 'ENOENT',
  });
  await expect(stat(paths.run('NG-3-1').sessionsDir)).rejects.toMatchObject({
    code: 'ENOENT',
  });
  expect(
    await readFile(join(paths.run('NG-3-1').snapshotDir, 'evidence'), 'utf8'),
  ).toBe('kept');
  expect(
    await readFile(join(paths.run('NG-5-1').sessionsDir, 'evidence'), 'utf8'),
  ).toBe('kept');
  const reopened = await RunScheduler.open({
    paths,
    boot: async () => {
      throw new Error();
    },
  });
  expect(await reopened.delegate(input('NG-2'))).toMatchObject({
    run: { runId: 'NG-2-2' },
  });
});

it('uses checkpoint and CI polling cadences', () => {
  expect(nextPoll('checkpoint', 0)).toBe(300_000);
  expect([0, 1, 2, 3, 9].map((n) => nextPoll('scm:waitForCi', n))).toEqual([
    10_000, 20_000, 40_000, 60_000, 60_000,
  ]);
});

it('ticks due polls and retries a recovered cancellation without booting its Workflow', async () => {
  await writeRunHeader(paths, {
    ...stored('NG-1'),
    status: 'parked',
    reason: 'scm:waitForCi',
  });
  await writeRunHeader(paths, {
    ...stored('NG-2'),
    status: 'running',
    cancelRequestedAt: '2026-09-07T10:00:00Z',
  });
  let now = 0;
  const boot = vi.fn(async () => ({
    status: 'parked' as const,
    reason: 'scm:waitForCi',
    boot: 2,
    replayed: 0,
    executed: 1,
  }));
  const cleanup = vi.fn(async () => undefined);
  const scheduler = await RunScheduler.open({
    paths,
    boot,
    now: () => new Date(now),
    cancellation: { kill: cleanup, cleanup },
  });
  await scheduler.tick();
  expect(boot).not.toHaveBeenCalled();
  expect((await scheduler.get('NG-2-1'))?.status).toBe('cancelled');
  now = 10_000;
  await scheduler.tick();
  expect(boot).toHaveBeenCalledTimes(1);
  now = 29_999;
  await scheduler.tick();
  expect(boot).toHaveBeenCalledTimes(1);
  now = 30_000;
  await scheduler.tick();
  expect(boot).toHaveBeenCalledTimes(2);
});

it('never lets retention remove a terminal Run whose worktree still needs preservation', async () => {
  for (const id of ['NG-1', 'NG-2'])
    await writeRunHeader(paths, {
      ...stored(id),
      status: 'finished',
      outcome: 'merged',
    });
  await mkdir(paths.run('NG-1-1').workspaceDir);
  await writeFile(
    join(paths.run('NG-1-1').workspaceDir, 'unfinished'),
    'human work',
  );
  const scheduler = await RunScheduler.open({
    paths,
    boot: async () => {
      throw new Error();
    },
  });
  await scheduler.sweepRetention({
    keepTerminalRuns: 1,
    keepSessionsAndScreenshots: 1,
  });
  expect(
    await readFile(
      join(paths.run('NG-1-1').workspaceDir, 'unfinished'),
      'utf8',
    ),
  ).toBe('human work');
});

it('shutdown stops owned work but leaves it resumable, not cancelled', async () => {
  let entered!: () => void;
  const entering = new Promise<void>((resolve) => {
    entered = resolve;
  });
  runtime = new WorkflowRuntime({
    paths,
    workspace: () => dir,
    loadWorkflow: async () => async (ctx) => {
      entered();
      await ctx.exec('sleep 600');
      return 'merged';
    },
  });
  const scheduler = await RunScheduler.open({
    paths,
    boot: runtime.boot,
    cancellation: {
      kill: runtime.kill,
      cleanup: async () => {
        throw new Error('must not preserve on shutdown');
      },
    },
  });
  await scheduler.delegate(input('NG-1'));
  await scheduler.drain();
  await entering;
  await scheduler.close();
  expect((await openJournal(paths.run('NG-1-1').journal)).end).toBeUndefined();
  const reopened = await RunScheduler.open({ paths, boot: runtime.boot });
  expect((await reopened.get('NG-1-1'))?.status).toBe('queued');
});

it('refuses admission when a Run header names a different directory', async () => {
  const run = stored('NG-1');
  await writeRunHeader(paths, run);
  await writeFile(
    paths.run(run.runId).runJson,
    JSON.stringify({ ...run, runId: 'NG-1-2' }),
  );
  await expect(
    RunScheduler.open({
      paths,
      boot: async () => {
        throw new Error();
      },
    }),
  ).rejects.toThrow(/directory/);
});

it.each([false, true])(
  'recovers a loader failure from the terminal Journal with prior Steps=%s',
  async (priorSteps) => {
    const run = stored('NG-1');
    await writeRunHeader(paths, run);
    const journalPath = paths.run(run.runId).journal;
    if (priorSteps)
      await runBoot({
        journalPath,
        workflow: async (ctx) => {
          await ctx.step('read', {}, async () => ({
            status: 'done',
            result: { kept: true },
          }));
          await ctx.step('scm:waitForCi', {}, async () => ({
            status: 'waiting',
          }));
          return 'merged';
        },
      });
    const before = await openJournal(journalPath);
    const loadWorkflow = vi.fn(async (): Promise<never> => {
      throw new Error('snapshot module cannot load');
    });
    runtime = new WorkflowRuntime({ paths, loadWorkflow });
    const scheduler = await RunScheduler.open({ paths, boot: runtime.boot });
    await scheduler.drain();
    await vi.waitFor(async () =>
      expect((await scheduler.get(run.runId))?.status).toBe('failed'),
    );
    await scheduler.close();
    const journal = await openJournal(journalPath);
    expect(journal.entries.slice(0, before.entries.length)).toEqual(
      before.entries,
    );
    expect(journal.end).toMatchObject({
      step: '$end',
      status: 'failed',
      boot: before.nextBoot,
      result: {
        status: 'failed',
        error: { message: 'snapshot module cannot load' },
      },
    });
    expect(journal.entries).toHaveLength(before.entries.length + 1);
    // A stale header and a fresh scheduler must recover the failure without loading again.
    await writeRunHeader(paths, run);
    const recovered = await RunScheduler.open({ paths, boot: runtime.boot });
    expect(await recovered.get(run.runId)).toMatchObject({
      status: 'failed',
      error: { message: 'snapshot module cannot load' },
    });
    await recovered.drain();
    await recovered.close();
    expect(loadWorkflow).toHaveBeenCalledTimes(1);
  },
);

it('keeps the header-only failure exception when the Journal is unreadable', async () => {
  const loadWorkflow = vi.fn(async (): Promise<never> => {
    throw new Error('must not load');
  });
  runtime = new WorkflowRuntime({ paths, loadWorkflow });
  const scheduler = await RunScheduler.open({ paths, boot: runtime.boot });
  const { run } = await scheduler.delegate(input('NG-1'));
  const corrupt = 'invalid Journal\n';
  await writeFile(paths.run(run.runId).journal, corrupt);
  await scheduler.drain();
  await vi.waitFor(async () =>
    expect((await scheduler.get(run.runId))?.status).toBe('failed'),
  );
  await scheduler.close();
  expect((await readRunHeader(paths, run.runId)).error?.name).toBe(
    'JournalFormatError',
  );
  expect(await readFile(paths.run(run.runId).journal, 'utf8')).toBe(corrupt);
  expect(loadWorkflow).not.toHaveBeenCalled();
});

it('services other cancellation retries, due polls and queued Runs despite a persistent preservation failure', async () => {
  const intent = '2026-09-07T10:00:00Z';
  for (const id of ['NG-1', 'NG-2']) {
    await writeRunHeader(paths, { ...stored(id), cancelRequestedAt: intent });
  }
  const parked = {
    ...stored('NG-3'),
    status: 'parked' as const,
    reason: 'scm:waitForCi',
  };
  await writeRunHeader(paths, parked);
  await runBoot({
    journalPath: paths.run(parked.runId).journal,
    workflow: async (ctx) => {
      await ctx.step('scm:waitForCi', {}, async () => ({ status: 'waiting' }));
      return 'merged';
    },
  });
  await writeRunHeader(paths, stored('NG-4'));
  let now = 0;
  let unavailable = true;
  const polls: string[] = [];
  const admitted: string[] = [];
  const errors: unknown[] = [];
  const scheduler = await RunScheduler.open({
    paths,
    maxRuns: 1,
    now: () => new Date(now),
    onError: (error) => errors.push(error),
    boot: (run, kind, signal) =>
      runBoot({
        journalPath: paths.run(run.runId).journal,
        poll: kind === 'poll',
        signal,
        workflow: async (ctx) => {
          if (run.runId === parked.runId) {
            await ctx.step('scm:waitForCi', {}, async () => {
              polls.push(run.runId);
              return { status: 'waiting' };
            });
          } else {
            await ctx.step('work', {}, async () => {
              admitted.push(run.runId);
              return { status: 'done', result: null };
            });
          }
          return 'merged';
        },
      }),
    cancellation: {
      kill: async () => undefined,
      cleanup: async (run) => {
        if (run.runId === 'NG-1-1' && unavailable)
          throw new Error('NG-1 cannot push');
      },
    },
  });
  try {
    for (const due of [10_000, 30_000, 70_000]) {
      now = due;
      await expect(scheduler.tick()).resolves.toBeUndefined();
      expect((await readRunHeader(paths, 'NG-1-1')).cancelRequestedAt).toBe(
        intent,
      );
      expect(
        (await openJournal(paths.run('NG-1-1').journal)).end,
      ).toBeUndefined();
    }
    await vi.waitFor(async () =>
      expect((await scheduler.get('NG-4-1'))?.status).toBe('finished'),
    );
    expect(admitted).toEqual(['NG-4-1']);
    expect(polls).toEqual(['NG-3-1', 'NG-3-1', 'NG-3-1']);
    expect(errors).toHaveLength(3);
    for (const error of errors)
      expect(error).toMatchObject({ message: 'NG-1 cannot push' });
    expect(
      (await openJournal(paths.run('NG-2-1').journal)).end?.result,
    ).toEqual({ status: 'cancelled' });
    unavailable = false;
    await scheduler.tick();
    expect(
      (await openJournal(paths.run('NG-1-1').journal)).end?.result,
    ).toEqual({ status: 'cancelled' });
  } finally {
    await scheduler.close();
  }
});

it.each(['parked', 'failed'] as const)(
  'never retries an obsolete %s header over durable cancellation intent',
  async (status) => {
    const barrier = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    };
    const writing = barrier();
    const failWrite = barrier();
    const killing = barrier();
    const releaseKill = barrier();
    let delayed = false;
    let bootCalls = 0;
    let preserve = false;
    const writeError = new Error('result header write failed');
    const reported: unknown[] = [];
    const boot = async (
      run: ReturnType<typeof stored>,
      kind: 'run' | 'poll',
      signal: AbortSignal,
    ) => {
      bootCalls++;
      if (status === 'failed') throw new Error('Boot transport unavailable');
      return runBoot({
        journalPath: paths.run(run.runId).journal,
        poll: kind === 'poll',
        signal,
        workflow: async (ctx) => {
          await ctx.step('scm:waitForCi', {}, async () => ({
            status: 'waiting',
          }));
          return 'merged';
        },
      });
    };
    const cleanup = async () => {
      if (!preserve) throw new Error('push offline');
    };
    const scheduler = await RunScheduler.open({
      paths,
      boot,
      onError: (error) => reported.push(error),
      writeHeader: async (target, header) => {
        if (header.status === status && !header.cancelRequestedAt && !delayed) {
          delayed = true;
          writing.resolve();
          await failWrite.promise;
          throw writeError;
        }
        await writeRunHeader(target, header);
      },
      cancellation: {
        kill: async () => {
          killing.resolve();
          await releaseKill.promise;
        },
        cleanup,
      },
    });
    const { run } = await scheduler.delegate(input('NG-1'));
    await scheduler.drain();
    await writing.promise;
    // Queue stop behind the held write before letting the write reject.
    const stopping = scheduler.stop(run.runId);
    void stopping.catch(() => undefined);
    failWrite.resolve();
    try {
      await killing.promise;
      await scheduler.drain();
      const disk = await readRunHeader(paths, run.runId);
      expect(disk.cancelRequestedAt).toBeDefined();
      expect(await scheduler.get(run.runId)).toMatchObject({
        cancelRequestedAt: disk.cancelRequestedAt,
      });
      expect(reported).toContain(writeError);
      releaseKill.resolve();
      await expect(stopping).rejects.toThrow('push offline');
      await scheduler.drain();
      await scheduler.poll(run.runId);
      expect(bootCalls).toBe(1);
      expect(
        (await openJournal(paths.run(run.runId).journal)).end,
      ).toBeUndefined();
      await scheduler.close();
      // Recovery must retain the stop and retry preservation, never the old Boot.
      const recovered = await RunScheduler.open({
        paths,
        boot,
        onError: (error) => reported.push(error),
        cancellation: { kill: async () => undefined, cleanup },
      });
      try {
        await recovered.drain();
        await recovered.poll(run.runId);
        await recovered.tick();
        expect((await readRunHeader(paths, run.runId)).cancelRequestedAt).toBe(
          disk.cancelRequestedAt,
        );
        expect((await recovered.get(run.runId))?.cancelRequestedAt).toBe(
          disk.cancelRequestedAt,
        );
        expect(bootCalls).toBe(1);
        preserve = true;
        await recovered.tick();
        const journal = await openJournal(paths.run(run.runId).journal);
        expect(journal.end?.result).toEqual({ status: 'cancelled' });
        expect(
          journal.entries.filter((entry) => entry.step === '$end'),
        ).toHaveLength(1);
        expect((await readRunHeader(paths, run.runId)).status).toBe(
          'cancelled',
        );
      } finally {
        await recovered.close();
      }
    } finally {
      releaseKill.resolve();
      await stopping.catch(() => undefined);
      await scheduler.close();
    }
  },
);
