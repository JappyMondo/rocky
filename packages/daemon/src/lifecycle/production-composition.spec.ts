import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';

import type { ConfigStore } from '../config/watcher.js';
import { rockyPaths } from '../config/paths.js';
import { parseInstanceConfig } from '../config/schema.js';
import { newRunHeader } from '../run/header.js';
import { JournalWriter } from '../run/writer.js';
import { LocalArtifacts } from '../local-api/artifacts.js';
import type { ReviewReport } from '@rocky/local-contracts';
import type { ExecutionIntegration } from '../run/execution.js';
import type { AgentSessionEvent } from '../linear/events.js';

const webhookPayload = {} as AgentSessionEvent['payload'];

const fakes = vi.hoisted(() => ({
  acknowledge: vi.fn(async () => ({ id: 'session-1', success: true })),
  controls: [] as Array<{
    answer: ReturnType<typeof vi.fn>;
    closeConversation: ReturnType<typeof vi.fn>;
    currentCheckpoint: ReturnType<typeof vi.fn>;
    delivered: ReturnType<typeof vi.fn>;
    openConversation: ReturnType<typeof vi.fn>;
    prompted: ReturnType<typeof vi.fn>;
    reconcile: ReturnType<typeof vi.fn>;
    steer: ReturnType<typeof vi.fn>;
    steers: ReturnType<typeof vi.fn>;
    takeSteers: ReturnType<typeof vi.fn>;
    options: {
      ended(): Promise<boolean>;
      wake(): void;
      cancel(): void;
      beforeElicitation(): Promise<void>;
    };
  }>,
  delegate: vi.fn(),
  issue: vi.fn(),
  comments: vi.fn<
    () => Promise<import('../linear/client.js').LinearCommentSummary[]>
  >(async () => []),
  openExecution: vi.fn(),
  postActivity: vi.fn(async () => ({ id: 'activity', success: true })),
}));

vi.mock('../linear/client.js', async (original) => ({
  ...(await original<typeof import('../linear/client.js')>()),
  RockyLinearClient: class {
    issue = fakes.issue;
    comments = fakes.comments;
    acknowledgeSession = fakes.acknowledge;
    postActivity = fakes.postActivity;
  },
}));
vi.mock('../linear/control.js', async (original) => ({
  ...(await original<typeof import('../linear/control.js')>()),
  LinearRunControl: class {
    options: {
      ended(): Promise<boolean>;
      wake(): void;
      cancel(): void;
      beforeElicitation(): Promise<void>;
    };
    checkpoint = vi.fn(async () => ({ status: 'waiting' }));
    reconcile = vi.fn(async () => undefined);
    prompted = vi.fn(async () => undefined);
    openConversation = vi.fn(async () => undefined);
    takeSteers = vi.fn(async () => undefined);
    delivered = vi.fn(async () => undefined);
    closeConversation = vi.fn(async () => undefined);
    currentCheckpoint = vi.fn(async () => ({
      stepKey: '0',
      generation: 'generation-1',
      title: 'Review',
      body: 'Continue?',
    }));
    answer = vi.fn(async () => ({
      kind: 'accepted' as const,
      answer: { decision: 'approve' as const },
    }));
    steer = vi.fn(async (input: { requestId: string; message: string }) => ({
      requestId: input.requestId,
      message: input.message,
      receivedAt: '2026-09-08T00:00:00.000Z',
      state: 'held' as const,
      targets: [],
    }));
    steers = vi.fn(async () => []);
    constructor(options: {
      ended(): Promise<boolean>;
      wake(): void;
      cancel(): void;
      beforeElicitation(): Promise<void>;
    }) {
      this.options = options;
      fakes.controls.push(this as unknown as (typeof fakes.controls)[number]);
    }
  },
}));
vi.mock('../run/execution.js', () => ({ openExecution: fakes.openExecution }));

import { createProductionComposition } from './production-composition.js';

const roots: string[] = [];

