/**
 * `run.json` — the Run header (NG-574 §4–§5, §8).
 *
 * Written temp-file-plus-rename, and read back at boot into the daemon's
 * in-memory index. The header is a **cache of the journal**: the terminal
 * `$end` entry is what makes the journal self-describing, so when the two
 * disagree the journal wins and the header is rebuilt from it.
 *
 * With one exception, which is why a Run directory without a readable header
 * is unusable rather than merely stale: the issue snapshot and the branch live
 * only here. The journal records what a Run *did*, never what it was asked to
 * do.
 */
import { readFile, readdir } from 'node:fs/promises';

import type { Issue, Pr, RunOutcome } from '@rocky/sdk';
import { z } from 'zod';

import { PUBLIC_MODE, serializeJson, writeAtomic } from '../atomic-write.js';
import type { RockyPaths } from '../config/paths.js';
import {
  END_STEP,
  openJournal,
  parseRunEnd,
  type Journal,
  type RecordedError,
  type RunEnd,
} from './journal.js';

/** Bumped when the header shape changes incompatibly. */
export const RUN_HEADER_VERSION = 1;

/**
 * NG-574 §8. `parked` carries a `reason` that is just the parking Step's key
 * rather than minting `parked:checkpoint` and `parked:ci` as states, so a
 * Workflow author writing a new parking Step needs no new Run state.
 */
export type RunStatus =
  | 'queued'
  | 'running'
  | 'parked'
  | 'finished'
  | 'failed'
  | 'cancelled';

export interface RunHeader {
  v: number;
  /** `<issue>-<n>`, and the Run's directory name (NG-574 §1). */
  runId: string;
  /** Which Trigger started this Run. Recorded on it, per CONTEXT.md. */
  trigger?: string;
  /** Snapshotted at Run start and immutable for the Run's life (NG-574 §1). */
  issue: Issue;
  /** Linear's own `gitBranchName`; the Run's worktree is checked out on it. */
  branch: string;
  pr?: Pr;
  status: RunStatus;
  /** `finished` carries the Workflow's outcome. */
  outcome?: RunOutcome;
  /** The parking Step's key — `checkpoint`, `scm:waitForCi`. */
  reason?: string;
  /** Boots so far. A cache of the journal's highest `boot`. */
  boots: number;
  createdAt: string;
  endedAt?: string;
  error?: RecordedError;
}

const issueSchema = z.object({
  identifier: z.string(),
  title: z.string(),
  description: z.string(),
  url: z.string(),
  labels: z.array(z.string()),
});

const prSchema = z.object({
  number: z.number(),
  url: z.string(),
  headSha: z.string(),
});

const recordedErrorSchema = z.object({
  name: z.string(),
  message: z.string(),
  stack: z.string().optional(),
});

const outcomeSchema = z.enum(['merged', 'rejected', 'exhausted']);

const headerSchema = z.object({
  v: z.number().int(),
  runId: z.string().min(1),
  trigger: z.string().optional(),
  issue: issueSchema,
  branch: z.string().min(1),
  pr: prSchema.optional(),
  status: z.enum([
    'queued',
    'running',
    'parked',
    'finished',
    'failed',
    'cancelled',
  ]),
  outcome: outcomeSchema.optional(),
  reason: z.string().optional(),
  boots: z.number().int().min(0),
  createdAt: z.string(),
  endedAt: z.string().optional(),
  error: recordedErrorSchema.optional(),
});

/** Thrown for a `run.json` that cannot be read. */
export class RunHeaderError extends Error {
  constructor(
    readonly runId: string,
    message: string,
  ) {
    super(`${runId}: ${message}`);
    this.name = 'RunHeaderError';
  }
}

export function newRunHeader(opts: {
  runId: string;
  issue: Issue;
  branch: string;
  trigger?: string;
  now: string;
}): RunHeader {
  return {
    v: RUN_HEADER_VERSION,
    runId: opts.runId,
    ...(opts.trigger === undefined ? {} : { trigger: opts.trigger }),
    issue: opts.issue,
    branch: opts.branch,
    // A Run is admitted before it works: `queued` is a real state, so a Run
    // asleep for three days does not jump the cap (NG-574 §8).
    status: 'queued',
    boots: 0,
    createdAt: opts.now,
  };
}

