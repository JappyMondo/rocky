import { useState } from 'react';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { RunSummary } from '@rocky/local-contracts';
import { RunsOverview, type RunsViewState } from './runs-overview.js';
import { groupRuns } from './run-groups.js';
afterEach(cleanup);
const base: RunSummary = {
  runId: 'TASK-1-1',
  issue: {
    identifier: 'TASK-1',
    title: 'Build widget',
    url: 'https://example.test/task/1',
  },
  repo: 'project',
  branch: 'widget',
  status: 'failed',
  boots: 1,
  createdAt: '2026-09-25T10:00:00Z',
};
const latest: RunSummary = {
  ...base,
  runId: 'TASK-1-2',
  status: 'running',
  createdAt: '2026-09-25T11:00:00Z',
};
it('groups by ticket identity and orders attempts independently of input order', () => {
  const groups = groupRuns([
    base,
    latest,
    {
      ...base,
      runId: 'OTHER-1',
      issue: { ...base.issue, url: 'https://another.test/task/1' },
    },
  ]);
  expect(groups).toHaveLength(2);
  expect(groups[0].attempts.map((run) => run.runId)).toEqual([
    latest.runId,
    base.runId,
  ]);
});
it('settles and restores an earlier attempt while keeping latest work visible; reports save errors', async () => {
  const save = vi.fn().mockResolvedValue(undefined);
  function Fixture() {
    const [runs, setRuns] = useState([base, latest]);
    const [view, setView] = useState<RunsViewState>({
      filter: 'Unsettled',
      query: '',
      page: 0,
    });
    return (
      <RunsOverview
        runs={runs}
        loading={false}
        disabled={false}
        start={vi.fn()}
        openRun={vi.fn()}
        repository=""
        onRepository={vi.fn()}
        view={view}
        setView={setView}
        settle={async (id, settled) => {
          await save();
          setRuns((runs) =>
            runs.map((run) =>
              run.runId === id
                ? {
                    ...run,
                    settledAt: settled ? '2026-09-25T12:00:00Z' : undefined,
                  }
                : run,
            ),
          );
        }}
      />
    );
  }
  render(<Fixture />);
  expect(screen.getAllByRole('listitem')).toHaveLength(1);
  expect(
    screen.queryByRole('button', { name: `Settle run ${latest.runId}` }),
  ).toBeNull();
  fireEvent.click(screen.getByText('1 earlier attempt'));
  fireEvent.click(
    screen.getByRole('button', { name: `Settle run ${base.runId}` }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole('button', { name: `Open run ${base.runId}` }),
    ).toBeNull(),
  );
  expect(
    screen.getByRole('button', { name: `Open run ${latest.runId}` }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Settled 1' }));
  fireEvent.click(
    screen.getByRole('button', { name: `Restore run ${base.runId}` }),
  );
  await screen.findByRole('heading', { name: 'No matching runs' });
  fireEvent.click(screen.getByRole('button', { name: 'Unsettled 2' }));
  fireEvent.click(screen.getByText('1 earlier attempt'));
  save.mockRejectedValueOnce(new Error('Could not save settlement'));
  fireEvent.click(
    screen.getByRole('button', { name: `Settle run ${base.runId}` }),
  );
  expect(await screen.findByRole('alert')).toHaveProperty(
    'textContent',
    'Could not save settlement',
  );
  expect(
    screen.getByRole('button', { name: `Settle run ${base.runId}` }),
  ).toBeTruthy();
});

it('reveals a hidden settled attempt and opens that exact historical run', () => {
  const openRun = vi.fn();
  function Fixture() {
    const [view, setView] = useState<RunsViewState>({
      filter: 'Unsettled',
      query: '',
      page: 0,
    });
    return (
      <RunsOverview
        runs={[{ ...base, settledAt: '2026-09-25T12:00:00Z' }, latest]}
        loading={false}
        disabled={false}
        start={vi.fn()}
        openRun={openRun}
        repository=""
        onRepository={vi.fn()}
        view={view}
        setView={setView}
        settle={vi.fn()}
      />
    );
  }
  render(<Fixture />);
  expect(
    screen.getByRole('button', { name: `Open run ${latest.runId}` }),
  ).toBeTruthy();
  expect(
    screen.queryByRole('button', { name: `Open run ${base.runId}` }),
  ).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Show all attempts' }));
  fireEvent.click(screen.getByText('1 earlier attempt'));
  fireEvent.click(
    screen.getByRole('button', { name: `Open run ${base.runId}` }),
  );
  expect(openRun).toHaveBeenCalledWith(base.runId);
});

it('keeps a renamed ticket together using its integration identity', () => {
  expect(
    groupRuns([
      { ...base, issue: { ...base.issue, id: 'stable-ticket' } },
      {
        ...latest,
        issue: {
          ...latest.issue,
          id: 'stable-ticket',
          url: 'https://example.test/task/1/renamed',
        },
      },
    ]),
  ).toHaveLength(1);
});

it('joins retained manual attempts without IDs to the same integrated ticket', () => {
  const integrated = { ...base, issue: { ...base.issue, id: 'stable-ticket' } };
  expect(groupRuns([latest, integrated])).toHaveLength(1);
  expect(groupRuns([integrated, latest])[0].latest.runId).toBe(latest.runId);
});
