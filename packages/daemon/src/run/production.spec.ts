import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Workflow } from '@rocky/sdk';
import { afterEach, expect, it, vi } from 'vitest';

import { rockyPaths } from '../config/paths.js';
import {
  newRepositoryProfile,
  writeRepositoryProfile,
} from '../config/profiles.js';
import { parseInstanceConfig } from '../config/schema.js';
import { writeCredentials } from '../config/store.js';
import { appendEntry, readJournal } from './journal.js';
import { newRunHeader, writeRunHeader, readRunHeader } from './header.js';
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

it.each([false, true])(
  'passes snapshot MCP and refreshes current Git settings when available (%s)',
  async (refreshGit) => {
    const root = await mkdtemp(join(tmpdir(), 'rocky-production-agent-'));
    roots.push(root);
    const paths = rockyPaths(root);
    const runId = 'NG-544-1';
    const runPaths = paths.run(runId);
    await mkdir(runPaths.workspaceDir, { recursive: true });
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
    await writeCredentials(paths, {
      repos: { app: { BOT_GH: 'bot-gh-token' } },
    });

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
        'claude-code': {
          command: 'claude-custom',
          env: { GH_TOKEN: 'personal-token', SSH_AUTH_SOCK: '/personal-agent' },
        },
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
    if (!run.profile) throw new Error('Missing fixture profile');
    run.profile.sourceControl = {
      git: {
        sshAgent: '/snapshot-agent',
        signingFormat: 'ssh',
        signingKey: '/snapshot.pub',
      },
      github: { tokenEnv: 'BOT_GH' },
    };
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
    await writeRepositoryProfile(paths, run.profile);

    if (refreshGit) {
      config.sourceControl = {
        git: { name: 'Updated User', email: 'verified@example.test' },
      };
      const current = newRepositoryProfile({
        id: 'app',
        remote: 'https://example.test/app.git',
      });
      current.sourceControl = {
        git: { sshAgent: '/updated-agent' },
        github: { tokenEnv: 'BOT_GH' },
      };
      await writeRepositoryProfile(paths, current);
    }

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
      if (
        message.kind === 'control-get' &&
        ['review:continuations', 'retry:latest'].includes(message.key)
      )
        return 0;
      if (message.kind === 'workspace') return undefined;
      if (message.kind === 'control-get' && message.key === 'flow:repairs')
        return [];
      throw new Error(`Unexpected Boot request ${message.kind}`);
    };
    const runtime = createProductionRuntime({
      paths,
      config: () => config,
      request,
      adapterFor: (name) =>
        name === 'claude-code' || name === 'opencode' || name === 'codex'
          ? {
              run: invoke,
              resume: async (input) => invoke(input),
            }
          : undefined,
    });

    const workflow: Workflow = async (ctx) => {
      await ctx.agent('worker', {
        label: 'codex-worker',
        harness: 'codex',
        model: 'codex-model-verbatim',
        effort: 'xhigh',
        tools: ['read'],
      });
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
      if (refreshGit) {
        expect(
          (await ctx.exec('printf %s "$GIT_COMMITTER_EMAIL"')).stdout,
        ).toBe('verified@example.test');
      }
      return 'completed';
    };
    loadSnapshotWorkflow.mockResolvedValue(workflow);

    const outcome = await runtime.boot(
      run,
      'run',
      new AbortController().signal,
    );
    expect(outcome, JSON.stringify(outcome)).toMatchObject({
      status: 'finished',
      outcome: 'completed',
    });
    expect(loadSnapshotWorkflow).toHaveBeenCalledWith(
      runPaths.snapshotDir,
      {
        kind: 'linear.onDelegate',
      },
      0,
      [],
    );
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'codex',
        model: 'codex-model-verbatim',
        effort: 'xhigh',
        sessionStorage: 'codex',
      }),
    );
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
    const invocation = invoke.mock.calls.find(
      ([input]) => input.command === 'claude-custom',
    )?.[0];
    expect(invocation?.sessionStorage).toBe('rocky');
    expect(invocation?.env.GH_TOKEN).toBe('bot-gh-token');
    expect(invocation?.env.SSH_AUTH_SOCK).toBe(
      refreshGit ? '/updated-agent' : '/snapshot-agent',
    );
    if (refreshGit) {
      expect(invocation?.env.GIT_COMMITTER_EMAIL).toBe('verified@example.test');
      expect(invocation?.env.GIT_AUTHOR_EMAIL).toBe('verified@example.test');
    }
    expect((await readRunHeader(paths, runId)).profile?.sourceControl).toEqual(
      run.profile.sourceControl,
    );
    expect(
      JSON.stringify((await readJournal(runPaths.journal)).entries),
    ).not.toContain('snapshot-only-secret');
  },
);

it('loads the latest model selections into the workflow context on a retry Boot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rocky-production-models-'));
  roots.push(root);
  const paths = rockyPaths(root);
  const runId = 'NG-544-models';
  const source = [
    'export const models = { review: { name: "Review" } };',
    'export default [];',
  ].join('\n');
  const snapshotProfile = {
    ...newRepositoryProfile({
      id: 'app',
      remote: 'https://example.test/app.git',
    }),
    workflow: { source, triggers: [] },
    models: {
      review: {
        harness: 'opencode' as const,
        model: 'openai/old-model',
        effort: 'low',
      },
    },
  };
  const run = newRunHeader({
    runId,
    issue: {
      identifier: 'NG-544',
      title: 'Run an Agent',
      description: '',
      url: 'https://linear.app/issue/NG-544',
      labels: ['app'],
    },
    branch: 'ng-544-models',
    repo: 'app',
    profile: snapshotProfile,
    trigger: 'linear.onDelegate',
    now: '2026-09-15T00:00:00.000Z',
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
  await mkdir(paths.run(runId).workspaceDir, { recursive: true });
  await writeRunHeader(paths, run);
  await writeCredentials(paths, { repos: {} });

  const currentProfile = {
    ...snapshotProfile,
    models: {
      review: {
        harness: 'claude-code' as const,
        model: 'claude-current',
        effort: 'high',
      },
    },
  };
  await writeRepositoryProfile(paths, currentProfile);
  expect(run.profile?.models).toBeUndefined();

  const workflow: Workflow = async (ctx) => {
    expect(ctx.models.review).toEqual(currentProfile.models.review);
    return 'completed';
  };
  loadSnapshotWorkflow.mockResolvedValue(workflow);
  const runtime = createProductionRuntime({
    paths,
    config: () => parseInstanceConfig({}),
    request: async (message) => {
      if (message.kind === 'append') {
        await appendEntry(
          paths.run(runId).journal,
          message.entry,
          message.options,
        );
        return undefined;
      }
      if (message.kind === 'workspace') return undefined;
      if (message.kind === 'control-get') return 0;
      throw new Error(`Unexpected Boot request ${message.kind}`);
    },
  });
  try {
    await expect(
      runtime.boot(run, 'run', new AbortController().signal),
    ).resolves.toMatchObject({ status: 'finished', outcome: 'completed' });
    expect((await readRunHeader(paths, runId)).profile?.models).toBeUndefined();
  } finally {
    await runtime.close();
  }
});

it('refuses a Run missing immutable execution before importing its Workflow', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rocky-production-missing-'));
  roots.push(root);
  const paths = rockyPaths(root);
  const run = newRunHeader({
    runId: 'NG-544-execution',
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
  run.linear = {
    issueId: 'issue',
    teamId: 'team',
    organizationId: 'organization',
    appUserId: 'app-user',
    sessionId: 'session',
  };
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
});
