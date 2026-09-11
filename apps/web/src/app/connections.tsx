import { useCallback, useEffect, useState } from 'react';
import type {
  ConnectionsView,
  ConnectionLogin,
  ConnectionCheck,
  McpDefinition,
  McpProfileView,
} from '@rocky/local-contracts';
import { api, apiError } from './api.js';
import styles from './connections.module.css';
import { Dialog } from './ui.js';

type Editor = {
  name: string;
  definition: McpDefinition;
  allowed: boolean;
  revision: string;
  isNew: boolean;
  args: string;
};
const endpoint = (profile: string, name: string) =>
  `/api/connections/profiles/${encodeURIComponent(profile)}/mcp/${encodeURIComponent(name)}`;
const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const waiting = (login: ConnectionLogin) =>
  login.status === 'starting' || login.status === 'waiting';

function Fields(p: {
  label: string;
  values: Record<string, string | null>;
  change: (value: Record<string, string | null>) => void;
}) {
  const [newKey, setNewKey] = useState('');
  return (
    <fieldset className={styles.fields}>
      <legend>{p.label}</legend>
      {Object.entries(p.values).map(([key, value]) => (
        <div className={styles.secretRow} key={key}>
          <label>
            {key}
            <input
              aria-label={`${p.label}: ${key}`}
              type="password"
              autoComplete="off"
              value={value ?? ''}
              placeholder={
                value === null
                  ? 'Saved value — leave unchanged to keep'
                  : 'Value or ${ENV_VAR}'
              }
              onChange={(event) =>
                p.change({ ...p.values, [key]: event.target.value })
              }
            />
          </label>
          <button
            type="button"
            aria-label={`Remove ${p.label}: ${key}`}
            onClick={() =>
              p.change(
                Object.fromEntries(
                  Object.entries(p.values).filter(([name]) => name !== key),
                ),
              )
            }
          >
            Remove
          </button>
        </div>
      ))}
      <div className={styles.secretRow}>
        <input
          aria-label={`New ${p.label} name`}
          placeholder="Name"
          value={newKey}
          onChange={(event) => setNewKey(event.target.value)}
        />
        <button
          type="button"
          disabled={!newKey.trim() || Object.hasOwn(p.values, newKey.trim())}
          onClick={() => {
            p.change({ ...p.values, [newKey.trim()]: '' });
            setNewKey('');
          }}
        >
          Add entry
        </button>
      </div>
    </fieldset>
  );
}

