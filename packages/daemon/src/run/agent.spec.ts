import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createAgent,
  type AgentContinuation,
  type AgentHarnessInvocation,
  type AgentHarnessResult,
  type AgentOptions,
} from './agent.js';
import { runBoot } from './replay.js';
import { appendEntry, openJournal } from './journal.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rocky-agent-'));
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});

function fixture() {
  const run = vi.fn(
    async (_input: AgentHarnessInvocation): Promise<AgentHarnessResult> => ({
      text: '<result>{"count":2,"summary":"ready"}</result>',
      sessionId: 'session-1',
      events: [],
    }),
  );
  const resume = vi.fn(
    (input: AgentHarnessInvocation & { sessionId: string }) => run(input),
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
  return { run, resume, resolveServers, options };
}

it('returns the original schema fields plus summary and replays without a conversation', async () => {
  const f = fixture();
  const results: unknown[] = [];
  const workflow: Parameters<typeof runBoot>[0]['workflow'] = async (steps) => {
    results.push(
      await createAgent(steps, f.options)(
        { prompt: 'Count.' },
        {
          label: 'counter',
          schema: z.object({ count: z.number() }).refine((x) => x.count === 2),
          tools: ['read'],
          model: 'vendor/model',
          effort: 'high',
          input: { expected: 2 },
        },
      ),
    );
    return 'merged';
  };
  expect(
    await runBoot({ journalPath: join(dir, 'journal.jsonl'), workflow }),
  ).toMatchObject({ status: 'finished' });
  expect(results).toEqual([{ count: 2, summary: 'ready' }]);
  expect(f.run).toHaveBeenCalledOnce();
  expect(f.run.mock.calls[0]?.[0]).toMatchObject({
    capabilities: ['read'],
    model: 'vendor/model',
    effort: 'high',
  });
  await runBoot({ journalPath: join(dir, 'journal.jsonl'), workflow });
  expect(f.run).toHaveBeenCalledOnce();
});

it('nudges refinements twice in the same session, then burns three attempts with durable metadata', async () => {
  const f = fixture();
  f.run.mockImplementation(async () => ({
    text: '<result>{"count":1,"summary":"wrong"}</result>',
    sessionId: 'session-1',
    events: [],
    usage: { inputTokens: 12 },
  }));
  const boot = runBoot({
    journalPath: join(dir, 'journal.jsonl'),
    workflow: async (steps) => {
      await createAgent(steps, f.options)(
        { prompt: 'Count.' },
        {
          label: 'counter',
          schema: z
            .object({ count: z.number() })
            .refine((x) => x.count === 2, 'must equal two'),
        },
      );
      return 'merged';
    },
  });
  expect(await boot).toMatchObject({ status: 'failed' });
  expect(f.run).toHaveBeenCalledTimes(9);
  expect(f.resume).toHaveBeenCalledTimes(6);
  expect(f.resolveServers).toHaveBeenCalledTimes(9);
  const entry = (await openJournal(join(dir, 'journal.jsonl'))).latest(0);
  expect(entry?.attempts).toHaveLength(3);
  expect(entry?.attempts?.[0]).toMatchObject({
    kind: 'failed',
    sessionId: 'session-1',
    nudges: [
      { error: expect.stringContaining('must equal two') },
      { error: expect.stringContaining('must equal two') },
    ],
    usage: { inputTokens: 36 },
  });
});

it('holds a Steer until the turn settles, flushes its verbatim continuation, then resumes the same session', async () => {
  const f = fixture();
  let live!: AgentContinuation;
  let finish!: (value: AgentHarnessResult) => void;
  const unregister = vi.fn();
  f.options.steer = {
    register(handle) {
      live = handle;
      return unregister;
    },
  };
  f.run.mockImplementationOnce(
    async () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  f.resume.mockImplementation(async (input) => {
    expect(input.sessionId).toBe('original');
    expect(input.prompt).toBe('  Keep my spacing.\nDo not fork.');
    const entry = (await openJournal(join(dir, 'journal.jsonl'))).latest(0);
    expect(entry?.attempts).toMatchObject([
      { kind: 'steer', note: input.prompt },
    ]);
    return {
      text: '<result>{"summary":"steered"}</result>',
      sessionId: 'original',
      events: [],
    };
  });
  const boot = runBoot({
    journalPath: join(dir, 'journal.jsonl'),
    workflow: async (steps) => {
      expect(
        await createAgent(steps, f.options)(
          { prompt: 'Work.' },
          { label: 'worker' },
        ),
      ).toEqual({ summary: 'steered' });
      return 'merged';
    },
  });
  await vi.waitFor(() => expect(finish).toBeDefined());
  let acknowledged = false;
  const delivery = live
    .steer({ id: 'activity-1', note: '  Keep my spacing.\nDo not fork.' })
    .then(() => {
      acknowledged = true;
    });
  await new Promise((resolve) => setImmediate(resolve));
  expect(acknowledged).toBe(false);
  expect(f.resume).not.toHaveBeenCalled();
  finish({
    text: '<result>{"summary":"before"}</result>',
    sessionId: 'original',
    events: [],
  });
  expect(await boot).toMatchObject({ status: 'finished' });
  await delivery;
  expect(f.resume).toHaveBeenCalledOnce();
  expect(unregister).toHaveBeenCalledOnce();
});

it('acknowledges a pulled Steer batch only after persisting its same-session continuation', async () => {
  const f = fixture();
  const unregister = vi.fn();
  const take = vi
    .fn<NonNullable<NonNullable<AgentOptions['steer']>['take']>>()
    .mockResolvedValueOnce([
      {
        id: '["linear:one","local:two"]',
        ids: ['linear:one', 'local:two'],
        note: 'Keep the migration small.\n\nDo not reset the worktree.',
      },
    ])
    .mockResolvedValue([]);
  const delivered = vi.fn<
    NonNullable<NonNullable<AgentOptions['steer']>['delivered']>
  >(async (_handle, turns) => {
    const entry = (await openJournal(join(dir, 'journal.jsonl'))).latest(0);
    expect(entry?.attempts).toMatchObject([
      { kind: 'steer', note: turns[0]?.note, sessionId: 'initial-session' },
    ]);
  });
  f.options.steer = {
    async register() {
      return unregister;
    },
    take,
    delivered,
  };
  f.run.mockResolvedValueOnce({
    text: '<result>{"summary":"before"}</result>',
    sessionId: 'initial-session',
    events: [],
  });
  f.resume.mockImplementationOnce(async (input) => {
    expect(input.sessionId).toBe('initial-session');
    expect(input.prompt).toBe(
      'Keep the migration small.\n\nDo not reset the worktree.',
    );
    return {
      text: '<result>{"summary":"continued"}</result>',
      sessionId: input.sessionId,
      events: [],
    };
  });
  expect(
    await runBoot({
      journalPath: join(dir, 'journal.jsonl'),
      workflow: async (steps) => {
        await createAgent(steps, f.options)(
          { prompt: 'Work.' },
          { label: 'worker' },
        );
        return 'completed';
      },
    }),
  ).toMatchObject({ status: 'finished' });
  expect(delivered).toHaveBeenCalledWith(
    expect.objectContaining({ identity: '0' }),
    [
      expect.objectContaining({
        ids: ['linear:one', 'local:two'],
      }),
    ],
  );
  expect(unregister).toHaveBeenCalledOnce();
});

it('stops at a live Harness turn boundary before resuming the same session with a Steer', async () => {
  const f = fixture();
  let delivery!: Promise<void>;
  f.options.steer = {
    async register(handle) {
      delivery = handle.steer({
        id: 'boundary-steer',
        note: 'Keep the existing plan.',
      });
      return () => undefined;
    },
  };
  f.run.mockImplementationOnce(async (input) => {
    input.onEvent?.({ kind: 'turn-boundary' }, 'boundary-session');
    await new Promise<void>((_resolve, reject) => {
      input.signal?.addEventListener(
        'abort',
        () => reject(input.signal?.reason),
        {
          once: true,
        },
      );
    });
    throw new Error('unreachable');
  });
  f.resume.mockImplementationOnce(async (input) => {
    expect(input.sessionId).toBe('boundary-session');
    expect(input.prompt).toBe('Keep the existing plan.');
    return {
      text: '<result>{"summary":"continued"}</result>',
      sessionId: input.sessionId,
      events: [],
    };
  });
  const outcome = await runBoot({
    journalPath: join(dir, 'journal.jsonl'),
    workflow: async (steps) => {
      await createAgent(steps, f.options)(
        { prompt: 'Work.' },
        { label: 'worker' },
      );
      return 'completed';
    },
  });
  expect(outcome).toMatchObject({ status: 'finished' });
  await delivery;
  expect(f.resume).toHaveBeenCalledOnce();
  expect(
    (await openJournal(join(dir, 'journal.jsonl'))).latest(0)?.attempts,
  ).toMatchObject([
    {
      kind: 'steer',
      sessionId: 'boundary-session',
      note: 'Keep the existing plan.',
    },
  ]);
});

it('keeps full prompts and raw Harness output out of the Journal', async () => {
  const f = fixture();
  f.run.mockResolvedValueOnce({
    text: '<result>{"summary":"safe","private":"raw-model-output"}</result>',
    sessionId: 'private-session',
    events: [],
  });
  await runBoot({
    journalPath: join(dir, 'journal.jsonl'),
    workflow: async (steps) => {
      await createAgent(steps, f.options)(
        { prompt: 'private instruction' },
        { label: 'worker', input: { secret: 'private input' } },
      );
      return 'completed';
    },
  });
  const journal = JSON.stringify(
    (await openJournal(join(dir, 'journal.jsonl'))).entries,
  );
  expect(journal).not.toContain('private instruction');
  expect(journal).not.toContain('private input');
  expect(journal).not.toContain('raw-model-output');
});

it('fails a signed-out Harness without retries and retains the exact named fix on replay', async () => {
  const f = fixture();
  f.run.mockRejectedValue(
    Object.assign(new Error('Not signed in'), {
      retryable: false,
      fix: 'claude login',
    }),
  );
  const workflow: Parameters<typeof runBoot>[0]['workflow'] = async (steps) => {
    await createAgent(steps, f.options)(
      { prompt: 'Work.' },
      { label: 'worker' },
    );
    return 'merged';
  };
  const first = await runBoot({
    journalPath: join(dir, 'journal.jsonl'),
    workflow,
  });
  expect(first).toMatchObject({
    status: 'failed',
    error: { message: expect.stringContaining('claude login') },
  });
  expect(
    await runBoot({ journalPath: join(dir, 'journal.jsonl'), workflow }),
  ).toMatchObject({
    status: 'failed',
    error: first.status === 'failed' ? first.error : undefined,
  });
  expect(f.run).toHaveBeenCalledOnce();
});

it('prepares MCP before every resume and never journals resolved authorization', async () => {
  const f = fixture();
  const secret = 'test-private-bearer';
  f.resolveServers.mockImplementation(async () => [
    {
      name: 'api',
      config: {
        type: 'http',
        url: 'https://example.com',
        headers: { Authorization: secret },
      },
    },
  ]);
  f.run.mockResolvedValueOnce({
    text: 'invalid',
    sessionId: 'repair',
    events: [],
  });
  const outcome = await runBoot({
    journalPath: join(dir, 'journal.jsonl'),
    workflow: async (steps) => {
      await createAgent(steps, f.options)(
        { prompt: 'Work.' },
        { label: 'worker', mcp: ['api'] },
      );
      return 'merged';
    },
  });
  expect(outcome).toMatchObject({ status: 'finished' });
  expect(f.resolveServers).toHaveBeenCalledTimes(2);
  expect(f.resume).toHaveBeenCalledOnce();
  expect(
    JSON.stringify((await openJournal(join(dir, 'journal.jsonl'))).entries),
  ).not.toContain(secret);
});

it('reads named prose only from the snapshot and rejects frontmatter before invocation', async () => {
  const f = fixture();
  await mkdir(join(f.options.snapshotDir, 'agents'), { recursive: true });
  await writeFile(
    join(f.options.snapshotDir, 'agents', 'worker.md'),
    '---\nmodel: hidden\n---\nWork.',
  );
  const outcome = await runBoot({
    journalPath: join(dir, 'journal.jsonl'),
    workflow: async (steps) => {
      await createAgent(steps, f.options)('worker');
      return 'merged';
    },
  });
  expect(outcome).toMatchObject({
    status: 'failed',
    error: { message: expect.stringContaining('Remove frontmatter') },
  });
  expect(f.run).not.toHaveBeenCalled();
});

it('retains the retry number when interrupted immediately after recording a failed attempt', async () => {
  const f = fixture();
  f.run.mockRejectedValueOnce(new Error('stream died'));
  const crash = new Error('power loss after failed attempt flush');
  const workflow: Parameters<typeof runBoot>[0]['workflow'] = async (steps) => {
    await createAgent(steps, f.options)(
      { prompt: 'Work.' },
      { label: 'worker' },
    );
    return 'merged';
  };
  await expect(
    runBoot({
      journalPath: join(dir, 'journal.jsonl'),
      workflow,
      append: async (path, entry, options) => {
        await appendEntry(path, entry, options);
        if (entry.attempts?.length) throw crash;
      },
    }),
  ).rejects.toBe(crash);
  expect(
    await runBoot({ journalPath: join(dir, 'journal.jsonl'), workflow }),
  ).toMatchObject({ status: 'finished' });
  expect(
    (await openJournal(join(dir, 'journal.jsonl'))).latest(0)?.progress,
  ).toMatchObject({ attempt: 2 });
});

it('kills a wedged invocation at the override and retries timeout as a fresh attempt', async () => {
  const f = fixture();
  let aborted = false;
  f.run.mockImplementationOnce(
    async (input) =>
      new Promise((_resolve, reject) => {
        const signal = input.signal;
        if (!signal)
          throw new Error('Agent invocation must receive an AbortSignal');
        signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            reject(signal.reason);
          },
          { once: true },
        );
      }),
  );
  const outcome = await runBoot({
    journalPath: join(dir, 'journal.jsonl'),
    workflow: async (steps) => {
      await createAgent(steps, f.options)(
        { prompt: 'Work.' },
        { label: 'worker', timeout: 200 },
      );
      return 'merged';
    },
  });
  expect(outcome).toMatchObject({ status: 'finished' });
  expect(aborted).toBe(true);
  expect(f.run).toHaveBeenCalledTimes(2);
  expect(f.resume).not.toHaveBeenCalled();
  expect(
    (await openJournal(join(dir, 'journal.jsonl'))).latest(0)?.attempts,
  ).toMatchObject([
    {
      kind: 'failed',
      error: { message: 'Agent attempt 1 timed out after 200ms' },
    },
  ]);
});

