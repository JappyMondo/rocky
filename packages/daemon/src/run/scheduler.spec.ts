import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { rockyPaths, type RockyPaths } from '../config/paths.js';
import { readRunHeader, type RunHeader, writeRunHeader } from './header.js';
import type { BootResult } from './replay.js';
import {
  RunScheduler,
  type RunSchedulerOptions,
  type SchedulerBoot,
} from './scheduler.js';

let root: string;
let paths: RockyPaths;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rocky-scheduler-'));
  paths = rockyPaths(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const issue = {
  identifier: 'NG-540',
  title: 'Schedule Runs',
  description: '',
  url: 'https://linear.app/digimondo/issue/NG-540',
  labels: [],
};

function input(identifier = issue.identifier) {
  return {
    repo: 'rocky',
    issue: { ...issue, identifier },
    branch: identifier.toLowerCase(),
    trigger: 'linear.onDelegate',
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function scheduler(
  boot: SchedulerBoot,
  maxRuns = 3,
  options: Partial<
    Omit<RunSchedulerOptions, 'paths' | 'maxRuns' | 'boot'>
  > = {},
) {
  return RunScheduler.open({
    ...options,
    paths,
    maxRuns,
    boot,
    now: options.now ?? (() => new Date('2026-09-04T10:00:00.000Z')),
  });
}

function storedRun(over: Partial<RunHeader>): RunHeader {
  return {
    v: 2,
    runId: 'NG-540-1',
    issue,
    branch: 'ng-540',
    repo: 'rocky',
    status: 'finished',
    ports: [],
    outcome: 'merged',
    boots: 1,
    createdAt: '2026-09-04T09:00:00.000Z',
    endedAt: '2026-09-04T09:01:00.000Z',
    ...over,
  };
}

const acceptsRegularOrPollBoots: SchedulerBoot = async (
  _run,
  kind: 'run' | 'poll',
) => ({
  status: 'parked',
  reason: kind,
  boot: 1,
  replayed: 0,
  executed: 0,
});

describe('RunScheduler admission', () => {
  it('holds the fourth queued Run until one of three active Boots releases its slot', async () => {
    const started: string[] = [];
    const boots = new Map<string, ReturnType<typeof deferred<BootResult>>>();
    const open = await scheduler(async (run) => {
      started.push(run.runId);
      const next = deferred<BootResult>();
      boots.set(run.runId, next);
      return await next.promise;
    });

    for (const identifier of ['NG-541', 'NG-542', 'NG-543', 'NG-544']) {
      await open.delegate(input(identifier));
    }
    await open.drain();

    expect(started).toEqual(['NG-541-1', 'NG-542-1', 'NG-543-1']);
    expect((await open.get('NG-544-1'))?.status).toBe('queued');

    boots.get('NG-541-1')?.resolve({
      status: 'finished',
      outcome: 'merged',
      boot: 1,
      replayed: 0,
      executed: 0,
    });
    await vi.waitFor(() =>
      expect(started).toEqual(['NG-541-1', 'NG-542-1', 'NG-543-1', 'NG-544-1']),
    );
  });

  it('nudges the newest non-terminal Run without creating another header', async () => {
    const open = await scheduler(async () => ({
      status: 'parked',
      reason: 'checkpoint',
      boot: 1,
      replayed: 0,
      executed: 0,
    }));

    const first = await open.delegate(input());
    const second = await open.delegate(input());

    expect(first.kind).toBe('started');
    expect(second).toEqual({ kind: 'nudged', run: first.run });
    expect(await open.get('NG-540-2')).toBeUndefined();
  });

  it('starts the next increment after the newest Run is terminal', async () => {
    const terminal = storedRun({ runId: 'NG-540-4' });
    await writeRunHeader(paths, terminal);
    const open = await scheduler(async () => ({
      status: 'parked',
      reason: 'checkpoint',
      boot: 1,
      replayed: 0,
      executed: 0,
    }));

    const delegated = await open.delegate(input());

    expect(delegated).toMatchObject({
      kind: 'started',
      run: { runId: 'NG-540-5' },
    });
  });

  it('nudges an older live Run even when a newer Run is terminal', async () => {
    await writeRunHeader(
      paths,
      storedRun({
        runId: 'NG-540-1',
        status: 'parked',
        reason: 'checkpoint',
        endedAt: undefined,
      }),
    );
    await writeRunHeader(
      paths,
      storedRun({
        runId: 'NG-540-2',
        createdAt: '2026-09-04T10:00:00.000Z',
      }),
    );
    const open = await scheduler(acceptsRegularOrPollBoots);

    const delegated = await open.delegate(input());

    expect(delegated).toMatchObject({
      kind: 'nudged',
      run: { runId: 'NG-540-1' },
    });
  });

  it('allocates one greater than the largest suffix, not the newest timestamp', async () => {
    await writeRunHeader(
      paths,
      storedRun({ runId: 'NG-540-10', createdAt: '2026-09-04T08:00:00.000Z' }),
    );
    await writeRunHeader(
      paths,
      storedRun({ runId: 'NG-540-2', createdAt: '2026-09-04T10:00:00.000Z' }),
    );
    const open = await scheduler(acceptsRegularOrPollBoots);

    const delegated = await open.delegate(input());

    expect(delegated).toMatchObject({
      kind: 'started',
      run: { runId: 'NG-540-11' },
    });
  });

  it('serializes concurrent delegations into one started Run and one nudge', async () => {
    const open = await scheduler(acceptsRegularOrPollBoots);

    const delegated = await Promise.all([
      open.delegate(input()),
      open.delegate(input()),
    ]);

    expect(delegated.map((result) => result.kind).sort()).toEqual([
      'nudged',
      'started',
    ]);
    expect(await open.get('NG-540-1')).toBeDefined();
    expect(await open.get('NG-540-2')).toBeUndefined();
  });

  it('serializes concurrent drains without admitting more than the cap', async () => {
    const started: string[] = [];
    const boots = new Map<string, ReturnType<typeof deferred<BootResult>>>();
    const open = await scheduler(async (run) => {
      started.push(run.runId);
      const next = deferred<BootResult>();
      boots.set(run.runId, next);
      return await next.promise;
    });

    for (const identifier of ['NG-541', 'NG-542', 'NG-543', 'NG-544']) {
      await open.delegate(input(identifier));
    }
    await Promise.all([open.drain(), open.drain()]);

    expect(started).toHaveLength(3);
    expect(new Set(started).size).toBe(3);
    expect((await open.get('NG-544-1'))?.status).toBe('queued');

    for (const runId of started) {
      boots.get(runId)?.resolve({
        status: 'parked',
        reason: 'checkpoint',
        boot: 1,
        replayed: 0,
        executed: 0,
      });
    }
    await vi.waitFor(() => expect(started).toHaveLength(4));
    boots.get('NG-544-1')?.resolve({
      status: 'parked',
      reason: 'checkpoint',
      boot: 1,
      replayed: 0,
      executed: 0,
    });
    await vi.waitFor(async () => {
      expect((await open.get('NG-544-1'))?.status).toBe('parked');
    });
  });

  it('records a rejected Boot as failed and admits the next queued Run', async () => {
    const started: string[] = [];
    const open = await scheduler(async (run) => {
      started.push(run.runId);
      if (run.runId === 'NG-541-1') {
        throw new Error('disk full');
      }
      return {
        status: 'parked',
        reason: 'checkpoint',
        boot: 1,
        replayed: 0,
        executed: 0,
      };
    }, 1);
    await open.delegate(input('NG-541'));
    await open.delegate(input('NG-542'));

    await open.drain();

    await vi.waitFor(async () => {
      expect(await open.get('NG-541-1')).toMatchObject({
        status: 'failed',
        error: { name: 'Error', message: 'disk full' },
        endedAt: '2026-09-04T10:00:00.000Z',
        boots: 0,
      });
      expect(started).toEqual(['NG-541-1', 'NG-542-1']);
    });
  });

  it('allocates the next suffix after a Run finishes through the scheduler', async () => {
    const open = await scheduler(async () => ({
      status: 'finished',
      outcome: 'merged',
      boot: 1,
      replayed: 0,
      executed: 0,
    }));
    await open.delegate(input());

    await open.drain();
    await vi.waitFor(async () => {
      expect(await open.get('NG-540-1')).toMatchObject({
        status: 'finished',
        outcome: 'merged',
      });
    });

    await expect(open.delegate(input())).resolves.toMatchObject({
      kind: 'started',
      run: { runId: 'NG-540-2' },
    });
    await open.drain();
    await vi.waitFor(async () => {
      expect((await open.get('NG-540-2'))?.status).toBe('finished');
    });
  });

  it('requeues a persisted running Run and admits it after restart', async () => {
    await writeRunHeader(
      paths,
      storedRun({
        runId: 'NG-540-1',
        status: 'running',
        outcome: undefined,
        endedAt: undefined,
        boots: 2,
      }),
    );
    const started: string[] = [];
    const open = await scheduler(async (run) => {
      started.push(run.runId);
      return {
        status: 'parked',
        reason: 'checkpoint',
        boot: 3,
        replayed: 0,
        executed: 0,
      };
    });

    expect((await open.get('NG-540-1'))?.status).toBe('queued');
    expect((await readRunHeader(paths, 'NG-540-1')).status).toBe('queued');

    await open.drain();
    await vi.waitFor(async () => {
      expect(started).toEqual(['NG-540-1']);
      expect((await open.get('NG-540-1'))?.status).toBe('parked');
    });
  });

  it('does not expose mutable headers through get or delegate', async () => {
    const open = await scheduler(acceptsRegularOrPollBoots);

    const started = await open.delegate(input());
    started.run.status = 'finished';
    started.run.issue.title = 'mutated';

    expect(await open.get('NG-540-1')).toMatchObject({
      status: 'queued',
      issue: { title: 'Schedule Runs' },
    });

    const read = await open.get('NG-540-1');
    if (!read) {
      throw new Error('expected Run');
    }
    read.status = 'finished';
    const nudged = await open.delegate(input());
    nudged.run.status = 'finished';

    expect(nudged).toMatchObject({
      kind: 'nudged',
      run: { runId: 'NG-540-1' },
    });
    await expect(open.delegate(input())).resolves.toMatchObject({
      kind: 'nudged',
      run: { runId: 'NG-540-1' },
    });
  });

  it('admits queued Runs in their distinct createdAt order', async () => {
    const started: string[] = [];
    let minute = 0;
    const open = await scheduler(
      async (run) => {
        started.push(run.runId);
        return {
          status: 'parked',
          reason: 'checkpoint',
          boot: 1,
          replayed: 0,
          executed: 0,
        };
      },
      3,
      {
        now: () => new Date(Date.UTC(2026, 8, 4, 10, minute++)),
      },
    );
    await open.delegate(input('NG-542'));
    await open.delegate(input('NG-541'));
    await open.delegate(input('NG-543'));

    await open.drain();

    await vi.waitFor(() =>
      expect(started).toEqual(['NG-542-1', 'NG-541-1', 'NG-543-1']),
    );
  });

  it('persists running before invoking a regular Boot', async () => {
    const seen: string[] = [];
    const open = await scheduler(async (run) => {
      seen.push((await readRunHeader(paths, run.runId)).status);
      return {
        status: 'parked',
        reason: 'checkpoint',
        boot: 1,
        replayed: 0,
        executed: 0,
      };
    });
    await open.delegate(input());

    await open.drain();

    await vi.waitFor(() => expect(seen).toEqual(['running']));
  });

  it('persists a failed Boot result and releases its slot', async () => {
    const started: string[] = [];
    const open = await scheduler(async (run) => {
      started.push(run.runId);
      return run.runId === 'NG-541-1'
        ? {
            status: 'failed',
            error: { name: 'Error', message: 'workflow failed' },
            boot: 1,
            replayed: 0,
            executed: 0,
          }
        : {
            status: 'parked',
            reason: 'checkpoint',
            boot: 1,
            replayed: 0,
            executed: 0,
          };
    }, 1);
    await open.delegate(input('NG-541'));
    await open.delegate(input('NG-542'));

    await open.drain();

    await vi.waitFor(async () => {
      expect(await open.get('NG-541-1')).toMatchObject({
        status: 'failed',
        error: { name: 'Error', message: 'workflow failed' },
        boots: 1,
      });
      expect(started).toEqual(['NG-541-1', 'NG-542-1']);
    });
  });

  it('leaves a Run queued when persisting running fails before its Boot', async () => {
    const started: string[] = [];
    const open = await scheduler(
      async (run) => {
        started.push(run.runId);
        return {
          status: 'parked',
          reason: 'checkpoint',
          boot: 1,
          replayed: 0,
          executed: 0,
        };
      },
      1,
      {
        writeHeader: async (target, header) => {
          if (header.status === 'running') {
            throw new Error('run.json unavailable');
          }
          await writeRunHeader(target, header);
        },
      },
    );
    await open.delegate(input());

    await expect(open.drain()).rejects.toThrow('run.json unavailable');

    expect(started).toEqual([]);
    expect((await open.get('NG-540-1'))?.status).toBe('queued');
  });

  it('reports result-header persistence failure without replacing a finished outcome', async () => {
    const errors: Error[] = [];
    const started: string[] = [];
    const open = await scheduler(
      async (run) => {
        started.push(run.runId);
        return run.runId === 'NG-541-1'
          ? {
              status: 'finished',
              outcome: 'merged',
              boot: 1,
              replayed: 0,
              executed: 0,
            }
          : {
              status: 'parked',
              reason: 'checkpoint',
              boot: 1,
              replayed: 0,
              executed: 0,
            };
      },
      1,
      {
        writeHeader: async (target, header) => {
          if (header.status === 'finished') {
            throw new Error('run.json unavailable');
          }
          await writeRunHeader(target, header);
        },
        onError: (error) => errors.push(error as Error),
      },
    );
    await open.delegate(input('NG-541'));
    await open.delegate(input('NG-542'));

    await open.drain();

    await vi.waitFor(async () => {
      expect(
        errors.some((error) => error.message === 'run.json unavailable'),
      ).toBe(true);
      expect(await open.get('NG-541-1')).toMatchObject({ status: 'running' });
      expect(started).toEqual(['NG-541-1', 'NG-542-1']);
    });
  });

  it('starts each persisted admission before a later running-header write fails', async () => {
    const started: string[] = [];
    const open = await scheduler(
      async (run) => {
        started.push(run.runId);
        return {
          status: 'parked',
          reason: 'checkpoint',
          boot: 1,
          replayed: 0,
          executed: 0,
        };
      },
      2,
      {
        writeHeader: async (target, header) => {
          if (header.runId === 'NG-542-1' && header.status === 'running') {
            throw new Error('second admission failed');
          }
          await writeRunHeader(target, header);
        },
      },
    );
    await open.delegate(input('NG-541'));
    await open.delegate(input('NG-542'));

    await expect(open.drain()).rejects.toThrow('second admission failed');

    await vi.waitFor(async () => {
      expect(started).toEqual(['NG-541-1']);
      expect((await open.get('NG-541-1'))?.status).toBe('parked');
    });
    expect((await open.get('NG-542-1'))?.status).toBe('queued');
  });

  it('retries a completed result header without replaying its workflow', async () => {
    let calls = 0;
    let failed = false;
    const errors: Error[] = [];
    const open = await scheduler(
      async () => {
        calls += 1;
        return {
          status: 'finished',
          outcome: 'merged',
          boot: 1,
          replayed: 0,
          executed: 0,
        };
      },
      1,
      {
        writeHeader: async (target, header) => {
          if (header.status === 'finished' && !failed) {
            failed = true;
            throw new Error('result header unavailable');
          }
          await writeRunHeader(target, header);
        },
        onError: (error) => errors.push(error as Error),
      },
    );
    await open.delegate(input());

    await open.drain();
    await vi.waitFor(async () => {
      expect(calls).toBe(1);
      expect(
        errors.some((error) => error.message === 'result header unavailable'),
      ).toBe(true);
      expect(await open.get('NG-540-1')).toMatchObject({
        status: 'finished',
        outcome: 'merged',
      });
      expect(calls).toBe(1);
    });
  });

  it('reports failed-header persistence after a rejected Boot without stranding later Runs', async () => {
    const errors: Error[] = [];
    const started: string[] = [];
    const open = await scheduler(
      async (run) => {
        started.push(run.runId);
        if (run.runId === 'NG-541-1') {
          throw new Error('harness died');
        }
        return {
          status: 'parked',
          reason: 'checkpoint',
          boot: 1,
          replayed: 0,
          executed: 0,
        };
      },
      1,
      {
        writeHeader: async (target, header) => {
          if (header.runId === 'NG-541-1' && header.status === 'failed') {
            throw new Error('failed header unavailable');
          }
          await writeRunHeader(target, header);
        },
        onError: (error) => errors.push(error as Error),
      },
    );
    await open.delegate(input('NG-541'));
    await open.delegate(input('NG-542'));

    await open.drain();

    await vi.waitFor(async () => {
      expect(
        errors.some((error) => error.message === 'failed header unavailable'),
      ).toBe(true);
      expect(started).toEqual(['NG-541-1', 'NG-542-1']);
      expect((await open.get('NG-542-1'))?.status).toBe('parked');
    });
  });

  it('retries a rejected Boot failure header without replaying that Boot', async () => {
    let calls = 0;
    let failedWrites = 0;
    const errors: Error[] = [];
    const open = await scheduler(
      async () => {
        calls += 1;
        throw new Error('harness died');
      },
      1,
      {
        writeHeader: async (target, header) => {
          if (header.status === 'failed' && failedWrites++ < 2) {
            throw new Error('failed header unavailable');
          }
          await writeRunHeader(target, header);
        },
        onError: (error) => errors.push(error as Error),
      },
    );
    await open.delegate(input());

    await open.drain();
    await vi.waitFor(async () => {
      expect(calls).toBe(1);
      expect(errors).toHaveLength(2);
      expect((await open.get('NG-540-1'))?.status).toBe('running');
    });

    await open.drain();

    await vi.waitFor(async () => {
      expect(await open.get('NG-540-1')).toMatchObject({
        status: 'failed',
        error: { name: 'Error', message: 'harness died' },
      });
      expect(calls).toBe(1);
    });
  });

  it('uses numeric Run suffixes to order equal timestamps after restart', async () => {
    await writeRunHeader(
      paths,
      storedRun({
        runId: 'NG-540-10',
        status: 'queued',
        outcome: undefined,
        endedAt: undefined,
      }),
    );
    await writeRunHeader(
      paths,
      storedRun({
        runId: 'NG-540-2',
        status: 'queued',
        outcome: undefined,
        endedAt: undefined,
      }),
    );
    const started: string[] = [];
    await expect(
      scheduler(async () => {
        started.push('unexpected');
        throw new Error('must not boot');
      }, 2),
    ).rejects.toThrow(/multiple live Runs/i);
    expect(started).toEqual([]);
  });
});
