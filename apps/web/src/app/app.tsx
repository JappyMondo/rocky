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
  RepositoryProfileDefaults,
  RepositoryProfileView,
  ProfileRoutingView,
  SettingsView,
  StepView,
  Usage,
} from '@rocky/local-contracts';
import { api, apiError } from './api.js';
import { ReviewReports } from './review-report.js';
import { WorkflowDiagram } from './workflow-diagram.js';
import { DiffViewer } from './diff-view.js';
import { RunsOverview, type RunsViewState } from './runs-overview.js';
import { Dialog, Icon, Mark, Status, dateLabel } from './ui.js';
import styles from './app.module.css';
import { Connections } from './connections.js';

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
  target instanceof HTMLSelectElement ||
  (target instanceof HTMLElement && target.isContentEditable);
const active = (status: string) => status === 'running' || status === 'queued';
const terminal = (status: string) =>
  status === 'finished' || status === 'failed' || status === 'cancelled';
const stepId = (runId: string, key: string) => `${runId}:${key}`;
const stepFragment = (key: string) => `step=${encodeURIComponent(key)}`;

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
  if (absent && pieces.length) pieces.push(`partial (${absent} missing)`);
  return pieces.length ? pieces.join(' · ') : 'Usage not reported';
}

export function App() {
  const [currentRoute, setRoute] = useState<Route>(route);
  const [runs, setRuns] = useState<RunList | null>(null);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [intakeFailures, setIntakeFailures] = useState<IntakeFailure[]>([]);
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [profiles, setProfiles] = useState<RepositoryProfileView[]>([]);
  const [unreachable, setUnreachable] = useState(false);
  const [mismatch, setMismatch] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [diff, setDiff] = useState<DiffView | null>(null);
  const [diffId, setDiffId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [compose, setCompose] = useState('');
  const [focusedStep, setFocusedStep] = useState<string | null>(null);
  const [triggerIssue, setTriggerIssue] = useState('');
  const [triggerProfile, setTriggerProfile] = useState('');
  const [newRun, setNewRun] = useState(false);
  const [starting, setStarting] = useState(false);
  const [triggerError, setTriggerError] = useState<string | null>(null);
  const [repository, setRepository] = useState('');
  const [runsView, setRunsView] = useState<RunsViewState>({
    filter: 'All runs',
    query: '',
    page: 0,
  });
  const contentRef = useRef<HTMLElement>(null);
  const overviewScroll = useRef(0);
  const closeNewRun = useCallback(() => setNewRun(false), []);
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
          : undefined));
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
    let cancelled = false;
    api<RepositoryProfileList>('/api/profiles', setMismatch)
      .then((next) => {
        if (!cancelled && next.profiles) setProfiles(next.profiles);
      })
      .catch(() => {
        // The workspace remains useful with a daemon from before profiles.
      });
    return () => {
      cancelled = true;
    };
  }, [currentRoute.page]);
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
        diff ||
        newRun
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
        selectedDetail.checkpoint.kind !== 'question' &&
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
    newRun,
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
    if (
      !triggerIssue.trim() ||
      !triggerName.trim() ||
      !mutationsAllowed ||
      starting
    )
      return;
    setStarting(true);
    setTriggerError(null);
    try {
      const result = await api<{ runId: string }>(
        '/api/triggers',
        setMismatch,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            trigger: triggerName.trim(),
            issue: triggerIssue.trim(),
            ...(triggerProfile ? { profileId: triggerProfile } : {}),
          }),
        },
      );
      setTriggerIssue('');
      setNewRun(false);
      go(`/runs/${encodeURIComponent(result.runId)}`);
    } catch (caught) {
      setTriggerError(await apiError(caught, 'Trigger was not admitted.'));
    } finally {
      setStarting(false);
    }
  };
  const startRun = () => {
    setTriggerError(null);
    setNewRun(true);
  };
  const isOverview =
    currentRoute.page === 'inbox' &&
    !currentRoute.runId &&
    !currentRoute.issueIdentifier;
  useEffect(() => {
    if (contentRef.current)
      contentRef.current.scrollTop = isOverview ? overviewScroll.current : 0;
  }, [isOverview, selectedId, currentRoute.page]);
  const pageLabel =
    currentRoute.page === 'profiles'
      ? 'Profiles'
      : currentRoute.page === 'settings'
        ? 'Settings'
        : 'Runs';
  return (
    <div className={styles.app}>
      <a href="#main-content" className={styles.skipLink}>
        Skip to content
      </a>
      <aside
        className={styles.sidebar}
        aria-label="Workspace navigation"
        inert={newRun || !!diff}
      >
        <button
          className={styles.brand}
          onClick={() => go('/')}
          aria-label="Rocky home"
        >
          <Mark />
          <span>
            rocky<span className={styles.brandPeriod}>.</span>
          </span>
        </button>
        <div className={styles.workspaceLabel}>
          <span className={styles.workspaceAvatar}>L</span>
          <div>
            <strong>Local workspace</strong>
            <small>On your machine</small>
          </div>
        </div>
        <p className={styles.navLabel}>Workspace</p>
        <nav className={styles.navigation} aria-label="Main navigation">
          <button
            aria-current={currentRoute.page === 'inbox' ? 'page' : undefined}
            onClick={() => go('/')}
          >
            <Icon name="runs" />
            Runs
            <span className={styles.navCount}>{runs?.runs.length ?? '—'}</span>
          </button>
          <button
            aria-current={currentRoute.page === 'profiles' ? 'page' : undefined}
            onClick={() => go('/profiles')}
          >
            <Icon name="repo" />
            Profiles
          </button>
          <button
            aria-current={currentRoute.page === 'settings' ? 'page' : undefined}
            onClick={() => go('/settings')}
          >
            <Icon name="settings" />
            Settings
          </button>
        </nav>
        {!!runs?.runs.length && (
          <div className={styles.recentRuns}>
            <p className={styles.navLabel}>Recent runs</p>
            {runs.runs.slice(0, 4).map((run) => (
              <button
                key={run.runId}
                aria-current={run.runId === selectedId ? 'page' : undefined}
                onClick={() => go(`/runs/${encodeURIComponent(run.runId)}`)}
              >
                <span className={`${styles.dot} ${styles[run.status]}`} />
                <span>
                  <strong>
                    {run.issue.identifier}
                    <small>{run.runId}</small>
                  </strong>
                  <em>{run.issue.title}</em>
                </span>
              </button>
            ))}
          </div>
        )}
        <footer className={styles.sidebarFooter}>
          <details className={styles.connection}>
            <summary>
              <span
                className={`${styles.dot} ${unreachable ? styles.failed : health ? styles.finished : ''}`}
              />
              {unreachable
                ? 'Disconnected'
                : health
                  ? 'Rocky is online'
                  : 'Connecting…'}
              <Icon name="chevron" size={13} />
            </summary>
            <div>
              <p>Daemon {health?.version ?? VERSION}</p>
              {health?.endpoint?.configured && (
                <>
                  <strong>
                    {health.endpoint.ok
                      ? 'Public endpoint is reachable.'
                      : 'Linear cannot reach Rocky.'}
                  </strong>
                  <p>
                    {health.endpoint.checkedAt
                      ? `Last verified ${new Date(health.endpoint.checkedAt).toLocaleString()}.`
                      : 'Checking the public endpoint now.'}
                  </p>
                  <p>Rocky checks it once a minute.</p>
                </>
              )}
            </div>
          </details>
          <div className={styles.sidebarFootnote}>
            <span>Made for focused work</span>
            <span>v{VERSION}</span>
          </div>
        </footer>
      </aside>
      <div className={styles.main} inert={newRun || !!diff}>
        <header className={styles.topbar}>
          <div>
            <span>Workspace</span>
            <Icon name="chevron" size={12} />
            <button
              onClick={() =>
                go(
                  currentRoute.page === 'profiles'
                    ? '/profiles'
                    : currentRoute.page === 'settings'
                      ? '/settings'
                      : '/',
                )
              }
            >
              {pageLabel}
            </button>
            {selectedId && (
              <>
                <Icon name="chevron" size={12} />
                <span className={styles.breadcrumbRun}>{selectedId}</span>
              </>
            )}
          </div>
          <span className={styles.localLabel}>
            <span className={`${styles.dot} ${styles.finished}`} />
            Local
          </span>
        </header>
        <main
          id="main-content"
          className={styles.content}
          ref={contentRef}
          onScroll={(event) => {
            if (isOverview)
              overviewScroll.current = event.currentTarget.scrollTop;
          }}
        >
          <div className={styles.statusStack} aria-label="Rocky status">
            {mismatch && (
              <p className={styles.warning} role="alert">
                This web UI expects daemon {VERSION}, but reached {mismatch}.
                Mutating controls are disabled.
              </p>
            )}
            {unreachable && (
              <p className={styles.warning} role="status">
                {runs ? (
                  'The daemon is temporarily unreachable; showing the last known state.'
                ) : (
                  <>
                    No daemon answering. Run <code>rocky start</code> to connect
                    your workspace.
                  </>
                )}
              </p>
            )}
            {health?.endpoint?.configured && !health.endpoint.ok && (
              <p className={styles.warning} role="status">
                <strong>Linear cannot reach Rocky.</strong>{' '}
                {health.endpoint.checkedAt
                  ? `Last verified ${new Date(health.endpoint.checkedAt).toLocaleString()}.`
                  : 'Checking the public endpoint now.'}{' '}
                {health.endpoint.detail ?? 'The endpoint is not answering'}.
                Restore your tunnel or Tailscale Funnel, then run rocky doctor.
              </p>
            )}
            {intakeFailures.length > 0 && (
              <details
                className={styles.intakeFailures}
                aria-label="Linear intake failures"
              >
                <summary>
                  Linear intake needs attention{' '}
                  <span>{intakeFailures.length}</span>
                </summary>
                {intakeFailures.map((failure) => (
                  <article key={failure.sessionId}>
                    <p>
                      <strong>{failure.action} delivery</strong> ·{' '}
                      {dateLabel(failure.occurredAt)}
                    </p>
                    <p>{failure.reason}</p>
                    <p>{failure.remediation}</p>
                    <small>Session {failure.sessionId}</small>
                  </article>
                ))}
              </details>
            )}
            {error && (
              <p className={styles.error} role="alert">
                {error}
              </p>
            )}
          </div>
          {currentRoute.page === 'settings' ? (
            <Settings
              settings={settings}
              disabled={!mutationsAllowed}
              mismatch={setMismatch}
              error={setError}
            />
          ) : currentRoute.page === 'profiles' ? (
            <Profiles
              disabled={!mutationsAllowed}
              mismatch={setMismatch}
              error={setError}
            />
          ) : isOverview ? (
            <RunsOverview
              runs={runs?.runs ?? []}
              loading={!runs && !unreachable}
              start={startRun}
              openRun={(id) => go(`/runs/${encodeURIComponent(id)}`)}
              repository={repository}
              onRepository={setRepository}
              view={runsView}
              setView={setRunsView}
            />
          ) : (
            <RunView
              detail={selectedDetail}
              loading={Boolean(selectedId) || !runs}
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
        </main>
      </div>
      {newRun && (
        <Dialog title="Start a new run" onClose={closeNewRun}>
          <p className={styles.dialogIntro}>
            Choose a Linear issue and the workflow trigger Rocky should run.
          </p>
          <form className={styles.trigger} onSubmit={fireTrigger}>
            <label>
              Profile
              <select
                aria-label="Run profile"
                value={triggerProfile}
                disabled={!mutationsAllowed || starting}
                onChange={(event) => setTriggerProfile(event.target.value)}
              >
                <option value="">Use the issue’s routing label</option>
                {profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.id}
                    {profile.repos
                      ? ` · ${profile.repos.length} ${profile.repos.length === 1 ? 'repository' : 'repositories'}`
                      : ''}
                  </option>
                ))}
              </select>
              <small>
                Every repository in the selected profile gets its own worktree.
              </small>
            </label>
            <label>
              Linear issue
              <input
                aria-label="Trigger issue"
                value={triggerIssue}
                onChange={(event) => setTriggerIssue(event.target.value)}
                placeholder="e.g. NG-612"
                disabled={!mutationsAllowed || starting}
                required
              />
              <small>Use the issue identifier from Linear.</small>
            </label>
            <label>
              Workflow trigger
              <input
                aria-label="Trigger name"
                list="workflow-triggers"
                value={triggerName}
                onChange={(event) => setTriggerName(event.target.value)}
                disabled={!mutationsAllowed || starting}
                required
              />
              <datalist id="workflow-triggers">
                {[
                  ...new Set(
                    profiles
                      .filter(
                        (profile) =>
                          !triggerProfile || profile.id === triggerProfile,
                      )
                      .flatMap((profile) => profile.workflow.triggers),
                  ),
                ].map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
              <small>
                A manual trigger configured in the selected profile.
              </small>
            </label>
            {triggerError && (
              <p className={styles.error} role="alert">
                {triggerError}
              </p>
            )}
            <footer className={styles.formActions}>
              <button type="button" onClick={closeNewRun}>
                Cancel
              </button>
              <button
                className={styles.primary}
                disabled={
                  !mutationsAllowed ||
                  !triggerIssue.trim() ||
                  !triggerName.trim() ||
                  starting
                }
              >
                <Icon name="plus" />
                {starting ? 'Starting…' : 'Start run'}
              </button>
            </footer>
          </form>
        </Dialog>
      )}
      {diff && (
        <DiffViewer
          diff={diff}
          onClose={() => {
            setDiff(null);
            setDiffId(null);
          }}
        />
      )}
    </div>
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
      {rendered && (
        <details className={styles.rawResult}>
          <summary>Raw result</summary>
          <pre>{rendered}</pre>
        </details>
      )}
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
  return (
    step.label ??
    { workspace: 'Prepare workspace', $end: 'Finish run' }[step.step] ??
    step.step
  );
}