it('fails MCP configuration before any Harness invocation without burning retries', async () => {
  const f = fixture();
  f.resolveServers.mockRejectedValue(
    new Error('Unknown MCP server browser; add it to .rocky/mcp.json'),
  );
  const outcome = await runBoot({
    journalPath: join(dir, 'journal.jsonl'),
    workflow: async (steps) => {
      await createAgent(steps, f.options)(
        { prompt: 'Work.' },
        { label: 'worker', mcp: ['browser'] },
      );
      return 'merged';
    },
  });
  expect(outcome).toMatchObject({
    status: 'failed',
    error: { message: expect.stringContaining('.rocky/mcp.json') },
  });
  expect(f.resolveServers).toHaveBeenCalledOnce();
  expect(f.run).not.toHaveBeenCalled();
});

it('requires summary without discarding strict object refinements', async () => {
  const f = fixture();
  f.run.mockResolvedValueOnce({
    text: '<result>{"count":2}</result>',
    sessionId: 'strict',
    events: [],
  });
  const outcome = await runBoot({
    journalPath: join(dir, 'journal.jsonl'),
    workflow: async (steps) => {
      expect(
        await createAgent(steps, f.options)(
          { prompt: 'Work.' },
          {
            label: 'worker',
            schema: z
              .strictObject({ count: z.number() })
              .refine((value) => value.count === 2),
          },
        ),
      ).toEqual({ count: 2, summary: 'ready' });
      return 'merged';
    },
  });
  expect(outcome).toMatchObject({ status: 'finished' });
  expect(f.resume).toHaveBeenCalledOnce();
});

