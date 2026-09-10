import {
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import type {
  Answer,
  ApiError,
  DiffView,
  IntakeFailure,
  RunDetail,
  RunList,
  RepositoryProfileList,
  RepositoryProfileView,
  SettingsView,
  StepView,
  Usage,
} from '@rocky/local-contracts';
import { DiffViewer } from './diff-view.js';
import styles from './app.module.css';

const VERSION = __ROCKY_VERSION__;
const TAIL = 40_000;
type Route =
  | { page: 'inbox'; runId?: string; issueIdentifier?: string }
  | { page: 'settings' }
  | { page: 'profiles' };
type Health = {
  status: string;
  version: string;
  endpoint?: {
    configured: boolean;
    ok: boolean;
    checkedAt?: string;
    detail?: string;
  };
};

const route = (): Route => {
  const run = /^\/runs\/([^/]+)$/.exec(window.location.pathname);
  const issue = /^\/issues\/([^/]+)$/.exec(window.location.pathname);
  if (run) return { page: 'inbox', runId: decodeURIComponent(run[1]) };
  if (issue)
    return { page: 'inbox', issueIdentifier: decodeURIComponent(issue[1]) };
  return window.location.pathname === '/settings'
    ? { page: 'settings' }
    : window.location.pathname === '/profiles'
      ? { page: 'profiles' }
      : { page: 'inbox' };
};
const go = (path: string) => {
  window.history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
};
const typing = (target: EventTarget | null) =>
  target instanceof HTMLInputElement ||
  target instanceof HTMLTextAreaElement ||
  (target instanceof HTMLElement && target.isContentEditable);
const active = (status: string) => status === 'running' || status === 'queued';
const terminal = (status: string) =>
  status === 'finished' || status === 'failed' || status === 'cancelled';
const stepId = (runId: string, key: string) => `${runId}:${key}`;
const stepFragment = (key: string) => `step=${encodeURIComponent(key)}`;

async function api<T>(
  path: string,
  mismatch: (v: string | null) => void,
  init?: RequestInit,
): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set('x-rocky-client-version', VERSION);
  const response = await fetch(path, { ...init, headers });
  const version = response.headers.get('x-rocky-version');
  if (version && version !== VERSION) mismatch(version);
  if (!response.ok)
    throw Object.assign(new Error(`Request failed (${response.status})`), {
      response,
    });
  return response.json() as Promise<T>;
}
async function apiError(error: unknown, fallback: string) {
  const response = (error as { response?: Response }).response;
  if (!response) return fallback;
  try {
    const body = (await response.json()) as ApiError;
    return body.error ? `${fallback} ${body.error}` : fallback;
  } catch {
    return fallback;
  }
}
function usage(value: Usage, missing?: Record<string, number>) {
  const tokens = [value.inputTokens, value.outputTokens].filter(
    (x): x is number => x !== undefined,
  );
  const pieces = tokens.length
    ? [`${tokens.reduce((a, b) => a + b, 0).toLocaleString()} tokens`]
    : [];
  if (value.cacheReadTokens !== undefined)
    pieces.push(`${value.cacheReadTokens.toLocaleString()} cache read`);
  if (value.cacheCreationTokens !== undefined)
    pieces.push(`${value.cacheCreationTokens.toLocaleString()} cache write`);
  if (value.usd !== undefined) pieces.push(`$${value.usd.toFixed(4)} USD`);
  const absent = missing
    ? Object.values(missing).reduce((a, b) => a + b, 0)
    : 0;
  if (absent) pieces.push(`partial (${absent} missing)`);
  return pieces.length ? pieces.join(' · ') : 'Usage not reported';
}

