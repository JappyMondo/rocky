import { expect, it } from 'vitest';
import type { ReviewThread } from '@rocky/sdk';
import { coalesceReply, replyIntent, replyScope } from './reply.js';

const thread = {
  pr: {
    repo: 'lead',
    id: 'PR_one',
    number: 7,
    url: 'https://github.test/team/repo/pull/7',
    sourceBranch: 'ng-524',
    baseBranch: 'main',
    headSha: 'abc',
    state: 'open',
    draft: false,
  },
  id: 'thread-one',
  body: 'Please fix this',
  resolved: false,
} satisfies ReviewThread;

it('makes authenticated reply intent idempotent and rejects a changed manual intent', async () => {
  const initial = replyIntent(thread, 'Fixed', 'NG-524-1', [], 'author-secret');
  expect(initial).toMatchObject({
    exists: false,
    body: expect.stringContaining('Fixed'),
  });
  expect(
    replyIntent(thread, 'Fixed', 'NG-524-1', [initial.body], 'author-secret'),
  ).toMatchObject({ exists: true, body: initial.body });
  await expect(
    Promise.resolve().then(() =>
      replyIntent(
        thread,
        'Different fix',
        'NG-524-1',
        [initial.body],
        'author-secret',
      ),
    ),
  ).rejects.toMatchObject({ refusal: { reason: 'blocked_status' } });
});

it('coalesces only live duplicate effects and releases a failed attempt for retry', async () => {
  const scope = replyScope(
    'https://github.test',
    'team/repo',
    thread.id,
    'author-secret',
  );
  let attempts = 0;
  const failed = () => {
    attempts++;
    return Promise.reject(new Error('temporary failure'));
  };
  await expect(
    Promise.all([
      coalesceReply(scope, 'Fixed', failed),
      coalesceReply(scope, 'Fixed', failed),
    ]),
  ).rejects.toThrow('temporary failure');
  expect(attempts).toBe(1);

  await coalesceReply(scope, 'Fixed', async () => {
    attempts++;
  });
  expect(attempts).toBe(2);
  expect(
    replyScope('https://github.test', 'team/repo', thread.id, 'other-secret'),
  ).not.toBe(scope);
});
