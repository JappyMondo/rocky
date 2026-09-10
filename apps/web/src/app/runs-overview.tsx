import type { Dispatch, SetStateAction } from 'react';
import type { RunSummary } from '@rocky/local-contracts';
import { Icon, Status, dateLabel } from './ui.js';
import styles from './app.module.css';

const filters = [
  'All runs',
  'In progress',
  'Needs review',
  'Completed',
  'Failed',
] as const;
type Filter = (typeof filters)[number];
export type RunsViewState = { filter: Filter; query: string; page: number };
const matches = (run: RunSummary, filter: Filter) =>
  filter === 'All runs' ||
  (filter === 'In progress'
    ? ['running', 'queued'].includes(run.status)
    : filter === 'Needs review'
      ? run.status === 'parked'
      : filter === 'Completed'
        ? run.status === 'finished'
        : run.status === 'failed');

export function RunsOverview({
  runs,
  loading,
  start,
  openRun,
  repository,
  onRepository,
  view,
  setView,
}: {
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
  const setFilter = (filter: Filter) =>
    setView((view) => ({ ...view, filter }));
  const setQuery = (query: string) => setView((view) => ({ ...view, query }));
  const setPage = (page: number) => setView((view) => ({ ...view, page }));
  const repositories = [...new Set(runs.map((run) => run.repo))].sort();
  const scoped = runs.filter((run) => !repository || run.repo === repository);
  const filtered = scoped.filter(
    (run) =>
      matches(run, filter) &&
      `${run.issue.identifier} ${run.issue.title} ${run.repo} ${run.runId} ${run.branch} ${run.trigger ?? ''}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const pages = Math.max(1, Math.ceil(filtered.length / 10));
  const currentPage = Math.min(page, pages - 1);
  const shown = filtered.slice(currentPage * 10, currentPage * 10 + 10);
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
            <strong>{loading ? '—' : scoped.length}</strong>
            <small>Total runs</small>
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
                : scoped.filter((r) => matches(r, 'Needs review')).length}
            </strong>
            <small>Need your review</small>
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
                  setFilter('All runs');
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
            <div className={styles.runTable} role="table" aria-label="Runs">
              <div className={styles.tableHeader} role="row">
                <span role="columnheader">Issue / run</span>
                <span role="columnheader">Status</span>
                <span role="columnheader">Repository</span>
                <span role="columnheader">Started</span>
                <span role="columnheader" className={styles.srOnly}>
                  Open
                </span>
              </div>
              {shown.map((run) => (
                <div role="row" key={run.runId} className={styles.tableRow}>
                  <div role="cell" className={styles.issueCell}>
                    <button onClick={() => openRun(run.runId)}>
                      <span className={styles.issueMeta}>
                        {run.issue.identifier}
                        <span> / {run.runId}</span>
                      </span>
                      <strong>{run.issue.title}</strong>
                    </button>
                  </div>
                  <div role="cell">
                    <Status value={run.status} />
                  </div>
                  <div role="cell" className={styles.repoCell}>
                    <Icon name="repo" size={15} />
                    <span>{run.repo}</span>
                  </div>
                  <div role="cell" className={styles.dateCell}>
                    <time dateTime={run.createdAt}>
                      {dateLabel(run.createdAt)}
                    </time>
                  </div>
                  <div role="cell">
                    <button
                      className={styles.iconButton}
                      aria-label={`Open run ${run.runId}`}
                      onClick={() => openRun(run.runId)}
                    >
                      <Icon name="arrow" size={16} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <footer className={styles.tableFooter}>
              <span>
                {currentPage * 10 + 1}–
                {Math.min((currentPage + 1) * 10, filtered.length)} of{' '}
                {filtered.length} runs
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