it('a missing snapshot prompt is Run-fatal even when Workflow code catches it', async () => {
  const f = fixture();
  let touched = false;
  const outcome = await runBoot({
    journalPath: join(dir, 'journal.jsonl'),
    workflow: async (steps) => {
      try {
        await createAgent(steps, f.options)('missing');
      } catch {
        /* Workflow cannot waive a missing prompt. */
      }
      await steps.step('later', {}, async () => {
        touched = true;
        return { status: 'done', result: null };
      });
      return 'merged';
    },
  });
  expect(touched).toBe(false);
  expect(f.run).not.toHaveBeenCalled();
  expect(outcome).toMatchObject({
    status: 'failed',
    error: {
      message: expect.stringContaining(
        join(f.options.snapshotDir, 'agents', 'missing.md'),
      ),
    },
  });
});

it('names the Harness successor when no adapter has been integrated', async () => {
  const f = fixture();
  delete f.options.adapterFor;
  const outcome = await runBoot({
    journalPath: join(dir, 'harness-missing.jsonl'),
    workflow: async (steps) => {
      await createAgent(steps, f.options)(
        { prompt: 'Work.' },
        { label: 'worker' },
      );
      return 'completed';
    },
  });
  expect(outcome).toMatchObject({
    status: 'failed',
    error: { message: expect.stringContaining('Integrate Harness #20') },
  });
  expect(f.run).not.toHaveBeenCalled();
});

