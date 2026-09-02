/**
 * Deterministic replay — one Boot over a Run (NG-572 §1, NG-574 §5–§6, §8).
 *
 * A Boot re-runs the workflow function **from the top**. Completed `ctx.*`
 * calls hand back their recorded result without touching the world; plain
 * TypeScript between Steps re-executes, which is safe precisely because the
 * Steps around it do not. Waking a Parked Run is an ordinary Boot, so this
 * path runs six times a minute rather than only after a crash — which is why
 * there is deliberately **no cached replay state between Boots**. One code
 * path, exercised constantly, is the version that still works in six months.
 *
 * The two ways a Run fails are both bugs rather than staleness: **divergence**
 * (the code asked for a different Step than the journal recorded at that seq)
 * and the **crash loop** (three consecutive Boots left one seq unsettled).
 * Nothing else invalidates a Run — NG-574 §9 dissolved that whole category.
 */
import type { RunOutcome } from '@rocky/sdk';

import {
  END_STEP,
  JOURNAL_FORMAT_VERSION,
  RUNNER_KEY_PREFIX,
  appendEntry,
  openJournal,
  parseRunEnd,
  recordError,
  type Attempt,
  type AppendOptions,
  type Journal,
  type JournalEntry,
  type RecordedError,
  type RunEnd,
} from './journal.js';

/**
 * A Step found `running` at boot this many times running fails the Run, rather
 * than re-running an agent call that reliably kills the daemon (NG-574 §6).
 */
export const CRASH_LOOP_LIMIT = 3;

/** The code asked for a different Step than the journal recorded at that seq. */
export class DivergenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DivergenceError';
  }
}

/** Three consecutive Boots left the same seq unsettled. */
export class CrashLoopError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CrashLoopError';
  }
}

/**
 * What a Step's effect reports back. `waiting` is how a Step that cannot
 * complete yet parks the Run; retrying it on the next Boot is asking the world
 * again, which is the same shape for a Checkpoint and for CI (NG-574 §8).
 */
export type StepOutcome<T> =
  | { status: 'done'; result: T; sessionId?: string }
  | { status: 'waiting' };

export interface EffectHandle {
  /**
   * Record an attempt that did not settle the Step. Retries never consume a
   * seq — seq *is* the replay key — so a retry, or the interrupt-append-
   * continue cycle of a Steer, accumulates here instead.
   */
  record(attempt: Attempt): void;
}

export type Effect<T> = (handle: EffectHandle) => Promise<StepOutcome<T>>;

export interface StepOptions {
  /** Display-only, e.g. "reviewer 3/5". Never compared during replay. */
  label?: string;
}

/** What a Workflow is driven through. NG-598 wires the real `ctx` onto it. */
export interface BootContext {
  /** The Boot number every entry this Boot writes is stamped with. */
  readonly boot: number;
  /**
   * Display-only stage marker: takes no seq, is never journaled as a Step of
   * its own, and stamps `stage` on every entry created after it. The runner
   * never learns what the string means (NG-574 §5, NG-631).
   */
  stage(label: string): void;
  /** One journaled Step, written twice: `running`, then how it settled. */
  step<T>(key: string, options: StepOptions, effect: Effect<T>): Promise<T>;
}

interface BootCounts {
  boot: number;
  /** Steps that handed back a recorded result. NG-573 renders this. */
  replayed: number;
  executed: number;
}

export type BootResult =
  | ({ status: 'finished'; outcome: RunOutcome } & BootCounts)
  | ({ status: 'parked'; reason: string } & BootCounts)
  | ({ status: 'failed'; error: RecordedError } & BootCounts);

type Appender = (
  path: string,
  entry: JournalEntry,
  options?: AppendOptions,
) => Promise<void>;

export interface RunBootOptions {
  journalPath: string;
  workflow: (ctx: BootContext) => Promise<RunOutcome>;
  /** Epoch millis. Injected so a test can have a predictable `ms`. */
  now?: () => number;
  /**
   * The journal appender. Defaults to `appendEntry`; a failure here aborts the
   * Boot rather than being recorded, because there is nowhere to record it —
   * the journal is the Run's only durable truth. Injectable so a test can
   * reach the three phase boundaries a `kill -9` produces.
   */
  append?: Appender;
}

/**
 * Round-trips a Step's result through JSON on the live path too, so a Step
 * returns the *same* value on the Boot that executed it as on every Boot that
 * replays it. Anything a JSONL line cannot hold fails here, at the call site
 * that produced it, rather than as a mystery on the next Boot.
 */
