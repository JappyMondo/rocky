import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { ApprovedCheckpoint } from '@rocky/sdk';
import { runBoot } from '../run/replay.js';
import { openJournal } from '../run/journal.js';
import { createGitHubScm, createScm, type ScmAdapter } from './index.js';
import { githubOptions } from './scm.fixtures.js';
import { refuse } from './http.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

function stubAdapter(signal: AbortSignal, id = 'lead'): ScmAdapter {
  const pr = {
    repo: id,
    id: 'PR_one',
    number: 7,
    url: 'https://github.test/pull/7',
    sourceBranch: 'ng-524',
    baseBranch: 'main',
    headSha: 'abc',
    state: 'open' as const,
    draft: false,
  };
  return {
    repo: { id, project: `team/${id}`, baseBranch: 'main' },
    signal,
    openPr: async () => pr,
    markDraft: async () => pr,
    waitForCi: async () => ({
      status: 'done',
      result: { status: 'passed', headSha: pr.headSha, failedJobs: [] },
    }),
    retryFailedJobs: async () => undefined,
    updateBranch: async () => ({
      status: 'done',
      result: { status: 'clean', pr },
    }),
    armAutoMerge: async () => ({
      status: 'done',
      result: { status: 'merged', pr },
    }),
    reviewThreads: async () => [],
    replyToThread: async () => undefined,
  };
}

it('parks a permission-refused arm with an idempotent named blocker and settles only when a human merges', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rocky-scm-'));
  dirs.push(dir);
  const journalPath = join(dir, 'journal.jsonl');
  let merged = false;
  let reads = 0;
  const notices = new Map<string, unknown>();
  const signal = new AbortController().signal;
  const fetcher: typeof fetch = async (url) => {
    reads++;
    if (new URL(String(url)).pathname.endsWith('/pulls/7'))
      return Response.json({
        node_id: 'PR_one',
        number: 7,
        html_url: 'https://github.test/pull/7',
        head: {
          ref: 'ng-524',
          sha: 'abc',
          repo: { full_name: 'team/repo' },
        },
        base: { ref: 'main', repo: { full_name: 'team/repo' } },
        state: merged ? 'closed' : 'open',
        merged_at: merged ? 'now' : null,
        draft: false,
      });
    return Response.json({
      data: {
        node: {
          id: 'PR_one',
          headRefOid: 'abc',
          state: merged ? 'MERGED' : 'OPEN',
          isDraft: false,
          mergeStateStatus: 'CLEAN',
          reviewDecision: null,
          isMergeQueueEnabled: false,
          isInMergeQueue: false,
          autoMergeRequest: null,
          repository: {
            autoMergeAllowed: false,
            squashMergeAllowed: true,
            mergeCommitAllowed: false,
            rebaseMergeAllowed: false,
          },
        },
      },
    });
  };
  const boot = (poll = false) =>
    runBoot({
      journalPath,
      poll,
      signal,
      workflow: async (steps) => {
        const scm = createScm(steps, {
          runId: 'NG-524-1',
          lead: 'lead',
          signal,
          approvals: () => true,
          members: [
            createGitHubScm({ ...githubOptions, signal, fetch: fetcher }),
          ],
          onRefusal: async (notice) => {
            notices.set(notice.key, notice.refusal);
          },
        });
        const result = await scm.armAutoMerge(
          {
            repo: 'lead',
            id: 'PR_one',
            number: 7,
            url: 'https://github.test/pull/7',
            sourceBranch: 'ng-524',
            baseBranch: 'main',
            headSha: 'abc',
            state: 'open',
            draft: false,
          },
          { decision: 'approve' } as unknown as ApprovedCheckpoint,
        );
        expect(result).toMatchObject({ status: 'merged' });
        return 'merged';
      },
    });
  expect(await boot()).toMatchObject({ status: 'parked' });
  expect(await boot(true)).toMatchObject({ status: 'parked' });
  expect(notices.size).toBe(1);
  expect([...notices.values()][0]).toMatchObject({
    repo: 'lead',
    reason: 'unsupported',
    fix: expect.stringContaining('merge manually'),
  });
  merged = true;
  expect(await boot(true)).toMatchObject({ status: 'ready' });
  expect(await boot()).toMatchObject({ status: 'finished', outcome: 'merged' });
  // Each guarded GraphQL arm has one REST identity re-read.
  expect(reads).toBe(6);
  expect((await openJournal(journalPath)).latest(0)?.status).toBe('done');
});

