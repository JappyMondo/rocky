/**
 * The instance side of configuration (NG-594): two JSON files under
 * `~/.rocky`, hot-reloaded, with no secrets in the first.
 */
export {
  ROCKY_HOME_ENV,
  defaultRockyHome,
  rockyPaths,
  type RockyPaths,
  type RunPaths,
} from './paths.js';

export {
  ConfigError,
  SHIPPED_HARNESSES,
  credentialsSchema,
  harnessSchema,
  instanceConfigSchema,
  labelKey,
  parseCredentials,
  parseInstanceConfig,
  repoEntrySchema,
  repoGroupSchema,
  retentionSchema,
  serverSchema,
  type Credentials,
  type HarnessConfig,
  type InstanceConfig,
  type RepoEntry,
  type RepoGroup,
} from './schema.js';

export { expandHarness, expandVars, type Env } from './expand.js';

export {
  ensureInstanceLayout,
  readCredentials,
  readInstanceConfig,
  writeCredentials,
  writeInstanceConfig,
  type ReadOptions,
} from './store.js';

export {
  findRepo,
  groupsForRepo,
  resolveGroup,
  resolveRepoEnv,
  routableLabels,
  route,
  type Delegation,
  type GroupRoute,
  type RepoRoute,
  type Route,
  type RouteRefusal,
} from './routing.js';

export {
  REDACTED,
  SECRET_KEY_PATTERN,
  buildRedactionSet,
  createRedactor,
  redactingStream,
  type Redactor,
} from './redaction.js';

export {
  openConfigStore,
  type BoundServer,
  type ConfigStore,
  type OpenOptions,
  type ReloadReport,
  type RestartOnlyField,
} from './watcher.js';
