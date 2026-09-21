import { useState } from 'react';
import {
  commandRecipe,
  serviceRecipe,
  type WorkspaceRepository,
  type RepositoryCommand,
  type DevService,
  type AutomationSettings,
  type UiEndpoint,
  type ConfigurationMigration,
  type WorkspaceConfiguration,
} from '@rocky/local-contracts';
import { RecipeDiscoveryPanel } from './recipe-discovery.js';
import { SourceControlFields } from './source-control.js';
import styles from './app.module.css';
import { api, apiError } from './api.js';

const newId = () => crypto.randomUUID();
export function ConfigurationMigrationPanel(p: {
  migration: ConfigurationMigration;
  disabled: boolean;
  onApply: (config: WorkspaceConfiguration) => void;
}) {
  const [choices, setChoices] = useState<Record<string, number>>({});
  return (
    <section
      className={styles.configurationNotice}
      aria-label="Unify profile settings"
    >
      <h2>Bring repository settings together</h2>
      <p>
        Move commands and dev services out of the workflow. Review conflicts
        below; nothing changes until you apply and save.
      </p>
      {p.migration.conflicts.map((conflict, index) => (
        <label key={index} className={styles.field}>
          {conflict.repository} / {conflict.id}: choose the value to keep
          <select
            value={choices[index] ?? ''}
            disabled={p.disabled}
            onChange={(e) =>
              setChoices({ ...choices, [index]: Number(e.target.value) })
            }
          >
            <option value="" disabled>
              Choose a source…
            </option>
            {conflict.choices.map((choice, option) => (
              <option key={option} value={option}>
                {choice.source}:{' '}
                {'command' in choice.value
                  ? choice.value.command
                  : choice.value.start}
              </option>
            ))}
          </select>
        </label>
      ))}
      {p.migration.errors.map((error) => (
        <p role="alert" key={error}>
          {error}
        </p>
      ))}
      <details>
        <summary>Migration preview</summary>
        <pre>
          {JSON.stringify(
            {
              repositories: p.migration.repos,
              automation: p.migration.automation,
            },
            null,
            2,
          )}
        </pre>
      </details>
      <button
        type="button"
        disabled={
          p.disabled ||
          !!p.migration.errors.length ||
          p.migration.conflicts.some((_, index) => choices[index] === undefined)
        }
        onClick={() => {
          const config = structuredClone(p.migration);
          config.conflicts.forEach((conflict, index) => {
            const repo = config.repos.find(
              (repo) => repo.id === conflict.repository,
            )!;
            const value = conflict.choices[choices[index]].value;
            if ('command' in value)
              repo.commands = [
                ...(repo.commands ?? []).filter(
                  (item) => item.id !== conflict.id,
                ),
                value,
              ];
            else
              repo.services = [
                ...(repo.services ?? []).filter(
                  (item) => item.id !== conflict.id && item.id !== value.id,
                ),
                value,
              ];
          });
          p.onApply({ repos: config.repos, automation: config.automation });
        }}
      >
        Apply unified settings to draft
      </button>
    </section>
  );
}

