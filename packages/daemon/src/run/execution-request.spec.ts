import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { rockyPaths } from '../config/paths.js';
import { createRepoContext } from '../repos/index.js';
import { newRunHeader } from './header.js';
import {
  createExecutionRequestHandler,
  type AgentSteerControl,
} from './execution.js';
import { JournalWriter } from './writer.js';

const { createWorkspace } = vi.hoisted(() => ({
  createWorkspace: vi.fn(),
}));

vi.mock('../repos/workspace.js', () => ({ createWorkspace }));

const roots: string[] = [];

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(agentSteer?: AgentSteerControl) {
  const root = await mkdtemp(join(tmpdir(), 'rocky-execution-request-'));
  roots.push(root);
  const paths = rockyPaths(root);
  const repos = createRepoContext({
    paths,
    identity: { name: 'Rocky', email: 'rocky@example.test' },
  });
  const run = newRunHeader({
    runId: 'NG-598-1',
    repo: 'app',
    branch: 'ng-598',
    issue: {
      identifier: 'NG-598',
      title: 'Execution request routing',
      description: '',
      url: 'https://linear.app/issue/NG-598',
      labels: ['app'],
    },
    now: '2026-09-07T00:00:00.000Z',
  });
  run.execution = {
    source: 'repository',
    sourceCommit: 'immutable-commit',
    trigger: { kind: 'linear.onDelegate' },
    members: [
      {
        name: 'app',
        path: 'app',
        lead: true,
        url: 'https://example.test/app.git',
        baseBranch: 'main',
      },
    ],
  };
  const getRun = vi.fn(async (runId: string) =>
    runId === run.runId ? run : undefined,
  );
  return {
    run,
    repos,
    getRun,
    handler: createExecutionRequestHandler(
      { paths, repos, agentSteer },
      getRun,
      JournalWriter.open,
    ),
  };
}

it('routes journal, workspace, and Agent Steer requests through the parent', async () => {
  const steer = {
    open: vi.fn(async () => undefined),
    take: vi.fn(async () => ({ ids: ['linear:1'], message: 'Continue.' })),
    delivered: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  } satisfies AgentSteerControl;
  const f = await fixture(steer);
  const execution = f.run.execution;
  if (!execution) throw new Error('Fixture must define frozen membership');
  const signal = new AbortController().signal;

  await expect(
    f.handler(
      f.run.runId,
      {
        kind: 'append',
        entry: {
          v: 1,
          seq: 0,
          step: 'step',
          status: 'running',
          boot: 1,
          startedAt: '2026-09-07T00:00:00.000Z',
        },
      },
      signal,
    ),
  ).resolves.toBeUndefined();
  await f.handler(
    f.run.runId,
    { kind: 'control-put', key: 'checkpoint', value: { decision: 'approve' } },
    signal,
  );
  await expect(
    f.handler(f.run.runId, { kind: 'control-get', key: 'checkpoint' }, signal),
  ).resolves.toEqual({ decision: 'approve' });

  await f.handler(
    f.run.runId,
    {
      kind: 'agent-steer-open',
      stepKey: '0/1',
      label: 'implementer',
      group: '0',
    },
    signal,
  );
  await f.handler(
    f.run.runId,
    { kind: 'agent-steer-take', stepKey: '0/1' },
    signal,
  );
  await f.handler(
    f.run.runId,
    {
      kind: 'agent-steer-delivered',
      stepKey: '0/1',
      ids: ['linear:1'],
    },
    signal,
  );
  await f.handler(
    f.run.runId,
    { kind: 'agent-steer-close', stepKey: '0/1' },
    signal,
  );
  await f.handler(
    f.run.runId,
    { kind: 'agent-steer-open', stepKey: '1', label: 'reviewer' },
    signal,
  );
  expect(steer.open).toHaveBeenCalledWith(f.run.runId, {
    stepKey: '0/1',
    label: 'implementer',
    group: '0',
  });
  expect(steer.open).toHaveBeenLastCalledWith(f.run.runId, {
    stepKey: '1',
    label: 'reviewer',
  });
  expect(steer.take).toHaveBeenCalledWith(f.run.runId, '0/1');
  expect(steer.delivered).toHaveBeenCalledWith(f.run.runId, '0/1', [
    'linear:1',
  ]);
  expect(steer.close).toHaveBeenCalledWith(f.run.runId, '0/1');

  const workspace = { dir: '/workspace' };
  createWorkspace.mockResolvedValue(workspace);
  await expect(
    f.handler(f.run.runId, { kind: 'workspace' }, signal),
  ).resolves.toBe(workspace);
  expect(createWorkspace).toHaveBeenCalledWith(f.repos, {
    runId: f.run.runId,
    branch: f.run.branch,
    lead: f.run.repo,
    members: execution.members,
  });
});

it('rejects aborted, unknown, incomplete, and unconfigured requests', async () => {
  const f = await fixture();
  const stopped = new AbortController();
  stopped.abort(new Error('Boot cancelled'));
  await expect(
    f.handler(f.run.runId, { kind: 'workspace' }, stopped.signal),
  ).rejects.toThrow('Boot cancelled');
  await expect(
    f.handler(
      'NG-598-unknown',
      { kind: 'workspace' },
      new AbortController().signal,
    ),
  ).rejects.toThrow('Unknown Run NG-598-unknown');
  await expect(
    f.handler(
      f.run.runId,
      { kind: 'agent-steer-open', stepKey: '0', label: 'worker' },
      new AbortController().signal,
    ),
  ).rejects.toThrow('Configure ExecutionOptions.agentSteer');
  await expect(
    f.handler(
      f.run.runId,
      { kind: 'agent-steer-take', stepKey: '0' },
      new AbortController().signal,
    ),
  ).rejects.toThrow('Configure ExecutionOptions.agentSteer');
  await expect(
    f.handler(
      f.run.runId,
      { kind: 'agent-steer-delivered', stepKey: '0', ids: ['linear:1'] },
      new AbortController().signal,
    ),
  ).rejects.toThrow('Configure ExecutionOptions.agentSteer');
  await expect(
    f.handler(
      f.run.runId,
      { kind: 'agent-steer-close', stepKey: '0' },
      new AbortController().signal,
    ),
  ).rejects.toThrow('Configure ExecutionOptions.agentSteer');
  f.run.execution = undefined;
  await expect(
    f.handler(f.run.runId, { kind: 'workspace' }, new AbortController().signal),
  ).rejects.toThrow('missing frozen repo membership');
});

it('routes a durable question identity and answer through the parent checkpoint control', async () => {
  const f = await fixture();
  const root = await mkdtemp(join(tmpdir(), 'rocky-question-request-'));
  roots.push(root);
  const checkpoint = vi.fn(async () => ({
    status: 'done',
    result: { decision: 'steer', message: 'Keep the existing behavior.' },
  }));
  const handler = createExecutionRequestHandler(
    { paths: rockyPaths(root), repos: f.repos, checkpoint },
    f.getRun,
    JournalWriter.open,
  );
  const request = {
    title: 'Which behavior?',
    body: 'Choose the scope.',
    kind: 'question' as const,
    digest: { diffStat: '', ci: '', unresolved: 0 },
  };
  await expect(
    handler(
      f.run.runId,
      { kind: 'checkpoint', stepKey: '2/0/1', request },
      new AbortController().signal,
    ),
  ).resolves.toEqual({
    status: 'done',
    result: { decision: 'steer', message: 'Keep the existing behavior.' },
  });
  expect(checkpoint).toHaveBeenCalledWith(f.run.runId, '2/0/1', request);
});
