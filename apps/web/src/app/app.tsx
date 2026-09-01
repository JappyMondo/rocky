import { useEffect, useState } from 'react';

import styles from './app.module.css';

interface Health {
  status: string;
  version: string;
  web: boolean;
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

  return (
    <main className={styles.shell}>
      <h1>Rocky</h1>
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
