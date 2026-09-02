/**
 * One persistent clone per repo under `~/.rocky/repos/<repoName>/` (NG-521,
 * NG-578).
 *
 * The rule this file exists to protect is the one in the ticket's
 * "deliberately absent" list: **no checkout of the developer's own working
 * copy, ever.** Rocky's clone is Rocky's, it is cloned with the developer's
 * ambient git credentials, and it mints nothing.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'; // prettier-ignore

import { rockyPaths, type RockyPaths } from '../config/paths.js';
import { ensureInstanceLayout } from '../config/store.js';
import { CloneError, cloneStatus, ensureClone } from './clone.js';
import { git, gitOk } from './git.js';
import { KeyedMutex } from './mutex.js';
import { createUpstream, makeTempDir, type Upstream } from './upstream.fixtures.js'; // prettier-ignore
import type { RepoContext } from './context.js';

/**
 * The machine's own git config must not decide what this suite proves, so
 * every git command — Rocky's included, since the runner inherits the
 * environment — runs against an empty global and system config.
 */
const savedEnv = { ...process.env };

beforeAll(() => {
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_SYSTEM = '/dev/null';
});

afterAll(() => {
  process.env = savedEnv;
});

let home: string;
let paths: RockyPaths;
let ctx: RepoContext;
let upstream: Upstream;

beforeEach(async () => {
  home = makeTempDir('home');
  paths = rockyPaths(home);
  await ensureInstanceLayout(paths);
  ctx = {
    paths,
    mutex: new KeyedMutex(),
    identity: { name: 'Rocky', email: 'rocky@localhost' },
  };
  upstream = await createUpstream({ branches: ['ng-601-do-a-thing'] });
});

