import type { RunSummary } from '@rocky/local-contracts';

export function groupRuns(runs: RunSummary[]) {
  const groups = new Map<string, RunSummary[]>();
  for (const run of [...runs].sort(
    (a, b) =>
      b.createdAt.localeCompare(a.createdAt) ||
      b.runId.localeCompare(a.runId, undefined, { numeric: true }),
  )) {
    const key =
      (run.issue.id ? `issue:${run.issue.id}` : run.issue.url) ||
      JSON.stringify([
        run.profileId,
        [...(run.repos ?? [run.repo])].sort(),
        run.issue.identifier || run.runId,
      ]);
    const attempts = groups.get(key) ?? [];
    attempts.push(run);
    groups.set(key, attempts);
  }
  return [...groups].map(([key, attempts]) => ({
    key,
    attempts,
    latest: attempts[0],
  }));
}
