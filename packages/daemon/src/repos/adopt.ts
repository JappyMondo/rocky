/**
 * Adopting a human's push at wake (NG-521, NG-574 §9).
 *
 * §9 dissolved invalidation: nothing makes a Run stale, and "a human pushed to
 * the branch" resolved to **adoption** rather than failure — "a human pushing
 * a fix is the system working". So this is the one reconciliation Rocky does,
 * and it is deliberately narrow: fast-forward, or report. There is no merge, no
 * rebase and no reset anywhere in this file, because every one of those either
 * invents history or destroys work, and §9 allows neither.
 *
 * The Run-failing case is exactly one: a genuinely diverged worktree, where
 * neither head is an ancestor of the other and both are real work. Reaching it
 * needs a crash first — Rocky committed and the push never happened.
 */
import type { RepoContext, RepoRef } from './context.js';
import { GitError, git, gitOk } from './git.js';

export interface AdoptOptions {
  runId: string;
  repo: RepoRef;
  /** Linear's own `gitBranchName` — the branch the Run works on. */
  branch: string;
  /** The member's worktree, from `createWorkspace`. */
  worktree: string;
  /**
   * The head SHA Rocky last pushed for this branch, from the journal. Absent
   * before the first push. Used to phrase the note — whether the remote moved
   * is decided by the refs themselves, which cannot be out of date.
   */
  lastPushedSha?: string;
}

interface Common {
  repo: string;
  branch: string;
  /** The worktree's head after this call. */
  head: string;
}

export type AdoptOutcome =
  /** Remote and worktree agree. Nothing happened. */
  | ({ kind: 'unchanged' } & Common)
  /** The branch is not on the remote yet, so there is nothing to adopt. */
  | ({ kind: 'no-remote-branch' } & Common)
  /** Rocky holds commits it has not pushed. The normal working state. */
  | ({ kind: 'local-ahead'; ahead: number } & Common)
  /** The remote moved forward and a clean worktree took it. */
  | ({
      kind: 'fast-forwarded';
      from: string;
      to: string;
      commits: number;
      note: string;
    } & Common)
  /** The remote moved forward but the worktree is mid-edit. Left alone. */
  | ({
      kind: 'dirty';
      remote: string;
      changed: string[];
      note: string;
    } & Common)
  /** Neither side is an ancestor of the other. Fails the Run. */
  | ({ kind: 'diverged'; remote: string; note: string } & Common);

/**
 * Whether this outcome ends the Run. Exactly one kind does, and it is a value
 * rather than a thrown error so the caller journals the note either way.
 */
export function failsTheRun(outcome: AdoptOutcome): boolean {
  return outcome.kind === 'diverged';
}