afterEach(async () => {
  fakes.acknowledge.mockClear();
  fakes.controls.splice(0);
  fakes.delegate.mockReset();
  fakes.issue.mockReset();
  fakes.comments.mockReset();
  fakes.comments.mockResolvedValue([]);
  fakes.openExecution.mockReset();
  fakes.postActivity.mockClear();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it('answers a legacy approval from its published non-ready recap before polling it again', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rocky-recap-checkpoint-'));
  roots.push(root);
  const paths = rockyPaths(root);
  const runId = 'TEST-1';
  const run = newRunHeader({
    runId,
    issue: {
      identifier: 'TEST',
      title: 'Complete a repository-neutral task',
      description: 'Keep the package usable.',
      labels: [],
      url: 'https://linear.example.test/issue/TEST',
    },
    branch: 'test',
    repo: 'fixture',
    trigger: 'linear.onDelegate',
    now: '2026-09-26T12:00:00.000Z',
  });
  const execution = {
    scheduler: {
      get: vi.fn(async () => run),
      list: vi.fn(async () => [run]),
      poll: vi.fn(),
      stop: vi.fn(),
    },
    journal: vi.fn(async () => ({})),
  };
  fakes.openExecution.mockResolvedValue(
    execution as unknown as ExecutionIntegration,
  );
  const config = {
    current: parseInstanceConfig({
      server: { host: '127.0.0.1', port: 7625 },
      repos: [
        {
          name: 'fixture',
          label: 'Fixture',
          url: 'https://github.com/example/fixture.git',
          baseBranch: 'main',
        },
      ],
    }),
  } as ConfigStore;
  const runPaths = paths.run(runId);
  await mkdir(runPaths.snapshotDir, { recursive: true });
  await writeFile(
    join(runPaths.snapshotDir, 'workflow.json'),
    JSON.stringify({
      settings: {},
      nodes: [{ type: 'delivery.approval' }],
    }),
  );
  const reportId = `r_${'a'.repeat(32)}`;
  const headSha = 'b'.repeat(40);
  const report: ReviewReport = {
    id: reportId,
    runId,
    createdAt: '2026-09-26T12:00:00.000Z',
    title: 'Package review',
    summary: 'The package still needs a check.',
    decision: {
      status: 'needs-attention',
      summary: 'Installation has not been checked.',
      actions: ['Run the install check.'],
    },
    problems: [{ problem: 'Missing check', solution: 'Run it.' }],
    diagrams: [],
    verification: [],
    limitations: [],
    visuallyReviewable: false,
    visuals: [],
    pr: {
      repo: 'fixture',
      number: 12,
      url: 'https://github.com/example/fixture/pull/12',
      headSha,
      baseSha: 'c'.repeat(40),
    },
  };
  await new LocalArtifacts(paths).saveReport(runId, report);
  await (
    await JournalWriter.open(runPaths.journal)
  ).append({
    v: 1,
    seq: 0,
    step: 'reviewReport.publish',
    status: 'done',
    result: { reportId, headSha },
    boot: 1,
    startedAt: '2026-09-26T12:00:00.000Z',
  });
  const composition = await createProductionComposition({ paths, config });
  const options = fakes.openExecution.mock.calls[0]?.[0];
  await expect(
    options.checkpoint(runId, '0', {
      title: 'Approve this change?',
      body: 'Review the change.',
    }),
  ).resolves.toEqual({ status: 'waiting' });
  expect(fakes.controls[0]?.answer).toHaveBeenCalledWith({
    stepKey: '0',
    generation: 'generation-1',
    requestId: 'legacy-recap:generation-1',
    answer: {
      decision: 'steer',
      message: expect.stringContaining('Installation has not been checked.'),
    },
  });
  await composition.close();
});

it('hydrates a signed delegation, isolates foreign prompts, and exposes durable local control', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rocky-production-boundary-'));
  roots.push(root);
  const paths = rockyPaths(root);
  const run = newRunHeader({
    runId: 'NG-700-1',
    issue: {
      identifier: 'NG-700',
      title: 'Hydrated issue',
      description: 'immutable description',
      labels: ['rocky'],
      url: 'https://linear.app/issue/NG-700',
    },
    branch: 'ng-700',
    repo: 'rocky',
    trigger: 'linear.onDelegate',
    now: '2026-09-08T00:00:00.000Z',
  });
  run.linear = {
    issueId: 'issue-1',
    teamId: 'team-1',
    organizationId: 'organization-1',
    appUserId: 'app-user-1',
    sessionId: 'session-1',
  };
  const execution = {
    delegate: fakes.delegate,
    manual: vi.fn(async () => ({ kind: 'started' as const, run })),
    scheduler: {
      get: vi.fn(async () => run),
      list: vi.fn(async () => [run]),
      recoverSession: vi.fn(async () => run),
      poll: vi.fn(),
      stop: vi.fn(),
    },
    journal: vi.fn(async () => ({ read: async () => ({ entries: [] }) })),
  };
  fakes.openExecution.mockResolvedValue(
    execution as unknown as ExecutionIntegration,
  );
  fakes.issue.mockResolvedValue({
    id: 'issue-1',
    identifier: 'NG-700',
    title: 'Hydrated issue',
    description: 'immutable description',
    labels: ['rocky'],
    url: 'https://linear.app/issue/NG-700',
    teamId: 'team-1',
  });
  const comments = [
    {
      id: 'answer',
      issueId: 'issue-1',
      body: 'Whole platform; deliver in a Linear comment, no PR.',
      createdAt: '2026-09-07T00:00:00Z',
      userId: 'human',
      sessionId: null,
      parentId: 'previous-session-thread',
    },
  ];
  fakes.comments.mockResolvedValue(comments);
  fakes.delegate.mockResolvedValue({ kind: 'admitted', run });
  const config = {
    current: parseInstanceConfig({
      server: { host: '127.0.0.1', port: 7625 },
      repos: [
        {
          name: 'rocky',
          label: 'rocky',
          url: 'https://github.com/JappyMondo/rocky.git',
          baseBranch: 'main',
        },
      ],
    }),
    readCredentials: async () => ({ repos: {} }),
  } as unknown as ConfigStore;
  const composition = await createProductionComposition({
    paths,
    config,
    localOrigin: 'https://rocky.example.test',
  });

  const options = fakes.openExecution.mock.calls[0]?.[0];
  expect(options).toEqual(
    expect.objectContaining({
      onboarding: expect.any(Function),
      agentSteer: expect.objectContaining({ open: expect.any(Function) }),
    }),
  );
  const prepared = await options.onboarding(
    { name: 'rocky' },
    new AbortController().signal,
  );
  expect(prepared).toMatchObject({ sourceCommit: 'onboarding' });
  await prepared.dispose();
  await options.onRefusal(
    { linear: { sessionId: 'session-1' } },
    'A preflight check refused this Run.',
  );
  expect(fakes.postActivity).toHaveBeenCalledWith(
    expect.objectContaining({ sessionId: 'session-1' }),
  );

  await composition.onAgentSessionEvent({
    action: 'created',
    sessionId: 'session-1',
    issueId: 'issue-1',
    appUserId: 'app-user-1',
    organizationId: 'organization-1',
    payload: webhookPayload,
  });
  expect(fakes.delegate).toHaveBeenCalledWith(
    expect.objectContaining({
      branch: 'rocky-ng-700',
      issue: expect.objectContaining({
        identifier: 'NG-700',
        description: 'immutable description',
        comments,
      }),
    }),
  );
  expect(fakes.acknowledge).toHaveBeenCalledWith(
    'session-1',
    'https://rocky.example.test/runs/NG-700-1',
  );
  const control = fakes.controls[0];
  if (!control) throw new Error('expected a Linear control');
  await options.agentSteer.open('NG-700-1', {
    stepKey: '0',
    label: 'worker',
    group: 'parallel',
  });
  await options.agentSteer.take('NG-700-1', '0');
  await options.agentSteer.delivered('NG-700-1', '0', ['receipt-1']);
  await options.agentSteer.close('NG-700-1', '0');
  await control.options.beforeElicitation();
  control.options.wake();
  control.options.cancel();
  expect(await control.options.ended()).toBe(false);
  await composition.onAgentSessionEvent({
    action: 'prompted',
    sessionId: 'session-1',
    appUserId: 'app-user-1',
    organizationId: 'organization-1',
    payload: webhookPayload,
  });
  expect(control.prompted).toHaveBeenCalled();
  await expect(
    composition.onAgentSessionEvent({
      action: 'prompted',
      sessionId: 'session-1',
      appUserId: 'other-app',
      organizationId: 'organization-1',
      payload: webhookPayload,
    }),
  ).rejects.toThrow(/does not belong/);
  await expect(
    composition.onAgentSessionEvent({
      action: 'created',
      sessionId: 'session-2',
      appUserId: 'app-user-1',
      organizationId: 'organization-1',
      payload: webhookPayload,
    }),
  ).rejects.toThrow(/must name/);

  const app = fastify();
  await composition.registerLocalApi(app);
  const tailnetHeaders = {
    host: 'rocky.tail123.ts.net:7625',
    origin: 'https://rocky.tail123.ts.net:7625',
  };
  expect(
    (await app.inject({ url: '/api/runs', headers: tailnetHeaders }))
      .statusCode,
  ).toBe(403);
  config.current.server.tailscaleOrigin = tailnetHeaders.origin;
  expect(
    (await app.inject({ url: '/api/runs', headers: tailnetHeaders }))
      .statusCode,
  ).toBe(200);
  delete config.current.server.tailscaleOrigin;
  expect(
    (await app.inject({ url: '/api/runs', headers: tailnetHeaders }))
      .statusCode,
  ).toBe(403);
  const manual = await app.inject({
    method: 'POST',
    url: '/api/triggers',
    payload: { trigger: 'start', issue: 'NG-700' },
  });
  expect(manual.statusCode).toBe(201);
  expect(execution.manual).toHaveBeenCalledWith(
    'start',
    expect.objectContaining({
      branch: 'rocky-ng-700',
      issue: expect.objectContaining({ comments }),
    }),
  );
  expect(fakes.comments).toHaveBeenCalledWith('issue-1');
  fakes.comments.mockRejectedValueOnce(new Error('Comments unavailable'));
  const callsBeforeFailure = fakes.delegate.mock.calls.length;
  await expect(
    composition.onAgentSessionEvent({
      action: 'created',
      sessionId: 'new-session',
      issueId: 'issue-1',
      appUserId: 'app-user-1',
      organizationId: 'organization-1',
      payload: webhookPayload,
    }),
  ).rejects.toThrow('Comments unavailable');
  expect(fakes.delegate).toHaveBeenCalledTimes(callsBeforeFailure);

  const answer = await app.inject({
    method: 'POST',
    url: '/api/runs/NG-700-1/answer',
    payload: {
      stepKey: '0',
      generation: 'generation-1',
      answer: { decision: 'approve' },
    },
  });
  expect(answer.statusCode).toBe(200);
  const steer = await app.inject({
    method: 'POST',
    url: '/api/runs/NG-700-1/steer',
    payload: {
      requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      message: 'Continue carefully.',
    },
  });
  expect(steer.json()).toMatchObject({ state: 'held' });
  run.status = 'failed';
  const recovery = await app.inject({
    method: 'POST',
    url: '/api/runs/NG-700-1/recover-session',
  });
  expect(recovery.statusCode).toBe(200);
  expect(recovery.json()).toEqual({
    runId: 'NG-700-1',
    issueIdentifier: 'NG-700',
    sessionId: 'session-1',
  });
  expect(execution.scheduler.recoverSession).toHaveBeenCalledWith('NG-700-1');
  expect(control.answer).toHaveBeenCalledWith(
    expect.objectContaining({ answer: { decision: 'approve' } }),
  );
  execution.scheduler.get.mockResolvedValueOnce({
    ...run,
    runId: 'local-run',
    linear: undefined,
  });
  await expect(
    options.checkpoint('local-run', '2', {
      title: 'Clarify',
      body: 'Which behavior?',
    }),
  ).resolves.toEqual({ status: 'waiting' });
  expect(fakes.controls.at(-1)?.options).toMatchObject({
    runId: 'local-run',
    sessionId: undefined,
  });
  await app.close();
  await composition.close();
});

