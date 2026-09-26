import { z } from 'zod';
import { profileRepoSchema } from '../config/profiles.js';
import {
  validateConfiguration,
  automationSettings,
} from '@rocky/local-contracts';
import type { JournalEntry } from './journal.js';
import type { FlowConfigurationRepair } from '@rocky/local-contracts';

export const configurationRepairSchema = z
  .object({
    execution: z.array(profileRepoSchema).min(1).max(20).optional(),
    readiness: z
      .object({
        attempts: z.number().int().min(1).max(600),
        intervalMs: z.number().int().min(1).max(10000),
      })
      .strict()
      .optional(),
    ui: z
      .object({
        start: z.string().trim().min(1).max(12000),
        url: z
          .string()
          .url()
          .refine(
            (url) => /^https?:\/\//.test(url),
            'Use an HTTP or HTTPS URL',
          ),
      })
      .strict()
      .optional(),
    commands: z
      .object({
        install: z.string().max(12000).optional(),
        test: z.string().max(12000).optional(),
        lint: z.string().max(12000).optional(),
        build: z.string().max(12000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.execution !== undefined ||
      value.ui !== undefined ||
      value.readiness !== undefined ||
      Object.keys(value.commands ?? {}).length > 0,
    'Supply a configuration repair',
  )
  .superRefine((value, ctx) => {
    if (!value.execution) return;
    try {
      validateConfiguration({
        repos: value.execution,
        automation: automationSettings(),
      });
    } catch (error) {
      ctx.addIssue({
        code: 'custom',
        message:
          error instanceof Error
            ? error.message
            : 'Invalid environment repair.',
      });
    }
  });

export const retryRecordSchema = z
  .object({
    v: z.number().int(),
    kind: z.literal('retry'),
    continueExhausted: z.literal(true).optional(),
    configurationRepair: configurationRepairSchema.optional(),
    requestId: z.string().min(1).max(200),
    stepKey: z.string().regex(/^\d+$/),
    recordedAt: z.string().datetime(),
    resetControls: z.array(z.string().min(1)).optional(),
    recovery: z
      .object({
        instructions: z.string().trim().min(1).max(12000),
        context: z.string(),
      })
      .optional(),
  })
  .strict();
export type RetryRequest = {
  requestId: string;
  stepKey: string;
  expectedBoot: number;
  recoveryInstructions?: string;
  continueExhausted?: true;
  configurationRepair?: FlowConfigurationRepair;
};
const latest = (entries: readonly JournalEntry[]) => [
  ...new Map(entries.map((entry) => [entry.seq, entry])).values(),
];
/** ctx.exec returns nonzero exits as values so workflows can inspect them. */
function failedCommand(entry: JournalEntry): boolean {
  return (
    entry.step === 'exec' &&
    entry.status === 'done' &&
    typeof entry.result === 'object' &&
    entry.result !== null &&
    'exitCode' in entry.result &&
    typeof entry.result.exitCode === 'number' &&
    entry.result.exitCode !== 0
  );
}
/** SCM refusals are values so workflows can handle recoverable conditions. */
function refusedScm(entry: JournalEntry): boolean {
  return (
    entry.step.startsWith('scm.') &&
    entry.status === 'done' &&
    typeof entry.result === 'object' &&
    entry.result !== null &&
    'refused' in entry.result &&
    entry.result.refused === true
  );
}
/** Resume failed work without invalidating completed downstream outcomes. */
export function uiStartupRetryKey(
  entries: readonly JournalEntry[],
): string | undefined {
  const steps = latest(entries.filter((entry) => entry.step !== '$end')).sort(
    (a, b) => a.seq - b.seq,
  );
  const [server, readiness, stop, report] = steps.slice(-4);
  // A failed complaint writer cannot repair a cached infrastructure failure.
  // Only rewind this exact suffix: no successful reviews or edits are discarded.
  if (
    server?.step === 'exec:background' &&
    server.label === 'dev server' &&
    readiness?.step === 'step' &&
    /^UI readiness \d+\/1$/.test(readiness.label ?? '') &&
    readiness.status === 'done' &&
    readiness.result &&
    typeof readiness.result === 'object' &&
    'ready' in readiness.result &&
    readiness.result.ready === false &&
    stop?.step === 'exec' &&
    stop.label === 'stop failed dev server' &&
    stop.status === 'done' &&
    report?.step === '$parallel' &&
    report.status === 'failed'
  )
    return String(server.seq);
  return undefined;
}

export function retryStepKey(
  entries: readonly JournalEntry[],
  includeUiStartup = true,
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
  if (includeUiStartup) {
    const ui = uiStartupRetryKey(entries);
    if (ui !== undefined) return ui;
  }
  const steps = latest(entries.filter((entry) => entry.step !== '$end')).sort(
    (a, b) => a.seq - b.seq,
  );
  // A previous Boot can fail while restarting an already successful setup
  // probe, before reaching a later waiting fixer Step. Reopen the failed
  // probe first or every retry of that fixer fails at the same earlier seq.
  if (end.error?.message.includes('Previously verified setup failed')) {
    const failedSetup = steps.find(
      (entry) =>
        entry.step === 'exec:background' &&
        entry.status === 'failed' &&
        entry.label?.startsWith('Environment probe ') &&
        entries.some(
          (prior) =>
            prior.seq === entry.seq &&
            prior.step === entry.step &&
            prior.label === entry.label &&
            prior.status === 'done',
        ),
    );
    if (failedSetup) return String(failedSetup.seq);
  }
  const step = steps.at(-1);
  if (
    step &&
    (step.status !== 'done' || failedCommand(step) || refusedScm(step))
  )
    return String(step.seq);
  // PR delivery can throw after a successful status command reports dirty
  // files. A recovery agent may commit those files, but reopening only $end
  // would replay the old stdout and fail again against the clean worktree.
  const deliveryStatus = step?.label?.match(/^(.+): git status --porcelain$/);
  if (
    step?.step === 'exec' &&
    step.status === 'done' &&
    deliveryStatus &&
    end.error?.message ===
      `${deliveryStatus[1]} has uncommitted work. Commit it before PR delivery.` &&
    typeof step.result === 'object' &&
    step.result !== null &&
    'stdout' in step.result &&
    typeof step.result.stdout === 'string' &&
    step.result.stdout.trim()
  )
    return String(step.seq);
  // An integration or workflow can throw between journaled Steps. Reopen the
  // terminal barrier without manufacturing a failed Step or rerunning successes.
  if (steps.every((entry) => entry.status === 'done')) return String(end.seq);
  return undefined;
}
/** Exhaustion continuation reopens only the terminal barrier; all Steps replay. */
export function exhaustedStepKey(
  entries: readonly JournalEntry[],
): string | undefined {
  const end = entries.at(-1);
  const result = end?.result;
  if (
    end?.step === '$end' &&
    result &&
    typeof result === 'object' &&
    'status' in result &&
    result.status === 'finished' &&
    'outcome' in result &&
    result.outcome === 'exhausted'
  )
    return String(end.seq);
  return undefined;
}
/** Older markers reopened only $end after a nonzero command; retain that history. */
export function isRecordedRetryTarget(
  entries: readonly JournalEntry[],
  key: string,
): boolean {
  const target = retryStepKey(entries);
  if (target === key) return true;
  // Markers written before UI startup retries targeted the reporting failure.
  if (retryStepKey(entries, false) === key) return true;
  return (
    target !== undefined &&
    key === String(entries.at(-1)?.seq) &&
    latest(entries.filter((entry) => entry.step !== '$end')).every(
      (entry) => entry.status === 'done',
    )
  );
}
/** A retry marker changes the replay projection; original bytes are never edited. */
export function retryEntry(
  entry: JournalEntry,
  recordedAt: string,
): JournalEntry {
  const {
    error: recordedError,
    result: _result,
    progress: _progress,
    sessionId: _session,
    ms,
    ...rest
  } = entry;
  const command = failedCommand(entry)
    ? (entry.result as { exitCode: number; stderr?: string })
    : undefined;
  const error =
    recordedError ??
    (command
      ? {
          name: 'Error',
          message: `Command exited with code ${command.exitCode}${command.stderr ? `: ${command.stderr}` : ''}`,
        }
      : undefined);
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
