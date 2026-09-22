import { EnvironmentVerification } from './environment-verification.js';
import { useEffect, useState } from 'react';
import type {
  RecipeDiscoveryJob,
  RepositoryRecipes,
  UiEndpoint,
} from '@rocky/local-contracts';
import { api, apiError } from './api.js';
import styles from './recipe-discovery.module.css';

type Proposal = NonNullable<RecipeDiscoveryJob['proposal']>;
type Props = {
  kind?: 'commands' | 'services';
  profileId: string;
  repository: string;
  disabled: boolean;
  recipes?: RepositoryRecipes;
  mismatch: (version: string | null) => void;
  onApply: (recipes: RepositoryRecipes) => void;
  onApplyCatalog?: (catalog: NonNullable<Proposal['catalog']>) => void;
};
type Row = {
  key: string;
  name: string;
  cwd?: string;
  shell: string;
  endpoints: Array<{ name: string; locator: UiEndpoint }>;
  dependencies: string[];
};

function Suggestions({ proposal, ...p }: Props & { proposal: Proposal }) {
  const catalog = p.onApplyCatalog ? proposal.catalog : undefined;
  const [rows, setRows] = useState<Row[]>(() =>
    catalog
      ? [
          ...catalog.commands.map((c) => ({
            key: `command:${c.id}`,
            name: c.name,
            cwd: c.cwd,
            shell: c.command,
            endpoints: [],
            dependencies: c.dependsOn.map(
              (d) => `command:${d.split('/').at(-1)}`,
            ),
          })),
          ...catalog.services.map((s) => ({
            key: `service:${s.id}`,
            name: s.name,
            cwd: s.cwd,
            shell: s.start,
            endpoints: structuredClone(s.endpoints),
            dependencies: s.dependsOn.map(
              (d) => `service:${d.split('/').at(-1)}`,
            ),
          })),
        ]
      : [
          ...Object.entries(proposal.commands ?? {})
            .filter(([, c]) => c)
            .map(([name, shell]) => ({
              key: `command:${name}`,
              name,
              shell,
              endpoints: [],
              dependencies: [],
            })),
          ...(proposal.ui ?? []).map((r) => ({
            key: `ui:${r.id}`,
            name: r.id,
            shell: r.start,
            endpoints: [{ name: 'web', locator: structuredClone(r.endpoint) }],
            dependencies: [],
          })),
        ],
  );
  const [applied, setApplied] = useState<string[]>([]);
  const scope = p.kind ?? 'all';
  const visibleRows = rows.filter(
    (row) =>
      !p.kind ||
      (p.kind === 'commands'
        ? row.key.startsWith('command:')
        : !row.key.startsWith('command:')),
  );
  const patch = (key: string, update: Partial<Row>) =>
    setRows((old) => old.map((r) => (r.key === key ? { ...r, ...update } : r)));
  if (applied.includes(scope)) return <p role="status">Applied to draft.</p>;
  return (
    <div className={styles.suggestions}>
      <fieldset disabled={p.disabled} className={styles.list}>
        {visibleRows.map((row, index) => {
          const needed = rows.some((other) =>
            other.dependencies.includes(row.key),
          );
          return (
            <div className={styles.row} key={row.key}>
              <div className={styles.heading}>
                {catalog ? (
                  <input
                    aria-label={`Suggestion ${index + 1} name`}
                    value={row.name}
                    onChange={(e) => patch(row.key, { name: e.target.value })}
                  />
                ) : (
                  <span>{row.name}</span>
                )}
                {row.cwd !== undefined && (
                  <label>
                    Directory
                    <input
                      aria-label={`Suggestion ${index + 1} directory`}
                      value={row.cwd}
                      onChange={(e) => patch(row.key, { cwd: e.target.value })}
                    />
                  </label>
                )}
                <button
                  type="button"
                  aria-label={`Remove ${row.name}`}
                  disabled={needed}
                  title={
                    needed
                      ? 'Remove dependent suggestions first'
                      : 'Remove suggestion'
                  }
                  onClick={() => setRows(rows.filter((r) => r.key !== row.key))}
                >
                  ×
                </button>
              </div>
              <textarea
                aria-label={`Suggestion ${index + 1} command`}
                spellCheck={false}
                rows={2}
                value={row.shell}
                onChange={(e) => patch(row.key, { shell: e.target.value })}
              />
              {row.endpoints.map((endpoint, endpointIndex) => (
                <div className={styles.endpoint} key={endpoint.name}>
                  {Object.entries(endpoint.locator)
                    .filter(([field]) => field !== 'kind')
                    .map(([field, value]) => (
                      <label key={field}>
                        {
                          (
                            {
                              path: 'JSON file',
                              pointer: 'JSON pointer',
                              pattern: 'Output pattern',
                              command: 'URL command',
                              url: 'URL',
                            } as Record<string, string>
                          )[field]
                        }
                        <input
                          aria-label={`${row.name} ${endpoint.name} ${field}`}
                          value={value}
                          onChange={(e) =>
                            patch(row.key, {
                              endpoints: row.endpoints.map((old, i) =>
                                i === endpointIndex
                                  ? {
                                      ...old,
                                      locator: {
                                        ...old.locator,
                                        [field]: e.target.value,
                                      },
                                    }
                                  : old,
                              ),
                            })
                          }
                        />
                      </label>
                    ))}
                </div>
              ))}
            </div>
          );
        })}
      </fieldset>
      {!visibleRows.length && (
        <p>No {p.kind === 'services' ? 'service' : 'command'} suggestions.</p>
      )}
      <button
        type="button"
        disabled={
          p.disabled ||
          !visibleRows.length ||
          visibleRows.some((r) => !r.name.trim() || !r.shell.trim())
        }
        onClick={() => {
          const byKey = new Map(visibleRows.map((r) => [r.key, r]));
          if (catalog && p.onApplyCatalog)
            p.onApplyCatalog({
              commands: catalog.commands.flatMap((c) => {
                const r = byKey.get(`command:${c.id}`);
                return r
                  ? [{ ...c, name: r.name, cwd: r.cwd!, command: r.shell }]
                  : [];
              }),
              services: catalog.services.flatMap((s) => {
                const r = byKey.get(`service:${s.id}`);
                return r
                  ? [
                      {
                        ...s,
                        name: r.name,
                        cwd: r.cwd!,
                        start: r.shell,
                        endpoints: r.endpoints,
                      },
                    ]
                  : [];
              }),
            });
          else {
            const ui = (proposal.ui ?? []).flatMap((recipe) => {
              const r = byKey.get(`ui:${recipe.id}`);
              return r
                ? [
                    {
                      ...recipe,
                      start: r.shell,
                      endpoint: r.endpoints[0].locator,
                    },
                  ]
                : [];
            });
            p.onApply({
              commands: {
                ...p.recipes?.commands,
                ...Object.fromEntries(
                  visibleRows
                    .filter((r) => r.key.startsWith('command:'))
                    .map((r) => [r.name, r.shell]),
                ),
              },
              ui: [
                ...(p.recipes?.ui ?? []).filter(
                  (old) => !ui.some((r) => r.id === old.id),
                ),
                ...ui,
              ],
            });
          }
          setApplied((old) => [...old, scope]);
        }}
      >
        Apply to draft
      </button>
    </div>
  );
}

