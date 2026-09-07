import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openJournal } from './journal.js';
import { runBoot, type BootContext } from './replay.js';

let dir: string;
let journalPath: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rocky-control-'));
  journalPath = join(dir, 'journal.jsonl');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

it.each([false, true])(
  'polls only existing waits, even in nested parallel (%s)',
  async (nested) => {
    let ready = false;
    let after = 0;
    const work = async (ctx: BootContext) => {
      try {
        await ctx.step('checkpoint', {}, async () =>
          ready ? { status: 'done', result: 'answer' } : { status: 'waiting' },
        );
      } catch {
        /* A catch cannot escape the poll fence. */
      }
      await ctx.step('after', {}, async () => {
        after++;
        return { status: 'done', result: null };
      });
    };
    const workflow = async (ctx: BootContext) => {
      if (nested)
        await ctx.parallel('outer', [1], {}, async (branch) => {
          await branch.parallel('inner', [1], {}, async (inner) => work(inner));
        });
      else await work(ctx);
      return 'merged' as const;
    };
    expect((await runBoot({ journalPath, workflow })).status).toBe('parked');
    ready = true;
    expect((await runBoot({ journalPath, workflow, poll: true })).status).toBe(
      'ready',
    );
    expect(after).toBe(0);
    expect((await openJournal(journalPath)).end).toBeUndefined();
    expect((await runBoot({ journalPath, workflow })).status).toBe('finished');
    expect(after).toBe(1);
  },
);

it('cancellation cannot be caught to execute a later Step or finish the Run', async () => {
  const controller = new AbortController();
  let after = false;
  const result = await runBoot({
    journalPath,
    signal: controller.signal,
    workflow: async (ctx) => {
      await ctx.step('one', {}, async () => {
        controller.abort();
        return { status: 'done', result: 1 };
      });
      try {
        await ctx.step('two', {}, async () => {
          after = true;
          return { status: 'done', result: 2 };
        });
      } catch {
        /* cannot finish */
      }
      return 'merged';
    },
  });
  expect(result.status).toBe('cancelled');
  expect(after).toBe(false);
  // Only the scheduler may commit cancellation, after preservation succeeds.
  expect((await openJournal(journalPath)).end).toBeUndefined();
});

it('records ordinary thrown undefined as failure and trusts the same failed end on another Boot', async () => {
  const workflow = async (): Promise<never> => {
    throw undefined;
  };
  const first = await runBoot({ journalPath, workflow });
  expect(first).toMatchObject({
    status: 'failed',
    error: { message: 'undefined' },
  });
  expect(await runBoot({ journalPath, workflow })).toMatchObject({
    status: 'failed',
    error: { message: 'undefined' },
    executed: 0,
  });
});

it('returns the recorded parallel result, while still checking the branch sequence on replay', async () => {
  let value = 0;
  const results: unknown[][] = [];
  const workflow = async (ctx: BootContext) => {
    results.push(
      await ctx.parallel('values', [1, 2], {}, async (_branch, item) =>
        item === 1 ? ++value : undefined,
      ),
    );
    await ctx.step('checkpoint', {}, async () => ({ status: 'waiting' }));
    return 'merged' as const;
  };
  await runBoot({ journalPath, workflow });
  await runBoot({ journalPath, workflow });
  expect(results).toEqual([
    [1, undefined],
    [1, undefined],
  ]);
});

it('drains an unawaited Step before failing the Run', async () => {
  const result = await runBoot({
    journalPath,
    workflow: async (ctx) => {
      void ctx.step('forgotten', {}, async () => ({
        status: 'done',
        result: null,
      }));
      return 'merged';
    },
  });
  expect(result).toMatchObject({
    status: 'failed',
    error: { name: 'DivergenceError' },
  });
  expect((await openJournal(journalPath)).entries.at(-1)?.step).toBe('$end');
});

it('records a non-JSON parallel result as an ordinary replayable failure', async () => {
  const first = await runBoot({
    journalPath,
    workflow: async (ctx) => {
      await ctx.parallel('invalid', [1], {}, async () => new Map());
      return 'merged';
    },
  });
  expect(first).toMatchObject({
    status: 'failed',
    error: { message: expect.stringMatching(/JSON/) },
  });
  expect((await openJournal(journalPath)).latest(0)?.status).toBe('failed');
});

it('returns a recorded cancelled outcome without executing Workflow code', async () => {
  const { appendEntry } = await import('./journal.js');
  await appendEntry(
    journalPath,
    {
      v: 1,
      seq: 0,
      step: '$end',
      status: 'done',
      boot: 1,
      startedAt: '2026-09-07T10:00:00Z',
      result: { status: 'cancelled' },
    },
    { runner: true },
  );
  expect(
    await runBoot({
      journalPath,
      workflow: async () => {
        throw new Error('must not run');
      },
    }),
  ).toMatchObject({ status: 'cancelled', executed: 0 });
});
