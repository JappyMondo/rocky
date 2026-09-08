/**
 * Deterministic replay (NG-572 §1, NG-574 §5–§6).
 *
 * A Boot re-runs the workflow function from the top. Completed `ctx.*` calls
 * hand back their recorded result without touching the world; plain TypeScript
 * between Steps simply re-executes. Every test here is a scripted Run: the
 * effects are injected, so what is under test is the engine and nothing else.
 *
 * Covers AC1 (killed at every phase boundary), AC3 (divergence), AC4 (a caught
 * `failed` Step re-throws identically) and AC5 (the crash-loop guard).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CRASH_LOOP_LIMIT,
  CrashLoopError,
  DivergenceError,
  runBoot,
  type BootContext,
  type BootResult,
  type EffectHandle,
} from './replay.js';
import {
  END_STEP,
  JOURNAL_FORMAT_VERSION,
  JournalFormatError,
  appendEntry,
  openJournal,
  type JournalEntry,
} from './journal.js';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rocky-replay-'));
  path = join(dir, 'journal.jsonl');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A clock that advances a millisecond per reading, so `ms` is predictable. */
function clock(): () => number {
  let tick = 0;
  return () => Date.UTC(2026, 8, 2, 10, 0, 0) + tick++;
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((done) => {
      resolve = done;
    }),
    resolve: (value) => resolve(value),
  };
}

type Workflow = (
  ctx: BootContext,
) => Promise<'merged' | 'rejected' | 'exhausted'>;

function boot(
  workflow: Workflow,
  over: Partial<Parameters<typeof runBoot>[0]> = {},
) {
  return runBoot({ journalPath: path, workflow, now: clock(), ...over });
}

/** The folded, replay-relevant view of the journal: what must survive a kill. */
async function folded(): Promise<
  { seq: number; step: string; status: string; result?: unknown }[]
> {
  const journal = await openJournal(path);
  const seqs = [...new Set(journal.entries.map((entry) => entry.seq))].sort(
    (a, b) => a - b,
  );
  return seqs.map((seq) => {
    const entry = journal.latest(seq);
    if (!entry) {
      throw new Error(`no entry for seq ${seq}`);
    }
    return {
      seq,
      step: entry.step,
      status: entry.status,
      ...(entry.result === undefined ? {} : { result: entry.result }),
    };
  });
}

async function lines(): Promise<JournalEntry[]> {
  return [...(await openJournal(path)).entries];
}

describe('the first Boot', () => {
  it('executes every Step and journals it twice', async () => {
    const result = await boot(async (ctx) => {
      await ctx.step('agent', {}, async () => ({
        status: 'done',
        result: { summary: 'planned' },
      }));
      await ctx.step('exec', {}, async () => ({
        status: 'done',
        result: { exitCode: 0 },
      }));
      return 'merged';
    });

    expect(result).toMatchObject({ status: 'finished', outcome: 'merged' });
    expect(result.boot).toBe(1);
    expect(result.executed).toBe(2);
    expect(result.replayed).toBe(0);

    expect((await lines()).map((e) => [e.seq, e.step, e.status])).toEqual([
      [0, 'agent', 'running'],
      [0, 'agent', 'done'],
      [1, 'exec', 'running'],
      [1, 'exec', 'done'],
      [2, END_STEP, 'done'],
    ]);
  });

  it('records the outcome in a terminal $end entry', async () => {
    await boot(async () => 'exhausted');

    const journal = await openJournal(path);

    expect(journal.end?.result).toEqual({
      status: 'finished',
      outcome: 'exhausted',
    });
  });

  it('stamps the boot number and elapsed time on every entry', async () => {
    await boot(async (ctx) => {
      await ctx.step('exec', {}, async () => ({ status: 'done', result: 1 }));
      return 'merged';
    });

    const done = (await lines()).find(
      (e) => e.seq === 0 && e.status === 'done',
    );

    expect(done?.boot).toBe(1);
    expect(done?.startedAt).toBe('2026-09-02T10:00:00.000Z');
    expect(done?.ms).toBeGreaterThanOrEqual(0);
  });
});

describe('a replaying Boot', () => {
  const script =
    (touched: string[]): Workflow =>
    async (ctx) => {
      const plan = await ctx.step('agent', { label: 'plan' }, async () => {
        touched.push('agent');
        return { status: 'done', result: { touchesUi: true } };
      });
      // Plain TypeScript between Steps: re-executes every Boot, which is safe
      // precisely because the Steps around it do not.
      touched.push(
        `between:${String((plan as { touchesUi: boolean }).touchesUi)}`,
      );
      await ctx.step('exec', {}, async () => {
        touched.push('exec');
        return { status: 'done', result: { exitCode: 0 } };
      });
      return 'merged';
    };

  it('hands back recorded results without touching the world', async () => {
    const first: string[] = [];
    await boot(script(first));
    expect(first).toEqual(['agent', 'between:true', 'exec']);

    // The `$end` line makes the Run terminal, so a fresh journal is needed to
    // watch a *resumable* Run replay. Park it instead, by failing to finish.
    rmSync(path);
    const seeded: string[] = [];
    await boot(async (ctx) => {
      await ctx.step('agent', {}, async () => {
        seeded.push('agent');
        return { status: 'done', result: { touchesUi: true } };
      });
      await ctx.step('exec', {}, async () => ({ status: 'waiting' }));
      return 'merged';
    });
    expect(seeded).toEqual(['agent']);

    const second: string[] = [];
    const result = await boot(script(second));

    // `agent` was replayed, so it never ran; the code between Steps did.
    expect(second).toEqual(['between:true', 'exec']);
    expect(result).toMatchObject({ status: 'finished', replayed: 1 });
    expect(result.executed).toBe(1);
  });

  it('does not compare the display-only label', async () => {
    await boot(async (ctx) => {
      await ctx.step('agent', { label: 'reviewer 1/5' }, async () => ({
        status: 'done',
        result: 'ok',
      }));
      await ctx.step('exec', {}, async () => ({ status: 'waiting' }));
      return 'merged';
    });

    const result = await boot(async (ctx) => {
      await ctx.step('agent', { label: 'totally different' }, async () => ({
        status: 'done',
        result: 'ok',
      }));
      await ctx.step('exec', {}, async () => ({ status: 'done', result: 0 }));
      return 'merged';
    });

    expect(result.status).toBe('finished');
  });

  it('counts up the boot number', async () => {
    await boot(async (ctx) => {
      await ctx.step('exec', {}, async () => ({ status: 'waiting' }));
      return 'merged';
    });

    const second = await boot(async (ctx) => {
      await ctx.step('exec', {}, async () => ({ status: 'done', result: 0 }));
      return 'merged';
    });

    expect(second.boot).toBe(2);
  });

  it('refuses to re-run a Run that already ended', async () => {
    await boot(async () => 'merged');

    let ran = false;
    const again = await boot(async () => {
      ran = true;
      return 'rejected';
    });

    expect(ran).toBe(false);
    expect(again).toMatchObject({ status: 'finished', outcome: 'merged' });
  });
});

