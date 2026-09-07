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

/** Reserved structural Step key for one journaled fan-out. */
const PARALLEL_STEP = '$parallel';

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
  { status: 'done'; result: T; sessionId?: string } | { status: 'waiting' };

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
  /** Background commands need a fresh process on a working Boot, never a poll. */
  replay?: 'restart';
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
  /**
   * Runs branches concurrently while storing each index in its own sub-journal.
   * The parent consumes one sequence in the surrounding journal.
   */
  parallel<T>(
    key: string,
    items: readonly T[],
    options: StepOptions,
    run: (branch: BootContext, item: T, index: number) => Promise<unknown>,
  ): Promise<unknown[]>;
}

interface BootCounts {
  boot: number;
  /** Steps that handed back a recorded result. NG-573 renders this. */
  replayed: number;
  executed: number;
}

export type BootResult =
  | ({ status: 'ready' } & BootCounts)
  | ({ status: 'cancelled' } & BootCounts)
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
  poll?: boolean;
  signal?: AbortSignal;
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
  const text = JSON.stringify(value);
  const validate = (item: unknown): void => {
    if (
      item === null ||
      typeof item === 'string' ||
      typeof item === 'boolean' ||
      (typeof item === 'number' && Number.isFinite(item))
    )
      return;
    if (
      typeof item !== 'object' ||
      (!Array.isArray(item) &&
        Object.getPrototypeOf(item) !== Object.prototype &&
        Object.getPrototypeOf(item) !== null)
    ) {
      throw new TypeError('Step result must be plain JSON data');
    }
    for (const child of Object.values(item)) validate(child);
  };
  validate(value);
  return JSON.parse(text) as T;
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

function replayableParallelError(recorded: RecordedError): Error {
  if (recorded.name === 'DivergenceError') {
    return new DivergenceError(recorded.message);
  }
  if (recorded.name === 'CrashLoopError') {
    return new CrashLoopError(recorded.message);
  }
  return rethrowable(recorded);
}

/** Presents one persisted branch array through the normal replay lookup API. */
function journalFor(entries: readonly JournalEntry[]): Journal {
  const latest = new Map<number, JournalEntry>();
  const bySeq = new Map<number, JournalEntry[]>();
  for (const entry of entries) {
    latest.set(entry.seq, entry);
    const lines = bySeq.get(entry.seq);
    if (lines) {
      lines.push(entry);
    } else {
      bySeq.set(entry.seq, [entry]);
    }
  }
  return {
    entries,
    truncated: false,
    nextBoot: 1,
    end: undefined,
    latest: (seq) => latest.get(seq),
    isInterrupted: (seq) => latest.get(seq)?.status === 'running',
    interruptedBoots(seq) {
      const boots = new Set<number>();
      for (const entry of bySeq.get(seq) ?? []) {
        if (entry.status === 'running') {
          boots.add(entry.boot);
        } else {
          boots.clear();
        }
      }
      return boots.size;
    },
  };
}

class BootRunner implements BootContext {
  private pending: Promise<unknown> | undefined;
  private seq = 0;
  currentStage: string | undefined;
  /** Latched so workflow code cannot catch its way out of failing the Run. */
  fatal: Error | undefined;
  /** Latched likewise: a journal that cannot be written ends the Boot. */
  infra: unknown;
  parked: string | undefined;
  ready = false;
  replayed = 0;
  executed = 0;

