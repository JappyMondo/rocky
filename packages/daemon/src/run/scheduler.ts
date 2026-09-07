import { readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { PUBLIC_MODE, serializeJson, writeAtomic } from '../atomic-write.js';
import type { RockyPaths } from '../config/paths.js';
import { concurrencySchema, retentionSchema } from '../config/schema.js';
import {
  newRunHeader,
  readRunHeader,
  updateRunHeader,
  readRunIndex,
  writeRunHeader,
  type RunHeader,
} from './header.js';
import {
  appendEntry,
  openJournal,
  parseRunEnd,
  recordError,
  JOURNAL_FORMAT_VERSION,
} from './journal.js';
import { type BootResult } from './replay.js';

export type SchedulerBoot = (
  run: RunHeader,
  kind: 'run' | 'poll',
  signal: AbortSignal,
) => Promise<BootResult>;

export interface DelegateInput {
  repo: string;
  issue: RunHeader['issue'];
  branch: string;
  trigger?: string;
}

export type RunDelegation =
  { kind: 'started'; run: RunHeader } | { kind: 'nudged'; run: RunHeader };

export interface RunSchedulerOptions {
  paths: RockyPaths;
  maxRuns?: number;
  boot: SchedulerBoot;
  cancellation?: Cancellation;
  now?: () => Date;
  writeHeader?: typeof writeRunHeader;
  onError?: (error: unknown) => void;
}

export interface Cancellation {
  /** Stop the owned Boot child/exec groups and wait until no writer remains. */
  kill(run: RunHeader): Promise<void>;
  /** Idempotent preservation: push commits, draft/comment PRs, then remove worktree. */
  cleanup(run: RunHeader): Promise<void>;
}

export function nextPoll(reason: string, attempts: number): number {
  return reason === 'checkpoint'
    ? 300_000
    : Math.min(10_000 * 2 ** attempts, 60_000);
}

function isTerminal(run: RunHeader): boolean {
  return (
    run.status === 'finished' ||
    run.status === 'failed' ||
    run.status === 'cancelled'
  );
}

function runNumber(issue: string, runId: string): number {
  const suffix = new RegExp(
    `^${issue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+)$`,
  ).exec(runId)?.[1];
  return suffix === undefined ? 0 : Number(suffix);
}

function compareQueuedRuns(left: RunHeader, right: RunHeader): number {
  if (left.queueOrder !== undefined && right.queueOrder !== undefined)
    return left.queueOrder - right.queueOrder;
  const created = left.createdAt.localeCompare(right.createdAt);
  if (created !== 0) {
    return created;
  }
  if (left.issue.identifier === right.issue.identifier) {
    const number =
      runNumber(left.issue.identifier, left.runId) -
      runNumber(right.issue.identifier, right.runId);
    if (number !== 0) {
      return number;
    }
  }
  return left.runId.localeCompare(right.runId);
}

export class RunScheduler {
  private readonly runs = new Map<string, RunHeader>();
  private readonly active = new Set<string>();
  private readonly pendingHeaders = new Map<string, RunHeader>();
  private readonly executions = new Map<
    string,
    { controller: AbortController; done: Promise<void> }
  >();
  private readonly stops = new Map<string, Promise<void>>();
  private readonly polls = new Map<string, { at: number; attempts: number }>();
  private counters: Record<string, number> = {};
  private queueOrder = 0;
  private closed = false;
  private serial = Promise.resolve();

  private constructor(
    private readonly options: RunSchedulerOptions &
      Required<
        Pick<RunSchedulerOptions, 'maxRuns' | 'now' | 'writeHeader' | 'onError'>
      >,
  ) {}

  static async open(options: RunSchedulerOptions): Promise<RunScheduler> {
    const scheduler = new RunScheduler({
      ...options,
      maxRuns: concurrencySchema.parse({ maxRuns: options.maxRuns }).maxRuns,
      now: options.now ?? (() => new Date()),
      writeHeader: options.writeHeader ?? writeRunHeader,
      onError: options.onError ?? (() => undefined),
    });
    try {
      scheduler.counters = z
        .record(z.string(), z.number().int().min(0))
        .parse(
          JSON.parse(
            await readFile(
              join(options.paths.runsDir, 'counters.json'),
              'utf8',
            ),
          ),
        );
    } catch (error) {
      if (!(
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      ))
        throw error;
    }
    const runs = await readRunIndex(options.paths, { strict: true });
    const live = new Map<string, string>();
    for (const run of runs) {
      if (!isTerminal(run)) {
        const other = live.get(run.issue.identifier);
        if (other)
          throw new Error(
            `multiple live Runs for ${run.issue.identifier}: ${other}, ${run.runId}; repair the history before starting work`,
          );
        live.set(run.issue.identifier, run.runId);
      }
    }
    for (const run of runs.sort(compareQueuedRuns)) {
      const recovered =
        run.status === 'running' ? { ...run, status: 'queued' as const } : run;
      if (recovered !== run) {
        await scheduler.options.writeHeader(options.paths, recovered);
      }
      scheduler.runs.set(recovered.runId, recovered);
      scheduler.queueOrder = Math.max(
        scheduler.queueOrder,
        run.queueOrder ?? 0,
      );
      scheduler.counters[run.issue.identifier] = Math.max(
        scheduler.counters[run.issue.identifier] ?? 0,
        runNumber(run.issue.identifier, run.runId),
      );
      if (run.status === 'parked') scheduler.schedulePoll(run, 0);
    }
    await scheduler.saveCounters();
    return scheduler;
  }

  async get(runId: string): Promise<RunHeader | undefined> {
    const run = this.runs.get(runId);
    return run === undefined ? undefined : structuredClone(run);
  }

  async delegate(input: DelegateInput): Promise<RunDelegation> {
    return this.admit(input, false);
  }

  async manual(
    input: DelegateInput & { trigger: string },
  ): Promise<RunDelegation> {
    return this.admit(input, true);
  }

  private async admit(
    input: DelegateInput,
    manual: boolean,
  ): Promise<RunDelegation> {
    return await this.mutate(async () => {
      if (this.closed) throw new Error('The Run scheduler is closed');
      const runs = [...this.runs.values()].filter(
        (run) => run.issue.identifier === input.issue.identifier,
      );
      const live = runs.find((run) => !isTerminal(run));

      if (live) {
        if (manual)
          throw new Error(
            `Manual Trigger refused: ${live.runId} is still live`,
          );
        return { kind: 'nudged', run: structuredClone(live) };
      }

      const suffix = Math.max(
        this.counters[input.issue.identifier] ?? 0,
        ...runs.map((run) => runNumber(input.issue.identifier, run.runId)),
      );
      const run = newRunHeader({
        runId: `${input.issue.identifier}-${suffix + 1}`,
        issue: input.issue,
        branch: input.branch,
        repo: input.repo,
        ...(input.trigger === undefined ? {} : { trigger: input.trigger }),
        now: this.options.now().toISOString(),
      });
      run.issue = structuredClone(input.issue);
      run.queueOrder = ++this.queueOrder;
      this.counters[input.issue.identifier] = suffix + 1;
      await this.saveCounters();
      await this.options.writeHeader(this.options.paths, run);
      this.runs.set(run.runId, run);
      return { kind: 'started', run: structuredClone(run) };
    });
  }

  async drain(): Promise<void> {
    for (;;) {
      const admitted = await this.mutate(async () => {
        if (this.closed) return undefined;
        await this.retryPendingHeaders();
        if (this.active.size >= this.options.maxRuns) {
          return undefined;
        }
        const next = [...this.runs.values()]
          .filter(
            (run) =>
              run.status === 'queued' &&
              !run.cancelRequestedAt &&
              !this.executions.has(run.runId),
          )
          .sort(compareQueuedRuns)[0];
        if (!next) {
          return undefined;
        }

        const running = { ...next, status: 'running' as const };
        await this.options.writeHeader(this.options.paths, running);
        this.runs.set(running.runId, running);
        this.active.add(running.runId);
        this.launch(running, 'run');
        return running;
      });
      if (!admitted) {
        return;
      }
    }
  }

  private launch(run: RunHeader, kind: 'run' | 'poll'): Promise<void> {
    const controller = new AbortController();
    const done = this.boot(run, kind, controller.signal);
    this.executions.set(run.runId, { controller, done });
    void done.catch((error) => this.report(error));
    return done;
  }

  private async boot(
    run: RunHeader,
    kind: 'run' | 'poll',
    signal: AbortSignal,
  ): Promise<void> {
    try {
      let result: BootResult;
      try {
        result = await this.options.boot(structuredClone(run), kind, signal);
      } catch (error) {
        if (signal.aborted) return;
        await this.recordBootFailure(run, error);
        return;
      }

      if (!signal.aborted) await this.applyBootResult(run, result);
    } finally {
      await this.mutate(async () => {
        this.active.delete(run.runId);
        this.executions.delete(run.runId);
      });
      await this.drain();
    }
  }

  private async applyBootResult(
    run: RunHeader,
    result: BootResult,
  ): Promise<void> {
    if (result.status === 'cancelled')
      throw new Error(
        'A Boot returned cancelled without a scheduler cancellation request',
      );
    run = {
      ...(await readRunHeader(this.options.paths, run.runId)),
      reason: undefined,
      error: undefined,
      outcome: undefined,
      endedAt: undefined,
    };
    const settled =
      result.status === 'ready'
        ? {
            ...run,
            status: 'queued' as const,
            queueOrder: ++this.queueOrder,
            boots: result.boot,
          }
        : result.status === 'parked'
          ? {
              ...run,
              status: 'parked' as const,
              reason: result.reason,
              boots: result.boot,
            }
          : result.status === 'finished'
            ? {
                ...run,
                status: 'finished' as const,
                outcome: result.outcome,
                endedAt: this.options.now().toISOString(),
                boots: result.boot,
              }
            : {
                ...run,
                status: 'failed' as const,
                error: result.error,
                endedAt: this.options.now().toISOString(),
                boots: result.boot,
              };
    await this.mutate(async () => {
      if (this.executions.get(run.runId)?.controller.signal.aborted) return;
      try {
        await this.options.writeHeader(this.options.paths, settled);
        this.runs.set(settled.runId, settled);
        this.pendingHeaders.delete(settled.runId);
        if (settled.status === 'parked')
          this.schedulePoll(
            settled,
            (this.polls.get(run.runId)?.attempts ?? -1) + 1,
          );
        else this.polls.delete(run.runId);
      } catch (error) {
        // Enqueue the retry before releasing the same lock that stop uses to clear it.
        this.pendingHeaders.set(settled.runId, settled);
        this.report(error);
      }
    });
  }

  /** Called under mutate, so a retry cannot overtake durable cancellation intent. */
  private async retryPendingHeaders(): Promise<void> {
    for (const header of this.pendingHeaders.values()) {
      try {
        await this.options.writeHeader(this.options.paths, header);
        this.runs.set(header.runId, header);
        this.pendingHeaders.delete(header.runId);
        if (header.status === 'parked') this.schedulePoll(header, 0);
        else this.polls.delete(header.runId);
      } catch (error) {
        this.report(error);
      }
    }
  }

  private async recordBootFailure(
    run: RunHeader,
    error: unknown,
  ): Promise<void> {
    run = await readRunHeader(this.options.paths, run.runId);
    const failed = {
      ...run,
      status: 'failed' as const,
      error: recordError(error),
      endedAt: this.options.now().toISOString(),
    };
    await this.mutate(async () => {
      if (this.executions.get(run.runId)?.controller.signal.aborted) return;
      try {
        await this.options.writeHeader(this.options.paths, failed);
        this.runs.set(failed.runId, failed);
        this.pendingHeaders.delete(failed.runId);
      } catch (writeError) {
        this.pendingHeaders.set(failed.runId, failed);
        this.report(writeError);
      }
    });
  }

  /** One active Boot per Run, even when webhook and timer race. */
  async poll(runId: string): Promise<void> {
    const task = await this.mutate(async () => {
      if (this.closed) return undefined;
      const existing = this.executions.get(runId);
      if (existing) return { done: existing.done };
      const run = this.runs.get(runId);
      if (!run) throw new Error(`Unknown Run ${runId}`);
      if (
        run.status !== 'parked' ||
        run.cancelRequestedAt ||
        this.pendingHeaders.has(runId)
      )
        return undefined;
      return { done: this.launch(run, 'poll') };
    });
    await task?.done;
  }

  private schedulePoll(run: RunHeader, attempts: number): void {
    this.polls.set(run.runId, {
      attempts,
      at: this.options.now().getTime() + nextPoll(run.reason ?? '', attempts),
    });
  }

  /** Daemon timer and webhook wiring call this seam; no second replay path. */
  async tick(): Promise<void> {
    if (this.closed) return;
    for (const run of this.runs.values()) {
      if (run.cancelRequestedAt && !isTerminal(run)) {
        await this.stop(run.runId).catch((error) => this.report(error));
      }
    }
    await Promise.all(
      [...this.polls]
        .filter(([, poll]) => poll.at <= this.options.now().getTime())
        .map(([id]) => this.poll(id)),
    );
    await this.drain();
  }

  /** Daemon shutdown is not cancellation: no SCM effects and no terminal record. */
  async close(): Promise<void> {
    const active = await this.mutate(async () => {
      this.closed = true;
      const active = [...this.executions];
      for (const [, execution] of active) execution.controller.abort();
      return active;
    });
    await Promise.all(
      active.map(async ([id, execution]) => {
        const run = this.runs.get(id);
        if (run) await this.options.cancellation?.kill(run);
        await execution.done;
      }),
    );
  }

  stop(runId: string): Promise<void> {
    const existing = this.stops.get(runId);
    if (existing) return existing;
    const done = this.cancel(runId).finally(() => this.stops.delete(runId));
    this.stops.set(runId, done);
    return done;
  }

  private async cancel(runId: string): Promise<void> {
    const cancellation = this.options.cancellation;
    const state = await this.mutate(async () => {
      const run = this.runs.get(runId);
      if (!run) throw new Error(`Unknown Run ${runId}`);
      if (isTerminal(run)) return undefined;
      if (run.status === 'parked' && run.reason === 'checkpoint')
        throw new Error(
          `${runId}: stop at a Checkpoint is an Answer; use the Checkpoint Answer intake`,
        );
      if (!cancellation)
        throw new Error(
          'Configure cancellation preservation before stopping a Run',
        );
      const cancelling = await updateRunHeader(
        this.options.paths,
        runId,
        {
          cancelRequestedAt:
            run.cancelRequestedAt ?? this.options.now().toISOString(),
        },
        this.options.writeHeader,
      );
      this.runs.set(runId, cancelling);
      this.pendingHeaders.delete(runId);
      this.polls.delete(runId);
      const active = this.executions.get(runId);
      active?.controller.abort();
      return { run: cancelling, active };
    });
    if (!state) return;
    await cancellation!.kill(state.run);
    await state.active?.done;
    // Completion may have committed just before the cancellation request won.
    let journal = await openJournal(this.options.paths.run(runId).journal);
    if (!journal.end) {
      await cancellation!.cleanup(state.run);
      await appendEntry(
        this.options.paths.run(runId).journal,
        {
          v: JOURNAL_FORMAT_VERSION,
          seq: Math.max(-1, ...journal.entries.map((entry) => entry.seq)) + 1,
          step: '$end',
          status: 'done',
          boot: Math.max(1, journal.nextBoot - 1),
          startedAt: this.options.now().toISOString(),
          result: { status: 'cancelled' },
        },
        { runner: true },
      );
      journal = await openJournal(this.options.paths.run(runId).journal);
    }
    const end = parseRunEnd(journal.end!.result)!;
    await this.mutate(async () => {
      const run = {
        ...(await readRunHeader(this.options.paths, runId)),
        ...end,
        reason: undefined,
        cancelRequestedAt: undefined,
        endedAt: journal.end!.startedAt,
        boots: journal.nextBoot - 1,
      };
      await this.options.writeHeader(this.options.paths, run);
      this.runs.set(runId, run);
      this.pendingHeaders.delete(runId);
    });
    await this.drain();
  }

  private async saveCounters(): Promise<void> {
    await writeAtomic(
      join(this.options.paths.runsDir, 'counters.json'),
      serializeJson(this.counters),
      PUBLIC_MODE,
    );
  }

  async sweepRetention(
    counts: { keepTerminalRuns: number; keepSessionsAndScreenshots: number } = {
      keepTerminalRuns: 100,
      keepSessionsAndScreenshots: 40,
    },
  ): Promise<void> {
    const settings = retentionSchema.parse(counts);
    await this.mutate(async () => {
      await this.saveCounters();
      const groups = new Map<string, RunHeader[]>();
      for (const run of this.runs.values()) {
        if (
          !isTerminal(run) ||
          this.executions.has(run.runId) ||
          this.pendingHeaders.has(run.runId)
        )
          continue;
        const group = groups.get(run.repo) ?? [];
        group.push(run);
        groups.set(run.repo, group);
      }
      for (const group of groups.values()) {
        group.sort(
          (a, b) =>
            (b.endedAt ?? b.createdAt).localeCompare(
              a.endedAt ?? a.createdAt,
            ) || b.runId.localeCompare(a.runId),
        );
        for (const [index, run] of group.entries()) {
          const paths = this.options.paths.run(run.runId);
          // Worktree preservation belongs to SCM. Never let retention bypass it.
          try {
            await stat(paths.workspaceDir);
            continue;
          } catch (error) {
            if (!(
              error &&
              typeof error === 'object' &&
              'code' in error &&
              error.code === 'ENOENT'
            ))
              throw error;
          }
          if (index >= settings.keepTerminalRuns) {
            await rm(paths.dir, { recursive: true, force: true });
            this.runs.delete(run.runId);
          } else if (index >= settings.keepSessionsAndScreenshots) {
            await rm(paths.sessionsDir, { recursive: true, force: true });
            await rm(paths.screenshotsDir, { recursive: true, force: true });
            const pruned = { ...run, artifactsPruned: true };
            await this.options.writeHeader(this.options.paths, pruned);
            this.runs.set(run.runId, pruned);
          }
        }
      }
    });
  }

  private report(error: unknown): void {
    try {
      this.options.onError(error);
    } catch {
      // Reporting infrastructure cannot be allowed to strand a Run.
    }
  }

  private async mutate<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.serial;
    let release!: () => void;
    this.serial = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }
}