describe('a waiting Step', () => {
  it('parks the Boot, naming the parking Step as the reason', async () => {
    const result = await boot(async (ctx) => {
      await ctx.step('scm:waitForCi', {}, async () => ({ status: 'waiting' }));
      return 'merged';
    });

    expect(result).toMatchObject({ status: 'parked', reason: 'scm:waitForCi' });
    expect(await folded()).toEqual([
      { seq: 0, step: 'scm:waitForCi', status: 'waiting' },
    ]);
  });

  it('stops the Workflow dead rather than running later Steps', async () => {
    let reached = false;
    await boot(async (ctx) => {
      await ctx.step('checkpoint', {}, async () => ({ status: 'waiting' }));
      reached = true;
      await ctx.step('post', {}, async () => ({
        status: 'done',
        result: null,
      }));
      return 'merged';
    });

    expect(reached).toBe(false);
  });

  it('retries its effect on the next Boot — asking the world again', async () => {
    let asked = 0;
    const parking: Workflow = async (ctx) => {
      await ctx.step('checkpoint', {}, async () => {
        asked += 1;
        return asked < 3
          ? { status: 'waiting' }
          : { status: 'done', result: { decision: 'approve' } };
      });
      return 'merged';
    };

    expect((await boot(parking)).status).toBe('parked');
    expect((await boot(parking)).status).toBe('parked');
    expect((await boot(parking)).status).toBe('finished');
    expect(asked).toBe(3);
  });

  it('never trips the crash-loop guard however long it parks', async () => {
    // A `waiting` Step writes a fresh `running` line on every poll Boot, so a
    // guard that counted those would fail a Checkpoint that waited a weekend.
    const parking: Workflow = async (ctx) => {
      await ctx.step('checkpoint', {}, async () => ({ status: 'waiting' }));
      return 'merged';
    };

    for (let i = 0; i < CRASH_LOOP_LIMIT + 3; i += 1) {
      expect((await boot(parking)).status).toBe('parked');
    }
  });
});

describe('a failed Step', () => {
  const failing: Workflow = async (ctx) => {
    try {
      await ctx.step('agent', {}, async () => {
        throw new Error('the harness died');
      });
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) throw error;
      caught.push(error);
    }
    await ctx.step('post', {}, async () => ({ status: 'done', result: null }));
    return 'exhausted';
  };
  let caught: Error[];

  beforeEach(() => {
    caught = [];
  });

  it('throws into workflow code as an ordinary exception', async () => {
    const result = await boot(failing);

    expect(caught).toHaveLength(1);
    expect(caught[0]?.message).toBe('the harness died');
    // The Workflow caught it, so the Run itself finished.
    expect(result).toMatchObject({ status: 'finished', outcome: 'exhausted' });
  });

  it('records the error on the entry', async () => {
    await boot(failing);

    const entry = (await openJournal(path)).latest(0);

    expect(entry?.status).toBe('failed');
    expect(entry?.error).toMatchObject({
      name: 'Error',
      message: 'the harness died',
    });
  });

  it('re-throws its recorded error identically on replay, without re-running', async () => {
    // AC4. `failed` is a recorded, replayable outcome — otherwise a Workflow
    // that caught the failure would diverge the moment replay succeeded.
    await boot(async (ctx) => {
      try {
        await ctx.step('agent', {}, async () => {
          throw new Error('the harness died');
        });
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        if (!(error instanceof Error)) throw error;
        caught.push(error);
      }
      await ctx.step('post', {}, async () => ({ status: 'waiting' }));
      return 'exhausted';
    });

    const live = caught.at(0);
    caught = [];

    let reRan = false;
    const result = await boot(async (ctx) => {
      try {
        await ctx.step('agent', {}, async () => {
          reRan = true;
          return { status: 'done', result: 'this must never happen' };
        });
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        if (!(error instanceof Error)) throw error;
        caught.push(error);
      }
      await ctx.step('post', {}, async () => ({
        status: 'done',
        result: null,
      }));
      return 'exhausted';
    });

    expect(reRan).toBe(false);
    expect(caught).toHaveLength(1);
    expect({ name: caught[0]?.name, message: caught[0]?.message }).toEqual({
      name: live?.name,
      message: live?.message,
    });
    expect(result.status).toBe('finished');
  });

  it('records an unserializable result as failed and rethrows it on replay', async () => {
    const caught: Error[] = [];
    const first = await boot(async (ctx) => {
      try {
        await ctx.step('agent', {}, async () => ({
          status: 'done',
          result: 1n,
        }));
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        if (!(error instanceof Error)) throw error;
        caught.push(error);
      }
      await ctx.step('wait', {}, async () => ({ status: 'waiting' }));
      return 'merged';
    });

    expect(first.status).toBe('parked');
    expect((await openJournal(path)).latest(0)?.status).toBe('failed');

    let reran = false;
    const second = await boot(async (ctx) => {
      try {
        await ctx.step('agent', {}, async () => {
          reran = true;
          return { status: 'done', result: 'must not run' };
        });
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        if (!(error instanceof Error)) throw error;
        caught.push(error);
      }
      await ctx.step('wait', {}, async () => ({
        status: 'done',
        result: null,
      }));
      return 'merged';
    });

    expect(reran).toBe(false);
    expect(caught.map((error) => error.message)).toEqual([
      'Do not know how to serialize a BigInt',
      'Do not know how to serialize a BigInt',
    ]);
    expect(second.status).toBe('finished');
  });

  it('fails the Run when the Workflow does not catch it', async () => {
    const result = await boot(async (ctx) => {
      await ctx.step('agent', {}, async () => {
        throw new Error('unhandled');
      });
      return 'merged';
    });

    expect(result).toMatchObject({ status: 'failed' });
    expect(result.status === 'failed' && result.error.message).toBe(
      'unhandled',
    );
    expect((await openJournal(path)).end?.result).toMatchObject({
      status: 'failed',
    });
  });
});

