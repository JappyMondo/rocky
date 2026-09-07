import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
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
  const fetcher: typeof fetch = async () => {
    reads++;
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
          { decision: 'approve' },
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
  expect(reads).toBe(3);
  expect((await openJournal(journalPath)).latest(0)?.status).toBe('done');
});
