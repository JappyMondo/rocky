import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { rockyPaths } from '../config/paths.js';
import { readRunHeader, readRunIndex, writeRunHeader } from './header.js';
import { RunScheduler } from './scheduler.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'rocky-admission-'));
  roots.push(root);
  const paths = rockyPaths(root);
  const scheduler = await RunScheduler.open({
    paths,
    boot: async () => ({
      status: 'parked',
      reason: 'checkpoint',
      boot: 1,
      replayed: 0,
      executed: 0,
    }),
  });
  return { root, paths, scheduler };
}

const input = {
  repo: 'rocky',
  issue: {
    identifier: 'NG-598',
    title: 'Load a Workflow',
    description: 'Frozen',
    url: 'https://linear.app/issue/NG-598',
    labels: ['rocky'],
  },
  branch: 'ng-598',
  trigger: 'linear.onDelegate',
};

it('prepares once across a delegation race and refuses a live manual Trigger before loading', async () => {
  const { scheduler } = await setup();
  const prepare = vi.fn(async () => input);
  const request = { issueIdentifier: 'NG-598', prepare };
  const [first, second] = await Promise.all([
    scheduler.admit(request),
    scheduler.admit(request),
  ]);
  expect(first.kind).toBe('started');
  expect(second).toEqual({ kind: 'nudged', run: first.run });
  await expect(scheduler.admit({ ...request, manual: true })).rejects.toThrow(
    'NG-598-1 is still live',
  );
  expect(prepare).toHaveBeenCalledTimes(1);
  await scheduler.close();
});

it('publishes the snapshot and metadata together and leaves no Run for a refused preparation', async () => {
  const { root, paths, scheduler } = await setup();
  await expect(
    scheduler.admit({
      issueIdentifier: 'NG-598',
      prepare: async () => {
        throw new Error('Fix workflow.ts');
      },
    }),
  ).rejects.toThrow('Fix workflow.ts');
  expect(await readRunIndex(paths, { strict: true })).toEqual([]);
  const snapshotDir = join(root, 'prepared');
  await mkdir(snapshotDir);
  await writeFile(join(snapshotDir, 'workflow.ts'), 'export default [];\n');
  const admitted = await scheduler.admit({
    issueIdentifier: 'NG-598',
    requestId: 'session-1',
    prepare: async () => ({
      ...input,
      snapshotDir,
      linear: {
        issueId: 'issue-uuid',
        teamId: 'team-uuid',
        organizationId: 'org-uuid',
        appUserId: 'app-uuid',
        sessionId: 'session-1',
      },
      execution: {
        source: 'repository',
        sourceCommit: 'abc123',
        trigger: { kind: 'linear.onDelegate' },
        members: [
          {
            name: 'rocky',
            path: 'rocky',
            lead: true,
            url: 'git@example.com:rocky',
            baseBranch: 'main',
          },
        ],
      },
    }),
  });
  expect(
    await readFile(
      join(paths.run(admitted.run.runId).snapshotDir, 'workflow.ts'),
      'utf8',
    ),
  ).toBe('export default [];\n');
  expect(await readRunHeader(paths, admitted.run.runId)).toEqual(admitted.run);
  await scheduler.close();
  await writeRunHeader(paths, {
    ...admitted.run,
    status: 'finished',
    outcome: 'merged',
  });
  const recovered = await RunScheduler.open({
    paths,
    boot: async () => {
      throw new Error('Not expected');
    },
  });
  const prepare = vi.fn(async () => input);
  const replayed = await recovered.admit({
    issueIdentifier: 'NG-598',
    requestId: 'session-1',
    prepare,
  });
  expect(replayed.kind).toBe('existing');
  expect(replayed.run.linear?.issueId).toBe('issue-uuid');
  expect(replayed.run.execution?.sourceCommit).toBe('abc123');
  expect(prepare).not.toHaveBeenCalled();
  await recovered.close();
});

it('lets unrelated admission progress during a slow import and cancels preparation on shutdown', async () => {
  const { scheduler, paths } = await setup();
  let begun!: () => void;
  const started = new Promise<void>((resolve) => {
    begun = resolve;
  });
  const slow = scheduler.admit({
    issueIdentifier: 'NG-598',
    prepare: async (_id, signal) => {
      begun();
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener(
          'abort',
          () => reject(new Error('Preparation aborted')),
          { once: true },
        ),
      );
      return input;
    },
  });
  const failed = expect(slow).rejects.toThrow('Preparation aborted');
  await started;
  expect(
    (
      await scheduler.delegate({
        ...input,
        issue: { ...input.issue, identifier: 'NG-599' },
      })
    ).kind,
  ).toBe('started');
  await scheduler.close();
  await failed;
  expect(
    (await readRunIndex(paths, { strict: true })).map(
      (run) => run.issue.identifier,
    ),
  ).toEqual(['NG-599']);
});
