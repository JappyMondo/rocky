import { useEffect, useId, useState } from 'react';
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
          {detail.reports.map((item) => (
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
            {report && (
              <article className={styles.reviewReport}>
                <header>
                  <p className={styles.eyebrow}>
                    {report.pr
                      ? `${report.pr.repo} · #${report.pr.number}`
                      : 'Deliverable recap'}
                  </p>
                  <h1>{report.title}</h1>
                  <p>{report.summary}</p>
                  <p>
                    {report.pr && (
                      <>
                        <a
                          href={report.pr.url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Open pull request
                        </a>{' '}
                        · Revision <code>{report.pr.headSha.slice(0, 12)}</code>{' '}
                        ·{' '}
                      </>
                    )}
                    <time dateTime={report.createdAt}>
                      {new Date(report.createdAt).toLocaleString()}
                    </time>
                  </p>
                </header>
                <div
                  className={styles.reportOverview}
                  aria-label="Recap at a glance"
                >
                  <span>
                    <strong>
                      {report.keyChanges?.length ?? report.problems.length}
                    </strong>{' '}
                    key changes
                  </span>
                  <span>
                    <strong>{report.files?.length ?? '—'}</strong> changed files
                  </span>
                  <span>
                    <strong>
                      {
                        report.visuals.filter((v) => v.status === 'captured')
                          .length
                      }
                      /{report.visuals.length}
                    </strong>{' '}
                    inventoried UI variants captured
                  </span>
                  <span>
                    <strong>
                      {report.reviewFocus?.filter(
                        (f) => f.status === 'attention',
                      ).length ?? '—'}
                    </strong>{' '}
                    review priorities
                  </span>
                </div>
                {!!report.keyChanges?.length && (
                  <KeyChanges changes={report.keyChanges} />
                )}
                {report.deliverable && (
                  <section>
                    <h2>Delivered result</h2>
                    <p>{report.deliverable}</p>
                  </section>
                )}
                {!!report.reviewFocus?.length && (
                  <section>
                    <h2>Where to focus your review</h2>
                    <div className={styles.reportFocusGrid}>
                      {report.reviewFocus.map((focus, i) => (
                        <article
                          key={i}
                          className={
                            focus.status === 'attention'
                              ? styles.reportAttention
                              : styles.reportFocus
                          }
                        >
                          <p className={styles.eyebrow}>
                            {focus.category} ·{' '}
                            {focus.status.replaceAll('-', ' ')}
                          </p>
                          <h3>{focus.title}</h3>
                          <p>{focus.summary}</p>
                          <ul>
                            {focus.evidence.map((evidence, j) => (
                              <li key={j}>{evidence}</li>
                            ))}
                          </ul>
                        </article>
                      ))}
                    </div>
                  </section>
                )}
                {!!report.files?.length && (
                  <section>
                    <h2>Change footprint</h2>
                    <ul className={styles.reportFiles}>
                      {report.files.map((file, i) => (
                        <li key={i}>
                          <code>{file.path}</code>
                          <span>{file.status}</span>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
                <section>
                  <h2>Problems solved</h2>
                  {report.problems.map((p, i) => (
                    <div key={i}>
                      <h3>{p.problem}</h3>
                      <p>{p.solution}</p>
                    </div>
                  ))}
                </section>
                {!!report.diagrams.length && (
                  <section>
                    <h2>How processing changed</h2>
                    {report.diagrams.map((d, i) => (
                      <div key={i}>
                        <h3>{d.title}</h3>
                        <p>{d.description}</p>
                        <Chart source={d.mermaid} />
                        <details>
                          <summary>Diagram source</summary>
                          <pre>{d.mermaid}</pre>
                        </details>
                      </div>
                    ))}
                  </section>
                )}
                {!!report.visuals.length && (
                  <section>
                    <h2>Visual evidence</h2>
                    <p>
                      {
                        report.visuals.filter((v) => v.status === 'captured')
                          .length
                      }{' '}
                      of {report.visuals.length} inventoried variants captured.
                      Open an image to inspect it at full size. Unavailable
                      variants are listed with their reason.
                    </p>
                    {[...new Set(report.visuals.map((v) => v.group))].map(
                      (group) => (
                        <section key={group}>
                          <h3>{group}</h3>
                          <div className={styles.visualGrid}>
                            {report.visuals
                              .filter((v) => v.group === group)
                              .map((v, i) => (
                                <article key={i}>
                                  <h4>{v.variant}</h4>
                                  <p>{v.description}</p>
                                  {v.status === 'unavailable' ? (
                                    <p className={styles.warning}>
                                      Not captured: {v.reason}
                                    </p>
                                  ) : (
                                    v.screenshots.map((shot) => (
                                      <figure key={shot.id}>
                                        <a
                                          href={`/api/screenshots/${encodeURIComponent(shot.id)}`}
                                          target="_blank"
                                          rel="noreferrer"
                                        >
                                          <img
                                            src={`/api/screenshots/${encodeURIComponent(shot.id)}`}
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
                        </section>
                      ),
                    )}
                  </section>
                )}
                <section>
                  <h2>Verification</h2>
                  <ul>
                    {report.verification.map((v, i) => (
                      <li key={i}>{v}</li>
                    ))}
                  </ul>
                </section>
                {!!report.limitations.length && (
                  <section className={styles.warning}>
                    <h2>Review limitations</h2>
                    <ul>
                      {report.limitations.map((v, i) => (
                        <li key={i}>{v}</li>
                      ))}
                    </ul>
                  </section>
                )}
              </article>
            )}
          </Dialog>
        </div>
      )}
    </>
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
