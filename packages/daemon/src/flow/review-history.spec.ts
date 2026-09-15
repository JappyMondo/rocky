import { expect, it } from 'vitest';
import { ReviewHistory } from './review-history.js';
import { ReviewFor } from './schemas.js';

it('keeps all findings and fixes, drops nit picks, and requires independent verification', () => {
  const history = new ReviewHistory();
  const result = ReviewFor('review/1').parse({
    complaints: [
      {
        id: 'review/1/a',
        file: 'a.ts',
        text: 'Data is lost.',
        severity: 'must-fix',
      },
      {
        id: 'review/1/b',
        file: 'b.ts',
        text: 'Unnecessary retry.',
        severity: 'should-fix',
      },
      {
        id: 'review/1/c',
        file: 'c.ts',
        text: 'Prefer a different name.',
        severity: 'nit-pick',
      },
    ],
  });
  const active = history.review(result, 'reviewer', 'head-1');
  expect(active.map((item) => item.id)).toEqual(['review/1/a', 'review/1/b']);
  history.resolved(
    active.map((item) => ({
      id: item.id,
      status: 'fixed',
      note: 'Patched in commit 2.',
    })),
  );
  expect(history.snapshot().map((item) => item.status)).toEqual([
    'fix-reported',
    'fix-reported',
    'ignored',
  ]);
  const prior = history.snapshot().filter((item) => item.status !== 'ignored');
  const schema = ReviewFor('review/2', undefined, prior);
  expect(schema.safeParse({ complaints: [] }).success).toBe(false);
  const verified = schema.parse({
    complaints: [],
    previousIssues: [
      { id: prior[0].id, status: 'fixed', note: 'The data-loss test passes.' },
      {
        id: prior[1].id,
        status: 'open',
        note: 'Retry still loops on empty input.',
      },
    ],
  });
  expect(history.review(verified, 'compliance-reviewer', 'head-2')).toEqual([
    expect.objectContaining({
      id: prior[1].id,
      text: 'Unnecessary retry.',
      severity: 'should-fix',
    }),
  ]);
  expect(history.snapshot()).toHaveLength(3);
  expect(history.snapshot()[0]).toMatchObject({
    status: 'fixed',
    resolutions: [expect.objectContaining({ note: 'Patched in commit 2.' })],
  });
  expect(
    schema.safeParse({
      complaints: [],
      previousIssues: [verified.previousIssues[0], verified.previousIssues[0]],
    }).success,
  ).toBe(false);
});

it('reconstructs legacy issue IDs reused across continuation batches without losing history', () => {
  const history = new ReviewHistory();
  for (const text of ['first issue', 'second issue']) {
    history.review(
      { complaints: [{ id: 'review/1/a', file: 'a.ts', text }] },
      'reviewer',
      'head',
    );
    history.resolved([{ id: 'review/1/a', status: 'fixed', note: text }]);
  }
  expect(
    history.snapshot().map((item) => [item.id, item.resolutions[0].note]),
  ).toEqual([
    ['issue-1', 'first issue'],
    ['issue-2', 'second issue'],
  ]);
});
