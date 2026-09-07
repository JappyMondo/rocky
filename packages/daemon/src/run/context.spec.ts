import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createWorkflowContext } from './context.js';
import { newRunHeader } from './header.js';
import { openJournal, type JournalEntry } from './journal.js';
import { runBoot } from './replay.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rocky-context-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const header = newRunHeader({
  runId: 'NG-597-1',
  repo: 'rocky',
  branch: 'ng-597',
  now: '2026-09-07T10:00:00Z',
  issue: {
    identifier: 'NG-597',
    title: 'Immutable',
    description: '',
    labels: ['rocky'],
    url: '',
  },
});

it('names missing external adapters without inventing behavior', async () => {
  await runBoot({
    journalPath: join(dir, 'journal.jsonl'),
    workflow: async (runner) => {
      const ctx = createWorkflowContext(runner, header, {
        exec: async () => ({ pid: 1 }),
        changedFiles: async () => [],
      });
      for (const name of [
        'agent',
        'checkpoint',
        'post',
        'scm',
        'linear',
      ] as const) {
        expect(() => ctx[name]).toThrow(`ctx.${name} requires an adapter`);
      }
      return 'merged';
    },
  });
});

it('runs ordinary loops and nested parallel callbacks through the same ctx and replays their Steps', async () => {
  const effects: string[] = [];
  let ready = false;
  const journalPath = join(dir, 'journal.jsonl');
  const boot = () =>
    runBoot({
      journalPath,
      workflow: async (runner) => {
        const ctx = createWorkflowContext(
          runner,
          { ...header, ports: [12345] },
          {
            exec: async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }),
            changedFiles: async () => {
              effects.push('files');
              return ['a.ts'];
            },
          },
        );
        expect(() => {
          ctx.issue.labels.push('mutated');
        }).toThrow();
        ctx.stage('Code review');
        for (const i of [1, 2]) {
          const files = await ctx.changedFiles();
          if (files.length)
            await ctx.parallel([1, 2], async (item, index) => {
              await new Promise((resolve) =>
                setTimeout(resolve, item === 1 ? 3 : 0),
              );
              await ctx.step('first', () => {
                effects.push(`${i}:${index}`);
                return item;
              });
              return ctx.parallel([item], async (inner) =>
                ctx.step('second', () => inner * 2),
              );
            });
        }
        await runner.step('checkpoint', {}, async () =>
          ready ? { status: 'done', result: null } : { status: 'waiting' },
        );
        return 'merged';
      },
    });
  expect((await boot()).status).toBe('parked');
  const first = [...effects];
  ready = true;
  expect((await boot()).status).toBe('finished');
  expect(effects).toEqual(first);
  const journal = await openJournal(journalPath);
  expect(journal.latest(0)?.stage).toBe('Code review');
  expect(journal.latest(1)?.step).toBe('$parallel');
  expect(journal.latest(4)?.step).toBe('checkpoint');
});

it.each([new Map(), new Date(), { dropped: undefined }, { n: NaN }, () => 1])(
  'fails non-JSON Step values at record time: %j',
  async (value) => {
    const result = await runBoot({
      journalPath: join(dir, 'journal.jsonl'),
      workflow: async (runner) => {
        const ctx = createWorkflowContext(
          runner,
          { ...header, ports: [] },
          {
            exec: async () => ({ pid: 1 }),
            changedFiles: async () => [],
          },
        );
        await ctx.step('invalid', () => value);
        return 'merged';
      },
    });
    expect(result).toMatchObject({
      status: 'failed',
      error: { message: expect.stringMatching(/JSON/) },
    });
  },
);

