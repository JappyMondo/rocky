import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { EnvironmentVerification } from './environment-verification.js';
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('verifies saved configuration and exposes actionable blockers and attempted evidence', async () => {
  let job: unknown = null;
  const fetch = vi.fn(async (_url, options) => {
    if (options?.method === 'POST')
      job = {
        id: '1',
        status: 'blocked',
        startedAt: 'now',
        evidence: [{ label: 'browser probe', result: { status: 'blocked' } }],
        result: {
          status: 'blocked',
          blocker: {
            capability: 'browser',
            action: 'Configure the supported browser tool.',
          },
        },
      };
    return new Response(JSON.stringify(job));
  });
  vi.stubGlobal('fetch', fetch);
  render(
    <EnvironmentVerification
      profileId="test"
      disabled={false}
      mismatch={() => undefined}
    />,
  );
  await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  fireEvent.click(
    screen.getByRole('button', { name: 'Verify saved environment' }),
  );
  expect(await screen.findByText('Environment: blocked')).toBeTruthy();
  expect(
    screen.getByText('browser: Configure the supported browser tool.'),
  ).toBeTruthy();
  expect(screen.getByText('Verification and repair evidence')).toBeTruthy();
});
