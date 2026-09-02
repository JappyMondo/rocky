/**
 * Rocky's own clone of a repo (NG-521, NG-578).
 *
 * One persistent clone per repo at `~/.rocky/repos/<repoName>/`, and it is
 * **bare**. That is the one non-obvious choice here, and it is load-bearing:
 * git refuses `worktree add` for a branch that some worktree already has
 * checked out, and a non-bare clone checks out its own default branch. A Run
 * on the base branch would then fail for a reason with nothing to do with the
 * Run. A bare clone claims no branch, so every branch stays available.
 *
 * It is built as `init --bare` + `remote add` + `fetch` rather than
 * `clone --bare`, for two reasons: `clone --bare` copies the upstream heads
 * into local `refs/heads/*` (which would claim branches after all) and sets no
 * fetch refspec, whereas `remote add` sets the ordinary
 * `+refs/heads/*:refs/remotes/origin/*` — so the clone ends up with exactly
 * the remote-tracking layout a normal clone has, and no local branches until a
 * Run's worktree makes one.
 *
 * Credentials are the developer's own, ambient: an SSH agent or a credential
 * helper. Rocky mints nothing — the per-fetch platform tokens belonged to the
 * retired server product and are on this ticket's "do not add" list.
 */
import { mkdir, readdir, rm, stat } from 'node:fs/promises';

import type { CloneRef, RepoContext } from './context.js';
import { GitError, git, gitOk } from './git.js';

/** A clone that could not be made or refreshed, phrased for a human. */
export class CloneError extends Error {
  constructor(
    readonly repo: string,
    readonly url: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'CloneError';
  }
}

export interface CloneOutcome {
  repo: string;
  dir: string;
  /** `created` only on the fetch that first filled the directory. */
  state: 'created' | 'updated';
  /**
   * The upstream's own default branch, from `origin/HEAD`. `rocky repo add`
   * records this as `baseBranch` so a human does not have to know it.
   */
  defaultBranch?: string;
}

export interface CloneStatus {
  name: string;
  url: string;
  dir: string;
  cloned: boolean;
  defaultBranch?: string;
}

/**
 * Make sure `repo` has a usable clone, then fetch it. Idempotent, so it is
 * safe as the daemon's response to a repo appearing in `config.json`, as
 * `rocky repo add`'s eager clone, and as a Run's own preparation.
 *
 * Holds the repo's mutex for the whole thing: `init`, `remote` and `fetch` all
 * touch the shared clone, and the sweep's `worktree prune` must not land
 * between them.
 */
export function ensureClone(
  ctx: RepoContext,
  repo: CloneRef,
): Promise<CloneOutcome> {
  return ctx.mutex.run(repo.name, () => ensureCloneLocked(ctx, repo));
}

async function ensureCloneLocked(
  ctx: RepoContext,
  repo: CloneRef,
): Promise<CloneOutcome> {
  const dir = ctx.paths.repo(repo.name);
  const alreadyThere = await isCloned(dir);

  if (!alreadyThere) {
    await refuseIfOccupied(ctx, repo, dir);
    await mkdir(dir, { recursive: true });
    await git(['init', '--quiet', '--bare', dir]);
  }

  // `remote add` sets `+refs/heads/*:refs/remotes/origin/*`; `set-url` keeps
  // it. Following a hand-edited url matters because the alternative is a clone
  // that silently keeps fetching from wherever it was first pointed.
  if (await gitOk(['remote', 'get-url', 'origin'], { cwd: dir })) {
    await git(['remote', 'set-url', 'origin', repo.url], { cwd: dir });
  } else {
    await git(['remote', 'add', 'origin', repo.url], { cwd: dir });
  }

  try {
    await git(['fetch', '--quiet', '--prune', 'origin'], { cwd: dir });
  } catch (error) {
    // Only the directory this call created is cleaned up. An existing clone is
    // the only copy of a parked Run's prior art, and NG-574's rule is that
    // Rocky never destroys work, only its own scaffolding.
    if (!alreadyThere) {
      await rm(dir, { recursive: true, force: true });
    }
    throw unreachable(repo, error);
  }

  await enableWorktreeConfig(dir);

  // Records `origin/HEAD`, which is where the upstream's default branch is
  // legible from without asking the platform API.
  await gitOk(['remote', 'set-head', 'origin', '--auto'], { cwd: dir });

  return {
    repo: repo.name,
    dir,
    state: alreadyThere ? 'updated' : 'created',
    defaultBranch: await readDefaultBranch(dir),
  };
}

