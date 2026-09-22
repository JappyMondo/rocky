import {
  defaultFlowSettings,
  parseFlow,
  type FlowSettings,
  type UiEndpoint,
} from './flow.js';
import type { SourceControlSettings } from './index.js';

export type SelectionPolicy = 'agent' | 'required' | 'manual';
export interface RepositoryCommand {
  id: string;
  name: string;
  purpose: 'install' | 'test' | 'lint' | 'build' | 'other';
  command: string;
  cwd: string;
  policy: SelectionPolicy;
  description: string;
  timeoutMs: number;
  endpointEnv?: Record<string, { service: string; endpoint: string }>;
  dependsOn: string[];
  env: Record<string, string>;
}
export interface DevService {
  id: string;
  name: string;
  start: string;
  stop?: string;
  cwd: string;
  policy: SelectionPolicy;
  description: string;
  dependsOn: string[];
  env: Record<string, string>;
  portEnv: string;
  /** Environment variable -> dependency service ID and endpoint name. */
  endpointEnv?: Record<string, { service: string; endpoint: string }>;
  endpoints: Array<{ name: string; locator: UiEndpoint }>;
  readiness: { endpoint: string; attempts: number; intervalMs: number };
}
export interface WorkspaceRepository {
  /** Stable across folder and display-name changes. Missing only in legacy profiles. */
  id?: string;
  name: string;
  url: string;
  baseBranch: string;
  commands?: RepositoryCommand[];
  services?: DevService[];
  environment?: import('./environment.js').EnvironmentRecipe;
  ci?: 'required' | 'none';
  sourceControl?: SourceControlSettings;
}
export type AutomationSettings = Pick<
  FlowSettings,
  | 'workspaceSetup'
  | 'pullRequests'
  | 'states'
  | 'reviewCap'
  | 'ciCap'
  | 'readiness'
  | 'ciLogLines'
  | 'maxTransitions'
>;
export interface ConfigurationConflict {
  repository: string;
  id: string;
  kind: 'command' | 'service';
  choices: Array<{ source: string; value: RepositoryCommand | DevService }>;
}
export interface WorkspaceConfiguration {
  repos: WorkspaceRepository[];
  automation: AutomationSettings;
}
export interface ConfigurationMigration extends WorkspaceConfiguration {
  conflicts: ConfigurationConflict[];
  errors: string[];
}
export function commandRecipe(id: string, command = ''): RepositoryCommand {
  return {
    id,
    name: id,
    purpose: 'other',
    command,
    cwd: '.',
    policy: 'agent',
    description: '',
    timeoutMs: 600000,
    dependsOn: [],
    env: {},
  };
}
export function serviceRecipe(id: string): DevService {
  return {
    id,
    name: id,
    start: '',
    cwd: '.',
    policy: 'agent',
    description: '',
    dependsOn: [],
    env: {},
    portEnv: 'PORT',
    endpoints: [
      {
        name: 'web',
        locator: { kind: 'assigned-port', url: 'http://127.0.0.1/' },
      },
    ],
    readiness: { endpoint: 'web', attempts: 30, intervalMs: 1000 },
  };
}
export function automationSettings(
  settings: FlowSettings = defaultFlowSettings(),
): AutomationSettings {
  const {
    workspaceSetup,
    pullRequests,
    states,
    reviewCap,
    ciCap,
    readiness,
    ciLogLines,
    maxTransitions,
  } = settings;
  return {
    workspaceSetup,
    pullRequests,
    states,
    reviewCap,
    ciCap,
    readiness,
    ciLogLines,
    maxTransitions,
  };
}

