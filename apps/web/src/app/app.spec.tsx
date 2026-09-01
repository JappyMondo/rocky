import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from './app.js';

afterEach(() => {
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
