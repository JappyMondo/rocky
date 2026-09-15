import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { rockyPaths } from '../config/paths.js';
import { parseInstanceConfig } from '../config/schema.js';
import { createRepoContext } from '../repos/index.js';
import { openExecution } from './execution.js';
import { newRunHeader, writeRunHeader } from './header.js';
import { JournalWriter } from './writer.js';
import { runBoot } from './replay.js';
import { prepareRetryWorkspace } from './retry-workspace.js';

vi.mock('./retry-workspace.js', () => ({
  prepareRetryWorkspace: vi.fn(async () => undefined),
}));

it.each([false, true])(
  'reopens delivery with preserved receipts (continuation=%s)',
  async (continueExhausted) => {
    vi.mocked(prepareRetryWorkspace).mockClear();
    const root = await mkdtemp(join(tmpdir(), 'rocky-execution-retry-'));
    const paths = rockyPaths(root);
    const config = parseInstanceConfig({});
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
    run.execution = {
      source: 'repository',
      sourceCommit: 'a'.repeat(40),
      trigger: { kind: 'linear.onDelegate' },
      members: [
        {
          name: 'repo',
          path: 'repo',
          lead: true,
          url: 'https://github.com/acme/repo.git',
          baseBranch: 'main',
        },
      ],
    };
    await mkdir(paths.run(run.runId).snapshotDir, { recursive: true });
    await writeFile(
      join(paths.run(run.runId).snapshotDir, 'workflow.json'),
      await readFile(
        new URL('../../content/.rocky/workflow.json', import.meta.url),
      ),
    );
    const path = paths.run(run.runId).journal;
    const terminalKey = `linear-mirror:${run.runId}:terminal`;
    const receipt = { id: 'frozen-publication', content: { body: 'Failed' } };
    const writer = await JournalWriter.open(path);
    await writer.put(terminalKey, receipt);
    await writer.put(`${terminalKey}:done`, true);
    await runBoot({
      journalPath: path,
      workflow: async () => {
        if (continueExhausted) return 'exhausted';
        throw new Error('delivery failed');
      },
    });
    await writeRunHeader(paths, {
      ...run,
      status: continueExhausted ? 'finished' : 'failed',
      ...(continueExhausted ? { outcome: 'exhausted' as const } : {}),
      boots: 1,
    });
    const execution = await openExecution({
      paths,
      config: () => config,
      repos: createRepoContext({ paths, identity: config.identity }),
      runtime: { boot: vi.fn(), kill: vi.fn(), close: vi.fn() },
      onRefusal: vi.fn(),
    });
    try {
      await execution.scheduler.retryStep(run.runId, {
        requestId: 'retry-finalization',
        stepKey: '0',
        expectedBoot: 1,
        ...(continueExhausted ? { continueExhausted: true as const } : {}),
      });
      expect(prepareRetryWorkspace).toHaveBeenCalledOnce();
      expect(prepareRetryWorkspace).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.any(Array),
        { continueExhausted: continueExhausted ? true : undefined },
      );
      expect((await execution.scheduler.get(run.runId))?.status).toBe('queued');
      const journal = await execution.journal(run.runId);
      expect(await journal.get(terminalKey)).toEqual(receipt);
      expect(await journal.get(`${terminalKey}:done`)).toBe(true);
      expect((await journal.read()).end).toBeUndefined();
      expect(await journal.get('review:continuations')).toBe(
        continueExhausted ? 1 : undefined,
      );
    } finally {
      await execution.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
