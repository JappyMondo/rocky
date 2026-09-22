import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { RunDetail, RunSummary } from '@rocky/local-contracts';
import { RunActivitySummary } from './run-activity-summary.js';

const run: RunSummary = {
  runId: 'r1',
  issue: { identifier: 'NG-1', title: 'Work', url: '' },
  repo: 'repo',
  branch: 'work',
  status: 'queued',
  boots: 1,
  createdAt: '2026-09-22T10:00:00Z',
};
const detail = (changes: Partial<RunSummary>): RunDetail => ({
  run: { ...run, ...changes },
  revision: 'r1',
  steps: [],
  steers: [],
  diffs: [],
  usage: {
    reported: {},
    missing: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      usd: 0,
    },
  },
  controls: { answer: false, steer: false },
});
afterEach(cleanup);

it.each([
  ['queued', undefined, 'Waiting to start'],
  ['running', undefined, 'Starting workflow'],
  ['finished', 'exhausted', 'Workflow stopped with unresolved work'],
  ['finished', 'rejected', 'Review rejected'],
  ['finished', 'merged', 'Changes merged'],
  ['finished', 'completed', 'Run completed'],
  ['cancelled', undefined, 'Run cancelled'],
] satisfies Array<[RunSummary['status'], RunSummary['outcome'], string]>)(
  'explains %s / %s without inventing progress',
  (status, outcome, title) => {
    render(
      <RunActivitySummary
        detail={detail({ status, outcome })}
        reveal={vi.fn()}
      />,
    );
    expect(screen.getByText(title)).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  },
);

it('uses the recorded end time for terminal elapsed time and foregrounds active recovery', () => {
  const d = detail({ status: 'failed', endedAt: '2026-09-22T10:25:00Z' });
  d.recovery = {
    requestId: 'repair',
    instructions: 'Repair',
    status: 'running',
    summary: 'Working',
  };
  render(<RunActivitySummary detail={d} reveal={vi.fn()} />);
  expect(screen.getByText('Recovering')).toBeTruthy();
  expect(screen.getByText('Recovery agent is working')).toBeTruthy();
  expect(screen.getByText('25m elapsed · 0 steps completed')).toBeTruthy();
});