describe('attempts', () => {
  it.each(['record', 'update'] as const)(
    'drains an unawaited %s failure before any later effect or terminal record',
    async (method) => {
      const failure = new Error('flush failed');
      let fail = false;
      let reached = false;
      const appended: JournalEntry[] = [];
      await expect(
        boot(
          async (ctx) => {
            await ctx
              .step('agent', {}, async (handle) => {
                fail = true;
                if (method === 'update')
                  void handle.update({ session: 'first' });
                else
                  void handle.record({
                    kind: 'failed',
                    startedAt: 'now',
                    ms: 1,
                    error: { name: 'Error', message: 'retry' },
                  });
                void handle.update({ session: 'second' });
                throw new Error(
                  'ordinary effect error must not hide persistence failure',
                );
              })
              .catch(() => undefined);
            await ctx
              .step('later', {}, async () => {
                reached = true;
                return { status: 'done', result: null };
              })
              .catch(() => undefined);
            return 'merged';
          },
          {
            append: async (target, entry, options) => {
              if (fail) {
                fail = false;
                throw failure;
              }
              appended.push(entry);
              await appendEntry(target, entry, options);
            },
          },
        ),
      ).rejects.toBe(failure);
      expect(reached).toBe(false);
      expect(appended).toHaveLength(1);
      expect((await openJournal(path)).latest(0)?.status).toBe('running');
    },
  );

  it('rejects non-JSON progress through the promised API without changing progress', async () => {
    let checked = false;
    const result = await boot(async (ctx) => {
      await ctx.step('agent', {}, async (handle) => {
        await handle.update({ session: 'kept' });
        await expect(handle.update({ session: new Date() })).rejects.toThrow(
          'plain JSON',
        );
        expect(handle.progress).toEqual({ session: 'kept' });
        checked = true;
        return { status: 'done', result: null };
      });
      return 'merged';
    });
    expect(checked).toBe(true);
    expect(result.status).toBe('finished');
  });

  it.each(['done', 'waiting', 'failed'] as const)(
    'drains unawaited snapshots before %s and rejects late writers',
    async (status) => {
      let handle!: EffectHandle;
      const writing = deferred<void>();
      const release = deferred<void>();
      const progress = { session: { id: 'original' } };
      const attempt = {
        kind: 'steer' as const,
        note: 'original',
        startedAt: 'now',
        ms: 1,
        usage: { input_tokens: 1 },
        nudges: [{ error: 'original' }],
      };
      const result = boot(
        async (ctx) => {
          await ctx.step('agent', {}, async (current) => {
            handle = current;
            void handle.update(progress);
            progress.session.id = 'mutated';
            void handle.record(attempt);
            attempt.note = 'mutated';
            attempt.usage.input_tokens = 999;
            attempt.nudges[0]!.error = 'mutated';
            void handle.update({ session: { id: 'final' } });
            if (status === 'failed') throw new Error('effect failed');
            return status === 'waiting' ? { status } : { status, result: null };
          });
          return 'merged';
        },
        {
          append: async (target, entry, options) => {
            if (
              entry.progress &&
              !entry.attempts &&
              entry.status === 'running'
            ) {
              writing.resolve();
              await release.promise;
            }
            await appendEntry(target, entry, options);
          },
        },
      );
      await writing.promise;
      try {
        expect((await openJournal(path)).latest(0)?.status).toBe('running');
        await expect(handle.update({ late: true })).rejects.toThrow('closed');
        await expect(handle.record(attempt)).rejects.toThrow('closed');
      } finally {
        release.resolve();
      }
      await result;
      const journal = await openJournal(path);
      expect(
        journal.entries
          .filter((entry) => entry.step === 'agent')
          .map((entry) => entry.progress),
      ).toEqual([
        undefined,
        { session: { id: 'original' } },
        { session: { id: 'original' } },
        { session: { id: 'final' } },
        { session: { id: 'final' } },
      ]);
      expect(journal.latest(0)).toMatchObject({
        status,
        attempts: [
          {
            note: 'original',
            usage: { input_tokens: 1 },
            nudges: [{ error: 'original' }],
          },
        ],
      });
      await expect(handle.update(null)).rejects.toThrow('closed');
      expect(await lines()).toEqual(journal.entries);
    },
  );

  it.each(['record', 'update'] as const)(
    'latches a caught %s persistence failure across nested siblings and later root Steps',
    async (method) => {
      const failed = deferred<void>();
      const failure = new Error('disk unavailable');
      const touched: string[] = [];
      let rejectWrite = false;
      const result = boot(
        async (ctx) => {
          await ctx
            .parallel('outer', [0, 1], {}, async (branch, index) => {
              if (index === 0) {
                await branch
                  .parallel('inner', [0], {}, async (nested) => {
                    await nested
                      .step('agent', {}, async (handle) => {
                        rejectWrite = true;
                        try {
                          if (method === 'update')
                            await handle.update({ session: 'saved' });
                          else
                            await handle.record({
                              kind: 'steer',
                              note: 'continue',
                              startedAt: 'now',
                              ms: 1,
                            });
                        } catch {
                          failed.resolve();
                        }
                        return { status: 'done', result: null };
                      })
                      .catch(() => undefined);
                  })
                  .catch(() => undefined);
              } else {
                await failed.promise;
                await branch
                  .step('later sibling', {}, async () => {
                    touched.push('sibling');
                    return { status: 'done', result: null };
                  })
                  .catch(() => undefined);
              }
            })
            .catch(() => undefined);
          await ctx
            .step('later root', {}, async () => {
              touched.push('root');
              return { status: 'done', result: null };
            })
            .catch(() => undefined);
          return 'merged';
        },
        {
          append: async (target, entry, options) => {
            if (rejectWrite) {
              rejectWrite = false;
              throw failure;
            }
            await appendEntry(target, entry, options);
          },
        },
      );
      await expect(result).rejects.toBe(failure);
      expect(touched).toEqual([]);
      expect((await openJournal(path)).end).toBeUndefined();
    },
  );

  it('recovers detached progress and stable identities through nested parallel reservations', async () => {
    const identities: string[] = [];
    const saved: unknown[] = [];
    const workflow =
      (controller?: AbortController): Workflow =>
      async (ctx) => {
        await ctx.parallel('outer', [0, 1], {}, async (branch, index) => {
          await branch.parallel('inner', [0], {}, async (nested) => {
            await nested.step('agent', {}, async (handle) => {
              identities.push(handle.identity);
              if (controller) {
                await handle.update({ session: { id: `session-${index}` } });
                await handle.record({
                  kind: 'steer',
                  note: 'continue',
                  ms: 1,
                  startedAt: 'now',
                });
                saved.push(handle.progress);
              } else {
                saved.push(handle.progress);
                const detached = handle.progress;
                if (typeof detached === 'object' && detached !== null) {
                  Object.assign(detached, { session: null });
                }
                expect(handle.progress).toEqual({
                  session: { id: `session-${index}` },
                });
              }
              if (controller) {
                // Both branches reach a durable update before shutting down.
                if (saved.length === 2) controller.abort();
                await bothUpdated.promise;
                throw new Error('shutdown');
              }
              return { status: 'done', result: null };
            });
          });
        });
        return 'merged';
      };
    const bothUpdated = deferred<void>();
    const controller = new AbortController();
    controller.signal.addEventListener('abort', () => bothUpdated.resolve());
    expect(
      (await boot(workflow(controller), { signal: controller.signal })).status,
    ).toBe('cancelled');
    const journal = await openJournal(path);
    for (const branch of journal.latest(0)!.parallel!.branches) {
      expect(branch.at(-1)?.parallel?.branches[0]?.at(-1)).toMatchObject({
        status: 'running',
        attempts: [{ kind: 'steer', note: 'continue' }],
      });
    }
    expect((await boot(workflow())).status).toBe('finished');
    expect(identities).toEqual([
      '0/0/0/0/0',
      '0/1/0/0/0',
      '0/0/0/0/0',
      '0/1/0/0/0',
    ]);
    expect(saved).toEqual([
      { session: { id: 'session-0' } },
      { session: { id: 'session-1' } },
      { session: { id: 'session-0' } },
      { session: { id: 'session-1' } },
    ]);
  });

  it('persists attempts while running and preserves them in the next Boot reservation', async () => {
    const attempt = {
      kind: 'failed' as const,
      startedAt: '2026-09-02T10:00:00.000Z',
      ms: 5,
      error: { name: 'Error', message: 'retry' },
      usage: { input_tokens: 12, output_tokens: 3 },
      nudges: [{ error: 'invalid output' }],
      attempt: 1,
    };
    const controller = new AbortController();
    let running: JournalEntry | undefined;
    await boot(
      async (ctx) => {
        await ctx.step('agent', {}, async (handle) => {
          await handle.record(attempt);
          await handle.update({ session: 'resume-me' });
          running = (await openJournal(path)).latest(0);
          controller.abort();
          throw new Error('shutdown');
        });
        return 'merged';
      },
      { signal: controller.signal },
    );
    expect(running).toMatchObject({
      status: 'running',
      attempts: [attempt],
      progress: { session: 'resume-me' },
    });

    await expect(
      boot(
        async (ctx) => {
          await ctx.step('agent', {}, async () => {
            throw new Error('must not reach effect');
          });
          return 'merged';
        },
        {
          append: async (target, entry, options) => {
            await appendEntry(target, entry, options);
            throw new Error('interrupted after reservation');
          },
        },
      ),
    ).rejects.toThrow('interrupted after reservation');
    expect((await openJournal(path)).latest(0)).toMatchObject({
      boot: 2,
      status: 'running',
      attempts: [attempt],
      progress: { session: 'resume-me' },
    });
  });

  it('accumulate on the entry without consuming a seq', async () => {
    await boot(async (ctx) => {
      await ctx.step('agent', {}, async (attempt) => {
        attempt.record({
          kind: 'failed',
          startedAt: '2026-09-02T10:00:00.000Z',
          ms: 5,
          error: { name: 'Error', message: 'rate limited' },
        });
        attempt.record({
          kind: 'steer',
          startedAt: '2026-09-02T10:00:02.000Z',
          ms: 9,
          note: 'drop the caching layer you added',
        });
        return { status: 'done', result: 'ok', sessionId: 'sess-1' };
      });
      await ctx.step('exec', {}, async () => ({ status: 'done', result: 0 }));
      return 'merged';
    });

    const journal = await openJournal(path);
    const entry = journal.latest(0);

    expect(entry?.attempts?.map((a) => a.kind)).toEqual(['failed', 'steer']);
    expect(entry?.result).toBe('ok');
    expect(entry?.sessionId).toBe('sess-1');
    // Retries never consume a seq: `exec` is still seq 1.
    expect(journal.latest(1)?.step).toBe('exec');
  });

  it('survive into the next Boot when the Step was interrupted', async () => {
    await appendEntry(path, {
      v: JOURNAL_FORMAT_VERSION,
      seq: 0,
      step: 'agent',
      status: 'running',
      boot: 1,
      startedAt: '2026-09-02T09:00:00.000Z',
      attempts: [
        {
          kind: 'steer',
          startedAt: '2026-09-02T09:00:01.000Z',
          ms: 3,
          note: 'use the existing helper',
        },
      ],
    });

    await boot(async (ctx) => {
      await ctx.step('agent', {}, async () => ({
        status: 'done',
        result: 'ok',
      }));
      return 'merged';
    });

    const entry = (await openJournal(path)).latest(0);

    expect(entry?.status).toBe('done');
    expect(entry?.attempts?.map((a) => a.kind)).toEqual(['steer']);
  });
});