/** Pure migration proposal. Conflicting values are never silently ranked. */
export function proposeConfiguration(input: {
  repos: WorkspaceRepository[];
  source: string;
  settings?: {
    buildCommand?: string;
    testCommand?: string;
    uiCommand?: string;
  };
}): ConfigurationMigration {
  const flow = parseFlow(input.source);
  const conflicts: ConfigurationConflict[] = [];
  const errors: string[] = [];
  const repos = input.repos.map((repo, index) => {
    const id = repo.id ?? repo.name;
    const commands: RepositoryCommand[] = [...(repo.commands ?? [])];
    const services: DevService[] = [...(repo.services ?? [])];
    const legacy = flow.settings.repositories?.[repo.name];
    for (const purpose of ['install', 'test', 'lint', 'build'] as const) {
      const candidates = [
        {
          source: 'Repository flow recipe',
          value: legacy?.commands?.[purpose],
        },
        {
          source: 'Flow settings',
          value: index === 0 ? flow.settings.commands[purpose] : undefined,
        },
        {
          source: 'Profile settings',
          value:
            index === 0
              ? input.settings?.[
                  purpose === 'build'
                    ? 'buildCommand'
                    : purpose === 'test'
                      ? 'testCommand'
                      : 'uiCommand'
                ]
              : undefined,
        },
      ].filter(
        (entry) =>
          entry.value?.trim() &&
          !(
            entry.source === 'Profile settings' &&
            purpose !== 'test' &&
            purpose !== 'build'
          ),
      );
      const choices = [
        ...new Map(candidates.map((entry) => [entry.value, entry])).values(),
      ].map((entry) => ({
        source: entry.source,
        value: {
          ...commandRecipe(purpose, entry.value!),
          purpose,
          policy:
            purpose === 'install' && !flow.settings.workspaceSetup
              ? ('manual' as const)
              : ('required' as const),
        },
      }));
      if (commands.some((command) => command.id === purpose)) continue;
      if (choices.length === 1) commands.push(choices[0].value);
      else if (choices.length > 1)
        conflicts.push({
          repository: id,
          id: purpose,
          kind: 'command',
          choices,
        });
    }
    for (const recipe of legacy?.ui ?? [])
      services.push({
        ...serviceRecipe(recipe.id),
        start: recipe.start,
        endpoints: [{ name: 'web', locator: recipe.endpoint }],
      });
    if (index === 0 && flow.settings.ui) {
      const value = {
        ...serviceRecipe('web'),
        start: flow.settings.ui.start,
        endpoints: [
          {
            name: 'web',
            locator: {
              kind: 'assigned-port' as const,
              url: flow.settings.ui.url,
            },
          },
        ],
      };
      if (
        services.length &&
        !services.some(
          (service) =>
            service.start === value.start &&
            JSON.stringify(service.endpoints) ===
              JSON.stringify(value.endpoints),
        )
      ) {
        conflicts.push({
          repository: id,
          id: 'web',
          kind: 'service',
          choices: [
            { source: 'Flow UI settings', value },
            ...services.map((service) => ({
              source: `Repository recipe: ${service.name}`,
              value: service,
            })),
          ],
        });
      } else if (!services.length) services.push(value);
    }
    if (
      index === 0 &&
      input.settings?.uiCommand?.trim() &&
      !services.some((service) => service.start === input.settings?.uiCommand)
    )
      errors.push(
        'Profile uiCommand has no reliable endpoint. Add a dev service with its endpoint before clearing this legacy field.',
      );
    return {
      ...repo,
      id,
      commands,
      services,
      ci:
        repo.ci ??
        (flow.settings.ciSkipRepositories?.includes(repo.name)
          ? ('none' as const)
          : ('required' as const)),
    };
  });
  for (const name of Object.keys(flow.settings.repositories ?? {}))
    if (!repos.some((repo) => repo.name === name))
      errors.push(
        `Recipes reference missing repository ${name}. Restore or explicitly remove that legacy recipe before migrating.`,
      );
  return {
    repos,
    automation: automationSettings(flow.settings),
    conflicts,
    errors,
  };
}

const safeId = (id: string) => /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(id);
export const repositoryRelativePath = (path: string) =>
  !!path &&
  !path.startsWith('/') &&
  !path.includes('\\') &&
  !path.split('/').includes('..') &&
  !path.includes('\0');
