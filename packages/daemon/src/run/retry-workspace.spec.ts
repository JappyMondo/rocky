import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { rockyPaths } from '../config/paths.js';
import { KeyedMutex } from '../repos/mutex.js';
import { restoreRetryWorkspace } from '../repos/workspace.js';
import { newRunHeader } from './header.js';
import { prepareRetryWorkspace } from './retry-workspace.js';
import type { JournalEntry } from './journal.js';
vi.mock('../repos/workspace.js', () => ({
  restoreRetryWorkspace: vi.fn(async () => undefined),
}));
const roots: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
it('requires retained execution metadata, a snapshot, and a recorded revision for every member', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rocky-retry-workspace-'));
  roots.push(root);
  const paths = rockyPaths(root);
  const repos = {
    paths,
    mutex: new KeyedMutex(),
    identity: { name: 'Rocky', email: 'rocky@example.test' },
  };
  const run = newRunHeader({
    runId: 'NG-1-1',
    repo: 'repo',
    branch: 'issue',
    issue: {
      identifier: 'NG-1',
      title: '',
      description: '',
      url: '',
      labels: [],
    },
    now: '2026-09-11T10:00:00Z',
  });
  await expect(prepareRetryWorkspace(repos, run, [])).rejects.toThrow(
    /execution artifacts/,
  );
  run.execution = {
    source: 'repository',
    sourceCommit: 'a'.repeat(40),
    trigger: { kind: 'linear.onDelegate' },
    members: [
      {
        name: 'repo',
        path: 'repo',
        lead: true,
        url: 'https://example.test/repo.git',
        baseBranch: 'main',
      },
    ],
  };
  await expect(prepareRetryWorkspace(repos, run, [])).rejects.toThrow(
    /snapshot is missing/,
  );
  await mkdir(paths.run(run.runId).snapshotDir, { recursive: true });
  await expect(prepareRetryWorkspace(repos, run, [])).rejects.toThrow(
    /No recorded workspace/,
  );
  const entry: JournalEntry = {
    v: 1,
    seq: 0,
    step: 'workspace',
    status: 'done',
    boot: 1,
    startedAt: run.createdAt,
    result: { members: [] },
  };
  await expect(prepareRetryWorkspace(repos, run, [entry])).rejects.toThrow(
    /No recorded workspace revision/,
  );
  entry.result = { members: [{ repo: 'repo', head: 'b'.repeat(40) }] };
  await prepareRetryWorkspace(repos, run, [entry]);
  expect(restoreRetryWorkspace).toHaveBeenCalledWith(repos, {
    runId: run.runId,
    branch: 'issue',
    members: [{ name: 'repo', head: 'b'.repeat(40) }],
  });
  await expect(
    prepareRetryWorkspace(repos, { ...run, artifactsPruned: true }, [entry]),
  ).rejects.toThrow(/execution artifacts/);
});
