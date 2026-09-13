import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { rockyPaths } from '../config/paths.js';
import {
  newRepositoryProfile,
  writeRepositoryProfile,
} from '../config/profiles.js';
import { parseInstanceConfig } from '../config/schema.js';
import { createRepoContext } from '../repos/index.js';
import { openExecution, type PreparedExecution } from './execution.js';

const { prepareProfileSnapshot, resolveSnapshotTrigger } = vi.hoisted(() => ({
  prepareProfileSnapshot: vi.fn(),
  resolveSnapshotTrigger: vi.fn(),
}));

vi.mock('./snapshot.js', () => ({
  prepareProfileSnapshot,
  resolveSnapshotTrigger,
}));

const roots: string[] = [];

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const request = {
  requestId: 'delegation-1',
  issue: {
    identifier: 'NG-598',
    title: 'Frozen title',
    description: 'Frozen text',
    url: 'https://linear.app/issue/NG-598',
    labels: ['app'],
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

async function fixture(
  onboarding?: (
    ...args: Parameters<
      NonNullable<Parameters<typeof openExecution>[0]['onboarding']>
    >
  ) => Promise<PreparedExecution>,
) {
  const root = await mkdtemp(join(tmpdir(), 'rocky-execution-default-'));
  roots.push(root);
  const paths = rockyPaths(root);
  const config = parseInstanceConfig({
    repos: [
      {
        name: 'app',
        label: 'app',
        url: 'https://example.test/app.git',
        baseBranch: 'main',
        profile: 'app',
      },
    ],
  });
  const runtime = {
    boot: vi.fn(async () => ({
      status: 'finished' as const,
      outcome: 'completed' as const,
      boot: 1,
      replayed: 0,
      executed: 0,
    })),
    kill: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  const onRefusal = vi.fn(async () => undefined);
  await writeRepositoryProfile(
    paths,
    newRepositoryProfile({ id: 'app', remote: 'https://example.test/app.git' }),
  );
  const execution = await openExecution({
    paths,
    config: () => config,
    repos: createRepoContext({ paths, identity: config.identity }),
    runtime,
    onRefusal,
    onboarding,
  });
  return { paths, runtime, onRefusal, execution, config };
}

it('builds and disposes the default immutable snapshot around admission', async () => {
  const f = await fixture();
  const snapshotDir = join(f.paths.root, 'snapshot');
  await mkdir(snapshotDir);
  prepareProfileSnapshot.mockResolvedValue({
    sourceCommit: 'immutable-commit',
    snapshotDir,
    triggers: [{ kind: 'linear.onDelegate' }],
  });
  resolveSnapshotTrigger.mockReturnValue({ kind: 'linear.onDelegate' });

  await expect(f.execution.delegate(request)).resolves.toMatchObject({
    kind: 'started',
    run: {
      execution: {
        sourceCommit: 'immutable-commit',
        trigger: { kind: 'linear.onDelegate' },
      },
    },
  });
  expect(prepareProfileSnapshot).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ name: 'app' }),
    expect.objectContaining({ id: 'app' }),
    { signal: expect.any(AbortSignal) },
  );
  expect(resolveSnapshotTrigger).toHaveBeenCalledWith(
    [{ kind: 'linear.onDelegate' }],
    { kind: 'linear.onDelegate' },
  );
  await expect(access(snapshotDir)).rejects.toMatchObject({ code: 'ENOENT' });
  const journal = await f.execution.journal('NG-598-1');
  await journal.put('control', { ready: true });
  await expect(journal.get('control')).resolves.toEqual({ ready: true });
  await f.execution.tick();
  await f.execution.close();
});

it('removes a partially prepared snapshot before publishing a Refusal', async () => {
  const f = await fixture();
  const snapshotDir = join(f.paths.root, 'broken-snapshot');
  await mkdir(snapshotDir);
  prepareProfileSnapshot.mockResolvedValue({
    sourceCommit: 'immutable-commit',
    snapshotDir,
    triggers: [{ kind: 'manual', name: 'repair' }],
  });
  resolveSnapshotTrigger.mockImplementation(() => {
    throw new Error('no delegation Trigger');
  });

  await expect(f.execution.delegate(request)).resolves.toMatchObject({
    kind: 'refused',
    message: expect.stringContaining('no delegation Trigger'),
  });
  expect(f.onRefusal).toHaveBeenCalledOnce();
  await expect(access(snapshotDir)).rejects.toMatchObject({ code: 'ENOENT' });
  await f.execution.close();
});