it('refuses unknown Harnesses and invalid timeouts before invoking', async () => {
  const f = fixture();
  f.options.adapterFor = () => undefined;
  const unknownHarness = await runBoot({
    journalPath: join(dir, 'unknown-harness.jsonl'),
    workflow: async (steps) => {
      await createAgent(steps, f.options)(
        { prompt: 'Work.' },
        { label: 'worker', harness: 'missing' },
      );
      return 'completed';
    },
  });
  expect(unknownHarness).toMatchObject({
    status: 'failed',
    error: { message: expect.stringContaining('Unknown Harness missing') },
  });

  f.options.adapterFor = () => ({ run: f.run, resume: f.resume });
  const invalidTimeout = await runBoot({
    journalPath: join(dir, 'invalid-timeout.jsonl'),
    workflow: async (steps) => {
      await createAgent(steps, f.options)(
        { prompt: 'Work.' },
        { label: 'worker', timeout: 0 },
      );
      return 'completed';
    },
  });
  expect(invalidTimeout).toMatchObject({
    status: 'failed',
    error: {
      message: expect.stringContaining(
        'Agent timeout must be a positive number of milliseconds',
      ),
    },
  });
  expect(f.run).not.toHaveBeenCalled();
});

it('uses the direct MCP resolver only when its required Run context exists', async () => {
  const empty = fixture();
  delete empty.options.resolveServers;
  await expect(
    runBoot({
      journalPath: join(dir, 'empty-mcp.jsonl'),
      workflow: async (steps) => {
        await createAgent(steps, empty.options)(
          { prompt: 'Work.' },
          { label: 'worker' },
        );
        return 'completed';
      },
    }),
  ).resolves.toMatchObject({ status: 'finished' });
  expect(empty.run.mock.calls[0]?.[0]?.mcpServers).toEqual([]);

  const missing = fixture();
  delete missing.options.resolveServers;
  const outcome = await runBoot({
    journalPath: join(dir, 'missing-mcp-context.jsonl'),
    workflow: async (steps) => {
      await createAgent(steps, missing.options)(
        { prompt: 'Work.' },
        { label: 'worker', mcp: ['browser'] },
      );
      return 'completed';
    },
  });
  expect(outcome).toMatchObject({
    status: 'failed',
    error: {
      message: expect.stringContaining('Configure a per-Boot MCP resolver'),
    },
  });
  expect(missing.run).not.toHaveBeenCalled();
});