function RunView(p: {
  detail: RunDetail | null;
  loading: boolean;
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
        {p.issueIdentifier && !p.loading
          ? `No Run found for ${p.issueIdentifier}.`
          : 'Loading run…'}
      </div>
    );
  const checkpointOpen = !!d.checkpoint && !d.checkpoint.answer;
  const isQuestion = d.checkpoint?.kind === 'question';
  const failedStep = d.steps.findLast((step) => step.status === 'failed');
  const failure = d.run.error?.message ?? failedStep?.error?.message;
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
          <button className={styles.backLink} onClick={() => go('/')}>
            <Icon name="back" size={16} />
            All runs
          </button>
          <div className={styles.runIdentity}>
            <a href={d.run.issue.url} target="_blank" rel="noreferrer">
              {d.run.issue.identifier}
              <Icon name="external" size={13} />
            </a>
            <span>{d.run.runId}</span>
            <Status value={d.run.status} />
          </div>
          <h1>{d.run.issue.title}</h1>
          <p className={styles.runMeta}>
            <span>
              <Icon name="repo" size={15} />
              {d.run.repos?.join(', ') ?? d.run.repo}
            </span>
            <span>
              <Icon name="branch" size={15} />
              <code>{d.run.branch}</code>
            </span>
            <span>
              <Icon name="clock" size={15} />
              <time dateTime={d.run.createdAt}>
                {dateLabel(d.run.createdAt)}
              </time>
            </span>
          </p>
        </div>
        {d.run.pr && (
          <a
            className={styles.buttonLink}
            href={d.run.pr.url}
            target="_blank"
            rel="noreferrer"
          >
            Pull request #{d.run.pr.number}
            <Icon name="external" size={14} />
          </a>
        )}
      </header>
      {d.run.status === 'failed' && (
        <section role="alert" className={styles.runFailure}>
          <h2>Run failed{failedStep ? ` · ${stepName(failedStep)}` : ''}</h2>
          <p>
            {failure ??
              d.run.reason ??
              'No failure details were recorded. Check the daemon log.'}
          </p>
          {failedStep && (
            <button
              onClick={() => {
                p.toggle((state) => ({
                  ...state,
                  [stepId(d.run.runId, failedStep.key)]: true,
                }));
                document
                  .getElementById(`step=${failedStep.key}`)
                  ?.scrollIntoView({ block: 'center' });
              }}
            >
              Show failed step
            </button>
          )}
        </section>
      )}
      <div className={styles.runSummary}>
        <div>
          <p className={styles.eyebrow}>Progress</p>
          <strong>
            {d.steps.filter((step) => step.status === 'done').length} of{' '}
            {d.steps.length} steps complete
          </strong>
          <progress
            aria-label="Run progress"
            value={d.steps.filter((step) => step.status === 'done').length}
            max={Math.max(1, d.steps.length)}
          />
        </div>
        <div>
          <p className={styles.eyebrow}>Profile</p>
          <strong>
            {d.run.profileId ?? 'Legacy run — no profile recorded'}
          </strong>
        </div>
        <div>
          <p className={styles.eyebrow}>Workflow trigger</p>
          <strong>{d.run.trigger ?? 'Issue delegation'}</strong>
        </div>
        <div>
          <p className={styles.eyebrow}>Usage</p>
          <span>{usage(d.usage.reported, d.usage.missing)}</span>
        </div>
      </div>
      <ReviewReports key={d.run.runId} detail={d} />
      {d.run.reason && <p className={styles.warning}>{d.run.reason}</p>}
      {d.diffs.length > 0 && (
        <section className={styles.diffs}>
          <div>
            <Icon name="code" />
            <h2>Changes ready to inspect</h2>
          </div>
          {d.diffs.map((item) => (
            <button key={item.id} onClick={() => p.openDiff(item.id)}>
              {item.label}
              <Icon name="arrow" size={15} />
            </button>
          ))}
        </section>
      )}
      {d.checkpoint && (
        <section className={styles.checkpoint}>
          <p className={styles.eyebrow}>
            {isQuestion
              ? 'Clarification needed'
              : d.checkpoint.answer
                ? 'Review completed'
                : 'Your review is needed'}
          </p>
          <h2>{d.checkpoint.title}</h2>
          <p>{d.checkpoint.body}</p>
          {d.checkpoint.answer ? (
            <p>Answered: {d.checkpoint.answer.decision}</p>
          ) : (
            <>
              {!isQuestion && (
                <div className={styles.answer}>
                  <button
                    disabled={!canAnswer}
                    onClick={() => void p.answer({ decision: 'approve' })}
                  >
                    <Icon name="check" size={16} />
                    Approve <kbd>e</kbd>
                  </button>
                  <button
                    disabled={!canAnswer}
                    onClick={() => void p.answer({ decision: 'reject' })}
                  >
                    Reject <kbd>r</kbd>
                  </button>
                </div>
              )}
              {isQuestion &&
                d.checkpoint.options?.map((option) => (
                  <button
                    key={option}
                    disabled={!canAnswer}
                    onClick={() => p.setCompose(option)}
                  >
                    {option}
                  </button>
                ))}
              <form
                className={styles.checkpointCompose}
                onSubmit={(event) => {
                  event.preventDefault();
                  submitCheckpointSteer();
                }}
              >
                <label htmlFor="checkpoint-steer">
                  {isQuestion ? 'Your answer' : 'Steer this checkpoint'}
                </label>
                <textarea
                  id="checkpoint-steer"
                  ref={p.composeRef}
                  value={p.compose}
                  onChange={(event) => p.setCompose(event.target.value)}
                  onKeyDown={(event) =>
                    submitOnModifierEnter(event, submitCheckpointSteer)
                  }
                  disabled={!canAnswer}
                  placeholder={
                    isQuestion
                      ? 'Answer the questions above…'
                      : 'Give the Agent direction…'
                  }
                />
                <button disabled={!canAnswer || !p.compose.trim()}>
                  {isQuestion ? 'Send answer' : 'Send steer'}
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
        <header className={styles.sectionHeading}>
          <div>
            <h2>Run activity</h2>
            <p>Follow the work. Expand a step for results and logs.</p>
          </div>
          <span>{d.steps.length} steps</span>
        </header>
        {!d.steps.length && (
          <p className={styles.placeholder}>
            Waiting for the first workflow step…
          </p>
        )}
        {d.steps.map((step) => {
          const boot = previousBoot !== step.boot ? step.boot : undefined;
          previousBoot = step.boot;
          const id = stepId(d.run.runId, step.key);
          const expanded = !!p.expanded[id];
          return (
            <section key={step.key}>
              {boot !== undefined && d.run.boots > 1 && (
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
                  onClick={() =>
                    p.toggle((state) => ({ ...state, [id]: !state[id] }))
                  }
                  aria-expanded={expanded}
                >
                  <span className={`${styles.dot} ${styles[step.status]}`} />
                  <span className={styles.stepTitle}>
                    <strong>{stepName(step)}</strong>
                    {step.stage && <small>{step.stage}</small>}
                    {step.agent && (
                      <small>
                        {step.agent.harness} ·{' '}
                        {step.agent.model ?? 'Harness default model'} ·{' '}
                        {step.agent.variant ?? 'Default variant'}
                      </small>
                    )}
                  </span>
                  <small className={styles.stepTiming}>
                    <time
                      dateTime={step.startedAt}
                      title={new Date(step.startedAt).toLocaleString()}
                    >
                      {new Date(step.startedAt).toLocaleTimeString()}
                    </time>
                    <span>
                      {step.ms !== undefined
                        ? duration(step.ms)
                        : step.status === 'running' && !terminal(d.run.status)
                          ? duration(Date.now() - Date.parse(step.startedAt))
                          : '—'}
                    </span>
                  </small>
                  <Status value={step.status} />
                  <span className={styles.expandIcon} data-open={expanded}>
                    <Icon name="chevron" size={16} />
                  </span>
                </button>
                {!expanded && step.status === 'running' && step.liveSummary && (
                  <p className={styles.livePreview}>{step.liveSummary}</p>
                )}
                {!expanded && step.error && (
                  <p className={styles.stepError}>{step.error.message}</p>
                )}
                {expanded && (
                  <div className={styles.stepBody}>
                    <a
                      className={styles.stepLink}
                      href={`#${stepFragment(step.key)}`}
                    >
                      #{step.key}
                    </a>
                    <StepMetadata
                      step={step}
                      terminal={terminal(d.run.status)}
                    />
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
                    {(step.transcript === 'available' ||
                      step.transcript === 'pending') && (
                      <TranscriptPanel
                        key={id}
                        runId={d.run.runId}
                        step={step}
                      />
                    )}
                    {step.transcript === 'pruned' && (
                      <p className={styles.muted}>
                        The transcript for this step is no longer retained.
                      </p>
                    )}
                  </div>
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
  error: (s: string) => void;
}) {
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [values, setValues] = useState<SettingsView['values'] | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    setSettings(p.settings);
    setValues(p.settings?.values ?? null);
  }, [p.settings]);
  if (!settings || !values)
    return <div className={styles.placeholder}>Loading settings…</div>;
  const save = async () => {
    setSaved(false);
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
      setSaved(true);
    } catch (caught) {
      p.error(await apiError(caught, 'Settings were not saved.'));
    }
  };
  return (
    <>
      <form
        className={styles.settings}
        onChange={() => setSaved(false)}
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <header className={styles.pageHeader}>
          <div>
            <p className={styles.eyebrow}>Workspace preferences</p>
            <h1>Settings</h1>
            <p>Make Rocky fit the way you work.</p>
          </div>
        </header>
        <div className={styles.settingsGroup}>
          <div className={styles.groupIntro}>
            <Icon name="settings" />
            <h2>Local server</h2>
            <p>
              Where your Rocky workspace is available. Changes require a
              restart.
            </p>
          </div>
          <div className={styles.fieldGrid}>
            <label>
              Bind host
              <input
                disabled={p.disabled}
                required
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
                required
                min={1}
                disabled={p.disabled}
                max={65535}
                value={values.server.port}
                onChange={(event) =>
                  setValues({
                    ...values,
                    server: {
                      ...values.server,
                      port: Number(event.target.value),
                    },
                  })
                }
              />
            </label>
          </div>
        </div>
        <div className={styles.settingsGroup}>
          <div className={styles.groupIntro}>
            <Icon name="clock" />
            <h2>Run history</h2>
            <p>Choose how much completed work and its artifacts to keep.</p>
          </div>
          <div className={styles.fieldGrid}>
            <label>
              Retention: terminal Runs
              <input
                type="number"
                required
                min={1}
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
                required
                min={1}
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
          </div>
        </div>
        <div className={styles.settingsGroup}>
          <div className={styles.groupIntro}>
            <Icon name="runs" />
            <h2>Concurrency</h2>
            <p>Limit how many runs can work at the same time.</p>
          </div>
          <div className={styles.fieldGrid}>
            <label>
              Maximum concurrent Runs
              <input
                type="number"
                required
                min={1}
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
          </div>
        </div>
        <div className={styles.formActions}>
          {saved && (
            <span className={styles.saved} role="status">
              <Icon name="check" size={15} />
              Settings saved
            </span>
          )}
          <button
            className={styles.primary}
            disabled={p.disabled}
            type="submit"
          >
            Save settings
          </button>
        </div>
        {settings.restartRequired && (
          <p className={styles.warning}>
            Restart Rocky for server settings to take effect.
          </p>
        )}
      </form>
      <Connections disabled={p.disabled} mismatch={p.mismatch} />
    </>
  );
}

function Profiles(p: {
  disabled: boolean;
  mismatch: (v: string | null) => void;
  error: (s: string) => void;
}) {
  const [profiles, setProfiles] = useState<RepositoryProfileView[] | null>(
    null,
  );
  const [selected, setSelected] = useState<RepositoryProfileView | null>(null);
  const [draft, setDraft] = useState<RepositoryProfileView | null>(null);
  const [creating, setCreating] = useState(false);
  const [editor, setEditor] = useState('default');
  const [openingEditor, setOpeningEditor] = useState(false);
  const [editorOpened, setEditorOpened] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [routing, setRouting] = useState<ProfileRoutingView | null>(null);
  const [routingDraft, setRoutingDraft] = useState({ labels: '', teams: '' });
  const [savingRouting, setSavingRouting] = useState(false);
  const [saved, setSaved] = useState(false);
  const [tab, setTab] = useState<'general' | 'workflow'>('general');
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
    setSaved(false);
    setEditorOpened(false);
    setEditorError(null);
    const next = profiles?.find((profile) => profile.id === id) ?? null;
    setSelected(next);
    setDraft(next);
  };
  useEffect(() => {
    if (!selected) {
      setRouting(null);
      return;
    }
    let stopped = false;
    api<ProfileRoutingView>(
      `/api/profiles/${encodeURIComponent(selected.id)}/routing`,
      p.mismatch,
    )
      .then((next) => {
        if (stopped) return;
        setRouting(next);
        setRoutingDraft({
          labels: next.labels.join('\n'),
          teams: next.teams.join('\n'),
        });
      })
      .catch(
        (caught) =>
          !stopped &&
          void apiError(caught, 'Could not load Linear routing.').then(p.error),
      );
    return () => {
      stopped = true;
    };
  }, [selected?.id, p.mismatch, p.error]);
  const create = async () => {
    if (p.disabled || creating) return;
    setCreating(true);
    try {
      const defaults = await api<RepositoryProfileDefaults>(
        '/api/profile-defaults',
        p.mismatch,
      );
      setSaved(false);
      setEditorOpened(false);
      setEditorError(null);
      setTab('general');
      const next: RepositoryProfileView = {
        ...defaults,
        id: '',
        remote: '',
        repos: [{ name: '', url: '', baseBranch: 'main' }],
        revision: '',
      };
      setSelected(null);
      setDraft(next);
    } catch (caught) {
      p.error(
        await apiError(
          caught,
          'Could not load the default workflow. Try adding the profile again.',
        ),
      );
    } finally {
      setCreating(false);
    }
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
            ...(draft.repos
              ? { repos: draft.repos }
              : { remote: draft.remote }),
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
      setSaved(true);
    } catch (caught) {
      p.error(await apiError(caught, 'Profile was not saved.'));
    }
  };
  const saveRouting = async () => {
    if (!selected || !routing || p.disabled || savingRouting) return;
    setSavingRouting(true);
    try {
      const saved = await api<ProfileRoutingView>(
        `/api/profiles/${encodeURIComponent(selected.id)}/routing`,
        p.mismatch,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            labels: routingDraft.labels
              .split('\n')
              .map((label) => label.trim())
              .filter(Boolean),
            teams: routingDraft.teams
              .split('\n')
              .map((team) => team.trim())
              .filter(Boolean),
            revision: routing.revision,
          }),
        },
      );
      setRouting(saved);
      setRoutingDraft({
        labels: saved.labels.join('\n'),
        teams: saved.teams.join('\n'),
      });
      setSaved(true);
    } catch (caught) {
      p.error(await apiError(caught, 'Linear routing was not saved.'));
    } finally {
      setSavingRouting(false);
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
  const openWorkflow = async () => {
    if (!selected || p.disabled || openingEditor) return;
    setOpeningEditor(true);
    setEditorOpened(false);
    setEditorError(null);
    try {
      await api(
        `/api/profiles/${encodeURIComponent(selected.id)}/open-workflow`,
        p.mismatch,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ editor }),
        },
      );
      setEditorOpened(true);
    } catch (caught) {
      setEditorError(
        await apiError(caught, 'Could not open the local workflow file.'),
      );
    } finally {
      setOpeningEditor(false);
    }
  };
  if (!profiles)
    return <div className={styles.placeholder}>Loading profiles…</div>;
  if (!draft)
    return (
      <section className={styles.profiles} onChange={() => setSaved(false)}>
        <header className={styles.pageHeader}>
          <div>
            <p className={styles.eyebrow}>Workflow profiles</p>
            <h1>Profiles</h1>
            <p>One workflow, across one or more repositories.</p>
          </div>
        </header>
        <div className={styles.emptyState}>
          <span className={styles.emptyIcon}>
            <Icon name="repo" size={28} />
          </span>
          <h2>Create your first profile</h2>
          <p>Choose the repositories and workflow your agent will use.</p>
          <button
            className={styles.primary}
            onClick={() => void create()}
            disabled={p.disabled || creating}
          >
            <Icon name="plus" />
            {creating ? 'Loading workflow…' : 'Add profile'}
          </button>
        </div>
      </section>
    );
  return (
    <section className={styles.profiles} onChange={() => setSaved(false)}>
      <header className={styles.pageHeader}>
        <div>
          <p className={styles.eyebrow}>Workflow profiles</p>
          <h1>{selected?.id ?? 'New profile'}</h1>
          <p>
            {selected
              ? 'Rocky keeps this configuration locally and runs it in isolated worktrees.'
              : 'Starts with Rocky’s default workflow. Add repositories, then customize it in Workflow.'}
          </p>
        </div>
        <button disabled={p.disabled || creating} onClick={() => void create()}>
          <Icon name="plus" />
          {creating ? 'Loading workflow…' : 'Add profile'}
        </button>
      </header>
      <label>
        Profile
        <select
          value={selected?.id ?? ''}
          onChange={(event) => choose(event.target.value)}
          disabled={p.disabled || creating}
        >
          {!selected && <option value="">New profile</option>}
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.id} ·{' '}
              {profile.repos
                ? `${profile.repos.length} ${profile.repos.length === 1 ? 'repository' : 'repositories'}`
                : profile.remote}
            </option>
          ))}
        </select>
      </label>
      <div
        className={styles.filters}
        role="group"
        aria-label="Profile sections"
      >
        <button
          aria-pressed={tab === 'general'}
          onClick={() => setTab('general')}
        >
          General
        </button>
        <button
          aria-pressed={tab === 'workflow'}
          onClick={() => setTab('workflow')}
        >
          Workflow
        </button>
      </div>
      <div hidden={tab !== 'general'} className={styles.profileGeneral}>
        <div className={styles.sectionHeading}>
          <div>
            <h2>Profile details</h2>
            <p>
              One shared workflow and agent configuration for all member
              repositories.
            </p>
          </div>
        </div>
        <div className={styles.fieldGrid}>
          <label>
            Profile id
            <input
              value={draft.id}
              disabled={p.disabled || Boolean(selected)}
              onChange={(event) =>
                setDraft({ ...draft, id: event.target.value })
              }
              placeholder="my-project"
            />
          </label>
        </div>
        <div className={styles.sectionHeading}>
          <div>
            <h2>Repositories</h2>
            <p>
              Each run creates a fresh worktree for every member in one shared
              folder. The first repository is the default for Git and pull
              request actions.
            </p>
          </div>
          <button
            type="button"
            disabled={p.disabled}
            onClick={() =>
              setDraft({
                ...draft,
                repos: [
                  ...(draft.repos ?? [
                    { name: draft.id, url: draft.remote, baseBranch: 'main' },
                  ]),
                  { name: '', url: '', baseBranch: 'main' },
                ],
              })
            }
          >
            <Icon name="plus" />
            Add repository
          </button>
        </div>
        <div className={styles.profileRepos}>
          {(
            draft.repos ?? [
              { name: draft.id, url: draft.remote, baseBranch: 'main' },
            ]
          ).map((repo, index, repos) => (
            <fieldset
              key={index}
              className={styles.profileRepo}
              disabled={p.disabled}
            >
              <legend>
                {index === 0 ? 'Primary repository' : `Repository ${index + 1}`}
              </legend>
              <div className={styles.repoFields}>
                {(['name', 'url', 'baseBranch'] as const).map((field) => (
                  <label key={field}>
                    {field === 'name'
                      ? 'Folder name'
                      : field === 'url'
                        ? 'Remote URL'
                        : 'Base branch'}
                    <input
                      aria-label={`${field === 'name' ? 'Folder name' : field === 'url' ? 'Remote URL' : 'Base branch'} ${index + 1}`}
                      value={repo[field]}
                      placeholder={
                        field === 'name'
                          ? 'api'
                          : field === 'url'
                            ? 'git@github.com:acme/api.git'
                            : 'main'
                      }
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          repos: repos.map((member, position) =>
                            position === index
                              ? { ...member, [field]: event.target.value }
                              : member,
                          ),
                        })
                      }
                    />
                  </label>
                ))}
              </div>
              <div className={styles.repoActions}>
                {index > 0 && (
                  <button
                    type="button"
                    onClick={() =>
                      setDraft({
                        ...draft,
                        repos: [
                          repo,
                          ...repos.filter((_, position) => position !== index),
                        ],
                      })
                    }
                  >
                    Make primary
                  </button>
                )}
                <button
                  type="button"
                  disabled={repos.length === 1}
                  aria-label={`Remove repository ${index + 1}`}
                  onClick={() =>
                    setDraft({
                      ...draft,
                      repos: repos.filter((_, position) => position !== index),
                    })
                  }
                >
                  Remove
                </button>
              </div>
            </fieldset>
          ))}
        </div>
        <section className={styles.profileRouting}>
          <div className={styles.sectionHeading}>
            <div>
              <p className={styles.eyebrow}>Linear delegation</p>
              <h2>Route issues to this profile</h2>
              <p>
                Delegating an issue with this label starts this profile and all
                of its repositories.
              </p>
            </div>
          </div>
          {selected && routing ? (
            <>
              <label>
                Linear labels (one per line)
                <textarea
                  value={routingDraft.labels}
                  disabled={p.disabled || savingRouting}
                  onChange={(event) =>
                    setRoutingDraft({
                      ...routingDraft,
                      labels: event.target.value,
                    })
                  }
                  placeholder={'product\nproduct-bug'}
                />
              </label>
              <label>
                Allowed Linear teams (optional, one per line)
                <textarea
                  value={routingDraft.teams}
                  disabled={p.disabled || savingRouting}
                  onChange={(event) =>
                    setRoutingDraft({
                      ...routingDraft,
                      teams: event.target.value,
                    })
                  }
                  placeholder="Engineering"
                />
              </label>
              <button
                type="button"
                disabled={
                  p.disabled || savingRouting || !routingDraft.labels.trim()
                }
                onClick={() => void saveRouting()}
              >
                {savingRouting ? 'Saving route…' : 'Save Linear route'}
              </button>
            </>
          ) : (
            <p className={styles.muted}>
              Save this profile first, then choose the Linear label that starts
              it.
            </p>
          )}
        </section>
      </div>
      <div hidden={tab !== 'workflow'} className={styles.profileWorkflow}>
        {tab === 'workflow' && (
          <WorkflowDiagram
            key={selected?.id ?? 'new'}
            profileId={selected?.id}
            revision={selected?.revision}
            unsaved={
              !!selected &&
              (draft.workflow.source !== selected.workflow.source ||
                draft.workflow.triggers.join('\n') !==
                  selected.workflow.triggers.join('\n'))
            }
            disabled={p.disabled}
            mismatch={p.mismatch}
          />
        )}
        <section className={styles.workflowEditor}>
          <div>
            <p className={styles.eyebrow}>Workflow source</p>
            <h2>workflow.ts</h2>
            <p>
              Stored on this machine beside the local profile. Edit it in your
              usual editor, then return here to refresh the configuration.
            </p>
          </div>
          <div className={styles.openWorkflow}>
            <select
              aria-label="Workflow editor"
              value={editor}
              disabled={p.disabled || !selected || openingEditor}
              onChange={(event) => {
                setEditor(event.target.value);
                setEditorOpened(false);
                setEditorError(null);
              }}
            >
              <option value="default">Default text editor</option>
              <option value="vscode">Visual Studio Code</option>
              <option value="zed">Zed</option>
            </select>
            <button
              type="button"
              disabled={p.disabled || !selected || openingEditor}
              aria-busy={openingEditor}
              onClick={() => void openWorkflow()}
            >
              {openingEditor ? 'Opening…' : 'Open workflow'}
            </button>
            {editorOpened && (
              <span className={styles.saved} role="status">
                Workflow sent to your editor.
              </span>
            )}
            {editorError && (
              <p className={styles.error} role="alert">
                {editorError}
              </p>
            )}
          </div>
        </section>
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
        <details className={styles.webEditor}>
          <summary>Edit workflow in browser</summary>
          <label>
            Workflow source
            <textarea
              aria-label="workflow.ts"
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
        </details>
      </div>
      <div hidden={tab !== 'general'} className={styles.profileGeneral}>
        <div className={styles.sectionHeading}>
          <div>
            <h2>Agent & tools</h2>
            <p>The coding agent that executes your workflow.</p>
          </div>
        </div>
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
        <details className={styles.rawResult}>
          <summary>
            Configuration files · {draft.prompts.length} prompts ·{' '}
            {draft.rules.length} rules · {draft.secretEnv.length} secret
            references
          </summary>
          <p className={styles.muted}>
            Prompts: {draft.prompts.join(', ') || 'none'} · Rules:{' '}
            {draft.rules.join(', ') || 'none'} · Secret references:{' '}
            {draft.secretEnv.join(', ') || 'none'}
          </p>
        </details>
      </div>
      <div className={styles.formActions}>
        {saved && (
          <span role="status" className={styles.saved}>
            <Icon name="check" size={15} />
            Profile saved
          </span>
        )}
        <button
          className={styles.primary}
          disabled={
            p.disabled ||
            !draft.id ||
            (draft.repos
              ? draft.repos.length === 0 ||
                draft.repos.some(
                  (repo) =>
                    !repo.name.trim() ||
                    !repo.url.trim() ||
                    !repo.baseBranch.trim(),
                )
              : !draft.remote) ||
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
      </div>
    </section>
  );
}
export default App;