describe('the stage marker', () => {
  it('stamps every entry created after it, and consumes no seq', async () => {
    await boot(async (ctx) => {
      ctx.stage('Planning');
      await ctx.step('agent', {}, async () => ({ status: 'done', result: 1 }));
      ctx.stage('Code review');
      await ctx.step('exec', {}, async () => ({ status: 'done', result: 2 }));
      return 'merged';
    });

    const journal = await openJournal(path);

    expect(journal.latest(0)?.stage).toBe('Planning');
    expect(journal.latest(1)?.stage).toBe('Code review');
    // Two Steps, two seqs — the marker took none of them.
    expect(journal.latest(2)?.step).toBe(END_STEP);
  });
});

describe('journaled parallel', () => {
  it.each([
    [
      'top-level entry',
      (entry: Record<string, unknown>) => ({ ...entry, extra: true }),
    ],
    [
      'attempt',
      (entry: Record<string, unknown>) => ({
        ...entry,
        attempts: [
          {
            kind: 'steer',
            startedAt: '2026-09-02T10:00:00.000Z',
            ms: 1,
            note: 'continue',
            extra: true,
          },
        ],
      }),
    ],
    [
      'error',
      (entry: Record<string, unknown>) => ({
        ...entry,
        error: { name: 'Error', message: 'bad', extra: true },
      }),
    ],
    [
      'nested branch entry',
      (entry: Record<string, unknown>) => ({
        ...entry,
        step: '$parallel',
        parallel: {
          count: 1,
          branches: [[{ ...entry, extra: true }]],
        },
      }),
    ],
    [
      'nested branch version',
      (entry: Record<string, unknown>) => ({
        ...entry,
        step: '$parallel',
        parallel: {
          count: 1,
          branches: [[{ ...entry, v: JOURNAL_FORMAT_VERSION + 1 }]],
        },
      }),
    ],
    [
      'invalid status enum',
      (entry: Record<string, unknown>) => ({ ...entry, status: 'settled' }),
    ],
    [
      'invalid field type',
      (entry: Record<string, unknown>) => ({ ...entry, boot: 'first' }),
    ],
  ])('rejects unknown or incompatible data in a %s', async (_name, mutate) => {
    const { writeFile } = await import('node:fs/promises');
    const base: Record<string, unknown> = {
      v: JOURNAL_FORMAT_VERSION,
      seq: 0,
      step: 'agent',
      status: 'done',
      boot: 1,
      startedAt: '2026-09-02T10:00:00.000Z',
    };
    await writeFile(path, `${JSON.stringify(mutate(base))}\n`);

    await expect(openJournal(path)).rejects.toThrow(JournalFormatError);
  });

  it('validates parallel journal data and every nested branch entry', async () => {
    const base = {
      v: JOURNAL_FORMAT_VERSION,
      seq: 0,
      status: 'done' as const,
      boot: 1,
      startedAt: '2026-09-02T10:00:00.000Z',
    };

    await expect(
      appendEntry(path, { ...base, step: '$parallel' }, { runner: true }),
    ).rejects.toThrow(/parallel/i);
    await expect(
      appendEntry(path, {
        ...base,
        step: 'agent',
        parallel: { count: 1, branches: [[]] },
      }),
    ).rejects.toThrow(/parallel/i);
    await expect(
      appendEntry(
        path,
        {
          ...base,
          step: '$parallel',
          parallel: { count: 2, branches: [[]] },
        },
        { runner: true },
      ),
    ).rejects.toThrow(/branches.*count/i);
    await expect(
      appendEntry(
        path,
        {
          ...base,
          step: '$parallel',
          parallel: {
            count: 1,
            branches: [[{ ...base, step: '$parallel' }]],
          },
        },
        { runner: true },
      ),
    ).rejects.toThrow(/parallel/i);
  });

  it('replays every multi-Step branch by index despite reversed settlement timing', async () => {
    const firstEffects: string[] = [];
    const slow = deferred<void>();
    const first = await boot(async (ctx) => {
      await ctx.parallel('work', ['slow', 'fast'], {}, async (branch, item) => {
        await branch.step(`${item}:one`, {}, async () => {
          if (item === 'slow') {
            await slow.promise;
          }
          firstEffects.push(`${item}:one`);
          return { status: 'done', result: item };
        });
        await branch.step(`${item}:two`, {}, async () => {
          firstEffects.push(`${item}:two`);
          if (item === 'fast') {
            slow.resolve();
          }
          return item === 'fast'
            ? { status: 'waiting' }
            : { status: 'done', result: item };
        });
      });
      return 'merged';
    });

    expect(first.status).toBe('parked');
    expect(firstEffects).toEqual([
      'fast:one',
      'fast:two',
      'slow:one',
      'slow:two',
    ]);

    const replayedEffects: string[] = [];
    const second = await boot(async (ctx) => {
      await ctx.parallel('work', ['slow', 'fast'], {}, async (branch, item) => {
        await branch.step(`${item}:one`, {}, async () => {
          replayedEffects.push(`${item}:one`);
          return { status: 'done', result: item };
        });
        await branch.step(`${item}:two`, {}, async () => {
          replayedEffects.push(`${item}:two`);
          return { status: 'done', result: item };
        });
      });
      return 'merged';
    });

    expect(second).toMatchObject({
      status: 'finished',
      replayed: 3,
      executed: 1,
    });
    expect(replayedEffects).toEqual(['fast:two']);
    const parallel = (await openJournal(path)).latest(0)?.parallel;
    expect(parallel?.count).toBe(2);
    expect(
      parallel?.branches.map((branch) =>
        [...new Map(branch.map((entry) => [entry.seq, entry])).values()].map(
          (entry) => entry.step,
        ),
      ),
    ).toEqual([
      ['slow:one', 'slow:two'],
      ['fast:one', 'fast:two'],
    ]);
  });

  it('fails when a replay changes a parallel item count', async () => {
    await boot(async (ctx) => {
      await ctx.parallel('work', ['one'], {}, async (branch, _item) => {
        await branch.step('work', {}, async () => ({ status: 'waiting' }));
      });
      return 'merged';
    });

    const result = await boot(async (ctx) => {
      await ctx.parallel('work', ['one', 'two'], {}, async (branch, _item) => {
        await branch.step('work', {}, async () => ({
          status: 'done',
          result: null,
        }));
      });
      return 'merged';
    });

    expect(result.status).toBe('failed');
    expect(result.status === 'failed' && result.error.message).toMatch(
      /parallel.*count.*1.*2/is,
    );
    expect((await openJournal(path)).latest(0)).toMatchObject({
      status: 'failed',
      error: { name: 'DivergenceError' },
    });
  });

  it('keeps nested parallel journals separate by every parent index', async () => {
    const firstEffects: string[] = [];
    const first = await boot(async (ctx) => {
      await ctx.parallel(
        'outer',
        ['outer-a', 'outer-b'],
        {},
        async (branch, outer) => {
          await branch.parallel(
            'inner',
            ['left', 'right'],
            {},
            async (nested, inner) => {
              await nested.step(`${outer}:${inner}`, {}, async () => {
                firstEffects.push(`${outer}:${inner}`);
                return outer === 'outer-b' && inner === 'right'
                  ? { status: 'waiting' }
                  : { status: 'done', result: `${outer}:${inner}` };
              });
            },
          );
        },
      );
      return 'merged';
    });

    expect(first.status).toBe('parked');
    expect(firstEffects.sort()).toEqual([
      'outer-a:left',
      'outer-a:right',
      'outer-b:left',
      'outer-b:right',
    ]);

    const replayedEffects: string[] = [];
    const second = await boot(async (ctx) => {
      await ctx.parallel(
        'outer',
        ['outer-a', 'outer-b'],
        {},
        async (branch, outer) => {
          await branch.parallel(
            'inner',
            ['left', 'right'],
            {},
            async (nested, inner) => {
              await nested.step(`${outer}:${inner}`, {}, async () => {
                replayedEffects.push(`${outer}:${inner}`);
                return { status: 'done', result: `${outer}:${inner}` };
              });
            },
          );
        },
      );
      return 'merged';
    });

    expect(second).toMatchObject({
      status: 'finished',
      replayed: 3,
      executed: 1,
    });
    expect(replayedEffects).toEqual(['outer-b:right']);
    const outer = (await openJournal(path)).latest(0)?.parallel;
    expect(
      outer?.branches.map(
        (branch) => branch.at(-1)?.parallel?.branches[0]?.at(-1)?.step,
      ),
    ).toEqual(['outer-a:left', 'outer-b:left']);
  });

  it('fails rather than parking when a sibling branch throws', async () => {
    const result = await boot(async (ctx) => {
      await ctx.parallel('work', ['park', 'fail'], {}, async (branch, item) => {
        await branch.step(item, {}, async () => {
          if (item === 'park') {
            return { status: 'waiting' };
          }
          throw new Error('sibling failed');
        });
      });
      return 'merged';
    });

    expect(result).toMatchObject({ status: 'failed' });
    expect(result.status === 'failed' && result.error.message).toBe(
      'sibling failed',
    );
  });

  const caughtStructuralCases: [string, JournalEntry[]][] = [
    [
      'DivergenceError',
      [
        {
          v: JOURNAL_FORMAT_VERSION,
          seq: 0,
          step: 'recorded',
          status: 'done',
          boot: 1,
          startedAt: '2026-09-02T10:00:00.000Z',
        },
      ],
    ],
    [
      'CrashLoopError',
      Array.from({ length: CRASH_LOOP_LIMIT }, (_, boot): JournalEntry => ({
        v: JOURNAL_FORMAT_VERSION,
        seq: 0,
        step: 'work',
        status: 'running',
        boot: boot + 1,
        startedAt: '2026-09-02T10:00:00.000Z',
      })),
    ],
  ];

  it.each(caughtStructuralCases)(
    'latches a caught branch-local %s as fatal',
    async (name, branch) => {
      await appendEntry(
        path,
        {
          v: JOURNAL_FORMAT_VERSION,
          seq: 0,
          step: '$parallel',
          status: 'running',
          boot: 1,
          startedAt: '2026-09-02T10:00:00.000Z',
          parallel: { count: 1, branches: [branch] },
        },
        { runner: true },
      );

      const result = await boot(async (ctx) => {
        await ctx.parallel(
          'work',
          ['only'],
          {},
          async (branchContext, _item) => {
            try {
              await branchContext.step(
                name === 'DivergenceError' ? 'other' : 'work',
                {},
                async () => ({
                  status: 'done',
                  result: null,
                }),
              );
            } catch {
              // A branch cannot catch a structural replay failure away.
            }
          },
        );
        return 'merged';
      });

      expect(result.status === 'failed' && result.error.name).toBe(name);
      expect((await openJournal(path)).latest(0)).toMatchObject({
        status: 'failed',
        error: { name },
      });
    },
  );

  it('prevents a delayed sibling branch from executing after structural failure', async () => {
    await appendEntry(
      path,
      {
        v: JOURNAL_FORMAT_VERSION,
        seq: 0,
        step: '$parallel',
        status: 'running',
        boot: 1,
        startedAt: '2026-09-02T10:00:00.000Z',
        parallel: {
          count: 2,
          branches: [
            [
              {
                v: JOURNAL_FORMAT_VERSION,
                seq: 0,
                step: 'recorded',
                status: 'done',
                boot: 1,
                startedAt: '2026-09-02T10:00:00.000Z',
                result: null,
              },
            ],
            [],
          ],
        },
      },
      { runner: true },
    );

    let touched = false;
    const structuralStarted = deferred<void>();
    const result = await boot(async (ctx) => {
      await ctx.parallel(
        'work',
        ['structural', 'delayed'],
        {},
        async (branch, item) => {
          if (item === 'structural') {
            structuralStarted.resolve();
            await branch.step('other', {}, async () => ({
              status: 'done',
              result: null,
            }));
            return;
          }
          await structuralStarted.promise;
          await branch.step('delayed', {}, async () => {
            touched = true;
            return { status: 'done', result: null };
          });
        },
      );
      return 'merged';
    });

    expect(touched).toBe(false);
    expect(result.status === 'failed' && result.error.name).toBe(
      'DivergenceError',
    );
  });

  it('keeps a latched structural failure ahead of a later ordinary rejection', async () => {
    await appendEntry(
      path,
      {
        v: JOURNAL_FORMAT_VERSION,
        seq: 0,
        step: '$parallel',
        status: 'running',
        boot: 1,
        startedAt: '2026-09-02T10:00:00.000Z',
        parallel: {
          count: 2,
          branches: [
            [
              {
                v: JOURNAL_FORMAT_VERSION,
                seq: 0,
                step: 'recorded',
                status: 'done',
                boot: 1,
                startedAt: '2026-09-02T10:00:00.000Z',
                result: null,
              },
            ],
            [],
          ],
        },
      },
      { runner: true },
    );
    const structuralStarted = deferred<void>();
    const result = await boot(async (ctx) => {
      await ctx.parallel(
        'work',
        ['structural', 'ordinary'],
        {},
        async (branch, item) => {
          if (item === 'ordinary') {
            await structuralStarted.promise;
            throw new Error('ordinary failure');
          }
          structuralStarted.resolve();
          await branch.step('other', {}, async () => ({
            status: 'done',
            result: null,
          }));
        },
      );
      return 'merged';
    });
    expect(result.status === 'failed' && result.error.name).toBe(
      'DivergenceError',
    );
    expect((await openJournal(path)).latest(0)?.error?.name).toBe(
      'DivergenceError',
    );
  });

  it('settles a parent when a run callback throws synchronously', async () => {
    const result = await boot(async (ctx) => {
      await ctx.parallel('work', ['only'], {}, () => {
        throw new Error('synchronous failure');
      });
      return 'merged';
    });
    expect(result.status === 'failed' && result.error.message).toBe(
      'synchronous failure',
    );
    expect((await openJournal(path)).latest(0)?.status).toBe('failed');
  });

  it('applies the crash-loop guard to an interrupted parallel parent', async () => {
    for (let boot = 1; boot <= CRASH_LOOP_LIMIT; boot += 1) {
      await appendEntry(
        path,
        {
          v: JOURNAL_FORMAT_VERSION,
          seq: 0,
          step: '$parallel',
          status: 'running',
          boot,
          startedAt: '2026-09-02T10:00:00.000Z',
          parallel: { count: 1, branches: [[]] },
        },
        { runner: true },
      );
    }

    let ran = false;
    const result = await boot(async (ctx) => {
      await ctx.parallel('work', ['only'], {}, async (branch, _item) => {
        ran = true;
        await branch.step('work', {}, async () => ({
          status: 'done',
          result: null,
        }));
      });
      return 'merged';
    });

    expect(ran).toBe(false);
    expect(result.status === 'failed' && result.error.name).toBe(
      'CrashLoopError',
    );
    expect((await openJournal(path)).latest(0)).toMatchObject({
      status: 'failed',
      error: { name: 'CrashLoopError' },
    });
  });

  it('settles a parked parent as waiting so polling never becomes a crash loop', async () => {
    const workflow: Workflow = async (ctx) => {
      await ctx.parallel('work', ['only'], {}, async (branch, _item) => {
        await branch.step('wait', {}, async () => ({ status: 'waiting' }));
      });
      return 'merged';
    };

    for (let attempt = 0; attempt < CRASH_LOOP_LIMIT + 2; attempt += 1) {
      expect((await boot(workflow)).status).toBe('parked');
      expect((await openJournal(path)).latest(0)?.status).toBe('waiting');
    }
  });

  it('parks every enclosing parent when a branch catches nested ParkSignal', async () => {
    const result = await boot(async (ctx) => {
      await ctx.parallel('outer', ['outer'], {}, async (outer, _item) => {
        try {
          await outer.parallel(
            'inner',
            ['inner'],
            {},
            async (inner, _nested) => {
              await inner.step('wait', {}, async () => ({ status: 'waiting' }));
            },
          );
        } catch {
          // A user catch cannot make the enclosing parent complete.
        }
      });
      return 'merged';
    });

    expect(result.status).toBe('parked');
    const parent = (await openJournal(path)).latest(0);
    expect(parent?.status).toBe('waiting');
    expect(parent?.parallel?.branches[0]?.at(-1)?.status).toBe('waiting');
  });

  it('fails when a branch returns before replaying its recorded subjournal', async () => {
    await appendEntry(
      path,
      {
        v: JOURNAL_FORMAT_VERSION,
        seq: 0,
        step: '$parallel',
        status: 'running',
        boot: 1,
        startedAt: '2026-09-02T10:00:00.000Z',
        parallel: {
          count: 1,
          branches: [
            [
              {
                v: JOURNAL_FORMAT_VERSION,
                seq: 0,
                step: 'recorded',
                status: 'done',
                boot: 1,
                startedAt: '2026-09-02T10:00:00.000Z',
                result: null,
              },
            ],
          ],
        },
      },
      { runner: true },
    );

    const result = await boot(async (ctx) => {
      await ctx.parallel('work', ['only'], {}, async () => undefined);
      return 'merged';
    });

    expect(result.status === 'failed' && result.error.name).toBe(
      'DivergenceError',
    );
  });

  it('records and rethrows an ordinary branch failure across Boots', async () => {
    const caught: Error[] = [];
    const first = await boot(async (ctx) => {
      try {
        await ctx.parallel('work', ['only'], {}, async (branch, _item) => {
          await branch.step('work', {}, async () => {
            throw new Error('branch failed');
          });
        });
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        if (!(error instanceof Error)) throw error;
        caught.push(error);
      }
      await ctx.step('wait', {}, async () => ({ status: 'waiting' }));
      return 'merged';
    });

    expect(first.status).toBe('parked');
    expect((await openJournal(path)).latest(0)?.status).toBe('failed');

    let reran = false;
    const second = await boot(async (ctx) => {
      try {
        await ctx.parallel('work', ['only'], {}, async (branch, _item) => {
          reran = true;
          await branch.step('work', {}, async () => ({
            status: 'done',
            result: null,
          }));
        });
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        if (!(error instanceof Error)) throw error;
        caught.push(error);
      }
      await ctx.step('wait', {}, async () => ({
        status: 'done',
        result: null,
      }));
      return 'merged';
    });

    expect(reran).toBe(false);
    expect(caught.map((error) => error.message)).toEqual([
      'branch failed',
      'branch failed',
    ]);
    expect(second.status).toBe('finished');
  });

  it('fails when workflow code catches parallel waiting then throws', async () => {
    const result = await boot(async (ctx) => {
      try {
        await ctx.parallel('work', ['only'], {}, async (branch, _item) => {
          await branch.step('wait', {}, async () => ({ status: 'waiting' }));
        });
      } catch {
        // Deliberately continue into an ordinary workflow failure.
      }
      throw new Error('after waiting');
    });

    expect(result.status === 'failed' && result.error.message).toBe(
      'after waiting',
    );
  });

  it('reserves one top-level sequence and leaves the next serial Step after it', async () => {
    await boot(async (ctx) => {
      ctx.stage('Parallel work');
      await ctx.parallel('work', [1, 2], {}, async (branch, item) => {
        await branch.step(`branch:${item}`, {}, async () => ({
          status: 'done',
          result: item,
        }));
      });
      await ctx.step('after', {}, async () => ({
        status: 'done',
        result: null,
      }));
      return 'merged';
    });

    const journal = await openJournal(path);
    expect(journal.latest(0)?.step).toBe('$parallel');
    expect(journal.latest(0)?.status).toBe('done');
    expect(journal.latest(0)?.parallel?.branches[0]?.at(-1)?.stage).toBe(
      'Parallel work',
    );
    expect(journal.latest(1)?.step).toBe('after');
    expect(journal.latest(2)?.step).toBe(END_STEP);
  });
});