it('does not let display callback failures affect a completed Agent', async () => {
  const f = fixture();
  f.options.onEvent = () => {
    throw new Error('display disconnected');
  };
  f.run.mockImplementationOnce(async (input) => {
    input.onEvent?.({ kind: 'text', text: 'Working.' }, 'session-1');
    return {
      text: '<result>{"summary":"finished"}</result>',
      sessionId: 'session-1',
      events: [],
    };
  });
  await expect(
    runBoot({
      journalPath: join(dir, 'display-failure.jsonl'),
      workflow: async (steps) => {
        await createAgent(steps, f.options)(
          { prompt: 'Work.' },
          { label: 'worker' },
        );
        return 'completed';
      },
    }),
  ).resolves.toMatchObject({ status: 'finished' });
});

it('coalesces queued Steers and acknowledges an already durable continuation', async () => {
  const f = fixture();
  let live!: AgentContinuation;
  let release!: (value: AgentHarnessResult) => void;
  const first = { id: 'first', note: 'Keep the existing plan.' };
  const second = { id: 'second', note: 'Also check the error path.' };
  const take = vi
    .fn<NonNullable<NonNullable<AgentOptions['steer']>['take']>>()
    .mockResolvedValueOnce([first])
    .mockResolvedValueOnce([first])
    .mockResolvedValue([]);
  const delivered = vi.fn<
    NonNullable<NonNullable<AgentOptions['steer']>['delivered']>
  >(async () => undefined);
  f.options.steer = {
    register(handle) {
      live = handle;
      return () => undefined;
    },
    take,
    delivered,
  };
  f.resume.mockImplementationOnce(
    async () =>
      new Promise<AgentHarnessResult>((resolve) => {
        release = resolve;
      }),
  );

  const boot = runBoot({
    journalPath: join(dir, 'coalesced-steers.jsonl'),
    workflow: async (steps) => {
      await createAgent(steps, f.options)(
        { prompt: 'Work.' },
        { label: 'worker' },
      );
      return 'completed';
    },
  });
  await vi.waitFor(() => expect(f.resume).toHaveBeenCalledOnce());
  await expect(live.steer(first)).resolves.toBeUndefined();
  const queued = live.steer(second);
  expect(live.steer(second)).toBe(queued);
  release({
    text: '<result>{"summary":"continued"}</result>',
    sessionId: 'session-1',
    events: [],
  });

  await expect(boot).resolves.toMatchObject({ status: 'finished' });
  await expect(queued).resolves.toBeUndefined();
  expect(delivered).toHaveBeenCalledWith(
    expect.objectContaining({ identity: '0' }),
    [first],
  );
});

