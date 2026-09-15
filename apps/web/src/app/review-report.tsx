import { useEffect, useId, useRef, useState } from 'react';
import type { ReviewReport, RunDetail } from '@rocky/local-contracts';
import { api, apiError } from './api.js';
import { Chart } from './workflow-diagram.js';
import { Dialog } from './ui.js';
import styles from './app.module.css';

export function ReviewReports({ detail }: { detail: RunDetail }) {
  const [selected, setSelected] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get('report'),
  );
  const [report, setReport] = useState<ReviewReport>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    setReport(undefined);
    setError(undefined);
    void api<ReviewReport>(
      `/api/runs/${encodeURIComponent(detail.run.runId)}/reports/${encodeURIComponent(selected)}`,
      () => undefined,
      { signal: controller.signal },
    )
      .then((value) => {
        if (!controller.signal.aborted) setReport(value);
      })
      .catch(async (error) => {
        const message = await apiError(error, 'Could not load the report.');
        if (!controller.signal.aborted) setError(message);
      });
    return () => controller.abort();
  }, [selected, detail.run.runId]);
  const open = (id: string | null) => {
    setSelected(id);
    const url = new URL(window.location.href);
    if (id) url.searchParams.set('report', id);
    else url.searchParams.delete('report');
    window.history.replaceState({}, '', url);
  };
  return (
    <>
      {!!detail.reports?.length && (
        <section
          className={styles.reportLinks}
          aria-label="Visual review reports"
        >
          <h2>Visual review reports</h2>
          <p>
            What changed, why it matters, and the evidence for each revision.
          </p>
          {[...detail.reports]
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
            .map((item) => (
              <button key={item.id} onClick={() => open(item.id)}>
                <strong>{item.title}</strong>
                <span>
                  {item.pr
                    ? `${item.pr.repo} #${item.pr.number} · ${item.pr.headSha.slice(0, 8)}`
                    : 'Deliverable recap'}
                </span>
              </button>
            ))}
        </section>
      )}
      {selected && (
        <div className={styles.reportModal}>
          <Dialog title="Visual review report" onClose={() => open(null)}>
            {error && <p role="alert">{error}</p>}
            {!report && !error && <p role="status">Loading report…</p>}
            {report && <ReportReader key={report.id} report={report} />}
          </Dialog>
        </div>
      )}
    </>
  );
}

const decisionLabels = {
  ready: 'Ready for review',
  'needs-attention': 'Needs attention',
  blocked: 'Blocked',
};
const requirementLabels = {
  supported: 'Supported',
  gap: 'Missing',
  unverified: 'Not confirmed',
  waived: 'Skipped as agreed',
};

function Evidence({
  items,
  title = 'Evidence',
}: {
  items: string[];
  title?: string;
}) {
  if (!items.length) return null;
  return (
    <details className={styles.reportEvidence}>
      <summary>{title}</summary>
      <ul>
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </details>
  );
}

