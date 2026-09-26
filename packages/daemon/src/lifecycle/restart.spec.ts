import { expect, it, vi } from 'vitest';
import { restartRun } from './restart.js';
import { newRunHeader } from '../run/header.js';

function fixture() {
  const issue = {
    identifier: 'TEST-1',
    title: 'Repair',
    description: 'Original',
    labels: [],
    url: 'https://example.test/TEST-1',
  };
  const run = newRunHeader({
    runId: 'TEST-1-1',
    repo: 'app',
    branch: 'existing-issue-branch',
    issue,
    trigger: 'linear.onDelegate',
    now: '2026-09-25T00:00:00Z',
  });
  run.status = 'failed';
  run.boots = 3;
  const delegate = vi.fn(async () => ({
    kind: 'started' as const,
    run: { ...run, runId: 'TEST-1-2', status: 'queued' as const },
  }));
  const execution = {
    scheduler: { get: vi.fn(async () => run), list: vi.fn(async () => [run]) },
    delegate,
  };
  const hydrate = vi.fn(async () => ({
    ...issue,
    id: 'issue-id',
    teamId: 'team',
    description: 'Current',
    comments: [],
  }));
  return { run, execution, hydrate };
}
it('restarts a failed run with current issue content and the retained branch, without copying its journal', async () => {
  const f = fixture();
  expect(
    await restartRun(f.execution, f.hydrate, f.run.runId, {
      expectedBoot: 3,
      requestId: 'request',
    }),
  ).toEqual({ runId: 'TEST-1-2', previousRunId: 'TEST-1-1' });
  expect(f.execution.delegate).toHaveBeenCalledWith(
    expect.objectContaining({
      branch: 'existing-issue-branch',
      issue: expect.objectContaining({ description: 'Current' }),
      requestId: 'restart:TEST-1-1:request',
    }),
  );
  expect(f.run.status).toBe('failed');
});
it.each(['running', 'cancelled', 'finished'] as const)(
  'refuses restarting %s work',
  async (status) => {
    const f = fixture();
    f.run.status = status;
    await expect(
      restartRun(f.execution, f.hydrate, f.run.runId, {
        expectedBoot: 3,
        requestId: 'request',
      }),
    ).rejects.toThrow();
    expect(f.execution.delegate).not.toHaveBeenCalled();
  },
);
it('returns the same successor for a repeated request and rejects another newer run', async () => {
  const f = fixture();
  const successor = {
    ...f.run,
    runId: 'TEST-1-2',
    admissionId: 'restart:TEST-1-1:request',
  };
  f.execution.scheduler.list.mockResolvedValue([f.run, successor]);
  expect(
    await restartRun(f.execution, f.hydrate, f.run.runId, {
      expectedBoot: 3,
      requestId: 'request',
    }),
  ).toMatchObject({ runId: 'TEST-1-2' });
  await expect(
    restartRun(f.execution, f.hydrate, f.run.runId, {
      expectedBoot: 3,
      requestId: 'other',
    }),
  ).rejects.toThrow('newer');
});
it('rejects stale boots and changed issue identity', async () => {
  const f = fixture();
  await expect(
    restartRun(f.execution, f.hydrate, f.run.runId, {
      expectedBoot: 2,
      requestId: 'request',
    }),
  ).rejects.toThrow('Refresh');
  f.hydrate.mockResolvedValue({
    ...(await f.hydrate()),
    url: 'https://other.test/issue',
  });
  await expect(
    restartRun(f.execution, f.hydrate, f.run.runId, {
      expectedBoot: 3,
      requestId: 'request',
    }),
  ).rejects.toThrow('identity');
});
