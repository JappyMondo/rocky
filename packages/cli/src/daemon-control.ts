/**
 * What `start -d`, `stop`, `restart` and `status` do underneath (NG-595).
 *
 * The pidfile is the CLI's way of finding a daemon it did not start: it
 * records the address actually bound, which an explicit `--port 0` makes the
 * only way to know. An explicit flag still wins over it, so a developer can
 * always address a daemon the pidfile has lost track of.
 */
import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';

import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  inspectPidFile,
  pidIsAlive,
  readInstanceConfig,
  removePidFile,
  rockyPaths,
  type DaemonRecord,
  type RockyPaths,
} from '@rocky/daemon';

import { DaemonClient, DaemonUnreachableError } from './client.js';

export interface AddressFlags {
  host?: string;
  port?: number;
}

export interface Address {
  host: string;
  port: number;
  url: string;
}

export interface ControlOptions {
  paths?: RockyPaths;
  /** Injected by the tests. */
  spawn?: typeof nodeSpawn;
  fetch?: typeof fetch;
  isAlive?(pid: number): boolean;
  /** The `rocky` entry point a detached daemon re-runs. */
  entry?: string;
  /** The environment the detached daemon inherits. */
  env?: NodeJS.ProcessEnv;
  /** How long to wait for a daemon to answer, or to go away. */
  timeoutMs?: number;
  /** Poll interval while waiting. */
  intervalMs?: number;
  now?(): number;
  sleep?(ms: number): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_INTERVAL_MS = 50;

function addressOf(host: string, port: number): Address {
  return { host, port, url: `http://${host}:${port}` };
}

/**
 * Explicit flags, then the running daemon's own pidfile, then `config.json`,
 * then the defaults.
 */
export async function resolveAddress(
  paths: RockyPaths,
  flags: AddressFlags = {},
  options: ControlOptions = {},
): Promise<Address> {
  // `--port 0` says "any free port" to a daemon starting up; as an address to
  // *find* one it means nothing, since nothing ever listens on port 0. So it
  // resolves like an absent flag, through the pidfile the daemon wrote.
  const wanted = flags.port === 0 ? undefined : flags.port;

  if (flags.host !== undefined && wanted !== undefined) {
    return addressOf(flags.host, wanted);
  }

  const found = await inspectPidFile(paths, { isAlive: options.isAlive });
  if (found.state === 'running') {
    return addressOf(
      flags.host ?? found.record.host,
      wanted ?? found.record.port,
    );
  }

  let host = DEFAULT_HOST;
  let port: number = DEFAULT_PORT;
  try {
    const config = await readInstanceConfig(paths);
    host = config.server.host;
    port = config.server.port;
  } catch {
    // A config too broken to read is `rocky doctor`'s to report; `status`
    // still has the defaults, and saying "nothing is listening on 7625" is
    // more use than refusing to look.
  }

  return addressOf(flags.host ?? host, wanted ?? port);
}

export interface DaemonStatus {
  address: Address;
  running: boolean;
  version?: string;
  web?: boolean;
  endpoint?: import('@rocky/daemon').EndpointHealth;
  record?: DaemonRecord;
  /** Set when the pidfile claims something the process table denies. */
  staleReason?: string;
}

export async function daemonStatus(
  paths: RockyPaths,
  flags: AddressFlags = {},
  options: ControlOptions = {},
  warn?: (message: string) => void,
): Promise<DaemonStatus> {
  const found = await inspectPidFile(paths, { isAlive: options.isAlive });
  const address = await resolveAddress(paths, flags, options);

  const client = new DaemonClient({
    host: address.host,
    port: address.port,
    fetch: options.fetch,
    warn,
  });

  try {
    const health = await client.health();
    return {
      address,
      running: true,
      version: health.version,
      web: health.web,
      endpoint: health.endpoint,
      ...(found.state === 'running' ? { record: found.record } : {}),
    };
  } catch (error) {
    if (!(error instanceof DaemonUnreachableError)) {
      throw error;
    }
    return {
      address,
      running: false,
      // A pidfile naming a live pid that will not answer is the pid-reuse
      // case: something is running under that number, but it is not Rocky.
      ...(found.state === 'stale' || found.state === 'unreadable'
        ? { staleReason: found.reason }
        : {}),
      ...(found.state === 'running'
        ? {
            record: found.record,
            staleReason: `${paths.pidFile} names pid ${String(found.record.pid)}, which is running but is not answering as Rocky on ${found.record.url} — its pid was probably reused. Delete the file and run \`rocky start -d\`.`,
          }
        : {}),
    };
  }
}

async function waitFor(
  predicate: () => Promise<boolean>,
  options: ControlOptions,
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const now = options.now ?? (() => Date.now());
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const deadline = now() + timeoutMs;
  for (;;) {
    if (await predicate()) {
      return true;
    }
    if (now() >= deadline) {
      return false;
    }
    await sleep(intervalMs);
  }
}

export class StartFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StartFailedError';
  }
}