/** Per configured repo, whether Rocky has it yet. Touches no network. */
export async function cloneStatus(
  ctx: RepoContext,
  repos: readonly CloneRef[],
): Promise<CloneStatus[]> {
  return Promise.all(
    repos.map(async (repo) => {
      const dir = ctx.paths.repo(repo.name);
      const cloned = await isCloned(dir);

      return {
        name: repo.name,
        url: repo.url,
        dir,
        cloned,
        defaultBranch: cloned ? await readDefaultBranch(dir) : undefined,
      };
    }),
  );
}

export async function isCloned(dir: string): Promise<boolean> {
  return gitOk(['rev-parse', '--git-dir'], { cwd: dir });
}

/**
 * Turn on genuinely per-worktree config, which is what lets NG-580's
 * worktree-local `user.name` / `user.email` be worktree-local rather than
 * shared across every Run on the repo.
 *
 * The relocation of `core.bare` is not optional and not cosmetic. With
 * `extensions.worktreeConfig` enabled, git reads `core.bare` **only** from
 * `config.worktree`; leaving `git init --bare`'s copy in the shared config
 * means every linked worktree inherits `core.bare = true` and every command
 * that needs a working tree fails with `fatal: this operation must be run in a
 * work tree`. Moving it into the *main* worktree's own `config.worktree` keeps
 * the clone bare and leaves the linked worktrees alone — git's own documented
 * remedy.
 *
 * Idempotent: run on every ensure, so a clone made by an earlier Rocky gets it.
 */
async function enableWorktreeConfig(dir: string): Promise<void> {
  await git(['config', 'extensions.worktreeConfig', 'true'], { cwd: dir });
  await git(['config', '--worktree', 'core.bare', 'true'], { cwd: dir });
  // Absent already on the second run through, and `--unset` of a missing key
  // is git's exit 5 rather than a real failure.
  await gitOk(['config', '--unset', '--local', 'core.bare'], { cwd: dir });
}

/**
 * `origin/HEAD` as a plain branch name. Absent when the upstream is empty, or
 * when it has no HEAD to speak of — hence optional rather than guessed.
 */
async function readDefaultBranch(dir: string): Promise<string | undefined> {
  try {
    const { stdout } = await git(
      ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
      { cwd: dir },
    );
    return stdout.replace(/^origin\//, '') || undefined;
  } catch {
    return undefined;
  }
}

/**
 * A directory a human put something else in. `git init --bare` would either
 * succeed over the top of it or fail with a message about a template, and
 * neither says what actually happened.
 */
async function refuseIfOccupied(
  ctx: RepoContext,
  repo: CloneRef,
  dir: string,
): Promise<void> {
  let entries: string[];
  try {
    const stats = await stat(dir);
    if (!stats.isDirectory()) {
      throw new CloneError(
        repo.name,
        repo.url,
        `${dir} is not a directory, and it is where Rocky keeps its clone of "${repo.name}". Move it out of the way.`,
      );
    }
    entries = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }

  if (entries.length > 0) {
    throw new CloneError(
      repo.name,
      repo.url,
      `${dir} already has files in it but is not a git repository, so Rocky will not clone "${repo.name}" over the top of it. Move or delete it, then try again.`,
    );
  }
}

function unreachable(repo: CloneRef, cause: unknown): CloneError {
  const said = cause instanceof GitError ? cause.stderr : String(cause);

  return new CloneError(
    repo.name,
    repo.url,
    [
      `Could not fetch "${repo.name}" from ${repo.url}.`,
      said && `git said: ${said}`,
      `Rocky clones with your own git credentials — an SSH agent or a credential helper — and mints none of its own, so check that \`git ls-remote ${repo.url}\` works for you.`,
    ]
      .filter(Boolean)
      .join('\n'),
    { cause },
  );
}
