import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DiffView,
  RunDetail,
  RunSummary,
  SettingsView,
  StepView,
} from '@rocky/local-contracts';
import { App } from './app.js';

const r1: RunSummary = {
  runId: 'r1',
  issue: { identifier: 'NG-612', title: 'Older Run', url: '/issues/NG-612' },
  repo: 'rocky',
  branch: 'ng-612',
  status: 'parked',
  boots: 2,
  createdAt: '2026-09-01',
};
const r2: RunSummary = {
  ...r1,
  runId: 'r2',
  issue: { ...r1.issue, title: 'Latest Run' },
  status: 'running',
  createdAt: '2026-09-02',
};
const agent = (changes: Partial<StepView> = {}): StepView => ({
  key: '0',
  seq: 0,
  step: 'agent',
  status: 'waiting',
  boot: 2,
  startedAt: '2026-09-01',
  completedBeforeCurrentBoot: false,
  transcript: 'available',
  attempts: [],
  screenshots: [],
  result: {
    summary: 'Awaiting a decision',
    steps: ['Inspect the issue'],
    ci: { lint: 'passed' },
  },
  usage: { inputTokens: 12, usd: 0.01 },
  ...changes,
});
const detail = (
  run: RunSummary = r1,
  changes: Partial<RunDetail> = {},
): RunDetail => ({
  run,
  revision: 'one',
  steps: [agent()],
  checkpoint: {
    stepKey: '0',
    generation: 'g1',
    title: 'Choose',
    body: 'Should Rocky continue?',
  },
  steers: [],
  usage: {
    reported: { inputTokens: 12 },
    missing: {
      inputTokens: 0,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      usd: 0,
    },
  },
  diffs: [],
  controls: { answer: true, steer: true },
  ...changes,
});
const settings = (changes: Partial<SettingsView> = {}): SettingsView => ({
  values: {
    server: { host: '127.0.0.1', port: 7625 },
    retention: { keepTerminalRuns: 10, keepSessionsAndScreenshots: 5 },
    concurrency: { maxRuns: 1 },
  },
  revision: 'old',
  restartRequired: false,
  mcpAvailable: true,
  mcp: [
    {
      name: 'linear',
      status: 'authenticated',
      loginCommand: 'rocky login linear',
    },
  ],
  ...changes,
});
const diff: DiffView = {
  id: 'd/1',
  baseSha: 'base',
  headSha: 'head',
  availability: 'available',
  files: [
    {
      path: 'src/a.ts',
      kind: 'file',
      status: 'modified',
      hunks: [
        { header: '@@', lines: [{ kind: 'add', text: 'new', headLine: 1 }] },
      ],
    },
  ],
  annotations: [],
};
type Reply = {
  ok?: boolean;
  status?: number;
  body?: unknown;
  version?: string;
  reject?: unknown;
};
const reply = ({
  ok = true,
  status = 200,
  body = {},
  version = '0.0.0',
  reject,
}: Reply = {}) =>
  reject
    ? Promise.reject(reject)
    : Promise.resolve({
        ok,
        status,
        json: async () => body,
        headers: {
          get: (name: string) => (name === 'x-rocky-version' ? version : null),
        },
      } as unknown as Response);