export async function adoptRemoteMoves(
  ctx: RepoContext,
  options: AdoptOptions,
): Promise<AdoptOutcome> {
  const { repo, branch, worktree, lastPushedSha } = options;
  const clone = ctx.paths.repo(repo.name);
  const inWorktree = { cwd: worktree };
  const common = { repo: repo.name, branch };

  // The fetch is a clone operation, so it takes the repo's mutex like the
  // rest. Everything after it reads the worktree, which is this Run's alone.
  const onRemote = await ctx.mutex.run(repo.name, () =>
    fetchBranch(clone, branch),
  );

  const head = (await git(['rev-parse', 'HEAD'], inWorktree)).stdout;
  const remoteRef = `refs/remotes/origin/${branch}`;

  if (
    !onRemote ||
    !(await gitOk(['rev-parse', '--verify', '--quiet', remoteRef], inWorktree))
  ) {
    return { ...common, kind: 'no-remote-branch', head };
  }

  const remote = (await git(['rev-parse', remoteRef], inWorktree)).stdout;

  if (remote === head) {
    return { ...common, kind: 'unchanged', head };
  }

  // Rocky committed since it last pushed. Not a move on the remote's part, so
  // there is nothing to adopt and nothing to say.
  if (await isAncestor(remote, head, worktree)) {
    return {
      ...common,
      kind: 'local-ahead',
      head,
      ahead: await countCommits(remote, head, worktree),
    };
  }

  if (!(await isAncestor(head, remote, worktree))) {
    return {
      ...common,
      kind: 'diverged',
      head,
      remote,
      note: [
        `Run ${options.runId} cannot continue: "${repo.name}" has diverged from \`origin/${branch}\`.`,
        `Rocky's worktree is at ${short(head)} and the remote is at ${short(remote)}, and neither contains the other — both hold commits the other does not.`,
        `Rocky will not merge, rebase or reset that, because any of the three would either invent history or throw away someone's work. Reconcile it by hand in ${worktree}, then re-delegate the issue.`,
      ].join('\n'),
    };
  }

  // The remote moved forward. §9 conditions the fast-forward on a clean
  // worktree, so a mid-edit one is reported and left exactly as found — the
  // same rule as NG-574 §6's "worktree exactly as found" on a re-run.
  const changed = await changedFiles(worktree);
  if (changed.length > 0) {
    return {
      ...common,
      kind: 'dirty',
      head,
      remote,
      changed,
      note: [
        `\`origin/${branch}\` moved to ${short(remote)} while Run ${options.runId} was parked, but "${repo.name}" has uncommitted changes, so Rocky left it at ${short(head)} rather than merging over them.`,
        `In the way: ${changed.join(', ')}.`,
      ].join('\n'),
    };
  }

  const commits = await countCommits(head, remote, worktree);
  // `--ff-only` and nothing else: it fails rather than creating a merge commit
  // if the assumption above ever turns out to be wrong.
  await git(['merge', '--quiet', '--ff-only', remoteRef], inWorktree);

  const pushedByRocky = lastPushedSha !== undefined && lastPushedSha === remote;

  return {
    ...common,
    kind: 'fast-forwarded',
    head: remote,
    from: head,
    to: remote,
    commits,
    note: pushedByRocky
      ? `Fast-forwarded "${repo.name}" on \`${branch}\` from ${short(head)} to ${short(remote)} (${plural(commits)}) to catch up with what Rocky had already pushed.`
      : `A human pushed to \`${branch}\` while Run ${options.runId} was parked. Fast-forwarded "${repo.name}" from ${short(head)} to ${short(remote)}, adopting ${plural(commits)}.`,
  };
}

/**
 * Fetch just this branch, reporting whether the remote has it.
 *
 * One branch rather than the whole remote, because a Checkpoint-parked Run
 * polls this every five minutes for as long as it takes a human to answer
 * (NG-574 §8). The catch is that git treats a missing ref as a hard failure,
 * and a Run that has not pushed yet is the ordinary case — so that one stderr
 * is turned into `false` and everything else, a network failure included,
 * still throws.
 */
async function fetchBranch(clone: string, branch: string): Promise<boolean> {
  try {
    await git(['fetch', '--quiet', 'origin', branch], { cwd: clone });
    return true;
  } catch (error) {
    if (
      error instanceof GitError &&
      /couldn't find remote ref/i.test(error.stderr)
    ) {
      return false;
    }
    throw error;
  }
}

function short(sha: string): string {
  return sha.slice(0, 7);
}

function plural(commits: number): string {
  return commits === 1 ? '1 commit' : `${commits} commits`;
}

async function isAncestor(
  maybeAncestor: string,
  descendant: string,
  cwd: string,
): Promise<boolean> {
  return gitOk(['merge-base', '--is-ancestor', maybeAncestor, descendant], {
    cwd,
  });
}

async function countCommits(
  from: string,
  to: string,
  cwd: string,
): Promise<number> {
  const { stdout } = await git(['rev-list', '--count', `${from}..${to}`], {
    cwd,
  });
  return Number(stdout);
}

/** Tracked and untracked alike: either would be lost by a merge. */
async function changedFiles(cwd: string): Promise<string[]> {
  const { stdout } = await git(['status', '--porcelain'], { cwd });

  return stdout
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => line.slice(3).trim());
}
