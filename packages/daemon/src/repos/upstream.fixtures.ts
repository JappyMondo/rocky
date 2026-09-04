/**
 * Real git repositories on disk, for the specs in this directory.
 *
 * There is no seam here on purpose. Everything NG-521 promises is a statement
 * about what git actually does — that a bare clone never claims a branch, that
 * `--worktree` config beats a global `user.email`, that `merge --ff-only`
 * refuses a diverged branch — and a faked git would let all three of those
 * regress while the suite stayed green. So the fixtures build a bare
 * "upstream" in a temp directory and Rocky fetches from it over a `file://`
 * path, which exercises the same code path as a remote without a network.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * A committer for the fixture's own commits, and a global config the tests can
 * point git at so the machine running them contributes nothing.
 */
export const FIXTURE_AUTHOR = {
  name: 'Fixture Human',
  email: 'human@example.test',
} as const;

export interface Upstream {
  /** The bare repository Rocky treats as `origin`. */
  url: string;
  dir: string;
  /** A scratch clone of it, for acting as a human with push access. */
  workingCopy: string;
  /** `git` in the working copy. */
  git(...args: string[]): Promise<string>;
  /** Commit `message`, touching `file`, and push the current branch. */
  commitAndPush(options: {
    branch: string;
    file?: string;
    body?: string;
    message?: string;
  }): Promise<string>;
  head(ref: string): Promise<string>;
}

export function makeTempDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `rocky-${label}-`));
}

/**
 * The env every fixture git command runs with: an empty global and system
 * config, so a developer's own `user.email`, `init.defaultBranch` or
 * `core.hooksPath` cannot change what the suite proves.
 */
export function isolatedGitEnv(
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: FIXTURE_AUTHOR.name,
    GIT_AUTHOR_EMAIL: FIXTURE_AUTHOR.email,
    GIT_COMMITTER_NAME: FIXTURE_AUTHOR.name,
    GIT_COMMITTER_EMAIL: FIXTURE_AUTHOR.email,
    ...overrides,
  };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, env: isolatedGitEnv() });
  return stdout.trim();
}

/**
 * A bare upstream with `main` and, optionally, extra branches — the prior art
 * a Run adopts (NG-580).
 */
export async function createUpstream(
  options: { branches?: string[]; defaultBranch?: string } = {},
): Promise<Upstream> {
  const defaultBranch = options.defaultBranch ?? 'main';
  const root = makeTempDir('upstream');
  const dir = join(root, 'origin.git');
  const workingCopy = join(root, 'working-copy');

  await git(root, ['init', '--quiet', '--bare', `--initial-branch=${defaultBranch}`, dir]); // prettier-ignore
  await mkdir(workingCopy, { recursive: true });

  const inCopy = (...args: string[]) => git(workingCopy, args);

  await inCopy('init', '--quiet', `--initial-branch=${defaultBranch}`);
  await inCopy('remote', 'add', 'origin', dir);
  await inCopy('commit', '--quiet', '--allow-empty', '-m', 'Initial commit');
  await inCopy('push', '--quiet', '--set-upstream', 'origin', defaultBranch);

  for (const branch of options.branches ?? []) {
    await inCopy('checkout', '--quiet', '-b', branch, defaultBranch);
    await inCopy(
      'commit',
      '--quiet',
      '--allow-empty',
      '-m',
      `Prior art on ${branch}`,
    );
    await inCopy('push', '--quiet', '--set-upstream', 'origin', branch);
  }
  await inCopy('checkout', '--quiet', defaultBranch);

  return {
    // `file://` rather than a bare path: it takes git's remote-helper path,
    // which is the one a real `origin` uses.
    url: `file://${dir}`,
    dir,
    workingCopy,
    git: (...args) => inCopy(...args),
    head: (ref) => inCopy('rev-parse', ref),

    async commitAndPush({ branch, file = 'HUMAN.md', body, message }) {
      await inCopy('fetch', '--quiet', 'origin');
      // `-B` here is the *fixture* standing in for a human's own checkout, not
      // Rocky: Rocky never resets a branch (NG-580).
      await inCopy('checkout', '--quiet', '-B', branch, `origin/${branch}`);
      await writeFile(join(workingCopy, file), body ?? 'a human was here\n');
      await inCopy('add', '--all');
      await inCopy('commit', '--quiet', '-m', message ?? 'A human pushed this');
      await inCopy('push', '--quiet', 'origin', branch);
      return inCopy('rev-parse', 'HEAD');
    },
  };
}
