import { readJournal } from '../run/journal.js';
import { JournalWriter } from '../run/writer.js';
import { retryStepKey } from '../run/retry.js';
import { flowBindings } from '../flow/runtime.js';
import { parseFlow, type FlowRepairRevision } from '@rocky/local-contracts';
import { createJiti } from 'jiti';
import { execFile, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentCallOpts,
  ScmOps,
  Triggers,
  WorkflowContext,
} from '@rocky/sdk';
import { z } from '@rocky/sdk';
import { newRepositoryProfile } from '../config/profiles.js';
import { createWorkflowContext } from '../run/context.js';
import { runBoot } from '../run/replay.js';

const { default: legacyTriggers, addressPrConversations: legacyConversations } =
  await createJiti(import.meta.url, {
    alias: {
      '@rocky/sdk': new URL('../../../sdk/src/index.ts', import.meta.url)
        .pathname,
    },
  }).import<{
    default: Triggers;
    addressPrConversations: (ctx: unknown) => Promise<string>;
  }>(new URL('../../content/.rocky/workflow.ts', import.meta.url).pathname);

type RawCheckpointAnswer =
  | { decision: 'approve' }
  | { decision: 'reject'; reason?: string }
  | { decision: 'steer'; message: string };

const flowSource = await readFile(
  new URL('../../content/.rocky/workflow.json', import.meta.url),
  'utf8',
);
const flowTriggers = (source: string, snapshot: string): Triggers =>
  flowBindings(source, snapshot).map(({ descriptor, workflow }) => ({
    ...descriptor,
    workflow,
  }));
