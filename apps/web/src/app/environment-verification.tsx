import { useEffect, useState } from 'react';
import type { EnvironmentJob } from '@rocky/local-contracts';
import { api, apiError } from './api.js';

export function EnvironmentVerification(p: {
  profileId: string;
  disabled: boolean;
  mismatch: (version: string | null) => void;
}) {
  const [job, setJob] = useState<EnvironmentJob | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const path = `/api/profiles/${encodeURIComponent(p.profileId)}/verify-environment`;
  const running = !!job && !['ready', 'blocked'].includes(job.status);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api<EnvironmentJob | null>(path, p.mismatch);
        if (stopped) return;
        setJob(next);
        if (next && !['ready', 'blocked'].includes(next.status))
          timer = setTimeout(() => void poll(), 1000);
      } catch (error) {
        if (!stopped)
          setError(
            await apiError(error, 'Could not read environment verification.'),
          );
      }
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [path, p.mismatch, busy]);
  return (
    <section aria-label="Environment verification">
      <p>
        Verify the saved profile’s baseline in disposable workspaces. Runs
        verify again before depending on it.
      </p>
      <button
        type="button"
        disabled={p.disabled || busy || running}
        onClick={async () => {
          setBusy(true);
          setError('');
          try {
            setJob(
              await api<EnvironmentJob>(path, p.mismatch, { method: 'POST' }),
            );
          } catch (error) {
            setError(await apiError(error, 'Could not verify environment.'));
          } finally {
            setBusy(false);
          }
        }}
      >
        Verify saved environment
      </button>
      {job && <p role="status">Environment: {job.status}</p>}
      {job?.result?.status === 'blocked' && (
        <p role="alert">
          {job.result.blocker.capability}: {job.result.blocker.action}
        </p>
      )}
      {job?.evidence.length ? (
        <details>
          <summary>Verification and repair evidence</summary>
          <pre>{JSON.stringify(job.evidence, null, 2)}</pre>
        </details>
      ) : null}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