it('settles forged checkpoint capabilities as not_approved without replaying a valid arm', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rocky-scm-approval-'));
  dirs.push(dir);
  const signal = new AbortController().signal;
  const pr = {
    repo: 'lead',
    id: 'PR_one',
    number: 7,
    url: 'https://github.test/pull/7',
    sourceBranch: 'ng-524',
    baseBranch: 'main',
    headSha: 'abc',
    state: 'open' as const,
    draft: false,
  };
  const approved = { decision: 'approve' } as ApprovedCheckpoint;
  let arms = 0;
  let notices = 0;
  const adapter = {
    repo: { id: 'lead', project: 'team/repo', baseBranch: 'main' },
    signal,
    armAutoMerge: async () => {
      arms++;
      return {
        status: 'done' as const,
        result: { status: 'merged' as const, pr },
      };
    },
  };
  const result = await runBoot({
    journalPath: join(dir, 'journal.jsonl'),
    signal,
    workflow: async (steps) => {
      const scm = createScm(steps, {
        runId: 'NG-524-approval',
        lead: 'lead',
        signal,
        approvals: (approval) => approval === approved,
        members: [adapter as never],
        onRefusal: async () => {
          notices++;
        },
      });
      expect(await scm.armAutoMerge(pr, approved)).toMatchObject({
        status: 'merged',
      });
      expect(
        await scm.armAutoMerge(pr, {
          decision: 'approve',
        } as unknown as ApprovedCheckpoint),
      ).toMatchObject({ refused: true, reason: 'not_approved' });
      return 'merged';
    },
  });
  expect(result).toMatchObject({ status: 'finished' });
  expect(arms).toBe(1);
  expect(notices).toBe(0);
});

it('journals every SCM operation through its selected Run member', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rocky-scm-operations-'));
  dirs.push(dir);
  const signal = new AbortController().signal;
  const pr = {
    repo: 'lead',
    id: 'PR_one',
    number: 7,
    url: 'https://github.test/pull/7',
    sourceBranch: 'ng-524',
    baseBranch: 'main',
    headSha: 'abc',
    state: 'open' as const,
    draft: false,
  };
  const thread = {
    pr,
    id: 'thread',
    body: 'Please fix this',
    resolved: false,
  };
  const calls: string[] = [];
  const adapter: ScmAdapter = {
    repo: { id: 'lead', project: 'team/repo', baseBranch: 'main' },
    signal,
    async openPr() {
      calls.push('openPr');
      return pr;
    },
    async markDraft() {
      calls.push('markDraft');
      return pr;
    },
    async waitForCi() {
      calls.push('waitForCi');
      return {
        status: 'done',
        result: { status: 'passed', headSha: pr.headSha, failedJobs: [] },
      };
    },
    async retryFailedJobs() {
      calls.push('retryFailedJobs');
    },
    async updateBranch() {
      calls.push('updateBranch');
      return { status: 'done', result: { status: 'clean', pr } };
    },
    async armAutoMerge() {
      calls.push('armAutoMerge');
      return { status: 'done', result: { status: 'merged', pr } };
    },
    async reviewThreads() {
      calls.push('reviewThreads');
      return [thread];
    },
    async replyToThread(_thread, _body, runId) {
      calls.push(`replyToThread:${runId}`);
    },
  };
  const approved = { decision: 'approve' } as ApprovedCheckpoint;

  const result = await runBoot({
    journalPath: join(dir, 'journal.jsonl'),
    signal,
    workflow: async (steps) => {
      const scm = createScm(steps, {
        runId: 'NG-524-operations',
        lead: 'lead',
        members: [adapter],
        signal,
        approvals: (approval) => approval === approved,
        onRefusal: async () => undefined,
      });
      expect(
        await scm.openPr({ repo: 'lead', title: 'Change', body: 'Plan' }),
      ).toEqual(pr);
      expect(await scm.markDraft(pr, false, { body: 'Ready' })).toEqual(pr);
      expect(await scm.waitForCi(pr, { logTailLines: 200 })).toEqual({
        status: 'passed',
        headSha: 'abc',
        failedJobs: [],
      });
      await scm.retryFailedJobs(pr);
      expect(await scm.updateBranch(pr)).toEqual({ status: 'clean', pr });
      expect(await scm.armAutoMerge(pr, approved)).toEqual({
        status: 'merged',
        pr,
      });
      expect(await scm.reviewThreads(pr)).toEqual([thread]);
      await scm.replyToThread(thread, 'Fixed');
      return 'merged';
    },
  });

  expect(result).toMatchObject({ status: 'finished' });
  expect(calls).toEqual([
    'openPr',
    'markDraft',
    'waitForCi',
    'retryFailedJobs',
    'updateBranch',
    'armAutoMerge',
    'reviewThreads',
    'replyToThread:NG-524-operations',
  ]);
});

