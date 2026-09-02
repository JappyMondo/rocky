/**
 * The sweep (NG-521's fifth acceptance criterion, from NG-574 §10 and
 * NG-578).
 *
 * "`git worktree prune` in every clone, then delete `workspace/` children of
 * terminal Runs" — and, above all, **every non-terminal Run is kept forever.
 * No timer ever deletes something still parked.** A parked Run's worktree
 * holds an implementer's uncommitted edits and is the whole reason ADR 0001
 * refused Sandcastle's `pruneStale()`, which deletes worktrees recursively
 * across siblings.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'; // prettier-ignore

import { rockyPaths, type RockyPaths } from '../config/paths.js';
import { ensureInstanceLayout } from '../config/store.js';
import { git } from './git.js';
import { KeyedMutex } from './mutex.js';
import { sweep } from './sweep.js';
import { createUpstream, makeTempDir, type Upstream } from './upstream.fixtures.js'; // prettier-ignore
import { createWorkspace } from './workspace.js';
import type { RepoContext, RepoRef } from './context.js';

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
let sibling: Upstream;
let niotix: RepoRef;
let niotaApi: RepoRef;

const IDENTITY = { name: 'Rocky', email: 'rocky@rocky.invalid' } as const;

beforeEach(async () => {
  home = makeTempDir('home');
  paths = rockyPaths(home);
  await ensureInstanceLayout(paths);
  ctx = { paths, mutex: new KeyedMutex(), identity: { ...IDENTITY } };

  upstream = await createUpstream();
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

/**
 * A Run with a workspace and the durable files the sweep must not touch.
 * `members` defaults to the single-repo shape.
 */
async function makeRun(runId: string, members: RepoRef[] = [niotix]) {
  const workspace = await createWorkspace(ctx, {
    runId,
    branch: `${runId.toLowerCase()}-work`,
    members,
    lead: members[0].name,
  });

  const run = paths.run(runId);
  mkdirSync(run.snapshotDir, { recursive: true });
  mkdirSync(run.sessionsDir, { recursive: true });
  writeFileSync(run.journal, `{"seq":0,"step":"$start","runId":"${runId}"}\n`);
  writeFileSync(run.runJson, `{"id":"${runId}"}\n`);

  return workspace;
}

/**
 * A fresh context over the same `~/.rocky`, which is what the daemon has after
 * a restart: new mutex, new everything in memory, the same disk.
 */
function afterRestart(): RepoContext {
  return {
    paths: rockyPaths(home),
    mutex: new KeyedMutex(),
    identity: { ...IDENTITY },
  };
}

describe('a parked Run (AC5)', () => {
  it('keeps its worktree across a daemon restart and a sweep', async () => {
    const parked = await makeRun('NG-601-1');
    await writeFile(join(parked.lead.dir, 'in-progress.txt'), 'mid-edit\n');

    const report = await sweep(afterRestart(), { liveRunIds: ['NG-601-1'] });

    expect(report.removed).toEqual([]);
    expect(existsSync(parked.lead.dir)).toBe(true);
    expect(await readFile(join(parked.lead.dir, 'in-progress.txt'), 'utf8')).toBe('mid-edit\n'); // prettier-ignore
  });

  it('has a worktree that still works after the restart', async () => {
    const parked = await makeRun('NG-601-1');

    const restarted = afterRestart();
    await sweep(restarted, { liveRunIds: ['NG-601-1'] });

    // The point of a plain `git worktree add` is that nothing in the daemon's
    // memory is load-bearing: the directory and the clone are the whole state.
    await writeFile(join(parked.lead.dir, 'after-reboot.txt'), 'more work\n');
    await git(['add', '--all'], { cwd: parked.lead.dir });
    await git(['commit', '--quiet', '--message', 'work after a reboot'], {
      cwd: parked.lead.dir,
    });

    expect(
      (await git(['log', '-1', '--format=%an <%ae>'], { cwd: parked.lead.dir }))
        .stdout,
    ).toBe(`${IDENTITY.name} <${IDENTITY.email}>`);
  });

  it('is kept even when every other Run on the repo is terminal', async () => {
    const parked = await makeRun('NG-601-1');
    const done = await makeRun('NG-602-1');

    await sweep(ctx, { liveRunIds: ['NG-601-1'] });

    // Sandcastle's `pruneStale()` deleted worktrees recursively across
    // siblings, which is the exact failure this asserts the absence of.
    expect(existsSync(parked.lead.dir)).toBe(true);
    expect(existsSync(done.lead.dir)).toBe(false);
  });
});