it('requires a nonempty label for a named Agent prompt', async () => {
  const f = fixture();
  const outcome = await runBoot({
    journalPath: join(dir, 'inline-label.jsonl'),
    workflow: async (steps) => {
      await createAgent(steps, f.options)('');
      return 'completed';
    },
  });
  expect(outcome).toMatchObject({
    status: 'failed',
    error: { message: 'Agent Step requires a nonempty label' },
  });
  expect(f.run).not.toHaveBeenCalled();
});

it('cancels retry backoff through the active Run signal', async () => {
  const f = fixture();
  const controller = new AbortController();
  const stopped = new Error('Run stopped during Agent retry backoff');
  f.options.signal = controller.signal;
  f.run.mockRejectedValueOnce(new Error('temporary Harness disconnect'));
  const outcome = await runBoot({
    journalPath: join(dir, 'backoff-cancelled.jsonl'),
    signal: controller.signal,
    append: async (path, entry, options) => {
      await appendEntry(path, entry, options);
      if (entry.attempts?.some((attempt) => attempt.kind === 'failed'))
        controller.abort(stopped);
    },
    workflow: async (steps) => {
      await createAgent(steps, f.options)(
        { prompt: 'Work.' },
        { label: 'worker' },
      );
      return 'completed';
    },
  });
  expect(outcome).toMatchObject({ status: 'cancelled' });
  expect(f.run).toHaveBeenCalledOnce();
});
