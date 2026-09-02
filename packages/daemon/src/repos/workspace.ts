/**
 * A Run's workspace: one plain `git worktree add` per member repo (NG-521,
 * NG-578).
 *
 * ```
 * ~/.rocky/runs/<runId>/workspace/
 * ├── niotix/        # a worktree of ~/.rocky/repos/niotix
 * └── niota-api/     # a worktree of ~/.rocky/repos/niota-api
 * ```
 *
 * A plain repo is a workspace with one child, so grouped and single-repo Runs
 * are the same shape and the parent is what the agent is handed either way
 * (NG-578, and the layout comment in `config/paths.ts`).
 *
 * "Plain" is the operative word in `git worktree add`. ADR 0001 dropped
 * Sandcastle, and its `createWorktree()` is on this ticket's do-not-add list:
 * it calls `pruneStale()`, which recursively deletes worktrees git no longer
 * considers active, so it would delete a *sibling* Run's work. Rocky owns
 * worktrees precisely so nothing does that.
 *
 * Two rules run through every branch below:
 *
 * - **Adopt, never reset** (NG-580). Whatever a prior Run or a human left on
 *   the issue's branch is prior art. There is no `reset --hard` in this file.
 * - **At-least-once** (NG-574 §6). A Step that creates something outside Rocky
 *   finds the existing one rather than making a second, and an adopted
 *   worktree is taken exactly as found — uncommitted edits included, because a
 *   half-finished edit is the normal state an agent works from.
 */
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { ensureClone } from './clone.js';
import type { RepoContext, RepoRef } from './context.js';
import { GitError, git, gitOk } from './git.js';

/** Something wrong with a workspace, phrased for a human. */
export class WorkspaceError extends Error {
  constructor(
    readonly runId: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'WorkspaceError';
  }
}

/** How a member's branch came to be, which is worth journaling. */
export type Adoption =
  /** The worktree was already there — a re-run of the same Step. */
  | 'already-there'
  /** A local branch a prior Run left behind, taken at its tip. */
  | 'existing-local'
  /** The upstream has the branch; taken at its tip. */
  | 'remote-branch'
  /** Nobody has it yet; started from the entry's `baseBranch`. */
  | 'new-from-base';

export interface WorkspaceMember {
  repo: string;
  /** Stable for the Run's whole life (NG-578). */
  dir: string;
  /** The group's lead, whose `.rocky/` the Run executes (NG-578). */
  lead: boolean;
  branch: string;
  head: string;
  adopted: Adoption;
}

export interface Workspace {
  runId: string;
  /** The parent: one child per repo, grouped or not. */
  dir: string;
  /** In the order the caller listed the members. */
  members: WorkspaceMember[];
  lead: WorkspaceMember;
}

export interface CreateWorkspaceOptions {
  runId: string;
  /** Linear's own `gitBranchName`, the same across every member (NG-578). */
  branch: string;
  members: readonly RepoRef[];
  /** Repo-entry name of the lead. For a plain Run, the only member. */
  lead: string;
}

export async function createWorkspace(
  ctx: RepoContext,
  options: CreateWorkspaceOptions,
): Promise<Workspace> {
  const { runId, branch, members, lead } = options;

  if (members.length === 0) {
    throw new WorkspaceError(runId, `Run ${runId} has no member repos.`);
  }
  if (!members.some((member) => member.name === lead)) {
    throw new WorkspaceError(
      runId,
      `Run ${runId} names "${lead}" as its lead, but its members are ${members
        .map((member) => `"${member.name}"`)
        .join(', ')}. The lead must be one of the group's own repos.`,
    );
  }

  const workspaceDir = ctx.paths.run(runId).workspaceDir;
  await mkdir(workspaceDir, { recursive: true });

  // Sequential rather than concurrent: a grouped Run is two or three repos,
  // and a fetch storm on a laptop's uplink is worse than waiting.
  const materialised: WorkspaceMember[] = [];
  for (const repo of members) {
    materialised.push(
      await materialise(ctx, { runId, branch, repo, lead: repo.name === lead }),
    );
  }

  return {
    runId,
    dir: workspaceDir,
    members: materialised,
    // Non-null by the check above.
    lead: materialised.find((member) => member.lead) as WorkspaceMember,
  };
}

async function materialise(
  ctx: RepoContext,
  options: { runId: string; branch: string; repo: RepoRef; lead: boolean },
): Promise<WorkspaceMember> {
  const { runId, branch, repo, lead } = options;
  const dir = ctx.paths.run(runId).workspaceRepo(repo.name);

  // Fetch first, and outside the `worktree add` lock rather than inside it:
  // both take the repo's mutex, one after the other. Holding it across both
  // would buy nothing — anything another Run did in between is on another
  // branch — and re-entering it would deadlock.
  const clone = (await ensureClone(ctx, repo)).dir;

  const adopted = await ctx.mutex.run(repo.name, async () => {
    if (await isWorktree(dir)) {
      return 'already-there' as const;
    }
    return addWorktree(ctx, { runId, branch, repo, clone, dir });
  });

  // Outside the lock: the worktree's own config is nobody else's business, and
  // it is re-asserted on every call so a hand-edit cannot outlive one Boot.
  await writeIdentity(ctx, dir);

  return {
    repo: repo.name,
    dir,
    lead,
    branch,
    head: (await git(['rev-parse', 'HEAD'], { cwd: dir })).stdout,
    adopted,
  };
}