export function App() {
  const [currentRoute, setRoute] = useState<Route>(route);
  const [runs, setRuns] = useState<RunList | null>(null);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [intakeFailures, setIntakeFailures] = useState<IntakeFailure[]>([]);
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [mismatch, setMismatch] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [diff, setDiff] = useState<DiffView | null>(null);
  const [diffId, setDiffId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [compose, setCompose] = useState('');
  const [focusedStep, setFocusedStep] = useState<string | null>(null);
  const [triggerIssue, setTriggerIssue] = useState('');
  const [triggerName, setTriggerName] = useState('address-pr-conversations');
  const composeRef = useRef<HTMLTextAreaElement>(null);
  const requestId = useRef<string | null>(null);
  const selectedId =
    currentRoute.page !== 'inbox'
      ? undefined
      : (currentRoute.runId ??
        (currentRoute.issueIdentifier
          ? runs?.runs.find(
              (run) => run.issue.identifier === currentRoute.issueIdentifier,
            )?.runId
          : runs?.runs[0]?.runId));
  const selectedDetail = detail?.run.runId === selectedId ? detail : null;
  const selectedRunId = selectedDetail?.run.runId;
  const selectedRevision = selectedDetail?.revision;
  const mutationsAllowed = !mismatch;
  const refreshDetail = useCallback(
    async (id = selectedId) => {
      if (!id) return;
      const next = await api<RunDetail>(
        `/api/runs/${encodeURIComponent(id)}`,
        setMismatch,
      );
      if (next.run.runId === id) setDetail(next);
    },
    [selectedId],
  );
  const submitAnswer = useCallback(
    async (answer: Answer) => {
      if (
        !selectedDetail?.checkpoint ||
        selectedDetail.checkpoint.answer ||
        !mutationsAllowed ||
        !selectedDetail.controls.answer
      )
        return;
      setError(null);
      try {
        await api(
          `/api/runs/${encodeURIComponent(selectedDetail.run.runId)}/answer`,
          setMismatch,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              stepKey: selectedDetail.checkpoint.stepKey,
              generation: selectedDetail.checkpoint.generation,
              answer,
            }),
          },
        );
        setCompose('');
        requestId.current = null;
        await refreshDetail(selectedDetail.run.runId);
      } catch (caught) {
        const response = (caught as { response?: Response }).response;
        if (response?.status === 409) {
          const conflict = (await response.json()) as ApiError;
          setError(
            `This Checkpoint was already answered${conflict.answer ? `: ${conflict.answer.decision}.` : '.'}`,
          );
          if (conflict.answer)
            setDetail((current) =>
              current?.run.runId === selectedDetail.run.runId &&
              current.checkpoint
                ? {
                    ...current,
                    checkpoint: {
                      ...current.checkpoint,
                      answer: conflict.answer,
                    },
                  }
                : current,
            );
        } else setError(await apiError(caught, 'Answer was not saved.'));
      }
    },
    [mutationsAllowed, refreshDetail, selectedDetail],
  );
  const revealStep = useCallback(() => {
    const key = new URLSearchParams(window.location.hash.slice(1)).get('step');
    if (
      selectedDetail &&
      key &&
      selectedDetail.steps.some((step) => step.key === key)
    )
      setExpanded((current) => {
        const id = stepId(selectedDetail.run.runId, key);
        return current[id] ? current : { ...current, [id]: true };
      });
  }, [selectedDetail]);

  useEffect(() => {
    const listener = () => setRoute(route());
    window.addEventListener('popstate', listener);
    return () => window.removeEventListener('popstate', listener);
  }, []);
  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      try {
        const next = await api<Health>('/api/health', setMismatch);
        if (!stopped) {
          setHealth(next);
          setUnreachable(false);
        }
      } catch {
        if (!stopped) setUnreachable(true);
      }
    };
    void poll();
    const timer = setInterval(() => {
      void poll();
    }, 30_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      try {
        const failures = await api<IntakeFailure[]>(
          '/api/intake-failures',
          setMismatch,
        );
        if (!stopped) setIntakeFailures(failures);
      } catch {
        // A daemon from before this endpoint is still usable; its health
        // response supplies the version-mismatch warning where applicable.
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 30_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const list = await api<RunList>('/api/runs', setMismatch);
        if (stopped) return;
        setRuns(list);
        setUnreachable(false);
        timer = setTimeout(poll, list.pollAfterMs);
      } catch {
        if (!stopped) {
          setUnreachable(true);
          timer = setTimeout(poll, 30_000);
        }
      }
    };
    void poll();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, []);
  useEffect(() => {
    setDetail(null);
    setError(null);
    setCompose('');
    requestId.current = null;
    setFocusedStep(null);
    setDiff(null);
    setDiffId(null);
    if (!selectedId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const next = await api<RunDetail>(
          `/api/runs/${encodeURIComponent(selectedId)}`,
          setMismatch,
        );
        if (stopped || next.run.runId !== selectedId) return;
        setDetail(next);
        setUnreachable(false);
        timer = setTimeout(poll, active(next.run.status) ? 2_000 : 30_000);
      } catch {
        if (!stopped) {
          setError('Could not load this Run.');
          timer = setTimeout(poll, 30_000);
        }
      }
    };
    void poll();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [selectedId]);
  useEffect(() => {
    if (!selectedRunId || !diffId) return;
    let cancelled = false;
    api<DiffView>(
      `/api/runs/${encodeURIComponent(selectedRunId)}/diffs/${encodeURIComponent(diffId)}`,
      setMismatch,
    )
      .then((next) => {
        if (!cancelled) setDiff(next);
      })
      .catch(() => !cancelled && setError('Could not load diff.'));
    return () => {
      cancelled = true;
    };
  }, [diffId, selectedRevision, selectedRunId]);
  useEffect(() => {
    if (currentRoute.page !== 'settings') return;
    let cancelled = false;
    api<SettingsView>('/api/settings', setMismatch)
      .then((next) => !cancelled && setSettings(next))
      .catch(() => !cancelled && setError('Could not load settings.'));
    return () => {
      cancelled = true;
    };
  }, [currentRoute.page]);
  useEffect(() => {
    revealStep();
    window.addEventListener('hashchange', revealStep);
    return () => window.removeEventListener('hashchange', revealStep);
  }, [revealStep]);
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (
        currentRoute.page !== 'inbox' ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        typing(event.target) ||
        diff
      )
        return;
      const list = runs?.runs ?? [];
      const index = list.findIndex((run) => run.runId === selectedId);
      if (event.key === 'j' || event.key === 'k') {
        const next = list[index + (event.key === 'j' ? 1 : -1)];
        if (next) {
          event.preventDefault();
          go(`/runs/${encodeURIComponent(next.runId)}`);
        }
      } else if (event.key === 'u') {
        event.preventDefault();
        go('/');
      } else if (
        event.key === 's' &&
        ((selectedDetail?.checkpoint &&
          !selectedDetail.checkpoint.answer &&
          selectedDetail.controls.answer) ||
          selectedDetail?.controls.steer) &&
        mutationsAllowed
      ) {
        event.preventDefault();
        composeRef.current?.focus();
      } else if (event.key === 'o') {
        const step =
          selectedDetail?.steps.find((x) => x.key === focusedStep) ??
          selectedDetail?.steps.find((x) =>
            x.step.toLowerCase().includes('agent'),
          );
        if (step && selectedDetail) {
          event.preventDefault();
          const id = stepId(selectedDetail.run.runId, step.key);
          setExpanded((x) => ({ ...x, [id]: !x[id] }));
        }
      } else if (
        event.key === 'e' &&
        selectedDetail?.checkpoint &&
        !selectedDetail.checkpoint.answer &&
        selectedDetail.controls.answer &&
        mutationsAllowed
      ) {
        event.preventDefault();
        void submitAnswer({ decision: 'approve' });
      } else if (
        event.key === 'r' &&
        selectedDetail?.checkpoint &&
        !selectedDetail.checkpoint.answer &&
        selectedDetail.controls.answer &&
        mutationsAllowed
      ) {
        event.preventDefault();
        void submitAnswer({ decision: 'reject' });
      }
    };
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  }, [
    currentRoute.page,
    diff,
    focusedStep,
    mutationsAllowed,
    runs,
    selectedDetail,
    selectedId,
    submitAnswer,
  ]);
  const changeCompose = (value: string) => {
    if (requestId.current && value !== compose) requestId.current = null;
    setCompose(value);
  };
  const submitSteer = async (event: FormEvent) => {
    event.preventDefault();
    if (
      !selectedDetail ||
      !compose.trim() ||
      !selectedDetail.controls.steer ||
      terminal(selectedDetail.run.status) ||
      !mutationsAllowed
    )
      return;
    const id = requestId.current ?? crypto.randomUUID();
    requestId.current = id;
    setError(null);
    try {
      await api(
        `/api/runs/${encodeURIComponent(selectedDetail.run.runId)}/steer`,
        setMismatch,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ requestId: id, message: compose }),
        },
      );
      setCompose('');
      requestId.current = null;
      await refreshDetail(selectedDetail.run.runId);
    } catch (caught) {
      setError(
        await apiError(
          caught,
          'Steer was not received. Your text is preserved for retry.',
        ),
      );
    }
  };
  const recoverSession = async (runId: string) => {
    setError(null);
    try {
      const result = await api<{
        issueIdentifier: string;
        sessionId: string;
      }>(
        `/api/runs/${encodeURIComponent(runId)}/recover-session`,
        setMismatch,
        { method: 'POST' },
      );
      setError(
        `Released the stale Linear session for ${result.issueIdentifier}. Delegate Rocky again in Linear to start a fresh Run.`,
      );
      await refreshDetail(runId);
    } catch (caught) {
      setError(
        await apiError(
          caught,
          'Could not release this Linear session for re-delegation.',
        ),
      );
    }
  };
  const fireTrigger = async (event: FormEvent) => {
    event.preventDefault();
    if (!triggerIssue.trim() || !triggerName.trim() || !mutationsAllowed)
      return;
    setError(null);
    try {
      await api('/api/triggers', setMismatch, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ trigger: triggerName, issue: triggerIssue }),
      });
      setTriggerIssue('');
    } catch (caught) {
      setError(await apiError(caught, 'Trigger was not admitted.'));
    }
  };

  if (unreachable && !runs)
    return (
      <main className={styles.empty}>
        <h1>Rocky</h1>
        <p>
          No daemon answering. Run <code>rocky start</code>.
        </p>
      </main>
    );
  return (
    <main className={styles.app}>
      <aside className={styles.inbox} aria-label="Runs inbox">
        <header>
          <div>
            <strong>Rocky</strong>
            <span>Inbox</span>
          </div>
          <button onClick={() => go('/settings')}>Settings</button>
          <button onClick={() => go('/profiles')}>Profiles</button>
        </header>
        <nav aria-label="Runs">
          <ul className={styles.runList}>
            {runs?.runs.map((run) => (
              <li key={run.runId}>
                <button
                  className={run.runId === selectedId ? styles.selected : ''}
                  onClick={() => go(`/runs/${encodeURIComponent(run.runId)}`)}
                >
                  <span className={`${styles.dot} ${styles[run.status]}`} />
                  <strong>{run.issue.identifier}</strong>
                  <small>
                    {run.status === 'parked' ? 'Needs attention' : run.status}
                  </small>
                  <b>{run.issue.title}</b>
                  <em>
                    {run.repo} · {run.branch}
                  </em>
                </button>
              </li>
            ))}
            {!runs?.runs.length && (
              <li>
                <p className={styles.muted}>No Runs yet.</p>
              </li>
            )}
          </ul>
        </nav>
        <form className={styles.trigger} onSubmit={fireTrigger}>
          <label>
            Issue
            <input
              aria-label="Trigger issue"
              value={triggerIssue}
              onChange={(event) => setTriggerIssue(event.target.value)}
              placeholder="NG-612"
              disabled={!mutationsAllowed}
            />
          </label>
          <label>
            Trigger
            <input
              aria-label="Trigger name"
              value={triggerName}
              onChange={(event) => setTriggerName(event.target.value)}
              disabled={!mutationsAllowed}
            />
          </label>
          <button
            disabled={
              !mutationsAllowed || !triggerIssue.trim() || !triggerName.trim()
            }
          >
            Trigger
          </button>
        </form>
      </aside>
      <section className={styles.content}>
        {mismatch && (
          <p className={styles.warning} role="alert">
            This web UI expects daemon {VERSION}, but reached {mismatch}.
            Mutating controls are disabled.
          </p>
        )}
        {unreachable && (
          <p className={styles.warning} role="status">
            The daemon is temporarily unreachable; showing the last known state.
          </p>
        )}
        {health?.endpoint?.configured && (
          <p
            className={
              health.endpoint.ok ? styles.endpointHealthy : styles.warning
            }
            role="status"
          >
            <strong>
              {health.endpoint.ok
                ? 'Public endpoint is reachable.'
                : 'Linear cannot reach Rocky.'}
            </strong>{' '}
            {health.endpoint.checkedAt
              ? `Last verified ${new Date(health.endpoint.checkedAt).toLocaleString()}.`
              : 'Checking the public endpoint now.'}{' '}
            {health.endpoint.ok
              ? 'Rocky checks it once a minute.'
              : `${health.endpoint.detail ?? 'The endpoint is not answering'} Restore your tunnel or Tailscale Funnel, then run rocky doctor.`}
          </p>
        )}
        {intakeFailures.length > 0 && (
          <section
            className={styles.intakeFailures}
            aria-label="Linear intake failures"
            role="alert"
          >
            <h2>Linear intake needs attention</h2>
            {intakeFailures.map((failure) => (
              <article key={failure.sessionId}>
                <p>
                  <strong>{failure.action} delivery</strong> · session{' '}
                  <code>{failure.sessionId}</code> ·{' '}
                  {new Date(failure.occurredAt).toLocaleString()}
                </p>
                <p>{failure.reason}</p>
                <p>{failure.remediation}</p>
              </article>
            ))}
          </section>
        )}
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        {currentRoute.page === 'settings' ? (
          <Settings
            settings={settings}
            disabled={!mutationsAllowed}
            mismatch={setMismatch}
            back={() => go('/')}
            error={setError}
          />
        ) : currentRoute.page === 'profiles' ? (
          <Profiles
            disabled={!mutationsAllowed}
            mismatch={setMismatch}
            back={() => go('/')}
            error={setError}
          />
        ) : (
          <RunView
            detail={selectedDetail}
            issueIdentifier={currentRoute.issueIdentifier}
            expanded={expanded}
            toggle={setExpanded}
            focus={setFocusedStep}
            compose={compose}
            setCompose={changeCompose}
            composeRef={composeRef}
            submitSteer={submitSteer}
            allowed={mutationsAllowed}
            answer={submitAnswer}
            recoverSession={recoverSession}
            openDiff={setDiffId}
          />
        )}
      </section>
      {diff && (
        <DiffViewer
          diff={diff}
          onClose={() => {
            setDiff(null);
            setDiffId(null);
          }}
        />
      )}
    </main>
  );
}

