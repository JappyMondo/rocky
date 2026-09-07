import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Workflow } from '@rocky/sdk';
import { git } from '../repos/git.js';
import { rockyPaths, type RockyPaths } from '../config/paths.js';
import {
  newRunHeader,
  readRunHeader,
  writeRunHeader,
  type RunHeader,
} from './header.js';
import { WorkflowRuntime } from './lifecycle.js';
import { appendEntry, type RunEnd } from './journal.js';

let dir: string;
let paths: RockyPaths;
let header: RunHeader;
let runtime: WorkflowRuntime;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rocky-runtime-'));
  paths = rockyPaths(dir);
  header = newRunHeader({
    runId: 'NG-597-1',
    repo: 'rocky',
    branch: 'ng-597',
    now: '2026-09-07T10:00:00Z',
    issue: {
      identifier: 'NG-597',
      title: '',
      description: '',
      url: '',
      labels: [],
    },
  });
  await writeRunHeader(paths, header);
});
afterEach(async () => {
  await runtime?.close();
  await rm(dir, { recursive: true, force: true });
});
function open(workflow: Workflow, timeoutMs?: number) {
  runtime = new WorkflowRuntime({
    paths,
    loadWorkflow: async () => workflow,
    workspace: () => dir,
    execTimeoutMs: timeoutMs,
    external: (_run, steps) => ({
      checkpoint: () =>
        steps.step('checkpoint', {}, async () => ({ status: 'waiting' })),
    }),
  });
  return runtime;
}
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

it('runs the explicit Start-Preflight seam before loading the workflow', async () => {
  const order: string[] = [];
  runtime = new WorkflowRuntime({
    paths,
    startPreflight: async (_run, steps) => {
      order.push('preflight');
      await steps.step('preflight', {}, async () => ({
        status: 'done',
        result: undefined,
      }));
    },
    loadWorkflow: async () => {
      order.push('workflow');
      return async () => 'merged';
    },
  });
  expect(
    (await runtime.boot(header, 'run', new AbortController().signal)).status,
  ).toBe('finished');
  expect(order).toEqual(['preflight', 'workflow']);
});

it('captures real command output and records renewed ports in the header', async () => {
  const ports: number[] = [];
  let done = false;
  open(async (ctx) => {
    ports.push(ctx.ports[0]!);
    expect(await ctx.exec('printf rocky; printf warning >&2; exit 7')).toEqual({
      exitCode: 7,
      stdout: 'rocky',
      stderr: 'warning',
    });
    if (!done) await ctx.checkpoint({ title: '', body: '' });
    else await ctx.checkpoint({ title: '', body: '' });
    return 'merged';
  });
  await runtime.boot(header, 'run', new AbortController().signal);
  header = await readRunHeader(paths, header.runId);
  expect(header.ports).toEqual([ports[0]]);
  done = true;
  await runtime.boot(header, 'run', new AbortController().signal);
  expect(ports[1]).not.toBe(ports[0]);
  expect((await readRunHeader(paths, header.runId)).ports).toEqual([ports[1]]);
});

it('keeps background work while Parked, respawns on Boot, and kills the group and grandchild at terminal', async () => {
  const pids: number[] = [];
  let ready = false;
  const workflow: Workflow = async (ctx) => {
    const result = await ctx.exec(
      `sleep 600 & printf "$!" > "${join(dir, 'grandchild')}"; wait`,
      { background: true },
    );
    pids.push(result.pid);
    if (!ready) await ctx.checkpoint({ title: '', body: '' });
    else await ctx.checkpoint({ title: '', body: '' });
    return 'merged';
  };
  runtime = new WorkflowRuntime({
    paths,
    loadWorkflow: async () => workflow,
    workspace: () => dir,
    external: (_run, steps) => ({
      checkpoint: () =>
        steps.step<{ decision: 'approve' }>('checkpoint', {}, async () =>
          ready
            ? { status: 'done', result: { decision: 'approve' } }
            : { status: 'waiting' },
        ),
    }),
  });
  expect(
    (await runtime.boot(header, 'run', new AbortController().signal)).status,
  ).toBe('parked');
  await vi.waitFor(async () =>
    expect(
      Number(await readFile(join(dir, 'grandchild'), 'utf8')),
    ).toBeGreaterThan(0),
  );
  const grandchild = Number(await readFile(join(dir, 'grandchild'), 'utf8'));
  expect(alive(grandchild)).toBe(true);
  ready = true;
  expect(
    (await runtime.boot(header, 'run', new AbortController().signal)).status,
  ).toBe('finished');
  expect(pids[1]).not.toBe(pids[0]);
  await vi.waitFor(() => {
    expect(alive(grandchild)).toBe(false);
    for (const pid of pids) expect(alive(pid)).toBe(false);
  });
});

it('kills a foreground command on cancellation, without recording terminal cancellation itself', async () => {
  open(async (ctx) => {
    await ctx.exec('sleep 600');
    return 'merged';
  });
  const controller = new AbortController();
  const boot = runtime.boot(header, 'run', controller.signal);
  await vi.waitFor(async () =>
    expect(await readFile(paths.run(header.runId).journal, 'utf8')).toContain(
      '"running"',
    ),
  );
  controller.abort();
  expect((await boot).status).toBe('cancelled');
});