export async function writeRunHeader(
  paths: RockyPaths,
  headerToWrite: RunHeader,
): Promise<void> {
  await writeAtomic(
    paths.run(headerToWrite.runId).runJson,
    serializeJson(headerToWrite),
    PUBLIC_MODE,
  );
}

export async function readRunHeader(
  paths: RockyPaths,
  runId: string,
): Promise<RunHeader> {
  let text: string;
  try {
    text = await readFile(paths.run(runId).runJson, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new RunHeaderError(runId, 'has no run.json');
    }
    throw error;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new RunHeaderError(runId, 'run.json is not valid JSON');
  }

  const parsed = headerSchema.safeParse(raw);
  if (!parsed.success) {
    throw new RunHeaderError(
      runId,
      `run.json is not a Run header — ${z.prettifyError(parsed.error)}`,
    );
  }
  if (parsed.data.v !== RUN_HEADER_VERSION) {
    throw new RunHeaderError(
      runId,
      `run.json is at header version ${parsed.data.v}, and this daemon reads version ${RUN_HEADER_VERSION}`,
    );
  }

  return parsed.data;
}

/**
 * Folds what the journal knows into the header, returning `undefined` when the
 * two already agree — which is how a load avoids rewriting a file every boot.
 */
export function reconcileHeader(
  headerOnDisk: RunHeader,
  journal: Journal,
): RunHeader | undefined {
  const patch: Partial<RunHeader> = {};

  const bootsSeen = journal.nextBoot - 1;
  if (bootsSeen !== headerOnDisk.boots) {
    patch.boots = bootsSeen;
  }

  const end = journal.end;
  const runEnd = end ? parseRunEnd(end.result) : undefined;
  if (end && runEnd) {
    if (headerOnDisk.status !== runEnd.status) {
      patch.status = runEnd.status;
    }
    if (headerOnDisk.endedAt !== end.startedAt) {
      patch.endedAt = end.startedAt;
    }
    if (
      runEnd.status === 'finished' &&
      headerOnDisk.outcome !== runEnd.outcome
    ) {
      patch.outcome = runEnd.outcome;
    }
    if (
      runEnd.status === 'failed' &&
      headerOnDisk.error?.message !== runEnd.error.message
    ) {
      patch.error = runEnd.error;
    }
  }

  if (Object.keys(patch).length === 0) {
    return undefined;
  }
  return { ...headerOnDisk, ...patch };
}

/**
 * Reads one Run's header and corrects it against its own journal, persisting
 * the correction so the next reader — the web UI polling the index — sees it.
 */
export async function loadRunHeader(
  paths: RockyPaths,
  runId: string,
): Promise<RunHeader> {
  const headerOnDisk = await readRunHeader(paths, runId);
  const journal = await openJournal(paths.run(runId).journal);

  const rebuilt = reconcileHeader(headerOnDisk, journal);
  if (!rebuilt) {
    return headerOnDisk;
  }

  await writeRunHeader(paths, rebuilt);
  return rebuilt;
}

export interface ReadIndexOptions {
  /** Where a skipped-Run warning goes. The daemon log, in production. */
  warn?(message: string): void;
}

/**
 * The in-memory index, rebuilt from the headers at boot (NG-574 §4).
 *
 * One unreadable Run never costs the others: the index is what the run list
 * renders from, and a developer whose `runs/` holds one corrupt directory
 * still wants to see the other ninety-nine.
 */
export async function readRunIndex(
  paths: RockyPaths,
  options: ReadIndexOptions = {},
): Promise<RunHeader[]> {
  let dirents: string[];
  try {
    dirents = (await readdir(paths.runsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const headers: RunHeader[] = [];
  for (const runId of dirents.sort()) {
    try {
      headers.push(await loadRunHeader(paths, runId));
    } catch (error) {
      options.warn?.(
        `skipping run ${runId} — ${(error as Error).message}. Its run.json is missing or unreadable, and the issue snapshot lives only there.`,
      );
    }
  }

  return headers;
}

/** The `$end` result for a Run that reached a terminal state. */
export function runEndFor(header: RunHeader): RunEnd | undefined {
  switch (header.status) {
    case 'finished':
      return header.outcome === undefined
        ? undefined
        : { status: 'finished', outcome: header.outcome };
    case 'failed':
      return header.error === undefined
        ? undefined
        : { status: 'failed', error: header.error };
    case 'cancelled':
      return { status: 'cancelled' };
    default:
      return undefined;
  }
}

export { END_STEP };