afterEach(() => {
  for (const dir of [home, upstream.dir, upstream.workingCopy]) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const entry = (overrides: Partial<{ name: string; url: string }> = {}) => ({
  name: 'niotix',
  url: upstream.url,
  baseBranch: 'main',
  label: 'rocky',
  ...overrides,
});

describe('the first clone', () => {
  it('lands at ~/.rocky/repos/<repoName> and nothing else is in it', async () => {
    const outcome = await ensureClone(ctx, entry());

    expect(outcome.state).toBe('created');
    expect(outcome.dir).toBe(join(paths.reposDir, 'niotix'));
    expect(existsSync(outcome.dir)).toBe(true);
  });

  it('has no working tree, so nothing can claim a branch a Run wants', async () => {
    const { dir } = await ensureClone(ctx, entry());

    // A non-bare clone checks out its default branch, and git then refuses
    // `worktree add` for that branch — which would make a Run on the base
    // branch fail for a reason that has nothing to do with the Run.
    expect((await git(['rev-parse', '--is-bare-repository'], { cwd: dir })).stdout).toBe('true'); // prettier-ignore
    expect(
      (await git(['for-each-ref', '--format=%(refname)', 'refs/heads'], { cwd: dir })).stdout, // prettier-ignore
    ).toBe('');
  });

  it('brings the upstream branches down as remote-tracking refs', async () => {
    const { dir } = await ensureClone(ctx, entry());

    const refs = (
      await git(['for-each-ref', '--format=%(refname)', 'refs/remotes'], {
        cwd: dir,
      })
    ).stdout.split('\n');

    expect(refs).toContain('refs/remotes/origin/main');
    expect(refs).toContain('refs/remotes/origin/ng-601-do-a-thing');
  });

  it("reports the upstream's default branch, which is what `rocky repo add` records", async () => {
    const outcome = await ensureClone(ctx, entry());

    expect(outcome.defaultBranch).toBe('main');
  });

  it('turns on per-worktree config without breaking the bare clone', async () => {
    const { dir } = await ensureClone(ctx, entry());

    // NG-580 wants worktree-local identity, which needs
    // `extensions.worktreeConfig`. With it on, git reads `core.bare` only from
    // `config.worktree` — so leaving `git init --bare`'s copy in the shared
    // config makes every linked worktree think it is bare, and every command
    // needing a working tree fails. Both halves are asserted because the
    // second one is the half that silently regresses.
    expect(
      (await git(['config', 'extensions.worktreeConfig'], { cwd: dir })).stdout,
    ).toBe('true');
    expect(
      await gitOk(['config', '--local', '--get', 'core.bare'], { cwd: dir }),
    ).toBe(false);
    expect(
      (await git(['rev-parse', '--is-bare-repository'], { cwd: dir })).stdout,
    ).toBe('true');
  });

  it('upgrades a clone made before per-worktree config was turned on', async () => {
    const { dir } = await ensureClone(ctx, entry());
    await git(['config', '--unset', 'extensions.worktreeConfig'], { cwd: dir });
    await git(['config', '--local', 'core.bare', 'true'], { cwd: dir });

    await ensureClone(ctx, entry());

    expect(
      (await git(['config', 'extensions.worktreeConfig'], { cwd: dir })).stdout,
    ).toBe('true');
    expect(
      await gitOk(['config', '--local', '--get', 'core.bare'], { cwd: dir }),
    ).toBe(false);
  });
});

describe('ensuring a clone that is already there', () => {
  it('fetches rather than re-cloning, and says so', async () => {
    await ensureClone(ctx, entry());
    await upstream.commitAndPush({ branch: 'ng-601-do-a-thing' });

    const outcome = await ensureClone(ctx, entry());

    expect(outcome.state).toBe('updated');
    expect(
      (await git(['rev-parse', 'refs/remotes/origin/ng-601-do-a-thing'], { cwd: outcome.dir })).stdout, // prettier-ignore
    ).toBe(await upstream.head('refs/heads/ng-601-do-a-thing'));
  });

  it('drops remote-tracking refs for branches the upstream deleted', async () => {
    const { dir } = await ensureClone(ctx, entry());
    await upstream.git('push', '--quiet', '--delete', 'origin', 'ng-601-do-a-thing'); // prettier-ignore

    await ensureClone(ctx, entry());

    expect(
      (await git(['for-each-ref', '--format=%(refname)', 'refs/remotes'], { cwd: dir })).stdout, // prettier-ignore
    ).not.toContain('ng-601-do-a-thing');
  });

  it('follows the url when a hand-edit repoints the entry', async () => {
    const { dir } = await ensureClone(ctx, entry());
    const moved = await createUpstream({ branches: ['ng-700-elsewhere'] });

    try {
      await ensureClone(ctx, entry({ url: moved.url }));

      expect((await git(['remote', 'get-url', 'origin'], { cwd: dir })).stdout).toBe(moved.url); // prettier-ignore
      expect(
        (await git(['for-each-ref', '--format=%(refname)', 'refs/remotes'], { cwd: dir })).stdout, // prettier-ignore
      ).toContain('ng-700-elsewhere');
    } finally {
      rmSync(moved.dir, { recursive: true, force: true });
      rmSync(moved.workingCopy, { recursive: true, force: true });
    }
  });
});

describe('a clone that cannot be made', () => {
  it('fails naming the url and the credentials it used, since Rocky mints none', async () => {
    const bad = entry({ url: join(makeTempDir('gone'), 'nope.git') });

    const error = await ensureClone(ctx, bad).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(CloneError);
    expect((error as CloneError).message).toContain(bad.url);
    expect((error as CloneError).message).toMatch(/ls-remote/);
  });

  it('leaves nothing behind, so `rocky repo add` writes no entry for it', async () => {
    // Eager cloning exists so a bad url fails at the terminal with a human
    // present (NG-521). A half-made clone would turn that into a Run failure
    // an hour later instead.
    const bad = entry({ url: join(makeTempDir('gone'), 'nope.git') });

    await expect(ensureClone(ctx, bad)).rejects.toThrow(CloneError);

    expect(existsSync(paths.repo('niotix'))).toBe(false);
  });

  it('keeps a clone that was already good when a later fetch fails', async () => {
    const { dir } = await ensureClone(ctx, entry());
    rmSync(upstream.dir, { recursive: true, force: true });

    await expect(ensureClone(ctx, entry())).rejects.toThrow(CloneError);

    // The prior art in the clone is the only copy of a parked Run's history.
    expect(existsSync(dir)).toBe(true);
  });

  it('refuses a file sitting where the clone belongs', async () => {
    writeFileSync(paths.repo('niotix'), 'not a directory');

    const error = await ensureClone(ctx, entry()).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(CloneError);
    expect((error as CloneError).message).toMatch(/not a directory/);
  });

  it('refuses a directory a human filled with something else', async () => {
    const occupied = paths.repo('niotix');
    mkdirSync(occupied, { recursive: true });
    writeFileSync(join(occupied, 'notes.txt'), 'mine');

    const error = await ensureClone(ctx, entry()).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(CloneError);
    expect((error as CloneError).message).toMatch(/not a git repository/i);
  });
});

describe('an upstream with nothing in it', () => {
  it('clones, but reports no default branch to guess a baseBranch from', async () => {
    const empty = await createUpstream();
    rmSync(empty.dir, { recursive: true, force: true });
    await git(['init', '--quiet', '--bare', empty.dir]);

    try {
      const outcome = await ensureClone(ctx, entry({ url: empty.url }));

      // `rocky repo add` turns this into "re-run with `--base-branch`" rather
      // than writing a guess into config.json.
      expect(outcome.state).toBe('created');
      expect(outcome.defaultBranch).toBeUndefined();
    } finally {
      rmSync(empty.dir, { recursive: true, force: true });
      rmSync(empty.workingCopy, { recursive: true, force: true });
    }
  });
});

describe('what `rocky status` reports', () => {
  it('lists every configured repo, cloned or not', async () => {
    await ensureClone(ctx, entry());

    const status = await cloneStatus(ctx, [
      entry(),
      entry({ name: 'niota-api', url: 'git@github.com:digimondo/niota-api.git' }), // prettier-ignore
    ]);

    expect(status).toMatchObject([
      { name: 'niotix', cloned: true, defaultBranch: 'main' },
      { name: 'niota-api', cloned: false },
    ]);
  });
});

describe('the per-repo mutex', () => {
  it('serializes fetches on one clone without blocking another repo', async () => {
    const other = await createUpstream();

    try {
      await Promise.all([
        ensureClone(ctx, entry()),
        ensureClone(ctx, entry({ name: 'niota-api', url: other.url })),
      ]);

      // Both clones exist, and neither `git init` raced the other's fetch.
      await Promise.all([
        ensureClone(ctx, entry()),
        ensureClone(ctx, entry()),
        ensureClone(ctx, entry({ name: 'niota-api', url: other.url })),
      ]);

      expect(existsSync(paths.repo('niotix'))).toBe(true);
      expect(existsSync(paths.repo('niota-api'))).toBe(true);
      expect(ctx.mutex.isHeld('niotix')).toBe(false);
    } finally {
      rmSync(other.dir, { recursive: true, force: true });
      rmSync(other.workingCopy, { recursive: true, force: true });
    }
  });
});