it('fails a command at the single configured timeout', async () => {
  open(async (ctx) => {
    await ctx.exec('sleep 600');
    return 'merged';
  }, 30);
  expect(
    await runtime.boot(header, 'run', new AbortController().signal),
  ).toMatchObject({
    status: 'failed',
    error: { message: expect.stringMatching(/timed out/) },
  });
});

it('journals real changed files against the configured base, including untracked work', async () => {
  const cwd = join(dir, 'repo');
  await git(['init', '-b', 'base', cwd]);
  await writeFile(join(cwd, 'tracked'), 'before');
  await git(['add', '.'], { cwd });
  await git(
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@localhost',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'base',
    ],
    { cwd },
  );
  await git(['switch', '-c', 'work'], { cwd });
  await writeFile(join(cwd, 'tracked'), 'after');
  await writeFile(join(cwd, 'untracked'), 'new');
  const files: string[][] = [];
  runtime = new WorkflowRuntime({
    paths,
    workspace: () => cwd,
    baseRef: () => 'base',
    loadWorkflow: async () => async (ctx) => {
      files.push(await ctx.changedFiles());
      return 'merged';
    },
  });
  expect(
    (await runtime.boot(header, 'run', new AbortController().signal)).status,
  ).toBe('finished');
  expect(files).toEqual([['tracked', 'untracked']]);
});

it('fails readably on an invalid working directory and cleans up its worker', async () => {
  runtime = new WorkflowRuntime({
    paths,
    workspace: () => join(dir, 'missing'),
    loadWorkflow: async () => async (ctx) => {
      await ctx.exec('true');
      return 'merged';
    },
  });
  expect(
    await runtime.boot(header, 'run', new AbortController().signal),
  ).toMatchObject({
    status: 'failed',
    error: { message: expect.stringMatching(/ENOENT/) },
  });
});

it('does not run command effects during a poll Boot', async () => {
  let pid = 0;
  let calls = 0;
  open(async (ctx) => {
    pid = (await ctx.exec('sleep 600', { background: true })).pid;
    calls++;
    await ctx.checkpoint({ title: '', body: '' });
    return 'merged';
  });
  await runtime.boot(header, 'run', new AbortController().signal);
  const first = pid;
  await runtime.boot(header, 'poll', new AbortController().signal);
  expect(calls).toBe(2);
  expect(pid).toBe(first);
  expect(alive(pid)).toBe(true);
});

it('names the missing changedFiles base rather than silently comparing against HEAD', async () => {
  open(async (ctx) => {
    await ctx.changedFiles();
    return 'merged';
  });
  expect(
    await runtime.boot(header, 'run', new AbortController().signal),
  ).toMatchObject({
    status: 'failed',
    error: { message: expect.stringMatching(/Configure baseRef/) },
  });
});

it('records git failures through the same cancellable command ownership', async () => {
  runtime = new WorkflowRuntime({
    paths,
    workspace: () => dir,
    baseRef: () => 'missing',
    loadWorkflow: async () => async (ctx) => {
      await ctx.changedFiles();
      return 'merged';
    },
  });
  expect(
    await runtime.boot(header, 'run', new AbortController().signal),
  ).toMatchObject({
    status: 'failed',
    error: { message: expect.stringMatching(/git merge-base failed/) },
  });
});

it('merges per-Run environment over the inherited environment', async () => {
  runtime = new WorkflowRuntime({
    paths,
    workspace: () => dir,
    env: () => ({ ROCKY_TEST_VALUE: 'per-run' }),
    loadWorkflow: async () => async (ctx) => {
      expect(await ctx.exec('printf "$ROCKY_TEST_VALUE"')).toMatchObject({
        stdout: 'per-run',
      });
      expect(await ctx.exec('test -n "$PATH"')).toMatchObject({ exitCode: 0 });
      return 'merged';
    },
  });
  expect(
    (await runtime.boot(header, 'run', new AbortController().signal)).status,
  ).toBe('finished');
});

const terminalOutcomes: RunEnd[] = [
  { status: 'finished', outcome: 'merged' },
  { status: 'failed', error: { name: 'Error', message: 'recorded failure' } },
  { status: 'cancelled' },
];
it.each(terminalOutcomes)(
  'honors an existing terminal record before loading or reserving ports: $status',
  async (end) => {
    const journalPath = paths.run(header.runId).journal;
    await appendEntry(
      journalPath,
      {
        v: 1,
        seq: 0,
        step: '$end',
        boot: 1,
        status: end.status === 'failed' ? 'failed' : 'done',
        startedAt: '2026-09-07T10:00:00Z',
        result: end,
      },
      { runner: true },
    );
    const before = await readFile(paths.run(header.runId).runJson, 'utf8');
    const journalBefore = await readFile(journalPath, 'utf8');
    const loadWorkflow = vi.fn(async (): Promise<never> => {
      throw new Error('snapshot unavailable');
    });
    runtime = new WorkflowRuntime({ paths, loadWorkflow });
    expect(
      await runtime.boot(header, 'run', new AbortController().signal),
    ).toMatchObject(end);
    expect(loadWorkflow).not.toHaveBeenCalled();
    expect(await readFile(paths.run(header.runId).runJson, 'utf8')).toBe(
      before,
    );
    expect(await readFile(journalPath, 'utf8')).toBe(journalBefore);
  },
);
