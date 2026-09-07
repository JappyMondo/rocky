import { createHmac } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { rockyPaths } from '../config/paths.js';
import { writeCredentials, writeInstanceConfig } from '../config/store.js';
import { createRepoContext } from '../repos/index.js';
import { openExecution, type ExecutionIntegration } from '../run/execution.js';
import { WorkflowRuntime } from '../run/lifecycle.js';
import { readJournal } from '../run/journal.js';
import { runDaemon } from './run-daemon.js';

it('connects signed delegation to admission and runBoot through the daemon lifecycle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rocky-production-composition-'));
  const paths = rockyPaths(root);
  const snapshotDir = join(root, 'prepared');
  await mkdir(snapshotDir);
  await writeFile(join(snapshotDir, 'workflow.ts'), 'fixture');
  await writeCredentials(paths, {
    repos: {},
    linear: { webhookSecret: 'fixture-only-secret' },
  });
  await writeInstanceConfig(paths, {
    repos: [
      { name: 'app', label: 'app', url: 'file:///app', baseBranch: 'main' },
    ],
  });
  let execution!: ExecutionIntegration;
  const daemon = await runDaemon({
    paths,
    port: 0,
    webRoot: false,
    handleSignals: false,
    compose: async ({ config }) => {
      execution = await openExecution({
        paths,
        config: () => config.current,
        repos: createRepoContext({ paths, identity: config.current.identity }),
        onRefusal: async (_request, message) => {
          throw new Error(message);
        },
        runtime: new WorkflowRuntime({
          paths,
          loadWorkflow: async () => async (ctx) => {
            await ctx.step('implemented', () => ctx.issue.title);
            return 'completed';
          },
        }),
        prepareSnapshot: async () => ({
          sourceCommit: 'immutable',
          snapshotDir,
          trigger: { kind: 'linear.onDelegate' },
        }),
      });
      return {
        execution,
        onAgentSessionEvent: async (event) => {
          if (!event.issueId)
            throw new Error(
              'A delegated Agent session must name its Linear issue',
            );
          await execution.delegate({
            requestId: event.sessionId,
            issue: {
              identifier: 'NG-598',
              title: 'Verified delegation',
              description: '',
              labels: ['app'],
              url: 'https://linear.app/issue/NG-598',
            },
            branch: 'ng-598',
            linear: {
              issueId: event.issueId,
              teamId: 'team',
              organizationId: event.organizationId,
              appUserId: event.appUserId,
              sessionId: event.sessionId,
            },
          });
        },
      };
    },
  });
  try {
    const body = JSON.stringify({
      type: 'AgentSessionEvent',
      action: 'created',
      appUserId: 'app',
      organizationId: 'org',
      agentSession: { id: 'session', issueId: 'issue' },
      webhookTimestamp: Date.now(),
    });
    const response = await fetch(`${daemon.url}/api/linear/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'linear-signature': createHmac('sha256', 'fixture-only-secret')
          .update(body)
          .digest('hex'),
      },
      body,
    });
    expect(response.status).toBe(200);
    await vi.waitFor(async () =>
      expect((await execution.scheduler.get('NG-598-1'))?.outcome).toBe(
        'completed',
      ),
    );
    expect(
      (await readJournal(paths.run('NG-598-1').journal)).latest(0)?.result,
    ).toBe('Verified delegation');
  } finally {
    await daemon.stop();
    await rm(root, { recursive: true, force: true });
  }
});

it('does not acknowledge and discard delegations when production intake is not wired', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rocky-no-intake-'));
  const daemon = await runDaemon({
    paths: rockyPaths(root),
    port: 0,
    webRoot: false,
    handleSignals: false,
  });
  try {
    const response = await fetch(`${daemon.url}/api/linear/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('Run admission is unavailable');
  } finally {
    await daemon.stop();
    await rm(root, { recursive: true, force: true });
  }
});
