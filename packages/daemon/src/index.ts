export {
  createDaemon,
  startDaemon,
  DEFAULT_HOST,
  DEFAULT_PORT,
  type DaemonOptions,
  type HealthStatus,
  type RunningDaemon,
} from './server.js';

export {
  CLIENT_VERSION_HEADER,
  DAEMON_VERSION,
  VERSION_HEADER,
} from './version.js';

export { resolveWebRoot } from './web-root.js';

export * from './config/index.js';