function JsonField(p: {
  label: string;
  value: unknown;
  disabled: boolean;
  onChange: (value: unknown) => void;
}) {
  const [text, setText] = useState(JSON.stringify(p.value, null, 2));
  const [error, setError] = useState('');
  return (
    <label className={styles.field}>
      {p.label}
      <textarea
        value={text}
        disabled={p.disabled}
        onChange={(e) => {
          setText(e.target.value);
          try {
            const value: unknown = JSON.parse(e.target.value);
            p.onChange(value);
            setError('');
            e.target.setCustomValidity('');
          } catch {
            setError('Enter valid JSON before saving.');
            e.target.setCustomValidity('Enter valid JSON before saving.');
          }
        }}
      />
      {error && <span role="alert">{error}</span>}
    </label>
  );
}
function Policy(p: {
  value: RepositoryCommand['policy'];
  disabled: boolean;
  onChange: (value: RepositoryCommand['policy']) => void;
}) {
  return (
    <label className={styles.field}>
      Selection
      <select
        disabled={p.disabled}
        value={p.value}
        onChange={(e) =>
          p.onChange(e.target.value as RepositoryCommand['policy'])
        }
      >
        <option value="agent">Agent chooses</option>
        <option value="required">Always required</option>
        <option value="manual">Manual only</option>
      </select>
    </label>
  );
}
function EndpointFields(p: {
  value: UiEndpoint;
  disabled: boolean;
  onChange: (value: UiEndpoint) => void;
}) {
  const endpoint = p.value;
  return (
    <fieldset disabled={p.disabled}>
      <label className={styles.field}>
        Discover endpoint from
        <select
          value={endpoint.kind}
          onChange={(e) => {
            const kind = e.target.value as UiEndpoint['kind'];
            p.onChange(
              kind === 'fixed' || kind === 'assigned-port'
                ? { kind, url: 'http://127.0.0.1/' }
                : kind === 'output-regex'
                  ? { kind, pattern: 'http://localhost:(?<port>[0-9]+)' }
                  : kind === 'json-file'
                    ? { kind, path: '.runtime/server.json', pointer: '/port' }
                    : { kind, command: '' },
            );
          }}
        >
          <option value="assigned-port">Assigned port</option>
          <option value="output-regex">Server output</option>
          <option value="json-file">JSON file</option>
          <option value="command">Resolver command</option>
          <option value="fixed">Fixed URL</option>
        </select>
      </label>
      {'url' in endpoint && (
        <label className={styles.field}>
          URL
          <input
            value={endpoint.url}
            onChange={(e) => p.onChange({ ...endpoint, url: e.target.value })}
          />
        </label>
      )}
      {endpoint.kind === 'output-regex' && (
        <label className={styles.field}>
          Pattern (named url or port capture)
          <input
            value={endpoint.pattern}
            onChange={(e) =>
              p.onChange({ ...endpoint, pattern: e.target.value })
            }
          />
        </label>
      )}
      {endpoint.kind === 'json-file' && (
        <>
          <label className={styles.field}>
            JSON file (relative to repository)
            <input
              value={endpoint.path}
              onChange={(e) =>
                p.onChange({ ...endpoint, path: e.target.value })
              }
            />
          </label>
          <label className={styles.field}>
            JSON pointer
            <input
              value={endpoint.pointer}
              onChange={(e) =>
                p.onChange({ ...endpoint, pointer: e.target.value })
              }
            />
          </label>
        </>
      )}
      {endpoint.kind === 'command' && (
        <label className={styles.field}>
          Resolver command (prints URL or port)
          <textarea
            value={endpoint.command}
            onChange={(e) =>
              p.onChange({ ...endpoint, command: e.target.value })
            }
          />
        </label>
      )}
    </fieldset>
  );
}

