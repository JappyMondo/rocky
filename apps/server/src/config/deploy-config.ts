import { randomBytes } from 'node:crypto';

/**
 * Deploy config: the handful of values fixed at container start, read and
 * validated exactly once at boot. It exists only for what is needed before the
 * database is usable — the key that decrypts the store, the URL that cannot be
 * inferred without a browser, and logging that starts before either.
 *
 * These four variables are the complete list. Everything else is an Instance
 * setting living in the database and edited in the web UI; a fifth variable
 * here would give some setting two homes, and nobody could tell which won.
 */

/**
 * The data volume path is fixed and deliberately not configurable. Inside the
 * container the path is ours and Docker maps any host path onto it, so an env
 * var would be a knob that only offers ways to be wrong.
 */
export const DATA_DIR = '/data';

export const LOG_LEVELS = [
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export const DEFAULT_PORT = 3000;
export const DEFAULT_LOG_LEVEL: LogLevel = 'info';

/** Key material AES-256-GCM needs, in bytes. */
const ENCRYPTION_KEY_BYTES = 32;

const MIN_PORT = 1;
const MAX_PORT = 65535;

export interface DeployConfig {
  /** Base64 key for AES-256-GCM column encryption of the secrets store. */
  readonly encryptionKey: string;
  /** Public origin, normalised without a trailing slash. */
  readonly baseUrl: string;
  readonly port: number;
  readonly logLevel: LogLevel;
}

/**
 * Every problem found while reading the environment, collected in one throw so
 * an operator fixes all of them in one edit instead of one restart at a time.
 */
export class DeployConfigError extends Error {
  constructor(
    readonly problems: readonly string[],
    /** Set only when `ROCKY_ENCRYPTION_KEY` was absent, never when it was invalid. */
    readonly generatedEncryptionKey?: string,
  ) {
    super(`Invalid deploy configuration: ${problems.join(' ')}`);
    this.name = 'DeployConfigError';
  }
}

export function generateEncryptionKey(): string {
  return randomBytes(ENCRYPTION_KEY_BYTES).toString('base64');
}

export function loadDeployConfig(env: NodeJS.ProcessEnv): DeployConfig {
  const problems: string[] = [];

  const encryptionKey = readEncryptionKey(env, problems);
  const baseUrl = readBaseUrl(env, problems);
  const port = readPort(env, problems);
  const logLevel = readLogLevel(env, problems);

  if (problems.length > 0) {
    const missingKey = read(env, 'ROCKY_ENCRYPTION_KEY') === undefined;
    throw new DeployConfigError(
      problems,
      missingKey ? generateEncryptionKey() : undefined,
    );
  }

  // Every reader either pushed a problem or returned a value, and we bailed out
  // above if any of them pushed one.
  return {
    encryptionKey: encryptionKey as string,
    baseUrl: baseUrl as string,
    port: port as number,
    logLevel: logLevel as LogLevel,
  };
}

export function formatDeployConfigError(error: DeployConfigError): string {
  const lines = [
    'Rocky cannot start: the deploy configuration is not usable.',
    '',
    ...error.problems.map((problem) => `  - ${problem}`),
  ];

  if (error.generatedEncryptionKey) {
    lines.push(
      '',
      'A freshly generated key, ready to paste:',
      '',
      `  ROCKY_ENCRYPTION_KEY=${error.generatedEncryptionKey}`,
      '',
      `Rocky will not write this key into ${DATA_DIR} for you: the key and the`,
      'database must never end up in the same backup tarball, or a copied',
      'database would carry everything needed to decrypt itself.',
    );
  }

  lines.push(
    '',
    'These four variables are the whole configuration surface. There is no',
    'config file to look for — set them next to the port mapping in your',
    'docker-compose.yml.',
  );

  return lines.join('\n');
}

/** Reads an environment variable, treating blank as absent. */
function read(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

function readEncryptionKey(
  env: NodeJS.ProcessEnv,
  problems: string[],
): string | undefined {
  const value = read(env, 'ROCKY_ENCRYPTION_KEY');
  if (value === undefined) {
    problems.push('ROCKY_ENCRYPTION_KEY is required but was not set.');
    return undefined;
  }

  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== ENCRYPTION_KEY_BYTES) {
    problems.push(
      `ROCKY_ENCRYPTION_KEY must be ${ENCRYPTION_KEY_BYTES} bytes of base64 ` +
        `(AES-256-GCM), but decoded to ${decoded.length} bytes.`,
    );
    return undefined;
  }

  return value;
}

function readBaseUrl(
  env: NodeJS.ProcessEnv,
  problems: string[],
): string | undefined {
  const value = read(env, 'ROCKY_BASE_URL');
  if (value === undefined) {
    problems.push(
      'ROCKY_BASE_URL is required but was not set. It is the public origin ' +
        'Rocky builds webhook targets, OAuth redirects and report links from.',
    );
    return undefined;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    problems.push(`ROCKY_BASE_URL is not a valid absolute URL: ${value}`);
    return undefined;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    problems.push(
      `ROCKY_BASE_URL must be http or https, but was ${url.protocol}//`,
    );
    return undefined;
  }

  if (url.search !== '' || url.hash !== '') {
    problems.push(
      'ROCKY_BASE_URL must not carry a query string or fragment: ' +
        'Rocky appends its own paths to it.',
    );
    return undefined;
  }

  // Normalise away trailing slashes so callers can append '/api/...' safely.
  // A path is kept, so Rocky can live under a sub-path of a shared host.
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

function readPort(
  env: NodeJS.ProcessEnv,
  problems: string[],
): number | undefined {
  const value = read(env, 'ROCKY_PORT');
  if (value === undefined) {
    return DEFAULT_PORT;
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    problems.push(
      `ROCKY_PORT must be an integer between ${MIN_PORT} and ${MAX_PORT}, ` +
        `but was ${value}.`,
    );
    return undefined;
  }

  return port;
}

function readLogLevel(
  env: NodeJS.ProcessEnv,
  problems: string[],
): LogLevel | undefined {
  const value = read(env, 'ROCKY_LOG_LEVEL');
  if (value === undefined) {
    return DEFAULT_LOG_LEVEL;
  }

  const level = value.toLowerCase();
  if (!isLogLevel(level)) {
    problems.push(
      `ROCKY_LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}, ` +
        `but was ${value}.`,
    );
    return undefined;
  }

  return level;
}

function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}