  constructor(
    readonly boot: number,
    private readonly journal: Journal,
    private readonly writeEntry: (
      entry: JournalEntry,
      options?: AppendOptions,
    ) => Promise<void>,
    private readonly now: () => number,
    initialStage?: string,
    private readonly latchFatal?: (error: Error) => void,
    private readonly fanoutFatal?: { error: Error | undefined },
    private readonly poll = false,
    private readonly signal?: AbortSignal,
  ) {
    this.currentStage = initialStage;
  }

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
    this.latch(error);
    throw this.fatal;
  }

  private latch(error: Error): void {
    this.fatal ??= error;
    this.latchFatal?.(this.fatal);
  }

  step<T>(key: string, options: StepOptions, effect: Effect<T>): Promise<T> {
    return this.exclusive(() => this.performStep(key, options, effect));
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.signal?.aborted) return Promise.reject(new CancelSignal());
    if (this.ready) return Promise.reject(new ReadySignal());
    if (this.parked) return Promise.reject(new ParkSignal(this.parked));
    if (this.pending) {
      this.latch(
        new DivergenceError(
          'Concurrent ctx calls are unsupported; use ctx.parallel(items, fn)',
        ),
      );
      return Promise.reject(this.fatal);
    }
    const pending = work().finally(() => {
      this.pending = undefined;
    });
    this.pending = pending;
    // A Workflow may forget to await. Drain it before the terminal record.
    void pending.catch(() => undefined);
    return pending;
  }

  async drain(): Promise<void> {
    if (this.pending) {
      this.latch(
        new DivergenceError('Workflow returned with an unawaited ctx call'),
      );
      await this.pending.catch(() => undefined);
    }
  }

  private async performStep<T>(
    key: string,
    options: StepOptions,
    effect: Effect<T>,
  ): Promise<T> {
    // Once the Run is failing, every later Step fails the same way rather than
    // running an effect against a journal we have already stopped trusting.
    const fatal = this.fatal ?? this.fanoutFatal?.error;
    if (fatal) {
      throw fatal;
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

      if (
        recorded.status === 'done' &&
        (options.replay !== 'restart' || this.poll)
      ) {
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

    if (this.poll && recorded?.status !== 'waiting') {
      this.ready = true;
      throw new ReadySignal();
    }

    return await this.execute(seq, key, options, effect, recorded);
  }

  parallel<T>(
    key: string,
    items: readonly T[],
    options: StepOptions,
    run: (branch: BootContext, item: T, index: number) => Promise<unknown>,
  ): Promise<unknown[]> {
    return this.exclusive(() => this.performParallel(key, items, options, run));
  }

  private async performParallel<T>(
    key: string,
    items: readonly T[],
    options: StepOptions,
    run: (branch: BootContext, item: T, index: number) => Promise<unknown>,
  ): Promise<unknown[]> {
    const fatal = this.fatal ?? this.fanoutFatal?.error;
    if (fatal) {
      throw fatal;
    }

    const seq = this.seq++;
    const recorded = this.journal.latest(seq);
    if (this.poll && !recorded) {
      this.ready = true;
      throw new ReadySignal();
    }
    if (recorded && recorded.step !== PARALLEL_STEP) {
      this.fail(
        new DivergenceError(
          `seq ${seq}: the journal recorded step "${recorded.step}" and this replay asked for parallel. The Workflow is not deterministic — a Run cannot be replayed past this point.`,
        ),
      );
    }
    const branches =
      recorded?.parallel?.branches.map((branch) => [...branch]) ??
      items.map(() => []);
    const base = {
      v: JOURNAL_FORMAT_VERSION,
      seq,
      step: PARALLEL_STEP,
      boot: this.boot,
      startedAt: new Date(this.now()).toISOString(),
      ...(options.label === undefined
        ? { label: key }
        : { label: options.label }),
      ...(this.currentStage === undefined ? {} : { stage: this.currentStage }),
    };
    let parent: JournalEntry = {
      ...base,
      status: 'running',
      parallel: {
        count: recorded?.parallel?.count ?? items.length,
        branches,
        results: recorded?.parallel?.results,
      },
    };
    let writes = Promise.resolve();
    const persist = async () => {
      const snapshot = structuredClone(parent);
      writes = writes.then(() => this.write(snapshot, { runner: true }));
      await writes;
    };
    const settleFailed = async (reason: unknown) => {
      parent = {
        ...parent,
        status: 'failed',
        ms: this.now() - new Date(base.startedAt).getTime(),
        error: recordError(reason),
      };
      await persist();
    };

    if (recorded?.parallel && recorded.parallel.count !== items.length) {
      const error = new DivergenceError(
        `seq ${seq}: the journal recorded parallel count ${recorded.parallel.count} and this replay asked for ${items.length}. The Workflow is not deterministic — a Run cannot be replayed past this point.`,
      );
      await settleFailed(error);
      this.fail(error);
    }
    if (recorded?.status === 'failed') {
      const error = replayableParallelError(
        recorded.error ?? { name: 'Error', message: 'parallel branch failed' },
      );
      if (error instanceof DivergenceError || error instanceof CrashLoopError) {
        this.fail(error);
      }
      throw error;
    }
    if (recorded?.status === 'running') {
      const interrupted = this.journal.interruptedBoots(seq);
      if (interrupted >= CRASH_LOOP_LIMIT) {
        const error = new CrashLoopError(
          `seq ${seq}: parallel was found running at boot ${interrupted} times in a row. Failing the Run rather than performing it again.`,
        );
        await settleFailed(error);
        this.fail(error);
      }
    }

    // A running parent line is the durable reservation before any branch can
    // touch the world. On replay it also records a fresh attempt at any waiting
    // branch, just like a normal Step's running line.
    await persist();

    const fanoutFatal: { error: Error | undefined } = { error: undefined };
    const branchContexts = branches.map(
      (branch) =>
        new BootRunner(
          this.boot,
          journalFor(branch),
          async (entry) => {
            branch.push(entry);
            await persist();
          },
          this.now,
          this.currentStage,
          (error) => {
            fanoutFatal.error ??= error;
            this.latch(error);
          },
          fanoutFatal,
          this.poll,
          this.signal,
        ),
    );
    const settled = await Promise.allSettled(
      items.map((item, index) =>
        Promise.resolve()
          .then(() => run(branchContexts[index]!, item, index))
          .finally(() => branchContexts[index]!.drain()),
      ),
    );

    for (const branch of branchContexts) {
      this.replayed += branch.replayed;
      this.executed += branch.executed;
    }

    if (this.fatal) {
      await settleFailed(this.fatal);
      throw this.fatal;
    }
    for (const result of settled) {
      if (result.status === 'rejected') {
        if (
          !(result.reason instanceof ParkSignal) &&
          !(result.reason instanceof ReadySignal) &&
          !(result.reason instanceof CancelSignal)
        ) {
          await settleFailed(result.reason);
          if (
            result.reason instanceof DivergenceError ||
            result.reason instanceof CrashLoopError
          ) {
            this.fail(result.reason);
          }
          throw result.reason;
        }
      }
    }
    if (this.signal?.aborted) throw new CancelSignal();
    for (const [index, result] of settled.entries()) {
      if (
        result.status !== 'fulfilled' ||
        branchContexts[index]!.ready ||
        branchContexts[index]!.parked
      ) {
        continue;
      }
      const branch = branchContexts[index]!;
      const beyond = branch.journal.entries.find(
        (entry) => entry.seq >= branch.reached(),
      );
      if (beyond) {
        const error = new DivergenceError(
          `parallel branch ${index} returned after ${branch.reached()} Steps, but its journal records step "${beyond.step}" at seq ${beyond.seq}. The Workflow is not deterministic.`,
        );
        await settleFailed(error);
        this.fail(error);
      }
    }

    const parkedResult = settled.find(
      (result): result is PromiseRejectedResult =>
        result.status === 'rejected' && result.reason instanceof ParkSignal,
    );
    const parkedBranch = branchContexts.find((branch) => branch.parked);
    if (branchContexts.some((branch) => branch.ready)) {
      this.ready = true;
      parent = { ...parent, status: 'waiting' };
      await persist();
      throw new ReadySignal();
    }
    if (parkedResult || parkedBranch) {
      const signal =
        parkedResult?.reason ?? new ParkSignal(parkedBranch!.parked!);
      this.parked ??= signal.stepKey;
      parent = {
        ...parent,
        status: 'waiting',
        ms: this.now() - new Date(base.startedAt).getTime(),
      };
      await persist();
      throw signal;
    }
    for (const result of settled) {
      // Every rejected result at this point was handled by the failure loop.
      if (result.status === 'rejected') throw result.reason;
    }

    let results: { value?: unknown }[];
    try {
      results =
        recorded?.parallel?.results ??
        settled.map((result) => {
          if (result.status === 'rejected') throw result.reason;
          return result.value === undefined
            ? {}
            : { value: jsonClone(result.value) };
        });
    } catch (error) {
      await settleFailed(error);
      throw error;
    }
    parent = {
      ...parent,
      status: 'done',
      parallel: { count: items.length, branches, results },
      ms: this.now() - new Date(base.startedAt).getTime(),
    };
    await persist();
    return results.map((result) => result.value);
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
    if (this.signal?.aborted) throw new CancelSignal();
    if (this.fatal ?? this.fanoutFatal?.error)
      throw this.fatal ?? this.fanoutFatal?.error;

    let outcome: StepOutcome<T>;
    try {
      outcome = await effect({ record: (attempt) => attempts.push(attempt) });
      if (outcome.status === 'done') {
        outcome = { ...outcome, result: jsonClone(outcome.result) };
      }
    } catch (thrown) {
      if (this.signal?.aborted) throw new CancelSignal();
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

    const result = outcome.result;
    await this.write({
      ...settle(),
      status: 'done',
      ...(result === undefined ? {} : { result }),
      ...(outcome.sessionId === undefined
        ? {}
        : { sessionId: outcome.sessionId }),
    });
    if (this.poll && recorded?.status === 'waiting') {
      this.ready = true;
      throw new ReadySignal();
    }
    return result;
  }

  private async write(
    entry: JournalEntry,
    options?: AppendOptions,
  ): Promise<void> {
    try {
      await this.writeEntry(entry, options);
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

class ReadySignal extends Error {}
class CancelSignal extends Error {}

function endResultFor(journal: Journal): BootResult | undefined {
  const end = journal.end;
  if (!end) {
    return undefined;
  }
  const runEnd = parseRunEnd(end.result);
  const counts = {
    boot: Math.max(1, journal.nextBoot - 1),
    replayed: 0,
    executed: 0,
  };

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
  return { status: 'cancelled', ...counts };
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
  const runner = new BootRunner(
    boot,
    journal,
    (entry, appendOptions) => append(journalPath, entry, appendOptions),
    now,
    undefined,
    undefined,
    undefined,
    options.poll,
    options.signal,
  );

  let outcome: RunOutcome | undefined;
  let thrown: unknown;
  let didThrow = false;
  try {
    outcome = await workflow(runner);
  } catch (error) {
    thrown = error;
    didThrow = true;
  }
  await runner.drain();

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
        ...(runner.currentStage === undefined
          ? {}
          : { stage: runner.currentStage }),
        ...(end.status === 'failed' ? { error: end.error } : {}),
      },
      { runner: true },
    );
  };

  const failWith = async (error: RecordedError): Promise<BootResult> => {
    await writeEnd({ status: 'failed', error }, 'failed');
    return { status: 'failed', error, ...counts };
  };

  if (options.signal?.aborted) return { status: 'cancelled', ...counts };
  if (runner.fatal) {
    return await failWith(recordError(runner.fatal));
  }
  if (
    didThrow &&
    !(thrown instanceof ParkSignal) &&
    !(thrown instanceof ReadySignal)
  ) {
    return await failWith(recordError(thrown));
  }
  if (runner.ready) return { status: 'ready', ...counts };
  if (runner.parked !== undefined) {
    return { status: 'parked', reason: runner.parked, ...counts };
  }
  if (didThrow) {
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
  if (options.poll) return { status: 'ready', ...counts };
  if (
    settled !== 'merged' &&
    settled !== 'rejected' &&
    settled !== 'exhausted'
  ) {
    return failWith(
      recordError(
        new Error('Workflow must return merged, rejected or exhausted'),
      ),
    );
  }
  await writeEnd({ status: 'finished', outcome: settled }, 'done');
  return { status: 'finished', outcome: settled, ...counts };
}
