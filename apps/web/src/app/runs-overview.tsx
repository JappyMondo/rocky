import { useState, type Dispatch, type SetStateAction } from 'react';
import { groupRuns } from './run-groups.js';
import type { RunSummary } from '@rocky/local-contracts';
import { Icon, Status, dateLabel } from './ui.js';
import styles from './app.module.css';
import { isTerminalRun, runState } from './run-presentation.js';

const filters = [
  'Unsettled',
  'All runs',
  'Settled',
  'In progress',
  'Needs input',
  'Waiting',
  'Completed',
  'Failed',
  'Cancelled',
] as const;
type Filter = (typeof filters)[number];
export type RunsViewState = { filter: Filter; query: string; page: number };
const matches = (run: RunSummary, filter: Filter) => {
  const state = runState(run).value;
  return (
    filter === 'All runs' ||
    (filter === 'Settled'
      ? Boolean(run.settledAt)
      : !run.settledAt &&
        (filter === 'Unsettled' ||
          (filter === 'In progress'
            ? ['running', 'queued'].includes(state)
            : filter === 'Needs input'
              ? state === 'parked'
              : filter === 'Waiting'
                ? state === 'waiting'
                : filter === 'Completed'
                  ? state === 'finished'
                  : filter === 'Cancelled'
                    ? state === 'cancelled'
                    : state === 'failed')))
  );
};

