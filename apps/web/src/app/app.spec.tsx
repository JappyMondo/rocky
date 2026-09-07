import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DiffView, RunDetail, RunSummary, SettingsView, StepView } from '@rocky/local-contracts';
import { App } from './app.js';

const r1: RunSummary = { runId: 'r1', issue: { identifier: 'NG-612', title: 'Older Run', url: '/issues/NG-612' }, repo: 'rocky', branch: 'ng-612', status: 'parked', boots: 2, createdAt: '2026-09-01' };
const r2: RunSummary = { ...r1, runId: 'r2', issue: { ...r1.issue, title: 'Latest Run' }, status: 'running', createdAt: '2026-09-02' };
const agent = (changes: Partial<StepView> = {}): StepView => ({
  key: 'agent/0', seq: 0, step: 'agent', status: 'waiting', boot: 2, startedAt: '2026-09-01',
  completedBeforeCurrentBoot: false, transcript: 'available', attempts: [], screenshots: [],
  result: { summary: 'Awaiting a decision', steps: ['Inspect the issue'], ci: { lint: 'passed' } },
  usage: { inputTokens: 12, usd: 0.01 }, ...changes,
});
const detail = (run: RunSummary = r1, changes: Partial<RunDetail> = {}): RunDetail => ({
  run, revision: 'one', steps: [agent()],
  checkpoint: { stepKey: 'agent/0', generation: 'g1', title: 'Choose', body: 'Should Rocky continue?' },
  steers: [], usage: { reported: { inputTokens: 12 }, missing: { inputTokens: 0, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, usd: 0 } },
  diffs: [], controls: { answer: true, steer: true }, ...changes,
});
const settings = (changes: Partial<SettingsView> = {}): SettingsView => ({
  values: { server: { host: '127.0.0.1', port: 7625 }, retention: { keepTerminalRuns: 10, keepSessionsAndScreenshots: 5 }, concurrency: { maxRuns: 1 } },
  revision: 'old', restartRequired: false, mcpAvailable: true,
  mcp: [{ name: 'linear', status: 'authenticated', loginCommand: 'rocky login linear' }], ...changes,
});
const diff: DiffView = {
  id: 'd/1', baseSha: 'base', headSha: 'head', availability: 'available',
  files: [{ path: 'src/a.ts', kind: 'file', status: 'modified', hunks: [{ header: '@@', lines: [{ kind: 'add', text: 'new', headLine: 1 }] }] }],
  annotations: [],
};
type Reply = { ok?: boolean; status?: number; body?: unknown; version?: string; reject?: unknown };
const reply = ({ ok = true, status = 200, body = {}, version = '0.0.0', reject }: Reply = {}) =>
  reject ? Promise.reject(reject) : Promise.resolve({ ok, status, json: async () => body, headers: { get: (name: string) => name === 'x-rocky-version' ? version : null } } as unknown as Response);
function installFetch(handler: (path: string, init?: RequestInit) => Reply) {
  const mock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => reply(handler(String(input), init)));
  vi.stubGlobal('fetch', mock);
  return mock;
}
function daemon(options: {
  runs?: RunSummary[];
  detail?: (id: string, count: number) => Reply;
  health?: (count: number) => Reply;
  settings?: (init?: RequestInit) => Reply;
  trigger?: (init?: RequestInit) => Reply;
  diffs?: (path: string) => Reply;
} = {}) {
  let details = 0;
  let healths = 0;
  return installFetch((path, init) => {
    if (path === '/api/health') return options.health?.(++healths) ?? { body: { status: 'ok', version: '0.0.0' } };
    if (path === '/api/runs') return { body: { runs: options.runs ?? [r1], pollAfterMs: 30000 } };
    if (path === '/api/settings') return options.settings?.(init) ?? { body: settings() };
    if (path === '/api/triggers') return options.trigger?.(init) ?? { body: { runId: 'r3' } };
    if (/\/diffs\//.test(path)) return options.diffs?.(path) ?? { body: diff };
    if (path.startsWith('/api/runs/')) return options.detail?.(decodeURIComponent(path.split('/')[3]), ++details) ?? { body: detail() };
    return { body: { state: 'held' } };
  });
}
async function loaded(name = 'Older Run') {
  expect(await screen.findByRole('heading', { name })).toBeTruthy();
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  history.replaceState({}, '', '/');
});