function jsonClone<T>(value: T): T {
  if (value === undefined) {
    return value;
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Rebuilds a thrown Error from its recorded form, name and message intact. */
function rethrowable(recorded: RecordedError): Error {
  const error = new Error(recorded.message);
  error.name = recorded.name;
  if (recorded.stack !== undefined) {
    error.stack = recorded.stack;
  }
  return error;
}

class BootRunner implements BootContext {
  private seq = 0;
  private currentStage: string | undefined;
  /** Latched so workflow code cannot catch its way out of failing the Run. */
  fatal: Error | undefined;
  /** Latched likewise: a journal that cannot be written ends the Boot. */
  infra: unknown;
  parked: string | undefined;
  replayed = 0;
  executed = 0;

  constructor(
    readonly boot: number,
    private readonly journal: Journal,
    private readonly path: string,
    private readonly append: Appender,
    private readonly now: () => number,
  ) {}

  /** The seq the terminal `$end` entry takes: past the code and the journal. */
  endSeq(): number {
    const highest = this.journal.entries.reduce(
      (max, entry) => Math.max(max, entry.seq),
      -1,
    );
    return Math.max(this.seq, highest + 1);
  }

  /** How far the code got, so a Workflow stopping short is detectable. */
  reached(): number {
    return this.seq;
  }

  stage(label: string): void {
    this.currentStage = label;
  }

  private fail<E extends Error>(error: E): never {
    this.fatal ??= error;
    throw this.fatal;
  }

  async step<T>(
    key: string,
    options: StepOptions,
    effect: Effect<T>,
  ): Promise<T> {
    // Once the Run is failing, every later Step fails the same way rather than
    // running an effect against a journal we have already stopped trusting.
    if (this.fatal) {
      throw this.fatal;
    }

    const seq = this.seq++;

    if (key.startsWith(RUNNER_KEY_PREFIX)) {
      this.fail(
        new DivergenceError(
          `seq ${seq}: step key "${key}" is in the runner-owned "${RUNNER_KEY_PREFIX}" namespace — a ctx.* key cannot start with it`,
        ),
      );
    }

    const recorded = this.journal.latest(seq);
    if (recorded) {
      if (recorded.step !== key) {
        this.fail(
          new DivergenceError(
            `seq ${seq}: the journal recorded step "${recorded.step}" and this replay asked for "${key}". The Workflow is not deterministic — a Run cannot be replayed past this point.`,
          ),
        );
      }

      if (recorded.status === 'done') {
        this.replayed += 1;
        return recorded.result as T;
      }

      if (recorded.status === 'failed') {
        // A recorded, replayable outcome: re-throw rather than re-execute, or
        // a Workflow that caught the failure diverges the moment a replay
        // succeeds where the original Run failed (NG-574 §6).
        this.replayed += 1;
        throw rethrowable(
          recorded.error ?? {
            name: 'Error',
            message: `step "${key}" failed`,
          },
        );
      }

      if (recorded.status === 'running') {
        const interrupted = this.journal.interruptedBoots(seq);
        if (interrupted >= CRASH_LOOP_LIMIT) {
          this.fail(
            new CrashLoopError(
              `seq ${seq}: step "${key}" was found running at boot ${interrupted} times in a row. Failing the Run rather than performing it again.`,
            ),
          );
        }
      }
      // `waiting` retries its effect — asking the world again — and `running`
      // performs it again, which is what at-least-once means.
    }

    return await this.execute(seq, key, options, effect, recorded);
  }

  private async execute<T>(
    seq: number,
    key: string,
    options: StepOptions,
    effect: Effect<T>,
    recorded: JournalEntry | undefined,
  ): Promise<T> {
    this.executed += 1;

    const startedMs = this.now();
    const startedAt = new Date(startedMs).toISOString();
    // Attempts accumulate across Boots: a Steer delivered before a crash is
    // still part of this Step's history.
    const attempts: Attempt[] = [...(recorded?.attempts ?? [])];

    const base = {
      v: JOURNAL_FORMAT_VERSION,
      seq,
      step: key,
      boot: this.boot,
      startedAt,
      ...(options.label === undefined ? {} : { label: options.label }),
      ...(this.currentStage === undefined ? {} : { stage: this.currentStage }),
    };
    const settle = () => ({
      ...base,
      ms: this.now() - startedMs,
      ...(attempts.length === 0 ? {} : { attempts }),
    });

    // Phase one, before the effect. A Run that dies from here until the line
    // below performs this Step again on the next Boot.
    await this.write({ ...base, status: 'running' });

    let outcome: StepOutcome<T>;
    try {
      outcome = await effect({ record: (attempt) => attempts.push(attempt) });
    } catch (thrown) {
      const error = recordError(thrown);
      await this.write({ ...settle(), status: 'failed', error });
      // Into workflow code as an ordinary exception a Workflow may catch.
      throw thrown;
    }

    if (outcome.status === 'waiting') {
      await this.write({ ...settle(), status: 'waiting' });
      this.parked ??= key;
      throw new ParkSignal(key);
    }

    const result = jsonClone(outcome.result);
    await this.write({
      ...settle(),
      status: 'done',
      ...(result === undefined ? {} : { result }),
      ...(outcome.sessionId === undefined
        ? {}
        : { sessionId: outcome.sessionId }),
    });
    return result;
  }

  private async write(entry: JournalEntry): Promise<void> {
    try {
      await this.append(this.path, entry);
    } catch (error) {
      this.infra ??= error;
      throw error;
    }
  }
}

/** Unwinds the Boot when a Step parks. Never surfaces to a caller. */
class ParkSignal extends Error {
  constructor(readonly stepKey: string) {
    super(`parked at ${stepKey}`);
    this.name = 'ParkSignal';
  }
}

function endResultFor(journal: Journal): BootResult | undefined {
  const end = journal.end;
  if (!end) {
    return undefined;
  }
  const runEnd = parseRunEnd(end.result);
  const counts = { boot: Math.max(1, journal.nextBoot - 1), replayed: 0, executed: 0 };

  if (!runEnd) {
    return {
      status: 'failed',
      error: { name: 'Error', message: 'the $end entry is unreadable' },
      ...counts,
    };
  }
  if (runEnd.status === 'finished') {
    return { status: 'finished', outcome: runEnd.outcome, ...counts };
  }
  if (runEnd.status === 'failed') {
    return { status: 'failed', error: runEnd.error, ...counts };
  }
  return {
    status: 'failed',
    error: { name: 'Cancelled', message: 'the Run was cancelled' },
    ...counts,
  };
}

/**
 * Runs one Boot. Rejects — rather than returning a failed result — when the
 * journal itself cannot be read or written: the Run's only durable truth is
 * unavailable, so the runner cannot even record its own failure, and it will
 * not append a v${JOURNAL_FORMAT_VERSION} line to a journal it has refused to
 * parse. The caller marks the Run failed in `run.json`.
 */
export async function runBoot(options: RunBootOptions): Promise<BootResult> {
  const { journalPath, workflow } = options;
  const append = options.append ?? appendEntry;
  const now = options.now ?? (() => Date.now());

  const journal = await openJournal(journalPath);

  // A Run that already ended is not booted again; its outcome is recorded.
  const already = endResultFor(journal);
  if (already) {
    return already;
  }

  const boot = journal.nextBoot;
  const runner = new BootRunner(boot, journal, journalPath, append, now);

  let outcome: RunOutcome | undefined;
  let thrown: unknown;
  try {
    outcome = await workflow(runner);
  } catch (error) {
    thrown = error;
  }

  const counts = {
    boot,
    replayed: runner.replayed,
    executed: runner.executed,
  };

  // Checked before anything else: workflow code may have caught these, and
  // neither is a Step outcome it gets a say in.
  if (runner.infra !== undefined) {
    throw runner.infra;
  }
  if (runner.parked !== undefined) {
    return { status: 'parked', reason: runner.parked, ...counts };
  }

  const writeEnd = async (end: RunEnd, status: 'done' | 'failed') => {
    await append(
      journalPath,
      {
        v: JOURNAL_FORMAT_VERSION,
        seq: runner.endSeq(),
        step: END_STEP,
        status,
        boot,
        startedAt: new Date(now()).toISOString(),
        result: end,
        ...(end.status === 'failed' ? { error: end.error } : {}),
      },
      { runner: true },
    );
  };

  const failWith = async (error: RecordedError): Promise<BootResult> => {
    await writeEnd({ status: 'failed', error }, 'failed');
    return { status: 'failed', error, ...counts };
  };

  if (runner.fatal) {
    return await failWith(recordError(runner.fatal));
  }
  if (thrown !== undefined) {
    return await failWith(recordError(thrown));
  }

  // The Workflow returned, so every Step the journal holds should have been
  // reached. Anything beyond means the code took a different path this time.
  const beyond = journal.entries.find((entry) => entry.seq >= runner.reached());
  if (beyond) {
    return await failWith(
      recordError(
        new DivergenceError(
          `the Workflow returned after ${runner.reached()} Steps, but the journal records step "${beyond.step}" at seq ${beyond.seq}. The Workflow is not deterministic.`,
        ),
      ),
    );
  }

  const settled: RunOutcome = outcome as RunOutcome;
  await writeEnd({ status: 'finished', outcome: settled }, 'done');
  return { status: 'finished', outcome: settled, ...counts };
}