it('keeps every nested Journal snapshot unchanged when Workflow code mutates returned values across Boots', async () => {
  const journalPath = join(dir, 'journal.jsonl');
  const stepValues: string[][] = [];
  const parallelValues: string[][] = [];
  let effects = 0;
  const boot = () =>
    runBoot({
      journalPath,
      workflow: async (runner) => {
        const ctx = createWorkflowContext(runner, header, {
          exec: async () => ({ pid: 1 }),
          changedFiles: async () => [],
        });
        const outer = await ctx.parallel(
          [1],
          async () => {
            const inner = await ctx.parallel(
              [1],
              async () => {
                const value = await ctx.step('original', () => {
                  effects++;
                  return { nested: { items: [] as string[] } };
                });
                stepValues.push([...value.nested.items]);
                value.nested.items.push('step mutation');
                await ctx.step('flush Step snapshot', () => null);
                return { nested: { items: [] as string[] } };
              },
              { label: 'inner' },
            );
            const value = inner[0];
            if (!value) throw new Error('missing inner result');
            parallelValues.push([...value.nested.items]);
            value.nested.items.push('parallel mutation');
            await ctx.step('flush parallel snapshot', () => null);
            return value;
          },
          { label: 'outer' },
        );
        outer[0]?.nested.items.push('Workflow mutation');
        await runner.step('checkpoint', {}, async () => ({
          status: 'waiting',
        }));
        return 'merged';
      },
    });
  const inspect = (entries: readonly JournalEntry[]): void => {
    for (const entry of entries) {
      if (entry.status === 'done' && entry.label === 'original') {
        expect(entry.result).toEqual({ nested: { items: [] } });
      }
      if (entry.status === 'done' && entry.label === 'inner') {
        expect(entry.parallel?.results).toEqual([
          { value: { nested: { items: [] } } },
        ]);
      }
      if (entry.status === 'done' && entry.label === 'outer') {
        expect(entry.parallel?.results).toEqual([
          { value: { nested: { items: ['parallel mutation'] } } },
        ]);
      }
      for (const branch of entry.parallel?.branches ?? []) inspect(branch);
    }
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    expect((await boot()).status).toBe('parked');
    const journal = await openJournal(journalPath);
    expect(journal.latest(0)?.parallel?.count).toBe(1);
    inspect(journal.entries);
  }
  expect(effects).toBe(1);
  expect(stepValues).toEqual([[], [], []]);
  expect(parallelValues).toEqual([[], [], []]);
/*
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  BackgroundExecResult,
  ExecResult,
  WorkflowContext,
} from '@rocky/sdk';

import { appendEntry, openJournal } from './journal.js';
import { runBoot, type BootContext } from './replay.js';
import { createWorkflowContext, type ContextServices } from './context.js';

let dir: string;
let journalPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rocky-context-'));
  journalPath = join(dir, 'journal.jsonl');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const header = {
  issue: {
    identifier: 'NG-597',
    title: 'Context',
    description: 'Build it',
    url: 'https://linear.app/NG-597',
    labels: ['daemon'],
  },
  branch: 'rocky/ng-597',
  ports: [41001],
};

function services(over: Partial<ContextServices> = {}): ContextServices {
  return {
    changedFiles: vi.fn(async () => ['packages/daemon/src/run/context.ts']),
    exec: vi.fn(async (): Promise<ExecResult> => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
    })),
    trackProcessGroup: vi.fn(),
    external: {} as ContextServices['external'],
    ...over,
  };
}

function context(runner: BootContext, supplied = services()): WorkflowContext {
  return createWorkflowContext(runner, header, supplied);
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((done) => {
      resolve = done;
    }),
    resolve: (value) => resolve(value),
  };
}

describe('createWorkflowContext', () => {
  it('exposes immutable Run data and a mutable detached ports snapshot', () => {
    const ctx = context({} as BootContext);

    expect(ctx.issue).toEqual(header.issue);
    expect(ctx.branch).toBe(header.branch);
    expect(ctx.ports).toEqual(header.ports);
    expect(Object.isFrozen(ctx.issue)).toBe(true);
    expect(Object.isFrozen(ctx.issue.labels)).toBe(true);
    expect(Object.isFrozen(ctx.ports)).toBe(false);

    ctx.ports.push(41002);

    expect(ctx.ports).toEqual([41001, 41002]);
    expect(header.ports).toEqual([41001]);
  });

  it('replays an ordinary ctx.step result without invoking its callback', async () => {
    let calls = 0;
    const workflow = async (runner: BootContext) => {
      const ctx = context(runner);
      await ctx.step('derive title', () => {
        calls += 1;
        return { title: 'Context' };
      });
      await runner.step('wait', {}, async () => ({ status: 'waiting' }));
      return 'merged' as const;
    };

    await runBoot({ journalPath, workflow });
    await runBoot({ journalPath, workflow });

    expect(calls).toBe(1);
  });

  it('records a failed ctx.step callback in the journal', async () => {
    const result = await runBoot({
      journalPath,
      workflow: async (runner) => {
        await context(runner).step('explode', () => {
          throw new Error('expected failure');
        });
        return 'merged';
      },
    });

    expect(result).toMatchObject({
      status: 'failed',
      error: { message: 'expected failure' },
    });
    expect((await openJournal(journalPath)).latest(0)).toMatchObject({
      step: 'step',
      status: 'failed',
      error: { message: 'expected failure' },
    });
  });

  it('records a non-JSON ctx.step result as a failed Step', async () => {
    const result = await runBoot({
      journalPath,
      workflow: async (runner) => {
        await context(runner).step('bad result', () => BigInt(1));
        return 'merged';
      },
    });

    expect(result).toMatchObject({ status: 'failed' });
    expect(result.status === 'failed' && result.error.message).toMatch(
      /BigInt|serialize/,
    );
    expect((await openJournal(journalPath)).latest(0)).toMatchObject({
      step: 'step',
      status: 'failed',
    });
  });

  it('stamps entries after ctx.stage without consuming a sequence', async () => {
    const result = await runBoot({
      journalPath,
      workflow: async (runner) => {
        const ctx = context(runner);
        ctx.stage('Implementation');
        await ctx.step('one', () => 1);
        await ctx.changedFiles();
        return 'merged';
      },
    });

    expect(result).toMatchObject({ status: 'finished' });
    expect((await openJournal(journalPath)).entries).toMatchObject([
      { seq: 0, step: 'step', stage: 'Implementation' },
      { seq: 0, step: 'step', stage: 'Implementation' },
      { seq: 1, step: 'changedFiles', stage: 'Implementation' },
      { seq: 1, step: 'changedFiles', stage: 'Implementation' },
      { seq: 2, step: '$end' },
    ]);
  });

  it('replays changed files without calling its service again', async () => {
    const supplied = services();
    const workflow = async (runner: BootContext) => {
      await context(runner, supplied).changedFiles();
      await runner.step('wait', {}, async () => ({ status: 'waiting' }));
      return 'merged' as const;
    };

    await runBoot({ journalPath, workflow });
    await runBoot({ journalPath, workflow });

    expect(supplied.changedFiles).toHaveBeenCalledTimes(1);
  });

  it('returns the foreground command result', async () => {
    const result: ExecResult = { exitCode: 0, stdout: 'rocky', stderr: '' };
    const supplied = services({ exec: vi.fn(async () => result) });
    const boot = await runBoot({
      journalPath,
      workflow: async (runner) => {
        await expect(
          context(runner, supplied).exec('printf rocky'),
        ).resolves.toEqual(result);
        return 'merged';
      },
    });

    expect(boot).toMatchObject({ status: 'finished' });
    expect(supplied.exec).toHaveBeenCalledWith('printf rocky', {
      background: false,
    });
  });

  it('treats an explicit false background option as a replayable foreground command', async () => {
    const result: ExecResult = { exitCode: 0, stdout: 'rocky', stderr: '' };
    const supplied = services({ exec: vi.fn(async () => result) });
    const options = { background: false, label: 'foreground' };
    const workflow = async (runner: BootContext) => {
      const ctx = context(runner, supplied);
      await expect(ctx.exec('printf rocky', options)).resolves.toEqual(result);
      await runner.step('wait', {}, async () => ({ status: 'waiting' }));
      return 'merged' as const;
    };

    await runBoot({ journalPath, workflow });
    await runBoot({ journalPath, workflow });

    expect(supplied.exec).toHaveBeenCalledOnce();
    expect(supplied.exec).toHaveBeenCalledWith('printf rocky', {
      background: false,
    });
    expect(supplied.trackProcessGroup).not.toHaveBeenCalled();
  });

  it('re-spawns a completed background command on a subsequent Boot', async () => {
    const supplied = services({
      exec: vi
        .fn<ContextServices['exec']>()
        .mockResolvedValueOnce({ pid: 101 } satisfies BackgroundExecResult)
        .mockResolvedValueOnce({ pid: 102 } satisfies BackgroundExecResult),
    });
    const pids: number[] = [];
    const workflow = async (runner: BootContext) => {
      const ctx = context(runner, supplied);
      pids.push((await ctx.exec('pnpm dev', { background: true })).pid);
      await runner.step('wait', {}, async () => ({ status: 'waiting' }));
      return 'merged' as const;
    };

    await runBoot({ journalPath, workflow });
    await runBoot({ journalPath, workflow });

    expect(pids).toEqual([101, 102]);
    expect(supplied.trackProcessGroup).toHaveBeenNthCalledWith(1, 101);
    expect(supplied.trackProcessGroup).toHaveBeenNthCalledWith(2, 102);
  });

  it('persists background ownership before a failed done-record write', async () => {
    const owned: number[] = [];
    const supplied = services({
      exec: vi.fn(async () => ({ pid: 101 }) satisfies BackgroundExecResult),
      trackProcessGroup: async (pid) => {
        owned.push(pid);
      },
    });
    let appends = 0;

    await expect(
      runBoot({
        journalPath,
        workflow: async (runner) => {
          await context(runner, supplied).exec('pnpm dev', {
            background: true,
          });
          return 'merged';
        },
        append: async (path, entry, options) => {
          appends += 1;
          if (appends === 2) throw new Error('done record unavailable');
          await appendEntry(path, entry, options);
        },
      }),
    ).rejects.toThrow('done record unavailable');

    expect(owned).toEqual([101]);
  });

  it('routes public fan-out through runner.parallel', async () => {
    const runner = {
      boot: 1,
      stage: vi.fn(),
      step: vi.fn(),
      parallel: vi.fn(async (_key, items, _opts, fn) =>
        Promise.all(
          items.map((item: number, index: number) => fn(runner, item, index)),
        ),
      ),
    } as unknown as BootContext;

    await expect(
      context(runner).parallel([2, 3], async (item) => item * 2),
    ).resolves.toEqual([4, 6]);
    expect(runner.parallel).toHaveBeenCalledOnce();
    expect(runner.step).not.toHaveBeenCalled();
  });

  it('rejects raw concurrent ctx calls outside ctx.parallel', async () => {
    const result = await runBoot({
      journalPath,
      workflow: async (runner) => {
        const ctx = context(runner);
        await Promise.all([ctx.step('one', () => 1), ctx.step('two', () => 2)]);
        return 'merged';
      },
    });

    expect(result).toMatchObject({
      status: 'failed',
      error: { name: 'ConcurrentContextCallError' },
    });
    expect(result.status === 'failed' && result.error.message).toMatch(
      /ctx.parallel/,
    );
  });

  it('waits for an active raw call before failing a concurrent Promise.all', async () => {
    const started = deferred<void>();
    const release = deferred<void>();
    const boot = runBoot({
      journalPath,
      workflow: async (runner) => {
        const ctx = context(runner);
        await Promise.all([
          ctx.step('slow', async () => {
            started.resolve();
            await release.promise;
            return 1;
          }),
          ctx.step('immediate', () => 2),
        ]);
        return 'merged';
      },
    });

    await started.promise;
    const beforeRelease = (await openJournal(journalPath)).entries;
    expect(beforeRelease).toMatchObject([
      { seq: 0, step: 'step', status: 'running' },
    ]);
    expect(beforeRelease.some((entry) => entry.step === '$end')).toBe(false);

    release.resolve();
    const result = await boot;
    const entries = (await openJournal(journalPath)).entries;

    expect(result).toMatchObject({
      status: 'failed',
      error: { name: 'ConcurrentContextCallError' },
    });
    expect(entries.at(-1)).toMatchObject({ step: '$end', status: 'failed' });
    expect(entries.findIndex((entry) => entry.step === '$end')).toBe(
      entries.length - 1,
    );
  });

  it('waits for an active raw call inside a parallel branch', async () => {
    const started = deferred<void>();
    const release = deferred<void>();
    const boot = runBoot({
      journalPath,
      workflow: async (runner) => {
        const ctx = context(runner);
        await ctx.parallel([1], async () =>
          Promise.all([
            ctx.step('slow', async () => {
              started.resolve();
              await release.promise;
              return 1;
            }),
            ctx.step('immediate', () => 2),
          ]),
        );
        return 'merged';
      },
    });

    await started.promise;
    const beforeRelease = (await openJournal(journalPath)).entries;
    expect(beforeRelease.some((entry) => entry.step === '$end')).toBe(false);

    release.resolve();
    const result = await boot;
    const entries = (await openJournal(journalPath)).entries;

    expect(result).toMatchObject({
      status: 'failed',
      error: { name: 'ConcurrentContextCallError' },
    });
    expect(entries.at(-1)).toMatchObject({ step: '$end', status: 'failed' });
  });
*/
});