describe('Inbox behavior', () => {
  it('routes direct Runs and issue hashes, and tells a missing issue apart from an empty inbox', async () => {
    history.replaceState({}, '', '/runs/r2');
    const mock = daemon({ runs: [r1, r2], detail: (id) => ({ body: detail(id === 'r2' ? r2 : r1) }) });
    render(<App />);
    await loaded('Latest Run');
    expect(mock).toHaveBeenCalledWith('/api/runs/r2', expect.anything());
    cleanup();
    history.replaceState({}, '', '/issues/NOPE-404');
    daemon({ runs: [] });
    render(<App />);
    expect(await screen.findByText('No Run found for NOPE-404.')).toBeTruthy();
    expect(screen.getByText('No Runs yet.')).toBeTruthy();
  });

  it('preserves readable mutation text for HTTP errors and reports an already-won answer', async () => {
    let answer = 0;
    const mock = daemon({ detail: () => ({ body: detail() }) });
    mock.mockImplementation((input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith('/answer')) {
        answer += 1;
        return reply(answer === 1
          ? { ok: false, status: 409, body: { error: 'already answered', code: 'conflict', answer: { decision: 'approve' } } }
          : { ok: false, status: 500, body: { error: 'slow proxy', code: 'down' } });
      }
      if (path === '/api/health') return reply({ body: { status: 'ok', version: '0.0.0' } });
      if (path === '/api/runs') return reply({ body: { runs: [r1], pollAfterMs: 30000 } });
      return reply({ body: detail() });
    });
    render(<App />);
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: /Approve/ }));
    expect((await screen.findByRole('alert')).textContent).toContain('already answered: approve');
    fireEvent.click(screen.getByRole('button', { name: /Reject/ }));
    expect((await screen.findByRole('alert')).textContent).toContain('Answer was not saved. slow proxy');
    cleanup();
    daemon({ detail: () => ({ body: detail(r1, { checkpoint: undefined }) }) });
    render(<App />);
    await loaded();
    const steer = screen.getByLabelText('Steer this Run');
    fireEvent.change(steer, { target: { value: 'Keep this wording' } });
    installFetch((path) => path.endsWith('/steer') ? { reject: new TypeError('offline') } : path === '/api/health' ? { body: { status: 'ok', version: '0.0.0' } } : path === '/api/runs' ? { body: { runs: [r1], pollAfterMs: 30000 } } : { body: detail(r1, { checkpoint: undefined }) });
    fireEvent.click(screen.getByRole('button', { name: 'Send Steer' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Your text is preserved');
    expect((steer as HTMLTextAreaElement).value).toBe('Keep this wording');
  });

  it('recovers after polling failures, reports daemon death before any list, and disables mutations on version mismatch', async () => {
    vi.useFakeTimers();
    let list = 0;
    daemon();
    const mock = globalThis.fetch as ReturnType<typeof vi.fn>;
    mock.mockImplementation((input: RequestInfo | URL) => {
      const path = String(input);
      if (path === '/api/health') return reply({ reject: new TypeError('offline') });
      if (path === '/api/runs') return reply(++list === 1 ? { reject: new TypeError('offline') } : { body: { runs: [r1], pollAfterMs: 30000 } });
      return reply({ body: detail() });
    });
    render(<App />);
    await act(async () => {});
    expect(screen.getByText(/No daemon answering/)).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(screen.getByRole('heading', { name: 'Older Run' })).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
    cleanup();
    daemon({ health: () => ({ body: { status: 'ok', version: '9.9.9' }, version: '9.9.9' }) });
    render(<App />);
    await act(async () => {});
    expect(screen.getByRole('heading', { name: 'Older Run' })).toBeTruthy();
    expect((screen.getByRole('button', { name: /Approve/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Trigger' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('polls active detail and refreshes the selected diff on a revision then closes it', async () => {
    vi.useFakeTimers();
    const active = { ...r2, status: 'running' as const };
    daemon({
      runs: [r1, active],
      detail: (id, count) => ({ body: detail(id === 'r2' ? active : r1, { revision: String(count), diffs: [{ id: 'd/1', label: 'Recorded diff', baseSha: 'b', headSha: 'h' }] }) }),
      diffs: () => ({ body: diff }),
    });
    render(<App />);
    await act(async () => {});
    expect(screen.getByRole('heading', { name: 'Older Run' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /NG-612.*Latest Run/ }));
    await act(async () => {});
    expect(screen.getByRole('heading', { name: 'Latest Run' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Recorded diff' }));
    await act(async () => {});
    expect(screen.getByLabelText('Diff viewer')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(([x]) => String(x).includes('/diffs/')).length).toBeGreaterThan(1);
    fireEvent.click(screen.getByRole('button', { name: 'Close diff viewer' }));
    expect(screen.queryByLabelText('Diff viewer')).toBeNull();
  });

  it('implements inbox shortcuts without stealing typed or modified keys', async () => {
    daemon({ runs: [r1, r2], detail: (id) => ({ body: detail(id === 'r2' ? r2 : r1, { checkpoint: undefined }) }) });
    render(<App />);
    await loaded();
    fireEvent.keyDown(window, { key: 'j' });
    await loaded('Latest Run');
    fireEvent.keyDown(window, { key: 'k' });
    await loaded('Older Run');
    fireEvent.keyDown(window, { key: 'o' });
    expect(screen.getByText('Transcript could not be read.')).toBeTruthy();
    fireEvent.keyDown(window, { key: 's' });
    expect(document.activeElement).toBe(screen.getByLabelText('Steer this Run'));
    fireEvent.keyDown(document.activeElement!, { key: 'u' });
    expect(location.pathname).toBe('/runs/r1');
    fireEvent.keyDown(window, { key: 'u' });
    expect(location.pathname).toBe('/');
    fireEvent.keyDown(window, { key: 'j', ctrlKey: true });
    expect(location.pathname).toBe('/');
  });

  it('submits canonical triggers, clears success, and presents a named refusal', async () => {
    let refused = false;
    const mock = daemon({ trigger: () => refused ? { ok: false, status: 409, body: { code: 'trigger-refused', error: 'NG-612 already has Run r1' } } : { body: { runId: 'r3' } } });
    render(<App />);
    await loaded();
    const issue = screen.getByLabelText('Trigger issue');
    fireEvent.change(issue, { target: { value: 'NG-612' } });
    fireEvent.click(screen.getByRole('button', { name: 'Trigger' }));
    await vi.waitFor(() => expect((issue as HTMLInputElement).value).toBe(''));
    expect(mock).toHaveBeenCalledWith('/api/triggers', expect.objectContaining({ body: JSON.stringify({ trigger: 'address-pr-conversations', issue: 'NG-612' }) }));
    refused = true;
    fireEvent.change(issue, { target: { value: 'NG-612' } });
    fireEvent.click(screen.getByRole('button', { name: 'Trigger' }));
    expect((await screen.findByRole('alert')).textContent).toContain('NG-612 already has Run r1');
  });

  it('renders run history, result variants, artifacts, usage, terminal controls, and direct step hashes', async () => {
    history.replaceState({}, '', '/runs/r1#step=agent%2F2');
    const finished = { ...r1, status: 'finished' as const, artifactsPruned: true };
    const complex = detail(finished, {
      checkpoint: { stepKey: 'agent/0', generation: 'g1', title: 'Done', body: 'Done', answer: { decision: 'reject', reason: 'not now' } },
      usage: { reported: { cacheReadTokens: 3, cacheCreationTokens: 4, usd: 0 }, missing: { inputTokens: 2, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, usd: 0 } },
      steps: [
        agent({ key: 'agent/0', boot: 1, completedBeforeCurrentBoot: true, ms: 1234, parentKey: 'root', result: 'A plain result', screenshots: [{ id: 'shot/1', caption: 'proof' }] }),
        agent({ key: 'agent/1', seq: 1, boot: 2, result: { summary: 'Plan', steps: ['one', { two: 2 }], ci: 'skipped', results: { tests: 'ok' } }, error: { name: 'Boom', message: 'bad result' }, attempts: [{ kind: 'failed', startedAt: 'now', ms: 5, note: 'retry', error: { name: 'Error', message: 'no' } }] }),
        agent({ key: 'agent/2', seq: 2, label: 'No result', result: undefined, transcript: 'pruned', usage: undefined }),
      ],
    });
    daemon({ detail: () => ({ body: complex }) });
    render(<App />);
    await loaded('Older Run');
    expect(screen.getByText(/Answered: reject/)).toBeTruthy();
    expect(screen.getByText(/3 cache read/)).toBeTruthy();
    expect(screen.getByText('A plain result')).toBeTruthy();
    expect(screen.getByText('Plan')).toBeTruthy();
    expect(screen.getByText('Results')).toBeTruthy();
    expect(screen.getByText(/Boom:/)).toBeTruthy();
    expect(screen.getByRole('img', { name: 'proof' }).closest('a')?.getAttribute('href')).toBe('/api/screenshots/shot%2F1');
    expect((screen.getByRole('button', { name: /No result/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/finished; its Steer intake is closed/)).toBeTruthy();
    await act(async () => { dispatchEvent(new HashChangeEvent('hashchange')); });
    expect(screen.getByRole('button', { name: /No result/ }).getAttribute('aria-expanded')).toBe('true');
  });

  it('owns transcript streams per fold and handles data, duplicates, settled, unavailable, error, construction failure, and unmount', async () => {
    const sources: FakeSource[] = [];
    const close = vi.fn();
    class FakeSource {
      handlers = new Map<string, (event: Event) => void>();
      onerror: (() => void) | null = null;
      constructor(public url: string) { sources.push(this); if (url.includes('agent%2F2')) throw new Error('blocked'); }
      addEventListener(name: string, handler: (event: Event) => void) { this.handlers.set(name, handler); }
      close = close;
    }
    vi.stubGlobal('EventSource', FakeSource);
    daemon({ detail: () => ({ body: detail(r1, { steps: [agent({ key: 'agent/0', status: 'running' }), agent({ key: 'agent/1', seq: 1, status: 'done', transcript: 'pending' }), agent({ key: 'agent/2', seq: 2 })] }) }) });
    const view = render(<App />);
    await loaded();
    fireEvent.click(screen.getAllByRole('button', { name: /agent/ })[0]);
    const first = sources[0];
    await act(async () => { first.handlers.get('transcript')?.({ data: '{bad' } as MessageEvent); });
    expect(screen.getByText('Transcript could not be read.')).toBeTruthy();
    await act(async () => { first.handlers.get('transcript')?.({ data: JSON.stringify({ text: 'hello', offset: 1 }) } as MessageEvent); });
    expect(screen.getByText('hello')).toBeTruthy();
    await act(async () => { first.handlers.get('transcript')?.({ data: JSON.stringify({ text: 'ignored', offset: 1 }) } as MessageEvent); });
    expect(screen.queryByText('ignored')).toBeNull();
    await act(async () => { first.handlers.get('settled')?.(new Event('settled')); });
    expect(close).toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole('button', { name: /agent/ })[0]);
    fireEvent.click(document.getElementById('step=agent/1')!.querySelector('button')!);
    const second = sources.find((x) => x.url.includes('agent%2F1'))!;
    await act(async () => { second.handlers.get('unavailable')?.(new Event('unavailable')); });
    expect(screen.getByText('Transcript is unavailable.')).toBeTruthy();
    fireEvent.click(document.getElementById('step=agent/2')!.querySelector('button')!);
    expect(screen.getByText('Transcript could not be read.')).toBeTruthy();
    view.unmount();
    expect(close).toHaveBeenCalled();
  });

  it('edits all settings fields, retains revisions between saves, exposes MCP status, and reports settings failures', async () => {
    history.replaceState({}, '', '/settings');
    let saves = 0;
    const mock = daemon({ settings: (init) => init?.method === 'PATCH'
      ? ++saves === 1
        ? { body: settings({ revision: 'new', restartRequired: true, values: { ...settings().values, server: { host: '0.0.0.0', port: 7630 } } }) }
        : { ok: false, status: 500, body: { error: 'write denied', code: 'forbidden' } }
      : { body: settings() } });
    render(<App />);
    const host = await screen.findByLabelText('Bind host');
    fireEvent.change(host, { target: { value: '0.0.0.0' } });
    fireEvent.change(screen.getByLabelText('Bind port'), { target: { value: '7630' } });
    fireEvent.change(screen.getByLabelText('Retention: terminal Runs'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Retention: sessions & screenshots'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Maximum concurrent Runs'), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await screen.findByText(/Restart Rocky/);
    expect(mock).toHaveBeenCalledWith('/api/settings', expect.objectContaining({ body: expect.stringContaining('"revision":"old"') }));
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Settings were not saved. write denied');
    expect(screen.getByText('linear')).toBeTruthy();
    cleanup();
    history.replaceState({}, '', '/settings');
    daemon({ settings: () => ({ body: settings({ mcpAvailable: false, mcp: [] }) }) });
    render(<App />);
    expect(await screen.findByText('MCP status is unavailable.')).toBeTruthy();
  });
});
