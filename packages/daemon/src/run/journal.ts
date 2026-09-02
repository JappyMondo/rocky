/**
 * `journal.jsonl` — the Run's only durable truth (NG-574 §4–§5).
 *
 * A journal *is* an append-only ordered log, and JSONL is that datatype, so
 * there is no database here by design: on a developer's own machine,
 * `cat`-able and `rm`-able state is a feature while debugging an agent
 * framework, not a compromise.
 *
 * Two properties do the load-bearing work, and both are about a process that
 * died rather than returned:
 *
 * - **Two-phase writes.** The `running` line is appended *before* the effect
 *   and the `done` / `waiting` / `failed` line *after*. Last line per seq wins
 *   on read, so a seq whose last line is `running` is **interrupted** — which
 *   is what makes it distinguishable from one never reached at all.
 * - **A torn final line is truncated at boot.** Only the tail of an
 *   append-only file can tear, so an unusable line anywhere else is corruption
 *   and fails the Run instead.
 */
import { appendFile, mkdir, readFile, truncate } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { RunOutcome } from '@rocky/sdk';
import { z } from 'zod';

/**
 * Bumped when the entry shape changes incompatibly. A journal carrying any
 * other version fails its Run rather than being replayed wrong — the one piece
 * of insurance NG-574 §9 kept after invalidation dissolved.
 */
export const JOURNAL_FORMAT_VERSION = 1;

/**
 * `$`-prefixed step keys are the runner's own, so they can never collide with
 * a `ctx.*` key (NG-574 §5).
 */
export const RUNNER_KEY_PREFIX = '$';

/**
 * The terminal entry. Recording the outcome in the journal is what makes it
 * self-describing, and `run.json` a pure cache that boot rebuilds when the two
 * disagree.
 */
export const END_STEP = '$end';

/** Two-phase: `running` is written before the effect, the rest after it. */
export type StepStatus = 'running' | 'done' | 'waiting' | 'failed';

/** Thrown for a journal that cannot be trusted. Fails the Run. */
export class JournalFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JournalFormatError';
  }
}

const recordedErrorSchema = z.object({
  name: z.string(),
  message: z.string(),
  stack: z.string().optional(),
});

/** A thrown value flattened to something a JSONL line can hold. */
export type RecordedError = z.infer<typeof recordedErrorSchema>;

/**
 * One attempt at a Step. Retries never consume a seq — seq *is* the replay key
 * and must match the code's call sequence — so everything that happened before
 * the Step settled accumulates here instead, and only the successful attempt
 * sets the entry's `result`.
 *
 * Two kinds, per NG-596's agreed scope and NG-630: a `failed` attempt, and a
 * `steer` attempt for the interrupt-append-continue cycle of NG-574 §7. There
 * is deliberately no `interrupted` kind — ADR 0005 retired that word, and the
 * Step-level `interrupted` state below is an unrelated concept.
 */
const attemptSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('failed'),
    startedAt: z.string(),
    ms: z.number(),
    error: recordedErrorSchema,
    sessionId: z.string().optional(),
  }),
  z.object({
    kind: z.literal('steer'),
    startedAt: z.string(),
    ms: z.number(),
    /** The human's words, verbatim — the runner attaches no meaning. */
    note: z.string(),
    sessionId: z.string().optional(),
  }),
]);

export type Attempt = z.infer<typeof attemptSchema>;

const entrySchema = z.object({
  v: z.number().int(),
  /** The replay key: it must match the workflow's `ctx.*` call sequence. */
  seq: z.number().int().min(0),
  /** The step key — `agent`, `exec`, `scm:waitForCi`, or a runner `$` key. */
  step: z.string().min(1),
  /** Display-only, e.g. "reviewer 3/5". Never compared during replay. */
  label: z.string().optional(),
  status: z.enum(['running', 'done', 'waiting', 'failed']),
  /** Set by the successful attempt only. */
  result: z.unknown().optional(),
  /** From `ctx.stage()`, which stamps every entry created after it (NG-631). */
  stage: z.string().optional(),
  /** Monotonic per-Run. What makes "⟲ replayed 11 Steps" renderable. */
  boot: z.number().int().min(1),
  startedAt: z.string(),
  ms: z.number().optional(),
  /** A pointer to the Transcript, never something resume depends on. */
  sessionId: z.string().optional(),
  attempts: z.array(attemptSchema).optional(),
  error: recordedErrorSchema.optional(),
});

export type JournalEntry = z.infer<typeof entrySchema>;

const runEndSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('finished'),
    outcome: z.enum(['merged', 'rejected', 'exhausted']),
  }),
  z.object({ status: z.literal('failed'), error: recordedErrorSchema }),
  z.object({ status: z.literal('cancelled') }),
]);

/**
 * What the terminal `$end` entry's `result` holds. Recording the outcome in
 * the journal is what makes `run.json` a pure cache.
 */
export type RunEnd =
  | { status: 'finished'; outcome: RunOutcome }
  | { status: 'failed'; error: RecordedError }
  | { status: 'cancelled' };

/** Reads a `$end` entry's payload, or `undefined` if it is not one. */
export function parseRunEnd(result: unknown): RunEnd | undefined {
  const parsed = runEndSchema.safeParse(result);
  return parsed.success ? parsed.data : undefined;
}

/** A settle line closes a seq; a `running` line leaves it open. */
function isSettled(status: StepStatus): boolean {
  return status !== 'running';
}

