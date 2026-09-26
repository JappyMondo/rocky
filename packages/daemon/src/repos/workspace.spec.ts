/**
 * One plain `git worktree add` per Run and member repo, at
 * `~/.rocky/runs/<runId>/workspace/<repoName>/` (NG-521, NG-578).
 *
 * Covers NG-521's first three acceptance criteria:
 *
 * 1. Two concurrent Runs on one repo get independent worktrees, and
 *    interleaved fetch / add / remove goes through the mutex without
 *    corruption.
 * 2. A grouped Run materialises every member under one `workspace/` with the
 *    lead identifiable.
 * 3. Commits made in a worktree carry the Rocky identity regardless of the
 *    machine's global git config.
 */
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'; // prettier-ignore
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'; // prettier-ignore

import { rockyPaths, type RockyPaths } from '../config/paths.js';
import { ensureInstanceLayout } from '../config/store.js';
import { ensureClone } from './clone.js';
import { git } from './git.js';
import { KeyedMutex } from './mutex.js';
import { createUpstream, makeTempDir, type Upstream } from './upstream.fixtures.js'; // prettier-ignore
import { WorkspaceError, createWorkspace, releaseCleanWorkspace, removeWorkspace } from './workspace.js'; // prettier-ignore
import type { RepoContext, RepoRef } from './context.js';

/** The Rocky identity these tests expect every commit to carry. */
const ROCKY = { name: 'Rocky', email: 'rocky@rocky.invalid' } as const;

/**
 * A hostile global git config: a `user.name` and `user.email` that must never
 * reach a commit Rocky's worktree makes. This is the whole of AC3 — the
 * machine's global config is the thing being beaten, so it has to be present
 * and wrong rather than absent.
 */
const HOSTILE = { name: 'Global Human', email: 'human@example.test' } as const;

const savedEnv = { ...process.env };
let globalConfigFile: string;

beforeAll(() => {
  globalConfigFile = join(makeTempDir('git-global'), 'gitconfig');
  writeFileSync(
    globalConfigFile,
    `[user]\n\tname = ${HOSTILE.name}\n\temail = ${HOSTILE.email}\n`,
  );
  process.env.GIT_CONFIG_GLOBAL = globalConfigFile;
  process.env.GIT_CONFIG_SYSTEM = '/dev/null';
});

afterAll(() => {
  process.env = savedEnv;
});

let home: string;
let paths: RockyPaths;
let ctx: RepoContext;
let upstream: Upstream;
let sibling: Upstream;
let niotix: RepoRef;
let niotaApi: RepoRef;

const BRANCH = 'ng-601-do-a-thing';

beforeEach(async () => {
  home = makeTempDir('home');
  paths = rockyPaths(home);
  await ensureInstanceLayout(paths);
  ctx = { paths, mutex: new KeyedMutex(), identity: { ...ROCKY } };

  upstream = await createUpstream({ branches: [BRANCH] });
  sibling = await createUpstream();
  niotix = { name: 'niotix', url: upstream.url, baseBranch: 'main' };
  niotaApi = { name: 'niota-api', url: sibling.url, baseBranch: 'main' };
});

