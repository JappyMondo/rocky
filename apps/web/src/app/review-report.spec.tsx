import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ReviewReport, RunDetail } from '@rocky/local-contracts';
import { ReviewReports } from './review-report.js';
vi.mock('./workflow-diagram.js', () => ({
  Chart: ({ source }: { source: string }) => (
    <pre aria-label="Processing diagram">{source}</pre>
  ),
}));
const report: ReviewReport = {
  id: `r_${'a'.repeat(32)}`,
  runId: 'NG-700-1',
  createdAt: '2026-09-10T10:00:00Z',
  title: 'Clarify before implementation',
  summary: 'Questions resolve missing requirements.',
  pr: {
    repo: 'app',
    number: 42,
    url: 'https://github.com/example/app/pull/42',
    headSha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
  },
  problems: [
    { problem: 'Ambiguous scope', solution: 'Ask for the missing decision.' },
  ],
  diagrams: [
    {
      title: 'Processing flow',
      description: 'The loop comes first.',
      mermaid: 'flowchart LR\n Ticket --> Question --> Work',
    },
  ],
  verification: ['Question loop passes.'],
  limitations: ['Dark theme requires a preview account.'],
  visuallyReviewable: true,
  visuals: [
    {
      group: 'Run view',
      variant: 'Desktop light',
      description: 'Expanded questions.',
      status: 'captured',
      reason: '',
      screenshots: [
        { id: `s_${'b'.repeat(32)}`, caption: 'The question panel' },
      ],
    },
    {
      group: 'Run view',
      variant: 'Desktop dark',
      description: 'Authenticated theme.',
      status: 'unavailable',
      reason: 'Missing preview account.',
      screenshots: [],
    },
  ],
};
const detail: RunDetail = {
  run: {
    runId: report.runId,
    repo: 'app',
    branch: 'ng-700',
    issue: {
      identifier: 'NG-700',
      title: 'Clarify',
      url: 'https://linear.app/issue/NG-700',
    },
    status: 'parked',
    createdAt: report.createdAt,
    boots: 1,
  },
  steps: [],
  diffs: [],
  steers: [],
  reports: [report],
  revision: 'one',
  controls: { answer: false, steer: false },
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
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});
it('opens a revision with diagrams, grouped screenshots, unavailable variants and a shareable URL', async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify(report)));
  vi.stubGlobal('fetch', fetch);
  render(<ReviewReports detail={detail} />);
  fireEvent.click(
    screen.getByRole('button', { name: /Clarify before implementation/ }),
  );
  await screen.findByRole('dialog');
  await screen.findByRole('heading', { name: report.title });
  expect(fetch).toHaveBeenCalledWith(
    `/api/runs/${report.runId}/reports/${report.id}`,
    expect.any(Object),
  );
  expect(screen.getAllByRole('heading', { name: 'Run view' })).toHaveLength(1);
  expect(
    screen.getByRole('img', { name: 'The question panel' }).getAttribute('src'),
  ).toBe(`/api/screenshots/${report.visuals[0].screenshots[0].id}`);
  expect(
    screen.getByText('Not captured: Missing preview account.'),
  ).toBeTruthy();
  expect(screen.getByLabelText('Processing diagram').textContent).toContain(
    'Ticket --> Question',
  );
  expect(screen.getByText(report.limitations[0])).toBeTruthy();
  expect(window.location.search).toBe(`?report=${report.id}`);
  fireEvent.click(
    screen.getByRole('button', { name: 'Close visual review report' }),
  );
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(window.location.search).toBe('');
});
it('loads a directly linked report even when the summaries are absent', async () => {
  window.history.replaceState({}, '', `/?report=${report.id}`);
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({ ...report, visuals: [], limitations: [] }),
        ),
    ),
  );
  render(<ReviewReports detail={{ ...detail, reports: [] }} />);
  await screen.findByRole('heading', { name: report.title });
  expect(screen.queryByRole('heading', { name: 'Visual evidence' })).toBeNull();
  expect(
    screen.queryByRole('heading', { name: 'Review limitations' }),
  ).toBeNull();
});
it('shows failed report requests and aborts an in-flight request on close', async () => {
  window.history.replaceState({}, '', `/?report=${report.id}`);
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'Report was pruned.' }), {
          status: 410,
        }),
    ),
  );
  const view = render(<ReviewReports detail={detail} />);
  expect((await screen.findByRole('alert')).textContent).toContain(
    'Report was pruned.',
  );
  view.unmount();
  let signal: AbortSignal | null | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn((_url, init: RequestInit) => {
      signal = init.signal;
      return new Promise<Response>(() => undefined);
    }),
  );
  render(<ReviewReports detail={detail} />);
  expect(screen.getByRole('status').textContent).toContain('Loading report');
  fireEvent.click(
    screen.getByRole('button', { name: 'Close visual review report' }),
  );
  await waitFor(() => expect(signal?.aborted).toBe(true));
});