export function Connections(p: {
  disabled: boolean;
  mismatch: (value: string | null) => void;
}) {
  const [data, setData] = useState<ConnectionsView | null>(null);
  const [profileId, setProfileId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [login, setLogin] = useState<ConnectionLogin | null>(null);
  const [loginTarget, setLoginTarget] = useState<{
    profile: string;
    name: string;
  } | null>(null);
  const closeEditor = useCallback(() => setEditor(null), []);
  const closeLoginOptions = useCallback(() => setLoginTarget(null), []);
  const loginId = login?.id;
  const loginActive = login ? waiting(login) : false;
  const closeLogin = useCallback(() => {
    if (!loginId) return;
    void (
      loginActive
        ? api(`/api/connections/logins/${loginId}`, p.mismatch, {
            method: 'DELETE',
          })
        : Promise.resolve()
    )
      .then(() => setLogin(null))
      .catch(() =>
        setError('Could not cancel login. Retry or wait for it to expire.'),
      );
  }, [loginId, loginActive, p.mismatch]);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [callbackPort, setCallbackPort] = useState('');
  const [checks, setChecks] = useState<Record<string, ConnectionCheck>>({});
  const reload = useCallback(async () => {
    const next = await api<ConnectionsView>('/api/connections', p.mismatch);
    if (!Array.isArray(next.profiles))
      throw new Error('Connections are unavailable');
    setData(next);
    setProfileId((current) =>
      next.profiles.some((profile) => profile.id === current)
        ? current
        : (next.profiles[0]?.id ?? ''),
    );
  }, [p.mismatch]);
  useEffect(() => {
    void reload().catch(() =>
      setError('Could not load connections. Reload to retry.'),
    );
  }, [reload]);
  useEffect(() => {
    if (!login || !waiting(login)) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void api<ConnectionLogin>(
        `/api/connections/logins/${login.id}`,
        p.mismatch,
      )
        .then(async (next) => {
          if (cancelled) return;
          setLogin(next);
          if (next.status === 'success') await reload();
        })
        .catch(() => {
          if (!cancelled)
            setLogin({
              id: login.id,
              status: 'failed',
              message:
                'Login status was lost. Rocky may have restarted; start a new login.',
            });
        });
    }, 750);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [login, p.mismatch, reload]);
  const action = async (work: () => Promise<void>) => {
    setError('');
    setBusy(true);
    try {
      await work();
    } catch (caught) {
      setError(await apiError(caught, 'Connection action failed.'));
    } finally {
      setBusy(false);
    }
  };
  const disabled = p.disabled || busy;
  const profile = data?.profiles.find((value) => value.id === profileId);
  const edit = (server?: McpProfileView['servers'][number]) => {
    if (!profile) return;
    setEditor({
      name: server?.name ?? '',
      definition: server?.definition ?? { type: 'http', url: '' },
      allowed: server?.allowed ?? false,
      revision: profile.revision,
      isNew: !server,
      args: JSON.stringify(
        server?.definition.type === 'stdio'
          ? (server.definition.args ?? [])
          : [],
        null,
        2,
      ),
    });
  };
  const startLogin = (target?: { profile: string; name: string }) =>
    void action(async () => {
      const path = target
        ? `${endpoint(target.profile, target.name)}/login`
        : '/api/connections/linear/login';
      const options = target
        ? {
            ...(clientId ? { clientId } : {}),
            ...(clientSecret ? { clientSecret } : {}),
            ...(callbackPort ? { callbackPort: Number(callbackPort) } : {}),
          }
        : {};
      setLogin(
        await api<ConnectionLogin>(path, p.mismatch, json('POST', options)),
      );
      setClientSecret('');
      setLoginTarget(null);
    });
  return (
    <section className={styles.connections} aria-label="Connections">
      <header className={styles.heading}>
        <div>
          <h2>Connections</h2>
          <p>Manage Linear access and the tools available to each profile.</p>
        </div>
        <button
          type="button"
          disabled={disabled}
          onClick={() => void action(reload)}
        >
          Reload connections
        </button>
      </header>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {!data ? (
        <p>Loading connections…</p>
      ) : (
        <>
          <article className={styles.card}>
            <div className={styles.heading}>
              <div>
                <h3>Linear</h3>
                <p>Ticket intake, questions and workflow updates</p>
              </div>
              <span className={styles.badge} data-state={data.linear.state}>
                {data.linear.state.replaceAll('-', ' ')}
              </span>
            </div>
            <p>{data.linear.message}</p>
            <div className={styles.actions}>
              <button
                type="button"
                disabled={disabled || data.linear.state === 'not-configured'}
                onClick={() => startLogin()}
              >
                Reauthenticate Linear
              </button>
              <button
                type="button"
                disabled={disabled}
                onClick={() =>
                  void action(async () => {
                    const linear = await api<ConnectionsView['linear']>(
                      '/api/connections/linear/check',
                      p.mismatch,
                      { method: 'POST' },
                    );
                    setData({ ...data, linear });
                  })
                }
              >
                Test Linear access
              </button>
            </div>
          </article>
          <div className={styles.heading}>
            <div>
              <h3>MCP servers</h3>
              <p>
                Server changes apply to new runs. Workflows choose which allowed
                tools each agent uses.
              </p>
            </div>
            {profile && (
              <button type="button" disabled={disabled} onClick={() => edit()}>
                Add MCP server
              </button>
            )}
          </div>
          {data.profiles.length === 0 ? (
            <p>Create a profile before adding MCP servers.</p>
          ) : (
            <label>
              Profile for MCP servers
              <select
                value={profileId}
                disabled={disabled}
                onChange={(event) => {
                  setProfileId(event.target.value);
                  setEditor(null);
                }}
              >
                {data.profiles.map((value) => (
                  <option key={value.id} value={value.id}>
                    {value.id}
                  </option>
                ))}
              </select>
            </label>
          )}
          {profile?.servers.length === 0 && (
            <p className={styles.empty}>
              No MCP servers in this profile. Add a remote service or a local
              tool server.
            </p>
          )}
          {profile?.servers.map((server) => {
            const key = `${profile.id}:${server.name}`;
            const check = checks[key];
            return (
              <article className={styles.card} key={server.name}>
                <div className={styles.heading}>
                  <div>
                    <h4>{server.name}</h4>
                    <p className={styles.address}>
                      {server.definition.type === 'stdio'
                        ? server.definition.command
                        : server.definition.url}
                    </p>
                  </div>
                  <span className={styles.badge}>{server.definition.type}</span>
                </div>
                <p>
                  {server.allowed
                    ? 'Allowed for this profile’s agents'
                    : 'Not granted to this profile’s agents'}
                </p>
                <p role={check ? 'status' : undefined}>
                  {check?.message ?? server.auth.message}
                </p>
                {check?.tools && (
                  <details>
                    <summary>Available tools ({check.tools.length})</summary>
                    <ul>
                      {check.tools.map((tool) => (
                        <li key={tool}>{tool}</li>
                      ))}
                    </ul>
                  </details>
                )}
                <div className={styles.actions}>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => edit(server)}
                  >
                    Edit {server.name}
                  </button>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() =>
                      void action(async () => {
                        const result = await api<ConnectionCheck>(
                          `${endpoint(profile.id, server.name)}/check`,
                          p.mismatch,
                          { method: 'POST' },
                        );
                        setChecks((current) => ({ ...current, [key]: result }));
                      })
                    }
                  >
                    Test {server.name}
                  </button>
                  {server.definition.type !== 'stdio' && (
                    <>
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => {
                          setClientId('');
                          setClientSecret('');
                          setCallbackPort('');
                          setLoginTarget({
                            profile: profile.id,
                            name: server.name,
                          });
                        }}
                      >
                        {server.auth.state === 'saved'
                          ? 'Reauthenticate'
                          : 'Login'}{' '}
                        {server.name}
                      </button>
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => {
                          if (
                            window.confirm(
                              'Forget the saved OAuth login for this URL in every profile?',
                            )
                          )
                            void action(async () => {
                              await api(
                                `${endpoint(profile.id, server.name)}/credentials`,
                                p.mismatch,
                                { method: 'DELETE' },
                              );
                              setChecks({});
                              await reload();
                            });
                        }}
                      >
                        Forget login
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    disabled={disabled}
                    className={styles.danger}
                    onClick={() => {
                      if (
                        window.confirm(
                          `Remove ${server.name} from ${profile.id}? Workflows that reference it will need updating.`,
                        )
                      )
                        void action(async () => {
                          await api(
                            endpoint(profile.id, server.name),
                            p.mismatch,
                            json('DELETE', { revision: profile.revision }),
                          );
                          setChecks({});
                          await reload();
                        });
                    }}
                  >
                    Remove {server.name}
                  </button>
                </div>
              </article>
            );
          })}
        </>
      )}
      {editor && profile && (
        <Dialog
          title={editor.isNew ? 'Add MCP server' : 'Edit MCP server'}
          onClose={closeEditor}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              let definition = editor.definition;
              if (definition.type === 'stdio') {
                try {
                  const args: unknown = JSON.parse(editor.args);
                  if (
                    !Array.isArray(args) ||
                    args.some((arg) => typeof arg !== 'string')
                  )
                    throw new Error('Invalid arguments');
                  definition = { ...definition, args };
                } catch {
                  setError(
                    'Arguments must be a JSON array of strings, for example ["--port", "3000"].',
                  );
                  return;
                }
              }
              void action(async () => {
                await api(
                  endpoint(profile.id, editor.name),
                  p.mismatch,
                  json('PUT', {
                    revision: editor.revision,
                    definition,
                    allowed: editor.allowed,
                  }),
                );
                setEditor(null);
                setChecks({});
                await reload();
              });
            }}
          >
            <label>
              Server name
              <input
                required
                pattern="[A-Za-z0-9_][A-Za-z0-9_.-]*"
                disabled={!editor.isNew}
                value={editor.name}
                onChange={(event) =>
                  setEditor({ ...editor, name: event.target.value })
                }
              />
            </label>
            <label>
              Transport
              <select
                value={editor.definition.type}
                onChange={(event) =>
                  setEditor({
                    ...editor,
                    definition:
                      event.target.value === 'stdio'
                        ? { type: 'stdio', command: '' }
                        : {
                            type: event.target.value as 'http' | 'sse',
                            url: '',
                          },
                  })
                }
              >
                <option value="http">HTTP (remote)</option>
                <option value="sse">SSE (legacy remote)</option>
                <option value="stdio">Standard input/output (local)</option>
              </select>
            </label>
            {editor.definition.type === 'stdio' ? (
              <>
                <label>
                  Command
                  <input
                    required
                    value={editor.definition.command}
                    onChange={(event) => {
                      if (editor.definition.type === 'stdio')
                        setEditor({
                          ...editor,
                          definition: {
                            ...editor.definition,
                            command: event.target.value,
                          },
                        });
                    }}
                  />
                </label>
                <label>
                  Arguments (JSON array)
                  <textarea
                    value={editor.args}
                    onChange={(event) =>
                      setEditor({ ...editor, args: event.target.value })
                    }
                  />
                </label>
                <Fields
                  label="Environment variables"
                  values={editor.definition.env ?? {}}
                  change={(env) => {
                    if (editor.definition.type === 'stdio')
                      setEditor({
                        ...editor,
                        definition: { ...editor.definition, env },
                      });
                  }}
                />
              </>
            ) : (
              <>
                <label>
                  Server URL
                  <input
                    required
                    placeholder="https://example.com/mcp"
                    value={editor.definition.url}
                    onChange={(event) => {
                      if (editor.definition.type !== 'stdio')
                        setEditor({
                          ...editor,
                          definition: {
                            ...editor.definition,
                            url: event.target.value,
                          },
                        });
                    }}
                  />
                </label>
                <Fields
                  label="Headers"
                  values={editor.definition.headers ?? {}}
                  change={(headers) => {
                    if (editor.definition.type !== 'stdio')
                      setEditor({
                        ...editor,
                        definition: { ...editor.definition, headers },
                      });
                  }}
                />
              </>
            )}
            <label className={styles.checkbox}>
              <input
                type="checkbox"
                checked={editor.allowed}
                onChange={(event) =>
                  setEditor({ ...editor, allowed: event.target.checked })
                }
              />
              Allow this server for the profile’s agents
            </label>
            {error && (
              <p className={styles.error} role="alert">
                {error}
              </p>
            )}
            <div className={styles.actions}>
              <button type="submit" disabled={disabled}>
                Save MCP server
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setEditor(null)}
              >
                Cancel
              </button>
            </div>
          </form>
        </Dialog>
      )}
      {loginTarget && (
        <Dialog title="MCP login" onClose={closeLoginOptions}>
          <h3>Login to {loginTarget.name}</h3>
          <p>
            Rocky will prepare a secure login link. Continue in your browser to
            approve access.
          </p>
          <details>
            <summary>Advanced OAuth settings</summary>
            <label>
              OAuth client ID
              <input
                value={clientId}
                onChange={(event) => setClientId(event.target.value)}
              />
            </label>
            <label>
              OAuth client secret
              <input
                type="password"
                autoComplete="off"
                value={clientSecret}
                onChange={(event) => setClientSecret(event.target.value)}
              />
            </label>
            <label>
              Callback port
              <input
                type="number"
                min="0"
                max="65535"
                value={callbackPort}
                onChange={(event) => setCallbackPort(event.target.value)}
              />
            </label>
          </details>
          <div className={styles.actions}>
            <button
              type="button"
              disabled={disabled}
              onClick={() => startLogin(loginTarget)}
            >
              Start login
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setLoginTarget(null)}
            >
              Cancel
            </button>
          </div>
          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
        </Dialog>
      )}
      {login && (
        <Dialog title="Authentication progress" onClose={closeLogin}>
          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
          <h3>{login.status === 'success' ? 'Connected' : 'Authentication'}</h3>
          <p role="status">
            {login.message ??
              (login.status === 'starting'
                ? 'Preparing login…'
                : 'Waiting for authorization in your browser…')}
          </p>
          {login.authorizationUrl && waiting(login) && (
            <a
              className={styles.authorize}
              href={login.authorizationUrl}
              target="_blank"
              rel="noreferrer"
            >
              Continue to authorization
            </a>
          )}
          <div className={styles.actions}>
            <button type="button" disabled={disabled} onClick={closeLogin}>
              {waiting(login) ? 'Cancel login' : 'Close'}
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