/**
 * Runs `rocky start` again in a detached child, which writes the pidfile and
 * the log itself. There is one daemon code path either way — a backgrounded
 * daemon is not a second implementation that can drift from the foreground
 * one.
 */
export async function startDetached(
  paths: RockyPaths = rockyPaths(),
  flags: AddressFlags = {},
  options: ControlOptions = {},
): Promise<Address> {
  const already = await daemonStatus(paths, flags, options);
  if (already.running) {
    throw new StartFailedError(
      `a Rocky daemon is already running on ${already.address.url} — \`rocky restart\` to replace it`,
    );
  }

  const spawn = options.spawn ?? nodeSpawn;
  const entry = options.entry ?? process.argv[1];

  const args = [entry, 'start'];
  if (flags.host !== undefined) {
    args.push('--host', flags.host);
  }
  if (flags.port !== undefined) {
    args.push('--port', String(flags.port));
  }

  // Detached with its own session, and no inherited stdio: the daemon's output
  // is the rotated log, so holding the terminal's handles open would keep the
  // shell waiting on a process that has nothing more to say to it.
  const spawnOptions: SpawnOptions = {
    detached: true,
    stdio: 'ignore',
    env: options.env ?? process.env,
  };
  const child = spawn(process.execPath, args, spawnOptions);
  child.unref();

  const answered = await waitFor(async () => {
    const status = await daemonStatus(paths, flags, options);
    return status.running;
  }, options);

  if (!answered) {
    throw new StartFailedError(
      `the daemon did not come up within ${String(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)}ms — \`rocky logs\` should say why`,
    );
  }

  return (await daemonStatus(paths, flags, options)).address;
}

export type StopOutcome =
  | { stopped: true; how: 'api' | 'signal'; pid?: number }
  | { stopped: false; reason: 'not-running'; cleanedStalePidfile: boolean }
  | { stopped: false; reason: 'would-not-die'; pid: number };

/**
 * Asks over the local API, then falls back to SIGTERM. The API is the stated
 * route (NG-595) but a daemon too wedged to answer HTTP still has to be
 * stoppable, and SIGTERM is the same clean end launchd and systemd use.
 */
export async function stopDaemon(
  paths: RockyPaths = rockyPaths(),
  flags: AddressFlags = {},
  options: ControlOptions = {},
): Promise<StopOutcome> {
  const isAlive = options.isAlive ?? pidIsAlive;
  const found = await inspectPidFile(paths, { isAlive });
  const status = await daemonStatus(paths, flags, options);

  if (!status.running) {
    // A stale pidfile is detected, not obeyed — and cleaned up while we are
    // here, so the next `start -d` does not have to mention it.
    const stale = found.state === 'stale' || found.state === 'unreadable';
    if (stale) {
      await removePidFile(paths);
    }
    return {
      stopped: false,
      reason: 'not-running',
      cleanedStalePidfile: stale,
    };
  }

  const client = new DaemonClient({
    host: status.address.host,
    port: status.address.port,
    fetch: options.fetch,
    warn: () => undefined,
  });

  const pid = status.record?.pid;
  const cleanUp = () => removePidFile(paths, pid === undefined ? {} : { pid });

  // A daemon running inside this very process — `rocky start` in the
  // foreground being asked to stop by something in-process — must not be
  // watched for its pid leaving the process table, and must never be
  // signalled: both would be this process acting on itself.
  const separate = pid !== undefined && pid !== process.pid;

  /** Gone means: the pid is off the process table, or nothing answers. */
  const hasGone = async () =>
    separate
      ? !isAlive(pid)
      : !(await daemonStatus(paths, flags, options)).running;

  let asked = true;
  try {
    await client.shutdown();
  } catch {
    // A daemon too wedged to answer HTTP still has to be stoppable, so the
    // signal is tried straight away rather than after the full wait.
    asked = false;
  }

  if (asked && (await waitFor(hasGone, options))) {
    // The daemon removes its own pidfile; this covers one that died between
    // the reply and the cleanup.
    await cleanUp();
    return { stopped: true, how: 'api', ...(pid === undefined ? {} : { pid }) };
  }

  if (!separate) {
    // Nothing safe to signal: either the daemon answered but its pidfile is
    // gone, so the only handle on it was the one that just failed, or the
    // pidfile names this very process.
    return { stopped: false, reason: 'would-not-die', pid: pid ?? -1 };
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Already gone between the check and the signal.
  }

  if (!(await waitFor(hasGone, options))) {
    return { stopped: false, reason: 'would-not-die', pid };
  }

  await cleanUp();
  return { stopped: true, how: 'signal', pid };
}