describe.each(['legacy', 'flow'])('%s default workflow', (mode) => {
  const triggers =
    mode === 'flow'
      ? flowTriggers(
          flowSource,
          new URL('../../content/.rocky/', import.meta.url).pathname,
        )
      : legacyTriggers;
  const addressPrConversations =
    mode === 'flow'
      ? (ctx: unknown) =>
          triggers
            .find((t) => t.kind === 'manual')!
            .workflow(ctx as WorkflowContext, { members: [] })
      : legacyConversations;
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rocky-content-trace-'));
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
  });

  function repositoryFixture(options: Parameters<typeof fixture>[0] = {}) {
    const flow = JSON.parse(flowSource);
    flow.settings.pullRequests = 'all-changed';
    return fixture({
      ...options,
      triggers:
        options.triggers ??
        flowTriggers(
          JSON.stringify(flow),
          new URL('../../content/.rocky/', import.meta.url).pathname,
        ),
      members: [
        { name: 'fixture', path: 'app', lead: true, baseBranch: 'development' },
        { name: 'settings', path: 'settings', lead: false, baseBranch: 'main' },
      ],
      exec: (command) =>
        options.exec?.(command) ??
        (command.includes('status --porcelain')
          ? { exitCode: 0, stdout: '', stderr: '' }
          : command.includes('branch --show-current')
            ? { exitCode: 0, stdout: 'test-1', stderr: '' }
            : undefined),
      scm: (operation, count, args) => {
        const custom = options.scm?.(operation, count, args);
        if (custom !== undefined) return custom;
        if (operation === 'openPr') {
          const repo = (args[0] as { repo?: string }).repo ?? 'fixture';
          return {
            repo,
            id: repo,
            number: repo === 'fixture' ? 1 : 2,
            url: `https://example.test/${repo}/pr/1`,
            sourceBranch: 'test-1',
            baseBranch: repo === 'fixture' ? 'development' : 'main',
            headSha: 'abc',
            state: 'open',
            draft: true,
          };
        }
        if (operation === 'markDraft')
          return { ...(args[0] as object), draft: args[1] };
        if (operation === 'updateBranch')
          return { status: 'clean', pr: args[0] };
        if (operation === 'armAutoMerge')
          return {
            status: 'merged',
            pr: { ...(args[0] as object), state: 'merged' },
          };
        return undefined;
      },
    });
  }
  const calledRepos = (f: ReturnType<typeof fixture>, operation: string) =>
    f.scmCalls
      .filter((c) => c.operation === operation)
      .map((c) => (c.args[0] as { repo?: string }).repo ?? 'fixture');

  it.skipIf(mode === 'legacy')(
    'opens, reviews and checks every changed repository before one approval, then merges both',
    async () => {
      const f = repositoryFixture();
      expect(await f.boot()).toMatchObject({ status: 'parked' });
      expect(calledRepos(f, 'openPr')).toEqual(['fixture', 'settings']);
      expect(calledRepos(f, 'waitForCi')).toEqual(['fixture', 'settings']);
      expect(f.trace.filter((t) => t === 'visualRecap')).toHaveLength(2);
      expect(f.checkpointBodies.at(-1)).toContain(
        'https://example.test/settings/pr/1',
      );
      expect(f.checkpointBodies.at(-1)).toContain(
        'https://example.test/fixture/pr/1',
      );
      expect(calledRepos(f, 'armAutoMerge')).toEqual([]);
      expect(f.calls.find((c) => c.name === 'reviewer')?.input).toMatchObject({
        reviewScope: { repositories: { fixture: 'abc', settings: 'abc' } },
      });
      f.approve();
      f.merge();
      expect(await f.boot()).toMatchObject({
        status: 'finished',
        outcome: 'merged',
      });
      expect(calledRepos(f, 'updateBranch')).toEqual(['fixture', 'settings']);
      expect(calledRepos(f, 'armAutoMerge')).toEqual(['fixture', 'settings']);
      expect(f.trace.lastIndexOf('updateBranch')).toBeLessThan(
        f.trace.indexOf('armAutoMerge'),
      );
      expect(f.trace.at(-1)).toBe('Done');
      // A completed replay cannot open, publish or merge either PR twice.
      const before = f.scmCalls.length;
      expect(await f.boot()).toMatchObject({
        status: 'finished',
        outcome: 'merged',
      });
      expect(f.scmCalls).toHaveLength(before);
    },
  );

  it.skipIf(mode === 'legacy')(
    'checks every repository after approval before merging any of them',
    async () => {
      let repaired = false;
      const f = repositoryFixture({
        scm: (operation, _count, args) => {
          const candidate = args[0] as { repo: string };
          if (operation === 'reviewThreads')
            return candidate.repo === 'settings' && !repaired
              ? [
                  {
                    pr: candidate,
                    id: 'settings-review',
                    body: 'Correct the configuration',
                    path: 'values.yaml',
                    resolved: false,
                  },
                ]
              : [];
          if (operation === 'replyToThread') {
            repaired = true;
            return null;
          }
          return undefined;
        },
        agent: (name, input) =>
          name === 'fixer' && Array.isArray(input.complaints)
            ? {
                resolutions: (input.complaints as { id: string }[]).map(
                  ({ id }) => ({
                    id,
                    status: 'fixed',
                    note: 'Corrected and tested.',
                  }),
                ),
              }
            : undefined,
      });
      expect((await f.boot()).status).toBe('parked');
      f.approve();
      f.merge();
      expect((await f.boot()).status).toBe('parked');
      expect(calledRepos(f, 'armAutoMerge')).toEqual([]);
      expect(calledRepos(f, 'reviewThreads')).toEqual(['fixture', 'settings']);
      expect(repaired).toBe(true);
      f.approve();
      expect(await f.boot()).toMatchObject({
        status: 'finished',
        outcome: 'merged',
      });
      expect(calledRepos(f, 'checkMergeReady')).toEqual([
        'fixture',
        'settings',
      ]);
      expect(f.trace.lastIndexOf('checkMergeReady')).toBeLessThan(
        f.trace.indexOf('armAutoMerge'),
      );
    },
  );

  it.skipIf(mode === 'legacy')(
    'recovers a legacy recorded discussion refusal through repair and fresh approval',
    async () => {
      const flow = JSON.parse(flowSource);
      delete flow.settings.mergeReadinessVersion;
      let repaired = false;
      const f = fixture({
        triggers: flowTriggers(
          JSON.stringify(flow),
          new URL('../../content/.rocky/', import.meta.url).pathname,
        ),
        scm: (operation, count, args) => {
          if (operation === 'armAutoMerge' && count === 1)
            return {
              refused: true,
              repo: 'fixture',
              reason: 'discussions_not_resolved',
              message: 'GitLab reports discussions_not_resolved.',
              fix: 'Repair the branch/CI in the bounded merge loop.',
              pr: args[0],
            };
          if (operation === 'reviewThreads')
            return repaired
              ? []
              : [{ pr: args[0], id: 'D1', body: 'Fix this', resolved: false }];
          if (operation === 'replyToThread') {
            repaired = true;
            return null;
          }
          return undefined;
        },
        agent: (name, input) =>
          name === 'fixer' && Array.isArray(input.complaints)
            ? {
                resolutions: (input.complaints as { id: string }[]).map(
                  ({ id }) => ({ id, status: 'fixed', note: 'Fixed.' }),
                ),
              }
            : undefined,
      });
      expect((await f.boot()).status).toBe('parked');
      f.approve();
      f.merge();
      expect((await f.boot()).status).toBe('parked');
      expect(repaired).toBe(true);
      expect(calledRepos(f, 'armAutoMerge')).toHaveLength(1);
      f.approve();
      expect(await f.boot()).toMatchObject({
        status: 'finished',
        outcome: 'merged',
      });
      expect(calledRepos(f, 'checkMergeReady')).toHaveLength(1);
    },
  );

  it.skipIf(mode === 'legacy')(
    'blocks the whole delivery when companion CI cannot pass',
    async () => {
      const f = repositoryFixture({
        scm: (operation, _count, args) =>
          operation === 'waitForCi' &&
          (args[0] as { repo: string }).repo === 'settings'
            ? { status: 'failed', headSha: 'abc', failedJobs: [] }
            : undefined,
        agent: (name) =>
          name === 'ci-fixer' ? { action: 'unresolved' } : undefined,
      });
      expect(await f.boot()).toMatchObject({
        status: 'finished',
        outcome: 'exhausted',
      });
      const posted = f.trace.find((entry) =>
        entry.startsWith('post:Unresolved Complaints:'),
      );
      expect(posted).toContain('```json\n');
      expect(
        JSON.parse(posted!.split('```json\n')[1].split('\n```')[0]),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            text: expect.stringContaining('CI did not pass'),
          }),
        ]),
      );
      expect(calledRepos(f, 'waitForCi')).toEqual(['fixture', 'settings']);
      expect(f.calls.find((c) => c.name === 'ci-fixer')?.input.repository).toBe(
        'settings',
      );
      expect(f.checkpointBodies).toEqual([]);
      expect(calledRepos(f, 'armAutoMerge')).toEqual([]);
      expect(
        f.scmCalls
          .filter((c) => c.operation === 'markDraft')
          .every((c) => c.args[1] === true),
      ).toBe(true);
    },
  );

  it.skipIf(mode === 'legacy')(
    'hands failed CI to its fixer before a persistent compliance review exhausts',
    async () => {
      const failedJob = {
        id: 'arbitrary-check',
        name: 'repository gate',
        failedSteps: ['Verify repository policy'],
        logTail: 'The submitted change violates a repository policy.',
      };
      const f = repositoryFixture({
        scm: (operation) =>
          operation === 'waitForCi'
            ? { status: 'failed', headSha: 'abc', failedJobs: [failedJob] }
            : undefined,
        agent: (name, input) => {
          if (name === 'ci-fixer') return { action: 'unresolved' };
          if (name === 'compliance-reviewer')
            return {
              complaints: [
                {
                  id: `${input.namespace}/persistent`,
                  file: 'src/a.ts',
                  text: 'Acceptance evidence is incomplete.',
                  quote: 'Return an empty list.',
                },
              ],
            };
          if (name === 'fixer')
            return {
              resolutions: (input.complaints as { id: string }[]).map(
                ({ id }) => ({ id, status: 'fixed', note: 'Patched.' }),
              ),
            };
          return undefined;
        },
      });
      const first = await f.boot();
      if (first.status === 'failed') throw new Error(JSON.stringify(first));
      expect(first).toMatchObject({
        status: 'finished',
        outcome: 'exhausted',
      });
      const ciFixer = f.calls.find((call) => call.name === 'ci-fixer');
      expect(ciFixer?.input.failedJobs).toEqual([failedJob]);
      expect(ciFixer?.input.pullRequest).toMatchObject({ repo: 'fixture' });
      expect(ciFixer?.options?.tools).toContain('bash');
      expect(f.trace).not.toContain('compliance-reviewer');
    },
  );

  it.skipIf(mode === 'legacy')(
    'revalidates after an early CI repair before compliance review',
    async () => {
      let failed = false;
      const f = repositoryFixture({
        scm: (operation, _count, args) => {
          if (
            operation === 'waitForCi' &&
            (args[0] as { repo: string }).repo === 'fixture' &&
            !failed
          ) {
            failed = true;
            return {
              status: 'failed',
              headSha: 'abc',
              failedJobs: [
                {
                  id: 'gate',
                  name: 'repository gate',
                  failedSteps: ['Verify change'],
                  logTail: 'Failed.',
                },
              ],
            };
          }
          return undefined;
        },
        agent: (name) =>
          name === 'ci-fixer' ? { action: 'fixed' } : undefined,
      });
      expect(await f.boot()).toMatchObject({ status: 'parked' });
      expect(f.calls.filter((call) => call.name === 'ci-fixer')).toHaveLength(
        1,
      );
      expect(f.trace.indexOf('ci-fixer')).toBeLessThan(
        f.trace.indexOf('compliance-reviewer'),
      );
      expect(calledRepos(f, 'waitForCi')).toEqual([
        'fixture',
        'fixture',
        'settings',
      ]);
    },
  );

  it.skipIf(mode === 'legacy').each([true, false])(
    'checks actual branch revisions before a CI retry and replays the migration boundary (enabled=%s)',
    async (enabled) => {
      let head = 'abc';
      const flow = JSON.parse(flowSource);
      if (enabled) flow.settings.ciRetryVersion = 1;
      else delete flow.settings.ciRetryVersion;
      const f = repositoryFixture({
        triggers: flowTriggers(
          JSON.stringify(flow),
          new URL('../../content/.rocky/', import.meta.url).pathname,
        ),
        exec: (command) =>
          command.includes('git rev-parse HEAD')
            ? { exitCode: 0, stdout: head, stderr: '' }
            : undefined,
        scm: (operation, count, args) =>
          operation === 'waitForCi'
            ? {
                status: count === 1 ? 'failed' : 'passed',
                headSha: (args[0] as { headSha: string }).headSha,
                failedJobs:
                  count === 1
                    ? [
                        {
                          id: 'gate',
                          name: 'repository check',
                          failedSteps: [],
                          logTail: 'Transient failure',
                        },
                      ]
                    : [],
              }
            : undefined,
        agent: (name) => {
          if (name !== 'ci-fixer') return undefined;
          head = 'def';
          return {
            action: 'retry',
            summary: 'Created a local commit for fresh CI.',
          };
        },
      });
      expect(await f.boot()).toMatchObject({ status: 'parked' });
      const checks = f.scmCalls.filter(
        (call) => call.operation === 'waitForCi',
      );
      expect(checks[1].args[0]).toMatchObject({
        headSha: enabled ? 'def' : 'abc',
      });
      expect(calledRepos(f, 'retryFailedJobs')).toHaveLength(enabled ? 0 : 1);
      const before = await readFile(join(dir, 'journal.jsonl'), 'utf8');
      f.approve();
      f.merge();
      expect(await f.boot()).toMatchObject({
        status: 'finished',
        outcome: 'merged',
      });
      expect(
        (await readFile(join(dir, 'journal.jsonl'), 'utf8')).startsWith(before),
      ).toBe(true);
      expect(f.calls.filter((call) => call.name === 'ci-fixer')).toHaveLength(
        1,
      );
    },
  );

  it.skipIf(mode === 'legacy')(
    'returns a refused CI retry to the fixer as evidence instead of claiming it ran',
    async () => {
      const refusal = {
        refused: true,
        repo: 'fixture',
        reason: 'permission_denied',
        message: 'External check cannot be rerequested.',
        fix: 'Inspect provider access.',
      };
      const f = repositoryFixture({
        scm: (operation, _count, args) =>
          operation === 'retryFailedJobs'
            ? refusal
            : operation === 'waitForCi'
              ? {
                  status: 'failed',
                  headSha: (args[0] as { headSha: string }).headSha,
                  failedJobs: [
                    {
                      id: 'check',
                      name: 'External review',
                      failedSteps: [],
                      logTail: 'Rate limited',
                    },
                  ],
                }
              : undefined,
        agent: (name, input, count) => {
          if (name !== 'ci-fixer') return undefined;
          if (count === 2) expect(input.retryRefusal).toEqual(refusal);
          return {
            action: count === 1 ? 'retry' : 'unresolved',
            summary: 'Provider access is required.',
          };
        },
      });
      expect(await f.boot()).toMatchObject({
        status: 'finished',
        outcome: 'exhausted',
      });
      expect(calledRepos(f, 'retryFailedJobs')).toHaveLength(1);
      expect(f.calls.filter((call) => call.name === 'ci-fixer')).toHaveLength(
        2,
      );
    },
  );

  it.skipIf(mode === 'legacy')(
    'can deliver only a changed companion without creating an empty lead PR',
    async () => {
      const f = repositoryFixture({
        exec: (command) =>
          command.startsWith("cd -- 'app'") && command.includes('git diff')
            ? { exitCode: 0, stdout: '', stderr: '' }
            : undefined,
      });
      expect(await f.boot()).toMatchObject({ status: 'parked' });
      expect(calledRepos(f, 'openPr')).toEqual(['settings']);
      expect(calledRepos(f, 'waitForCi')).toEqual(['settings']);
      expect(f.trace.filter((t) => t === 'visualRecap')).toHaveLength(1);
    },
  );

  it.skipIf(mode === 'legacy')(
    'preserves lead-only steps for frozen flows without the new setting',
    async () => {
      const flow = JSON.parse(flowSource);
      delete flow.settings.pullRequests;
      const f = repositoryFixture({
        triggers: flowTriggers(
          JSON.stringify(flow),
          new URL('../../content/.rocky/', import.meta.url).pathname,
        ),
      });
      expect(await f.boot()).toMatchObject({ status: 'parked' });
      expect(calledRepos(f, 'openPr')).toEqual(['fixture']);
      expect(f.trace.some((c) => c.includes("cd -- 'settings'"))).toBe(false);
    },
  );

  it.skipIf(mode === 'legacy')(
    'discovers a companion first changed by a CI repair and rechecks the full set',
    async () => {
      let settingsChanged = false;
      const f = repositoryFixture({
        exec: (command) =>
          !settingsChanged &&
          command.startsWith("cd -- 'settings'") &&
          command.includes('git diff')
            ? { exitCode: 0, stdout: '', stderr: '' }
            : undefined,
        scm: (operation, count) =>
          operation === 'waitForCi' && count === 1
            ? { status: 'failed', headSha: 'abc', failedJobs: [] }
            : undefined,
        agent: (name) => {
          if (name !== 'ci-fixer') return undefined;
          settingsChanged = true;
          return { action: 'fixed' };
        },
      });
      expect(await f.boot()).toMatchObject({ status: 'parked' });
      expect(calledRepos(f, 'openPr')).toEqual(['fixture', 'settings']);
      expect(calledRepos(f, 'waitForCi')).toEqual([
        'fixture',
        'fixture',
        'settings',
      ]);
      expect(f.checkpointBodies.at(-1)).toContain(
        'https://example.test/settings/pr/1',
      );
    },
  );

  it.skipIf(mode === 'legacy')(
    'requires new checks and approval if either branch changes after approval',
    async () => {
      let settingsHead = 'abc';
      const f = repositoryFixture({
        exec: (command) =>
          command.startsWith("cd -- 'settings'") &&
          command.includes('rev-parse HEAD')
            ? { exitCode: 0, stdout: settingsHead, stderr: '' }
            : undefined,
        scm: (operation, count, args) => {
          if (operation === 'waitForCi')
            return {
              status: 'passed',
              headSha: (args[0] as { headSha: string }).headSha,
              failedJobs: [],
            };
          if (operation === 'updateBranch' && count === 2) {
            settingsHead = 'def';
            return {
              status: 'updated',
              pr: { ...(args[0] as object), headSha: settingsHead },
            };
          }
          return undefined;
        },
      });
      expect(await f.boot()).toMatchObject({ status: 'parked' });
      f.approve();
      expect(await f.boot()).toMatchObject({ status: 'parked' });
      expect(calledRepos(f, 'armAutoMerge')).toEqual([]);
      expect(calledRepos(f, 'waitForCi')).toEqual([
        'fixture',
        'settings',
        'fixture',
        'settings',
      ]);
      expect(f.checkpointBodies.at(-1)).toContain('(def)');
      f.approve();
      f.merge();
      expect(await f.boot()).toMatchObject({
        status: 'finished',
        outcome: 'merged',
      });
      expect(calledRepos(f, 'armAutoMerge')).toEqual(['fixture', 'settings']);
    },
  );

  it.skipIf(mode === 'legacy')(
    'skips CI only for explicitly configured repositories and reports that in approval',
    async () => {
      const flow = JSON.parse(flowSource);
      flow.settings.ciSkipRepositories = ['settings'];
      const f = repositoryFixture({
        triggers: flowTriggers(
          JSON.stringify(flow),
          new URL('../../content/.rocky/', import.meta.url).pathname,
        ),
      });
      expect(await f.boot()).toMatchObject({ status: 'parked' });
      expect(calledRepos(f, 'waitForCi')).toEqual(['fixture']);
      expect(f.checkpointBodies.at(-1)).toContain(
        'settings: no CI pipeline configured',
      );
    },
  );

  it('ships the complete editable default tree without default Rules', async () => {
    const shipped = new URL('../../content/.rocky/', import.meta.url);
    const agents = await readdir(new URL('./agents/', shipped));
    expect(agents.sort()).toEqual([
      'ci-fixer.md',
      'compliance-reviewer.md',
      'deliverable-reviewer.md',
      'deliverable-writer.md',
      'fixer.md',
      'implementer.md',
      'merger.md',
      'planner.md',
      'refiner.md',
      'reviewer.md',
      'ui-complaint-writer.md',
      'ui-inspector.md',
      'ui-planner.md',
      'ui-triage.md',
    ]);
    for (const agent of agents) {
      expect(
        await readFile(new URL(`./agents/${agent}`, shipped), 'utf8'),
      ).not.toMatch(/^---(?:\r?\n)/);
    }
    await expect(readdir(new URL('./rules/', shipped))).rejects.toThrow();
    const workflow = await readFile(new URL('./workflow.ts', shipped), 'utf8');
    expect(workflow.match(/^\/\/ BEGIN ROCKY CONFIG$/gm)).toHaveLength(1);
    expect(workflow.match(/^\/\/ END ROCKY CONFIG$/gm)).toHaveLength(1);
    expect(await readFile(new URL('./mcp.json', shipped), 'utf8')).toBe(
      '{\n  "mcpServers": {}\n}\n',
    );
  });

  it.skipIf(mode === 'legacy')(
    'returns uncommitted implementation to its agent before PR delivery',
    async () => {
      let dirty = true;
      const flow = JSON.parse(flowSource);
      flow.settings.recoveryVersion = 1;
      const f = repositoryFixture({
        triggers: flowTriggers(
          JSON.stringify(flow),
          new URL('../../content/.rocky/', import.meta.url).pathname,
        ),
        exec: (command) =>
          command.includes('status --porcelain')
            ? { exitCode: 0, stdout: dirty ? ' M src/a.ts' : '', stderr: '' }
            : undefined,
        agent: (name, _input, count) => {
          if (name === 'implementer' && count === 2) {
            dirty = false;
            return { summary: 'Completed and committed.' };
          }
          return undefined;
        },
      });
      const result = await f.boot();
      expect(result, JSON.stringify(result)).toMatchObject({
        status: 'parked',
      });
      expect(
        f.calls.filter((call) => call.name === 'implementer'),
      ).toHaveLength(2);
      expect(
        f.calls.filter((call) => call.name === 'implementer')[1].input,
      ).toMatchObject({
        recovery: { kind: 'uncommitted-work', repository: 'fixture' },
      });
      f.approve();
      f.merge();
      expect(await f.boot()).toMatchObject({
        status: 'finished',
        outcome: 'merged',
      });
      expect(
        f.calls.filter((call) => call.name === 'implementer'),
      ).toHaveLength(2);
    },
  );

  it.skipIf(mode === 'legacy')(
    'replays a pre-recovery snapshot journal without inserting recovery steps',
    async () => {
      const flow = JSON.parse(flowSource);
      delete flow.settings.recoveryVersion;
      const f = repositoryFixture({
        triggers: flowTriggers(
          JSON.stringify(flow),
          new URL('../../content/.rocky/', import.meta.url).pathname,
        ),
      });
      expect(await f.boot()).toMatchObject({ status: 'parked' });
      const before = await readFile(join(dir, 'journal.jsonl'), 'utf8');
      f.approve();
      f.merge();
      expect(await f.boot()).toMatchObject({
        status: 'finished',
        outcome: 'merged',
      });
      expect(
        (await readFile(join(dir, 'journal.jsonl'), 'utf8')).startsWith(before),
      ).toBe(true);
      expect(
        f.calls.filter((call) => call.name === 'implementer'),
      ).toHaveLength(1);
      expect(
        f.calls.some((call) => call.options?.label?.includes('repair 1/2')),
      ).toBe(false);
    },
  );

  it.skipIf(mode === 'legacy').each([false, true])(
    'bounds unfinished-work recovery and preserves the old snapshot boundary (%s)',
    async (enabled) => {
      const flow = JSON.parse(flowSource);
      if (enabled) flow.settings.recoveryVersion = 1;
      else delete flow.settings.recoveryVersion;
      const f = repositoryFixture({
        triggers: flowTriggers(
          JSON.stringify(flow),
          new URL('../../content/.rocky/', import.meta.url).pathname,
        ),
        exec: (command) =>
          command.includes('status --porcelain')
            ? { exitCode: 0, stdout: ' M src/a.ts', stderr: '' }
            : undefined,
        agent: (name) =>
          name === 'implementer' ? { summary: 'Still blocked.' } : undefined,
      });
      expect(await f.boot()).toMatchObject({
        status: 'failed',
        error: { message: expect.stringContaining('uncommitted work') },
      });
      expect(
        f.calls.filter((call) => call.name === 'implementer'),
      ).toHaveLength(enabled ? 3 : 1);
      expect(calledRepos(f, 'openPr')).toEqual([]);
    },
  );

  it.skipIf(mode === 'legacy')(
    'revalidates and reviews work repaired after a passing review',
    async () => {
      let dirty = false;
      const f = repositoryFixture({
        exec: (command) =>
          command.includes('status --porcelain')
            ? { exitCode: 0, stdout: dirty ? ' M src/a.ts' : '', stderr: '' }
            : undefined,
        agent: (name, _input, count) => {
          if (name === 'reviewer' && count === 1) dirty = true;
          if (name === 'fixer') {
            dirty = false;
            return { summary: 'Committed recovered work.' };
          }
          return undefined;
        },
      });
      const result = await f.boot();
      expect(result, JSON.stringify(result)).toMatchObject({
        status: 'parked',
      });
      expect(f.calls.filter((call) => call.name === 'reviewer')).toHaveLength(
        2,
      );
      expect(
        f.calls.filter((call) => call.name === 'compliance-reviewer'),
      ).toHaveLength(2);
      expect(f.calls.filter((call) => call.name === 'fixer')).toHaveLength(1);
    },
  );

  function fixture(
    options: {
      comments?: import('@rocky/sdk').IssueComment[];
      members?: import('@rocky/sdk').WorkflowInput['members'];
      agent?: (
        name: string,
        input: Record<string, unknown>,
        count: number,
      ) => Record<string, unknown> | undefined;
      exec?: (
        command: string,
      ) => { exitCode: number; stdout: string; stderr: string } | undefined;
      comment?: (body: string) => void;
      recap?: () => { id: string; url: string };
      scm?: (operation: string, count: number, args: unknown[]) => unknown;
      triggers?: Triggers;
      continuation?: boolean;
      continuationSource?: string;
    } = {},
  ) {
    const trace: string[] = [];
    const calls: {
      name: string;
      input: Record<string, unknown>;
      options?: AgentCallOpts;
    }[] = [];
    const scmCalls: { operation: string; args: unknown[] }[] = [];
    const answers: RawCheckpointAnswer[] = [];
    const checkpointBodies: string[] = [];
    let merged = false;
    const pr = {
      repo: 'fixture',
      id: 'pr-1',
      number: 1,
      url: 'https://example.test/pr/1',
      sourceBranch: 'test-1',
      baseBranch: 'main',
      headSha: 'abc',
      state: 'open',
      draft: true,
    };
    const boot = () =>
      runBoot({
        journalPath: join(dir, 'journal.jsonl'),
        workflow: async (runner) => {
          const ctx = createWorkflowContext(
            runner,
            {
              issue: {
                identifier: 'TEST-1',
                title: 'Handle empty input',
                description: 'Return an empty list.',
                url: 'https://example.test/issue/1',
                labels: [],
                ...(options.comments ? { comments: options.comments } : {}),
              },
              profile: {
                ...newRepositoryProfile({
                  id: 'fixture',
                  remote: 'github.com/acme/app',
                }),
                models: {
                  review: {
                    harness: 'opencode',
                    model: 'review-model',
                    effort: 'high',
                  },
                  implementation: {
                    harness: 'claude-code',
                    model: 'implementation-model',
                    effort: 'high',
                  },
                  planner: {
                    harness: 'opencode',
                    model: 'planning-model',
                    effort: 'low',
                  },
                },
              },
              branch: 'test-1',
              ports: [12345],
            },
            {
              exec: async (command, background) => {
                trace.push(
                  command.includes('git push origin HEAD') ? 'push' : command,
                );
                const result = options.exec?.(command);
                if (result) return result;
                if (command.includes('ROCKY_MERMAID_CHECK'))
                  return {
                    exitCode: 0,
                    stdout: JSON.stringify({
                      ok: true,
                      rendered: false,
                      diagrams: [],
                    }),
                    stderr: '',
                  };
                return background
                  ? { pid: 123 }
                  : {
                      exitCode: 0,
                      stdout: command.includes('rev-parse') ? 'abc\n' : 'diff',
                      stderr: '',
                    };
              },
              changedFiles: async () => ['src/a.ts'],
              external: (steps, _approvals) => ({
                agent: async <S extends z.ZodType>(
                  name: string | { prompt: string },
                  opts?: AgentCallOpts<S>,
                ) =>
                  steps.step('agent', { label: opts?.label }, async () => {
                    const n =
                      typeof name === 'string'
                        ? name
                        : (opts?.label ?? 'inline');
                    trace.push(n);
                    const input = (opts?.input ?? {}) as Record<
                      string,
                      unknown
                    >;
                    calls.push({ name: n, input, options: opts });
                    const data =
                      options.agent?.(
                        n,
                        input,
                        calls.filter((call) => call.name === n).length,
                      ) ??
                      (n === 'refiner'
                        ? {
                            status: 'clear',
                            delivery: {
                              kind: 'pull-request',
                              merge: true,
                              stateChanges: true,
                            },
                            scope: 'Handle empty input.',
                            decisions: ['Return an empty list as requested.'],
                            acceptanceCriteria: ['Return an empty list.'],
                            outOfScope: [],
                          }
                        : n === 'planner'
                          ? { steps: ['Handle empty input.'] }
                          : n === 'ui-triage'
                            ? { isFrontend: false }
                            : n.includes('reviewer')
                              ? { complaints: [] }
                              : {});
                    if (
                      mode === 'flow' &&
                      (n === 'compliance-reviewer' || n === 'reviewer') &&
                      !('previousIssues' in data)
                    ) {
                      Object.assign(data, {
                        previousIssues: (
                          (input.reviewHistory ?? []) as {
                            id: string;
                            status: string;
                          }[]
                        )
                          .filter((item) => item.status !== 'ignored')
                          .map((item) => ({
                            id: item.id,
                            status: 'fixed',
                            note: 'Verified in this fixture.',
                          })),
                      });
                    }
                    return {
                      status: 'done',
                      result: Object.assign(opts?.schema?.parse(data) ?? data, {
                        summary: 'Fixture summary.',
                      }),
                    };
                  }),
                checkpoint: async (checkpoint) => {
                  trace.push('checkpoint');
                  checkpointBodies.push(checkpoint.body);
                  const answer = answers.shift();
                  return answer
                    ? { status: 'done', result: answer }
                    : { status: 'waiting', detail: checkpoint };
                },
                visualRecap: () =>
                  steps.step('visualRecap', {}, async () => {
                    trace.push('visualRecap');
                    return {
                      status: 'done',
                      result: options.recap?.() ?? {
                        id: 'r_fixture',
                        url: 'https://rocky.test/recap',
                      },
                    };
                  }),
                comment: (body) =>
                  steps.step('linear.comment', {}, async () => {
                    options.comment?.(body);
                    trace.push(`comment:${body}`);
                    return { status: 'done', result: undefined };
                  }),
                post: (body) =>
                  steps
                    .step('post', {}, async () => {
                      trace.push(`post:${body}`);
                      return { status: 'done', result: null };
                    })
                    .then(() => undefined),
                linear: {
                  setState: (state) =>
                    steps
                      .step('linear', {}, async () => {
                        trace.push(state);
                        return { status: 'done', result: null };
                      })
                      .then(() => undefined),
                },
                // External SCM fixture, not a substitute for SDK/platform integration.
                scm: new Proxy({} as ScmOps, {
                  get:
                    (_, operation: string) =>
                    (...args: unknown[]) =>
                      steps.step(`scm:${operation}`, {}, async () => {
                        trace.push(operation);
                        scmCalls.push({ operation, args });
                        if (operation === 'armAutoMerge' && !merged)
                          return { status: 'waiting' };
                        const result =
                          options.scm?.(
                            operation,
                            scmCalls.filter(
                              (call) => call.operation === operation,
                            ).length,
                            args,
                          ) ??
                          (operation === 'openPr' || operation === 'markDraft'
                            ? pr
                            : operation === 'checkMergeReady'
                              ? { status: 'ready', pr }
                              : operation === 'reviewThreads'
                                ? []
                                : operation === 'waitForCi'
                                  ? {
                                      status: 'passed',
                                      headSha: 'abc',
                                      failedJobs: [],
                                    }
                                  : operation === 'updateBranch'
                                    ? { status: 'clean', pr }
                                    : operation === 'armAutoMerge'
                                      ? { status: 'merged', pr }
                                      : null);
                        return { status: 'done', result };
                      }),
                }),
              }),
            },
          );
          const continuedTriggers = options.continuation
            ? flowBindings(
                options.continuationSource ?? flowSource,
                new URL('../../content/.rocky/', import.meta.url).pathname,
                Number(
                  (await readJournal(join(dir, 'journal.jsonl'))).getControl(
                    'review:continuations',
                  ) ?? 0,
                ),
                (await readJournal(join(dir, 'journal.jsonl'))).getControl(
                  'flow:repairs',
                ) as FlowRepairRevision[] | undefined,
              ).map(({ descriptor, workflow }) => ({ ...descriptor, workflow }))
            : undefined;
          const binding = (
            continuedTriggers ??
            options.triggers ??
            triggers
          ).find((trigger) => trigger.kind === 'linear.onDelegate');
          if (!binding) throw new Error('Missing delegation Trigger');
          return binding.workflow(ctx as WorkflowContext, {
            members: options.members ?? [],
          });
        },
      });
    return {
      trace,
      checkpointBodies,
      calls,
      scmCalls,
      boot,
      answer: (answer: RawCheckpointAnswer) => answers.push(answer),
      approve: () => {
        answers.push({ decision: 'approve' });
      },
      merge: () => {
        merged = true;
      },
    };
  }

  it.skipIf(mode === 'legacy')(
    'addresses conversations across repositories with scoped paths and one recap per PR',
    async () => {
      const flow = parseFlow(flowSource);
      const manual = flowTriggers(
        JSON.stringify(flow),
        new URL('../../content/.rocky/', import.meta.url).pathname,
      ).find((t) => t.kind === 'manual')!;
      const f = repositoryFixture({
        triggers: [{ kind: 'linear.onDelegate', workflow: manual.workflow }],
        scm: (operation, _count, args) => {
          if (operation === 'reviewThreads')
            return [
              {
                pr: args[0],
                id: 'first',
                path: 'src/a.ts',
                line: 4,
                body: 'Fix this',
                resolved: false,
              },
              {
                pr: args[0],
                id: 'second',
                body: 'Explain this',
                resolved: false,
              },
              { pr: args[0], id: 'resolved', body: 'Done', resolved: true },
              {
                pr: args[0],
                id: 'readonly',
                body: 'Info',
                resolved: false,
                resolvable: false,
              },
            ];
          return undefined;
        },
        agent: (name, input) =>
          name === 'fixer'
            ? {
                resolutions: (input.complaints as { id: string }[]).map(
                  ({ id }, i) => ({
                    id,
                    status: i % 2 ? 'disagreed' : 'fixed',
                    note: i % 2 ? 'Required by callers.' : 'Added a guard.',
                  }),
                ),
              }
            : undefined,
      });
      const result = await f.boot();
      expect(result, JSON.stringify(result)).toMatchObject({
        status: 'finished',
        outcome: 'completed',
      });
      expect(
        f.calls.find((c) => c.name === 'fixer')?.input.complaints,
      ).toMatchObject([
        { file: 'fixture/src/a.ts', line: 4 },
        { file: 'fixture' },
        { file: 'settings/src/a.ts', line: 4 },
        { file: 'settings' },
      ]);
      expect(
        f.scmCalls
          .filter((c) => c.operation === 'replyToThread')
          .map((c) => c.args[1]),
      ).toEqual([
        'Fixed in abc. Added a guard.',
        'Required by callers.',
        'Fixed in abc. Added a guard.',
        'Required by callers.',
      ]);
      expect(f.trace.filter((t) => t === 'visualRecap')).toHaveLength(2);
    },
  );

  it.skipIf(mode === 'legacy').each(['fixed', 'disagreed'] as const)(
    'repairs or exhausts a recap audit in a frozen flow without recovery edges (%s)',
    async (status) => {
      const flow = parseFlow(flowSource);
      flow.edges = flow.edges.filter(
        (e) =>
          !(
            e.source === 'recap' &&
            ['retry', 'exhausted'].includes(e.sourceHandle)
          ),
      );
      let recaps = 0;
      const f = repositoryFixture({
        triggers: flowTriggers(
          JSON.stringify(flow),
          new URL('../../content/.rocky/', import.meta.url).pathname,
        ),
        recap: () => {
          if (recaps++ === 0)
            throw Object.assign(new Error('Evidence audit failed'), {
              name: 'RecapAuditError',
              problems: ['Diagram does not match the change.'],
            });
          return { id: 'repaired', url: 'https://rocky.test/repaired' };
        },
        agent: (name, input) =>
          name === 'fixer'
            ? {
                resolutions: (input.complaints as { id: string }[]).map(
                  ({ id }) => ({ id, status, note: 'Checked the diagram.' }),
                ),
              }
            : undefined,
      });
      expect(await f.boot()).toMatchObject(
        status === 'fixed'
          ? { status: 'parked' }
          : { status: 'finished', outcome: 'exhausted' },
      );
      expect(
        f.calls.find((c) => c.name === 'fixer')?.input.complaints,
      ).toMatchObject([
        { file: 'fixture', text: 'Diagram does not match the change.' },
      ]);
      expect(calledRepos(f, 'armAutoMerge')).toEqual([]);
      if (status === 'fixed') expect(recaps).toBe(3);
    },
  );

  it
    .skipIf(mode === 'legacy')
    .each([
      'ci_must_pass',
      'head_changed',
      'requested_changes',
      'protected_branch',
    ])(
    'revalidates recoverable merge refusals and stops permanent refusals (%s)',
    async (reason) => {
      const f = repositoryFixture({
        scm: (operation, count, args) =>
          operation === 'armAutoMerge' && count === 1
            ? {
                refused: true,
                reason,
                message: 'Platform refused merge',
                fix: 'Resolve the platform requirement',
                pr: args[0],
              }
            : undefined,
      });
      expect(await f.boot()).toMatchObject({ status: 'parked' });
      f.approve();
      f.merge();
      const result = await f.boot();
      expect(result).toMatchObject(
        reason === 'protected_branch'
          ? { status: 'failed' }
          : { status: 'parked' },
      );
      expect(calledRepos(f, 'armAutoMerge')).toEqual(['fixture']);
      expect(f.trace.some((t) => t.includes('Platform refused merge'))).toBe(
        true,
      );
    },
  );

  it.skipIf(mode === 'legacy').each(['head_changed', 'permission_denied'])(
    'does not merge when post-approval CI refuses the request (%s)',
    async (reason) => {
      const f = repositoryFixture({
        scm: (operation, count) =>
          operation === 'waitForCi' && count === 3
            ? {
                refused: true,
                repo: 'fixture',
                reason,
                message: 'CI refused',
                fix: 'Check the head and access',
              }
            : undefined,
      });
      expect(await f.boot()).toMatchObject({ status: 'parked' });
      f.approve();
      f.merge();
      expect(await f.boot()).toMatchObject({
        status: reason === 'head_changed' ? 'parked' : 'failed',
      });
      expect(calledRepos(f, 'armAutoMerge')).toEqual([]);
    },
  );

  it
    .skipIf(mode === 'legacy')
    .each(['ci_still_running', 'requested_changes', 'protected_branch'])(
    'revalidates or asks for help when the platform is not ready after approval (%s)',
    async (reason) => {
      let checked = false;
      const f = repositoryFixture({
        scm: (operation, count, args) => {
          if (operation === 'checkMergeReady' && count === 1) {
            checked = true;
            return {
              refused: true,
              repo: 'fixture',
              reason,
              message: 'Platform not ready',
              fix: 'Resolve the requirement',
              pr: args[0],
            };
          }
          if (
            operation === 'reviewThreads' &&
            checked &&
            reason === 'requested_changes'
          )
            return [
              {
                pr: args[0],
                id: 'D1',
                body: 'Explain the behavior',
                line: 7,
                resolved: false,
              },
              {
                pr: args[0],
                id: 'D2',
                body: 'Already addressed',
                resolved: true,
              },
              {
                pr: args[0],
                id: 'D3',
                body: 'Information only',
                resolvable: false,
                resolved: false,
              },
            ];
          if (operation === 'replyToThread')
            return {
              refused: true,
              repo: 'fixture',
              reason: 'head_changed',
              message: 'New revision',
              fix: 'Recheck',
            };
          return undefined;
        },
        agent: (name, input) =>
          name === 'fixer'
            ? {
                resolutions: (input.complaints as { id: string }[]).map(
                  ({ id }) => ({
                    id,
                    status: 'disagreed',
                    note: 'Required by callers.',
                  }),
                ),
              }
            : undefined,
      });
      expect(await f.boot()).toMatchObject({ status: 'parked' });
      f.approve();
      f.merge();
      expect(await f.boot()).toMatchObject({ status: 'parked' });
      expect(calledRepos(f, 'armAutoMerge')).toEqual([]);
      if (reason === 'protected_branch') {
        f.answer({
          decision: 'reject',
          reason: 'Cannot satisfy the platform requirement',
        });
        expect(await f.boot()).toMatchObject({ status: 'failed' });
      } else if (reason === 'requested_changes') {
        expect(
          f.calls.find((call) => call.name === 'fixer')?.input.complaints,
        ).toMatchObject([
          { file: 'fixture/.', line: 7, text: 'Explain the behavior' },
        ]);
        expect(
          f.scmCalls.find((call) => call.operation === 'replyToThread')
            ?.args[2],
        ).toEqual({ resolve: false });
      }
    },
  );

  it.skipIf(mode === 'legacy')(
    'hands off every changed repository when merging is outside the ticket scope',
    async () => {
      const f = repositoryFixture({
        agent: (name) =>
          name === 'refiner'
            ? {
                status: 'clear',
                delivery: {
                  kind: 'pull-request',
                  merge: false,
                  stateChanges: false,
                },
                scope: 'Prepare a PR',
                decisions: ['A human will merge the PRs.'],
                acceptanceCriteria: ['Return an empty list for empty input.'],
                outOfScope: [],
              }
            : undefined,
      });
      expect(await f.boot()).toMatchObject({
        status: 'finished',
        outcome: 'completed',
      });
      const comment = f.trace.find((t) =>
        t.startsWith('comment:Ready for review:'),
      );
      expect(comment).toContain('https://example.test/fixture/pr/1');
      expect(comment).toContain('https://example.test/settings/pr/1');
      expect(calledRepos(f, 'armAutoMerge')).toEqual([]);
    },
  );

  it('opens a draft before reviews, parks at the final Checkpoint, and records Done only after actual merge', async () => {
    const f = fixture();
    expect((await f.boot()).status).toBe('parked');
    expect(f.trace.indexOf('push')).toBeLessThan(f.trace.indexOf('openPr'));
    expect(f.trace.indexOf('openPr')).toBeLessThan(
      f.trace.indexOf('compliance-reviewer'),
    );
    expect(f.trace).not.toContain('armAutoMerge');
    for (const name of ['refiner', 'planner'])
      expect(f.calls.find((call) => call.name === name)?.options).toMatchObject(
        {
          harness: 'opencode',
          model: 'planning-model',
          effort: 'low',
        },
      );
    expect(
      f.calls.find((call) => call.name === 'implementer')?.options,
    ).toMatchObject({
      harness: 'claude-code',
      model: 'implementation-model',
      effort: 'high',
    });
    expect(
      f.calls.find((call) => call.name === 'reviewer')?.options,
    ).toMatchObject({
      harness: 'opencode',
      model: 'review-model',
      effort: 'high',
    });
    const agentsBefore = f.calls.length;
    f.approve();
    expect((await f.boot()).status).toBe('parked');
    expect(f.calls).toHaveLength(agentsBefore);
    expect(f.trace).not.toContain('Done');
    f.merge();
    expect(await f.boot()).toMatchObject({
      status: 'finished',
      outcome: 'merged',
    });
    expect(f.trace.at(-1)).toBe('Done');
  });

  it.skipIf(mode !== 'flow')(
    'rechecks conversations and CI after approval before attempting merge',
    async () => {
      const f = fixture({
        scm: (operation) => (operation === 'reviewThreads' ? [] : undefined),
      });
      expect((await f.boot()).status).toBe('parked');
      const before = f.trace.length;
      f.approve();
      expect((await f.boot()).status).toBe('parked');
      const after = f.trace.slice(before);
      expect(after).toContain('reviewThreads');
      expect(after).toContain('waitForCi');
      expect(after.indexOf('reviewThreads')).toBeLessThan(
        after.indexOf('armAutoMerge'),
      );
      expect(after.indexOf('waitForCi')).toBeLessThan(
        after.indexOf('armAutoMerge'),
      );
    },
  );

  it.skipIf(mode !== 'flow')(
    'repairs post-approval conversations, validates, resolves, and asks again before merge',
    async () => {
      let resolved = false;
      const f = fixture({
        scm: (operation, _count, args) => {
          if (operation === 'reviewThreads')
            return resolved
              ? []
              : [
                  {
                    pr: args[0],
                    id: 'D1',
                    path: 'src/a.ts',
                    body: 'Fix the edge case',
                    resolved: false,
                  },
                ];
          if (operation === 'replyToThread') {
            resolved = true;
            return null;
          }
          return undefined;
        },
        agent: (name, input) =>
          name === 'fixer' && Array.isArray(input.complaints)
            ? {
                resolutions: (input.complaints as { id: string }[]).map(
                  ({ id }) => ({
                    id,
                    status: 'fixed',
                    note: 'Added and checked the edge case.',
                  }),
                ),
              }
            : undefined,
      });
      expect((await f.boot()).status).toBe('parked');
      f.approve();
      expect((await f.boot()).status).toBe('parked');
      expect(resolved).toBe(true);
      expect(f.trace).not.toContain('armAutoMerge');
      expect(f.checkpointBodies).toHaveLength(3); // initial wait, first answer, new approval wait
      const reply = f.scmCalls.find(
        (call) => call.operation === 'replyToThread',
      );
      expect(reply?.args[2]).toEqual({ resolve: true });
      expect(f.trace.lastIndexOf('waitForCi')).toBeLessThan(
        f.trace.indexOf('replyToThread'),
      );
      f.approve();
      f.merge();
      expect(await f.boot()).toMatchObject({
        status: 'finished',
        outcome: 'merged',
      });
      expect(f.trace.filter((op) => op === 'reviewThreads')).toHaveLength(2);
    },
  );

  it.skipIf(mode !== 'flow')(
    'repairs CI that fails after approval and requires new approval',
    async () => {
      const f = fixture({
        scm: (operation, count) =>
          operation === 'waitForCi' && (count === 2 || count === 3)
            ? {
                status: 'failed',
                headSha: 'abc',
                failedJobs: [
                  {
                    id: 'job',
                    name: 'test',
                    failedSteps: [],
                    logTail: 'Failure',
                  },
                ],
              }
            : undefined,
        agent: (name) =>
          name.startsWith('ci-fixer') ? { action: 'fixed' } : undefined,
      });
      expect((await f.boot()).status).toBe('parked');
      f.approve();
      expect((await f.boot()).status).toBe('parked');
      expect(f.calls.some((call) => call.name.startsWith('ci-fixer'))).toBe(
        true,
      );
      expect(f.trace).not.toContain('armAutoMerge');
      f.approve();
      f.merge();
      expect(await f.boot()).toMatchObject({
        status: 'finished',
        outcome: 'merged',
      });
    },
  );

  it.each([0, 1])(
    'installs configured dependencies before implementation (exit %s)',
    async (exitCode) => {
      const snapshot = join(dir, 'install-snapshot');
      await cp(new URL('../../content/.rocky/', import.meta.url), snapshot, {
        recursive: true,
      });
      const legacyPath = join(snapshot, 'workflow.ts');
      await writeFile(
        legacyPath,
        (await readFile(legacyPath, 'utf8')).replace(
          "install: ''",
          "install: 'fixture-install'",
        ),
      );
      const legacy = await createJiti(import.meta.url, {
        alias: {
          '@rocky/sdk': new URL('../../../sdk/src/index.ts', import.meta.url)
            .pathname,
        },
      }).import<{ default: Triggers }>(legacyPath);
      const flow = parseFlow(flowSource);
      flow.settings.commands.install = 'fixture-install';
      const f = fixture({
        exec: (command) =>
          command.includes('fixture-install')
            ? {
                exitCode,
                stdout: '',
                stderr: exitCode ? 'registry unavailable' : '',
              }
            : undefined,
        triggers:
          mode === 'flow'
            ? flowTriggers(JSON.stringify(flow), snapshot)
            : legacy.default,
      });

      expect(await f.boot()).toMatchObject({
        status: exitCode ? 'failed' : 'parked',
      });
      const install = 'cd -- "$ROCKY_LEAD_REPO" && fixture-install';
      expect(f.trace.filter((item) => item === install)).toHaveLength(1);
      if (exitCode) {
        expect(f.trace).not.toContain('implementer');
        expect(f.trace).not.toContain('push');
        expect(
          (await readJournal(join(dir, 'journal.jsonl'))).end,
        ).toMatchObject({
          result: {
            error: { message: expect.stringContaining('registry unavailable') },
          },
        });
        return;
      }
      expect(f.trace.indexOf(install)).toBeLessThan(
        f.trace.indexOf('implementer'),
      );
      if (mode === 'flow') {
        expect(
          f.calls.find(({ name }) => name === 'implementer')?.input,
        ).toMatchObject({
          validationResponsibility: {
            instruction: expect.stringContaining('no separate later agent'),
          },
        });
        expect(
          f.calls.find(({ name }) => name === 'compliance-reviewer')?.input,
        ).toMatchObject({
          validation: {
            summary: expect.stringContaining(
              'No local validation commands configured',
            ),
          },
        });
      }
      const before = f.trace.length;
      await f.boot();
      expect(f.trace.slice(before)).not.toContain(install);
    },
  );

  it.skipIf(mode !== 'flow').each([false, true])(
    'continues exhausted reviews for exactly another five rounds and survives replay (legacy journal=%s)',
    async (legacy) => {
      const f = fixture({
        continuation: true,
        agent: (name, input) => {
          if (name === 'compliance-reviewer')
            return {
              complaints: [
                {
                  id: `${input.namespace}/c1`,
                  file: 'src/a.ts',
                  text: 'Empty input crashes.',
                  quote: 'Return an empty list.',
                },
              ],
            };
          if (name === 'fixer')
            return {
              resolutions: (input.complaints as { id: string }[]).map(
                ({ id }) => ({ id, status: 'fixed', note: 'Patched.' }),
              ),
            };
          return undefined;
        },
      });
      const path = join(dir, 'journal.jsonl');
      const first = await f.boot();
      if (first.status === 'failed') throw new Error(JSON.stringify(first));
      expect(first).toMatchObject({ status: 'finished', outcome: 'exhausted' });
      if (legacy) {
        const rows = (await readFile(path, 'utf8'))
          .trimEnd()
          .split('\n')
          .map((line) => JSON.parse(line));
        // Simulate a Run recorded before CI was observed ahead of compliance.
        const ciSeqs = [
          ...new Set<number>(
            rows
              .filter((row) => row.step === 'scm:waitForCi')
              .map((row) => row.seq),
          ),
        ].sort((a, b) => a - b);
        const retained = rows.filter((row) => !ciSeqs.includes(row.seq));
        for (const row of retained)
          row.seq -= ciSeqs.filter((seq) => seq < row.seq).length;
        for (const row of retained) {
          if (row.step === 'agent' && Array.isArray(row.result?.complaints)) {
            delete row.result.previousIssues;
            for (const complaint of row.result.complaints)
              delete complaint.severity;
          }
        }
        await writeFile(
          path,
          retained.map((row) => JSON.stringify(row)).join('\n') + '\n',
        );
      }
      const history = await readFile(path, 'utf8');
      const count = (name: string) =>
        f.calls.filter((call) => call.name === name).length;
      expect(count('compliance-reviewer')).toBe(5);
      expect(
        f.calls
          .filter((call) => call.name === 'compliance-reviewer')
          .every(
            (call) =>
              call.options?.tools?.length === 1 &&
              call.options.tools[0] === 'read',
          ),
      ).toBe(true);
      const before = f.calls.length;
      const writer = await JournalWriter.open(path);
      await writer.retry(
        'continue-1',
        String((await readJournal(path)).end?.seq),
        [],
        undefined,
        true,
      );
      const resumed = await f.boot();
      if (resumed.status === 'failed') throw new Error(JSON.stringify(resumed));
      expect(resumed).toMatchObject({
        status: 'finished',
        outcome: 'exhausted',
      });
      expect(count('compliance-reviewer')).toBe(10);
      expect(count('implementer')).toBe(1);
      expect(count('planner')).toBe(1);
      expect(f.calls[before].name).toBe('fixer');
      expect(f.calls[before].input.complaints).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ text: 'Empty input crashes.' }),
        ]),
      );
      expect(
        f.calls
          .filter((call) => call.name === 'compliance-reviewer')
          .slice(5)
          .map((call) => call.options?.label),
      ).toEqual([
        'compliance-reviewer 1/5',
        'compliance-reviewer 2/5',
        'compliance-reviewer 3/5',
        'compliance-reviewer 4/5',
        'compliance-reviewer 5/5',
      ]);
      expect((await readFile(path, 'utf8')).startsWith(history)).toBe(true);
      expect(await f.boot()).toMatchObject({
        status: 'finished',
        outcome: 'exhausted',
      });
      expect(count('compliance-reviewer')).toBe(10);
      await (
        await JournalWriter.open(path)
      ).retry(
        'continue-2',
        String((await readJournal(path)).end?.seq),
        [],
        undefined,
        true,
      );
      expect(await f.boot()).toMatchObject({
        status: 'finished',
        outcome: 'exhausted',
      });
      expect(count('compliance-reviewer')).toBe(15);
      expect((await readJournal(path)).getControl('review:continuations')).toBe(
        2,
      );
    },
  );

  it.skipIf(mode !== 'flow')(
    'reinstalls dependencies when continuing an exhausted restored workspace',
    async () => {
      const flow = parseFlow(flowSource);
      flow.settings.commands.install = 'fixture-install';
      flow.settings.reviewCap = 1;
      const continuedSource = JSON.stringify(flow);
      const f = fixture({
        continuation: true,
        continuationSource: continuedSource,
        triggers: flowTriggers(
          continuedSource,
          new URL('../../content/.rocky/', import.meta.url).pathname,
        ),
        agent: (name, input) => {
          if (name === 'compliance-reviewer')
            return {
              complaints: [
                {
                  id: `${input.namespace}/c1`,
                  file: 'src/a.ts',
                  text: 'Empty input crashes.',
                  quote: 'Return an empty list.',
                },
              ],
            };
          if (name === 'fixer')
            return {
              resolutions: (input.complaints as { id: string }[]).map(
                ({ id }) => ({ id, status: 'fixed', note: 'Patched.' }),
              ),
            };
          return undefined;
        },
      });
      const path = join(dir, 'journal.jsonl');
      expect(await f.boot()).toMatchObject({
        status: 'finished',
        outcome: 'exhausted',
      });
      const writer = await JournalWriter.open(path);
      await writer.retry(
        'continue-install',
        String((await readJournal(path)).end?.seq),
        [],
        undefined,
        true,
      );
      expect(await f.boot()).toMatchObject({
        status: 'finished',
        outcome: 'exhausted',
      });
      expect(
        f.trace.filter(
          (item) => item === 'cd -- "$ROCKY_LEAD_REPO" && fixture-install',
        ),
      ).toHaveLength(2);
    },
  );

  it.skipIf(mode !== 'flow')(
    'preserves the step order of frozen flows without workspace setup',
    async () => {
      const flow = parseFlow(flowSource);
      delete flow.settings.workspaceSetup;
      flow.settings.commands.install = 'old-install';
      const f = fixture({
        triggers: flowTriggers(
          JSON.stringify(flow),
          new URL('../../content/.rocky/', import.meta.url).pathname,
        ),
      });
      expect(await f.boot()).toMatchObject({ status: 'parked' });
      expect(f.trace.some((command) => command.includes('old-install'))).toBe(
        false,
      );
      expect(f.trace).toContain('implementer');
    },
  );

  it.skipIf(mode !== 'flow')(
    'reviews all severities together, ignores nit picks, and shares verified history across incremental reviews',
    async () => {
      const f = fixture({
        exec: (command) =>
          command.includes("git diff 'abc'..HEAD")
            ? { exitCode: 0, stdout: 'only newer commits', stderr: '' }
            : undefined,
        agent: (name, input, count) => {
          if (name === 'compliance-reviewer' && count === 1)
            return {
              complaints: [
                {
                  id: `${input.namespace}/must`,
                  file: 'a.ts',
                  text: 'Loses data.',
                  quote: 'Return an empty list.',
                  severity: 'must-fix',
                },
                {
                  id: `${input.namespace}/should`,
                  file: 'b.ts',
                  text: 'Retries unnecessarily.',
                  quote: 'Return an empty list.',
                  severity: 'should-fix',
                },
                {
                  id: `${input.namespace}/nit`,
                  file: 'c.ts',
                  text: 'Prefer another name.',
                  quote: 'Return an empty list.',
                  severity: 'nit-pick',
                },
              ],
            };
          if (name === 'reviewer' && count === 1)
            return {
              complaints: [
                {
                  id: `${input.namespace}/new`,
                  file: 'a.ts',
                  text: 'A regression in the fix.',
                  severity: 'should-fix',
                },
              ],
            };
          if (name === 'fixer')
            return {
              resolutions: (input.complaints as { id: string }[]).map(
                ({ id }) => ({
                  id,
                  status: 'fixed',
                  note: 'Fixed and checked.',
                }),
              ),
            };
          return undefined;
        },
      });
      expect(await f.boot()).toMatchObject({ status: 'parked' });
      const fixers = f.calls.filter((call) => call.name === 'fixer');
      expect(fixers).toHaveLength(2);
      expect(fixers[0].input.complaints).toEqual([
        expect.objectContaining({ severity: 'must-fix' }),
        expect.objectContaining({ severity: 'should-fix' }),
      ]);
      expect(fixers[0].input.reviewHistory).toHaveLength(3);
      expect(fixers[1].input.reviewHistory).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            status: 'fixed',
            resolutions: [
              expect.objectContaining({ note: 'Fixed and checked.' }),
            ],
          }),
          expect.objectContaining({ status: 'ignored' }),
        ]),
      );
      for (const name of ['compliance-reviewer', 'reviewer']) {
        const passes = f.calls.filter((call) => call.name === name);
        expect(passes[0].input.reviewScope).toMatchObject({ kind: 'initial' });
        expect(passes[1].input).toMatchObject({
          diff: 'only newer commits',
          reviewScope: { kind: 'incremental', base: 'abc' },
        });
      }
      const calls = f.calls.length;
      expect(await f.boot()).toMatchObject({ status: 'parked' });
      expect(f.calls).toHaveLength(calls);
    },
  );

  it('bounds a disagreement loop, keeps compliance rule-free, and exposes unresolved blocking Complaints', async () => {
    const f = fixture({
      agent: (name, input) => {
        if (name === 'compliance-reviewer')
          return {
            complaints: [
              {
                id: `${input.namespace}/c1`,
                file: 'src/a.ts',
                text: 'Empty input crashes.',
                quote: 'Return an empty list.',
                ...(Array.isArray(input.disagreements) &&
                input.disagreements.length
                  ? { rebuttal: 'The empty case still crashes.' }
                  : {}),
              },
            ],
          };
        if (name === 'fixer')
          return {
            resolutions: (input.complaints as { id: string }[]).map(
              ({ id }) => ({
                id,
                status: 'disagreed',
                note: 'Not required.',
              }),
            ),
          };
        return undefined;
      },
    });
    expect(await f.boot()).toMatchObject({
      status: 'finished',
      outcome: 'exhausted',
    });
    const reviews = f.calls.filter(
      ({ name }) => name === 'compliance-reviewer',
    );
    expect(reviews).toHaveLength(5);
    expect(reviews.every(({ input }) => !('rules' in input))).toBe(true);
    expect(reviews[1].input.disagreements).toEqual([
      {
        id: 'compliance-reviewer/1/1/c1',
        text: 'Empty input crashes.',
        why: 'Not required.',
      },
    ]);
    expect(f.trace).not.toContain('checkpoint');
    expect(f.scmCalls.at(-1)).toMatchObject({
      operation: 'markDraft',
      args: [expect.anything(), true],
    });
    expect(f.trace.at(-1)).toContain('compliance-reviewer/5/1/c1');
  });

  it('revalidates every gate after a Checkpoint Steer and drafts on rejection', async () => {
    const f = fixture();
    f.answer({ decision: 'steer', message: 'Also handle whitespace.' });
    f.answer({ decision: 'reject', reason: 'Not ready.' });
    expect(await f.boot()).toMatchObject({
      status: 'finished',
      outcome: 'rejected',
    });
    const fixer = f.calls.find(({ name }) => name === 'fixer');
    expect(fixer?.input.steer).toBe('Also handle whitespace.');
    expect(
      f.calls.filter(({ name }) => name === 'compliance-reviewer'),
    ).toHaveLength(2);
    expect(f.calls.filter(({ name }) => name === 'ui-triage')).toHaveLength(2);
    expect(f.calls.filter(({ name }) => name === 'reviewer')).toHaveLength(2);
    expect(
      f.scmCalls.filter(({ operation }) => operation === 'waitForCi'),
    ).toHaveLength(2);
    expect(f.trace).not.toContain('armAutoMerge');
  });

  it.skipIf(mode !== 'flow')(
    'refreshes CI on continuation instead of invoking an unconnected review fixer',
    async () => {
      let repaired = false;
      const f = fixture({
        continuation: true,
        agent: (name) =>
          name === 'ci-fixer'
            ? { action: 'unresolved', summary: 'No child logs.' }
            : undefined,
        scm: (operation) =>
          operation === 'waitForCi' && !repaired
            ? {
                status: 'failed',
                headSha: 'abc',
                failedJobs: [
                  { id: '9', name: 'Pipeline 9', failedSteps: [], logTail: '' },
                ],
              }
            : undefined,
      });
      expect(await f.boot()).toMatchObject({
        status: 'finished',
        outcome: 'exhausted',
      });
      repaired = true;
      const path = join(dir, 'journal.jsonl');
      const writer = await JournalWriter.open(path);
      await writer.retry(
        'continue-ci',
        String((await readJournal(path)).end?.seq),
        [],
        undefined,
        true,
      );
      const resumed = await f.boot();
      if (resumed.status === 'failed') throw new Error(JSON.stringify(resumed));
      expect(resumed).toMatchObject({ status: 'parked' });
      expect(f.calls.filter((call) => call.name === 'fixer')).toHaveLength(0);
      expect(
        f.scmCalls.filter((call) => call.operation === 'waitForCi'),
      ).toHaveLength(2);
    },
  );

  it('spends at most three CI repair attempts and never readies failed CI', async () => {
    const f = fixture({
      agent: (name) => (name === 'ci-fixer' ? { action: 'retry' } : undefined),
      scm: (operation) =>
        operation === 'waitForCi'
          ? {
              status: 'failed',
              headSha: 'abc',
              failedJobs: [
                { name: 'test', failedSteps: ['unit'], logTail: 'Timeout' },
              ],
            }
          : undefined,
    });
    expect(await f.boot()).toMatchObject({
      status: 'finished',
      outcome: 'exhausted',
    });
    expect(f.calls.filter(({ name }) => name === 'ci-fixer')).toHaveLength(3);
    expect(
      f.scmCalls.filter(({ operation }) => operation === 'retryFailedJobs'),
    ).toHaveLength(3);
    expect(f.trace).not.toContain('checkpoint');
    expect(
      f.scmCalls.filter(
        ({ operation, args }) => operation === 'markDraft' && args[1] === false,
      ),
    ).toEqual([]);
  });

  it.skipIf(mode !== 'flow')(
    'preserves the historical missing-UI planner and fixer sequence on replay',
    async () => {
      const source = parseFlow(flowSource);
      source.settings.ui = null;
      delete source.settings.repositories;
      const f = fixture({
        triggers: flowTriggers(JSON.stringify(source), join(dir, 'snapshot')),
        agent: (name) => {
          if (name === 'ui-triage') return { isFrontend: true };
          if (name === 'ui-planner')
            return {
              checks: [
                {
                  id: 'page',
                  url: '/',
                  action: 'Open page',
                  expected: 'Page renders',
                },
              ],
            };
          if (name === 'fixer')
            throw new Error('Historical missing UI configuration');
          return undefined;
        },
      });
      expect(await f.boot()).toMatchObject({
        status: 'failed',
        error: { message: 'Historical missing UI configuration' },
      });
      expect(f.calls.some((call) => call.name === 'ui-planner')).toBe(true);
      const journalPath = join(dir, 'journal.jsonl');
      await (
        await JournalWriter.open(journalPath)
      ).retry(
        'replay-ui',
        retryStepKey((await readJournal(journalPath)).entries)!,
        [],
      );
      expect(await f.boot()).toMatchObject({
        status: 'failed',
        error: { message: 'Historical missing UI configuration' },
      });
    },
  );

  async function visualTemplate() {
    const snapshot = join(dir, 'snapshot');
    await cp(new URL('../../content/.rocky/', import.meta.url), snapshot, {
      recursive: true,
    });
    if (mode === 'flow') {
      const flow = parseFlow(flowSource);
      flow.settings.ui = { start: 'test-server', url: 'http://127.0.0.1' };
      flow.settings.readiness = { attempts: 2, intervalMs: 1 };
      vi.stubEnv('ROCKY_SCREENSHOT_DIR', dir);
      vi.stubEnv('ROCKY_RUN_DIR', dir);
      return flowTriggers(JSON.stringify(flow), snapshot);
    }
    const path = join(snapshot, 'workflow.ts');
    const source = await readFile(path, 'utf8');
    await writeFile(
      path,
      source
        .replace(
          '= null;',
          '= { start: "test-server", url: "http://127.0.0.1" };',
        )
        .replace(
          'attempts: 30, intervalMs: 1000',
          'attempts: 2, intervalMs: 0',
        ),
    );
    vi.stubEnv('ROCKY_SCREENSHOT_DIR', dir);
    vi.stubEnv('ROCKY_RUN_DIR', dir);
    return (
      await createJiti(import.meta.url, {
        alias: {
          '@rocky/sdk': new URL('../../../sdk/src/index.ts', import.meta.url)
            .pathname,
        },
      }).import<{ default: Triggers }>(path)
    ).default;
  }

  it.skipIf(mode !== 'flow')(
    'launches UI from the captured workspace and captures the whole command without parent env',
    async () => {
      await visualTemplate();
      for (const key of [
        'ROCKY_RUN_DIR',
        'ROCKY_LEAD_REPO',
        'ROCKY_SCREENSHOT_DIR',
      ])
        vi.stubEnv(key, undefined);
      const frontend = join(dir, 'workspace', 'app', 'frontend');
      await mkdir(frontend, { recursive: true });
      const source = parseFlow(flowSource);
      source.settings.ui = {
        start: 'printf startup-diagnostic >&2; cd frontend && pwd',
        url: 'http://127.0.0.1',
      };
      source.settings.pullRequests = 'lead';
      source.settings.readiness = { attempts: 1, intervalMs: 1 };
      vi.stubGlobal('fetch', async () => ({ ok: true }));
      const f = fixture({
        triggers: flowTriggers(JSON.stringify(source), join(dir, 'snapshot')),
        members: [{ name: 'app', path: 'app', lead: true }],
        exec: (command) => {
          if (command.includes('startup-diagnostic')) {
            const result = spawnSync('/bin/sh', ['-c', command], {
              cwd: join(dir, 'workspace'),
              encoding: 'utf8',
            });
            expect(result.status, result.stderr).toBe(0);
          }
          return undefined;
        },
        agent: (name) => {
          if (name === 'ui-triage') return { isFrontend: true };
          if (name === 'ui-planner')
            return {
              checks: [
                { id: 'page', url: '/', action: 'Open.', expected: 'Renders.' },
              ],
            };
          if (name === 'ui-inspector')
            return {
              results: [
                {
                  id: 'page',
                  verdict: 'ok',
                  note: 'Visible.',
                  screenshots: [],
                  observations: [],
                },
              ],
            };
          return undefined;
        },
      });
      const result = await f.boot();
      expect(result, JSON.stringify(result)).toMatchObject({
        status: 'parked',
      });
      expect(await readFile(join(dir, 'dev-server.log'), 'utf8')).toBe(
        `startup-diagnostic${frontend}\n`,
      );
    },
  );

  it('writes Checks once, sweeps all of them each pass, and anchors Observations in parallel before fixing', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: true }));
    const checks = [
      {
        id: 'desktop',
        url: '/',
        action: 'Open desktop.',
        expected: 'Button visible.',
      },
      {
        id: 'mobile',
        url: '/',
        action: 'Open mobile.',
        expected: 'Button visible.',
      },
    ];
    const f = fixture({
      triggers: await visualTemplate(),
      agent: (name, input, count) => {
        if (name === 'ui-triage') return { isFrontend: true };
        if (name === 'ui-planner') return { checks };
        if (name === 'ui-inspector')
          return {
            results: checks.map(({ id }) => ({
              id,
              verdict: count === 1 ? 'problem' : 'ok',
              note: 'Fixture UI result.',
              screenshots: [],
              observations:
                count === 1
                  ? [
                      {
                        url: 'http://127.0.0.1:12345/',
                        text: 'Button clipped.',
                        screenshots: [],
                      },
                    ]
                  : [],
            })),
          };
        if (name === 'ui-complaint-writer')
          return {
            id: `${input.namespace}/c1`,
            file: 'src/button.ts',
            text: 'Button clipped.',
          };
        if (name === 'fixer')
          return {
            resolutions: (input.complaints as { id: string }[]).map(
              ({ id }) => ({
                id,
                status: 'disagreed',
                note: 'No route exists.',
              }),
            ),
          };
        return undefined;
      },
    });
    expect((await f.boot()).status).toBe('parked');
    expect(f.calls.filter(({ name }) => name === 'ui-planner')).toHaveLength(1);
    const inspections = f.calls.filter(({ name }) => name === 'ui-inspector');
    expect(inspections).toHaveLength(2);
    expect(inspections.map(({ input }) => input.checks)).toEqual([
      checks,
      checks,
    ]);
    expect(inspections[1].input.previousExplanations).toEqual([
      'No route exists.',
      'No route exists.',
    ]);
    expect(inspections[0].options).toMatchObject({
      tools: ['read'],
      mcp: ['playwright'],
    });
    expect(
      f.calls.filter(({ name }) => name === 'ui-complaint-writer'),
    ).toHaveLength(2);
    expect(
      inspections.every(
        ({ input }) => !('diff' in input) && !('complaints' in input),
      ),
    ).toBe(true);
  });

  it('treats a dev server that never becomes ready as an anchored Complaint, not a skipped UI gate', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('connection refused');
    });
    const f = fixture({
      triggers: await visualTemplate(),
      agent: (name, input) => {
        if (name === 'ui-triage') return { isFrontend: true };
        if (name === 'ui-planner')
          return {
            checks: [
              { id: 'boot', url: '/', action: 'Open.', expected: 'Renders.' },
            ],
          };
        if (name === 'ui-complaint-writer')
          return {
            id: `${input.namespace}/boot`,
            file: 'vite.config.ts',
            text: 'Invalid import prevents startup.',
          };
        if (name === 'fixer')
          return {
            resolutions: (input.complaints as { id: string }[]).map(
              ({ id }) => ({
                id,
                status: 'fixed',
                note: 'Attempted repair.',
              }),
            ),
          };
        return undefined;
      },
    });
    expect(await f.boot()).toMatchObject({
      status: 'finished',
      outcome: 'exhausted',
    });
    expect(
      f.calls.filter(({ name }) => name === 'ui-complaint-writer'),
    ).toHaveLength(5);
    expect(f.calls.filter(({ name }) => name === 'ui-inspector')).toHaveLength(
      0,
    );
    expect(f.trace.at(-1)).toContain('vite.config.ts');
    expect(f.trace).not.toContain('checkpoint');
  });

  it.skipIf(mode !== 'flow').each([false, true])(
    'reports a missing baseline as recoverable exhaustion (frozen graph=%s)',
    async (frozen) => {
      const source = parseFlow(flowSource);
      source.settings.environmentVersion = 1;
      source.settings.execution = [];
      if (frozen)
        source.edges = source.edges.filter(
          (edge) =>
            !(edge.source === 'implement' && edge.sourceHandle === 'exhausted'),
        );
      const f = fixture({
        triggers: flowTriggers(JSON.stringify(source), join(dir, 'snapshot')),
      });
      const result = await f.boot();
      expect(result, JSON.stringify(result)).toMatchObject({
        status: 'finished',
        outcome: 'exhausted',
      });
      expect(f.trace.join('\n')).toContain(
        'Discover and configure baseline capabilities with executable checks',
      );
      expect(f.calls.some(({ name }) => name === 'implementer')).toBe(false);
      expect(calledRepos(f, 'openPr')).toEqual([]);
      expect(await f.boot()).toMatchObject({
        status: 'finished',
        outcome: 'exhausted',
      });
    },
  );

  it.skipIf(mode === 'legacy')(
    'exhausts with a Flow settings action when a frontend has no UI configuration',
    async () => {
      const source = parseFlow(flowSource);
      source.settings.uiConfigurationVersion = 1;
      const f = fixture({
        triggers: flowTriggers(JSON.stringify(source), join(dir, 'snapshot')),
        agent: (name) =>
          name === 'ui-triage' ? { isFrontend: true } : undefined,
      });

      const result = await f.boot();
      expect(result).toMatchObject({
        status: 'finished',
        outcome: 'exhausted',
      });
      expect(f.calls.filter(({ name }) => name === 'fixer')).toHaveLength(0);
      expect(f.calls.filter(({ name }) => name === 'ui-planner')).toHaveLength(
        0,
      );
      expect(f.trace.join('\n')).toContain('"file": "Flow settings"');
      expect(f.trace.join('\n')).toContain(
        'Use Repair configuration and resume',
      );
    },
  );

  it.skipIf(mode !== 'flow').each([false, true])(
    'repairs missing UI settings at the stop boundary without repeating implementation or compliance (catalog=%s)',
    async (catalog) => {
      vi.stubGlobal('fetch', async () => ({ ok: true }));
      vi.stubEnv('ROCKY_SCREENSHOT_DIR', dir);
      vi.stubEnv('ROCKY_RUN_DIR', dir);
      const source = parseFlow(flowSource);
      source.settings.uiConfigurationVersion = 1;
      if (catalog) source.settings.execution = [];
      const f = fixture({
        continuation: true,
        continuationSource: JSON.stringify(source),
        agent: (name, input) => {
          if (name === 'ui-triage')
            return 'services' in input
              ? {
                  isFrontend: true,
                  selected: [],
                  reason: 'Frontend changed.',
                }
              : { isFrontend: true };
          if (name === 'ui-planner')
            return {
              checks: [
                {
                  id: 'desktop',
                  url: '/',
                  action: 'Open desktop.',
                  expected: 'Button visible.',
                },
              ],
            };
          if (name === 'ui-inspector')
            return {
              results: [
                {
                  id: 'desktop',
                  verdict: 'ok',
                  note: 'Visible.',
                  screenshots: [],
                  observations: [],
                },
              ],
            };
          return undefined;
        },
      });
      expect(await f.boot()).toMatchObject({
        status: 'finished',
        outcome: 'exhausted',
      });
      // Even an ordinary boot must replay the new configuration stop, not enter the legacy UI path.
      expect(await f.boot()).toMatchObject({
        status: 'finished',
        outcome: 'exhausted',
      });
      const path = join(dir, 'journal.jsonl');
      const before = await readFile(path, 'utf8');
      await (
        await JournalWriter.open(path)
      ).retry(
        'repair-1',
        String((await readJournal(path)).end?.seq),
        [],
        undefined,
        true,
        {
          ui: { start: 'test-server', url: 'http://127.0.0.1' },
          commands: { install: 'install-frontend' },
        },
      );
      const resumed = await f.boot();
      if (resumed.status === 'failed') throw Error(JSON.stringify(resumed));
      expect(resumed).toMatchObject({ status: 'parked' });
      expect((await readFile(path, 'utf8')).startsWith(before)).toBe(true);
      const count = (name: string) =>
        f.calls.filter((call) => call.name === name).length;
      expect(count('implementer')).toBe(1);
      expect(count('compliance-reviewer')).toBe(1);
      expect(count('fixer')).toBe(0);
      expect(count('ui-inspector')).toBe(1);
      expect(f.trace.some((line) => line.includes('install-frontend'))).toBe(
        true,
      );
      const calls = f.calls.length;
      expect(await f.boot()).toMatchObject({ status: 'parked' });
      expect(f.calls).toHaveLength(calls);
    },
  );

  it('runs the merger only for reported conflicts, then revalidates before asking again and arming', async () => {
    const pr = {
      repo: 'fixture',
      id: 'pr-1',
      number: 1,
      url: 'https://example.test/pr/1',
      sourceBranch: 'test-1',
      baseBranch: 'main',
      headSha: 'abc',
      state: 'open',
      draft: true,
    };
    const f = fixture({
      scm: (operation, count) =>
        operation === 'updateBranch' && count === 1
          ? { status: 'conflict', pr }
          : undefined,
    });
    f.approve();
    f.approve();
    f.merge();
    expect(await f.boot()).toMatchObject({
      status: 'finished',
      outcome: 'merged',
    });
    expect(f.calls.filter(({ name }) => name === 'merger')).toHaveLength(1);
    expect(f.trace.filter((command) => command.includes('git merge'))).toEqual([
      'cd -- "$ROCKY_LEAD_REPO" && git merge --no-edit -- \'refs/remotes/origin/main\'',
    ]);
    expect(
      f.calls.filter(({ name }) => name === 'compliance-reviewer'),
    ).toHaveLength(2);
    expect(
      f.scmCalls.filter(({ operation }) => operation === 'waitForCi'),
    ).toHaveLength(mode === 'flow' ? 3 : 2);
    expect(f.trace.indexOf('merger')).toBeLessThan(
      f.trace.lastIndexOf('checkpoint'),
    );
    expect(f.trace.lastIndexOf('checkpoint')).toBeLessThan(
      f.trace.indexOf('armAutoMerge'),
    );
  });

  it('does not accept green CI for another head', async () => {
    const f = fixture({
      scm: (operation) =>
        operation === 'waitForCi'
          ? { status: 'passed', headSha: 'stale', failedJobs: [] }
          : undefined,
    });
    expect((await f.boot()).status).toBe('failed');
    expect(f.trace).not.toContain('checkpoint');
  });

  it('fails a refused ready-flip instead of presenting a ready Checkpoint', async () => {
    const f = fixture({
      scm: (operation) =>
        operation === 'markDraft'
          ? {
              refused: true,
              reason: 'permission_denied',
              message: 'Cannot make the PR ready.',
              fix: 'Grant PR write access.',
            }
          : undefined,
    });
    expect(await f.boot()).toMatchObject({
      status: 'failed',
      error: { message: expect.stringContaining('Grant PR write access.') },
    });
    expect(f.trace).not.toContain('checkpoint');
  });

  it('rechecks earlier gates when the final review fixes code and preserves fixes on the PR', async () => {
    const f = fixture({
      agent: (name, input, count) => {
        if (name === 'reviewer' && count === 1)
          return {
            complaints: [
              {
                id: `${input.namespace}/c1`,
                file: 'src/a.ts',
                text: 'Regression.',
              },
            ],
          };
        if (name === 'fixer')
          return {
            resolutions: (input.complaints as { id: string }[]).map(
              ({ id }) => ({
                id,
                status: 'fixed',
                note: 'Fixed the regression.',
              }),
            ),
          };
        return undefined;
      },
    });
    expect((await f.boot()).status).toBe('parked');
    expect(
      f.calls.filter(({ name }) => name === 'compliance-reviewer'),
    ).toHaveLength(2);
    expect(f.calls.filter(({ name }) => name === 'ui-triage')).toHaveLength(2);
    expect(f.trace.indexOf('push', f.trace.indexOf('fixer'))).toBeLessThan(
      f.trace.lastIndexOf('reviewer'),
    );
  });

  it('addresses unresolved PR conversations once each without prior Run hand-over state', async () => {
    const replies: { id: string; body: string }[] = [];
    const threads = [
      {
        id: 'a',
        path: 'src/a.ts',
        line: 10,
        body: 'Handle empty input.',
        resolved: false,
      },
      {
        id: 'b',
        path: 'src/b.ts',
        body: 'This should be removed.',
        resolved: false,
      },
      { id: 'done', path: 'src/c.ts', body: 'Already fixed.', resolved: true },
    ];
    const recap = vi.fn(async () => ({
      id: 'r_fixture',
      url: 'https://rocky.test/recap',
    }));
    const result = await addressPrConversations({
      models: {
        review: { harness: 'opencode', model: 'review-model', effort: 'high' },
        implementation: {
          harness: 'claude-code',
          model: 'implementation-model',
          effort: 'high',
        },
      },
      visualRecap: recap,
      stage: () => undefined,
      issue: {
        identifier: 'TEST-1',
        title: 'Fix it',
        url: 'https://example.test/issue/1',
      },
      exec: async () => ({ exitCode: 0, stdout: 'abc', stderr: '' }),
      scm: {
        openPr: async () => ({ id: 'pr', state: 'open' }),
        reviewThreads: async () => threads,
        replyToThread: async (thread: { id: string }, body: string) => {
          replies.push({ id: thread.id, body });
        },
      },
      agent: async (
        _name: string,
        opts: {
          input: { complaints: { id: string; file: string; line?: number }[] };
          schema: z.ZodType;
        },
      ) => {
        expect(opts.input.complaints).toHaveLength(2);
        expect(opts.input.complaints[0]).toMatchObject({
          file: 'src/a.ts',
          line: 10,
        });
        return Object.assign(
          {},
          opts.schema.parse({
            resolutions: opts.input.complaints.map(({ id }, index) => ({
              id,
              status: index ? 'disagreed' : 'fixed',
              note: index ? 'It is needed for callers.' : 'Added a guard.',
            })),
          }),
          { summary: 'Addressed both threads.' },
        );
      },
    });
    expect(result).toBe('completed');
    expect(recap).toHaveBeenCalledWith(
      expect.objectContaining({
        pr: expect.objectContaining({ headSha: 'abc' }),
      }),
    );
    expect(replies).toEqual([
      { id: 'a', body: 'Fixed in abc. Added a guard.' },
      { id: 'b', body: 'It is needed for callers.' },
    ]);
  });

  it('clarifies repeatedly before planning and carries the complete decision record downstream', async () => {
    const f = fixture({
      agent: (name, _input, count) =>
        name === 'refiner'
          ? count < 3
            ? {
                status: 'questions',
                reason: 'Repository scope is ambiguous.',
                questions: [
                  count === 1
                    ? 'Which repository?'
                    : 'What should empty input return?',
                ],
              }
            : {
                status: 'clear',
                delivery: {
                  kind: 'pull-request',
                  merge: true,
                  stateChanges: true,
                },
                scope: 'App only. Empty input returns an empty list.',
                decisions: [
                  'User chose app only.',
                  'User chose an empty list.',
                ],
                acceptanceCriteria: [
                  'An empty list is returned for empty input.',
                ],
                outOfScope: ['Other repositories.'],
              }
          : undefined,
    });
    expect(await f.boot()).toMatchObject({ status: 'parked' });
    expect(f.calls.some((call) => call.name === 'planner')).toBe(false);
    f.answer({ decision: 'steer', message: 'App only.' });
    expect(await f.boot()).toMatchObject({ status: 'parked' });
    expect(f.calls.some((call) => call.name === 'implementer')).toBe(false);
    f.answer({ decision: 'steer', message: 'An empty list.' });
    expect(await f.boot()).toMatchObject({ status: 'parked' });
    const planner = f.calls.find((call) => call.name === 'planner');
    expect(JSON.stringify(planner?.input)).toContain(
      'App only. Empty input returns an empty list.',
    );
    expect(
      f.trace.find(
        (line) =>
          line.startsWith('post:') && line.includes('Scope decision record'),
      ),
    ).toContain('Scope decision record');
    expect(
      JSON.stringify(
        f.calls.filter((call) => call.name === 'refiner').at(-1)?.input,
      ),
    ).toContain('An empty list.');
  });

  it('delivers a no-PR ticket as a reviewed Linear comment without SCM or editing', async () => {
    const body = '## Architecture\n```mermaid\nflowchart LR\n  API --> DB\n```';
    const f = fixture({
      agent: (name) => {
        if (name === 'refiner')
          return {
            status: 'clear',
            scope:
              'Inspect repositories and return a Linear comment. No PR or edits.',
            decisions: [
              'The user explicitly requests a Linear comment and no PR.',
            ],
            acceptanceCriteria: ['Explain the architecture.'],
            outOfScope: ['Repository changes.'],
            delivery: { kind: 'linear-comment', stateChanges: false },
          };
        if (name === 'deliverable-writer') return { body };
        if (name === 'deliverable-reviewer')
          return {
            assessments: [
              {
                criterion: 'Explain the architecture.',
                evidence: 'The diagram explains the architecture.',
                problems: [],
              },
            ],
            problems: [],
          };
        return undefined;
      },
    });
    expect(await f.boot()).toMatchObject({
      status: 'finished',
      outcome: 'completed',
    });
    expect(f.scmCalls).toEqual([]);
    expect(f.trace).not.toContain('implementer');
    for (const call of f.calls.filter(({ name }) =>
      name.startsWith('deliverable-'),
    )) {
      expect(call.options?.tools).toEqual(['read', 'bash']);
    }
    expect(f.trace.some((line) => line.includes('git push'))).toBe(false);
    expect(f.trace).toContain(`comment:${body}`);
    expect(f.trace.filter((line) => line.startsWith('comment:'))).toHaveLength(
      1,
    );
    expect(f.trace).not.toContain('Done');
    const calls = f.calls.length;
    expect(await f.boot()).toMatchObject({
      status: 'finished',
      outcome: 'completed',
    });
    expect(f.calls).toHaveLength(calls);
    expect(f.trace.filter((line) => line === `comment:${body}`)).toHaveLength(
      1,
    );
  });

  const commentScope = {
    status: 'clear',
    scope: 'Explain the architecture in a Linear comment.',
    decisions: ['Deliver in Linear; no PR or repository edits.'],
    acceptanceCriteria: ['Explain the architecture.'],
    outOfScope: ['Repository changes.'],
    delivery: { kind: 'linear-comment', stateChanges: true },
  };

  it('repairs a rejected comment and reviews the replacement before publishing', async () => {
    const f = fixture({
      agent: (name, input, count) => {
        if (name === 'refiner') return commentScope;
        if (name === 'deliverable-writer')
          return { body: count === 1 ? 'Incomplete' : 'Complete architecture' };
        if (name === 'deliverable-reviewer')
          return {
            assessments: [
              {
                criterion: 'Explain the architecture.',
                evidence: 'Checked repository entrypoints.',
                problems:
                  input.body === 'Incomplete'
                    ? ['Missing the storage connection.']
                    : [],
              },
            ],
            problems: [],
          };
        return undefined;
      },
    });
    expect(await f.boot()).toMatchObject({
      status: 'finished',
      outcome: 'completed',
    });
    expect(
      f.calls.filter(({ name }) => name === 'deliverable-reviewer'),
    ).toHaveLength(4);
    expect(
      f.calls.filter(({ name }) => name === 'deliverable-writer')[1].input
        .previous,
    ).toMatchObject({
      body: 'Incomplete',
      problems: expect.arrayContaining(['Missing the storage connection.']),
    });
    expect(f.trace.filter((line) => line.startsWith('comment:'))).toEqual([
      'comment:Complete architecture',
    ]);
    expect(f.trace).toContain(mode === 'legacy' ? 'In Review' : 'Done');
    expect(f.scmCalls).toEqual([]);
  });

  it.skipIf(mode !== 'flow')(
    'continues an exhausted deliverable with its previous draft and review feedback',
    async () => {
      const f = fixture({
        continuation: true,
        agent: (name) => {
          if (name === 'refiner') return commentScope;
          if (name === 'deliverable-writer') return { body: 'Incomplete' };
          if (name === 'deliverable-reviewer')
            return {
              assessments: [
                {
                  criterion: 'Explain the architecture.',
                  evidence: 'Missing.',
                  problems: ['Missing architecture.'],
                },
              ],
              problems: [],
            };
          return undefined;
        },
      });
      expect(await f.boot()).toMatchObject({
        status: 'finished',
        outcome: 'exhausted',
      });
      const path = join(dir, 'journal.jsonl');
      await (
        await JournalWriter.open(path)
      ).retry(
        'continue-comment',
        String((await readJournal(path)).end?.seq),
        [],
        undefined,
        true,
      );
      expect(await f.boot()).toMatchObject({
        status: 'finished',
        outcome: 'exhausted',
      });
      const drafts = f.calls.filter(
        (call) => call.name === 'deliverable-writer',
      );
      expect(drafts).toHaveLength(10);
      expect(drafts[5].input.previous).toMatchObject({
        body: 'Incomplete',
        problems: expect.arrayContaining(['Missing architecture.']),
      });
      expect(f.trace.filter((line) => line.startsWith('comment:'))).toEqual([]);
    },
  );

  it('exhausts comment review without publishing an unapproved deliverable', async () => {
    const f = fixture({
      agent: (name) => {
        if (name === 'refiner') return commentScope;
        if (name === 'deliverable-writer') return { body: 'Incomplete' };
        if (name === 'deliverable-reviewer')
          return {
            assessments: [
              {
                criterion: 'Explain the architecture.',
                evidence: 'No architecture in the body.',
                problems: ['Missing architecture.'],
              },
            ],
            problems: [],
          };
        return undefined;
      },
    });
    expect(await f.boot()).toMatchObject({
      status: 'finished',
      outcome: 'exhausted',
    });
    expect(
      f.calls.filter(({ name }) => name === 'deliverable-writer'),
    ).toHaveLength(5);
    expect(f.trace.filter((line) => line.startsWith('comment:'))).toEqual([]);
    expect(f.trace).not.toContain('In Review');
    expect(f.scmCalls).toEqual([]);
  });

  it('does not complete or advance state when comment delivery fails', async () => {
    const f = fixture({
      comment: () => {
        throw new Error('Linear unavailable');
      },
      agent: (name) => {
        if (name === 'refiner') return commentScope;
        if (name === 'deliverable-writer') return { body: 'Architecture' };
        if (name === 'deliverable-reviewer')
          return {
            assessments: [
              {
                criterion: 'Explain the architecture.',
                evidence: 'Source-backed architecture.',
                problems: [],
              },
            ],
            problems: [],
          };
        return undefined;
      },
    });
    expect(await f.boot()).toMatchObject({ status: 'failed' });
    expect(f.trace).not.toContain('In Review');
    expect(f.trace).not.toContain('Done');
  });

  it('hands off a validated PR without approval or merge when the ticket forbids Rocky merging', async () => {
    const f = fixture({
      agent: (name) =>
        name === 'refiner'
          ? {
              ...commentScope,
              scope: 'Implement empty input and hand off a PR without merging.',
              decisions: [
                'The user requests a PR for human handling, without automatic merge.',
              ],
              outOfScope: ['Automatic merge.'],
              delivery: {
                kind: 'pull-request',
                merge: false,
                stateChanges: false,
              },
            }
          : undefined,
    });
    expect(await f.boot()).toMatchObject({
      status: 'finished',
      outcome: 'completed',
    });
    expect(f.trace).toContain('waitForCi');
    expect(f.trace).not.toContain('checkpoint');
    expect(f.trace).not.toContain('updateBranch');
    expect(f.trace).not.toContain('armAutoMerge');
    expect(f.trace).not.toContain('In Progress');
    expect(f.trace).not.toContain('In Review');
    expect(f.trace.at(-1)).toContain(
      'comment:Ready for review: https://example.test/pr/1',
    );
  });

  it('passes human steering to subsequent compliance review', async () => {
    const f = fixture();
    f.answer({ decision: 'steer', message: 'Also handle whitespace.' });
    f.answer({ decision: 'reject' });
    await f.boot();
    const reviews = f.calls.filter(
      ({ name }) => name === 'compliance-reviewer',
    );
    expect(JSON.stringify(reviews[1].input.issue)).toContain(
      'Also handle whitespace.',
    );
  });

  it('runs configured checks and blocks handoff after repeated failures even when agents claim success', async () => {
    const snapshot = join(dir, 'validation-snapshot');
    await cp(new URL('../../content/.rocky/', import.meta.url), snapshot, {
      recursive: true,
    });
    const path = join(snapshot, 'workflow.ts');
    await writeFile(
      path,
      (await readFile(path, 'utf8')).replace(
        "test: ''",
        "test: 'fixture-test'",
      ),
    );
    const loaded = await createJiti(import.meta.url, {
      alias: {
        '@rocky/sdk': new URL('../../../sdk/src/index.ts', import.meta.url)
          .pathname,
      },
    }).import<{ default: Triggers }>(path);
    const f = fixture({
      triggers:
        mode === 'flow'
          ? flowTriggers(
              JSON.stringify({
                ...parseFlow(flowSource),
                settings: {
                  ...parseFlow(flowSource).settings,
                  commands: {
                    install: '',
                    test: 'fixture-test',
                    lint: '',
                    build: '',
                  },
                },
              }),
              snapshot,
            )
          : loaded.default,
      exec: (command) =>
        command.includes('fixture-test')
          ? { exitCode: 1, stdout: 'empty case still fails', stderr: '' }
          : undefined,
      agent: (name, input) =>
        name === 'fixer'
          ? {
              resolutions: (input.complaints as { id: string }[]).map(
                ({ id }) => ({ id, status: 'fixed', note: 'Claimed success.' }),
              ),
            }
          : undefined,
    });
    expect(await f.boot()).toMatchObject({
      status: 'finished',
      outcome: 'exhausted',
    });
    expect(f.calls.filter(({ name }) => name === 'fixer')).toHaveLength(4);
    expect(f.trace).not.toContain('checkpoint');
    expect(f.trace).not.toContain('armAutoMerge');
    expect(f.trace.at(-1)).toContain('empty case still fails');
  });

  it('typechecks the shipped workflow against the public SDK', async () => {
    await promisify(execFile)(process.execPath, [
      createRequire(import.meta.url).resolve('typescript/bin/tsc'),
      '--ignoreConfig',
      '--noEmit',
      '--strict',
      '--module',
      'NodeNext',
      '--target',
      'ES2022',
      '--skipLibCheck',
      '--types',
      'node',
      new URL('../../content/.rocky/workflow.ts', import.meta.url).pathname,
    ]);
  });

  it('creates the visual recap after validation and before readying or asking the human', async () => {
    const f = fixture();
    expect((await f.boot()).status).toBe('parked');
    expect(f.trace.indexOf('visualRecap')).toBeGreaterThan(
      f.trace.indexOf('waitForCi'),
    );
    expect(f.trace.indexOf('visualRecap')).toBeLessThan(
      f.trace.indexOf('markDraft'),
    );
    expect(f.trace.indexOf('visualRecap')).toBeLessThan(
      f.trace.indexOf('checkpoint'),
    );
    const ready = f.scmCalls.find(
      ({ operation, args }) => operation === 'markDraft' && args[1] === false,
    );
    expect(JSON.stringify(ready)).toContain('https://rocky.test/recap');
  });

  it('feeds previous-session answers to refinement and downstream planning', async () => {
    const comments = [
      {
        id: 'prior-answer',
        body: 'Return an empty list.',
        createdAt: '2026-09-01T00:00:00Z',
        userId: 'human',
        sessionId: null,
        parentId: 'old-session-thread',
      },
    ];
    const f = fixture({ comments });
    await f.boot();
    for (const name of ['refiner', 'planner']) {
      expect(
        f.calls.find((call) => call.name === name)?.input.issue,
      ).toMatchObject({ comments });
    }
  });

  it('reviews publication criteria as readiness, validates diagrams, and publishes only after approval', async () => {
    const criterion =
      'A comment is published on the issue containing the architecture diagram.';
    const body = '```mermaid\nflowchart LR\nA --> B\n```';
    const f = fixture({
      exec: (command) =>
        command.includes('ROCKY_MERMAID_CHECK')
          ? {
              exitCode: 0,
              stdout: JSON.stringify({
                ok: true,
                diagrams: [{ index: 1, valid: true }],
                rendered: false,
              }),
              stderr: '',
            }
          : undefined,
      agent: (name, input) => {
        if (name === 'refiner')
          return { ...commentScope, acceptanceCriteria: [criterion] };
        if (name === 'deliverable-writer') return { body };
        if (name === 'deliverable-reviewer') {
          expect(input.reviewContract).toMatchObject({
            phase: 'before-publication',
            publisher: 'workflow',
          });
          expect(input.validation).toMatchObject({ ok: true, rendered: false });
          return {
            assessments: [
              {
                criterion,
                evidence:
                  'The exact candidate body is ready; the workflow confirms publication afterwards.',
                problems: [],
              },
            ],
            problems: [],
          };
        }
        return undefined;
      },
    });
    expect(await f.boot()).toMatchObject({
      status: 'finished',
      outcome: 'completed',
    });
    expect(f.calls.filter((c) => c.name === 'deliverable-writer')).toHaveLength(
      1,
    );
    expect(f.trace.filter((t) => t === `comment:${body}`)).toHaveLength(1);
  });

  it('stops before drafting when the required validator is unavailable', async () => {
    const f = fixture({
      agent: (name) => (name === 'refiner' ? commentScope : undefined),
      exec: (command) =>
        command.includes('ROCKY_MERMAID_CHECK')
          ? { exitCode: 127, stdout: '', stderr: 'missing validator' }
          : undefined,
    });
    expect(await f.boot()).toMatchObject({
      status: 'failed',
      error: {
        message: expect.stringContaining(
          'Required Mermaid validator is unavailable',
        ),
      },
    });
    expect(f.calls.some((c) => c.name === 'deliverable-writer')).toBe(false);
  });
  it('repairs parser failures before review and never publishes an invalid diagram', async () => {
    let validations = 0;
    const f = fixture({
      exec: (command) => {
        if (!command.includes('ROCKY_MERMAID_CHECK')) return;
        const invalid = ++validations === 2;
        return {
          exitCode: invalid ? 1 : 0,
          stdout: JSON.stringify({
            ok: !invalid,
            rendered: false,
            diagrams: invalid
              ? [{ index: 1, valid: false, error: 'Parse error' }]
              : [],
          }),
          stderr: '',
        };
      },
      agent: (name, input, count) => {
        if (name === 'refiner') return commentScope;
        if (name === 'deliverable-writer') {
          if (count === 2)
            expect(input.previous).toMatchObject({
              problems: ['Mermaid diagram 1: Parse error'],
            });
          return { body: count === 1 ? 'Broken diagram' : 'Valid diagram' };
        }
        if (name === 'deliverable-reviewer')
          return {
            assessments: [
              {
                criterion: 'Explain the architecture.',
                evidence: 'Verified',
                problems: [],
              },
            ],
            problems: [],
          };
        return;
      },
    });
    expect(await f.boot()).toMatchObject({
      status: 'finished',
      outcome: 'completed',
    });
    expect(
      f.calls.filter((c) => c.name === 'deliverable-reviewer'),
    ).toHaveLength(2);
    expect(f.trace.filter((t) => t.startsWith('comment:'))).toEqual([
      'comment:Valid diagram',
    ]);
  });
});
