import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WorkflowDiagram } from './workflow-diagram.js';

const mermaid = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }));
vi.mock('mermaid', () => ({ default: mermaid }));
const mismatch = vi.fn();
const props = {
  profileId: 'service',
  revision: 'one',
  unsaved: false,
  disabled: false,
  mismatch,
};
const ready = {
  sourceHash: 'a',
  status: 'ready',
  mermaid: 'flowchart TB\n A --> B',
};
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'x-rocky-version': '0.0.0' },
  });
beforeEach(() => {
  mermaid.render.mockResolvedValue({
    svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>Start to finish</text></svg>',
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response(ready)),
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it('renders a cached chart as an isolated image with source, zoom and an expanded view', async () => {
  render(<WorkflowDiagram {...props} unsaved />);
  const chart = await screen.findByAltText(
    'Workflow stages, decisions and outcomes',
  );
  expect(chart.getAttribute('src')).toMatch(/^data:image\/svg\+xml/);
  expect(chart.parentElement?.style.width).toBe('100%');
  expect(chart.parentElement?.style.height).toBe('100%');
  expect(mermaid.render).toHaveBeenCalledWith(
    expect.any(String),
    'flowchart LR\n A --> B',
    expect.any(HTMLElement),
  );
  expect(mermaid.initialize).toHaveBeenCalledWith(
    expect.objectContaining({ securityLevel: 'strict' }),
  );
  expect(screen.getByText(/Showing the saved workflow/)).toBeTruthy();
  expect(screen.getByText(/flowchart LR A --> B/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
  expect(screen.getByText('125%')).toBeTruthy();
  expect(chart.parentElement?.style.width).toBe('125%');
  expect(chart.parentElement?.style.height).toBe('125%');
  for (let i = 0; i < 7; i++)
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
  expect(
    (screen.getByRole('button', { name: 'Zoom in' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  const canvas = screen.getByLabelText('Workflow chart, scroll to explore');
  canvas.scrollLeft = 200;
  canvas.scrollTop = 100;
  fireEvent.click(screen.getByRole('button', { name: 'Fit diagram' }));
  expect(canvas.scrollLeft).toBe(0);
  expect(canvas.scrollTop).toBe(0);
  expect(chart.parentElement?.style.width).toBe('100%');
  expect(chart.parentElement?.style.height).toBe('100%');
  fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
  fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
  expect(
    (screen.getByRole('button', { name: 'Zoom out' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Expand' }));
  const dialog = screen.getByRole('dialog', { name: 'Workflow overview' });
  expect(
    await within(dialog).findByAltText(
      'Workflow stages, decisions and outcomes',
    ),
  ).toBeTruthy();
  fireEvent.click(
    within(dialog).getByRole('button', { name: 'Close workflow overview' }),
  );
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('does not generate diagrams for an unsaved profile', () => {
  render(<WorkflowDiagram {...props} profileId={undefined} />);
  expect(screen.getByText(/Save this profile/)).toBeTruthy();
  expect(fetch).not.toHaveBeenCalled();
});

it('polls queued and running jobs and replaces an old diagram after a saved edit', async () => {
  vi.useFakeTimers();
  const fetcher = vi.mocked(fetch);
  fetcher
    .mockResolvedValueOnce(response({ sourceHash: 'a', status: 'queued' }))
    .mockResolvedValueOnce(response({ sourceHash: 'a', status: 'generating' }))
    .mockResolvedValueOnce(response(ready));
  const view = render(<WorkflowDiagram {...props} />);
  await act(async () => undefined);
  expect(screen.getByText('Preparing your workflow diagram…')).toBeTruthy();
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(screen.getByText('Your agent is mapping the workflow…')).toBeTruthy();
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(
    screen.getByAltText('Workflow stages, decisions and outcomes'),
  ).toBeTruthy();
  fetcher.mockResolvedValueOnce(
    response({ sourceHash: 'b', status: 'queued' }),
  );
  view.rerender(<WorkflowDiagram {...props} revision="two" />);
  await act(async () => undefined);
  expect(
    screen.queryByAltText('Workflow stages, decisions and outcomes'),
  ).toBeNull();
  expect(screen.getByText('Preparing your workflow diagram…')).toBeTruthy();
});

it('recovers from generation errors through the retry endpoint and reports retry failures', async () => {
  const fetcher = vi.mocked(fetch);
  fetcher.mockImplementation(async (_url, init) =>
    init?.method === 'POST'
      ? response({ error: 'Agent is offline.' }, 503)
      : response({
          sourceHash: 'a',
          status: 'failed',
          error: 'Could not generate this diagram.',
        }),
  );
  render(<WorkflowDiagram {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Retry diagram' }));
  expect(
    await screen.findByText(
      /Could not regenerate the diagram. Agent is offline./,
    ),
  ).toBeTruthy();
  fetcher.mockImplementation(async (_url, init) =>
    init?.method === 'POST'
      ? response({ sourceHash: 'a', status: 'queued' })
      : response(ready),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Retry diagram' }));
  expect(
    await screen.findByAltText('Workflow stages, decisions and outcomes'),
  ).toBeTruthy();
  expect(fetcher).toHaveBeenCalledWith(
    '/api/profiles/service/diagram/retry',
    expect.objectContaining({ method: 'POST' }),
  );
  expect(screen.queryByText(/Agent is offline/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
  await waitFor(() => expect(screen.queryByText('Retrying…')).toBeNull());
});

it('reports fetch and Mermaid errors without injecting agent output into the page', async () => {
  const fetcher = vi.mocked(fetch);
  fetcher.mockRejectedValueOnce(new Error('offline'));
  const view = render(<WorkflowDiagram {...props} />);
  expect(
    await screen.findByText('Could not load the workflow diagram.'),
  ).toBeTruthy();
  mermaid.render.mockRejectedValueOnce(new Error('invalid syntax'));
  view.rerender(<WorkflowDiagram {...props} revision="two" disabled />);
  expect(
    await screen.findByText(/This diagram could not be drawn/),
  ).toBeTruthy();
  expect(
    (screen.getByRole('button', { name: 'Regenerate' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(
    screen.queryByAltText('Workflow stages, decisions and outcomes'),
  ).toBeNull();
});

it('discards late requests and renderer results on unmount', async () => {
  let finish!: (value: Response) => void;
  vi.mocked(fetch).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const view = render(<WorkflowDiagram {...props} />);
  view.unmount();
  await act(async () => finish(response(ready)));
  expect(mermaid.render).not.toHaveBeenCalled();
  let finishRender!: (value: { svg: string }) => void;
  mermaid.render.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishRender = resolve;
      }),
  );
  const next = render(<WorkflowDiagram {...props} />);
  await waitFor(() => expect(mermaid.render).toHaveBeenCalled());
  next.unmount();
  await act(async () => finishRender({ svg: '<svg />' }));
  expect(document.querySelector('[style*="-100000px"]')).toBeNull();
});

it('aborts a retry when the profile is left', async () => {
  let finish!: (value: Response) => void;
  let signal: AbortSignal | null | undefined;
  vi.mocked(fetch).mockImplementation(async (_url, init) => {
    if (init?.method === 'POST') {
      signal = init.signal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    }
    return response(ready);
  });
  const view = render(<WorkflowDiagram {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Regenerate' }));
  expect(screen.getByText('Retrying…')).toBeTruthy();
  view.unmount();
  expect(signal?.aborted).toBe(true);
  await act(async () => finish(response({ error: 'late' }, 503)));
});
