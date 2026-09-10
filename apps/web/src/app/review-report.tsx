import { useEffect, useState } from 'react';
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
                {item.pr.repo} #{item.pr.number} · {item.pr.headSha.slice(0, 8)}
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
                    {report.pr.repo} · #{report.pr.number}
                  </p>
                  <h1>{report.title}</h1>
                  <p>{report.summary}</p>
                  <p>
                    <a href={report.pr.url} target="_blank" rel="noreferrer">
                      Open pull request
                    </a>{' '}
                    · Revision <code>{report.pr.headSha.slice(0, 12)}</code> ·{' '}
                    <time dateTime={report.createdAt}>
                      {new Date(report.createdAt).toLocaleString()}
                    </time>
                  </p>
                </header>
                <section>
                  <h2>Problems solved</h2>
                  {report.problems.map((p, i) => (
                    <div key={i}>
                      <h3>{p.problem}</h3>
                      <p>{p.solution}</p>
                    </div>
                  ))}
                </section>
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
                {!!report.visuals.length && (
                  <section>
                    <h2>Visual evidence</h2>
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
                                          href={`/api/screenshots/${shot.id}`}
                                          target="_blank"
                                          rel="noreferrer"
                                        >
                                          <img
                                            src={`/api/screenshots/${shot.id}`}
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
