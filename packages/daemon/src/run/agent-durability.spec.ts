import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  createAgent,
  type AgentContinuation,
  type AgentHarnessInvocation,
  type AgentHarnessResult,
  type AgentOptions,
} from './agent.js';
import { appendEntry, openJournal } from './journal.js';
import { runBoot, type RunBootOptions } from './replay.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rocky-agent-durability-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function result(sessionId = 'original', summary = 'ready'): AgentHarnessResult {
  return {
    text: `<result>${JSON.stringify({ summary })}</result>`,
    sessionId,
    events: [],
  };
}

function fixture() {
  const run = vi.fn(async (_input: AgentHarnessInvocation) => result());
  const resume = vi.fn(
    async (input: AgentHarnessInvocation & { sessionId: string }) =>
      result(input.sessionId, 'steered'),
  );
  const resolveServers = vi.fn<NonNullable<AgentOptions['resolveServers']>>(
    async () => [],
  );
  const options: AgentOptions = {
    snapshotDir: join(dir, '.rocky'),
    cwd: dir,
    sessionDir: join(dir, 'sessions'),
    harness: 'opencode',
    harnesses: {
      opencode: { command: 'opencode', env: {}, sessionStorage: 'rocky' },
    },
    adapterFor: () => ({ run, resume }),
    resolveServers,
  };
  const journalPath = join(dir, 'journal.jsonl');
  const workflow: RunBootOptions['workflow'] = async (steps) => {
    await createAgent(steps, options)(
      { prompt: 'Work in the existing checkout.' },
      { label: 'worker', mcp: ['issues'] },
    );
    return 'completed';
  };
  return { run, resume, resolveServers, options, journalPath, workflow };
}

it.each([
  'before Steer history flush',
  'before resume invocation',
  'during MCP preparation',
])(
  'resumes durable known Steer intent after interruption %s',
  async (boundary) => {
    const f = fixture();
    const stop = new AbortController();
    f.options.signal = stop.signal;
    const turn = {
      id: 'human-1',
      note: '  Keep these words.\nContinue the same conversation.  ',
    };
    let delivery!: Promise<void>;
    let acknowledged = false;
    f.options.steer = {
      register(handle) {
        delivery = handle.steer(turn);
        void delivery.then(
          () => {
            acknowledged = true;
          },
          () => undefined,
        );
        return () => undefined;
      },
    };
    const crash = new Error(`interrupted ${boundary}`);
    let historyFlushed = false;
    const append: NonNullable<RunBootOptions['append']> = async (
      path,
      entry,
      options,
    ) => {
      const hasSteer = entry.attempts?.some(
        (attempt) => attempt.kind === 'steer',
      );
      if (boundary === 'before Steer history flush' && hasSteer) throw crash;
      if (boundary === 'before resume invocation' && historyFlushed)
        throw crash;
      await appendEntry(path, entry, options);
      if (hasSteer) historyFlushed = true;
    };
    if (boundary === 'during MCP preparation') {
      f.resolveServers.mockImplementationOnce(async () => []);
      f.resolveServers.mockImplementationOnce(async () => {
        // No Harness resume has begun: only the external preparation was interrupted.
        stop.abort(crash);
        throw crash;
      });
      expect(
        await runBoot({ ...f, append, signal: stop.signal }),
      ).toMatchObject({ status: 'cancelled' });
    } else {
      await expect(runBoot({ ...f, append })).rejects.toBe(crash);
    }
    await Promise.allSettled([delivery]);
    expect(acknowledged).toBe(boundary !== 'before Steer history flush');
    expect(f.run).toHaveBeenCalledOnce();
    expect(f.resume).not.toHaveBeenCalled();
    const interrupted = await openJournal(f.journalPath);
    expect(interrupted.end).toBeUndefined();
    expect(interrupted.latest(0)).toMatchObject({
      status: 'running',
      progress: { sessionId: 'original', turns: [turn] },
    });

    // A new Agent/runtime receives only the Journal, not the previous delivery queue.
    const next = fixture();
    next.run.mockResolvedValue(result('unexpected-cold-session'));
    expect(await runBoot(next)).toMatchObject({ status: 'finished', boot: 2 });
    expect
      .soft(next.run, 'known continuation must not cold-run before resuming')
      .not.toHaveBeenCalled();
    expect(next.resume).toHaveBeenCalledOnce();
    expect(next.resume.mock.calls[0]?.[0]).toMatchObject({
      sessionId: 'original',
      prompt: turn.note,
      transcriptPath: f.run.mock.calls[0]?.[0].transcriptPath,
    });
  },
);