describe('divergence', () => {
  /** Journals a two-Step Run that parked, so the next Boot replays it. */
  async function parkedAfterTwoSteps(): Promise<void> {
    await boot(async (ctx) => {
      await ctx.step('agent', {}, async () => ({
        status: 'done',
        result: 'a',
      }));
      await ctx.step('exec', {}, async () => ({ status: 'done', result: 'b' }));
      await ctx.step('checkpoint', {}, async () => ({ status: 'waiting' }));
      return 'merged';
    });
  }

  it('fails the Run when ctx.* calls are reordered', async () => {
    // AC3. The step key at a seq *is* the replay contract.
    await parkedAfterTwoSteps();

    const result = await boot(async (ctx) => {
      await ctx.step('exec', {}, async () => ({ status: 'done', result: 'b' }));
      await ctx.step('agent', {}, async () => ({
        status: 'done',
        result: 'a',
      }));
      await ctx.step('checkpoint', {}, async () => ({
        status: 'done',
        result: {},
      }));
      return 'merged';
    });

    expect(result.status).toBe('failed');
    expect(result.status === 'failed' && result.error.name).toBe(
      'DivergenceError',
    );
  });

  it('names the seq, what was recorded and what the code asked for', async () => {
    await parkedAfterTwoSteps();

    const result = await boot(async (ctx) => {
      await ctx.step('exec', {}, async () => ({ status: 'done', result: 'b' }));
      return 'merged';
    });

    expect(result.status === 'failed' && result.error.message).toMatch(
      /seq 0.*recorded.*agent.*exec/s,
    );
  });

  it('is fatal even when workflow code swallows it', async () => {
    // Divergence is a bug in the Run, not a Step outcome — a `try`/`catch`
    // around a `ctx.*` call must not be able to talk the runner out of it.
    await parkedAfterTwoSteps();

    const result = await boot(async (ctx) => {
      try {
        await ctx.step('exec', {}, async () => ({
          status: 'done',
          result: 'b',
        }));
      } catch {
        // Swallowed on purpose.
      }
      return 'merged';
    });

    expect(result.status).toBe('failed');
    expect(result.status === 'failed' && result.error.name).toBe(
      'DivergenceError',
    );
  });

  it('catches a Workflow that stops short of what the journal recorded', async () => {
    await parkedAfterTwoSteps();

    const result = await boot(async (ctx) => {
      await ctx.step('agent', {}, async () => ({
        status: 'done',
        result: 'a',
      }));
      return 'merged';
    });

    expect(result.status === 'failed' && result.error.name).toBe(
      'DivergenceError',
    );
  });

  it('refuses a workflow Step in the runner-owned $ namespace', async () => {
    const result = await boot(async (ctx) => {
      await ctx.step('$end', {}, async () => ({ status: 'done', result: 1 }));
      return 'merged';
    });

    expect(result.status).toBe('failed');
    expect(result.status === 'failed' && result.error.message).toMatch(
      /runner-owned/,
    );
  });

  it('is an exported error class, so a caller can tell it apart', () => {
    expect(new DivergenceError('x')).toBeInstanceOf(Error);
    expect(new DivergenceError('x').name).toBe('DivergenceError');
  });
});