async function addWorktree(
  ctx: RepoContext,
  options: {
    runId: string;
    branch: string;
    repo: RepoRef;
    clone: string;
    dir: string;
  },
): Promise<Adoption> {
  const { runId, branch, repo, clone, dir } = options;
  const inClone = { cwd: clone };

  // Cheap insurance: metadata for a directory a human deleted by hand would
  // otherwise make `worktree add` refuse a path that is not actually taken.
  await gitOk(['worktree', 'prune'], inClone);

  const [hasLocal, hasRemote] = await Promise.all([
    gitOk(
      ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
      inClone,
    ),
    gitOk(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], inClone), // prettier-ignore
  ]);

  // The order is the adoption rule. A local branch is the newest prior art —
  // it may hold commits a previous Run made and never pushed — so it wins over
  // the remote, and neither is ever reset onto the other.
  const add = hasLocal
    ? { args: [branch], adopted: 'existing-local' as const }
    : hasRemote
      ? {
          args: ['--track', '-b', branch, `origin/${branch}`],
          adopted: 'remote-branch' as const,
        }
      : {
          args: ['-b', branch, `origin/${repo.baseBranch}`],
          adopted: 'new-from-base' as const,
        };

  if (!hasLocal && !hasRemote) {
    const base = `refs/remotes/origin/${repo.baseBranch}`;
    if (!(await gitOk(['rev-parse', '--verify', '--quiet', base], inClone))) {
      throw new WorkspaceError(
        runId,
        `Repo "${repo.name}" has no branch "${branch}" and no base branch "${repo.baseBranch}" to start one from. Fix \`baseBranch\` for "${repo.name}" in \`~/.rocky/config.json\` — ${repo.url} has no \`origin/${repo.baseBranch}\`.`,
      );
    }
  }

  try {
    await git(['worktree', 'add', '--quiet', dir, ...add.args], inClone);
  } catch (error) {
    throw addFailed(ctx, { runId, branch, repo, error });
  }

  return add.adopted;
}

/**
 * Turn git's refusals into something a human can act on. The one worth
 * naming is a branch another worktree already has: "at most one non-terminal
 * Run per issue" (NG-574 §1) makes it unreachable in normal operation, so when
 * it happens the other directory is the whole of the diagnosis.
 */
function addFailed(
  ctx: RepoContext,
  options: { runId: string; branch: string; repo: RepoRef; error: unknown },
): WorkspaceError {
  const { runId, branch, repo, error } = options;
  const said = error instanceof GitError ? error.stderr : String(error);
  const alreadyUsed = /already used by worktree at '([^']+)'/.exec(said);

  if (alreadyUsed) {
    return new WorkspaceError(
      runId,
      `Branch "${branch}" of "${repo.name}" is already checked out at ${alreadyUsed[1]}, so Run ${runId} cannot take it too. Two Runs on one branch is the failure mode that eats work — end the other Run, or delete that directory if it is left over from one that died.`,
      { cause: error },
    );
  }

  return new WorkspaceError(
    runId,
    `Could not create the worktree for "${repo.name}" at ${ctx.paths.run(runId).workspaceRepo(repo.name)}${said ? ` — git said: ${said}` : '.'}`,
    { cause: error },
  );
}

/**
 * The Rocky identity, written into the worktree's own config (NG-580) so
 * commit authorship is structural rather than prompt-trusted: an Agent commits
 * through its `bash` Capability, and nothing in a prompt can change who the
 * commit is from.
 *
 * `--worktree` is what makes it worktree-local rather than shared across every
 * Run on the repo; `clone.ts` turns on the `extensions.worktreeConfig` that
 * needs, and explains the `core.bare` trap that comes with it.
 */
async function writeIdentity(ctx: RepoContext, dir: string): Promise<void> {
  await git(['config', '--worktree', 'user.name', ctx.identity.name], {
    cwd: dir,
  });
  await git(['config', '--worktree', 'user.email', ctx.identity.email], {
    cwd: dir,
  });
}

async function isWorktree(dir: string): Promise<boolean> {
  return gitOk(['rev-parse', '--is-inside-work-tree'], { cwd: dir });
}

/**
 * Remove a Run's whole workspace. Names of the repos removed, so a caller can
 * report it; an empty array for a Run that has none.
 *
 * The precondition is not enforced here: NG-574 §3 allows removal only at a
 * terminal state and only after the branch is pushed, and both of those are
 * facts about the Run rather than about the filesystem. What this does
 * guarantee is that removing the directory never removes the *work* — the
 * branch stays in the clone, which is why `--force` on a dirty worktree is
 * safe at that point.
 */
export async function removeWorkspace(
  ctx: RepoContext,
  runId: string,
): Promise<string[]> {
  const workspaceDir = ctx.paths.run(runId).workspaceDir;

  let children: string[];
  try {
    children = await readdir(workspaceDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  for (const repoName of children) {
    await ctx.mutex.run(repoName, async () => {
      const clone = ctx.paths.repo(repoName);
      const dir = join(workspaceDir, repoName);

      // `--force` because a terminal Run's worktree may be dirty, and by then
      // the branch is pushed. Falling back to a plain delete plus a prune
      // covers a worktree whose metadata a human already removed.
      if (
        !(await gitOk(['worktree', 'remove', '--force', dir], { cwd: clone }))
      ) {
        await rm(dir, { recursive: true, force: true });
        await gitOk(['worktree', 'prune'], { cwd: clone });
      }
    });
  }

  // The Run directory itself stays: the journal, `run.json` and the snapshot
  // are retention's (NG-574 §10), not the sweep's.
  await rm(workspaceDir, { recursive: true, force: true });

  return children;
}
