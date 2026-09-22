import { expect, it } from 'vitest';
import type { RunSummary } from '@rocky/local-contracts';
import { runState } from './run-presentation.js';

const run: RunSummary = {
  runId: 'r1',
  issue: { identifier: 'NG-1', title: 'Work', url: '' },
  repo: 'repo',
  branch: 'work',
  status: 'parked',
  boots: 1,
  createdAt: '2026-09-22',
};

it.each([
  ['scm.waitForCi:repo:hash', 'waiting', 'Waiting for CI'],
  ['scm:waitForCi', 'waiting', 'Waiting for CI'],
  ['question', 'parked', 'Needs your input'],
  ['checkpoint', 'parked', 'Needs your input'],
  ['external-service', 'waiting', 'Waiting'],
  [undefined, 'waiting', 'Waiting'],
])(
  'describes parked reason %s without assuming human review',
  (reason, value, label) => {
    expect(runState({ ...run, reason })).toEqual({ value, label });
  },
);

it('does not let stale parking reasons override a terminal state or hide unresolved work', () => {
  expect(
    runState({ ...run, status: 'finished', reason: 'question' }).value,
  ).toBe('finished');
  expect(
    runState({ ...run, status: 'finished', outcome: 'exhausted' }),
  ).toEqual({ value: 'failed', label: 'Needs attention' });
  expect(
    runState({ ...run, status: 'cancelled', reason: 'scm:waitForCi' }).value,
  ).toBe('cancelled');
});