describe('a terminal Run (AC5)', () => {
  it('loses its workspace', async () => {
    const done = await makeRun('NG-602-1');

    const report = await sweep(ctx, { liveRunIds: [] });

    expect(report.removed).toEqual([{ runId: 'NG-602-1', repos: ['niotix'] }]);
    expect(existsSync(done.dir)).toBe(false);
  });

  it("keeps its journal, header and snapshot, which are retention's not the sweep's", async () => {
    await makeRun('NG-602-1');
    const run = paths.run('NG-602-1');

    await sweep(ctx, { liveRunIds: [] });

    for (const kept of [
      run.journal,
      run.runJson,
      run.snapshotDir,
      run.sessionsDir,
    ]) {
      // prettier-ignore
      expect(existsSync(kept)).toBe(true);
    }
    expect(existsSync(run.dir)).toBe(true);
  });

  it('keeps the branch and its commits in the clone', async () => {
    const done = await makeRun('NG-602-1');
    await writeFile(join(done.lead.dir, 'work.txt'), 'real work\n');
    await git(['add', '--all'], { cwd: done.lead.dir });
    await git(['commit', '--quiet', '--message', 'work'], {
      cwd: done.lead.dir,
    });
    const head = (await git(['rev-parse', 'HEAD'], { cwd: done.lead.dir }))
      .stdout;

    await sweep(ctx, { liveRunIds: [] });

    // NG-574: Rocky never destroys work, only its own scaffolding.
    expect(
      (
        await git(['rev-parse', 'refs/heads/ng-602-1-work'], {
          cwd: paths.repo('niotix'),
        })
      ).stdout,
    ).toBe(head);
  });

  it('takes every member of a grouped Run', async () => {
    const done = await makeRun('NG-602-1', [niotix, niotaApi]);

    const report = await sweep(ctx, { liveRunIds: [] });

    expect(report.removed).toEqual([
      { runId: 'NG-602-1', repos: ['niota-api', 'niotix'] },
    ]);
    expect(existsSync(done.dir)).toBe(false);
  });

  it('is a no-op the second time round', async () => {
    await makeRun('NG-602-1');

    await sweep(ctx, { liveRunIds: [] });
    const second = await sweep(ctx, { liveRunIds: [] });

    expect(second.removed).toEqual([]);
    expect(second.failures).toEqual([]);
  });
});

describe('pruning every clone', () => {
  it('reclaims metadata a hand-deleted worktree left behind', async () => {
    const parked = await makeRun('NG-601-1');
    rmSync(parked.lead.dir, { recursive: true, force: true });

    const report = await sweep(ctx, { liveRunIds: ['NG-601-1'] });

    expect(report.pruned).toEqual(['niotix']);
    expect(
      (
        await git(['worktree', 'list', '--porcelain'], {
          cwd: paths.repo('niotix'),
        })
      ).stdout,
    ).not.toContain('NG-601-1');
  });

  it('prunes clones with no worktrees at all without complaining', async () => {
    await makeRun('NG-601-1', [niotix, niotaApi]);

    const report = await sweep(ctx, { liveRunIds: ['NG-601-1'] });

    expect(report.pruned.sort()).toEqual(['niota-api', 'niotix']);
    expect(report.failures).toEqual([]);
  });

  it('ignores a stray file in repos/ rather than treating it as a clone', async () => {
    await makeRun('NG-601-1');
    writeFileSync(join(paths.reposDir, '.DS_Store'), '');

    const report = await sweep(ctx, { liveRunIds: ['NG-601-1'] });

    expect(report.pruned).toEqual(['niotix']);
    expect(report.failures).toEqual([]);
  });

  it('skips a directory in repos/ that is not a clone', async () => {
    await makeRun('NG-601-1');
    // A half-made clone whose fetch died before `git init` — or simply a
    // directory a human put there. `git worktree prune` in it would fail.
    mkdirSync(join(paths.reposDir, 'scratch'), { recursive: true });

    const report = await sweep(ctx, { liveRunIds: ['NG-601-1'] });

    expect(report.pruned).toEqual(['niotix']);
    expect(report.failures).toEqual([]);
  });
});

describe('a sweep it cannot finish', () => {
  it('records the failure and keeps going with the other Runs', async () => {
    await makeRun('NG-602-1');
    const broken = paths.run('NG-603-1');
    mkdirSync(broken.dir, { recursive: true });
    // A file where the workspace directory should be. Contrived, but the
    // point is general: one unreclaimable Run must not cost the others their
    // disk back, because the sweep is the only thing that hands it over.
    writeFileSync(broken.workspaceDir, 'not a directory');

    const report = await sweep(ctx, { liveRunIds: [] });

    expect(report.removed).toEqual([{ runId: 'NG-602-1', repos: ['niotix'] }]);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0].runId).toBe('NG-603-1');
  });

  it('copes with a runs/ directory that is not there at all', async () => {
    await makeRun('NG-601-1');
    rmSync(paths.runsDir, { recursive: true, force: true });

    const report = await sweep(ctx, { liveRunIds: ['NG-601-1'] });

    expect(report.removed).toEqual([]);
    expect(report.failures).toEqual([]);
  });
});

describe('a sweep on a machine with nothing on it', () => {
  it('reports nothing rather than failing', async () => {
    const report = await sweep(ctx, { liveRunIds: [] });

    expect(report).toEqual({ pruned: [], removed: [], failures: [] });
  });
});

describe('the sweep and the mutex', () => {
  it('waits for a fetch in flight rather than pruning under it', async () => {
    await makeRun('NG-602-1');
    const release = await ctx.mutex.acquire('niotix');

    const pending = sweep(ctx, { liveRunIds: [] });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(existsSync(paths.run('NG-602-1').workspaceDir)).toBe(true);

    release();
    await pending;
    expect(existsSync(paths.run('NG-602-1').workspaceDir)).toBe(false);
    expect(ctx.mutex.isHeld('niotix')).toBe(false);
  });
});
