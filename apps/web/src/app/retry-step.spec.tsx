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
  fireEvent.click(screen.getByRole('button', { name: 'Retry failed step' }));
  expect(submit).not.toHaveBeenCalled();
  view.rerender(<RetryStep disabled={false} submit={submit} />);
  fireEvent.click(screen.getByRole('button', { name: 'Retry failed step' }));
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

it('preserves recovery instructions and request identity after failure, and uses a new identity after editing', async () => {
  const submit = vi.fn(async (_requestId: string, _instructions?: string) => {
    throw new Error('offline');
  });
  render(<RetryStep disabled={false} submit={submit} />);
  fireEvent.click(screen.getByRole('button', { name: 'Solve with agent' }));
  const start = screen.getByRole('button', {
    name: 'Start agent and retry',
  }) as HTMLButtonElement;
  expect(start.disabled).toBe(true);
  const input = screen.getByLabelText(
    'Instructions for the error handling agent',
  );
  fireEvent.change(input, { target: { value: 'Use my updated Git identity' } });
  fireEvent.click(start);
  await screen.findByRole('alert');
  expect((input as HTMLTextAreaElement).value).toBe(
    'Use my updated Git identity',
  );
  fireEvent.click(start);
  await act(async () => undefined);
  expect(submit.mock.calls[0]).toEqual(submit.mock.calls[1]);
  expect(submit).toHaveBeenCalledWith(
    expect.any(String),
    'Use my updated Git identity',
  );
  fireEvent.change(input, {
    target: { value: 'Inspect the unpublished commit' },
  });
  fireEvent.click(start);
  await act(async () => undefined);
  expect(submit.mock.calls[2][0]).not.toBe(submit.mock.calls[0][0]);
});

it('offers a fresh review allowance and preserves the grant identity after a lost response', async () => {
  const submit = vi.fn(async () => {
    throw new Error('offline');
  });
  render(<RetryStep disabled={false} continueRounds={5} submit={submit} />);
  expect(screen.queryByRole('button', { name: 'Solve with agent' })).toBeNull();
  fireEvent.click(
    screen.getByRole('button', { name: 'Continue for another 5 rounds' }),
  );
  await screen.findByRole('alert');
  fireEvent.click(
    screen.getByRole('button', { name: 'Continue for another 5 rounds' }),
  );
  await act(async () => undefined);
  expect(submit).toHaveBeenCalledTimes(2);
  expect(submit.mock.calls[0]).toEqual(submit.mock.calls[1]);
});
