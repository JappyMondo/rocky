import type { RunSummary } from '@rocky/local-contracts';

export function groupRuns(runs: RunSummary[]) {
  const identities = new Map<string, string>();
  for (const run of runs) {
    if (run.issue.id && run.issue.url)
      identities.set(run.issue.url, run.issue.id);
  }
  const groups = new Map<string, RunSummary[]>();
  for (const run of [...runs].sort(
    (a, b) =>
      b.createdAt.localeCompare(a.createdAt) ||
      b.runId.localeCompare(a.runId, undefined, { numeric: true }),
  )) {
    const identity = run.issue.id ?? identities.get(run.issue.url);
    const key =
      (identity ? `issue:${identity}` : run.issue.url) ||
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
