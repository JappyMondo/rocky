import type { Issue } from '@rocky/sdk';
import type { ExecutionAdmission, ExecutionRequest } from '../run/execution.js';
import type { RunHeader } from '../run/header.js';

export interface RestartInput {
  expectedBoot: number;
  requestId: string;
}
export async function restartRun(
  execution: {
    scheduler: {
      get(id: string): Promise<RunHeader | undefined>;
      list(): Promise<RunHeader[]>;
    };
    delegate(input: ExecutionRequest): Promise<ExecutionAdmission>;
  },
  hydrate: (id: string) => Promise<Issue & { id: string; teamId: string }>,
  runId: string,
  input: RestartInput,
): Promise<{ runId: string; previousRunId: string }> {
  const run = await execution.scheduler.get(runId);
  if (!run) throw new Error('Unknown run.');
  const requestId = `restart:${runId}:${input.requestId}`;
  const related = (await execution.scheduler.list()).filter(
    (other) => other.issue.identifier === run.issue.identifier,
  );
  const existing = related.find((other) => other.admissionId === requestId);
  if (existing) return { runId: existing.runId, previousRunId: runId };
  if (
    run.status !== 'failed' &&
    !(run.status === 'finished' && run.outcome === 'exhausted')
  )
    throw new Error(
      'Only failed or exhausted runs can restart with the latest workflow.',
    );
  if (run.boots !== input.expectedBoot)
    throw new Error('Refresh the run before restarting.');
  const number = (id: string) => Number(id.slice(id.lastIndexOf('-') + 1));
  if (
    related.some(
      (other) =>
        other.runId !== runId &&
        (number(other.runId) > number(runId) ||
          !['finished', 'failed', 'cancelled'].includes(other.status)),
    )
  )
    throw new Error(
      'A newer or live run exists; restart the latest run instead.',
    );
  const issue = await hydrate(run.linear?.issueId ?? run.issue.identifier);
  if (
    issue.identifier !== run.issue.identifier ||
    (run.linear
      ? issue.id !== run.linear.issueId || issue.teamId !== run.linear.teamId
      : issue.url !== run.issue.url)
  )
    throw new Error('Restart issue identity does not match the original run.');
  const admitted = await execution.delegate({
    requestId,
    restartOf: { runId, expectedBoot: input.expectedBoot },
    issue: {
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description,
      url: issue.url,
      labels: issue.labels,
      comments: issue.comments,
    },
    branch: run.branch,
    team: issue.teamId,
    ...(run.linear ? { linear: run.linear } : {}),
  });
  if (admitted.kind === 'refused') throw new Error(admitted.message);
  if (admitted.kind === 'nudged')
    throw new Error('A live run already owns this issue.');
  return { runId: admitted.run.runId, previousRunId: runId };
}
