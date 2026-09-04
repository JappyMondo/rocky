/**
 * The sweep (NG-521, NG-574 §10, NG-578).
 *
 * Two steps, in NG-578's order: `git worktree prune` in every clone, then
 * delete the `workspace/` children of terminal Runs.
 *
 * Doing this ourselves is the point. It is the same job Sandcastle's
 * `pruneStale()` does destructively across siblings — deleting worktrees git
 * no longer considers active, on *every* worktree creation — and ADR 0001 took
 * ownership of worktrees precisely so this could be a rule Rocky writes.
 * Hence the rule:
 *
 * > Every non-terminal Run is kept forever. No timer ever deletes something
 * > still parked. (NG-574 §10)
 *
 * ⚠️ `liveRunIds` is therefore load-bearing and is not defaulted. It must be
 * every Run that has not reached a terminal state; a caller that passes an
 * empty set because its index failed to load would delete the uncommitted work
 * of every parked Run on the machine. The push precondition — NG-574 §3 allows
 * removal only after the branch is pushed — is likewise the caller's, because
 * it is a fact about the Run rather than about the filesystem.
 */
import { readdir } from 'node:fs/promises';

import { isCloned } from './clone.js';
import type { RepoContext } from './context.js';
import { gitOk } from './git.js';
import { removeWorkspace } from './workspace.js';

export interface SweepOptions {
  /**
   * Every Run that has *not* reached a terminal state. Anything under
   * `runs/` that is not in here loses its `workspace/`.
   */
  liveRunIds: Iterable<string>;
}

export interface SweepReport {
  /** Clones pruned, by repo name. */
  pruned: string[];
  /** Terminal Runs whose workspace went, and which repos were in it. */
  removed: { runId: string; repos: string[] }[];
  /** What could not be reclaimed. For the daemon log; never thrown. */
  failures: { runId?: string; repo?: string; message: string }[];
}

export async function sweep(
  ctx: RepoContext,
  options: SweepOptions,
): Promise<SweepReport> {
  const live = new Set(options.liveRunIds);
  const report: SweepReport = { pruned: [], removed: [], failures: [] };

  for (const repoName of await directoriesIn(ctx.paths.reposDir)) {
    const clone = ctx.paths.repo(repoName);
    if (!(await isCloned(clone))) {
      continue;
    }

    // Under the mutex: a `worktree add` for another Run half-done is exactly
    // what a prune must not land in the middle of.
    const ok = await ctx.mutex.run(repoName, () =>
      gitOk(['worktree', 'prune'], { cwd: clone }),
    );

    if (ok) {
      report.pruned.push(repoName);
    } else {
      report.failures.push({
        repo: repoName,
        message: `\`git worktree prune\` failed in ${clone}.`,
      });
    }
  }

  for (const runId of await directoriesIn(ctx.paths.runsDir)) {
    if (live.has(runId)) {
      continue;
    }

    try {
      const repos = await removeWorkspace(ctx, runId);
      if (repos.length > 0) {
        report.removed.push({ runId, repos: repos.sort() });
      }
    } catch (error) {
      // One unreclaimable directory must not stop the sweep: the next Run
      // still needs the rest of the disk back.
      report.failures.push({ runId, message: String(error) });
    }
  }

  return report;
}

/**
 * Directory names only. `repos/` and `runs/` are on a developer's own machine,
 * so a stray `.DS_Store` is a normal thing to find and not worth a failure.
 */
async function directoriesIn(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}
