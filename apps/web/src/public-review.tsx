import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ReviewReport } from '@rocky/local-contracts';
import { ReportReader } from './app/review-report.js';
import './styles.css';
import './public-review.css';

export function PublicReview() {
  const [report, setReport] = useState<ReviewReport>();
  const [error, setError] = useState(false);
  const path = window.location.pathname;
  useEffect(() => {
    const controller = new AbortController();
    if (!/^\/reviews\/[0-9a-f]{64}$/.test(path)) {
      setError(true);
      return;
    }
    void fetch(`${path}/report.json`, {
      signal: controller.signal,
      credentials: 'same-origin',
    })
      .then((response) => {
        if (!response.ok) throw new Error('Unavailable');
        return response.json();
      })
      .then((value: ReviewReport) => {
        setReport(value);
        document.title = `${value.title} · Rocky review`;
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, [path]);
  return (
    <main className="public-review">
      <p className="public-review-brand">Rocky · Shared review</p>
      {error ? (
        <p role="alert">This review link is no longer available.</p>
      ) : report ? (
        <ReportReader
          report={report}
          standalone
          screenshotUrl={(id) => `${path}/images/${encodeURIComponent(id)}`}
        />
      ) : (
        <p role="status">Loading review…</p>
      )}
    </main>
  );
}
const root = document.getElementById('root');
if (root)
  createRoot(root).render(
    <StrictMode>
      <PublicReview />
    </StrictMode>,
  );