afterEach(() => {
  for (const dir of [
    home,
    upstream.dir,
    upstream.workingCopy,
    sibling.dir,
    sibling.workingCopy,
  ]) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Commit inside a worktree the way an Agent's `bash` Capability would. */
async function commitInside(dir: string, message: string): Promise<string> {
  await writeFile(join(dir, `${message.replace(/\W+/g, '-')}.txt`), 'work\n');
  await git(['add', '--all'], { cwd: dir });
  await git(['commit', '--quiet', '--message', message], { cwd: dir });
  return (await git(['log', '-1', '--format=%an <%ae>'], { cwd: dir })).stdout;
}

describe('a plain Run', () => {
  it('refuses a Run with no member repos', async () => {
    await expect(
      createWorkspace(ctx, {
        runId: 'NG-601-1',
        branch: BRANCH,
        members: [],
        lead: 'niotix',
      }),
    ).rejects.toThrow(WorkspaceError);
  });

  it('is a workspace with one child', async () => {
    const workspace = await createWorkspace(ctx, {
      runId: 'NG-601-1',
      branch: BRANCH,
      members: [niotix],
      lead: 'niotix',
    });

    expect(workspace.dir).toBe(paths.run('NG-601-1').workspaceDir);
    expect(await readdir(workspace.dir)).toEqual(['niotix']);
    expect(workspace.members).toHaveLength(1);
    expect(workspace.lead.repo).toBe('niotix');
    expect(workspace.lead.dir).toBe(
      paths.run('NG-601-1').workspaceRepo('niotix'),
    );
  });

  it("is a real worktree of Rocky's own clone, not a second clone", async () => {
    const workspace = await createWorkspace(ctx, {
      runId: 'NG-601-1',
      branch: BRANCH,
      members: [niotix],
      lead: 'niotix',
    });

    // A worktree's `.git` is a file pointing into the shared clone. If this
    // were a clone of its own, the Run would fetch the world twice and the
    // per-repo mutex would be guarding nothing.
    const pointer = await readFile(join(workspace.lead.dir, '.git'), 'utf8');
    // `realpathSync` because git records the resolved path, and on macOS the
    // temp root is reached through the `/var` → `/private/var` symlink.
    expect(pointer.trim()).toBe(
      `gitdir: ${join(realpathSync(paths.repo('niotix')), 'worktrees', 'niotix')}`,
    );
  });

  it('clones the repo first, so a Run does not fail on a repo added by hand', async () => {
    expect(existsSync(paths.repo('niotix'))).toBe(false);

    await createWorkspace(ctx, {
      runId: 'NG-601-1',
      branch: BRANCH,
      members: [niotix],
      lead: 'niotix',
    });

    expect(existsSync(paths.repo('niotix'))).toBe(true);
  });
});

describe('a grouped Run (AC2)', () => {
  it('materialises every member side by side under one workspace', async () => {
    const workspace = await createWorkspace(ctx, {
      runId: 'NG-601-1',
      branch: BRANCH,
      members: [niotix, niotaApi],
      lead: 'niotix',
    });

    expect((await readdir(workspace.dir)).sort()).toEqual([
      'niota-api',
      'niotix',
    ]);
    for (const member of workspace.members) {
      expect(existsSync(join(member.dir, '.git'))).toBe(true);
    }
  });

  it('makes the lead identifiable, since only its .rocky/ is executed', async () => {
    const workspace = await createWorkspace(ctx, {
      runId: 'NG-601-1',
      branch: BRANCH,
      members: [niotix, niotaApi],
      lead: 'niota-api',
    });

    expect(workspace.lead.repo).toBe('niota-api');
    expect(workspace.lead.lead).toBe(true);
    expect(workspace.members.filter((member) => member.lead)).toHaveLength(1);
  });

  it('names all of the same Linear branch across the members', async () => {
    const workspace = await createWorkspace(ctx, {
      runId: 'NG-601-1',
      branch: BRANCH,
      members: [niotix, niotaApi],
      lead: 'niotix',
    });

    for (const member of workspace.members) {
      expect(member.branch).toBe(BRANCH);
      expect(
        (await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: member.dir }))
          .stdout,
      ).toBe(BRANCH);
    }
  });

  it('refuses a lead that is not one of the members', async () => {
    await expect(
      createWorkspace(ctx, {
        runId: 'NG-601-1',
        branch: BRANCH,
        members: [niotix],
        lead: 'niota-api',
      }),
    ).rejects.toThrow(WorkspaceError);
  });
});

