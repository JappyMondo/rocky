import { z } from 'zod';
import type { JournalEntry } from './journal.js';

export const retryRecordSchema = z
  .object({
    v: z.number().int(),
    kind: z.literal('retry'),
    requestId: z.string().min(1).max(200),
    stepKey: z.string().regex(/^\d+$/),
    recordedAt: z.string().datetime(),
    resetControls: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type RetryRequest = {
  requestId: string;
  stepKey: string;
  expectedBoot: number;
};
const forbidden = new Set([
  'DivergenceError',
  'CrashLoopError',
  'FatalStepError',
  'JournalFormatError',
]);
const latest = (entries: readonly JournalEntry[]) => [
  ...new Map(entries.map((entry) => [entry.seq, entry])).values(),
];
function retryable(entry: JournalEntry): boolean {
  if (entry.status === 'done') return true;
  if (entry.status !== 'failed' || forbidden.has(entry.error?.name ?? ''))
    return false;
  if (entry.parallel)
    return entry.parallel.branches.every((branch) =>
      latest(branch).every(retryable),
    );
  return entry.step === 'agent' || entry.step === 'exec';
}
/** Only the final failed root Step; downstream outcomes must never be invalidated. */
export function retryStepKey(
  entries: readonly JournalEntry[],
): string | undefined {
  const end = entries.at(-1);
  if (
    end?.step !== '$end' ||
    !end.result ||
    typeof end.result !== 'object' ||
    !('status' in end.result) ||
    end.result.status !== 'failed'
  )
    return;
  const steps = latest(entries.filter((entry) => entry.step !== '$end')).sort(
    (a, b) => a.seq - b.seq,
  );
  const step = steps.at(-1);
  if (step?.status === 'failed' && retryable(step)) return String(step.seq);
  return undefined;
}
/** A retry marker changes the replay projection; original bytes are never edited. */
export function retryEntry(
  entry: JournalEntry,
  recordedAt: string,
): JournalEntry {
  const {
    error,
    result: _result,
    progress: _progress,
    sessionId: _session,
    ms,
    ...rest
  } = entry;
  const attempts = [...(entry.attempts ?? [])];
  if (error && attempts.at(-1)?.kind !== 'failed')
    attempts.push({
      kind: 'failed',
      startedAt: entry.startedAt,
      ms: ms ?? 0,
      error,
    });
  const progress =
    entry.progress && typeof entry.progress === 'object'
      ? (entry.progress as Record<string, unknown>)
      : {};
  const notes = [
    ...new Set(
      [
        ...(Array.isArray(progress.retryNotes) ? progress.retryNotes : []),
        ...attempts.flatMap((attempt) =>
          attempt.kind === 'steer' && attempt.note ? [attempt.note] : [],
        ),
        ...(Array.isArray(progress.turns)
          ? progress.turns.map((turn) => turn?.note)
          : []),
      ].filter((note): note is string => typeof note === 'string'),
    ),
  ];
  return {
    ...rest,
    status: 'waiting',
    startedAt: recordedAt,
    attempts,
    ...(entry.step === 'agent'
      ? {
          progress: {
            kind: 'agent-retry',
            notes,
            delivered: progress.delivered ?? [],
          },
        }
      : {}),
    ...(entry.parallel
      ? {
          parallel: {
            count: entry.parallel.count,
            branches: entry.parallel.branches.map((branch) => [
              ...branch,
              ...latest(branch)
                .filter((item) => item.status === 'failed')
                .map((item) => retryEntry(item, recordedAt)),
            ]),
          },
        }
      : {}),
  };
}