function installFetch(handler: (path: string, init?: RequestInit) => Reply) {
  const mock = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    reply(handler(String(input), init)),
  );
  vi.stubGlobal('fetch', mock);
  return mock;
}
function daemon(
  options: {
    runs?: RunSummary[];
    detail?: (id: string, count: number) => Reply;
    health?: (count: number) => Reply;
    intakeFailures?: (count: number) => Reply;
    settings?: (init?: RequestInit) => Reply;
    profiles?: (init?: RequestInit) => Reply;
    routing?: (path: string, init?: RequestInit) => Reply;
    profileDefaults?: () => Reply;
    openWorkflow?: (init?: RequestInit) => Reply;
    trigger?: (init?: RequestInit) => Reply;
    recovery?: (init?: RequestInit) => Reply;
    diffs?: (path: string) => Reply;
  } = {},
) {
  let details = 0;
  let healths = 0;
  let intakeFailureReads = 0;
  return installFetch((path, init) => {
    if (path === '/api/connections')
      return {
        body: {
          profiles: [],
          linear: { state: 'connected', message: 'Linear connected' },
        },
      };
    if (path === '/api/health')
      return (
        options.health?.(++healths) ?? {
          body: { status: 'ok', version: '0.0.0' },
        }
      );
    if (path === '/api/intake-failures')
      return options.intakeFailures?.(++intakeFailureReads) ?? { body: [] };
    if (path === '/api/runs')
      return { body: { runs: options.runs ?? [r1], pollAfterMs: 30000 } };
    if (path === '/api/settings')
      return options.settings?.(init) ?? { body: settings() };
    if (path === '/api/profiles')
      return options.profiles?.(init) ?? { body: { profiles: [] } };
    if (path === '/api/profile-defaults')
      return (
        options.profileDefaults?.() ?? {
          body: {
            workflow: {
              source: 'export default [defaultWorkflow];',
              triggers: ['linear.onDelegate', 'address-pr-conversations'],
            },
            grants: { harness: 'opencode', capabilities: [], mcp: [] },
            prompts: ['planner', 'implementer'],
            rules: [],
            secretEnv: ['GITHUB_TOKEN'],
          },
        }
      );
    if (/\/open-workflow$/.test(path))
      return options.openWorkflow?.(init) ?? { body: { opened: true } };
    if (/\/routing$/.test(path))
      return (
        options.routing?.(path, init) ?? {
          body: {
            profileId: 'service',
            labels: ['service'],
            teams: [],
            revision: 'routing-revision',
          },
        }
      );
    if (/\/diagram$/.test(path))
      return { body: { sourceHash: 'saved', status: 'queued' } };
    if (path === '/api/triggers')
      return options.trigger?.(init) ?? { body: { runId: 'r3' } };
    if (/\/recover-session$/.test(path))
      return (
        options.recovery?.(init) ?? {
          body: { issueIdentifier: 'NG-612', sessionId: 'stale-session' },
        }
      );
    if (/\/diffs\//.test(path)) return options.diffs?.(path) ?? { body: diff };
    if (path.startsWith('/api/runs/'))
      return (
        options.detail?.(decodeURIComponent(path.split('/')[3]), ++details) ?? {
          body: detail(),
        }
      );
    return { body: { state: 'held' } };
  });
}
async function loaded(name = 'Older Run') {
  expect(await screen.findByRole('heading', { name })).toBeTruthy();
}
beforeEach(() => {
  window.history.replaceState({}, '', '/runs/r1');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  window.history.replaceState({}, '', '/');
});

describe('Inbox behavior', () => {
  it('releases a failed Linear session only on the explicit recovery action', async () => {
    const failed = { ...r1, status: 'failed' as const };
    const mock = daemon({
      runs: [failed],
      detail: () => ({
        body: detail(failed, {
          checkpoint: undefined,
          controls: { answer: false, steer: false },
        }),
      }),
    });
    render(<App />);
    await loaded();
    fireEvent.click(
      screen.getByRole('button', { name: 'Enable fresh Linear delegation' }),
    );
    expect(
      await screen.findByText(
        'Released the stale Linear session for NG-612. Delegate Rocky again in Linear to start a fresh Run.',
      ),
    ).toBeTruthy();
    expect(mock).toHaveBeenCalledWith(
      '/api/runs/r1/recover-session',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('keeps a failed session recoverable when the daemon rejects the release', async () => {
    const failed = { ...r1, status: 'failed' as const };
    daemon({
      runs: [failed],
      detail: () => ({
        body: detail(failed, {
          checkpoint: undefined,
          controls: { answer: false, steer: false },
        }),
      }),
      recovery: () => ({
        ok: false,
        status: 409,
        body: { error: 'The session belongs to a live Run.' },
      }),
    });
    render(<App />);
    await loaded();
    fireEvent.click(
      screen.getByRole('button', { name: 'Enable fresh Linear delegation' }),
    );
    expect(
      await screen.findByText(
        'Could not release this Linear session for re-delegation. The session belongs to a live Run.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Enable fresh Linear delegation' }),
    ).toBeTruthy();
  });

  it('offers the same explicit recovery for a cancelled Run', async () => {
    const cancelled = { ...r1, status: 'cancelled' as const };
    daemon({
      runs: [cancelled],
      detail: () => ({
        body: detail(cancelled, {
          checkpoint: undefined,
          controls: { answer: false, steer: false },
        }),
      }),
    });
    render(<App />);
    await loaded();
    expect(
      screen.getByRole('button', { name: 'Enable fresh Linear delegation' }),
    ).toBeTruthy();
  });

  it('routes direct Runs and issue hashes, and tells a missing issue apart from an empty inbox', async () => {
    window.history.replaceState({}, '', '/runs/r2');
    const mock = daemon({
      runs: [r1, r2],
      detail: (id) => ({ body: detail(id === 'r2' ? r2 : r1) }),
    });
    render(<App />);
    await loaded('Latest Run');
    expect(mock).toHaveBeenCalledWith('/api/runs/r2', expect.anything());
    cleanup();
    window.history.replaceState({}, '', '/issues/NOPE-404');
    daemon({ runs: [] });
    render(<App />);
    expect(await screen.findByText('No Run found for NOPE-404.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Rocky home' }));
    expect(
      screen.getByRole('heading', { name: 'Ready when you are.' }),
    ).toBeTruthy();
  });

  it('preserves readable mutation text for HTTP errors and reports an already-won answer', async () => {
    let answer = 0;
    const mock = daemon({ detail: () => ({ body: detail() }) });
    mock.mockImplementation((input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith('/answer')) {
        answer += 1;
        return reply(
          answer === 1
            ? {
                ok: false,
                status: 409,
                body: {
                  error: 'already answered',
                  code: 'conflict',
                  answer: { decision: 'approve' },
                },
              }
            : {
                ok: false,
                status: 500,
                body: { error: 'slow proxy', code: 'down' },
              },
        );
      }
      if (path === '/api/health')
        return reply({ body: { status: 'ok', version: '0.0.0' } });
      if (path === '/api/runs')
        return reply({ body: { runs: [r1], pollAfterMs: 30000 } });
      return reply({ body: detail() });
    });
    render(<App />);
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: /Approve/ }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'already answered: approve',
    );
    expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull();
    cleanup();
    render(<App />);
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: /Reject/ }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Answer was not saved. slow proxy',
    );
    cleanup();
    daemon({ detail: () => ({ body: detail(r1, { checkpoint: undefined }) }) });
    render(<App />);
    await loaded();
    const steer = screen.getByLabelText('Steer this Run');
    fireEvent.change(steer, { target: { value: 'Keep this wording' } });
    installFetch((path) =>
      path.endsWith('/steer')
        ? { reject: new TypeError('offline') }
        : path === '/api/health'
          ? { body: { status: 'ok', version: '0.0.0' } }
          : path === '/api/runs'
            ? { body: { runs: [r1], pollAfterMs: 30000 } }
            : { body: detail(r1, { checkpoint: undefined }) },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Send Steer' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Your text is preserved',
    );
    expect((steer as HTMLTextAreaElement).value).toBe('Keep this wording');
  });

  it('recovers after polling failures, reports daemon death before any list, and disables mutations on version mismatch', async () => {
    vi.useFakeTimers();
    let list = 0;
    daemon();
    const mock = globalThis.fetch as ReturnType<typeof vi.fn>;
    mock.mockImplementation((input: RequestInfo | URL) => {
      const path = String(input);
      if (path === '/api/health')
        return reply({ reject: new TypeError('offline') });
      if (path === '/api/runs')
        return reply(
          ++list === 1
            ? { reject: new TypeError('offline') }
            : { body: { runs: [r1], pollAfterMs: 30000 } },
        );
      if (path.startsWith('/api/runs/'))
        return list < 2
          ? reply({ reject: new TypeError('offline') })
          : reply({ body: detail() });
      return reply({ body: detail() });
    });
    render(<App />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText(/No daemon answering/)).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(screen.getByRole('heading', { name: 'Older Run' })).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
    cleanup();
    daemon({
      health: () => ({
        body: { status: 'ok', version: '9.9.9' },
        version: '9.9.9',
      }),
    });
    render(<App />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole('heading', { name: 'Older Run' })).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: /Approve/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Rocky home' }));
    fireEvent.click(screen.getByRole('button', { name: 'New run' }));
    expect(
      (screen.getByRole('button', { name: 'Start run' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('surfaces current public-ingress liveness, verification age, and a tunnel remedy', async () => {
    daemon({
      health: () => ({
        body: {
          status: 'ok',
          version: '0.0.0',
          endpoint: {
            configured: true,
            ok: true,
            checkedAt: '2026-09-09T11:00:00.000Z',
          },
        },
      }),
    });
    render(<App />);
    expect(
      await screen.findByText('Public endpoint is reachable.'),
    ).toBeTruthy();
    expect(screen.getByText(/Last verified/)).toBeTruthy();
    expect(screen.getByText(/once a minute/)).toBeTruthy();
    cleanup();
    daemon({
      health: () => ({
        body: {
          status: 'ok',
          version: '0.0.0',
          endpoint: { configured: true, ok: false, detail: 'answered 502' },
        },
      }),
    });
    render(<App />);
    expect(
      (await screen.findAllByText('Linear cannot reach Rocky.')).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText(/Checking the public endpoint now/).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getByText(/Restore your tunnel or Tailscale Funnel/),
    ).toBeTruthy();
  });

  it('surfaces durable, safe Linear intake failures with their remediation', async () => {
    daemon({
      intakeFailures: () => ({
        body: [
          {
            sessionId: 'session-1',
            action: 'created',
            occurredAt: '2026-09-10T12:00:00.000Z',
            reason:
              'Rocky acknowledged this Linear delivery but could not admit its Run.',
            remediation: 'Open Rocky locally and delegate the issue again.',
          },
        ],
      }),
    });
    render(<App />);
    expect(
      await screen.findByText(/Linear intake needs attention/),
    ).toBeTruthy();
    expect(screen.getByText('Session session-1')).toBeTruthy();
    expect(screen.getByText(/could not admit its Run/)).toBeTruthy();
    expect(screen.getByText(/delegate the issue again/)).toBeTruthy();
  });

  it('polls active detail and refreshes the selected diff on a revision then closes it', async () => {
    vi.useFakeTimers();
    const active = { ...r2, status: 'running' as const };
    daemon({
      runs: [r1, active],
      detail: (id, count) => ({
        body: detail(id === 'r2' ? active : r1, {
          revision: String(count),
          diffs: [
            { id: 'd/1', label: 'Recorded diff', baseSha: 'b', headSha: 'h' },
          ],
        }),
      }),
      diffs: () => ({ body: diff }),
    });
    render(<App />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole('heading', { name: 'Older Run' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /NG-612.*Latest Run/ }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole('heading', { name: 'Latest Run' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Recorded diff' }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByLabelText('Diff viewer')).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(
      (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(([x]) =>
        String(x).includes('/diffs/'),
      ).length,
    ).toBeGreaterThan(1);
    fireEvent.click(screen.getByRole('button', { name: 'Close diff viewer' }));
    expect(screen.queryByLabelText('Diff viewer')).toBeNull();
  });

  it('implements inbox shortcuts without stealing typed or modified keys', async () => {
    daemon({
      runs: [r1, r2],
      detail: (id) => ({
        body: detail(id === 'r2' ? r2 : r1, { checkpoint: undefined }),
      }),
    });
    render(<App />);
    await loaded();
    fireEvent.keyDown(window, { key: 'j' });
    await loaded('Latest Run');
    fireEvent.keyDown(window, { key: 'k' });
    await loaded('Older Run');
    fireEvent.keyDown(window, { key: 'o' });
    expect(
      await screen.findByText('Transcript could not be read.'),
    ).toBeTruthy();
    fireEvent.keyDown(window, { key: 's' });
    expect(document.activeElement).toBe(
      screen.getByLabelText('Steer this Run'),
    );
    const activeElement = document.activeElement;
    if (!activeElement) throw new Error('Expected a focused element');
    fireEvent.keyDown(activeElement, { key: 'u' });
    expect(window.location.pathname).toBe('/runs/r1');
    fireEvent.keyDown(window, { key: 'u' });
    expect(window.location.pathname).toBe('/');
    fireEvent.keyDown(window, { key: 'j', ctrlKey: true });
    expect(window.location.pathname).toBe('/');
  });

  it('focuses a Checkpoint Steer with s and submits it with modifier Enter', async () => {
    const mock = daemon();
    render(<App />);
    await loaded();
    fireEvent.keyDown(window, { key: 's' });
    const steer = screen.getByLabelText('Steer this checkpoint');
    expect(document.activeElement).toBe(steer);
    fireEvent.change(steer, {
      target: { value: 'Keep the evidence together.' },
    });
    fireEvent.keyDown(steer, { key: 'Enter', metaKey: true });
    await vi.waitFor(() =>
      expect(mock).toHaveBeenCalledWith(
        '/api/runs/r1/answer',
        expect.objectContaining({
          body: JSON.stringify({
            stepKey: '0',
            generation: 'g1',
            answer: {
              decision: 'steer',
              message: 'Keep the evidence together.',
            },
          }),
        }),
      ),
    );
  });

  it('renders durable Steer intake and delivery activity in the thread', async () => {
    const running = { ...r1, status: 'running' as const };
    daemon({
      runs: [running],
      detail: () => ({
        body: detail(running, {
          checkpoint: undefined,
          steers: [
            {
              requestId: 'receipt-1',
              message: 'Keep the evidence together.',
              receivedAt: '2026-09-07T12:00:00Z',
              state: 'held',
            },
            {
              requestId: 'receipt-2',
              message: 'Check the mobile layout too.',
              receivedAt: '2026-09-07T12:01:00Z',
              state: 'delivered',
              targets: [{ stepKey: 'ui-inspector', delivered: true }],
            },
          ],
        }),
      }),
    });
    render(<App />);
    await loaded();
    expect(screen.getByLabelText('Steer activity')).toBeTruthy();
    expect(screen.getByText('Keep the evidence together.')).toBeTruthy();
    expect(
      screen.getByText(/held for the next Agent conversation/),
    ).toBeTruthy();
    expect(screen.getByText(/delivered to ui-inspector/)).toBeTruthy();
  });

  it('submits canonical triggers, clears success, and presents a named refusal', async () => {
    let refused = false;
    const mock = daemon({
      trigger: () =>
        refused
          ? {
              ok: false,
              status: 409,
              body: {
                code: 'trigger-refused',
                error: 'NG-612 already has Run r1',
              },
            }
          : { body: { runId: 'r3' } },
    });
    window.history.replaceState({}, '', '/');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'New run' }));
    let issue = screen.getByLabelText('Trigger issue');
    fireEvent.change(issue, { target: { value: 'NG-612' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start run' }));
    await vi.waitFor(() => expect(window.location.pathname).toBe('/runs/r3'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mock).toHaveBeenCalledWith(
      '/api/triggers',
      expect.objectContaining({
        body: JSON.stringify({
          trigger: 'address-pr-conversations',
          issue: 'NG-612',
        }),
      }),
    );
    refused = true;
    fireEvent.click(screen.getByRole('button', { name: 'Rocky home' }));
    fireEvent.click(screen.getByRole('button', { name: 'New run' }));
    issue = screen.getByLabelText('Trigger issue');
    expect((issue as HTMLInputElement).value).toBe('');
    fireEvent.change(issue, { target: { value: 'NG-612' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start run' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'NG-612 already has Run r1',
    );
    expect((issue as HTMLInputElement).value).toBe('NG-612');
  });

  it('renders run history, result variants, artifacts, usage, terminal controls, and direct step hashes', async () => {
    window.history.replaceState({}, '', '/runs/r1#step=2');
    const finished = {
      ...r1,
      status: 'finished' as const,
      artifactsPruned: true,
    };
    const complex = detail(finished, {
      checkpoint: {
        stepKey: '0',
        generation: 'g1',
        title: 'Done',
        body: 'Done',
        answer: { decision: 'reject', reason: 'not now' },
      },
      usage: {
        reported: { cacheReadTokens: 3, cacheCreationTokens: 4, usd: 0 },
        missing: {
          inputTokens: 2,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          usd: 0,
        },
      },
      steps: [
        agent({
          key: '0',
          boot: 1,
          completedBeforeCurrentBoot: true,
          startedAt: '2026-09-01T12:00:00Z',
          stage: 'review',
          ms: 0,
          parentKey: 'root',
          result: 'A plain result',
          screenshots: [{ id: `s_${'a'.repeat(32)}`, caption: 'proof' }],
        }),
        agent({
          key: '1',
          seq: 1,
          boot: 2,
          result: {
            summary: 'Plan',
            steps: ['one', { two: 2 }],
            ci: 'skipped',
            results: { tests: 'ok' },
          },
          error: { name: 'Boom', message: 'bad result' },
          attempts: [
            {
              kind: 'failed',
              startedAt: 'now',
              ms: 5,
              note: 'retry',
              error: { name: 'Error', message: 'no' },
            },
          ],
        }),
        agent({
          key: '2',
          seq: 2,
          label: 'No result',
          result: undefined,
          transcript: 'pruned',
          usage: undefined,
        }),
      ],
    });
    daemon({ detail: () => ({ body: complex }) });
    render(<App />);
    await loaded('Older Run');
    expect(screen.getByText(/Answered: reject/)).toBeTruthy();
    expect(screen.getByText(/3 cache read/)).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: /agent/ })[0]);
    fireEvent.click(screen.getAllByRole('button', { name: /agent/ })[1]);
    expect(screen.getByText('A plain result')).toBeTruthy();
    expect(screen.getByText('review')).toBeTruthy();

    expect(screen.getAllByText(/0s/)[0]).toBeTruthy();
    expect(screen.getByText('Plan')).toBeTruthy();
    expect(screen.getByText('Results')).toBeTruthy();
    expect(screen.getByText(/Boom:/)).toBeTruthy();
    expect(
      screen
        .getByRole('img', { name: 'proof' })
        .closest('a')
        ?.getAttribute('href'),
    ).toBe(`/api/screenshots/s_${'a'.repeat(32)}`);
    expect(
      (screen.getByRole('button', { name: /No result/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(
      screen.getByText(/finished; its Steer intake is closed/),
    ).toBeTruthy();
    await act(async () => {
      dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(
      screen
        .getByRole('button', { name: /No result/ })
        .getAttribute('aria-expanded'),
    ).toBe('true');
  });

  it('owns transcript streams per fold and handles data, duplicates, settled, unavailable, error, construction failure, and unmount', async () => {
    const sources: FakeSource[] = [];
    const close = vi.fn();
    class FakeSource {
      handlers = new Map<string, (event: Event) => void>();
      onerror: (() => void) | null = null;
      constructor(public url: string) {
        sources.push(this);
        if (url.includes('/steps/2/transcript')) throw new Error('blocked');
      }
      addEventListener(name: string, handler: (event: Event) => void) {
        this.handlers.set(name, handler);
      }
      close = close;
    }
    vi.stubGlobal('EventSource', FakeSource);
    daemon({
      detail: () => ({
        body: detail(r1, {
          steps: [
            agent({ key: '0', status: 'running' }),
            agent({ key: '1', seq: 1, status: 'done', transcript: 'pending' }),
            agent({ key: '2', seq: 2 }),
          ],
        }),
      }),
    });
    const view = render(<App />);
    await loaded();
    fireEvent.click(screen.getAllByRole('button', { name: /agent/ })[0]);
    const first = sources[0];
    await act(async () => {
      first.handlers.get('transcript')?.({ data: '{bad' } as MessageEvent);
    });
    expect(screen.getByText('Transcript could not be read.')).toBeTruthy();
    await act(async () => {
      first.handlers.get('transcript')?.({
        data: JSON.stringify({ text: 'hello', offset: 1 }),
      } as MessageEvent);
    });
    expect(screen.getByText('hello')).toBeTruthy();
    await act(async () => {
      first.handlers.get('transcript')?.({
        data: JSON.stringify({ text: 'ignored', offset: 1 }),
      } as MessageEvent);
    });
    expect(screen.queryByText('ignored')).toBeNull();
    await act(async () => {
      first.handlers.get('settled')?.(new Event('settled'));
    });
    expect(close).toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole('button', { name: /agent/ })[0]);
    const stepButton = (key: string) => {
      const step = document.getElementById(`step=${key}`);
      const button = step?.querySelector('button');
      if (!button) throw new Error(`Expected a button for step ${key}`);
      return button;
    };
    fireEvent.click(stepButton('1'));
    const second = sources.find((x) => x.url.includes('/steps/1/transcript'));
    if (!second) throw new Error('Expected a transcript stream for step 1');
    await act(async () => {
      second.handlers.get('unavailable')?.(new Event('unavailable'));
    });
    expect(screen.getByText('Transcript is unavailable.')).toBeTruthy();
    fireEvent.click(stepButton('2'));
    expect(screen.getByText('Transcript could not be read.')).toBeTruthy();
    view.unmount();
    expect(close).toHaveBeenCalled();
  });

  it('edits all settings fields, retains revisions between saves, exposes MCP status, and reports settings failures', async () => {
    window.history.replaceState({}, '', '/settings');
    let saves = 0;
    const mock = daemon({
      settings: (init) =>
        init?.method === 'PATCH'
          ? ++saves === 1
            ? {
                body: settings({
                  revision: 'new',
                  restartRequired: true,
                  values: {
                    ...settings().values,
                    server: { host: 'localhost', port: 7630 },
                  },
                }),
              }
            : {
                ok: false,
                status: 500,
                body: { error: 'write denied', code: 'forbidden' },
              }
          : { body: settings() },
    });
    render(<App />);
    const host = await screen.findByLabelText('Bind host');
    fireEvent.change(host, { target: { value: 'localhost' } });
    fireEvent.change(screen.getByLabelText('Bind port'), {
      target: { value: '7630' },
    });
    fireEvent.change(screen.getByLabelText('Retention: terminal Runs'), {
      target: { value: '2' },
    });
    fireEvent.change(
      screen.getByLabelText('Retention: sessions & screenshots'),
      { target: { value: '3' } },
    );
    fireEvent.change(screen.getByLabelText('Maximum concurrent Runs'), {
      target: { value: '4' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await screen.findByText(/Restart Rocky/);
    expect(mock).toHaveBeenCalledWith(
      '/api/settings',
      expect.objectContaining({
        body: expect.stringContaining('"revision":"old"'),
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Settings were not saved. write denied',
    );
    expect(await screen.findByText('Linear connected')).toBeTruthy();
    cleanup();
    window.history.replaceState({}, '', '/settings');
    daemon({
      settings: () => ({ body: settings({ mcpAvailable: false, mcp: [] }) }),
    });
    render(<App />);
    expect(
      await screen.findByText('Create a profile before adding MCP servers.'),
    ).toBeTruthy();
  });

  it('edits and saves a local OpenCode workflow profile', async () => {
    window.history.replaceState({}, '', '/profiles');
    const mock = daemon({
      profiles: (init) =>
        init?.method === 'PUT'
          ? {
              body: {
                id: 'service',
                remote: 'github.com/acme/service',
                revision: 'new',
                workflow: {
                  source: 'export default [changed];',
                  triggers: ['custom-workflow'],
                },
                grants: { harness: 'opencode', capabilities: [], mcp: [] },
                prompts: ['planner'],
                rules: [],
                secretEnv: ['TOKEN'],
              },
            }
          : {
              body: {
                profiles: [
                  {
                    id: 'service',
                    remote: 'github.com/acme/service',
                    revision: 'old',
                    workflow: {
                      source: 'export default [];',
                      triggers: ['custom-workflow'],
                    },
                    grants: { harness: 'opencode', capabilities: [], mcp: [] },
                    prompts: ['planner'],
                    rules: [],
                    secretEnv: ['TOKEN'],
                  },
                ],
              },
            },
    });
    render(<App />);
    await screen.findByRole('button', { name: 'Workflow' });
    fireEvent.click(screen.getByRole('button', { name: 'Workflow' }));
    fireEvent.click(screen.getByText('Edit workflow in browser'));
    const source = await screen.findByLabelText('workflow.ts');
    fireEvent.change(source, {
      target: { value: 'export default [changed];' },
    });
    expect(screen.getByDisplayValue('OpenCode')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    expect(await screen.findByText(/Prompts: planner/)).toBeTruthy();
    expect(mock).toHaveBeenCalledWith(
      '/api/profiles',
      expect.objectContaining({
        method: 'PUT',
        body: expect.stringContaining('"harness":"opencode"'),
      }),
    );
  });

  it('opens only the selected repository workflow in a chosen local editor', async () => {
    window.history.replaceState({}, '', '/profiles');
    const mock = daemon({
      profiles: () => ({
        body: {
          profiles: [
            {
              id: 'service',
              remote: 'github.com/acme/service',
              revision: 'old',
              workflow: { source: 'export default [];', triggers: [] },
              grants: { harness: 'opencode', capabilities: [], mcp: [] },
              prompts: [],
              rules: [],
              secretEnv: [],
            },
          ],
        },
      }),
    });
    render(<App />);
    await screen.findByRole('heading', { name: 'service' });
    fireEvent.click(screen.getByRole('button', { name: 'Workflow' }));
    expect(
      Array.from(
        (screen.getByLabelText('Workflow editor') as HTMLSelectElement).options,
        (option) => option.value,
      ),
    ).toEqual(['default', 'vscode', 'zed']);
    fireEvent.change(screen.getByLabelText('Workflow editor'), {
      target: { value: 'zed' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open workflow' }));
    expect(mock).toHaveBeenCalledWith(
      '/api/profiles/service/open-workflow',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ editor: 'zed' }),
      }),
    );
    expect(
      await screen.findByText('Workflow sent to your editor.'),
    ).toBeTruthy();
  });

  it('shows editor launch failures beside the action and lets the user choose another editor and retry', async () => {
    window.history.replaceState({}, '', '/profiles');
    let failing = true;
    const mock = daemon({
      profiles: () => ({
        body: {
          profiles: [
            {
              id: 'service',
              remote: 'github.com/acme/service',
              revision: 'old',
              workflow: { source: 'export default [];', triggers: [] },
              grants: { harness: 'opencode', capabilities: [], mcp: [] },
              prompts: [],
              rules: [],
              secretEnv: [],
            },
          ],
        },
      }),
      openWorkflow: () =>
        failing
          ? {
              ok: false,
              status: 503,
              body: {
                code: 'editor-unavailable',
                error: 'The selected editor is not installed.',
              },
            }
          : { body: { opened: true } },
    });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Workflow' }));
    const open = screen.getByRole('button', { name: 'Open workflow' });
    fireEvent.click(open);
    expect(
      (screen.getByRole('button', { name: 'Opening…' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(open);
    expect(
      mock.mock.calls.filter(([path]) =>
        String(path).endsWith('/open-workflow'),
      ),
    ).toHaveLength(1);
    expect((await screen.findByRole('alert')).textContent).toContain(
      'The selected editor is not installed.',
    );
    expect(screen.queryByText('Workflow sent to your editor.')).toBeNull();
    failing = false;
    fireEvent.change(screen.getByLabelText('Workflow editor'), {
      target: { value: 'vscode' },
    });
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open workflow' }));
    await screen.findByText('Workflow sent to your editor.');
    fireEvent.change(screen.getByLabelText('Workflow editor'), {
      target: { value: 'default' },
    });
    expect(screen.queryByText('Workflow sent to your editor.')).toBeNull();
  });
});

describe('Workspace redesign', () => {
  it('opens to a searchable, paginated overview without loading an unselected journal', async () => {
    window.history.replaceState({}, '', '/');
    const runs = Array.from({ length: 13 }, (_, index): RunSummary => ({
      ...r1,
      runId: `run-${index}`,
      repo: index % 2 ? 'service' : 'rocky',
      issue: {
        ...r1.issue,
        identifier: `NG-${index}`,
        title: `Work item ${index}`,
      },
      status:
        index === 0
          ? 'parked'
          : index === 1
            ? 'running'
            : index === 2
              ? 'finished'
              : index === 3
                ? 'cancelled'
                : 'failed',
    }));
    const mock = daemon({
      runs,
      detail: (id) => ({ body: detail(runs.find((run) => run.runId === id)) }),
    });
    render(<App />);
    const table = await screen.findByRole('table', { name: 'Runs' });
    expect(within(table).getAllByRole('row')).toHaveLength(11);
    expect(
      mock.mock.calls.some(([path]) => String(path).startsWith('/api/runs/')),
    ).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(within(table).getAllByRole('row')).toHaveLength(4);
    expect(screen.getByText('11–13 of 13 runs')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Previous page' }));
    fireEvent.click(screen.getByRole('button', { name: 'In progress 1' }));
    expect(within(table).getByText('Work item 1')).toBeTruthy();
    expect(within(table).queryByText('Work item 0')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Needs review 1' }));
    expect(within(table).getByText('Work item 0')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Completed 1' }));
    expect(within(table).getByText('Work item 2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Failed 9' }));
    expect(within(table).getAllByRole('row')).toHaveLength(10);
    fireEvent.change(screen.getByLabelText('Filter by repository'), {
      target: { value: 'service' },
    });
    fireEvent.change(screen.getByLabelText('Search runs'), {
      target: { value: 'Work item 5' },
    });
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    fireEvent.change(screen.getByLabelText('Search runs'), {
      target: { value: 'missing' },
    });
    expect(
      screen.getByRole('heading', { name: 'No matching runs' }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(screen.getByText('1–10 of 13 runs')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open run run-1' }));
    await loaded('Work item 1');
    fireEvent.click(screen.getByRole('button', { name: 'All runs' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'NG-0 / run-0 Work item 0' }),
    );
    await loaded('Work item 0');
    fireEvent.click(screen.getByRole('button', { name: 'All runs' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    const content = screen.getByRole('main');
    fireEvent.scroll(content, { target: { scrollTop: 200 } });
    fireEvent.click(screen.getByRole('button', { name: 'Open run run-12' }));
    await loaded('Work item 12');
    expect(content.scrollTop).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'All runs' }));
    expect(screen.getByText('11–13 of 13 runs')).toBeTruthy();
    expect(content.scrollTop).toBe(200);
  });

  it('keeps modal focus contained, restores focus on close, and ignores run shortcuts while composing', async () => {
    window.history.replaceState({}, '', '/');
    const mock = daemon();
    render(<App />);
    const start = await screen.findByRole('button', { name: 'New run' });
    start.focus();
    fireEvent.click(start);
    const dialog = screen.getByRole('dialog', { name: 'Start a new run' });
    const issue = within(dialog).getByLabelText('Trigger issue');
    expect(document.activeElement).toBe(issue);
    fireEvent.change(issue, { target: { value: 'NG-612' } });
    fireEvent.change(screen.getByLabelText('Trigger name'), {
      target: { value: 'custom-workflow' },
    });
    const submit = within(dialog).getByRole('button', { name: 'Start run' });
    submit.focus();
    fireEvent.keyDown(submit, { key: 'Tab' });
    expect(document.activeElement).toBe(
      within(dialog).getByRole('button', { name: 'Close start a new run' }),
    );
    fireEvent.keyDown(
      within(dialog).getByRole('button', { name: 'Close start a new run' }),
      { key: 'Tab', shiftKey: true },
    );
    expect(document.activeElement).toBe(submit);
    fireEvent.keyDown(window, { key: 'e' });
    expect(
      mock.mock.calls.some(([path]) => String(path).endsWith('/answer')),
    ).toBe(false);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(start);
    fireEvent.click(start);
    expect(
      (screen.getByLabelText('Trigger issue') as HTMLInputElement).value,
    ).toBe('NG-612');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(start);
    fireEvent.click(
      screen.getByRole('button', { name: 'Close start a new run' }),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens the first-run action from an empty workspace and navigates the main sections', async () => {
    window.history.replaceState({}, '', '/');
    daemon({ runs: [] });
    render(<App />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Start your first run' }),
    );
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Profiles' }));
    expect(
      await screen.findByRole('heading', {
        name: 'Create your first profile',
      }),
    ).toBeTruthy();
    fireEvent.click(
      within(
        screen.getByRole('navigation', { name: 'Main navigation' }),
      ).getByRole('button', { name: 'Settings' }),
    );
    await screen.findByLabelText('Bind host');
    fireEvent.click(
      within(
        screen.getByRole('navigation', { name: 'Main navigation' }),
      ).getByRole('button', { name: /Runs/ }),
    );
    expect(
      screen.getByRole('heading', { name: 'Ready when you are.' }),
    ).toBeTruthy();
  });

  it('finds a multi-repository run by any member and shows all members in its detail', async () => {
    window.history.replaceState({}, '', '/');
    const run = { ...r1, repos: ['rocky', 'api'], profileId: 'product' };
    daemon({ runs: [run], detail: () => ({ body: detail(run) }) });
    render(<App />);
    await screen.findByRole('button', { name: 'Open run r1' });
    fireEvent.change(screen.getByLabelText('Filter by repository'), {
      target: { value: 'api' },
    });
    expect(screen.getByRole('button', { name: 'Open run r1' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open run r1' }));
    await loaded();
    expect(screen.getByText('rocky, api')).toBeTruthy();
  });

  it('starts a run with an explicitly selected multi-repository profile', async () => {
    window.history.replaceState({}, '', '/');
    const mock = daemon({
      profiles: () => ({
        body: {
          profiles: [
            {
              id: 'product',
              remote: 'github.com/acme/web',
              repos: [
                {
                  name: 'web',
                  url: 'https://github.com/acme/web',
                  baseBranch: 'main',
                },
                {
                  name: 'api',
                  url: 'https://github.com/acme/api',
                  baseBranch: 'develop',
                },
              ],
              workflow: {
                source: 'export default [];',
                triggers: ['edit-both'],
              },
              grants: { harness: 'opencode', capabilities: [], mcp: [] },
              prompts: [],
              rules: [],
              secretEnv: [],
              revision: 'v1',
            },
          ],
        },
      }),
    });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'New run' }));
    await screen.findByRole('option', { name: 'product · 2 repositories' });
    fireEvent.change(screen.getByLabelText('Run profile'), {
      target: { value: 'product' },
    });
    fireEvent.change(screen.getByLabelText('Trigger issue'), {
      target: { value: 'NG-612' },
    });
    fireEvent.change(screen.getByLabelText('Trigger name'), {
      target: { value: 'edit-both' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start run' }));
    await waitFor(() =>
      expect(mock).toHaveBeenCalledWith(
        '/api/triggers',
        expect.objectContaining({
          body: JSON.stringify({
            trigger: 'edit-both',
            issue: 'NG-612',
            profileId: 'product',
          }),
        }),
      ),
    );
  });

  it('loads the configured default before creating a draft and lets a failed load be retried', async () => {
    window.history.replaceState({}, '', '/profiles');
    let fail = true;
    daemon({
      profileDefaults: () =>
        fail
          ? {
              ok: false,
              status: 503,
              body: { error: 'Default workflow unavailable' },
            }
          : {
              body: {
                workflow: {
                  source:
                    "const agent = { harness: 'claude-code', model: 'configured-model' }; export default [workflow];",
                  triggers: ['linear.onDelegate', 'address-pr-conversations'],
                },
                grants: { harness: 'claude-code', capabilities: [], mcp: [] },
                prompts: ['planner', 'implementer'],
                rules: [],
                secretEnv: ['GITHUB_TOKEN'],
              },
            },
    });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add profile' }));
    expect(
      (
        screen.getByRole('button', {
          name: 'Loading workflow…',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    await screen.findByText(/Default workflow unavailable/);
    expect(screen.queryByRole('heading', { name: 'New profile' })).toBeNull();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Add profile' }));
    await screen.findByRole('heading', { name: 'New profile' });
    expect((screen.getByLabelText('Harness') as HTMLSelectElement).value).toBe(
      'claude-code',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Workflow' }));
    expect(
      (screen.getByLabelText('Workflow source') as HTMLTextAreaElement).value,
    ).toContain('configured-model');
    expect(
      (
        screen.getByLabelText(
          'Manual triggers (one per line)',
        ) as HTMLTextAreaElement
      ).value,
    ).toContain('address-pr-conversations');
    expect(screen.getByText(/Configuration files · 2 prompts/)).toBeTruthy();
  });

  it('creates, edits, switches, and removes repository profiles including the last profile', async () => {
    window.history.replaceState({}, '', '/profiles');
    let stored: import('@rocky/local-contracts').RepositoryProfileView[] = [];
    const mock = daemon({
      profiles: (init) => {
        if (init?.method === 'PUT') {
          const body = JSON.parse(String(init.body));
          const saved = {
            ...body,
            revision: 'saved',
            prompts: [],
            rules: [],
            secretEnv: [],
          };
          stored = [...stored.filter((p) => p.id !== saved.id), saved];
          return { body: saved };
        }
        if (init?.method === 'DELETE') {
          const body = JSON.parse(String(init.body));
          stored = stored.filter((p) => p.id !== body.id);
          return { body: {} };
        }
        return { body: { profiles: stored } };
      },
    });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add profile' }));
    await screen.findByRole('heading', { name: 'New profile' });
    expect(
      (
        screen.getByRole('button', {
          name: 'Save profile',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.change(screen.getByLabelText('Profile id'), {
      target: { value: 'service' },
    });
    fireEvent.change(screen.getByLabelText('Folder name 1'), {
      target: { value: 'service' },
    });
    fireEvent.change(screen.getByLabelText('Remote URL 1'), {
      target: { value: 'github.com/acme/service' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add repository' }));
    expect(
      (
        screen.getByRole('button', {
          name: 'Save profile',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.change(screen.getByLabelText('Folder name 2'), {
      target: { value: 'api' },
    });
    fireEvent.change(screen.getByLabelText('Remote URL 2'), {
      target: { value: 'git@github.com:acme/api.git' },
    });
    fireEvent.change(screen.getByLabelText('Base branch 2'), {
      target: { value: 'develop' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Make primary' }));
    expect(
      (screen.getByLabelText('Folder name 1') as HTMLInputElement).value,
    ).toBe('api');
    fireEvent.click(screen.getByRole('button', { name: 'Add repository' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Remove repository 3' }),
    );
    fireEvent.change(screen.getByLabelText('Harness'), {
      target: { value: 'claude-code' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Workflow' }));
    fireEvent.change(screen.getByLabelText('Manual triggers (one per line)'), {
      target: { value: 'first\nsecond\n' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'General' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    await screen.findByText('Profile saved');
    expect(stored[0].workflow.triggers).toEqual(['first', 'second']);
    expect(stored[0].repos).toEqual([
      {
        name: 'api',
        url: 'git@github.com:acme/api.git',
        baseBranch: 'develop',
      },
      { name: 'service', url: 'github.com/acme/service', baseBranch: 'main' },
    ]);
    expect(stored[0].grants.harness).toBe('claude-code');
    expect(
      (screen.getByLabelText('Profile id') as HTMLInputElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Add profile' }));
    await screen.findByRole('heading', { name: 'New profile' });
    fireEvent.change(screen.getByLabelText('Profile id'), {
      target: { value: 'another' },
    });
    fireEvent.change(screen.getByLabelText('Folder name 1'), {
      target: { value: 'service' },
    });
    fireEvent.change(screen.getByLabelText('Remote URL 1'), {
      target: { value: 'github.com/acme/another' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    await screen.findByText('Profile saved');
    fireEvent.change(screen.getByLabelText('Profile', { exact: true }), {
      target: { value: 'service' },
    });
    expect(screen.getByRole('heading', { name: 'service' })).toBeTruthy();
    confirm.mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole('button', { name: 'Delete profile' }));
    expect(mock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(
      false,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delete profile' }));
    await screen.findByRole('heading', { name: 'another' });
    fireEvent.click(screen.getByRole('button', { name: 'Delete profile' }));
    await screen.findByRole('heading', {
      name: 'Create your first profile',
    });
    confirm.mockRestore();
  });

  it('edits a profile’s Linear label and optional team filter', async () => {
    window.history.replaceState({}, '', '/profiles');
    const profile = {
      id: 'service',
      remote: 'github.com/acme/service',
      repos: [
        { name: 'service', url: 'github.com/acme/service', baseBranch: 'main' },
      ],
      workflow: { source: 'export default [];', triggers: [] },
      grants: { harness: 'opencode' as const, capabilities: [], mcp: [] },
      prompts: [],
      rules: [],
      secretEnv: [],
      revision: 'profile-revision',
    };
    let route = {
      profileId: 'service',
      labels: ['service'],
      teams: [],
      revision: 'route-one',
    };
    const mock = daemon({
      profiles: () => ({ body: { profiles: [profile] } }),
      routing: (_path, init) => {
        if (init?.method === 'PUT') {
          const body = JSON.parse(String(init.body));
          route = {
            profileId: 'service',
            labels: body.labels,
            teams: body.teams,
            revision: 'route-two',
          };
        }
        return { body: route };
      },
    });
    render(<App />);
    await screen.findByRole('heading', { name: 'service' });
    expect(
      (
        (await screen.findByLabelText(
          'Linear labels (one per line)',
        )) as HTMLTextAreaElement
      ).value,
    ).toBe('service');
    fireEvent.change(screen.getByLabelText('Linear labels (one per line)'), {
      target: { value: 'service-work\nservice-bug' },
    });
    fireEvent.change(
      screen.getByLabelText('Allowed Linear teams (optional, one per line)'),
      { target: { value: 'Engineering\nPlatform\n' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save Linear route' }));
    await waitFor(() =>
      expect(route).toEqual({
        profileId: 'service',
        labels: ['service-work', 'service-bug'],
        teams: ['Engineering', 'Platform'],
        revision: 'route-two',
      }),
    );
    expect(mock).toHaveBeenCalledWith(
      '/api/profiles/service/routing',
      expect.objectContaining({ method: 'PUT' }),
    );
  });

  it('keeps results and large raw payloads folded until requested, including steps without transcripts', async () => {
    const summary = 'A useful result';
    daemon({
      detail: () => ({
        body: detail(
          {
            ...r1,
            boots: 1,
            status: 'finished',
            trigger: 'smoke',
            reason: 'All work complete',
            pr: { number: 7, url: 'https://example.com/pr/7', headSha: 'head' },
          },
          {
            checkpoint: undefined,
            steps: [
              agent({
                step: 'workspace',
                label: 'Prepare files',
                transcript: 'unavailable',
                result: { summary, output: 'x'.repeat(600) },
              }),
            ],
          },
        ),
      }),
    });
    render(<App />);
    await loaded();
    expect(screen.queryByText(summary)).toBeNull();
    expect(
      screen
        .getByRole('link', { name: 'Pull request #7' })
        .getAttribute('href'),
    ).toBe('https://example.com/pr/7');
    fireEvent.click(screen.getByRole('button', { name: /Prepare files/ }));
    expect(screen.getByText(summary)).toBeTruthy();
    const raw = screen.getByText('Raw result').closest('details');
    expect(raw?.open).toBe(false);
    fireEvent.click(screen.getByText('Raw result'));
    expect(raw?.open).toBe(true);
    expect(screen.queryByText('Loading transcript…')).toBeNull();
  });
});

it('puts a terminal failure above the journal and shows the processing profile and Agent configuration', async () => {
  const run = {
    ...r1,
    status: 'failed' as const,
    profileId: 'product-team',
    error: { name: 'Error', message: 'Checkpoint adapter was not connected.' },
  };
  daemon({
    runs: [run],
    detail: () => ({
      body: detail(run, {
        checkpoint: undefined,
        steps: [
          agent({
            status: 'done',
            ms: 60000,
            agent: {
              harness: 'opencode',
              model: 'openai/example',
              variant: 'high',
              tools: ['read'],
              mcp: ['playwright'],
              timeoutMs: 120000,
            },
          }),
        ],
      }),
    }),
  });
  window.history.replaceState({}, '', '/runs/r1');
  render(<App />);
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('Checkpoint adapter was not connected.');
  expect(screen.getByText('product-team')).toBeTruthy();
  fireEvent.click(
    screen.getByRole('button', { name: /opencode.*openai\/example/ }),
  );
  expect(await screen.findByText('Model variant / effort')).toBeTruthy();
  expect(screen.getByText('Started')).toBeTruthy();
});
it('shows a clarification answer form without an approval shortcut', async () => {
  const d = detail(r1, {
    checkpoint: {
      stepKey: '0',
      generation: 'q',
      kind: 'question',
      title: 'Which repository?',
      body: 'Name the repository to change.',
      options: ['App only', 'All repositories'],
    },
  });
  const fetch = daemon({ detail: () => ({ body: d }) });
  window.history.replaceState({}, '', '/runs/r1');
  render(<App />);
  expect(await screen.findByLabelText('Your answer')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull();
  fireEvent.keyDown(window, { key: 'e' });
  expect(fetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(
    false,
  );
  fireEvent.click(screen.getByRole('button', { name: 'App only' }));
  expect(
    (screen.getByLabelText('Your answer') as HTMLTextAreaElement).value,
  ).toBe('App only');
});