export function ReportReader({
  report,
  standalone = false,
  screenshotUrl = (id) => `/api/screenshots/${encodeURIComponent(id)}`,
}: {
  report: ReviewReport;
  standalone?: boolean;
  screenshotUrl?: (id: string) => string;
}) {
  const pages = [
    { id: 'goal', label: 'Goal', title: 'The goal' },
    { id: 'changes', label: 'Changes', title: 'What changes in practice' },
    ...(report.visuals.length
      ? [{ id: 'visuals', label: 'Screenshots', title: 'See the result' }]
      : []),
    ...report.diagrams.map((diagram, i) => ({
      id: `diagram-${i}`,
      label: i === 0 ? 'How it works' : diagram.title,
      title: diagram.title,
    })),
    ...(report.requirements?.length
      ? [
          {
            id: 'requirements',
            label: 'Requirements',
            title: 'Does it meet the requirements?',
          },
        ]
      : []),
    {
      id: 'checks',
      label: 'Risks & checks',
      title: 'What needs a closer look',
    },
    { id: 'decision', label: 'Decision', title: 'The decision' },
  ];
  const [active, setActive] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const page = pages[active];
  const pageId = useId();
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    if (standalone) window.scrollTo({ top: 0 });
    else heading.current?.closest('[role="dialog"]')?.scrollTo?.({ top: 0 });
  }, [active, standalone]);
  const attention =
    report.reviewFocus?.filter((f) => f.status === 'attention') ?? [];
  const otherChecks =
    report.reviewFocus?.filter(
      (f) => f.status !== 'attention' && f.category !== 'testing',
    ) ?? [];
  const testing = report.reviewFocus?.find(
    (f) => f.category === 'testing' && f.status !== 'attention',
  );
  return (
    <article className={styles.reviewReport}>
      <header className={styles.reportReaderHeader}>
        <div>
          <p className={styles.eyebrow}>
            {report.pr
              ? `${report.pr.repo} · #${report.pr.number}`
              : 'Deliverable recap'}
          </p>
          <h1>{report.title}</h1>
        </div>
        {report.decision && (
          <button
            className={styles.reportDecisionBadge}
            onClick={() => setActive(pages.length - 1)}
          >
            {decisionLabels[report.decision.status]}
          </button>
        )}
      </header>
      <nav aria-label="Review steps" className={styles.reportSteps}>
        {pages.map((item, i) => (
          <button
            key={item.id}
            aria-current={active === i ? 'step' : undefined}
            aria-controls={pageId}
            onClick={() => setActive(i)}
          >
            <span aria-hidden="true">{i + 1}</span>
            {item.label}
          </button>
        ))}
      </nav>
      <section
        id={pageId}
        aria-labelledby={`${pageId}-title`}
        className={styles.reportPage}
      >
        <p className={styles.eyebrow}>
          Step {active + 1} of {pages.length}
        </p>
        <h2 id={`${pageId}-title`} ref={heading} tabIndex={-1}>
          {page.title}
        </h2>
        {page.id === 'goal' && (
          <>
            <p className={styles.reportLead}>{report.goal ?? report.summary}</p>
            {!report.goal && (
              <Evidence
                title="Original problem"
                items={report.problems.map((p) => p.problem)}
              />
            )}
          </>
        )}
        {page.id === 'changes' && (
          <>
            <p className={styles.reportLead}>{report.summary}</p>
            {report.ui?.changed && <p>{report.ui.summary}</p>}
            <div
              className={styles.reportScenarios}
              aria-label="Behavior changes"
            >
              {report.behavior?.map((item, i) => (
                <article key={i}>
                  <h3>{item.scenario}</h3>
                  <div className={styles.reportBeforeAfter}>
                    <div>
                      <span className={styles.eyebrow}>Before</span>
                      <p>{item.before}</p>
                    </div>
                    <span className={styles.reportArrow} aria-hidden="true">
                      →
                    </span>
                    <div>
                      <span className={styles.eyebrow}>After</span>
                      <p>{item.after}</p>
                    </div>
                  </div>
                  <Evidence items={item.evidence} />
                </article>
              ))}
            </div>
            {!report.behavior?.length &&
              report.problems.map((p, i) => (
                <article key={i}>
                  <h3>{p.problem}</h3>
                  <p>{p.solution}</p>
                </article>
              ))}
            {report.deliverable && (
              <details>
                <summary>Delivered result</summary>
                <p>{report.deliverable}</p>
              </details>
            )}
          </>
        )}
        {page.id === 'visuals' && (
          <div className={styles.visualGrid}>
            {report.visuals.map((v, i) => (
              <article key={i}>
                <p className={styles.eyebrow}>{v.group}</p>
                <h3>{v.variant}</h3>
                <p>{v.description}</p>
                {v.status === 'unavailable' ? (
                  <p className={styles.warning}>Not captured: {v.reason}</p>
                ) : (
                  v.screenshots.map((shot) => (
                    <figure key={shot.id}>
                      <a
                        href={screenshotUrl(shot.id)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <img
                          src={screenshotUrl(shot.id)}
                          alt={shot.caption}
                          loading="lazy"
                        />
                      </a>
                      <figcaption>{shot.caption}</figcaption>
                    </figure>
                  ))
                )}
              </article>
            ))}
          </div>
        )}
        {page.id.startsWith('diagram-') &&
          (() => {
            const diagram =
              report.diagrams[Number(page.id.slice('diagram-'.length))];
            return (
              <article>
                <p>{diagram.description}</p>
                <Chart source={diagram.mermaid} readable />
                <details>
                  <summary>Diagram source</summary>
                  <pre>{diagram.mermaid}</pre>
                </details>
              </article>
            );
          })()}
        {page.id === 'requirements' && (
          <>
            <p>
              Expand a requirement to see the original wording and what supports
              it.
            </p>
            <div className={styles.reportChecklist}>
              {report.requirements?.map((item, i) => (
                <details key={i}>
                  <summary>
                    <span>{item.label ?? item.criterion}</span>
                    <span
                      className={styles.reportRequirementStatus}
                      data-status={item.status}
                    >
                      {requirementLabels[item.status]}
                    </span>
                  </summary>
                  {item.label && <p>{item.criterion}</p>}
                  <ul>
                    {item.evidence.map((e, j) => (
                      <li key={j}>{e}</li>
                    ))}
                  </ul>
                </details>
              ))}
            </div>
            <p className={styles.reportFootnote}>
              “Supported” means the evidence supports the change. Open the
              details to see what was actually tested.
            </p>
          </>
        )}
        {page.id === 'checks' && (
          <>
            {testing && (
              <article className={styles.reportFocus}>
                <h3>{testing.title}</h3>
                <p>{testing.summary}</p>
                <Evidence items={testing.evidence} />
              </article>
            )}
            <div className={styles.reportFocusGrid}>
              {attention.map((focus, i) => (
                <article key={i} className={styles.reportAttention}>
                  <h3>{focus.title}</h3>
                  <p>{focus.summary}</p>
                  <Evidence items={focus.evidence} />
                </article>
              ))}
            </div>
            {!!report.limitations.length && (
              <aside className={styles.reportCaveats}>
                <h3>What is still unknown or was skipped</h3>
                <ul>
                  {report.limitations.map((v, i) => (
                    <li key={i}>{v}</li>
                  ))}
                </ul>
              </aside>
            )}
            <Evidence title="Check results" items={report.verification} />
            {!!otherChecks.length && (
              <details className={styles.reportEvidence}>
                <summary>Other review checks ({otherChecks.length})</summary>
                {otherChecks.map((focus, i) => (
                  <article key={i}>
                    <h3>{focus.title}</h3>
                    <p>{focus.summary}</p>
                    <Evidence items={focus.evidence} />
                  </article>
                ))}
              </details>
            )}
          </>
        )}
        {page.id === 'decision' && (
          <>
            {report.decision ? (
              <div
                className={styles.reportAttention}
                aria-label="Review decision"
              >
                <p className={styles.eyebrow}>
                  {decisionLabels[report.decision.status]}
                </p>
                <p className={styles.reportLead}>{report.decision.summary}</p>
                {!!report.decision.actions.length && (
                  <>
                    <h3>Next steps</h3>
                    <ul>
                      {report.decision.actions.map((action, i) => (
                        <li key={i}>{action}</li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            ) : (
              <p>{report.summary}</p>
            )}
            {!!report.pullRequests?.length ? (
              <ul aria-label="Pull requests">
                {report.pullRequests.map((pr) => (
                  <li key={pr.repo}>
                    <a href={pr.url} target="_blank" rel="noreferrer">
                      {pr.repo} #{pr.number}
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              report.pr && (
                <p>
                  <a href={report.pr.url} target="_blank" rel="noreferrer">
                    Open pull request
                  </a>
                </p>
              )
            )}
            <details className={styles.reportEvidence}>
              <summary>Report details</summary>
              <p>
                {report.pr && (
                  <>
                    Revision <code>{report.pr.headSha}</code> ·{' '}
                  </>
                )}
                <time dateTime={report.createdAt}>
                  {new Date(report.createdAt).toLocaleString()}
                </time>
              </p>
            </details>
            {!!report.keyChanges?.length && (
              <details className={styles.reportEvidence}>
                <summary>Technical changes and source diffs</summary>
                {!!report.files?.length && (
                  <ul className={styles.reportFiles}>
                    {report.files.map((file, i) => (
                      <li key={i}>
                        <code>{file.path}</code>
                        <span>{file.status}</span>
                      </li>
                    ))}
                  </ul>
                )}
                <KeyChanges changes={report.keyChanges} />
              </details>
            )}
          </>
        )}
      </section>
      <footer
        className={styles.reportNavigation}
        aria-label="Review navigation"
      >
        <button disabled={active === 0} onClick={() => setActive(active - 1)}>
          Back
        </button>
        <span>
          {active + 1} / {pages.length}
        </span>
        {active < pages.length - 1 ? (
          <button onClick={() => setActive(active + 1)}>
            Next: {pages[active + 1].label} →
          </button>
        ) : (
          <button onClick={() => setActive(0)}>Back to goal</button>
        )}
      </footer>
    </article>
  );
}

function KeyChanges({
  changes,
}: {
  changes: NonNullable<ReviewReport['keyChanges']>;
}) {
  const [active, setActive] = useState(0);
  const id = useId();
  const change = changes[active] ?? changes[0];
  return (
    <section>
      <h2>Key changes</h2>
      <div
        role="tablist"
        aria-label="Key changes"
        className={styles.reportTabs}
      >
        {changes.map((item, i) => (
          <button
            key={i}
            role="tab"
            id={`${id}-tab-${i}`}
            aria-controls={`${id}-panel`}
            aria-selected={active === i}
            tabIndex={active === i ? 0 : -1}
            onClick={() => setActive(i)}
            onKeyDown={(event) => {
              const next =
                event.key === 'ArrowRight'
                  ? (i + 1) % changes.length
                  : event.key === 'ArrowLeft'
                    ? (i - 1 + changes.length) % changes.length
                    : event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? changes.length - 1
                        : undefined;
              if (next === undefined) return;
              event.preventDefault();
              setActive(next);
              document.getElementById(`${id}-tab-${next}`)?.focus();
            }}
          >
            {item.title}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`${id}-panel`}
        aria-labelledby={`${id}-tab-${active}`}
        tabIndex={0}
        className={styles.reportChange}
      >
        <h3>{change.title}</h3>
        <p>{change.summary}</p>
        <ul className={styles.reportChangeFiles}>
          {change.files.map((file, i) => (
            <li key={i}>
              <code>{file}</code>
            </li>
          ))}
        </ul>
        {change.diff ? (
          <details>
            <summary>Inspect source diff</summary>
            <pre className={styles.reportDiff} aria-label="Key code diff">
              <code>
                {change.diff.split('\n').map((line, i) => (
                  <span
                    key={i}
                    className={
                      line.startsWith('@@') ||
                      line.startsWith('diff ') ||
                      line.startsWith('+++') ||
                      line.startsWith('---')
                        ? styles.reportDiffHeader
                        : line.startsWith('+')
                          ? styles.reportDiffAdded
                          : line.startsWith('-')
                            ? styles.reportDiffRemoved
                            : undefined
                    }
                  >
                    {line}
                    {'\n'}
                  </span>
                ))}
              </code>
            </pre>
          </details>
        ) : (
          <p>No code diff for this change.</p>
        )}
        {!!change.annotations.length && (
          <aside aria-label="Code review notes">
            <h4>Code review notes</h4>
            <ul>
              {change.annotations.map((note, i) => (
                <li key={i}>
                  <code>
                    {note.file}
                    {note.line !== undefined ? `:${note.line}` : ''}
                  </code>{' '}
                  — {note.text}
                </li>
              ))}
            </ul>
          </aside>
        )}
      </div>
    </section>
  );
}