it('cold-runs an arbitrarily interrupted resume on the retained worktree, then delivers its pending note', async () => {
  const f = fixture();
  const stop = new AbortController();
  f.options.signal = stop.signal;
  const turn = {
    id: 'human-2',
    note: '  Retain my pending note.\nDo not reset the checkout.',
  };
  let delivery!: Promise<void>;
  f.options.steer = {
    register(handle) {
      delivery = handle.steer(turn);
      return () => undefined;
    },
  };
  const priorArt = join(dir, 'unfinished.txt');
  f.resume.mockImplementationOnce(async () => {
    await writeFile(priorArt, 'edits left by the interrupted Harness');
    stop.abort(new Error('Harness process disappeared mid-turn'));
    throw stop.signal.reason;
  });
  expect(await runBoot({ ...f, signal: stop.signal })).toMatchObject({
    status: 'cancelled',
  });
  await delivery;
  expect(f.resume).toHaveBeenCalledOnce();
  expect((await openJournal(f.journalPath)).latest(0)).toMatchObject({
    status: 'running',
    progress: { turns: [turn] },
  });

  const next = fixture();
  next.run.mockImplementationOnce(async (input) => {
    expect(input.cwd).toBe(dir);
    expect(input).not.toHaveProperty('sessionId');
    expect(input.prompt).toContain('Work in the existing checkout.');
    expect(await readFile(priorArt, 'utf8')).toBe(
      'edits left by the interrupted Harness',
    );
    return result('cold-session');
  });
  expect(await runBoot(next)).toMatchObject({ status: 'finished', boot: 2 });
  expect(next.run).toHaveBeenCalledOnce();
  expect(next.resume).toHaveBeenCalledOnce();
  expect(next.resume.mock.calls[0]?.[0]).toMatchObject({
    sessionId: 'cold-session',
    prompt: turn.note,
  });
  expect(next.run.mock.calls[0]?.[0].transcriptPath).toBe(
    f.run.mock.calls[0]?.[0].transcriptPath,
  );
  expect((await openJournal(next.journalPath)).latest(0)).toMatchObject({
    status: 'done',
    progress: { turns: [], delivered: [turn.id] },
  });
});

it('retains an unacknowledged Steer in control storage when a cold Harness invocation crashes', async () => {
  const f = fixture();
  const stop = new AbortController();
  f.options.signal = stop.signal;
  const pending = new Map([
    [
      'human-3',
      { id: 'human-3', note: 'Words queued while the first turn was active.' },
    ],
  ]);
  const deliveries: Promise<void>[] = [];
  const steer: NonNullable<AgentOptions['steer']> = {
    register(handle) {
      for (const turn of pending.values()) {
        const delivery = handle.steer(turn).then(() => {
          pending.delete(turn.id);
        });
        void delivery.catch(() => undefined);
        deliveries.push(delivery);
      }
      return () => undefined;
    },
  };
  f.options.steer = steer;
  f.run.mockImplementationOnce(async () => {
    stop.abort(new Error('cold invocation interrupted'));
    throw stop.signal.reason;
  });
  expect(await runBoot({ ...f, signal: stop.signal })).toMatchObject({
    status: 'cancelled',
  });
  expect(await Promise.allSettled(deliveries)).toMatchObject([
    { status: 'rejected' },
  ]);
  expect(pending.size).toBe(1);

  const next = fixture();
  next.options.steer = steer;
  expect(await runBoot(next)).toMatchObject({ status: 'finished', boot: 2 });
  await Promise.all(deliveries.slice(1));
  expect(pending.size).toBe(0);
  expect(next.run).toHaveBeenCalledOnce();
  expect(next.resume.mock.calls[0]?.[0]).toMatchObject({
    sessionId: 'original',
    prompt: 'Words queued while the first turn was active.',
  });
});

it('gives nested parallel Agents distinct identities and Transcripts without leaking sessions to later Steps', async () => {
  const f = fixture();
  const handles: AgentContinuation[] = [];
  const unregister = vi.fn();
  f.options.steer = {
    register(handle) {
      handles.push(handle);
      return unregister;
    },
  };
  const release = deferred<void>();
  f.run.mockImplementation(async (input) => {
    await release.promise;
    return result(input.transcriptPath);
  });
  const workflow: RunBootOptions['workflow'] = async (steps) => {
    await steps.parallel('outer', [0, 1], {}, async (branch) => {
      await branch.parallel('inner', [0, 1], {}, async (leaf) => {
        await createAgent(leaf, f.options)(
          { prompt: 'Independent work.' },
          { label: 'same-label' },
        );
      });
    });
    await createAgent(steps, f.options)(
      { prompt: 'Later work.' },
      { label: 'same-label' },
    );
    return 'completed';
  };
  const boot = runBoot({ ...f, workflow });
  try {
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(4));
    expect(handles.map((handle) => handle.identity).sort()).toEqual([
      '0/0/0/0/0',
      '0/0/0/1/0',
      '0/1/0/0/0',
      '0/1/0/1/0',
    ]);
    expect(handles.map((handle) => handle.group).sort()).toEqual([
      '0/0/0',
      '0/0/0',
      '0/1/0',
      '0/1/0',
    ]);
    expect(
      new Set(f.run.mock.calls.map(([input]) => input.transcriptPath)).size,
    ).toBe(4);
  } finally {
    release.resolve();
    await boot;
  }
  expect(await boot).toMatchObject({ status: 'finished' });
  expect(handles[4]?.identity).toBe('1');
  expect(handles[4]?.group).toBeUndefined();
  expect(
    new Set(f.run.mock.calls.map(([input]) => input.transcriptPath)).size,
  ).toBe(5);
  expect(f.run.mock.calls.every(([input]) => !('sessionId' in input))).toBe(
    true,
  );
  expect(f.resume).not.toHaveBeenCalled();
  expect(unregister).toHaveBeenCalledTimes(5);
  expect(await runBoot({ ...f, workflow })).toMatchObject({
    status: 'finished',
  });
  expect(f.run).toHaveBeenCalledTimes(5);
  expect(handles).toHaveLength(5);
});

