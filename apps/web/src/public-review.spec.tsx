import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PublicReview } from './public-review.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('opens directly in the read-only wizard and loads only its scoped report', async () => {
  const path = `/reviews/${'a'.repeat(64)}`;
  window.history.replaceState({}, '', path);
  const fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      id: 'r_test',
      runId: 'TEST-1',
      title: '28 days of history',
      goal: 'Keep four weeks of measurements.',
      summary: 'The retention default is 28 days.',
      createdAt: '2026-09-15T10:00:00Z',
      visuals: [],
      diagrams: [],
      problems: [],
      verification: [],
      limitations: [],
      behavior: [
        {
          title: 'Default retention',
          before: 'One day',
          after: '28 days',
          evidence: [],
        },
      ],
    }),
  });
  vi.stubGlobal('fetch', fetch);
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
  render(<PublicReview />);
  await screen.findByRole('heading', { name: '28 days of history' });
  expect(screen.getByText('Keep four weeks of measurements.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /^Changes$/ }));
  expect(
    screen.getByRole('heading', { name: 'What changes in practice' }),
  ).toBeTruthy();
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(
    screen.queryByRole('navigation', { name: 'Main navigation' }),
  ).toBeNull();
  expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][0]).toBe(`${path}/report.json`);
  expect(fetch.mock.calls[0][1].credentials).toBe('same-origin');
});
it('explains an expired or unknown share without requesting the private app', async () => {
  window.history.replaceState({}, '', `/reviews/${'b'.repeat(64)}`);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
  render(<PublicReview />);
  await waitFor(() =>
    expect(screen.getByRole('alert').textContent).toContain(
      'no longer available',
    ),
  );
});
