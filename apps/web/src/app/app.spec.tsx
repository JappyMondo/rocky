import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from './app.js';

afterEach(() => {
  // Explicit, because auto-cleanup only runs when the globals are installed —
  // without it every render stacks up in one document and the second test
  // asserting the same text finds both.
  cleanup();
  vi.unstubAllGlobals();
});

/**
 * jsdom ships no `fetch`, and so no `Response` to construct — a plain object
 * with the one method the shell calls is both enough and honest.
 */
function daemonAnswering(health: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => health })),
  );
}

describe('the web shell', () => {
  it('reports the daemon it reached on the same origin', async () => {
    daemonAnswering({ status: 'ok', version: '1.2.3', web: true });

    render(<App />);

    expect(await screen.findByText('Daemon v1.2.3 is ok.')).toBeTruthy();
    expect(fetch).toHaveBeenCalledWith('/api/health');
  });

  it('banners a dead endpoint, with the reason and no offer to fix it', async () => {
    daemonAnswering({
      status: 'ok',
      version: '1.2.3',
      web: true,
      endpoint: {
        configured: true,
        ok: false,
        checkedAt: '2026-09-02T10:00:00.000Z',
        detail: 'could not be reached — ECONNREFUSED',
      },
    });

    render(<App />);

    const banner = await screen.findByRole('status');
    expect(banner.textContent).toContain('Linear cannot reach Rocky');
    expect(banner.textContent).toContain('ECONNREFUSED');
    // A dead endpoint costs latency, not correctness — the banner says so
    // rather than implying the machine has stopped working.
    expect(banner.textContent).toMatch(/Runs still progress/);
  });

  it('shows no banner while the endpoint is healthy', async () => {
    daemonAnswering({
      status: 'ok',
      version: '1.2.3',
      web: true,
      endpoint: { configured: true, ok: true },
    });

    render(<App />);

    await screen.findByText('Daemon v1.2.3 is ok.');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows no banner on a machine that has not been set up yet', async () => {
    daemonAnswering({
      status: 'ok',
      version: '1.2.3',
      web: true,
      endpoint: { configured: false, ok: false },
    });

    render(<App />);

    await screen.findByText('Daemon v1.2.3 is ok.');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('points at `rocky start` when nothing answers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );

    render(<App />);

    expect(await screen.findByText(/No daemon answering/)).toBeTruthy();
  });
});
