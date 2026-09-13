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
it('shows a non-PR deliverable and supports keyboard navigation of code changes without interpreting HTML', async () => {
  const recap = {
    ...report,
    pr: undefined,
    deliverable: 'The requested investigation and recommendations.',
    keyChanges: [
      {
        title: 'Restrict access',
        summary: 'Only owners may update settings.',
        files: ['src/access.ts'],
        diff: '--- a/src/access.ts\n+++ b/src/access.ts\n@@ -1 +1 @@\n-allowAll()\n+requireOwner()\n+<script>alert(1)</script>',
        annotations: [
          {
            file: 'src/access.ts',
            line: 1,
            text: 'Ownership is checked before writes.',
          },
        ],
      },
      {
        title: 'Explain the outcome',
        summary: 'The comment documents the decision.',
        files: [],
        diff: '',
        annotations: [],
      },
    ],
    reviewFocus: [
      {
        category: 'permissions',
        title: 'Ownership boundary',
        summary: 'Review the owner check.',
        status: 'attention',
        evidence: ['Non-owner requests return 403.'],
      },
      {
        category: 'routes',
        title: 'No new routes',
        summary: 'The existing route is reused.',
        status: 'not-applicable',
        evidence: [],
      },
    ],
    files: [{ path: 'src/access.ts', status: 'modified' }],
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(recap))),
  );
  render(
    <ReviewReports
      detail={{ ...detail, reports: [{ ...report, pr: undefined }] }}
    />,
  );
  fireEvent.click(
    screen.getByRole('button', { name: /Clarify before implementation/ }),
  );
  await screen.findByRole('heading', { name: 'Delivered result' });
  expect(screen.queryByRole('link', { name: 'Open pull request' })).toBeNull();
  expect(screen.getByText(recap.deliverable)).toBeTruthy();
  expect(screen.getByText('Review the owner check.')).toBeTruthy();
  expect(screen.getByText('No new routes')).toBeTruthy();
  expect(screen.getByLabelText('Key code diff').textContent).toContain(
    '<script>alert(1)</script>',
  );
  expect(document.querySelector('script')).toBeNull();
  expect(screen.getByText('src/access.ts:1')).toBeTruthy();
  expect(screen.getByLabelText('Recap at a glance').textContent).toContain(
    '1/2',
  );
  const first = screen.getByRole('tab', { name: 'Restrict access' });
  const second = screen.getByRole('tab', { name: 'Explain the outcome' });
  expect(first.getAttribute('aria-selected')).toBe('true');
  fireEvent.keyDown(first, { key: 'ArrowRight' });
  expect(second.getAttribute('aria-selected')).toBe('true');
  expect(document.activeElement).toBe(second);
  expect(screen.getByRole('tabpanel').textContent).toContain(
    'No code diff for this change.',
  );
  fireEvent.keyDown(second, { key: 'Home' });
  expect(first.getAttribute('aria-selected')).toBe('true');
  fireEvent.keyDown(first, { key: 'End' });
  expect(second.getAttribute('aria-selected')).toBe('true');
  fireEvent.keyDown(second, { key: 'ArrowLeft' });
  expect(first.getAttribute('aria-selected')).toBe('true');
  fireEvent.keyDown(first, { key: 'ArrowLeft' });
  expect(second.getAttribute('aria-selected')).toBe('true');
  fireEvent.click(first);
  expect(first.getAttribute('aria-selected')).toBe('true');
});
