import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CheckpointAnswer, Workflow } from '@rocky/sdk';
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
        steps.step<CheckpointAnswer>('checkpoint', {}, async () =>
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
/*
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkflowContext } from '@rocky/sdk';

import { rockyPaths, type RockyPaths } from '../config/paths.js';
import { newRunHeader, readRunHeader, type RunHeader } from './header.js';
import {
  assertBackgroundExecSupported,
  bootWorkflowRun,
  createRunLifecycleServices,
  type RunLifecycleServices,
} from './lifecycle.js';
import { runBoot, type BootContext } from './replay.js';

vi.mock('./replay.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./replay.js')>();
  return { ...actual, runBoot: vi.fn(actual.runBoot) };
});

let root: string;
let paths: RockyPaths;
let runHeader: RunHeader;
const processGroups: number[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rocky-lifecycle-'));
  paths = rockyPaths(root);
  runHeader = newRunHeader({
    runId: 'NG-597-1',
    issue: {
      identifier: 'NG-597',
      title: 'Lifecycle',
      description: 'Own processes and port reservations.',
      url: 'https://linear.app/NG-597',
      labels: ['daemon'],
    },
    branch: 'rocky/ng-597',
    now: '2026-09-04T10:00:00.000Z',
  });
});

afterEach(() => {
  for (const pid of processGroups.splice(0)) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
  rmSync(root, { recursive: true, force: true });
});

function services(
  over: Partial<RunLifecycleServices> = {},
): RunLifecycleServices {
  return {
    changedFiles: vi.fn(async () => []),
    exec: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
    external: {} as RunLifecycleServices['external'],
    reservePorts: vi.fn(async () => [41001]),
    killProcessGroup: vi.fn(async () => undefined),
    ...over,
  };
}

describe('bootWorkflowRun', () => {
  it('re-reserves ports on each Boot and persists the current reservation', async () => {
    const reservePorts = vi
      .fn<RunLifecycleServices['reservePorts']>()
      .mockResolvedValueOnce([41001])
      .mockResolvedValueOnce([41002]);
    const supplied = services({ reservePorts });
    const workflow = async (ctx: WorkflowContext) => {
      await ctx.step('one step', () => undefined);
      return 'merged' as const;
    };

    await bootWorkflowRun({
      paths,
      header: runHeader,
      services: supplied,
      workflow,
    });
    await bootWorkflowRun({
      paths,
      header: runHeader,
      services: supplied,
      workflow,
    });

    expect(reservePorts).toHaveBeenCalledTimes(2);
    expect((await readRunHeader(paths, runHeader.runId)).ports).toEqual([
      41002,
    ]);
  });

  it.skipIf(process.platform === 'win32')(
    'kills a background process group and its grandchild after terminal completion',
    async () => {
      const childPidFile = join(root, 'child.pid');
      let leaderPid: number | undefined;
      const supplied = createRunLifecycleServices({
        workspace: root,
        changedFiles: async () => [],
        external: {} as RunLifecycleServices['external'],
        reservePorts: async () => [],
      });

      await bootWorkflowRun({
        paths,
        header: runHeader,
        services: supplied,
        workflow: async (ctx) => {
          leaderPid = (
            await ctx.exec(
              `sh -c 'sleep 30 & child=$!; printf "%s" "$child" > "${childPidFile}"; wait'`,
              { background: true },
            )
          ).pid;
          await waitForFile(childPidFile);
          return 'merged';
        },
      });

      const childPid = Number(readFileSync(childPidFile, 'utf8'));
      await expectProcessGone(leaderPid!);
      await expectProcessGone(childPid);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'keeps a parked background group alive and cleans it after its resumed terminal Boot',
    async () => {
      const reservePorts = vi
        .fn<RunLifecycleServices['reservePorts']>()
        .mockResolvedValueOnce([41001])
        .mockResolvedValueOnce([41002]);
      const supplied = createRunLifecycleServices({
        workspace: root,
        changedFiles: async () => [],
        external: {} as RunLifecycleServices['external'],
        reservePorts,
      });
      const pids: number[] = [];
      vi.mocked(runBoot)
        .mockImplementationOnce(async ({ workflow }) => {
          await workflow(liveRunner());
          return { status: 'parked', reason: 'checkpoint', ...bootCounts(1) };
        })
        .mockImplementationOnce(async ({ workflow }) => {
          await workflow(liveRunner());
          return { status: 'finished', outcome: 'merged', ...bootCounts(2) };
        });
      const workflow = async (ctx: WorkflowContext) => {
        const pid = (await ctx.exec('sleep 30', { background: true })).pid;
        pids.push(pid);
        processGroups.push(pid);
        return 'merged' as const;
      };

      await bootWorkflowRun({
        paths,
        header: runHeader,
        services: supplied,
        workflow,
      });

      expect((await readRunHeader(paths, runHeader.runId)).ports).toEqual([
        41001,
      ]);
      expect(
        (await readRunHeader(paths, runHeader.runId)).processGroups,
      ).toEqual([pids[0]]);
      expectProcessAlive(pids[0]!);
      expect(reservePorts).toHaveBeenCalledTimes(1);

      await bootWorkflowRun({
        paths,
        header: await readRunHeader(paths, runHeader.runId),
        services: supplied,
        workflow,
      });

      expect(reservePorts).toHaveBeenCalledTimes(2);
      expect((await readRunHeader(paths, runHeader.runId)).ports).toEqual([
        41002,
      ]);
      await Promise.all(pids.map(expectProcessGone));
    },
  );

  it('retains groups whose terminal cleanup fails after attempting every group', async () => {
    const killProcessGroup = vi
      .fn<RunLifecycleServices['killProcessGroup']>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('permission denied'));
    const supplied = services({
      exec: vi
        .fn<RunLifecycleServices['exec']>()
        .mockResolvedValueOnce({ pid: 101 })
        .mockResolvedValueOnce({ pid: 102 }),
      killProcessGroup,
    });
    vi.mocked(runBoot).mockImplementationOnce(async ({ workflow }) => {
      await workflow(liveRunner());
      return { status: 'finished', outcome: 'merged', ...bootCounts(1) };
    });

    await expect(
      bootWorkflowRun({
        paths,
        header: runHeader,
        services: supplied,
        workflow: async (ctx) => {
          await ctx.exec('one', { background: true });
          await ctx.exec('two', { background: true });
          return 'merged';
        },
      }),
    ).rejects.toThrow('permission denied');

    expect(killProcessGroup).toHaveBeenCalledWith(101);
    expect(killProcessGroup).toHaveBeenCalledWith(102);
    expect((await readRunHeader(paths, runHeader.runId)).processGroups).toEqual(
      [102],
    );
  });

  it('rejects background execution on Windows before it can leave a partial tree', () => {
    expect(() => assertBackgroundExecSupported('win32')).toThrow(/Windows/);
    expect(() => assertBackgroundExecSupported('linux')).not.toThrow();
  });
});

function liveRunner(): BootContext {
  return {
    boot: 1,
    stage: () => undefined,
    step: async (_key, _options, effect) => {
      const outcome = await effect({ record: () => undefined });
      if (outcome.status !== 'done') throw new Error('unexpected parked Step');
      return outcome.result;
    },
    parallel: async () => [],
  };
}

function bootCounts(boot: number) {
  return { boot, replayed: 0, executed: 1 };
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function expectProcessGone(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`process ${pid} is still alive`);
}

function expectProcessAlive(pid: number): void {
  expect(() => process.kill(pid, 0)).not.toThrow();
}
*/