it('uses Onboarding only for its named missing-snapshot Refusal', async () => {
  const snapshotDir = await mkdtemp(
    join(tmpdir(), 'rocky-onboarding-snapshot-'),
  );
  roots.push(snapshotDir);
  const onboarding = vi.fn(async () => ({
    sourceCommit: 'onboarding-commit',
    snapshotDir,
    trigger: { kind: 'linear.onDelegate' as const },
    dispose: () => rm(snapshotDir, { recursive: true, force: true }),
  }));
  const f = await fixture(onboarding);
  prepareProfileSnapshot.mockRejectedValue(
    Object.assign(new Error('app/.rocky is missing'), {
      kind: 'onboarding-required',
    }),
  );

  await expect(f.execution.delegate(request)).resolves.toMatchObject({
    kind: 'started',
    run: { execution: { source: 'onboarding' } },
  });
  expect(f.onRefusal).toHaveBeenCalledWith(
    request,
    'Error: app/.rocky is missing',
  );
  expect(onboarding).toHaveBeenCalledWith(
    expect.objectContaining({ name: 'app' }),
    expect.any(AbortSignal),
  );
  await expect(access(snapshotDir)).rejects.toMatchObject({ code: 'ENOENT' });
  await f.execution.close();
});

it('names the Onboarding fix when no handler has been wired', async () => {
  const f = await fixture();
  prepareProfileSnapshot.mockRejectedValue(
    Object.assign(new Error('app/.rocky is missing'), {
      kind: 'onboarding-required',
    }),
  );

  await expect(f.execution.delegate(request)).resolves.toMatchObject({
    kind: 'refused',
    message: expect.stringContaining('Wire the built-in Onboarding Workflow'),
  });
  expect(f.onRefusal).toHaveBeenCalledOnce();
  await f.execution.close();
});

it('freezes Rocky defaults and profile overrides before the first clone and preserves them for replay', async () => {
  const f = await fixture();
  f.config.sourceControl = {
    git: { sshAgent: '/global-agent', signCommits: true },
    github: { configDir: '/global-gh' },
  };
  await writeRepositoryProfile(f.paths, {
    ...newRepositoryProfile({
      id: 'app',
      remote: 'https://example.test/app.git',
    }),
    sourceControl: {
      git: { sshKey: '/profile.pub', signCommits: false },
      github: { configDir: '/profile-gh' },
    },
  });
  const snapshotDir = join(f.paths.root, 'frozen-snapshot');
  await mkdir(snapshotDir);
  prepareProfileSnapshot.mockResolvedValue({
    sourceCommit: 'commit',
    snapshotDir,
    triggers: [{ kind: 'linear.onDelegate' }],
  });
  resolveSnapshotTrigger.mockReturnValue({ kind: 'linear.onDelegate' });
  try {
    const admitted = await f.execution.delegate(request);
    expect(admitted.kind).toBe('started');
    if (admitted.kind !== 'started') throw new Error('Admission failed');
    expect(admitted.run.profile?.sourceControl).toMatchObject({
      git: {
        sshAgent: '/global-agent',
        sshKey: '/profile.pub',
        signCommits: false,
      },
      github: { configDir: '/profile-gh' },
    });
    expect(prepareProfileSnapshot.mock.calls[0][0].env).toMatchObject({
      SSH_AUTH_SOCK: '/global-agent',
      GH_CONFIG_DIR: '/profile-gh',
      GH_TOKEN: undefined,
    });
    f.config.sourceControl.git = { sshAgent: '/changed' };
    expect(admitted.run.profile?.sourceControl?.git?.sshAgent).toBe(
      '/global-agent',
    );
  } finally {
    await f.execution.close();
  }
});