function TranscriptPanel({ runId, step }: { runId: string; step: StepView }) {
  const [text, setText] = useState('');
  const [state, setState] = useState<
    'loading' | 'settled' | 'unavailable' | 'error'
  >('loading');
  const offset = useRef(0);
  useEffect(() => {
    let source: EventSource | undefined;
    try {
      source = new EventSource(
        `/api/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(step.key)}/transcript?offset=${offset.current}`,
      );
      source.addEventListener('transcript', (event) => {
        try {
          const value = JSON.parse((event as MessageEvent<string>).data) as {
            text?: unknown;
            offset?: unknown;
          };
          if (
            typeof value.text !== 'string' ||
            typeof value.offset !== 'number' ||
            value.offset <= offset.current
          )
            return;
          offset.current = value.offset;
          setText((old) => `${old}${value.text}`.slice(-TAIL));
          setState('loading');
        } catch {
          setState('error');
        }
      });
      source.addEventListener('settled', () => {
        setState('settled');
        source?.close();
      });
      source.addEventListener('unavailable', () => {
        setState('unavailable');
        source?.close();
      });
      source.onerror = () => {
        if (step.status !== 'running') {
          setState('error');
          source?.close();
        }
      };
    } catch {
      setState('error');
    }
    return () => source?.close();
  }, [runId, step.key, step.status]);
  const empty =
    state === 'unavailable'
      ? 'Transcript is unavailable.'
      : state === 'error'
        ? 'Transcript could not be read.'
        : step.transcript === 'pending'
          ? 'Transcript is still being written…'
          : 'Loading transcript…';
  return <pre className={styles.transcript}>{text || empty}</pre>;
}
function ResultView({ step }: { step: StepView }) {
  const live =
    step.status === 'running' && (step.liveOutput || step.liveSummary) ? (
      <div className={styles.resultWrap} aria-live="polite">
        {step.liveSummary && (
          <p className={styles.stepResult}>{step.liveSummary}</p>
        )}
        {step.liveOutput && (
          <pre className={styles.transcript}>{step.liveOutput}</pre>
        )}
      </div>
    ) : null;
  if (step.result === undefined && !step.error) return live;
  if (typeof step.result === 'string')
    return <p className={styles.stepResult}>{step.result}</p>;
  const record =
    step.result &&
    typeof step.result === 'object' &&
    !Array.isArray(step.result)
      ? (step.result as Record<string, unknown>)
      : undefined;
  const summary =
    typeof record?.summary === 'string' ? record.summary : undefined;
  const plan = Array.isArray(record?.steps) ? record.steps : undefined;
  const rendered = JSON.stringify(step.result, null, 2);
  return (
    <div className={styles.resultWrap}>
      {live}
      {summary && <p className={styles.stepResult}>{summary}</p>}
      {plan && (
        <ol className={styles.plan}>
          {plan.map((item, index) => (
            <li key={index}>
              {typeof item === 'string' ? item : JSON.stringify(item)}
            </li>
          ))}
        </ol>
      )}
      {record?.ci !== undefined && <Values title="CI" value={record.ci} />}
      {record?.results !== undefined && (
        <Values title="Results" value={record.results} />
      )}
      {step.error && (
        <p className={styles.error}>
          <strong>{step.error.name}:</strong> {step.error.message}
        </p>
      )}
      {rendered &&
        (rendered.length > 500 ? (
          <details className={styles.rawResult}>
            <summary>Raw result</summary>
            <pre>{rendered}</pre>
          </details>
        ) : (
          <pre className={styles.result}>{rendered}</pre>
        ))}
    </div>
  );
}
function Values({ title, value }: { title: string; value: unknown }) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return (
      <p className={styles.stepResult}>
        {title}: {String(value)}
      </p>
    );
  return (
    <>
      <h4>{title}</h4>
      <dl className={styles.values}>
        {Object.entries(value as Record<string, unknown>).map(([key, item]) => (
          <div key={key}>
            <dt>{key}</dt>
            <dd>{typeof item === 'string' ? item : JSON.stringify(item)}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}
function stepName(step: StepView) {
  return step.label ?? step.step;
}

function RunView(p: {
  detail: RunDetail | null;
  issueIdentifier?: string;
  expanded: Record<string, boolean>;
  toggle: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  focus: (s: string) => void;
  compose: string;
  setCompose: (s: string) => void;
  composeRef: React.RefObject<HTMLTextAreaElement | null>;
  submitSteer: (e: FormEvent) => void;
  allowed: boolean;
  answer: (a: Answer) => Promise<void>;
  recoverSession: (runId: string) => Promise<void>;
  openDiff: (id: string) => void;
}) {
  const d = p.detail;
  if (!d)
    return (
      <div className={styles.placeholder}>
        {p.issueIdentifier
          ? `No Run found for ${p.issueIdentifier}.`
          : 'Select a Run to read its Journal.'}
      </div>
    );
  const checkpointOpen = !!d.checkpoint && !d.checkpoint.answer;
  const canAnswer = checkpointOpen && d.controls.answer && p.allowed;
  const canSteer = d.controls.steer && p.allowed && !terminal(d.run.status);
  const submitOnModifierEnter = (
    event: ReactKeyboardEvent<HTMLTextAreaElement>,
    submit: () => void,
  ) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      submit();
    }
  };
  const submitCheckpointSteer = () => {
    if (p.compose.trim())
      void p.answer({ decision: 'steer', message: p.compose });
  };
  let previousBoot: number | undefined;
  return (
    <>
      <header className={styles.runHeader}>
        <div>
          <a href={d.run.issue.url}>{d.run.issue.identifier}</a>
          <h1>{d.run.issue.title}</h1>
          <p>
            {d.run.repo} · <code>{d.run.branch}</code> · {d.run.status}
          </p>
        </div>
        <small>{usage(d.usage.reported, d.usage.missing)}</small>
      </header>
      {d.checkpoint && (
        <section className={styles.checkpoint}>
          <p>
            <strong>Checkpoint: {d.checkpoint.title}</strong>
          </p>
          <p>{d.checkpoint.body}</p>
          {d.checkpoint.answer ? (
            <p>Answered: {d.checkpoint.answer.decision}</p>
          ) : (
            <>
              <div className={styles.answer}>
                <button
                  disabled={!canAnswer}
                  onClick={() => void p.answer({ decision: 'approve' })}
                >
                  Approve <kbd>e</kbd>
                </button>
                <button
                  disabled={!canAnswer}
                  onClick={() => void p.answer({ decision: 'reject' })}
                >
                  Reject <kbd>r</kbd>
                </button>
              </div>
              <form
                className={styles.checkpointCompose}
                onSubmit={(event) => {
                  event.preventDefault();
                  submitCheckpointSteer();
                }}
              >
                <label htmlFor="checkpoint-steer">Steer this checkpoint</label>
                <textarea
                  id="checkpoint-steer"
                  ref={p.composeRef}
                  value={p.compose}
                  onChange={(event) => p.setCompose(event.target.value)}
                  onKeyDown={(event) =>
                    submitOnModifierEnter(event, submitCheckpointSteer)
                  }
                  disabled={!canAnswer}
                  placeholder="Give the Agent direction…"
                />
                <button disabled={!canAnswer || !p.compose.trim()}>
                  Send steer
                </button>
                <small>Press Command+Enter or Control+Enter to send.</small>
                {!d.controls.answer && (
                  <small>
                    Checkpoint answers are unavailable for this Run.
                  </small>
                )}
              </form>
            </>
          )}
        </section>
      )}
      <section className={styles.journal} aria-label="Journal">
        {d.steps.map((step) => {
          const boot = previousBoot !== step.boot ? step.boot : undefined;
          previousBoot = step.boot;
          const id = stepId(d.run.runId, step.key);
          const expanded = !!p.expanded[id];
          return (
            <section key={step.key}>
              {boot !== undefined && (
                <div className={styles.boot}>
                  Boot {boot}
                  {boot === d.run.boots ? ' · current' : ''}
                </div>
              )}
              <article
                id={`step=${step.key}`}
                className={styles.step}
                data-nested={step.parentKey ? 'true' : undefined}
                tabIndex={0}
                onFocus={() => p.focus(step.key)}
              >
                <button
                  className={styles.stepToggle}
                  disabled={
                    step.transcript === 'unavailable' ||
                    step.transcript === 'pruned'
                  }
                  onClick={() =>
                    p.toggle((state) => ({ ...state, [id]: !state[id] }))
                  }
                  aria-expanded={expanded}
                >
                  <span className={`${styles.dot} ${styles[step.status]}`} />
                  <strong>{stepName(step)}</strong>
                  <small>
                    {step.status}
                    {step.stage ? ` · Stage: ${step.stage}` : ''} ·{' '}
                    <time dateTime={step.startedAt}>{step.startedAt}</time>
                    {step.ms !== undefined
                      ? ` · ${Math.round(step.ms / 1000)}s`
                      : ''}
                  </small>
                </button>
                <a
                  className={styles.stepLink}
                  href={`#${stepFragment(step.key)}`}
                >
                  #{step.key}
                </a>
                {step.completedBeforeCurrentBoot && (
                  <p className={styles.prior}>
                    Completed in Boot {step.boot}; this is recorded history.
                  </p>
                )}
                {step.usage && (
                  <small className={styles.stepUsage}>
                    {usage(step.usage)}
                  </small>
                )}
                <ResultView step={step} />
                {step.screenshots.length > 0 && (
                  <div className={styles.screenshots}>
                    {step.screenshots.map((shot) => (
                      <a
                        key={shot.id}
                        href={`/api/screenshots/${encodeURIComponent(shot.id)}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <img
                          src={`/api/screenshots/${encodeURIComponent(shot.id)}`}
                          alt={shot.caption}
                        />
                      </a>
                    ))}
                  </div>
                )}
                {expanded && (
                  <TranscriptPanel key={id} runId={d.run.runId} step={step} />
                )}
              </article>
            </section>
          );
        })}
      </section>
      {d.steers.length > 0 && (
        <section className={styles.steers} aria-label="Steer activity">
          <h2>Steer activity</h2>
          {d.steers.map((steer) => (
            <article key={steer.requestId} className={styles.steerActivity}>
              <p>
                <strong>Steer intake</strong> · received {steer.receivedAt}
              </p>
              <blockquote>{steer.message}</blockquote>
              <p>
                <strong>Delivery</strong> ·{' '}
                {steer.state === 'delivered'
                  ? `delivered${steer.targets?.length ? ` to ${steer.targets.map((target) => target.stepKey).join(', ')}` : ''}.`
                  : 'held for the next Agent conversation.'}
              </p>
            </article>
          ))}
        </section>
      )}
      {d.diffs.length > 0 && (
        <section className={styles.diffs}>
          <h2>Diffs</h2>
          {d.diffs.map((item) => (
            <button key={item.id} onClick={() => p.openDiff(item.id)}>
              {item.label}
            </button>
          ))}
        </section>
      )}
      {!checkpointOpen &&
        (terminal(d.run.status) ? (
          <section className={styles.terminal}>
            <p className={styles.muted}>
              This Run is finished; its Steer intake is closed.
            </p>
            {(d.run.status === 'failed' || d.run.status === 'cancelled') && (
              <>
                <button
                  disabled={!p.allowed}
                  onClick={() => void p.recoverSession(d.run.runId)}
                >
                  Enable fresh Linear delegation
                </button>
                <small>
                  Use this only when Linear reused this failed Run&apos;s Agent
                  Session after you delegated Rocky again.
                </small>
              </>
            )}
          </section>
        ) : (
          <form className={styles.compose} onSubmit={p.submitSteer}>
            <label htmlFor="steer">Steer this Run</label>
            <textarea
              id="steer"
              ref={p.composeRef}
              value={p.compose}
              onChange={(event) => p.setCompose(event.target.value)}
              onKeyDown={(event) =>
                submitOnModifierEnter(event, () =>
                  p.composeRef.current?.form?.requestSubmit(),
                )
              }
              placeholder={
                d.controls.steer
                  ? 'Tell the next Agent conversation what to change…'
                  : 'This Run has no Steer seam.'
              }
              disabled={!canSteer}
            />
            <button disabled={!canSteer || !p.compose.trim()}>
              Send Steer
            </button>
            {!d.controls.steer && (
              <small>Steer is unavailable for this Run.</small>
            )}
          </form>
        ))}
    </>
  );
}
function Settings(p: {
  settings: SettingsView | null;
  disabled: boolean;
  mismatch: (v: string | null) => void;
  back: () => void;
  error: (s: string) => void;
}) {
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [values, setValues] = useState<SettingsView['values'] | null>(null);
  useEffect(() => {
    setSettings(p.settings);
    setValues(p.settings?.values ?? null);
  }, [p.settings]);
  if (!settings || !values)
    return <div className={styles.placeholder}>Loading settings…</div>;
  const save = async () => {
    try {
      const updated = await api<SettingsView>('/api/settings', p.mismatch, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          revision: settings.revision,
          patch: {
            server: values.server,
            retention: values.retention,
            concurrency: values.concurrency,
          },
        }),
      });
      setSettings(updated);
      setValues(updated.values);
    } catch (caught) {
      p.error(await apiError(caught, 'Settings were not saved.'));
    }
  };
  return (
    <section className={styles.settings}>
      <button onClick={p.back}>← Inbox</button>
      <h1>Settings</h1>
      <label>
        Bind host
        <input
          disabled={p.disabled}
          value={values.server.host}
          onChange={(event) =>
            setValues({
              ...values,
              server: { ...values.server, host: event.target.value },
            })
          }
        />
      </label>
      <label>
        Bind port
        <input
          type="number"
          disabled={p.disabled}
          value={values.server.port}
          onChange={(event) =>
            setValues({
              ...values,
              server: { ...values.server, port: Number(event.target.value) },
            })
          }
        />
      </label>
      <label>
        Retention: terminal Runs
        <input
          type="number"
          disabled={p.disabled}
          value={values.retention.keepTerminalRuns}
          onChange={(event) =>
            setValues({
              ...values,
              retention: {
                ...values.retention,
                keepTerminalRuns: Number(event.target.value),
              },
            })
          }
        />
      </label>
      <label>
        Retention: sessions & screenshots
        <input
          type="number"
          disabled={p.disabled}
          value={values.retention.keepSessionsAndScreenshots}
          onChange={(event) =>
            setValues({
              ...values,
              retention: {
                ...values.retention,
                keepSessionsAndScreenshots: Number(event.target.value),
              },
            })
          }
        />
      </label>
      <label>
        Maximum concurrent Runs
        <input
          type="number"
          disabled={p.disabled}
          value={values.concurrency.maxRuns}
          onChange={(event) =>
            setValues({
              ...values,
              concurrency: { maxRuns: Number(event.target.value) },
            })
          }
        />
      </label>
      <button disabled={p.disabled} onClick={save}>
        Save settings
      </button>
      {settings.restartRequired && (
        <p className={styles.warning}>
          Restart Rocky for server settings to take effect.
        </p>
      )}
      <h2>MCP</h2>
      {!settings.mcpAvailable ? (
        <p className={styles.muted}>MCP status is unavailable.</p>
      ) : (
        settings.mcp.map((m) => (
          <p key={m.name}>
            <strong>{m.name}</strong> · {m.status} <code>{m.loginCommand}</code>
          </p>
        ))
      )}
    </section>
  );
}

function Profiles(p: {
  disabled: boolean;
  mismatch: (v: string | null) => void;
  back: () => void;
  error: (s: string) => void;
}) {
  const [profiles, setProfiles] = useState<RepositoryProfileView[] | null>(
    null,
  );
  const [selected, setSelected] = useState<RepositoryProfileView | null>(null);
  const [draft, setDraft] = useState<RepositoryProfileView | null>(null);
  useEffect(() => {
    let stopped = false;
    api<RepositoryProfileList>('/api/profiles', p.mismatch)
      .then((next) => {
        if (stopped) return;
        setProfiles(next.profiles);
        const first = next.profiles[0] ?? null;
        setSelected(first);
        setDraft(first);
      })
      .catch(
        (caught) =>
          !stopped &&
          void apiError(caught, 'Could not load profiles.').then(p.error),
      );
    return () => {
      stopped = true;
    };
  }, [p.mismatch, p.error]);
  const choose = (id: string) => {
    const next = profiles?.find((profile) => profile.id === id) ?? null;
    setSelected(next);
    setDraft(next);
  };
  const create = () => {
    const next: RepositoryProfileView = {
      id: '',
      remote: '',
      workflow: { source: 'export default [];', triggers: [] },
      grants: { harness: 'opencode', capabilities: [], mcp: [] },
      prompts: [],
      rules: [],
      secretEnv: [],
      revision: '',
    };
    setSelected(null);
    setDraft(next);
  };
  const save = async () => {
    if (!draft || p.disabled) return;
    try {
      const saved = await api<RepositoryProfileView>(
        '/api/profiles',
        p.mismatch,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            id: draft.id,
            remote: draft.remote,
            revision: draft.revision || undefined,
            workflow: draft.workflow,
            grants: draft.grants,
          }),
        },
      );
      setProfiles((current) =>
        [...(current ?? []).filter((item) => item.id !== saved.id), saved].sort(
          (a, b) => a.id.localeCompare(b.id),
        ),
      );
      setSelected(saved);
      setDraft(saved);
    } catch (caught) {
      p.error(await apiError(caught, 'Profile was not saved.'));
    }
  };
  const remove = async () => {
    if (!selected || p.disabled) return;
    if (!window.confirm(`Delete local profile ${selected.id}?`)) return;
    try {
      await api('/api/profiles', p.mismatch, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: selected.id, revision: selected.revision }),
      });
      setProfiles((current) => {
        const next = (current ?? []).filter((item) => item.id !== selected.id);
        const replacement = next[0] ?? null;
        setSelected(replacement);
        setDraft(replacement);
        return next;
      });
    } catch (caught) {
      p.error(await apiError(caught, 'Profile was not deleted.'));
    }
  };
  if (!profiles || !draft)
    return (
      <div className={styles.placeholder}>Loading repository profiles…</div>
    );
  return (
    <section className={styles.profiles}>
      <button onClick={p.back}>← Inbox</button>
      <header>
        <div>
          <h1>Repository profiles</h1>
          <p>
            Local-only workflows. Repository files cannot change these settings.
          </p>
        </div>
        <button disabled={p.disabled} onClick={create}>
          New profile
        </button>
      </header>
      <label>
        Profile
        <select
          value={selected?.id ?? ''}
          onChange={(event) => choose(event.target.value)}
          disabled={p.disabled}
        >
          {!selected && <option value="">New profile</option>}
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.id} · {profile.remote}
            </option>
          ))}
        </select>
      </label>
      <label>
        Profile id
        <input
          value={draft.id}
          disabled={p.disabled || Boolean(selected)}
          onChange={(event) => setDraft({ ...draft, id: event.target.value })}
          placeholder="my-repo"
        />
      </label>
      <label>
        Canonical repository remote
        <input
          value={draft.remote}
          disabled={p.disabled}
          onChange={(event) =>
            setDraft({ ...draft, remote: event.target.value })
          }
          placeholder="github.com/acme/service"
        />
      </label>
      <label>
        Harness
        <select
          value={draft.grants.harness}
          disabled={p.disabled}
          onChange={(event) =>
            setDraft({
              ...draft,
              grants: {
                ...draft.grants,
                harness: event.target
                  .value as RepositoryProfileView['grants']['harness'],
              },
            })
          }
        >
          <option value="opencode">OpenCode</option>
          <option value="claude-code">Claude Code</option>
        </select>
      </label>
      <label>
        Manual triggers (one per line)
        <textarea
          value={draft.workflow.triggers.join('\n')}
          disabled={p.disabled}
          onChange={(event) =>
            setDraft({
              ...draft,
              workflow: {
                ...draft.workflow,
                triggers: event.target.value
                  .split('\n')
                  .map((name) => name.trim())
                  .filter(Boolean),
              },
            })
          }
          placeholder="custom-workflow"
        />
      </label>
      <label>
        workflow.ts
        <textarea
          className={styles.workflowSource}
          value={draft.workflow.source}
          disabled={p.disabled}
          onChange={(event) =>
            setDraft({
              ...draft,
              workflow: { ...draft.workflow, source: event.target.value },
            })
          }
          spellCheck={false}
        />
      </label>
      <p className={styles.muted}>
        Prompts: {draft.prompts.join(', ') || 'none'} · Rules:{' '}
        {draft.rules.join(', ') || 'none'} · Secret references:{' '}
        {draft.secretEnv.join(', ') || 'none'}
      </p>
      <button
        disabled={
          p.disabled ||
          !draft.id ||
          !draft.remote ||
          !draft.workflow.source.trim()
        }
        onClick={() => void save()}
      >
        Save profile
      </button>
      {selected && (
        <button
          className={styles.deleteProfile}
          disabled={p.disabled}
          onClick={() => void remove()}
        >
          Delete profile
        </button>
      )}
    </section>
  );
}
export default App;