describe('the crash-loop guard', () => {
  /** One Boot that dies inside seq 0, leaving a bare `running` line. */
  async function bootThatDiesInTheStep(bootNumber: number): Promise<void> {
    await appendEntry(path, {
      v: JOURNAL_FORMAT_VERSION,
      seq: 0,
      step: 'agent',
      status: 'running',
      boot: bootNumber,
      startedAt: '2026-09-02T10:00:00.000Z',
    });
  }

  it('re-executes an interrupted Step — at-least-once, stated openly', async () => {
    await bootThatDiesInTheStep(1);

    let ran = 0;
    const result = await boot(async (ctx) => {
      await ctx.step('agent', {}, async () => {
        ran += 1;
        return { status: 'done', result: 'ok' };
      });
      return 'merged';
    });

    expect(ran).toBe(1);
    expect(result.status).toBe('finished');
  });

  it('fails the Run once three consecutive Boots have interrupted one seq', async () => {
    // AC5. Better than re-running an agent call that reliably kills the daemon.
    for (let bootNumber = 1; bootNumber <= CRASH_LOOP_LIMIT; bootNumber += 1) {
      await bootThatDiesInTheStep(bootNumber);
    }

    let ran = false;
    const result = await boot(async (ctx) => {
      await ctx.step('agent', {}, async () => {
        ran = true;
        return { status: 'done', result: 'ok' };
      });
      return 'merged';
    });

    expect(ran).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.status === 'failed' && result.error.name).toBe(
      'CrashLoopError',
    );
    expect(result.status === 'failed' && result.error.message).toMatch(
      /seq 0.*agent.*3/s,
    );
  });

  it('still allows the third Boot itself to try', async () => {
    for (let bootNumber = 1; bootNumber < CRASH_LOOP_LIMIT; bootNumber += 1) {
      await bootThatDiesInTheStep(bootNumber);
    }

    let ran = false;
    const result = await boot(async (ctx) => {
      await ctx.step('agent', {}, async () => {
        ran = true;
        return { status: 'done', result: 'ok' };
      });
      return 'merged';
    });

    expect(ran).toBe(true);
    expect(result.status).toBe('finished');
  });

  it('is an exported error class', () => {
    expect(new CrashLoopError('x').name).toBe('CrashLoopError');
  });
});

