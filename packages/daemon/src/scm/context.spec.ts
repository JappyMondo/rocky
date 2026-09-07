import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { ApprovedCheckpoint } from '@rocky/sdk';
import { runBoot } from '../run/replay.js';
import { openJournal } from '../run/journal.js';
import { createGitHubScm, createScm } from './index.js';
import { githubOptions } from './scm.fixtures.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

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
