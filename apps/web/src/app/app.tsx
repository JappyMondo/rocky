import { useEffect, useState } from 'react';

import styles from './app.module.css';

interface EndpointHealth {
  /** False on a machine that has not run `rocky setup` yet. */
  configured: boolean;
  ok: boolean;
  checkedAt?: string;
  detail?: string;
}

interface Health {
  status: string;
  version: string;
  web: boolean;
  endpoint?: EndpointHealth;
}

type State =
  | { kind: 'loading' }
  | { kind: 'connected'; health: Health }
  | { kind: 'unreachable' };

/**
 * The shell. It exists to prove one thing for now — that the daemon is serving
 * the API and these statics on the same port — so the only thing it renders is
 * the answer to that. The Inbox and Run detail NG-573 sketched come later.
 */
export function App() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;

    fetch('/api/health')
      .then((response) => response.json() as Promise<Health>)
      .then((health) => {
        if (!cancelled) setState({ kind: 'connected', health });
      })
      .catch(() => {
        if (!cancelled) setState({ kind: 'unreachable' });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const endpoint =
    state.kind === 'connected' ? state.health.endpoint : undefined;

  return (
    <main className={styles.shell}>
      <h1>Rocky</h1>
      {/*
       * Only when the endpoint is configured *and* failing. Unconfigured is a
       * machine mid-setup, not a fault, and NG-578 rules out any remediation —
       * so the banner explains and points at the docs rather than offering a
       * button that would restart something Rocky does not manage.
       */}
      {endpoint?.configured && !endpoint.ok && (
        <p role="status" className={styles.banner}>
          <strong>Linear cannot reach Rocky.</strong> The public endpoint{' '}
          {endpoint.detail ?? 'is not answering'}. Webhooks will not arrive
          until it is back — Runs still progress, more slowly. See{' '}
          <code>docs/public-endpoint.md</code>.
        </p>
      )}
      {state.kind === 'loading' && <p>Reaching the daemon…</p>}
      {state.kind === 'connected' && (
        <p>
          Daemon v{state.health.version} is {state.health.status}.
        </p>
      )}
      {state.kind === 'unreachable' && (
        <p>
          No daemon answering. Run <code>rocky start</code>.
        </p>
      )}
    </main>
  );
}

export default App;