it('keeps the original attempt deadline across Steer and aborts an active resume with a real timer', async () => {
  // Only Date is faked: the remaining 200ms must actually abort the Harness.
  vi.useFakeTimers({ toFake: ['Date'] });
  const start = new Date('2026-09-07T12:00:00Z');
  vi.setSystemTime(start);
  const f = fixture();
  let delivery!: Promise<void>;
  f.options.steer = {
    register(handle) {
      delivery = handle.steer({
        id: 'deadline-steer',
        note: 'Continue without a new timeout.',
      });
      return () => undefined;
    },
  };
  f.run.mockImplementationOnce(async () => {
    vi.setSystemTime(start.getTime() + 800);
    return result();
  });
  f.resume.mockImplementationOnce(async (input) => {
    await new Promise<void>((resolve) => {
      input.signal!.addEventListener('abort', () => resolve(), { once: true });
      if (input.signal!.aborted) resolve();
    });
    throw input.signal!.reason;
  });
  const stopAfterTimeout = new Error(
    'stop after observing the first failed attempt',
  );
  const append: NonNullable<RunBootOptions['append']> = async (
    path,
    entry,
    options,
  ) => {
    await appendEntry(path, entry, options);
    // Stop at the public persistence boundary rather than waiting through retry backoff.
    if (entry.attempts?.some((attempt) => attempt.kind === 'failed'))
      throw stopAfterTimeout;
  };
  await expect(
    runBoot({
      ...f,
      append,
      workflow: async (steps) => {
        await createAgent(steps, f.options)(
          { prompt: 'Work.' },
          { label: 'deadline', timeout: 1000 },
        );
        return 'completed';
      },
    }),
  ).rejects.toBe(stopAfterTimeout);
  await delivery;
  expect(f.run.mock.calls[0]?.[0].timeoutMs).toBe(1000);
  expect(f.resume.mock.calls[0]?.[0].timeoutMs).toBe(200);
  expect(f.resume.mock.calls[0]?.[0].signal?.aborted).toBe(true);
  expect((await openJournal(f.journalPath)).latest(0)).toMatchObject({
    progress: {
      attempt: 1,
      startedAt: start.getTime(),
      deadline: start.getTime() + 1000,
    },
    attempts: [
      { kind: 'steer', attempt: 1 },
      {
        kind: 'failed',
        attempt: 1,
        error: { message: 'Agent attempt 1 timed out after 1000ms' },
      },
    ],
  });
}, 5000);

it('publishes progressive Harness events before the active invocation returns', async () => {
  const f = fixture();
  const finish = deferred<AgentHarnessResult>();
  const onEvent = vi.fn<NonNullable<AgentOptions['onEvent']>>();
  f.options.onEvent = onEvent;
  f.run.mockImplementationOnce(async () => finish.promise);
  let settled = false;
  const boot = runBoot(f).finally(() => {
    settled = true;
  });
  try {
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledOnce());
    const input = f.run.mock.calls[0]![0];
    input.onEvent!(
      { kind: 'text', text: 'Inspecting the checkout' },
      'stream-session',
    );
    expect(onEvent.mock.calls).toEqual([
      [
        '0',
        { kind: 'text', text: 'Inspecting the checkout' },
        'stream-session',
      ],
    ]);
    input.onEvent!({ kind: 'tool-call', name: 'read' }, 'stream-session');
    expect(onEvent).toHaveBeenNthCalledWith(
      2,
      '0',
      { kind: 'tool-call', name: 'read' },
      'stream-session',
    );
    expect(settled).toBe(false);
    expect((await openJournal(f.journalPath)).latest(0)?.status).toBe(
      'running',
    );
  } finally {
    finish.resolve(result('stream-session'));
    await boot;
  }
  expect(await boot).toMatchObject({ status: 'finished' });
  expect(onEvent).toHaveBeenCalledTimes(2);
});
