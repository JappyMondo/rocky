import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { RetryStep } from './retry-step.js';
afterEach(cleanup);
it('disables retries during a request and for incompatible clients', async () => {
  let resolve: () => void = () => undefined;
  const submit = vi.fn(
    () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
  );
  const view = render(<RetryStep disabled submit={submit} />);
  fireEvent.click(screen.getByRole('button'));
  expect(submit).not.toHaveBeenCalled();
  view.rerender(<RetryStep disabled={false} submit={submit} />);
  fireEvent.click(screen.getByRole('button'));
  expect(
    (
      screen.getByRole('button', {
        name: 'Queuing retry…',
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  await act(async () => resolve());
  expect(
    (
      screen.getByRole('button', {
        name: 'Retry failed step',
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
});
