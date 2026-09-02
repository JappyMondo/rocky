/**
 * Human-push adoption at wake (NG-521's fourth acceptance criterion, from
 * NG-574 §9).
 *
 * §9's table entry is the design: "Human pushed to the branch — **Adopted.**
 * Rocky records the head SHA it last pushed; on wake, if the remote moved and
 * the worktree is clean, fast-forward and post a note. A human pushing a fix
 * is the system working. Only a genuinely diverged worktree fails the Run, and
 * that needs a crash first."
 *
 * So the bar is: a clean worktree fast-forwards and records a note; a
 * genuinely diverged one fails the Run; and nothing else does either.
 */
import { rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'; // prettier-ignore

import { rockyPaths, type RockyPaths } from '../config/paths.js';
import { ensureInstanceLayout } from '../config/store.js';
import { adoptRemoteMoves, failsTheRun } from './adopt.js';
import { git } from './git.js';
import { KeyedMutex } from './mutex.js';
import { createUpstream, makeTempDir, type Upstream } from './upstream.fixtures.js'; // prettier-ignore
import { createWorkspace, type Workspace } from './workspace.js';
import type { RepoContext, RepoRef } from './context.js';

const savedEnv = { ...process.env };

beforeAll(() => {
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_SYSTEM = '/dev/null';
});

afterAll(() => {
  process.env = savedEnv;
});

const BRANCH = 'ng-601-do-a-thing';
const RUN = 'NG-601-1';

let home: string;
let paths: RockyPaths;
let ctx: RepoContext;
let upstream: Upstream;
let niotix: RepoRef;
let workspace: Workspace;

beforeEach(async () => {
  home = makeTempDir('home');
  paths = rockyPaths(home);
  await ensureInstanceLayout(paths);
  ctx = {
    paths,
    mutex: new KeyedMutex(),
    identity: { name: 'Rocky', email: 'rocky@rocky.invalid' },
  };

  upstream = await createUpstream({ branches: [BRANCH] });
  niotix = { name: 'niotix', url: upstream.url, baseBranch: 'main' };
  workspace = await createWorkspace(ctx, {
    runId: RUN,
    branch: BRANCH,
    members: [niotix],
    lead: 'niotix',
  });
});

afterEach(() => {
  for (const dir of [home, upstream.dir, upstream.workingCopy]) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const wake = (lastPushedSha?: string) =>
  adoptRemoteMoves(ctx, {
    runId: RUN,
    repo: niotix,
    branch: BRANCH,
    worktree: workspace.lead.dir,
    lastPushedSha,
  });

/** Commit inside the worktree, as an Agent's `bash` Capability would. */
async function commitInWorktree(name: string): Promise<string> {
  await writeFile(join(workspace.lead.dir, name), 'rocky was here\n');
  await git(['add', '--all'], { cwd: workspace.lead.dir });
  await git(['commit', '--quiet', '--message', `rocky: ${name}`], {
    cwd: workspace.lead.dir,
  });
  return (await git(['rev-parse', 'HEAD'], { cwd: workspace.lead.dir })).stdout;
}

async function push(): Promise<string> {
  await git(['push', '--quiet', 'origin', BRANCH], {
    cwd: workspace.lead.dir,
  });
  return (await git(['rev-parse', 'HEAD'], { cwd: workspace.lead.dir })).stdout;
}

describe('a wake with nothing to adopt', () => {
  it('says so when the remote has not moved', async () => {
    const outcome = await wake(workspace.lead.head);

    expect(outcome.kind).toBe('unchanged');
    expect(failsTheRun(outcome)).toBe(false);
  });

  it('says so when Rocky is simply ahead of what it pushed', async () => {
    const pushed = workspace.lead.head;
    await commitInWorktree('work.txt');

    const outcome = await wake(pushed);

    // Unpushed commits are the normal working state, not something to adopt.
    expect(outcome.kind).toBe('local-ahead');
    expect(failsTheRun(outcome)).toBe(false);
  });

  it('says so when the branch has never been pushed', async () => {
    const fresh = await createWorkspace(ctx, {
      runId: 'NG-999-1',
      branch: 'ng-999-never-pushed',
      members: [niotix],
      lead: 'niotix',
    });

    const outcome = await adoptRemoteMoves(ctx, {
      runId: 'NG-999-1',
      repo: niotix,
      branch: 'ng-999-never-pushed',
      worktree: fresh.lead.dir,
    });

    expect(outcome.kind).toBe('no-remote-branch');
    expect(failsTheRun(outcome)).toBe(false);
  });
});

describe('a human pushed while the Run was parked (AC4)', () => {
  it('fast-forwards a clean worktree onto it', async () => {
    const pushed = workspace.lead.head;
    const humanSha = await upstream.commitAndPush({ branch: BRANCH });

    const outcome = await wake(pushed);

    expect(outcome.kind).toBe('fast-forwarded');
    expect(
      (await git(['rev-parse', 'HEAD'], { cwd: workspace.lead.dir })).stdout,
    ).toBe(humanSha);
    expect(failsTheRun(outcome)).toBe(false);
  });

  it('records a note naming what it took, since a Run that changed under itself has to say so', async () => {
    const pushed = workspace.lead.head;
    await upstream.commitAndPush({
      branch: BRANCH,
      message: 'Fix the thing Rocky got wrong',
    });

    const outcome = await wake(pushed);

    const note = outcome.kind === 'fast-forwarded' ? outcome.note : '';
    expect(note).toContain('niotix');
    expect(note).toContain(BRANCH);
    expect(note).toMatch(/fast-forward/i);
    expect(note).toContain(pushed.slice(0, 7));
  });

  it("brings the human's files into the worktree, not just the ref", async () => {
    await upstream.commitAndPush({ branch: BRANCH, file: 'FROM-HUMAN.md' });

    await wake(workspace.lead.head);

    expect(
      (await git(['ls-files', 'FROM-HUMAN.md'], { cwd: workspace.lead.dir }))
        .stdout,
    ).toBe('FROM-HUMAN.md');
  });

  it('takes several commits at once, and counts them', async () => {
    const pushed = workspace.lead.head;
    await upstream.commitAndPush({ branch: BRANCH, file: 'one.md' });
    await upstream.commitAndPush({ branch: BRANCH, file: 'two.md' });

    const outcome = await wake(pushed);

    expect(outcome.kind).toBe('fast-forwarded');
    expect(outcome.kind === 'fast-forwarded' ? outcome.commits : 0).toBe(2);
  });
});

describe('a worktree that genuinely diverged (AC4)', () => {
  it('fails the Run rather than guessing which side to keep', async () => {
    // Needs a crash first, per NG-574 §9: Rocky committed locally and the
    // push never happened, then a human pushed something else. Neither head is
    // an ancestor of the other, and both are real work.
    const pushed = await push();
    await commitInWorktree('rocky-work.txt');
    await upstream.commitAndPush({ branch: BRANCH, file: 'human-work.md' });

    const outcome = await wake(pushed);

    expect(outcome.kind).toBe('diverged');
    expect(failsTheRun(outcome)).toBe(true);
  });

  it('names both sides, because a human has to pick one by hand', async () => {
    const pushed = await push();
    const rockySha = await commitInWorktree('rocky-work.txt');
    const humanSha = await upstream.commitAndPush({
      branch: BRANCH,
      file: 'human-work.md',
    });

    const outcome = await wake(pushed);

    const note = outcome.kind === 'diverged' ? outcome.note : '';
    expect(note).toContain(rockySha.slice(0, 7));
    expect(note).toContain(humanSha.slice(0, 7));
    expect(note).toContain(workspace.lead.dir);
  });

  it('destroys nothing it cannot reconcile', async () => {
    const pushed = await push();
    const rockySha = await commitInWorktree('rocky-work.txt');
    await upstream.commitAndPush({ branch: BRANCH, file: 'human-work.md' });

    await wake(pushed);

    // NG-574: Rocky never destroys work, only its own scaffolding. A failed
    // adoption that had reset the branch would have eaten the commit above.
    expect(
      (await git(['rev-parse', 'HEAD'], { cwd: workspace.lead.dir })).stdout,
    ).toBe(rockySha);
  });
});

describe('a worktree with uncommitted work when the remote moved', () => {
  it('holds off rather than merging over a mid-edit file', async () => {
    const pushed = workspace.lead.head;
    await writeFile(join(workspace.lead.dir, 'half-done.txt'), 'mid-edit\n');
    await upstream.commitAndPush({ branch: BRANCH });

    const outcome = await wake(pushed);

    // §9 conditions the fast-forward on a clean worktree, and this worktree is
    // not diverged either — a crash mid-Agent-call is the ordinary way to get
    // here. So it is reported and left alone rather than failed.
    expect(outcome.kind).toBe('dirty');
    expect(failsTheRun(outcome)).toBe(false);
    expect(
      (await git(['rev-parse', 'HEAD'], { cwd: workspace.lead.dir })).stdout,
    ).toBe(pushed);
  });

  it('names the files in the way, so the note says what to do about it', async () => {
    await writeFile(join(workspace.lead.dir, 'half-done.txt'), 'mid-edit\n');
    await upstream.commitAndPush({ branch: BRANCH });

    const outcome = await wake(workspace.lead.head);

    expect(outcome.kind === 'dirty' ? outcome.note : '').toContain(
      'half-done.txt',
    );
  });
});

describe('the fetch adoption needs', () => {
  it('goes through the per-repo mutex, like every other clone operation', async () => {
    await upstream.commitAndPush({ branch: BRANCH });
    const release = await ctx.mutex.acquire('niotix');

    const pending = wake(workspace.lead.head);
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Still on the old head: the fetch has not happened yet.
    expect(
      (await git(['rev-parse', 'HEAD'], { cwd: workspace.lead.dir })).stdout,
    ).toBe(workspace.lead.head);

    release();
    expect((await pending).kind).toBe('fast-forwarded');
  });
});