/** Shared semantic validation for all editors and run admission. */
export function validateConfiguration(config: WorkspaceConfiguration): void {
  const ids = new Set<string>();
  const names = new Set<string>();
  const tasks = new Map<string, string[]>();
  const services = new Map<string, string[]>();
  const checkLocator = (locator: UiEndpoint) => {
    if (locator.kind === 'assigned-port' || locator.kind === 'fixed') {
      if (!/^https?:\/\/[^\s/@?#]+(?:[/?#].*)?$/.test(locator.url))
        throw Error('Endpoints must be HTTP(S) URLs without credentials.');
    } else if (locator.kind === 'output-regex') {
      if (
        !locator.pattern.includes('(?<url>') &&
        !locator.pattern.includes('(?<port>')
      )
        throw Error('Output patterns need a named url or port capture.');
      new RegExp(locator.pattern);
    } else if (locator.kind === 'json-file') {
      if (
        !repositoryRelativePath(locator.path) ||
        !locator.pointer.startsWith('/')
      )
        throw Error('Use a repository-relative JSON file and JSON pointer.');
    } else if (locator.kind === 'command' && !locator.command.trim())
      throw Error('Endpoint resolver command is required.');
  };
  for (const repo of config.repos) {
    if (!repo.id || !safeId(repo.id) || ids.has(repo.id))
      throw Error('Repositories need unique stable IDs.');
    if (!safeId(repo.name) || names.has(repo.name.toLowerCase()))
      throw Error('Repositories need unique folder names.');
    ids.add(repo.id);
    names.add(repo.name.toLowerCase());
    for (const [kind, entries, graph] of [
      ['command', repo.commands ?? [], tasks],
      ['service', repo.services ?? [], services],
    ] as const) {
      for (const entry of entries) {
        const key = `${repo.id}/${entry.id}`;
        if (!safeId(entry.id) || graph.has(key))
          throw Error(`Duplicate or invalid ${kind} ID: ${key}`);
        if (!repositoryRelativePath(entry.cwd))
          throw Error(`Working directory must stay inside ${repo.name}.`);
        if (
          !entry.name.trim() ||
          !('command' in entry ? entry.command : entry.start).trim()
        )
          throw Error(`${key} needs a name and command.`);
        for (const name of Object.keys(entry.env)) {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
            throw Error(`Invalid environment name: ${name}`);
          if (
            repo.environment &&
            /secret|token|password|credential|api_key/i.test(name) &&
            !/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(entry.env[name])
          )
            throw Error(
              'Environment secrets must use machine variable references, not literal values.',
            );
        }
        graph.set(key, entry.dependsOn);
      }
    }
    for (const service of repo.services ?? []) {
      if (
        (service.portEnv !== '' &&
          !/^[A-Za-z_][A-Za-z0-9_]*$/.test(service.portEnv)) ||
        (!service.portEnv &&
          service.endpoints.some(
            (endpoint) => endpoint.locator.kind === 'assigned-port',
          ))
      )
        throw Error('Invalid port environment variable.');
      const endpointNames = new Set<string>();
      for (const endpoint of service.endpoints) {
        if (!safeId(endpoint.name) || endpointNames.has(endpoint.name))
          throw Error('Endpoint names must be unique.');
        endpointNames.add(endpoint.name);
        checkLocator(endpoint.locator);
      }
      if (!endpointNames.has(service.readiness.endpoint))
        throw Error(`Choose a readiness endpoint for ${service.name}.`);
    }
  }
  for (const repo of config.repos) {
    for (const entry of [...(repo.commands ?? []), ...(repo.services ?? [])]) {
      for (const [variable, reference] of Object.entries(
        entry.endpointEnv ?? {},
      )) {
        const dependency = config.repos
          .flatMap((r) =>
            (r.services ?? []).map((s) => ({
              id: `${r.id}/${s.id}`,
              service: s,
            })),
          )
          .find((s) => s.id === reference.service);
        if (
          !/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable) ||
          !dependency?.service.endpoints.some(
            (e) => e.name === reference.endpoint,
          )
        )
          throw Error(
            'Endpoint environment references must name a configured service endpoint.',
          );
        if ('start' in entry && !entry.dependsOn.includes(reference.service))
          throw Error(
            'Service endpoint references require an explicit service dependency.',
          );
      }
    }
    if (repo.environment && repo.environment.version !== 1)
      throw Error('Unsupported environment recipe version.');
    const capabilities = new Set<string>();
    for (const capability of repo.environment?.capabilities ?? []) {
      if (
        repo.environment?.version !== 1 ||
        !safeId(capability.id) ||
        capabilities.has(capability.id)
      )
        throw Error('Environment capabilities need unique IDs and version 1.');
      capabilities.add(capability.id);
      if (
        !capability.sources.length ||
        capability.sources.some((s) => !repositoryRelativePath(s.path))
      )
        throw Error(
          'Environment evidence must reference repository-relative source paths.',
        );
      if (
        !capability.checks.length ||
        new Set(capability.checks).size !== capability.checks.length ||
        capability.checks.some((id) => !safeId(id))
      )
        throw Error('Environment verification needs unique named checks.');
      if (
        ![capability.verify, ...capability.setup].every((id) =>
          tasks.has(id),
        ) ||
        !capability.services.every((id) => services.has(id))
      )
        throw Error(
          'Environment recipes must reference configured commands and services.',
        );
      const auth = capability.authentication;
      if (
        auth &&
        !(auth.kind === 'secret-env'
          ? /^[A-Za-z_][A-Za-z0-9_]*$/.test(auth.reference)
          : repositoryRelativePath(auth.reference) &&
            capability.sources.some((source) => source.path === auth.reference))
      )
        throw Error(
          'Authentication must reference a document or secret environment variable, never a credential value.',
        );
    }
  }
  for (const graph of [tasks, services]) {
    const visiting = new Set<string>(),
      done = new Set<string>();
    const visit = (key: string) => {
      if (!graph.has(key)) throw Error(`Unknown dependency: ${key}`);
      if (visiting.has(key)) throw Error(`Dependency cycle at ${key}`);
      if (done.has(key)) return;
      visiting.add(key);
      for (const dependency of graph.get(key)!) visit(dependency);
      visiting.delete(key);
      done.add(key);
    };
    for (const key of graph.keys()) visit(key);
  }
}

/** Only new run snapshots receive this materialized execution configuration. */
export function materializeConfiguration(
  source: string,
  config: WorkspaceConfiguration,
): string {
  validateConfiguration(config);
  const flow = parseFlow(source);
  for (const node of flow.nodes)
    if (
      node.type === 'command' &&
      node.parameters.recipe &&
      !config.repos.some((repo) =>
        repo.commands?.some(
          (command) => `${repo.id}/${command.id}` === node.parameters.recipe,
        ),
      )
    )
      throw Error(
        `Workflow command ${node.name} references a missing repository command: ${node.parameters.recipe}`,
      );
  for (const node of flow.nodes)
    if (
      node.type === 'service.start' &&
      !config.repos.some((repo) =>
        repo.services?.some(
          (service) => `${repo.id}/${service.id}` === node.parameters.recipe,
        ),
      )
    )
      throw Error(
        `Workflow service ${node.name} references a missing repository service: ${node.parameters.recipe}`,
      );
  flow.settings = {
    ...flow.settings,
    ...config.automation,
    commands: { install: '', test: '', lint: '', build: '' },
    ui: null,
    repositories: {},
    ciSkipRepositories: config.repos
      .filter((repo) => repo.ci === 'none')
      .map((repo) => repo.name),
    execution: config.repos,
    environmentVersion: 1,
  };
  return JSON.stringify(flow, null, 2) + '\n';
}