export function RepositorySettings(p: {
  repos: WorkspaceRepository[];
  savedRepos?: WorkspaceRepository[];
  savedRevision?: string;
  inheritedAccess?: import('@rocky/local-contracts').SourceControlSettings;
  profileId: string;
  disabled: boolean;
  mismatch: (version: string | null) => void;
  onChange: (repos: WorkspaceRepository[]) => void;
}) {
  const [selected, setSelected] = useState(p.repos[0]?.id);
  const [tab, setTab] = useState<
    'repository' | 'commands' | 'services' | 'access'
  >('repository');
  const repo = p.repos.find((repo) => repo.id === selected) ?? p.repos[0];
  const update = (next: WorkspaceRepository) =>
    p.onChange(p.repos.map((item) => (item.id === repo.id ? next : item)));
  const saved = p.savedRepos?.some(
    (item) =>
      item.id === repo?.id &&
      item.name === repo?.name &&
      item.url === repo?.url,
  );
  return (
    <section aria-label="Repository configuration">
      <div className={styles.repoToolbar}>
        <label>
          Repository
          <select
            value={repo?.id ?? ''}
            onChange={(e) => setSelected(e.target.value)}
          >
            {p.repos.map((item, index) => (
              <option key={item.id} value={item.id}>
                {item.name || 'New repository'}
                {index === 0 ? ' · primary' : ''}
              </option>
            ))}
          </select>
        </label>
        <button
          disabled={p.disabled}
          onClick={() => {
            const id = newId();
            p.onChange([
              ...p.repos,
              {
                id,
                name: '',
                url: '',
                baseBranch: 'main',
                commands: [],
                services: [],
                ci: 'required',
              },
            ]);
            setSelected(id);
          }}
        >
          Add repository
        </button>
      </div>
      {repo && (
        <div key={repo.id}>
          <div
            className={styles.filters}
            role="group"
            aria-label="Repository sections"
          >
            {(['repository', 'commands', 'services', 'access'] as const).map(
              (item) => (
                <button
                  key={item}
                  aria-pressed={tab === item}
                  onClick={() => setTab(item)}
                >
                  {item === 'services'
                    ? 'Dev services'
                    : item[0].toUpperCase() + item.slice(1)}
                </button>
              ),
            )}
          </div>
          <div hidden={tab !== 'repository'}>
            {(['name', 'url', 'baseBranch'] as const).map((key) => (
              <label key={key} className={styles.field}>
                {
                  {
                    name: 'Folder name',
                    url: 'Remote URL',
                    baseBranch: 'Base branch',
                  }[key]
                }
                <input
                  disabled={p.disabled}
                  value={repo[key]}
                  onChange={(e) => update({ ...repo, [key]: e.target.value })}
                />
              </label>
            ))}
            <label className={styles.field}>
              CI pipeline
              <select
                disabled={p.disabled}
                value={repo.ci ?? 'required'}
                onChange={(e) =>
                  update({ ...repo, ci: e.target.value as 'required' | 'none' })
                }
              >
                <option value="required">Require CI</option>
                <option value="none">No CI configured</option>
              </select>
            </label>
            <p className={styles.muted}>
              Stable ID: {repo.id}. Renaming this folder preserves command and
              service references.
            </p>
            <button
              disabled={p.disabled || repo === p.repos[0]}
              onClick={() =>
                p.onChange([
                  repo,
                  ...p.repos.filter((item) => item.id !== repo.id),
                ])
              }
            >
              Make primary
            </button>
            <button
              disabled={p.disabled || p.repos.length === 1}
              onClick={() =>
                p.onChange(p.repos.filter((item) => item.id !== repo.id))
              }
            >
              Remove repository
            </button>
          </div>
          {(tab === 'commands' || tab === 'services') && (
            <>
              {saved ? (
                <RecipeDiscoveryPanel
                  key={`${repo.id}/${repo.url}`}
                  profileId={p.profileId}
                  repository={repo.name}
                  kind={tab}
                  disabled={p.disabled}
                  mismatch={p.mismatch}
                  onApplyCatalog={(catalog) => {
                    const commands = [...(repo.commands ?? [])];
                    const services = [...(repo.services ?? [])];
                    const commandIds = new Map(
                      catalog.commands.map((item) => [
                        item.id,
                        commands.some((old) => old.id === item.id)
                          ? newId()
                          : item.id,
                      ]),
                    );
                    const serviceIds = new Map(
                      catalog.services.map((item) => [
                        item.id,
                        services.some((old) => old.id === item.id)
                          ? newId()
                          : item.id,
                      ]),
                    );
                    const remap = (
                      dependencies: string[],
                      ids: Map<string, string>,
                    ) =>
                      dependencies.map((dependency) =>
                        dependency.startsWith(`${repo.id}/`) &&
                        ids.has(dependency.slice(repo.id!.length + 1))
                          ? `${repo.id}/${ids.get(dependency.slice(repo.id!.length + 1))}`
                          : dependency,
                      );
                    commands.push(
                      ...catalog.commands.map((item) => ({
                        ...item,
                        id: commandIds.get(item.id)!,
                        dependsOn: remap(item.dependsOn, commandIds),
                      })),
                    );
                    services.push(
                      ...catalog.services.map((item) => ({
                        ...item,
                        id: serviceIds.get(item.id)!,
                        dependsOn: remap(item.dependsOn, serviceIds),
                      })),
                    );
                    update({ ...repo, commands, services });
                  }}
                  onApply={(recipes) => {
                    const commands = [...(repo.commands ?? [])];
                    for (const [purpose, command] of Object.entries(
                      recipes.commands ?? {},
                    ))
                      if (command) {
                        // Suggestions never silently replace an existing command; edit/remove after reviewing.
                        commands.push({
                          ...commandRecipe(newId(), command),
                          name: `Suggested ${purpose}`,
                          purpose: purpose as RepositoryCommand['purpose'],
                        });
                      }
                    const services = [
                      ...(repo.services ?? []),
                      ...(recipes.ui ?? []).map((recipe) => ({
                        ...serviceRecipe(newId()),
                        name: recipe.id,
                        start: recipe.start,
                        endpoints: [{ name: 'web', locator: recipe.endpoint }],
                      })),
                    ];
                    update({ ...repo, commands, services });
                  }}
                />
              ) : (
                <p>Save repository changes before using AI discovery.</p>
              )}
            </>
          )}
          <div hidden={tab !== 'commands'}>
            {(repo.commands ?? []).map((command, index) => {
              const change = (next: RepositoryCommand) =>
                update({
                  ...repo,
                  commands: repo.commands!.map((item, i) =>
                    i === index ? next : item,
                  ),
                });
              return (
                <fieldset
                  key={command.id}
                  disabled={p.disabled}
                  className={styles.recipeCard}
                >
                  <legend>{command.name || 'Command'}</legend>
                  <label className={styles.field}>
                    Command name
                    <input
                      value={command.name}
                      onChange={(e) =>
                        change({ ...command, name: e.target.value })
                      }
                    />
                  </label>
                  <label className={styles.field}>
                    Purpose
                    <select
                      value={command.purpose}
                      onChange={(e) =>
                        change({
                          ...command,
                          purpose: e.target
                            .value as RepositoryCommand['purpose'],
                        })
                      }
                    >
                      {['install', 'test', 'lint', 'build', 'other'].map(
                        (kind) => (
                          <option key={kind}>{kind}</option>
                        ),
                      )}
                    </select>
                  </label>
                  <label className={styles.field}>
                    Shell command
                    <textarea
                      value={command.command}
                      onChange={(e) =>
                        change({ ...command, command: e.target.value })
                      }
                    />
                  </label>
                  <label className={styles.field}>
                    Working directory
                    <input
                      value={command.cwd}
                      onChange={(e) =>
                        change({ ...command, cwd: e.target.value })
                      }
                    />
                  </label>
                  <Policy
                    value={command.policy}
                    disabled={p.disabled}
                    onChange={(policy) => change({ ...command, policy })}
                  />
                  <label className={styles.field}>
                    When to use
                    <input
                      value={command.description}
                      onChange={(e) =>
                        change({ ...command, description: e.target.value })
                      }
                    />
                  </label>
                  <label className={styles.field}>
                    Timeout (ms)
                    <input
                      type="number"
                      min={1}
                      value={command.timeoutMs}
                      onChange={(e) =>
                        change({
                          ...command,
                          timeoutMs: Number(e.target.value),
                        })
                      }
                    />
                  </label>
                  <Dependencies
                    repos={p.repos}
                    kind="commands"
                    self={`${repo.id}/${command.id}`}
                    value={command.dependsOn}
                    onChange={(dependsOn) => change({ ...command, dependsOn })}
                  />
                  <Environment
                    value={command.env}
                    disabled={p.disabled}
                    onChange={(env) => change({ ...command, env })}
                  />
                  <small>
                    Reference: {repo.id}/{command.id}
                  </small>
                  <button
                    onClick={() =>
                      update({
                        ...repo,
                        commands: repo.commands!.filter((_, i) => i !== index),
                      })
                    }
                  >
                    Remove command
                  </button>
                  <CommandTestButton
                    profileId={p.profileId}
                    repositoryId={repo.id!}
                    commandId={command.id}
                    revision={p.savedRevision ?? ''}
                    disabled={
                      p.disabled ||
                      !p.savedRevision ||
                      !saved ||
                      !p.savedRepos?.some(
                        (item) =>
                          item.id === repo.id &&
                          item.commands?.some(
                            (old) =>
                              JSON.stringify(old) === JSON.stringify(command),
                          ),
                      )
                    }
                    mismatch={p.mismatch}
                  />
                </fieldset>
              );
            })}
            <button
              disabled={p.disabled}
              onClick={() =>
                update({
                  ...repo,
                  commands: [
                    ...(repo.commands ?? []),
                    { ...commandRecipe(newId()), name: 'New command' },
                  ],
                })
              }
            >
              Add command
            </button>
          </div>
          <div hidden={tab !== 'services'}>
            {(repo.services ?? []).map((service, index) => {
              const change = (next: DevService) =>
                update({
                  ...repo,
                  services: repo.services!.map((item, i) =>
                    i === index ? next : item,
                  ),
                });
              return (
                <fieldset
                  key={service.id}
                  disabled={p.disabled}
                  className={styles.recipeCard}
                >
                  <legend>{service.name || 'Dev service'}</legend>
                  {(
                    ['name', 'start', 'cwd', 'portEnv', 'description'] as const
                  ).map((key) => (
                    <label key={key} className={styles.field}>
                      {
                        {
                          name: 'Service name',
                          start: 'Start command',
                          cwd: 'Working directory',
                          portEnv:
                            'Port environment variable (optional unless assigned)',
                          description: 'When to use',
                        }[key]
                      }
                      <input
                        value={service[key]}
                        onChange={(e) =>
                          change({ ...service, [key]: e.target.value })
                        }
                      />
                    </label>
                  ))}
                  <label className={styles.field}>
                    Stop command (optional)
                    <input
                      value={service.stop ?? ''}
                      onChange={(e) =>
                        change({
                          ...service,
                          stop: e.target.value || undefined,
                        })
                      }
                    />
                  </label>
                  <Policy
                    value={service.policy}
                    disabled={p.disabled}
                    onChange={(policy) => change({ ...service, policy })}
                  />
                  <Dependencies
                    repos={p.repos}
                    kind="services"
                    self={`${repo.id}/${service.id}`}
                    value={service.dependsOn}
                    onChange={(dependsOn) => change({ ...service, dependsOn })}
                  />
                  <Environment
                    value={service.env}
                    disabled={p.disabled}
                    onChange={(env) => change({ ...service, env })}
                  />
                  {service.endpoints.map((endpoint, i) => (
                    <div key={i} className={styles.recipeCard}>
                      <label className={styles.field}>
                        Endpoint name
                        <input
                          value={endpoint.name}
                          onChange={(e) =>
                            change({
                              ...service,
                              endpoints: service.endpoints.map((item, n) =>
                                n === i
                                  ? { ...item, name: e.target.value }
                                  : item,
                              ),
                            })
                          }
                        />
                      </label>
                      <EndpointFields
                        value={endpoint.locator}
                        disabled={p.disabled}
                        onChange={(locator) =>
                          change({
                            ...service,
                            endpoints: service.endpoints.map((item, n) =>
                              n === i ? { ...item, locator } : item,
                            ),
                          })
                        }
                      />
                      <button
                        disabled={service.endpoints.length === 1}
                        onClick={() =>
                          change({
                            ...service,
                            endpoints: service.endpoints.filter(
                              (_, n) => n !== i,
                            ),
                          })
                        }
                      >
                        Remove endpoint
                      </button>
                    </div>
                  ))}
                  <button
                    onClick={() =>
                      change({
                        ...service,
                        endpoints: [
                          ...service.endpoints,
                          {
                            name: `endpoint${service.endpoints.length + 1}`,
                            locator: {
                              kind: 'fixed',
                              url: 'http://127.0.0.1/',
                            },
                          },
                        ],
                      })
                    }
                  >
                    Add endpoint
                  </button>
                  <label className={styles.field}>
                    Readiness endpoint
                    <select
                      value={service.readiness.endpoint}
                      onChange={(e) =>
                        change({
                          ...service,
                          readiness: {
                            ...service.readiness,
                            endpoint: e.target.value,
                          },
                        })
                      }
                    >
                      {service.endpoints.map((endpoint) => (
                        <option key={endpoint.name}>{endpoint.name}</option>
                      ))}
                    </select>
                  </label>
                  {(['attempts', 'intervalMs'] as const).map((key) => (
                    <label key={key} className={styles.field}>
                      {key === 'attempts'
                        ? 'Readiness attempts'
                        : 'Readiness interval (ms)'}
                      <input
                        type="number"
                        min={1}
                        value={service.readiness[key]}
                        onChange={(e) =>
                          change({
                            ...service,
                            readiness: {
                              ...service.readiness,
                              [key]: Number(e.target.value),
                            },
                          })
                        }
                      />
                    </label>
                  ))}
                  <small>
                    Reference: {repo.id}/{service.id}
                  </small>
                  <button
                    onClick={() =>
                      update({
                        ...repo,
                        services: repo.services!.filter((_, i) => i !== index),
                      })
                    }
                  >
                    Remove service
                  </button>
                </fieldset>
              );
            })}
            <button
              disabled={p.disabled}
              onClick={() =>
                update({
                  ...repo,
                  services: [
                    ...(repo.services ?? []),
                    { ...serviceRecipe(newId()), name: 'New service' },
                  ],
                })
              }
            >
              Add dev service
            </button>
          </div>
          <div hidden={tab !== 'access'}>
            <p>
              Repository access inherits the profile’s Agents & access settings
              unless overridden here. Secrets remain in connected accounts or
              the environment.
            </p>
            <SourceControlFields
              profile
              inherited={p.inheritedAccess}
              inheritLabel="Use profile setting"
              disabled={p.disabled}
              value={repo.sourceControl}
              onChange={(sourceControl) => update({ ...repo, sourceControl })}
            />
          </div>
        </div>
      )}
    </section>
  );
}
function CommandTestButton(p: {
  profileId: string;
  repositoryId: string;
  commandId: string;
  revision: string;
  disabled: boolean;
  mismatch: (version: string | null) => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [runId, setRunId] = useState('');
  const run = async () => {
    if (
      !window.confirm(
        'Run this saved command and its prerequisites in an isolated worktree? It can access the profile’s configured environment and accounts.',
      )
    )
      return;
    setBusy(true);
    setError('');
    try {
      const result = await api<{ runId: string }>(
        '/api/profile-command-tests',
        p.mismatch,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            profileId: p.profileId,
            repositoryId: p.repositoryId,
            commandId: p.commandId,
            revision: p.revision,
          }),
        },
      );
      setRunId(result.runId);
    } catch (caught) {
      setError(await apiError(caught, 'Could not start the command test.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <button
        type="button"
        disabled={p.disabled || busy}
        onClick={() => void run()}
      >
        {busy ? 'Preparing test run…' : 'Test saved command'}
      </button>
      {p.disabled && <small>Save changes before testing.</small>}
      {runId && (
        <a href={`/runs/${encodeURIComponent(runId)}`}>
          View test run and logs
        </a>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
function Dependencies(p: {
  repos: WorkspaceRepository[];
  kind: 'commands' | 'services';
  self: string;
  value: string[];
  onChange: (value: string[]) => void;
}) {
  return (
    <details>
      <summary>Prerequisites ({p.value.length})</summary>
      {p.repos
        .flatMap((repo) =>
          (repo[p.kind] ?? []).map((entry) => ({
            id: `${repo.id}/${entry.id}`,
            name: `${repo.name} / ${entry.name}`,
          })),
        )
        .filter((entry) => entry.id !== p.self)
        .map((entry) => (
          <label key={entry.id} className={styles.checkbox}>
            <input
              type="checkbox"
              checked={p.value.includes(entry.id)}
              onChange={(e) =>
                p.onChange(
                  e.target.checked
                    ? [...p.value, entry.id]
                    : p.value.filter((id) => id !== entry.id),
                )
              }
            />
            {entry.name}
          </label>
        ))}
    </details>
  );
}
function Environment(p: {
  value: Record<string, string>;
  disabled: boolean;
  onChange: (value: Record<string, string>) => void;
}) {
  return (
    <details>
      <summary>Environment overrides</summary>
      <p>
        Non-secret values only. Use ${'{VARIABLE}'} to reference an existing
        secret environment variable.
      </p>
      <JsonField
        label="Environment (JSON)"
        value={p.value}
        disabled={p.disabled}
        onChange={(value) => {
          if (
            !value ||
            Array.isArray(value) ||
            typeof value !== 'object' ||
            Object.values(value).some((v) => typeof v !== 'string')
          )
            throw Error('Expected string values.');
          p.onChange(value as Record<string, string>);
        }}
      />
    </details>
  );
}
export function AutomationSettingsFields(p: {
  value: AutomationSettings;
  disabled: boolean;
  onChange: (value: AutomationSettings) => void;
}) {
  const value = p.value;
  return (
    <fieldset disabled={p.disabled}>
      <h2>Automation policy</h2>
      <label className={styles.checkbox}>
        <input
          type="checkbox"
          checked={value.workspaceSetup ?? false}
          onChange={(e) =>
            p.onChange({ ...value, workspaceSetup: e.target.checked })
          }
        />
        Set up dependencies before implementation
      </label>
      <label className={styles.field}>
        Pull requests
        <select
          value={value.pullRequests ?? 'lead'}
          onChange={(e) =>
            p.onChange({
              ...value,
              pullRequests: e.target.value as 'lead' | 'all-changed',
            })
          }
        >
          <option value="lead">Primary repository only</option>
          <option value="all-changed">Every changed repository</option>
        </select>
      </label>
      {(['reviewCap', 'ciCap', 'ciLogLines', 'maxTransitions'] as const).map(
        (key) => (
          <label key={key} className={styles.field}>
            {
              {
                reviewCap: 'Review and validation cycles',
                ciCap: 'CI repair attempts',
                ciLogLines: 'CI log lines',
                maxTransitions: 'Maximum workflow transitions',
              }[key]
            }
            <input
              type="number"
              min={1}
              value={value[key]}
              onChange={(e) =>
                p.onChange({ ...value, [key]: Number(e.target.value) })
              }
            />
          </label>
        ),
      )}
      <h3>Linear states</h3>
      {(['started', 'review', 'done'] as const).map((key) => (
        <label key={key} className={styles.field}>
          {key}
          <input
            value={value.states[key]}
            onChange={(e) =>
              p.onChange({
                ...value,
                states: { ...value.states, [key]: e.target.value },
              })
            }
          />
        </label>
      ))}
    </fieldset>
  );
}
