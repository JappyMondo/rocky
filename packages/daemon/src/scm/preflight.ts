import type { BootContext } from '../run/replay.js';
import { ScmError } from './http.js';
import type { ScmProbe } from './probe.js';

export interface PreflightOptions {
  members: readonly {
    repo: { id: string };
    probe(signal: AbortSignal): Promise<ScmProbe>;
  }[];
  signal: AbortSignal;
  /** Required: closes over #14 preflightMcp(expandedSnapshot, { paths, signal, ... }). */
  refreshMcp(signal: AbortSignal): Promise<string[]>;
  /** May shorten, never extend the first-minute budget. */
  timeoutMs?: number;
}
export interface PreflightReport {
  repos: ScmProbe[];
  refreshedMcp: string[];
  failures: string[];
}

export class PreflightError extends Error {
  constructor(readonly report: PreflightReport) {
    super(`Preflight failed: ${report.failures.join(' ')}`);
    this.name = 'PreflightError';
  }
}

/**
 * Consumer adapters are required to observe the signal, but Preflight's first
 * minute is a Run guarantee even when an injected adapter fails to do so.
 */
function withinBudget<T>(
  work: Promise<T>,
  signal: AbortSignal,
  budget: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`probe exceeded the ${budget} ms budget`)),
      budget,
    );
    const cancelled = () => reject(signal.reason);
    if (signal.aborted) cancelled();
    else signal.addEventListener('abort', cancelled, { once: true });
    void work.then(resolve, reject).finally(() => {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancelled);
    });
  });
}

export async function runPreflight(
  steps: BootContext,
  options: PreflightOptions,
): Promise<PreflightReport> {
  const report = await steps.step(
    'preflight',
    { label: 'Preflight' },
    async () => {
      const budget = options.timeoutMs ?? 60_000;
      if (!Number.isFinite(budget) || budget < 1 || budget > 60_000)
        throw new Error('Preflight budget must be within 1..60000 ms');
      if (
        !options.members.length ||
        new Set(options.members.map((member) => member.repo.id)).size !==
          options.members.length
      )
        throw new Error('Preflight requires every unique frozen Run member');
      const timeout = AbortSignal.timeout(budget);
      const signal = AbortSignal.any([options.signal, timeout]);
      const deadline = Date.now() + budget;
      const remaining = () => Math.max(1, deadline - Date.now());
      signal.throwIfAborted();
      const result: PreflightReport = {
        repos: [],
        refreshedMcp: [],
        failures: [],
      };
      const safeError = (subject: string, error: unknown) => {
        options.signal.throwIfAborted();
        if (
          timeout.aborted ||
          (error instanceof Error &&
            error.message === `probe exceeded the ${budget} ms budget`)
        )
          return `${subject}: probe exceeded the ${budget} ms budget; verify API responsiveness and retry. Permission remains unknown.`;
        if (
          error instanceof ScmError ||
          (error instanceof Error && error.name === 'McpAuthError')
        )
          return `${subject}: ${error.message}`;
        return `${subject}: probe failed; verify API access and connectivity without a permission mutation.`;
      };
      const reports = await Promise.all(
        options.members.map(async (member) => {
          try {
            return await withinBudget(
              member.probe(signal),
              signal,
              remaining(),
            );
          } catch (error) {
            result.failures.push(safeError(member.repo.id, error));
            return undefined;
          }
        }),
      );
      for (const probe of reports) {
        if (!probe) continue;
        result.repos.push(probe);
        if (probe.merge.status !== 'allowed')
          result.failures.push(
            `${probe.repo}: merge permission ${probe.merge.status}. ${probe.merge.source} ${probe.merge.fix}`,
          );
        if (
          probe.rebase.status !== 'allowed' &&
          probe.sourcePush.status !== 'allowed'
        )
          result.failures.push(
            `${probe.repo}: neither rebase nor ordinary source push is verified. ${probe.sourcePush.fix}`,
          );
        if (probe.draft.status !== 'allowed')
          result.failures.push(
            `${probe.repo}: draft state ${probe.draft.status}. ${probe.draft.source} ${probe.draft.fix}`,
          );
      }
      try {
        signal.throwIfAborted();
        result.refreshedMcp = await withinBudget(
          options.refreshMcp(signal),
          signal,
          remaining(),
        );
      } catch (error) {
        result.failures.push(safeError('MCP', error));
      }
      options.signal.throwIfAborted();
      return { status: 'done', result };
    },
  );
  if (report.failures.length) throw new PreflightError(report);
  return report;
}