describe('an unreadable journal', () => {
  it('fails the Run on a format-version mismatch, without writing to it', async () => {
    // AC3. We refuse to append our own `$end` to a journal we cannot read.
    await appendEntry(path, {
      v: JOURNAL_FORMAT_VERSION,
      seq: 0,
      step: 'agent',
      status: 'done',
      boot: 1,
      startedAt: '2026-09-02T10:00:00.000Z',
    });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      path,
      '{"v":99,"seq":0,"step":"agent","status":"done","boot":1,"startedAt":"x"}\n',
    );

    let ran = false;
    await expect(
      boot(async () => {
        ran = true;
        return 'merged';
      }),
    ).rejects.toThrow(JournalFormatError);

    expect(ran).toBe(false);
    expect(await openJournal(path).catch(() => undefined)).toBeUndefined();
  });
});

describe('a Boot that cannot write', () => {
  it('dies rather than carrying on unrecorded', async () => {
    // If the journal cannot be appended to there is nothing to fall back on:
    // the Run's only durable truth is the journal.
    let calls = 0;
    await expect(
      boot(
        async (ctx) => {
          await ctx.step('agent', {}, async () => ({
            status: 'done',
            result: 'ok',
          }));
          return 'merged';
        },
        {
          append: async (target, entry, options) => {
            calls += 1;
            if (calls === 2) {
              throw new Error('disk full');
            }
            await appendEntry(target, entry, options);
          },
        },
      ),
    ).rejects.toThrow('disk full');
  });
});