it('loads the failed Run and its durable Steps after the journal writer has latched an error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rocky-failed-run-view-'));
  roots.push(root);
  const paths = rockyPaths(root);
  const run = newRunHeader({
    runId: 'NG-692-4',
    issue: {
      identifier: 'NG-692',
      title: 'Clarify scope',
      description: '',
      labels: [],
      url: 'https://linear.app/issue/NG-692',
    },
    branch: 'ng-692',
    repo: 'rocky',
    trigger: 'linear.onDelegate',
    now: '2026-09-11T09:00:00Z',
  });
  run.status = 'failed';
  run.error = { name: 'Error', message: 'Question could not be saved' };
  run.linear = {
    issueId: 'issue',
    teamId: 'team',
    organizationId: 'org',
    appUserId: 'app',
    sessionId: 'session',
  };
  const path = paths.run(run.runId).journal;
  const writer = await JournalWriter.open(path);
  await writer.append({
    v: 1,
    seq: 0,
    step: 'question',
    label: 'Clarify scope',
    status: 'running',
    boot: 1,
    startedAt: '2026-09-11T09:00:00Z',
  });
  await expect(
    writer.put('linear:control', { checkpoints: [{ options: undefined }] }),
  ).rejects.toThrow();
  const before = await readFile(path, 'utf8');
  const execution = {
    scheduler: { get: async () => run, list: async () => [run] },
    journal: async () => writer,
  };
  fakes.openExecution.mockResolvedValue(
    execution as unknown as ExecutionIntegration,
  );
  const config = { current: parseInstanceConfig({}) } as ConfigStore;
  const composition = await createProductionComposition({ paths, config });
  const app = fastify();
  try {
    await composition.registerLocalApi(app);
    const response = await app.inject('/api/runs/NG-692-4');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      run: { runId: 'NG-692-4', status: 'failed', error: run.error },
      steps: [{ step: 'question', label: 'Clarify scope' }],
      steers: [],
    });
    await expect(writer.put('later', true)).rejects.toThrow();
    expect(await readFile(path, 'utf8')).toBe(before);
  } finally {
    await app.close();
    await composition.close();
  }
});