export function RunsOverview({
  runs,
  loading,
  start,
  openRun,
  repository,
  onRepository,
  view,
  setView,
  settle,
  disabled,
}: {
  settle: (id: string, settled: boolean) => Promise<void>;
  disabled: boolean;
  runs: RunSummary[];
  loading: boolean;
  start: () => void;
  openRun: (id: string) => void;
  repository: string;
  onRepository: (repo: string) => void;
  view: RunsViewState;
  setView: Dispatch<SetStateAction<RunsViewState>>;
}) {
  const { filter, query, page } = view;
  const [pending, setPending] = useState<string[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const changeSettled = async (run: RunSummary) => {
    setPending((ids) => [...ids, run.runId]);
    setFailure(null);
    try {
      await settle(run.runId, !run.settledAt);
    } catch (error) {
      setFailure(
        error instanceof Error ? error.message : 'Could not save. Try again.',
      );
    } finally {
      setPending((ids) => ids.filter((id) => id !== run.runId));
    }
  };
  const setFilter = (filter: Filter) =>
    setView((view) => ({ ...view, filter }));
  const setQuery = (query: string) => setView((view) => ({ ...view, query }));
  const setPage = (page: number) => setView((view) => ({ ...view, page }));
  const repositories = [
    ...new Set(runs.flatMap((run) => run.repos ?? [run.repo])),
  ].sort();
  const scoped = runs.filter(
    (run) => !repository || (run.repos ?? [run.repo]).includes(repository),
  );
  const groups = groupRuns(scoped);
  const filtered = groups
    .map((group) => ({
      ...group,
      visible: group.attempts.filter(
        (run) =>
          filter === 'All runs' ||
          (filter === 'Settled' ? !!run.settledAt : !run.settledAt),
      ),
    }))
    .filter((group) =>
      group.visible.some(
        (run) =>
          matches(run, filter) &&
          `${run.issue.identifier} ${run.issue.title} ${(run.repos ?? [run.repo]).join(' ')} ${run.profileId ?? ''} ${run.runId} ${run.branch} ${run.trigger ?? ''}`
            .toLowerCase()
            .includes(query.toLowerCase()),
      ),
    );
  const pages = Math.max(1, Math.ceil(filtered.length / 10));
  const currentPage = Math.min(page, pages - 1);
  const shown = filtered.slice(currentPage * 10, currentPage * 10 + 10);
  const row = (
    run: RunSummary,
    latest: RunSummary,
    group?: ReturnType<typeof groupRuns>[number],
  ) => (
    <div
      key={run.runId}
      className={group ? styles.ticketHeader : styles.attemptRow}
    >
      {group ? (
        <div className={styles.ticketIdentity}>
          <span className={styles.issueMeta}>
            {latest.issue.identifier} / {run.runId} ·{' '}
            {run.runId === latest.runId
              ? 'Latest attempt'
              : `Earlier attempt · latest ${latest.runId}`}{' '}
            · {group.attempts.length}{' '}
            {group.attempts.length === 1 ? 'attempt' : 'attempts'}
          </span>
          <h2 aria-label={latest.issue.title}>
            <button
              onClick={() => openRun(run.runId)}
              aria-label={`Open run ${run.runId}`}
            >
              {latest.issue.title}
            </button>
          </h2>
          <span className={styles.ticketRepo}>
            {[
              ...new Set(
                group.attempts.flatMap(
                  (attempt) => attempt.repos ?? [attempt.repo],
                ),
              ),
            ].join(', ')}
          </span>
        </div>
      ) : (
        <button
          className={styles.attemptLink}
          onClick={() => openRun(run.runId)}
          aria-label={`Open run ${run.runId}`}
        >
          <strong>{run.runId}</strong>
          <small>
            {run.runId === latest.runId
              ? 'Latest attempt'
              : `Earlier attempt · latest ${latest.runId}`}
          </small>
        </button>
      )}
      <Status {...runState(run)} />
      <time dateTime={run.createdAt}>{dateLabel(run.createdAt)}</time>
      {run.settledAt && <span className={styles.settledBadge}>Settled</span>}
      {isTerminalRun(run.status) && (
        <button
          disabled={disabled || pending.includes(run.runId)}
          onClick={() => void changeSettled(run)}
          aria-label={`${run.settledAt ? 'Restore' : 'Settle'} run ${run.runId}`}
        >
          {pending.includes(run.runId)
            ? 'Saving…'
            : run.settledAt
              ? 'Restore'
              : 'Settle'}
        </button>
      )}
    </div>
  );
  return (
    <section className={styles.overview}>
      <header className={styles.pageHeader}>
        <div>
          <p className={styles.eyebrow}>Your workspace</p>
          <h1>Runs</h1>
          <p>Keep work moving. Step in when you’re needed.</p>
        </div>
        <button className={styles.primary} onClick={start}>
          <Icon name="plus" />
          New run
        </button>
      </header>
      <div className={styles.summaryStrip}>
        <div>
          <span className={styles.summaryIcon}>
            <Icon name="runs" />
          </span>
          <span>
            <strong>
              {loading ? '—' : scoped.filter((run) => !run.settledAt).length}
            </strong>
            <small>Unsettled runs</small>
          </span>
        </div>
        <div>
          <span className={styles.summaryIcon} data-tone="blue">
            <Icon name="clock" />
          </span>
          <span>
            <strong>
              {loading
                ? '—'
                : scoped.filter((r) => matches(r, 'In progress')).length}
            </strong>
            <small>In progress</small>
          </span>
        </div>
        <div>
          <span className={styles.summaryIcon} data-tone="amber">
            <Icon name="pause" />
          </span>
          <span>
            <strong>
              {loading
                ? '—'
                : scoped.filter((r) => matches(r, 'Needs input')).length}
            </strong>
            <small>Need your input</small>
          </span>
        </div>
        <div>
          <span className={styles.summaryIcon} data-tone="green">
            <Icon name="check" />
          </span>
          <span>
            <strong>
              {loading
                ? '—'
                : scoped.filter((r) => matches(r, 'Completed')).length}
            </strong>
            <small>Completed</small>
          </span>
        </div>
      </div>
      {failure && <p role="alert">{failure}</p>}
      <div className={styles.runPanel}>
        <div
          className={styles.filters}
          role="group"
          aria-label="Filter runs by status"
        >
          {filters.map((item) => (
            <button
              key={item}
              aria-pressed={filter === item}
              onClick={() => {
                setFilter(item);
                setPage(0);
              }}
            >
              {item}
              <span>{scoped.filter((run) => matches(run, item)).length}</span>
            </button>
          ))}
        </div>
        <div className={styles.toolbar}>
          <label className={styles.search}>
            <Icon name="search" />
            <input
              aria-label="Search runs"
              placeholder="Search issues, runs, or branches…"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(0);
              }}
            />
            {query && (
              <button
                className={styles.iconButton}
                aria-label="Clear search"
                onClick={() => {
                  setQuery('');
                  setPage(0);
                }}
              >
                <Icon name="close" size={14} />
              </button>
            )}
          </label>
          <select
            aria-label="Filter by repository"
            value={repository}
            onChange={(e) => {
              onRepository(e.target.value);
              setPage(0);
            }}
          >
            <option value="">All repositories</option>
            {repositories.map((repo) => (
              <option key={repo}>{repo}</option>
            ))}
          </select>
        </div>
        {loading ? (
          <div className={styles.placeholder} role="status">
            Loading your runs…
          </div>
        ) : !filtered.length ? (
          <div className={styles.emptyState}>
            <span className={styles.emptyIcon}>
              <Icon name={runs.length ? 'search' : 'runs'} size={28} />
            </span>
            <h2>{runs.length ? 'No matching runs' : 'Ready when you are.'}</h2>
            <p>
              {runs.length
                ? 'Try another search or filter to find your work.'
                : 'Delegate a Linear issue to Rocky, or start a run here.'}
            </p>
            {runs.length ? (
              <button
                onClick={() => {
                  setQuery('');
                  setFilter('Unsettled');
                  onRepository('');
                  setPage(0);
                }}
              >
                Clear filters
              </button>
            ) : (
              <button className={styles.primary} onClick={start}>
                <Icon name="plus" />
                Start your first run
              </button>
            )}
          </div>
        ) : (
          <>
            <div className={styles.runTable} role="list" aria-label="Tickets">
              {shown.map((group) => (
                <section
                  key={group.key}
                  className={styles.ticketGroup}
                  role="listitem"
                  aria-label={`Ticket ${group.latest.issue.identifier}`}
                >
                  {row(group.visible[0], group.latest, group)}
                  {group.visible.length > 1 && (
                    <details
                      className={styles.attemptHistory}
                      open={query.trim() ? true : undefined}
                    >
                      <summary>
                        {group.visible.length - 1} earlier{' '}
                        {group.visible.length === 2 ? 'attempt' : 'attempts'}
                      </summary>
                      {group.visible
                        .slice(1)
                        .map((run) => row(run, group.latest))}
                    </details>
                  )}
                  {group.visible.length < group.attempts.length && (
                    <p className={styles.hiddenAttempts}>
                      {group.attempts.length - group.visible.length}{' '}
                      {filter === 'Settled' ? 'unsettled' : 'settled'}{' '}
                      {group.attempts.length - group.visible.length === 1
                        ? 'attempt'
                        : 'attempts'}{' '}
                      hidden.{' '}
                      <button
                        onClick={() => {
                          setQuery(group.latest.issue.identifier);
                          setFilter('All runs');
                          setPage(0);
                        }}
                      >
                        Show all attempts
                      </button>
                    </p>
                  )}
                </section>
              ))}
            </div>
            <footer className={styles.tableFooter}>
              <span>
                {currentPage * 10 + 1}–
                {Math.min((currentPage + 1) * 10, filtered.length)} of{' '}
                {filtered.length} tickets
              </span>
              <div>
                <button
                  className={styles.iconButton}
                  aria-label="Previous page"
                  disabled={currentPage === 0}
                  onClick={() => setPage(currentPage - 1)}
                >
                  <Icon name="back" size={16} />
                </button>
                <span>
                  Page {currentPage + 1} of {pages}
                </span>
                <button
                  className={styles.iconButton}
                  aria-label="Next page"
                  disabled={currentPage + 1 >= pages}
                  onClick={() => setPage(currentPage + 1)}
                >
                  <Icon name="arrow" size={16} />
                </button>
              </div>
            </footer>
          </>
        )}
      </div>
      <p className={styles.overviewHint}>
        <span className={styles.dot + ' ' + styles.finished} />
        {loading ? 'Connecting to your workspace' : 'Updates automatically'}
        <span>Built locally. Working alongside you.</span>
      </p>
    </section>
  );
}
