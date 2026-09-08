import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { rockyPaths } from '../config/paths.js';
import { parseInstanceConfig as parseConfig } from '../config/schema.js';
import { createRepoContext } from '../repos/index.js';
import { openExecution } from './execution.js';
import { WorkflowRuntime } from './lifecycle.js';
import { openJournal } from './journal.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const request = {
  requestId: 'delegation-1',
  issue: {
    identifier: 'NG-598',
    title: 'Frozen title',
    description: 'Frozen text',
    url: 'https://linear.app/issue/NG-598',
    labels: ['group'],
  },
  branch: 'ng-598',
  team: 'NG',
  linear: {
    issueId: 'issue-id',
    teamId: 'team-id',
    organizationId: 'org-id',
    appUserId: 'app-id',
    sessionId: 'session-id',
  },
};

it('composes grouped delegation and manual admission through the real Boot and immutable metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rocky-execution-'));
  roots.push(root);
  const paths = rockyPaths(root);
  const config = parseConfig({
    repos: [
      { name: 'app', label: 'app', url: 'file:///app', baseBranch: 'main' },
      { name: 'api', label: 'api', url: 'file:///api', baseBranch: 'main' },
    ],
    groups: [
      {
        name: 'product',
        label: 'group',
        repos: ['app', 'api'],
        workflow: 'app',
      },
    ],
  });
  const snapshotDir = join(root, 'source');
  await mkdir(snapshotDir);
  await writeFile(join(snapshotDir, 'workflow.ts'), 'immutable');
  let answer = false;
  const runtime = new WorkflowRuntime({
    paths,
    loadWorkflow: async () => async (ctx, input) => {
      await ctx.step('group input', () => ({
        input,
        title: ctx.issue.title,
        hasMembersOnCtx: 'members' in ctx,
      }));
      await ctx.checkpoint({ title: 'Wait', body: 'Wait for a human' });
      return 'completed';
    },
    external: (_run, steps, signal) => ({
      checkpoint: async () => {
        expect(steps).toBeDefined();
        expect(signal.aborted).toBe(false);
        return answer
          ? {
              status: 'done' as const,
              result: { decision: 'approve' as const },
            }
          : { status: 'waiting' as const };
      },
    }),
  });
  const prepare = vi.fn(async () => ({
    sourceCommit: 'source-sha',
    snapshotDir,
    trigger: { kind: 'linear.onDelegate' as const },
  }));
  const refused = vi.fn(async () => undefined);
  const execution = await openExecution({
    paths,
    config: () => config,
    repos: createRepoContext({ paths, identity: config.identity }),
    runtime,
    prepareSnapshot: prepare,
    onRefusal: refused,
  });
  const first = await execution.delegate(request);
  expect(first.kind).toBe('started');
  if (first.kind === 'refused') throw new Error(first.message);
  await vi.waitFor(async () =>
    expect((await execution.scheduler.get(first.run.runId))?.status).toBe(
      'parked',
    ),
  );
  expect(
    (await openJournal(paths.run(first.run.runId).journal)).latest(0)?.result,
  ).toEqual({
    input: {
      members: [
        { name: 'app', path: 'app', lead: true },
        { name: 'api', path: 'api', lead: false },
      ],
    },
    title: 'Frozen title',
    hasMembersOnCtx: false,
  });
  expect(
    await execution.manual('repair', { ...request, requestId: 'manual-1' }),
  ).toMatchObject({
    kind: 'refused',
    message: expect.stringContaining(first.run.runId),
  });
  expect(prepare).toHaveBeenCalledTimes(1);
  answer = true;
  await execution.scheduler.poll(first.run.runId);
  await vi.waitFor(async () =>
    expect((await execution.scheduler.get(first.run.runId))?.status).toBe(
      'finished',
    ),
  );
  expect((await execution.scheduler.get(first.run.runId))?.outcome).toBe(
    'completed',
  );
  const next = await execution.manual('repair', {
    ...request,
    requestId: 'manual-2',
  });
  expect(next.kind).toBe('started');
  await expect(execution.journal('not-a-run')).rejects.toThrow(
    'Unknown Run not-a-run',
  );
  await execution.tick();
  await execution.close();
});

it('publishes a routing Refusal without preparing or admitting any Run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rocky-execution-refusal-'));
  roots.push(root);
  const paths = rockyPaths(root);
  const config = parseConfig({});
  const refused = vi.fn(async () => undefined);
  const prepare = vi.fn();
  const runtime = new WorkflowRuntime({
    paths,
    loadWorkflow: async () => {
      throw new Error('Must not load');
    },
  });
  const execution = await openExecution({
    paths,
    config: () => config,
    repos: createRepoContext({ paths, identity: config.identity }),
    runtime,
    prepareSnapshot: prepare,
    onRefusal: refused,
  });
  expect(await execution.delegate(request)).toMatchObject({
    kind: 'refused',
    message: expect.stringContaining('rocky repo add'),
  });
  expect(refused).toHaveBeenCalledTimes(1);
  expect(prepare).not.toHaveBeenCalled();
  expect(await execution.scheduler.get('NG-598-1')).toBeUndefined();
  await execution.close();
});
