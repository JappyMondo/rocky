import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Workflow } from '@rocky/sdk';
import { afterEach, expect, it, vi } from 'vitest';

import { rockyPaths } from '../config/paths.js';
import { newRepositoryProfile } from '../config/profiles.js';
import { parseInstanceConfig } from '../config/schema.js';
import { writeCredentials } from '../config/store.js';
import { appendEntry, readJournal } from './journal.js';
import { newRunHeader, writeRunHeader } from './header.js';
import {
  createProductionRuntime,
  type ProductionRuntimeOptions,
} from './production.js';
import type { AgentHarnessInvocation, AgentHarnessResult } from './agent.js';

const { loadSnapshotWorkflow } = vi.hoisted(() => ({
  loadSnapshotWorkflow: vi.fn(),
}));

vi.mock('./loading/loader.js', () => ({ loadSnapshotWorkflow }));

const roots: string[] = [];

afterEach(async () => {
  loadSnapshotWorkflow.mockReset();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it('passes snapshot Agent MCP configuration through the production Boot seam', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rocky-production-agent-'));
  roots.push(root);
  const paths = rockyPaths(root);
  const runId = 'NG-544-1';
  const runPaths = paths.run(runId);
  await mkdir(join(runPaths.snapshotDir, 'agents'), { recursive: true });
  await writeFile(
    join(runPaths.snapshotDir, 'agents', 'worker.md'),
    'Inspect.',
  );
  await writeFile(
    join(runPaths.snapshotDir, 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        api: {
          type: 'http',
          url: 'https://example.test/mcp',
          headers: { Authorization: 'Bearer snapshot-only-secret' },
        },
      },
    }),
  );
  await writeCredentials(paths, { repos: {} });

  const config = parseInstanceConfig({
    repos: [
      {
        name: 'app',
        label: 'app',
        url: 'https://example.test/app.git',
        baseBranch: 'main',
      },
    ],
    harnesses: {
      'claude-code': { command: 'claude-custom' },
      opencode: { sessionStorage: 'opencode' },
    },
  });
  const run = newRunHeader({
    runId,
    issue: {
      identifier: 'NG-544',
      title: 'Run an Agent',
      description: 'Frozen issue text',
      url: 'https://linear.app/issue/NG-544',
      labels: ['app'],
    },
    branch: 'ng-544-agent',
    repo: 'app',
    profile: newRepositoryProfile({
      id: 'app',
      remote: 'https://example.test/app.git',
    }),
    trigger: 'linear.onDelegate',
    now: '2026-09-07T00:00:00.000Z',
  });
  run.linear = {
    issueId: 'issue',
    teamId: 'team',
    organizationId: 'organization',
    appUserId: 'app-user',
    sessionId: 'session',
  };
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
  await writeRunHeader(paths, run);

  const invoke = vi.fn(
    async (_input: AgentHarnessInvocation): Promise<AgentHarnessResult> => ({
      text: '<result>{"summary":"inspected"}</result>',
      events: [],
      sessionId: 'agent-session',
    }),
  );
  const request: ProductionRuntimeOptions['request'] = async (message) => {
    if (message.kind === 'append') {
      await appendEntry(runPaths.journal, message.entry, message.options);
      return undefined;
    }
    if (message.kind === 'workspace') return undefined;
    throw new Error(`Unexpected Boot request ${message.kind}`);
  };
  const runtime = createProductionRuntime({
    paths,
    config: () => config,
    request,
    adapterFor: (name) =>
      name === 'claude-code' || name === 'opencode'
        ? {
            run: invoke,
            resume: async (input) => invoke(input),
          }
        : undefined,
  });

  const workflow: Workflow = async (ctx) => {
    await ctx.agent('worker', {
      label: 'default-harness',
      tools: ['read'],
    });
    await ctx.agent('worker', {
      label: 'worker',
      harness: 'opencode',
      tools: ['read'],
      mcp: ['api'],
    });
    return 'completed';
  };
  loadSnapshotWorkflow.mockResolvedValue(workflow);

  await expect(
    runtime.boot(run, 'run', new AbortController().signal),
  ).resolves.toMatchObject({ status: 'finished', outcome: 'completed' });
  expect(loadSnapshotWorkflow).toHaveBeenCalledWith(runPaths.snapshotDir, {
    kind: 'linear.onDelegate',
  });
  expect(invoke).toHaveBeenCalledWith(
    expect.objectContaining({
      capabilities: ['read'],
      mcpServers: [
        {
          name: 'api',
          config: {
            type: 'http',
            url: 'https://example.test/mcp',
            headers: { Authorization: 'Bearer snapshot-only-secret' },
          },
        },
      ],
      sessionStorage: 'opencode',
    }),
  );
  expect(invoke).toHaveBeenCalledWith(
    expect.objectContaining({
      command: 'claude-custom',
      sessionStorage: 'rocky',
    }),
  );
  expect(
    JSON.stringify((await readJournal(runPaths.journal)).entries),
  ).not.toContain('snapshot-only-secret');
});

it.each([
  { kind: 'execution', label: 'execution' },
  { kind: 'linear', label: 'Linear identity' },
])(
  'refuses a Run missing immutable $label before importing its Workflow',
  async ({ kind }) => {
    const root = await mkdtemp(join(tmpdir(), 'rocky-production-missing-'));
    roots.push(root);
    const paths = rockyPaths(root);
    const run = newRunHeader({
      runId: `NG-544-${kind}`,
      issue: {
        identifier: 'NG-544',
        title: 'Missing immutable metadata',
        description: '',
        url: 'https://linear.app/issue/NG-544',
        labels: [],
      },
      branch: 'ng-544-missing',
      repo: 'app',
      trigger: 'linear.onDelegate',
      now: '2026-09-07T00:00:00.000Z',
    });
    if (kind === 'execution') {
      run.linear = {
        issueId: 'issue',
        teamId: 'team',
        organizationId: 'organization',
        appUserId: 'app-user',
        sessionId: 'session',
      };
    } else {
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
    }
    await writeRunHeader(paths, run);
    const runtime = createProductionRuntime({
      paths,
      config: () => parseInstanceConfig({}),
      request: async () => undefined,
    });

    await expect(
      runtime.boot(run, 'run', new AbortController().signal),
    ).resolves.toMatchObject({
      status: 'failed',
      error: {
        message: expect.stringContaining('missing immutable execution'),
      },
    });
    expect(loadSnapshotWorkflow).not.toHaveBeenCalled();
    await runtime.close();
  },
);
