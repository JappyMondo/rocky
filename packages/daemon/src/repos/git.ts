/**
 * Running git (NG-521).
 *
 * Deliberately a process runner rather than an abstraction: NG-580 settled
 * that "git plumbing never enters the seam" — `ctx.scm` is platform-API-only
 * because git is identical on GitHub and GitLab. So nothing here models a
 * commit or a branch. It spawns git, and it fails legibly.
 *
 * Two guarantees:
 *
 * - **The developer's ambient credentials, untouched.** Rocky mints nothing.
 *   The environment is inherited, not replaced, so the SSH agent, the
 *   credential helper and any `GIT_SSH_COMMAND` the developer relies on all
 *   still apply. That is also why this file sets no `GIT_SSH_COMMAND` of its
 *   own: choosing one would be Rocky overriding a setup it promised to use.
 * - **Never a prompt, never an unbounded wait.** `GIT_TERMINAL_PROMPT=0` and a
 *   timeout, because the daemon has no terminal and a hung fetch inside the
 *   per-repo mutex would stall every later Run on that repo.
 */
import { execFile } from 'node:child_process';

/** Generous: a cold clone of a large monorepo is a legitimately slow fetch. */
export const DEFAULT_GIT_TIMEOUT_MS = 10 * 60_000;

/** `git worktree list --porcelain` on a busy clone is still only kilobytes. */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export interface GitOptions {
  cwd?: string;
  /** Merged over the inherited environment, never replacing it. */
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface GitResult {
  stdout: string;
  stderr: string;
}

/**
 * A failed git command. Carries `args` and `cwd` as well as the message so a
 * caller can recognise the failure it expected — "branch already checked out",
 * "couldn't find remote ref" — and say something better than the raw stderr.
 */
export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly cwd: string | undefined,
    readonly exitCode: number | null,
    readonly stderr: string,
    readonly timedOut: boolean,
  ) {
    const what = `git ${args.join(' ')}`;
    const why = timedOut
      ? 'timed out'
      : `failed${exitCode === null ? '' : ` (exit ${exitCode})`}`;
    const said = stderr.trim();

    super(said ? `${what} ${why}: ${said}` : `${what} ${why}`);
    this.name = 'GitError';
  }
}

export function git(
  args: readonly string[],
  options: GitOptions = {},
): Promise<GitResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;

  return new Promise<GitResult>((resolve, reject) => {
    const spawnFailed = (error: unknown) => {
      // A cwd that is a file rather than a directory makes `execFile` throw
      // `spawn ENOTDIR` synchronously, and one that does not exist gives
      // `spawn ENOENT`. Both have to arrive as a `GitError` like everything
      // else: `gitOk` recognises only that, so a raw error escaping here would
      // turn "is this a clone?" from a question into a crash.
      const code = (error as NodeJS.ErrnoException).code;
      reject(
        new GitError(
          args,
          options.cwd,
          null,
          `${String(code ?? error)}`,
          false,
        ),
      );
    };

    let child;
    try {
      child = execFile(
        'git',
        [...args],
        {
          cwd: options.cwd,
          env: {
            ...process.env,
            // No terminal to prompt on. Without this a private URL with no
            // usable credential hangs git on a username prompt forever, and the
            // symptom — inside the per-repo mutex — is every later Run on that
            // repo silently stopping.
            GIT_TERMINAL_PROMPT: '0',
            ...options.env,
          },
          timeout: timeoutMs,
          maxBuffer: MAX_OUTPUT_BYTES,
          // git speaks the locale, and Rocky matches its output against
          // English phrases in a couple of places.
          encoding: 'utf8',
        },
        (error, stdout, stderr) => {
          if (error === null) {
            resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
            return;
          }

          const failure = error as Error & {
            code?: number | string;
            signal?: NodeJS.Signals | null;
          };
          // `execFile` reports a timeout by killing the child, which surfaces
          // as a signal rather than an exit code.
          const timedOut =
            failure.signal !== null && failure.signal !== undefined;

          reject(
            new GitError(
              args,
              options.cwd,
              typeof failure.code === 'number' ? failure.code : null,
              stderr || failure.message,
              timedOut,
            ),
          );
        },
      );
    } catch (error) {
      spawnFailed(error);
      return;
    }

    // The same failures can also arrive asynchronously, depending on the
    // platform and on which check inside libuv catches them first.
    child.on('error', spawnFailed);
  });
}

/**
 * For the questions where git's non-zero exit *is* the answer — does this ref
 * exist, is this commit an ancestor of that one. A caller that treated those
 * as errors would need a `try`/`catch` around a fact.
 */
export async function gitOk(
  args: readonly string[],
  options: GitOptions = {},
): Promise<boolean> {
  try {
    await git(args, options);
    return true;
  } catch (error) {
    if (error instanceof GitError && !error.timedOut) {
      return false;
    }
    throw error;
  }
}
