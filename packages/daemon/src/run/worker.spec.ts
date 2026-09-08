import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { rockyPaths } from '../config/paths.js';
import { parseInstanceConfig } from '../config/schema.js';
import { newRunHeader } from './header.js';
import {
  RunWorkers,
  type BootRequest,
  type RunWorkersOptions,
} from './worker.js';

let root: string;
const workers: RunWorkers[] = [];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'rocky-worker-'));
});
afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.close()));
  await rm(root, { recursive: true, force: true });
});

function run(branch = 'park') {
  return newRunHeader({
    runId: 'NG-598-1',
    repo: 'rocky',
    branch,
    issue: {
      identifier: 'NG-598',
      title: 'Boot ownership',
      description: '',
      url: 'https://linear.app/issue/NG-598',
      labels: [],
    },
    now: '2026-09-07T00:00:00.000Z',
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup(
  onEvent?: (runId: string, stepKey: string, event: unknown) => void,
  onRequest?: RunWorkersOptions['onRequest'],
  onError?: RunWorkersOptions['onError'],
) {
  const worker = new RunWorkers({
    paths: rockyPaths(root),
    config: () => parseInstanceConfig({}),
    childModule: new URL('./worker-fixture.mjs', import.meta.url),
    onEvent,
    onRequest,
    onError,
  });
  workers.push(worker);
  return worker;
}

it('retains one child across Parked Boots and sequential polls, and close joins it', async () => {
  const events: unknown[] = [];
  const worker = setup((runId, stepKey, event) => {
    events.push({ runId, stepKey, event });
  });
  const boot = worker.boot;
  await expect(
    boot(run(), 'run', new AbortController().signal),
  ).resolves.toEqual({
    status: 'parked',
    reason: 'ci',
    boot: 1,
    replayed: 0,
    executed: 0,
  });
  await expect(
    boot(run(), 'poll', new AbortController().signal),
  ).resolves.toEqual({
    status: 'parked',
    reason: 'ci',
    boot: 2,
    replayed: 0,
    executed: 0,
  });
  expect(events).toMatchObject([
    {
      runId: 'NG-598-1',
      stepKey: 'fixture',
      event: { boots: 1, kind: 'run', root },
    },
    {
      runId: 'NG-598-1',
      stepKey: 'fixture',
      event: { boots: 2, kind: 'poll', root },
    },
  ]);
  const { event: first } = events[0] as { event: { pid: number } };
  expect(events[1]).toMatchObject({ event: { pid: first.pid } });
  expect(() => process.kill(first.pid, 0)).not.toThrow();
  await worker.close();
  expect(() => process.kill(first.pid, 0)).toThrow();
});

it('routes a workspace request to the parent with the Boot signal and correlates its reply', async () => {
  const controller = new AbortController();
  const requests: {
    runId: string;
    request: BootRequest;
    signal: AbortSignal;
  }[] = [];
  const replies: unknown[] = [];
  const worker = setup(
    (_runId, _stepKey, event) => replies.push(event),
    async (runId, request, signal) => {
      requests.push({ runId, request, signal });
      return { cwd: '/owned/workspace' };
    },
  );
  await expect(
    worker.boot(run('request'), 'run', controller.signal),
  ).resolves.toMatchObject({ status: 'parked' });
  expect(requests).toHaveLength(1);
  expect(requests[0]?.runId).toBe('NG-598-1');
  expect(requests[0]?.request).toEqual({ kind: 'workspace' });
  expect(requests[0]?.signal).toBe(controller.signal);
  expect(replies).toEqual([
    { type: 'reply', id: 'request-1', result: { cwd: '/owned/workspace' } },
  ]);
});

it('joins parent workspace cleanup before Boot and kill return, even after child exit', async () => {
  const started = deferred<AbortSignal>();
  const release = deferred<void>();
  const pid = deferred<number>();
  const controller = new AbortController();
  const worker = setup(
    (_runId, _stepKey, event) => pid.resolve(event as number),
    async (_runId, _request, signal) => {
      started.resolve(signal);
      await release.promise;
    },
  );
  let bootSettled = false;
  let killSettled = false;
  const boot = worker.boot(run('request-wait'), 'run', controller.signal);
  const observed = boot.then(
    () => {
      bootSettled = true;
    },
    () => {
      bootSettled = true;
    },
  );
  let killed: Promise<void> | undefined;
  let killedAgain: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  try {
    expect(await started.promise).toBe(controller.signal);
    const childPid = await pid.promise;
    controller.abort();
    killed = worker.kill(run()).then(() => {
      killSettled = true;
    });
    await vi.waitFor(() => expect(() => process.kill(childPid, 0)).toThrow());
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(bootSettled).toBe(false);
    expect(killSettled).toBe(false);
    let secondSettled = false;
    killedAgain = worker.kill(run()).then(() => {
      secondSettled = true;
    });
    let closeSettled = false;
    closing = worker.close().then(() => {
      closeSettled = true;
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);
    expect(closeSettled).toBe(false);
  } finally {
    release.resolve(undefined);
    await Promise.all([observed, killed, killedAgain, closing]);
  }
  await expect(boot).rejects.toThrow(/stopped|exited|cancelled/);
  expect(controller.signal.aborted).toBe(true);
});

it('joins parent requests before returning a Parked result', async () => {
  const release = deferred<void>();
  const resultSent = deferred<void>();
  const worker = setup(
    (_runId, stepKey) => {
      if (stepKey === 'early-result') resultSent.resolve(undefined);
    },
    async () => {
      await release.promise;
    },
  );
  let returned = false;
  const boot = worker
    .boot(run('request-early'), 'run', new AbortController().signal)
    .then((result) => {
      returned = true;
      return result;
    });
  try {
    await resultSent.promise;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(returned).toBe(false);
  } finally {
    release.resolve(undefined);
    await boot;
  }
});

it.each([
  {
    kind: 'append',
    entry: {
      v: 1,
      seq: 0,
      step: 'exec',
      status: 'running',
      boot: 1,
      startedAt: '2026-09-07T00:00:00.000Z',
    },
    options: { runner: true },
  },
  { kind: 'control-get', key: 'checkpoint' },
  { kind: 'control-put', key: 'checkpoint', value: { answer: 'approve' } },
  {
    kind: 'agent-steer-open',
    stepKey: '3/0/2',
    label: 'implementer',
    group: '3',
  },
  { kind: 'agent-steer-take', stepKey: '3/0/2' },
  {
    kind: 'agent-steer-delivered',
    stepKey: '3/0/2',
    ids: ['linear:activity-1', 'local:request-2'],
  },
  { kind: 'agent-steer-close', stepKey: '3/0/2' },
] satisfies BootRequest[])(
  'transports $kind without creating a child-side writer',
  async (request) => {
    const calls: BootRequest[] = [];
    const replies: unknown[] = [];
    const worker = setup(
      (_runId, _stepKey, event) => replies.push(event),
      async (_runId, received) => {
        calls.push(received);
        if (received.kind === 'control-get') return { answer: 'approve' };
        if (received.kind === 'agent-steer-take') {
          return {
            ids: ['linear:activity-1', 'local:request-2'],
            message: 'Keep the migration small.',
          };
        }
        return undefined;
      },
    );
    const header = run('request');
    header.issue.description = JSON.stringify(request);
    await worker.boot(header, 'run', new AbortController().signal);
    expect(calls).toEqual([request]);
    expect(replies).toEqual([
      {
        type: 'reply',
        id: 'request-1',
        ...(request.kind === 'control-get'
          ? { result: { answer: 'approve' } }
          : request.kind === 'agent-steer-take'
            ? {
                result: {
                  ids: ['linear:activity-1', 'local:request-2'],
                  message: 'Keep the migration small.',
                },
              }
            : {}),
      },
    ]);
  },
);

it('closes parent Steer conversations when a child exits before unregistering', async () => {
  const controller = new AbortController();
  const calls: { request: BootRequest; signal: AbortSignal }[] = [];
  const worker = setup(undefined, async (_runId, request, signal) => {
    calls.push({ request, signal });
  });
  const header = run('request-exit');
  header.issue.description = JSON.stringify({
    kind: 'agent-steer-open',
    stepKey: '3/0/2',
    label: 'implementer',
  } satisfies BootRequest);

  await expect(worker.boot(header, 'run', controller.signal)).rejects.toThrow(
    /exited unexpectedly.*17/,
  );
  expect(calls.map(({ request }) => request)).toEqual([
    { kind: 'agent-steer-open', stepKey: '3/0/2', label: 'implementer' },
    { kind: 'agent-steer-close', stepKey: '3/0/2' },
  ]);
  expect(calls[0]?.signal).toBe(controller.signal);
  expect(calls[1]?.signal).not.toBe(controller.signal);
  expect(calls[1]?.signal.aborted).toBe(false);
});

it('reports a failed emergency Steer cleanup without stranding the worker', async () => {
  const error = new Error('control storage unavailable');
  const reported = vi.fn();
  const worker = setup(
    undefined,
    async (_runId, request) => {
      if (request.kind === 'agent-steer-close') throw error;
    },
    reported,
  );
  const header = run('request-exit');
  header.issue.description = JSON.stringify({
    kind: 'agent-steer-open',
    stepKey: '3/0/2',
    label: 'implementer',
  } satisfies BootRequest);

  await expect(
    worker.boot(header, 'run', new AbortController().signal),
  ).rejects.toThrow(/exited unexpectedly.*17/);
  expect(reported).toHaveBeenCalledWith(
    expect.objectContaining({
      message: 'Could not close Agent conversation 3/0/2 for NG-598-1',
      cause: error,
    }),
  );
});

it('returns a named fix when no parent request handler is configured', async () => {
  const worker = setup();
  await expect(
    worker.boot(run('request'), 'run', new AbortController().signal),
  ).rejects.toThrow(/Configure RunWorkers.onRequest.*workspace/);
});

it.each(['sync', 'async'])(
  'relays %s parent service errors by name and message',
  async (kind) => {
    const replies: unknown[] = [];
    const error = Object.assign(new Error('workspace unavailable'), {
      name: 'WorkspaceError',
    });
    const worker = setup(
      (_runId, _stepKey, event) => replies.push(event),
      () => {
        if (kind === 'sync') throw error;
        return Promise.reject(error);
      },
    );
    await expect(
      worker.boot(run('request'), 'run', new AbortController().signal),
    ).rejects.toMatchObject({
      name: 'WorkspaceError',
      message: 'workspace unavailable',
    });
    expect(replies).toEqual([
      {
        type: 'reply',
        id: 'request-1',
        error: { name: 'WorkspaceError', message: 'workspace unavailable' },
      },
    ]);
  },
);

it('keeps Runs isolated and refreshes config while retaining a ready child', async () => {
  const config = parseInstanceConfig({ server: { port: 8100 } });
  const events: { runId: string; pid: number; port: number }[] = [];
  const worker = new RunWorkers({
    paths: rockyPaths(root),
    config: () => config,
    childModule: new URL('./worker-fixture.mjs', import.meta.url),
    onEvent: (runId, _stepKey, event) =>
      events.push({ runId, ...(event as { pid: number; port: number }) }),
  });
  workers.push(worker);
  const first = run();
  const second = { ...run('ready'), runId: 'NG-598-2' };
  await Promise.all(
    [first, second].map((run) =>
      worker.boot(run, 'run', new AbortController().signal),
    ),
  );
  const firstPid = events.find((event) => event.runId === first.runId)?.pid;
  const secondPid = events.find((event) => event.runId === second.runId)?.pid;
  if (!firstPid || !secondPid) throw new Error('Both Boots must report a PID');
  expect(firstPid).not.toBe(secondPid);
  expect(events.every((event) => event.port === 8100)).toBe(true);
  await worker.kill(first);
  expect(() => process.kill(firstPid, 0)).toThrow();
  expect(() => process.kill(secondPid, 0)).not.toThrow();
  config.server.port = 8101;
  await worker.boot(second, 'poll', new AbortController().signal);
  expect(events.at(-1)).toMatchObject({ pid: secondPid, port: 8101 });
  await Promise.all([worker.close(), worker.close()]);
  expect(() => process.kill(secondPid, 0)).toThrow();
});

it.each(['signal', 'kill', 'close'])(
  '%s joins a blocked Boot and kills its stubborn grandchild',
  async (action) => {
    const ready = deferred<{ pid: number; descendant: number }>();
    const worker = setup((_runId, _stepKey, event) =>
      ready.resolve(event as { pid: number; descendant: number }),
    );
    const controller = new AbortController();
    const boot = worker.boot(run('blocked'), 'run', controller.signal);
    const rejected = expect(boot).rejects.toThrow(/stopped|exited|cancelled/);
    const { pid, descendant } = await ready.promise;
    if (action === 'signal') controller.abort();
    else if (action === 'kill') await worker.kill(run());
    else await worker.close();
    await rejected;
    expect(() => process.kill(pid, 0)).toThrow();
    await vi.waitFor(() => expect(() => process.kill(descendant, 0)).toThrow());
  },
);

it.each(['finished', 'failed', 'cancelled'])(
  'joins the child before returning a %s result',
  async (status) => {
    let pid = 0;
    const worker = setup((_runId, _stepKey, event) => {
      pid = (event as { pid: number }).pid;
    });
    await expect(
      worker.boot(run(status), 'run', new AbortController().signal),
    ).resolves.toMatchObject({ status });
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).toThrow();
  },
);

it.each(['error', 'exit'])(
  'rejects a Boot on child %s rather than manufacturing a result',
  async (branch) => {
    let pid = 0;
    const worker = setup((_runId, _stepKey, event) => {
      pid = (event as { pid: number }).pid;
    });
    const boot = worker.boot(run(branch), 'run', new AbortController().signal);
    if (branch === 'error')
      await expect(boot).rejects.toMatchObject({
        name: 'FixtureError',
        message: 'disk unavailable',
        stack: 'fixture stack',
      });
    else await expect(boot).rejects.toThrow(/exited unexpectedly.*17/);
    expect(() => process.kill(pid, 0)).toThrow();
  },
);

it('refuses overlapping Boots, already-aborted Boots, and Boots after close', async () => {
  const worker = setup();
  const boot = worker.boot(run(), 'run', new AbortController().signal);
  await expect(
    worker.boot(run(), 'poll', new AbortController().signal),
  ).rejects.toThrow(/already active/);
  await boot;
  await expect(worker.boot(run(), 'run', AbortSignal.abort())).rejects.toThrow(
    /cancelled/,
  );
  await worker.close();
  await expect(
    worker.boot(run(), 'run', new AbortController().signal),
  ).rejects.toThrow(/closed/);
});

it('rejects an unserializable Boot request without leaving an unhandled rejection or child', async () => {
  const config = parseInstanceConfig({});
  config.circular = config;
  const worker = new RunWorkers({
    paths: rockyPaths(root),
    config: () => config,
    childModule: new URL('./worker-fixture.mjs', import.meta.url),
  });
  workers.push(worker);
  await expect(
    worker.boot(run(), 'run', new AbortController().signal),
  ).rejects.toThrow(/circular/i);
  await worker.close();
});

it('sends abort before forced kill and joins even if the child races back with Parked', async () => {
  const ready = deferred<number>();
  let aborted = false;
  const worker = setup((_runId, _stepKey, event) => {
    if (event === 'aborted') aborted = true;
    else ready.resolve((event as { pid: number }).pid);
  });
  const boot = worker.boot(
    run('cooperative'),
    'run',
    new AbortController().signal,
  );
  const rejected = expect(boot).rejects.toThrow(/stopped/);
  const pid = await ready.promise;
  const killing = worker.kill(run());
  await rejected;
  expect(aborted).toBe(true);
  expect(() => process.kill(pid, 0)).toThrow();
  await killing;
});

it.each(['blocked', 'detached'])(
  'cleans up a %s Boot and descendants when the daemon is SIGKILLed',
  async (branch) => {
    const pidFile = join(root, 'pids');
    const script = `
    import { writeFileSync } from 'node:fs';
    import { RunWorkers } from ${JSON.stringify(new URL('./worker.ts', import.meta.url).href)};
    const workers = new RunWorkers({ paths: { root: ${JSON.stringify(root)} },
      config: () => (${JSON.stringify(parseInstanceConfig({}))}),
      childModule: new URL(${JSON.stringify(new URL('./worker-fixture.mjs', import.meta.url).href)}),
      onEvent: (_runId, _stepKey, event) => writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify(event)),
    });
    await workers.boot(${JSON.stringify(run(branch))}, 'run', new AbortController().signal);
  `;
    const owner = spawn(
      process.execPath,
      ['--input-type=module', '-e', script],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    owner.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    const closed = once(owner, 'close');
    try {
      await vi.waitFor(async () => {
        expect(stderr).toBe('');
        expect(
          JSON.parse(await readFile(pidFile, 'utf8')).descendant,
        ).toBeGreaterThan(0);
      });
      const { pid, descendant } = JSON.parse(
        await readFile(pidFile, 'utf8'),
      ) as { pid: number; descendant: number };
      owner.kill('SIGKILL');
      await closed;
      await vi.waitFor(() => {
        expect(() => process.kill(pid, 0)).toThrow();
        expect(() => process.kill(descendant, 0)).toThrow();
      });
    } finally {
      owner.kill('SIGKILL');
      await closed;
    }
  },
);
