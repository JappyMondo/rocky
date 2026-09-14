import { useState } from 'react';
import styles from './connections.module.css';

export function RockyMcpSetup() {
  const [readOnly, setReadOnly] = useState(false);
  const [copyStatus, setCopyStatus] = useState('');
  const configuration = JSON.stringify(
    {
      mcpServers: {
        rocky: {
          command: 'rocky',
          args: ['mcp', 'serve', ...(readOnly ? ['--read-only'] : [])],
        },
      },
    },
    null,
    2,
  );

  return (
    <article className={styles.card} aria-labelledby="rocky-mcp-setup-title">
      <div className={styles.heading}>
        <div>
          <h3 id="rocky-mcp-setup-title">Connect an agent to Rocky</h3>
          <p>
            Let another agent inspect runs, edit Rocky’s configuration and
            trigger workflows through Rocky’s MCP server.
          </p>
        </div>
        <span className={styles.badge}>MCP · stdio</span>
      </div>
      <ol className={styles.setupSteps}>
        <li>
          Run your agent on the same machine as Rocky. Keep the daemon running
          with <code>rocky start</code>.
        </li>
        <li>
          Open your agent’s MCP settings and add the configuration below. If it
          already has an <code>mcpServers</code> object, add the{' '}
          <code>rocky</code> entry to it.
        </li>
        <li>
          Save and reconnect or restart your agent. Ask it to list Rocky’s runs
          using <code>rocky_runs_list</code> to check the connection.
        </li>
      </ol>
      <label className={styles.checkbox}>
        <input
          type="checkbox"
          checked={readOnly}
          onChange={(event) => {
            setReadOnly(event.target.checked);
            setCopyStatus('');
          }}
        />
        Read-only access
      </label>
      <p>
        {readOnly
          ? 'The agent can inspect Rocky. Configuration edits and run controls are disabled.'
          : 'The agent can change configuration and start or redirect work. Workflows may update repositories and connected services.'}
      </p>
      <pre className={styles.mcpConfig} aria-label="Rocky MCP configuration">
        <code>{configuration}</code>
      </pre>
      <div className={styles.actions}>
        <button
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(configuration);
              setCopyStatus('Configuration copied.');
            } catch {
              setCopyStatus(
                'Could not copy automatically. Select and copy the configuration above.',
              );
            }
          }}
        >
          Copy MCP configuration
        </button>
      </div>
      <p role="status">{copyStatus}</p>
      <details>
        <summary>Connection troubleshooting</summary>
        <p>
          Choose the stdio transport if your agent asks. Set the command to{' '}
          <code>rocky</code> and arguments to{' '}
          <code>{readOnly ? 'mcp serve --read-only' : 'mcp serve'}</code>. The
          agent launches this command; no server URL is needed.
        </p>
        <p>
          If the agent cannot find <code>rocky</code>, use the absolute path to
          your Rocky executable as the command. Run <code>rocky status</code>
          to check the daemon. If <code>mcp serve</code> is unavailable, update
          Rocky to a version that includes the MCP server.
        </p>
        <p>
          If you use a custom <code>ROCKY_HOME</code>, add an <code>env</code>{' '}
          object beside <code>command</code> and <code>args</code> with{' '}
          <code>{'{"ROCKY_HOME": "/absolute/path/to/your/rocky-home"}'}</code>.
          Use the same home as the daemon you want to connect to.
        </p>
      </details>
    </article>
  );
}
