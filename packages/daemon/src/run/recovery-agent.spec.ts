import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { rockyPaths } from '../config/paths.js';
import { parseInstanceConfig } from '../config/schema.js';
import {
  newRepositoryProfile,
  writeRepositoryProfile,
} from '../config/profiles.js';
import { newRunHeader } from './header.js';
import { runBoot } from './replay.js';
import { JournalWriter } from './writer.js';
import { readJournal } from './journal.js';
import { recoverWithAgent, RECOVERY_VIEW_KEY } from './recovery-agent.js';
import type { AgentHarnessInvocation, AgentHarnessResult } from './agent.js';
import type { BootRequest } from './worker.js';
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'rocky-recovery-agent-'));
  roots.push(root);
  const paths = rockyPaths(root);
  const profile = newRepositoryProfile({
    id: 'app',
    remote: 'https://example.test/app.git',
  });
  profile.models = {
    implementation: {
      harness: 'opencode',
      model: 'test-model',
      effort: 'high',
    },
  };
  await writeRepositoryProfile(paths, profile);
  const run = newRunHeader({
    runId: 'NG-1-1',
    repo: 'app',
    branch: 'issue',
    profile,
    issue: {
      identifier: 'NG-1',
      title: 'Repair push',
      description: '',
      url: '',
      labels: [],
    },
    now: '2026-09-14T00:00:00Z',
  });
  const path = paths.run(run.runId).journal;
  await mkdir(paths.run(run.runId).workspaceDir, { recursive: true });
  await runBoot({
    journalPath: path,
    workflow: async (steps) => {
      await steps.step(
        'exec',
        { label: 'Completed preparation' },
        async () => ({ status: 'done', result: { summary: 'Commit ready' } }),
      );
      throw new Error('GitLab rejected rocky@localhost');
    },
  });
  const writer = await JournalWriter.open(path);
  await writer.retry(
    'recovery-request',
    '1',
    [],
    'Use the new Git identity and fix the unpublished commit.',
  );
  const request = async (message: BootRequest) => {
    if (message.kind === 'control-put')
      return writer.put(message.key, message.value);
    throw new Error(`Unexpected request ${message.kind}`);
  };
  const invoke = vi.fn(
    async (_input: AgentHarnessInvocation): Promise<AgentHarnessResult> => ({
      text: '<result>{"summary":"Repaired the unpublished committer identity."}</result>',
      events: [],
      sessionId: 'recovery-session',
    }),
  );
  return {
    paths,
    run,
    path,
    writer,
    invoke,
    options: {
      paths,
      run,
      request,
      config: parseInstanceConfig({
        identity: { name: 'New User', email: 'verified@example.test' },
      }),
      env: {},
      signal: new AbortController().signal,
      adapterFor: () => ({ run: invoke, resume: invoke }),
    },
  };
}
it('passes instructions, failure and current Git identity to an isolated durable agent', async () => {
  const f = await fixture();
  await recoverWithAgent(f.options);
  expect(f.invoke).toHaveBeenCalledOnce();
  const call = f.invoke.mock.calls[0][0];
  expect(call.prompt).toContain('Use the new Git identity');
  expect(call.prompt).toContain('GitLab rejected rocky@localhost');
  expect(call.prompt).toContain('Keep the failed operation separate');
  expect(call.prompt).toContain('Completed preparation');
  expect(call.prompt).toContain('verified@example.test');
  expect(call.cwd).toBe(f.paths.run(f.run.runId).workspaceDir);
  expect(call.capabilities).toEqual(['read', 'edit', 'bash']);
  expect(call.mcpServers).toEqual([]);
  expect(call.transcriptPath).toContain('/recovery/');
  expect(await f.writer.get(RECOVERY_VIEW_KEY)).toMatchObject({
    status: 'done',
    summary: 'Repaired the unpublished committer identity.',
  });
  expect(
    (await readJournal(f.path)).entries.map((entry) => entry.step),
  ).toEqual(['exec', 'exec']);
  await recoverWithAgent(f.options);
  expect(f.invoke).toHaveBeenCalledOnce();
  expect(
    (
      await runBoot({
        journalPath: f.path,
        workflow: async (steps) => {
          await steps.step(
            'exec',
            { label: 'Completed preparation' },
            async () => {
              throw new Error('Must reuse completed result');
            },
          );
          return 'completed';
        },
      })
    ).status,
  ).toBe('finished');
});
it('records recovery failures and does not let the workflow continue', async () => {
  const f = await fixture();
  f.invoke.mockImplementation(async () => {
    throw new Error('agent could not launch');
  });
  await expect(recoverWithAgent(f.options)).rejects.toThrow(
    'agent could not launch',
  );
  expect(await f.writer.get(RECOVERY_VIEW_KEY)).toMatchObject({
    status: 'failed',
    summary: expect.stringContaining('agent could not launch'),
  });
  expect((await readJournal(f.path)).latest(0)?.status).toBe('done');
});