describe("adopting the issue's branch (NG-580)", () => {
  it('takes a branch the upstream already has, at its tip', async () => {
    const priorArt = await upstream.head(`refs/heads/${BRANCH}`);

    const workspace = await createWorkspace(ctx, {
      runId: 'NG-601-1',
      branch: BRANCH,
      members: [niotix],
      lead: 'niotix',
    });

    // Whatever a prior Run or a human left is prior art, never reset.
    expect(workspace.lead.head).toBe(priorArt);
    expect(workspace.lead.adopted).toBe('remote-branch');
  });

  it('starts a branch the upstream has never seen from the base branch', async () => {
    const workspace = await createWorkspace(ctx, {
      runId: 'NG-999-1',
      branch: 'ng-999-brand-new',
      members: [niotix],
      lead: 'niotix',
    });

    expect(workspace.lead.head).toBe(await upstream.head('refs/heads/main'));
    expect(workspace.lead.adopted).toBe('new-from-base');
  });

  it('takes a local branch an earlier Run left behind, without resetting it', async () => {
    const first = await createWorkspace(ctx, {
      runId: 'NG-601-1',
      branch: BRANCH,
      members: [niotix],
      lead: 'niotix',
    });
    await commitInside(first.lead.dir, 'unpushed work');
    const unpushed = (await git(['rev-parse', 'HEAD'], { cwd: first.lead.dir }))
      .stdout;
    await removeWorkspace(ctx, 'NG-601-1');

    const second = await createWorkspace(ctx, {
      runId: 'NG-601-2',
      branch: BRANCH,
      members: [niotix],
      lead: 'niotix',
    });

    // Run #2 on a re-delegated issue continues on top of whatever Run #1 left
    // there. `git reset --hard` here would throw away real work.
    expect(second.lead.head).toBe(unpushed);
    expect(second.lead.adopted).toBe('existing-local');
  });

  it('says what is missing when neither the branch nor the base branch exists', async () => {
    const error = await createWorkspace(ctx, {
      runId: 'NG-601-1',
      branch: 'ng-601-x',
      members: [{ ...niotix, baseBranch: 'trunk' }],
      lead: 'niotix',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WorkspaceError);
    expect((error as WorkspaceError).message).toContain('trunk');
    expect((error as WorkspaceError).message).toContain('baseBranch');
  });

  it('quotes git when the worktree cannot be made for some other reason', async () => {
    const dir = paths.run('NG-601-1').workspaceRepo('niotix');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'squatting.txt'), 'not a worktree');

    const error = await createWorkspace(ctx, {
      runId: 'NG-601-1',
      branch: BRANCH,
      members: [niotix],
      lead: 'niotix',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WorkspaceError);
    expect((error as WorkspaceError).message).toContain(dir);
    expect((error as WorkspaceError).message).toMatch(/git said/);
  });

  it('names the other worktree when a branch is already checked out', async () => {
    await createWorkspace(ctx, {
      runId: 'NG-601-1',
      branch: BRANCH,
      members: [niotix],
      lead: 'niotix',
    });

    // At most one non-terminal Run per issue makes this unreachable in
    // practice, so when it does happen the message has to point at the
    // directory rather than leaving git's raw refusal in a log.
    const error = await createWorkspace(ctx, {
      runId: 'NG-601-2',
      branch: BRANCH,
      members: [niotix],
      lead: 'niotix',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WorkspaceError);
    expect((error as WorkspaceError).message).toContain('NG-601-1');
  });
});

describe('adopting retained terminal worktrees', () => {
  it.each(['C', 'de_DE.UTF-8'])(
    'moves prior work intact without parsing localized errors (%s)',
    async (locale) => {
      ctx.env = { LANG: locale, LC_ALL: locale };
      const first = await createWorkspace(ctx, {
        runId: 'NG-601-1',
        branch: BRANCH,
        members: [niotix],
        lead: 'niotix',
      });
      await commitInside(first.lead.dir, 'Unpushed prior work');
      const head = (await git(['rev-parse', 'HEAD'], { cwd: first.lead.dir }))
        .stdout;
      await writeFile(join(first.lead.dir, '.gitignore'), 'local-cache/\n');
      await git(['add', '.gitignore'], { cwd: first.lead.dir });
      await writeFile(join(first.lead.dir, 'unfinished.txt'), 'keep this edit');
      mkdirSync(join(first.lead.dir, 'local-cache'));
      await writeFile(
        join(first.lead.dir, 'local-cache', 'fixture'),
        'keep ignored state',
      );
      const status = (
        await git(['status', '--porcelain'], { cwd: first.lead.dir })
      ).stdout;
      for (const [runId, state] of [
        ['NG-601-1', 'failed'],
        ['NG-601-2', 'running'],
      ]) {
        mkdirSync(paths.run(runId).dir, { recursive: true });
        await writeFile(
          paths.run(runId).runJson,
          JSON.stringify({
            runId,
            branch: BRANCH,
            status: state,
            issue: { identifier: 'NG-601' },
          }),
        );
      }
      const next = await createWorkspace(ctx, {
        runId: 'NG-601-2',
        branch: BRANCH,
        members: [niotix],
        lead: 'niotix',
      });
      expect(next.lead.head).toBe(head);
      expect(next.lead.adopted).toBe('existing-local');
      expect(
        (await git(['status', '--porcelain'], { cwd: next.lead.dir })).stdout,
      ).toBe(status);
      expect(
        await readFile(join(next.lead.dir, 'unfinished.txt'), 'utf8'),
      ).toBe('keep this edit');
      expect(
        await readFile(join(next.lead.dir, 'local-cache', 'fixture'), 'utf8'),
      ).toBe('keep ignored state');
      expect(existsSync(first.lead.dir)).toBe(false);
      expect(
        (
          await createWorkspace(ctx, {
            runId: 'NG-601-2',
            branch: BRANCH,
            members: [niotix],
            lead: 'niotix',
          })
        ).lead.adopted,
      ).toBe('already-there');
    },
  );

  it.each(['running', 'other-issue'])(
    'refuses transfer from an unsafe owner (%s)',
    async (owner) => {
      const first = await createWorkspace(ctx, {
        runId: 'NG-601-1',
        branch: BRANCH,
        members: [niotix],
        lead: 'niotix',
      });
      for (const runId of ['NG-601-1', 'NG-601-2']) {
        mkdirSync(paths.run(runId).dir, { recursive: true });
        await writeFile(
          paths.run(runId).runJson,
          JSON.stringify({
            runId,
            branch: BRANCH,
            status:
              runId.endsWith('-1') && owner === 'running'
                ? 'running'
                : 'failed',
            issue: {
              identifier:
                runId.endsWith('-1') && owner === 'other-issue'
                  ? 'NG-999'
                  : 'NG-601',
            },
          }),
        );
      }
      await expect(
        createWorkspace(ctx, {
          runId: 'NG-601-2',
          branch: BRANCH,
          members: [niotix],
          lead: 'niotix',
        }),
      ).rejects.toThrow('NG-601-1');
      expect(existsSync(first.lead.dir)).toBe(true);
    },
  );
});

it('refuses to adopt a partial workspace switched to another branch', async () => {
  const first = await createWorkspace(ctx, {
    runId: 'NG-601-1',
    branch: BRANCH,
    members: [niotix],
    lead: 'niotix',
  });
  await git(['checkout', '-b', 'unrelated-work'], { cwd: first.lead.dir });
  await writeFile(join(first.lead.dir, 'preserve.txt'), 'human edit');
  await expect(
    createWorkspace(ctx, {
      runId: 'NG-601-1',
      branch: BRANCH,
      members: [niotix],
      lead: 'niotix',
    }),
  ).rejects.toThrow('different branch');
  expect(await readFile(join(first.lead.dir, 'preserve.txt'), 'utf8')).toBe(
    'human edit',
  );
});

describe('the Rocky identity in a worktree (AC3)', () => {
  it('authors a commit as Rocky even though the global config says otherwise', async () => {
    const workspace = await createWorkspace(ctx, {
      runId: 'NG-601-1',
      branch: BRANCH,
      members: [niotix],
      lead: 'niotix',
    });

    const author = await commitInside(workspace.lead.dir, 'implementer work');

    expect(author).toBe(`${ROCKY.name} <${ROCKY.email}>`);
    expect(author).not.toContain(HOSTILE.email);
  });

  it('is genuinely worktree-local rather than shared across the clone', async () => {
    const workspace = await createWorkspace(ctx, {
      runId: 'NG-601-1',
      branch: BRANCH,
      members: [niotix],
      lead: 'niotix',
    });

    expect(
      (
        await git(['config', '--worktree', '--get', 'user.email'], {
          cwd: workspace.lead.dir,
        })
      ).stdout,
    ).toBe(ROCKY.email);
  });

  it('gives every member of a grouped Run the identity, not just the lead', async () => {
    const workspace = await createWorkspace(ctx, {
      runId: 'NG-601-1',
      branch: BRANCH,
      members: [niotix, niotaApi],
      lead: 'niotix',
    });

    for (const member of workspace.members) {
      expect(await commitInside(member.dir, `work in ${member.repo}`)).toBe(
        `${ROCKY.name} <${ROCKY.email}>`,
      );
    }
  });

  it('re-asserts the identity on a worktree it adopts, so a hand-edit cannot stick', async () => {
    const workspace = await createWorkspace(ctx, {
      runId: 'NG-601-1',
      branch: BRANCH,
      members: [niotix],
      lead: 'niotix',
    });
    await git(
      ['config', '--worktree', 'user.email', 'someone-else@example.test'],
      { cwd: workspace.lead.dir },
    );

    await createWorkspace(ctx, {
      runId: 'NG-601-1',
      branch: BRANCH,
      members: [niotix],
      lead: 'niotix',
    });

    expect(await commitInside(workspace.lead.dir, 'after')).toBe(
      `${ROCKY.name} <${ROCKY.email}>`,
    );
  });
});

describe('two concurrent Runs on one repo (AC1)', () => {
  it('get independent worktrees', async () => {
    const [first, second] = await Promise.all([
      createWorkspace(ctx, {
        runId: 'NG-601-1',
        branch: BRANCH,
        members: [niotix],
        lead: 'niotix',
      }),
      createWorkspace(ctx, {
        runId: 'NG-602-1',
        branch: 'ng-602-something-else',
        members: [niotix],
        lead: 'niotix',
      }),
    ]);

    expect(first.lead.dir).not.toBe(second.lead.dir);
    await commitInside(first.lead.dir, 'first run work');

    // Independent means the other Run does not see it — the failure mode
    // ADR 0001 escaped was a library that deleted a sibling worktree outright.
    expect(existsSync(second.lead.dir)).toBe(true);
    expect(
      (await git(['status', '--porcelain'], { cwd: second.lead.dir })).stdout,
    ).toBe('');
    expect(
      (await git(['rev-parse', 'HEAD'], { cwd: first.lead.dir })).stdout,
    ).not.toBe(
      (await git(['rev-parse', 'HEAD'], { cwd: second.lead.dir })).stdout,
    );
  });

  it('takes the per-repo mutex for the worktree add', async () => {
    await ensureClone(ctx, niotix);
    const release = await ctx.mutex.acquire('niotix');
    const dir = paths.run('NG-601-1').workspaceRepo('niotix');

    const pending = createWorkspace(ctx, {
      runId: 'NG-601-1',
      branch: BRANCH,
      members: [niotix],
      lead: 'niotix',
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(existsSync(join(dir, '.git'))).toBe(false);

    release();
    await pending;
    expect(existsSync(join(dir, '.git'))).toBe(true);
  });

  it('survives interleaved fetch, add and remove without corrupting the clone', async () => {
    const runs = ['NG-701-1', 'NG-702-1', 'NG-703-1', 'NG-704-1'];
    await ensureClone(ctx, niotix);

    // Fetches, adds and removes all racing on one clone. Every one of them
    // touches `repos/niotix`, which is exactly the set NG-578 says the mutex
    // serializes.
    await Promise.all([
      ...runs.map((runId) =>
        createWorkspace(ctx, {
          runId,
          branch: `${runId.toLowerCase()}-work`,
          members: [niotix],
          lead: 'niotix',
        }),
      ),
      ensureClone(ctx, niotix),
      ensureClone(ctx, niotix),
    ]);

    await Promise.all([
      removeWorkspace(ctx, runs[0]),
      removeWorkspace(ctx, runs[1]),
      ensureClone(ctx, niotix),
    ]);

    const listed = (
      await git(['worktree', 'list', '--porcelain'], {
        cwd: paths.repo('niotix'),
      })
    ).stdout;

    for (const runId of runs.slice(2)) {
      expect(listed).toContain(paths.run(runId).workspaceRepo('niotix'));
      expect(existsSync(paths.run(runId).workspaceRepo('niotix'))).toBe(true);
    }
    for (const runId of runs.slice(0, 2)) {
      expect(listed).not.toContain(paths.run(runId).workspaceRepo('niotix'));
      expect(existsSync(paths.run(runId).workspaceDir)).toBe(false);
    }

    // `worktree list` reporting a prunable entry is what corruption looks
    // like here: metadata pointing at a directory that is not there.
    expect(listed).not.toContain('prunable');
    expect(ctx.mutex.isHeld('niotix')).toBe(false);
  });

  it("lets a grouped Run take each member's mutex without deadlocking", async () => {
    const held = await ctx.mutex.acquire('niota-api');

    const pending = createWorkspace(ctx, {
      runId: 'NG-601-1',
      branch: BRANCH,
      members: [niotix, niotaApi],
      lead: 'niotix',
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    held();

    const workspace = await pending;
    expect(workspace.members.map((member) => member.repo).sort()).toEqual([
      'niota-api',
      'niotix',
    ]);
  });
});

describe('being asked twice for the same Run', () => {
  it('finds the worktree it already made, since every Step is at-least-once', async () => {
    const first = await createWorkspace(ctx, {
      runId: 'NG-601-1',
      branch: BRANCH,
      members: [niotix],
      lead: 'niotix',
    });
    await commitInside(first.lead.dir, 'work from before the crash');
    const head = (await git(['rev-parse', 'HEAD'], { cwd: first.lead.dir }))
      .stdout;

    const second = await createWorkspace(ctx, {
      runId: 'NG-601-1',
      branch: BRANCH,
      members: [niotix],
      lead: 'niotix',
    });

    // NG-574 §6: the worktree is re-used exactly as found. Not discarded —
    // `git reset --hard` throws away real work whose only sin is an
    // unrecorded result.
    expect(second.lead.dir).toBe(first.lead.dir);
    expect(second.lead.head).toBe(head);
    expect(second.lead.adopted).toBe('already-there');
  });

  it('keeps uncommitted work in an adopted worktree', async () => {
    const first = await createWorkspace(ctx, {
      runId: 'NG-601-1',
      branch: BRANCH,
      members: [niotix],
      lead: 'niotix',
    });
    await writeFile(join(first.lead.dir, 'half-done.txt'), 'mid-edit\n');

    await createWorkspace(ctx, {
      runId: 'NG-601-1',
      branch: BRANCH,
      members: [niotix],
      lead: 'niotix',
    });

    expect(existsSync(join(first.lead.dir, 'half-done.txt'))).toBe(true);
  });

  it('adds a member that was missing, so a group that grew still materialises', async () => {
    await createWorkspace(ctx, {
      runId: 'NG-601-1',
      branch: BRANCH,
      members: [niotix],
      lead: 'niotix',
    });

    const grown = await createWorkspace(ctx, {
      runId: 'NG-601-1',
      branch: BRANCH,
      members: [niotix, niotaApi],
      lead: 'niotix',
    });

    expect(grown.members).toHaveLength(2);
    expect((await readdir(grown.dir)).sort()).toEqual(['niota-api', 'niotix']);
  });
});

describe('removing a workspace', () => {
  it('takes the worktrees and the workspace folder, and nothing else', async () => {
    const workspace = await createWorkspace(ctx, {
      runId: 'NG-601-1',
      branch: BRANCH,
      members: [niotix, niotaApi],
      lead: 'niotix',
    });
    const run = paths.run('NG-601-1');
    mkdirSync(run.snapshotDir, { recursive: true });
    writeFileSync(run.journal, '{"seq":0}\n');

    const removed = await removeWorkspace(ctx, 'NG-601-1');

    expect(removed.sort()).toEqual(['niota-api', 'niotix']);
    expect(existsSync(workspace.dir)).toBe(false);
    // Retention owns the journal and the snapshot (NG-574 §10), not the sweep.
    expect(existsSync(run.journal)).toBe(true);
    expect(existsSync(run.snapshotDir)).toBe(true);
  });

  it('leaves the clone with no stale worktree metadata behind', async () => {
    await createWorkspace(ctx, {
      runId: 'NG-601-1',
      branch: BRANCH,
      members: [niotix],
      lead: 'niotix',
    });

    await removeWorkspace(ctx, 'NG-601-1');

    const listed = (
      await git(['worktree', 'list', '--porcelain'], {
        cwd: paths.repo('niotix'),
      })
    ).stdout;
    expect(listed).not.toContain('NG-601-1');
  });

  it('keeps the branch, because Rocky never destroys work', async () => {
    const workspace = await createWorkspace(ctx, {
      runId: 'NG-601-1',
      branch: BRANCH,
      members: [niotix],
      lead: 'niotix',
    });
    await commitInside(workspace.lead.dir, 'work worth keeping');
    const head = (await git(['rev-parse', 'HEAD'], { cwd: workspace.lead.dir }))
      .stdout;

    await removeWorkspace(ctx, 'NG-601-1');

    expect(
      (
        await git(['rev-parse', `refs/heads/${BRANCH}`], {
          cwd: paths.repo('niotix'),
        })
      ).stdout,
    ).toBe(head);
  });

  it('removes a dirty worktree, since removal only happens at a terminal state', async () => {
    const workspace = await createWorkspace(ctx, {
      runId: 'NG-601-1',
      branch: BRANCH,
      members: [niotix],
      lead: 'niotix',
    });
    await writeFile(join(workspace.lead.dir, 'scratch.txt'), 'uncommitted\n');

    await removeWorkspace(ctx, 'NG-601-1');

    expect(existsSync(workspace.dir)).toBe(false);
  });

  it('copes with a member a human already deleted by hand', async () => {
    const workspace = await createWorkspace(ctx, {
      runId: 'NG-601-1',
      branch: BRANCH,
      members: [niotix, niotaApi],
      lead: 'niotix',
    });
    rmSync(join(workspace.dir, 'niotix'), { recursive: true, force: true });

    // Only what was actually there is reported. Reclaiming the clone metadata
    // the vanished directory left behind is `git worktree prune`'s job, which
    // is why NG-578 makes it a step of the sweep in its own right.
    await expect(removeWorkspace(ctx, 'NG-601-1')).resolves.toEqual([
      'niota-api',
    ]);

    expect(existsSync(workspace.dir)).toBe(false);
    expect(
      (
        await git(['worktree', 'list', '--porcelain'], {
          cwd: paths.repo('niota-api'),
        })
      ).stdout,
    ).not.toContain('NG-601-1');
  });

  it('says nothing happened for a Run with no workspace', async () => {
    await expect(removeWorkspace(ctx, 'NG-999-1')).resolves.toEqual([]);
  });

  it('reports rather than swallowing a workspace it cannot even read', async () => {
    const run = paths.run('NG-603-1');
    mkdirSync(run.dir, { recursive: true });
    writeFileSync(run.workspaceDir, 'not a directory');

    // A missing workspace is normal and answers with `[]`; one that is there
    // and unreadable is not, and the sweep turns this into a recorded failure.
    await expect(removeWorkspace(ctx, 'NG-603-1')).rejects.toThrow();
  });
});

describe('releasing a clean terminal workspace', () => {
  it('releases a clean workspace but preserves a dirty one for adoption', async () => {
    const clean = await createWorkspace(ctx, {
      runId: 'NG-601-1',
      branch: BRANCH,
      members: [niotix],
      lead: 'niotix',
    });
    await expect(releaseCleanWorkspace(ctx, 'NG-601-1')).resolves.toEqual([
      'niotix',
    ]);
    expect(existsSync(clean.dir)).toBe(false);

    const dirty = await createWorkspace(ctx, {
      runId: 'NG-601-2',
      branch: BRANCH,
      members: [niotix],
      lead: 'niotix',
    });
    await writeFile(join(dirty.lead.dir, 'unfinished.txt'), 'preserve me\n');
    await expect(releaseCleanWorkspace(ctx, 'NG-601-2')).resolves.toEqual([]);
    expect(existsSync(dirty.dir)).toBe(true);
  });
});

it('restores unchanged released worktrees for retry and preserves edits in retained worktrees', async () => {
  const { restoreRetryWorkspace } = await import('./workspace.js');
  const workspace = await createWorkspace(ctx, {
    runId: 'NG-601-1',
    branch: BRANCH,
    members: [niotix],
    lead: 'niotix',
  });
  const options = {
    runId: workspace.runId,
    branch: BRANCH,
    members: [{ name: 'niotix', head: workspace.lead.head }],
  };
  await releaseCleanWorkspace(ctx, workspace.runId);
  await restoreRetryWorkspace(ctx, options);
  expect(
    (await git(['rev-parse', 'HEAD'], { cwd: workspace.lead.dir })).stdout,
  ).toBe(workspace.lead.head);
  await writeFile(join(workspace.lead.dir, 'unfinished.txt'), 'keep this');
  await restoreRetryWorkspace(ctx, options);
  expect(
    await readFile(join(workspace.lead.dir, 'unfinished.txt'), 'utf8'),
  ).toBe('keep this');
  await git(['checkout', '-b', 'other-branch'], { cwd: workspace.lead.dir });
  await expect(restoreRetryWorkspace(ctx, options)).rejects.toThrow(
    /different branch/,
  );
});
it('refuses to restore a released workspace when its branch has moved', async () => {
  const { restoreRetryWorkspace } = await import('./workspace.js');
  const workspace = await createWorkspace(ctx, {
    runId: 'NG-601-1',
    branch: BRANCH,
    members: [niotix],
    lead: 'niotix',
  });
  await commitInside(workspace.lead.dir, 'later work');
  await releaseCleanWorkspace(ctx, workspace.runId);
  await expect(
    restoreRetryWorkspace(ctx, {
      runId: workspace.runId,
      branch: BRANCH,
      members: [{ name: 'niotix', head: workspace.lead.head }],
    }),
  ).rejects.toThrow(/branch has changed/);
});

it('restores an exhausted run at its retained branch tips, including changes in secondary repositories', async () => {
  const { restoreRetryWorkspace } = await import('./workspace.js');
  const workspace = await createWorkspace(ctx, {
    runId: 'NG-601-1',
    branch: BRANCH,
    members: [niotix, niotaApi],
    lead: 'niotix',
  });
  const tips = new Map<string, string>();
  for (const member of workspace.members) {
    await commitInside(member.dir, 'run implementation');
    tips.set(
      member.repo,
      (await git(['rev-parse', 'HEAD'], { cwd: member.dir })).stdout,
    );
  }
  await releaseCleanWorkspace(ctx, workspace.runId);
  const options = {
    runId: workspace.runId,
    branch: BRANCH,
    members: workspace.members.map((member) => ({
      name: member.repo,
      head: member.head,
    })),
    allowBranchAdvance: true,
  };
  await restoreRetryWorkspace(ctx, options);
  for (const member of workspace.members) {
    expect((await git(['rev-parse', 'HEAD'], { cwd: member.dir })).stdout).toBe(
      tips.get(member.repo),
    );
    expect(
      await readFile(join(member.dir, 'run-implementation.txt'), 'utf8'),
    ).toBe('work\n');
  }
});

it('does not treat an unrelated replacement branch as an exhaustion continuation', async () => {
  const { restoreRetryWorkspace } = await import('./workspace.js');
  const workspace = await createWorkspace(ctx, {
    runId: 'NG-601-1',
    branch: BRANCH,
    members: [niotix],
    lead: 'niotix',
  });
  await releaseCleanWorkspace(ctx, workspace.runId);
  const clone = paths.repo('niotix');
  const tree = (await git(['rev-parse', `${BRANCH}^{tree}`], { cwd: clone }))
    .stdout;
  const replacement = (
    await git(
      [
        '-c',
        'commit.gpgsign=false',
        'commit-tree',
        tree,
        '-m',
        'unrelated history',
      ],
      { cwd: clone },
    )
  ).stdout;
  await git(['update-ref', `refs/heads/${BRANCH}`, replacement], {
    cwd: clone,
  });
  await expect(
    restoreRetryWorkspace(ctx, {
      runId: workspace.runId,
      branch: BRANCH,
      allowBranchAdvance: true,
      members: [{ name: 'niotix', head: workspace.lead.head }],
    }),
  ).rejects.toThrow(/branch has changed/);
});

it('releases only published clean worktrees and preserves root evidence while reclaiming cache', async () => {
  const workspace = await createWorkspace(ctx, {
    runId: 'NG-601-1',
    branch: BRANCH,
    members: [niotix],
    lead: 'niotix',
  });
  await commitInside(workspace.lead.dir, 'unpublished');
  const store = join(workspace.dir, '.pnpm-store', 'v10');
  mkdirSync(store, { recursive: true });
  await writeFile(join(store, 'cached-package'), 'derived');
  await writeFile(join(workspace.dir, 'evidence.png'), 'keep');
  await expect(
    releaseCleanWorkspace(ctx, workspace.runId, { requirePublished: true }),
  ).resolves.toEqual([]);
  expect(existsSync(workspace.lead.dir)).toBe(true);
  expect(existsSync(store)).toBe(true);
  await git(['push', 'origin', BRANCH], { cwd: workspace.lead.dir });
  await expect(
    releaseCleanWorkspace(ctx, workspace.runId, { requirePublished: true }),
  ).resolves.toEqual(['niotix']);
  expect(existsSync(workspace.lead.dir)).toBe(false);
  expect(existsSync(store)).toBe(false);
  expect(await readFile(join(workspace.dir, 'evidence.png'), 'utf8')).toBe(
    'keep',
  );
});

it('reclaims orphaned package caches without deleting unknown directories', async () => {
  const dir = paths.run('NG-601-1').workspaceDir;
  mkdirSync(join(dir, '.pnpm-store', 'v10'), { recursive: true });
  mkdirSync(join(dir, 'unknown'), { recursive: true });
  await releaseCleanWorkspace(ctx, 'NG-601-1', { cachesOnly: true });
  expect(existsSync(join(dir, '.pnpm-store'))).toBe(true);
  rmSync(join(dir, 'unknown'), { recursive: true });
  await releaseCleanWorkspace(ctx, 'NG-601-1', { cachesOnly: true });
  expect(existsSync(dir)).toBe(false);
});