export interface Journal {
  /** Every line, in file order, after any torn tail was dropped. */
  readonly entries: readonly JournalEntry[];
  /** True when a torn final line was dropped and the file repaired. */
  readonly truncated: boolean;
  /** The boot this Run's next Boot should stamp its entries with. */
  readonly nextBoot: number;
  /** The terminal `$end` entry, once the Run has ended. */
  readonly end: JournalEntry | undefined;
  /** The winning line for a seq: the last one written. */
  latest(seq: number): JournalEntry | undefined;
  /** A seq whose last line is `running` — the process died inside the Step. */
  isInterrupted(seq: number): boolean;
  /**
   * How many Boots left this seq unsettled in a row. Resets on every settle,
   * so a Step that parks and re-polls for a weekend never looks like a crash
   * loop however many `running` lines it accumulates.
   */
  interruptedBoots(seq: number): number;
}

function parseLines(
  path: string,
  text: string,
): {
  entries: JournalEntry[];
  truncated: boolean;
  keptBytes: number;
} {
  const segments = text.split('\n');
  // A file ending in a newline leaves '' here; anything else is a line the
  // process never finished writing.
  const unterminated = segments.pop() ?? '';
  let complete = segments;
  let truncated = unterminated !== '';

  const at = (index: number) => `${path} line ${index + 1}`;

  const raw: unknown[] = [];
  for (const [index, line] of complete.entries()) {
    try {
      raw.push(JSON.parse(line));
    } catch {
      if (index === complete.length - 1) {
        // The tail of an append-only file is the one place a crash can tear.
        complete = complete.slice(0, index);
        truncated = true;
        break;
      }
      throw new JournalFormatError(`${at(index)} is not valid JSON`);
    }
  }

  // Before validating the shape: a line from an incompatible daemon is
  // well-formed rather than torn, so dropping it would lose real history.
  for (const [index, value] of raw.entries()) {
    const version = (value as { v?: unknown }).v;
    if (typeof version === 'number' && version !== JOURNAL_FORMAT_VERSION) {
      throw new JournalFormatError(
        `${at(index)} was written at journal format version ${version}, and this daemon reads format version ${JOURNAL_FORMAT_VERSION} — failing the Run rather than replaying it wrong`,
      );
    }
  }

  const entries: JournalEntry[] = [];
  for (const [index, value] of raw.entries()) {
    const parsed = entrySchema.safeParse(value);
    if (parsed.success) {
      entries.push(parsed.data);
      continue;
    }
    if (index === raw.length - 1) {
      complete = complete.slice(0, index);
      truncated = true;
      break;
    }
    throw new JournalFormatError(
      `${at(index)} is not a journal entry — ${z.prettifyError(parsed.error)}`,
    );
  }

  const keptBytes = Buffer.byteLength(
    complete.map((line) => `${line}\n`).join(''),
    'utf8',
  );

  return { entries, truncated, keptBytes };
}

/**
 * Reads the journal and repairs it: a torn final line is dropped from the file
 * as well as from the returned entries, so the next append lands on a clean
 * line. `ftruncate` rather than a rewrite — it is one metadata operation, with
 * no window in which the log is half-written.
 */
export async function openJournal(path: string): Promise<Journal> {
  let text = '';
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  const { entries, truncated, keptBytes } = parseLines(path, text);
  if (truncated) {
    await truncate(path, keptBytes);
  }

  const byLast = new Map<number, JournalEntry>();
  const bySeq = new Map<number, JournalEntry[]>();
  let highestBoot = 0;
  let end: JournalEntry | undefined;

  for (const entry of entries) {
    byLast.set(entry.seq, entry);
    const lines = bySeq.get(entry.seq);
    if (lines) {
      lines.push(entry);
    } else {
      bySeq.set(entry.seq, [entry]);
    }
    highestBoot = Math.max(highestBoot, entry.boot);
    if (entry.step === END_STEP) {
      end = entry;
    }
  }

  return {
    entries,
    truncated,
    nextBoot: highestBoot + 1,
    end,
    latest: (seq) => byLast.get(seq),
    isInterrupted: (seq) => byLast.get(seq)?.status === 'running',
    interruptedBoots(seq) {
      const boots = new Set<number>();
      for (const entry of bySeq.get(seq) ?? []) {
        if (isSettled(entry.status)) {
          boots.clear();
        } else {
          boots.add(entry.boot);
        }
      }
      return boots.size;
    },
  };
}

export interface AppendOptions {
  /** Lets the runner write its own `$`-prefixed step keys. */
  runner?: boolean;
}

/**
 * Appends one line. A single `appendFile` of a newline-terminated string is
 * the whole write: if it tears, the tear is at the end of the file, which is
 * exactly what `openJournal` repairs.
 */
export async function appendEntry(
  path: string,
  entry: JournalEntry,
  options: AppendOptions = {},
): Promise<void> {
  if (entry.step.startsWith(RUNNER_KEY_PREFIX) && !options.runner) {
    throw new JournalFormatError(
      `step key "${entry.step}" is in the runner-owned "${RUNNER_KEY_PREFIX}" namespace — a ctx.* key cannot start with it`,
    );
  }
  if (entry.v !== JOURNAL_FORMAT_VERSION) {
    throw new JournalFormatError(
      `refusing to append an entry at journal format version ${entry.v} — this daemon writes format version ${JOURNAL_FORMAT_VERSION}`,
    );
  }

  const parsed = entrySchema.safeParse(entry);
  if (!parsed.success) {
    throw new JournalFormatError(
      `refusing to append a malformed entry — ${z.prettifyError(parsed.error)}`,
    );
  }

  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(entry)}\n`);
}

/** Flattens a thrown value into something a JSONL line can hold. */
export function recordError(thrown: unknown): RecordedError {
  if (thrown instanceof Error) {
    return {
      name: thrown.name,
      message: thrown.message,
      ...(thrown.stack === undefined ? {} : { stack: thrown.stack }),
    };
  }
  return { name: 'Error', message: String(thrown) };
}