it.each([
  [
    'duplicate Run members',
    (signal: AbortSignal) => [stubAdapter(signal), stubAdapter(signal)],
  ],
  [
    'an adapter bound to another Boot',
    (_signal: AbortSignal) => [stubAdapter(new AbortController().signal)],
  ],
] as const)('rejects %s before any SCM operation', async (_name, members) => {
  const dir = await mkdtemp(join(tmpdir(), 'rocky-scm-members-'));
  dirs.push(dir);
  const signal = new AbortController().signal;
  const result = await runBoot({
    journalPath: join(dir, 'journal.jsonl'),
    signal,
    workflow: async (steps) => {
      createScm(steps, {
        runId: 'NG-524-members',
        lead: 'lead',
        signal,
        members: members(signal),
        approvals: () => false,
        onRefusal: async () => undefined,
      });
      return 'merged';
    },
  });

  expect(result).toMatchObject({
    status: 'failed',
    error: { message: expect.stringContaining('SCM') },
  });
});

it('refuses unknown frozen members and parks a rate-limited SCM Step', async () => {
  const unknownDir = await mkdtemp(join(tmpdir(), 'rocky-scm-unknown-'));
  const rateDir = await mkdtemp(join(tmpdir(), 'rocky-scm-rate-'));
  dirs.push(unknownDir, rateDir);
  const signal = new AbortController().signal;
  const unknown = await runBoot({
    journalPath: join(unknownDir, 'journal.jsonl'),
    signal,
    workflow: async (steps) => {
      const scm = createScm(steps, {
        runId: 'NG-524-unknown',
        lead: 'lead',
        signal,
        members: [stubAdapter(signal)],
        approvals: () => false,
        onRefusal: async () => undefined,
      });
      await scm.openPr({ repo: 'missing', title: 'Change', body: 'Plan' });
      return 'merged';
    },
  });
  expect(unknown).toMatchObject({
    status: 'failed',
    error: {
      message: expect.stringContaining('Unknown SCM Run member missing'),
    },
  });

  let attempts = 0;
  const rateLimited = {
    ...stubAdapter(signal),
    openPr: async () => {
      attempts++;
      throw refuse(
        'lead',
        'rate_limited',
        'Platform quota exhausted.',
        'Keep the Step Parked.',
      );
    },
  };
  const rate = await runBoot({
    journalPath: join(rateDir, 'journal.jsonl'),
    signal,
    workflow: async (steps) => {
      const scm = createScm(steps, {
        runId: 'NG-524-rate',
        lead: 'lead',
        signal,
        members: [rateLimited],
        approvals: () => false,
        onRefusal: async () => undefined,
      });
      await scm.openPr({ title: 'Change', body: 'Plan' });
      return 'merged';
    },
  });
  expect(rate).toMatchObject({ status: 'parked' });
  expect(attempts).toBe(1);
});

it('generates a journaled report before a ready flip and does not regenerate on replay', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rocky-ready-report-'));
  dirs.push(dir);
  const signal = new AbortController().signal;
  const adapter = stubAdapter(signal);
  let reports = 0;
  let ready = 0;
  adapter.markDraft = async (pr) => {
    ready++;
    return { ...pr, draft: false };
  };
  const boot = () =>
    runBoot({
      journalPath: join(dir, 'journal.jsonl'),
      workflow: async (steps) => {
        const scm = createScm(steps, {
          runId: 'TEST-1-1',
          lead: 'lead',
          members: [adapter],
          signal,
          approvals: () => false,
          onRefusal: async () => undefined,
          onReady: async () => {
            await steps.step('report', {}, async () => {
              expect(ready).toBe(0);
              reports++;
              return { status: 'done', result: null };
            });
          },
        });
        const pr = await adapter.openPr({ title: 'Test', body: 'Test' });
        await scm.markDraft(pr, false);
        return 'completed';
      },
    });
  expect(await boot()).toMatchObject({ status: 'finished' });
  expect(await boot()).toMatchObject({ status: 'finished' });
  expect(reports).toBe(1);
  expect(ready).toBe(1);
});
