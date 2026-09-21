import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ConfigurationRepair } from './configuration-repair.js';

afterEach(cleanup);

it('keeps repair contents and request identity after failure, but changes identity after edits', async () => {
  const submit = vi.fn(async () => {
    throw new Error('offline');
  });
  render(<ConfigurationRepair disabled={false} submit={submit} />);
  fireEvent.click(
    screen.getByRole('button', { name: 'Repair configuration and resume' }),
  );
  fireEvent.change(
    screen.getByLabelText('UI start command (from the lead repository)'),
    { target: { value: 'npm run dev' } },
  );
  fireEvent.change(screen.getByLabelText('UI URL (Rocky assigns the port)'), {
    target: { value: 'http://127.0.0.1/' },
  });
  const start = screen.getByRole('button', {
    name: 'Apply and resume this Run',
  });
  fireEvent.click(start);
  await screen.findByRole('alert');
  expect(submit).toHaveBeenCalledWith(expect.any(String), {
    ui: { start: 'npm run dev', url: 'http://127.0.0.1/' },
  });
  fireEvent.click(start);
  await act(async () => undefined);
  expect(submit.mock.calls[0]).toEqual(submit.mock.calls[1]);
  fireEvent.change(
    screen.getByLabelText('Replacement install command (optional)'),
    { target: { value: 'npm ci' } },
  );
  fireEvent.click(start);
  await act(async () => undefined);
  expect(submit.mock.calls[2]).not.toEqual(submit.mock.calls[0]);
  expect(submit).toHaveBeenLastCalledWith(expect.any(String), {
    ui: { start: 'npm run dev', url: 'http://127.0.0.1/' },
    commands: { install: 'npm ci' },
  });
});