function duration(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60
    ? `${minutes}m ${seconds % 60}s`
    : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function StepMetadata({
  step,
  terminal,
}: {
  step: StepView;
  terminal: boolean;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (terminal || step.status !== 'running') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [terminal, step.status]);
  const elapsed =
    step.ms ?? (!terminal ? now - Date.parse(step.startedAt) : undefined);
  return (
    <dl className={styles.stepMetadata}>
      <div>
        <dt>Started</dt>
        <dd>
          <time dateTime={step.startedAt}>
            {new Date(step.startedAt).toLocaleString()}
          </time>
        </dd>
      </div>
      <div>
        <dt>Duration</dt>
        <dd>
          {elapsed === undefined ? 'Not recorded' : duration(elapsed)}
          {step.status === 'running' && !terminal ? ' · running' : ''}
        </dd>
      </div>
      {step.ms !== undefined && (
        <div>
          <dt>{step.status === 'waiting' ? 'Parked at' : 'Finished'}</dt>
          <dd>
            {new Date(Date.parse(step.startedAt) + step.ms).toLocaleString()}
          </dd>
        </div>
      )}
      <div>
        <dt>Boot / attempts</dt>
        <dd>
          {step.boot} / {step.attempts.length + 1}
        </dd>
      </div>
      {step.step === 'agent' && (
        <>
          <div>
            <dt>Harness</dt>
            <dd>{step.agent?.harness ?? 'Not recorded'}</dd>
          </div>
          <div>
            <dt>Model</dt>
            <dd>
              {step.agent?.model ??
                (step.agent
                  ? 'Harness default (not reported)'
                  : 'Not recorded')}
            </dd>
          </div>
          <div>
            <dt>Model variant / effort</dt>
            <dd>
              {step.agent?.variant ?? (step.agent ? 'Default' : 'Not recorded')}
            </dd>
          </div>
          {step.agent && (
            <>
              <div>
                <dt>Tools</dt>
                <dd>{step.agent.tools.join(', ') || 'None'}</dd>
              </div>
              <div>
                <dt>MCP servers</dt>
                <dd>{step.agent.mcp.join(', ') || 'None'}</dd>
              </div>
              <div>
                <dt>Timeout</dt>
                <dd>{duration(step.agent.timeoutMs)}</dd>
              </div>
            </>
          )}
        </>
      )}
    </dl>
  );
}