export function RecipeDiscoveryPanel(p: Props) {
  const [job, setJob] = useState<RecipeDiscoveryJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const path = `/api/profiles/${encodeURIComponent(p.profileId)}/repositories/${encodeURIComponent(p.repository)}/discover-recipes`;
  useEffect(() => {
    if (busy) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api<RecipeDiscoveryJob | null>(path, p.mismatch);
        if (stopped) return;
        setJob(next);
        if (next?.status === 'running')
          timer = setTimeout(() => void poll(), 1000);
      } catch (caught) {
        if (!stopped)
          setError(await apiError(caught, 'Could not load discovery.'));
      }
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [path, p.mismatch, job?.id, job?.status, busy]);
  const run = async (method: 'POST' | 'DELETE') => {
    setBusy(true);
    setError('');
    try {
      setJob(
        await api<RecipeDiscoveryJob | null>(path, p.mismatch, { method }),
      );
    } catch (caught) {
      setError(await apiError(caught, 'Recipe discovery failed.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label={`Commands for ${p.repository}`}>
      {p.onApplyCatalog && (
        <EnvironmentVerification
          profileId={p.profileId}
          disabled={p.disabled}
          mismatch={p.mismatch}
        />
      )}
      <button
        type="button"
        disabled={p.disabled || busy || job?.status === 'running'}
        onClick={() => void run('POST')}
      >
        ✦ Discover with AI
      </button>
      {job?.status === 'running' && (
        <div className={styles.progress}>
          <span role="status">Discovering…</span>
          <button
            type="button"
            disabled={busy}
            onClick={() => void run('DELETE')}
          >
            Cancel discovery
          </button>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      {job?.status === 'failed' && <p role="alert">{job.error}</p>}
      {job?.status === 'cancelled' && <p role="status">Discovery cancelled.</p>}
      {job?.status === 'ready' && job.proposal && (
        <>
          <Suggestions
            key={`${path}/${job.id}`}
            {...p}
            proposal={job.proposal}
          />
          {job.proposal.catalog?.environment && (
            <details>
              <summary>Unverified environment recipes</summary>
              <p>
                Review these source references and verification commands in the
                profile configuration. Save the recipes with their referenced
                commands and services before verifying. Discovery has executed
                none of these checks.
              </p>
              <pre>
                {JSON.stringify(job.proposal.catalog.environment, null, 2)}
              </pre>
            </details>
          )}
        </>
      )}
    </section>
  );
}
