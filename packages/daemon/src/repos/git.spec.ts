/**
 * The git runner (NG-521).
 *
 * Thin on purpose — NG-580 settled that "git plumbing never enters the seam",
 * so this is a process runner, not an abstraction over git. Its two jobs are
 * both about failure: say enough that a human can act, and never hang the
 * daemon waiting for someone to type a password.
 */
import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import { GitError, git, gitOk } from './git.js';
import { createUpstream, makeTempDir } from './upstream.fixtures.js';

const trash: string[] = [];

afterEach(() => {
  for (const dir of trash.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function temp(label: string): string {
  const dir = makeTempDir(label);
  trash.push(dir);
  return dir;
}

describe('a command that works', () => {
  it('hands back trimmed stdout', async () => {
    const upstream = await createUpstream();
    trash.push(upstream.dir, upstream.workingCopy);

    const result = await git(['rev-parse', '--is-bare-repository'], {
      cwd: upstream.dir,
    });

    expect(result.stdout).toBe('true');
  });
});

describe('a command that fails', () => {
  it('names the command and what git said, both of which a human needs', async () => {
    const dir = temp('not-a-repo');

    const error = await git(['rev-parse', 'HEAD'], { cwd: dir }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(GitError);
    const failure = error as GitError;
    expect(failure.message).toContain('git rev-parse HEAD');
    expect(failure.message).toMatch(/not a git repository/i);
    expect(failure.exitCode).not.toBe(0);
    expect(failure.stderr).toMatch(/not a git repository/i);
  });

  it('keeps the arguments, so a caller can explain the failure in its own words', async () => {
    const dir = temp('not-a-repo');

    const failure = (await git(['status'], { cwd: dir }).catch(
      (caught: unknown) => caught,
    )) as GitError;

    expect(failure.args).toEqual(['status']);
    expect(failure.cwd).toBe(dir);
  });
});

describe('a command whose failure is an answer', () => {
  it('is asked with gitOk, which reports rather than throws', async () => {
    const upstream = await createUpstream();
    trash.push(upstream.dir, upstream.workingCopy);

    await expect(
      gitOk(['rev-parse', '--verify', 'refs/heads/nope'], {
        cwd: upstream.dir,
      }),
    ).resolves.toBe(false);

    await expect(
      gitOk(['rev-parse', '--verify', 'HEAD'], { cwd: upstream.dir }),
    ).resolves.toBe(true);
  });
});

describe('never blocking on a human', () => {
  it("turns off git's own terminal prompt, which a daemon can never answer", async () => {
    const upstream = await createUpstream();
    trash.push(upstream.dir, upstream.workingCopy);

    // The shape that hangs a daemon is git asking for a username on a
    // terminal it does not have. Asserted through git itself rather than by
    // reading the runner's env object, because the promise is about the
    // process that actually runs.
    const result = await git(
      ['-c', 'alias.showprompt=!echo ${GIT_TERMINAL_PROMPT-unset}', 'showprompt'], // prettier-ignore
      { cwd: upstream.workingCopy },
    );

    expect(result.stdout).toBe('0');
  });

  it("inherits the developer's ambient credentials — Rocky mints nothing", async () => {
    const upstream = await createUpstream();
    trash.push(upstream.dir, upstream.workingCopy);

    // NG-521: clones use the developer's SSH agent and credential helper. The
    // observable form of that is simply that the environment is passed through
    // rather than replaced, so `SSH_AUTH_SOCK` and friends survive.
    const result = await git(
      ['-c', 'alias.showvar=!echo ${ROCKY_AMBIENT_PROBE-unset}', 'showvar'],
      { cwd: upstream.workingCopy, env: { ROCKY_AMBIENT_PROBE: 'agent-sock' } },
    );

    expect(result.stdout).toBe('agent-sock');
  });

  it('gives up on a command that will not finish', async () => {
    const upstream = await createUpstream();
    trash.push(upstream.dir, upstream.workingCopy);

    const failure = (await git(['-c', 'alias.wait=!sleep 30', 'wait'], {
      cwd: upstream.workingCopy,
      timeoutMs: 200,
    }).catch((caught: unknown) => caught)) as GitError;

    expect(failure).toBeInstanceOf(GitError);
    expect(failure.timedOut).toBe(true);
    expect(failure.message).toMatch(/timed out/);
  });
});