describe('a Run killed at each phase boundary', () => {
  // AC1. Two-phase writes exist for exactly these three moments. The scripted
  // Run performs a side effect per Step, so re-execution is observable.
  const effects: string[] = [];

  const script: Workflow = async (ctx) => {
    await ctx.step('agent', {}, async () => {
      effects.push('agent');
      return { status: 'done', result: { summary: 'planned' } };
    });
    await ctx.step('exec', {}, async () => {
      effects.push('exec');
      return { status: 'done', result: { exitCode: 0 } };
    });
    return 'merged';
  };

  beforeEach(() => {
    effects.length = 0;
  });

  /**
   * Dies on the `nth` journal append, which is how each of the three
   * boundaries is reached honestly rather than with a hand-written fixture:
   * append 3 is `exec`'s `running` line (so `agent` is fully recorded),
   * append 4 is `exec`'s `done` line (so its effect ran and was not recorded).
   */
  function killOnAppend(nth: number) {
    let calls = 0;
    return async (
      target: string,
      entry: JournalEntry,
      options?: { runner?: boolean },
    ) => {
      calls += 1;
      if (calls === nth) {
        throw new Error('killed');
      }
      await appendEntry(target, entry, options);
    };
  }

  async function replayToCompletion(): Promise<BootResult> {
    const result = await boot(script);
    expect(result.status).toBe('finished');
    return result;
  }

  const completeJournal = [
    { seq: 0, step: 'agent', status: 'done', result: { summary: 'planned' } },
    { seq: 1, step: 'exec', status: 'done', result: { exitCode: 0 } },
    {
      seq: 2,
      step: END_STEP,
      status: 'done',
      result: { status: 'finished', outcome: 'merged' },
    },
  ];

  it('replays to the same journal when killed before the effect', async () => {
    // Append 3 is `exec`'s `running` line: the kill lands before its effect.
    await expect(boot(script, { append: killOnAppend(3) })).rejects.toThrow(
      'killed',
    );
    expect(effects).toEqual(['agent']);

    effects.length = 0;
    await replayToCompletion();

    // `agent` was recorded, so it did not re-run; `exec` never ran at all.
    expect(effects).toEqual(['exec']);
    expect(await folded()).toEqual(completeJournal);
  });

  it('re-executes when killed after the effect but before its record', async () => {
    // Append 4 is `exec`'s `done` line: its effect has already happened.
    await expect(boot(script, { append: killOnAppend(4) })).rejects.toThrow(
      'killed',
    );
    expect(effects).toEqual(['agent', 'exec']);

    effects.length = 0;
    await replayToCompletion();

    // The at-least-once case, and the only one of the three: `exec` ran twice
    // across the Run because its first run was never recorded.
    expect(effects).toEqual(['exec']);
    expect(await folded()).toEqual(completeJournal);
  });

  it('does not re-execute when killed after the record', async () => {
    // Append 5 is the `$end` line: both Steps are fully recorded.
    await expect(boot(script, { append: killOnAppend(5) })).rejects.toThrow(
      'killed',
    );
    expect(effects).toEqual(['agent', 'exec']);

    effects.length = 0;
    await replayToCompletion();

    expect(effects).toEqual([]);
    expect(await folded()).toEqual(completeJournal);
  });

  it('leaves the interrupted Step distinguishable from a never-reached one', async () => {
    // AC2's other half, asserted on a real kill rather than a fixture.
    await expect(boot(script, { append: killOnAppend(4) })).rejects.toThrow(
      'killed',
    );

    const journal = await openJournal(path);

    expect(journal.isInterrupted(1)).toBe(true);
    expect(journal.latest(1)?.status).toBe('running');
    // seq 2 was never reached, which is not the same thing.
    expect(journal.isInterrupted(2)).toBe(false);
    expect(journal.latest(2)).toBeUndefined();
  });
});
