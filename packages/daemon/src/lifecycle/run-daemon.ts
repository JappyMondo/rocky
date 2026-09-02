/**
 * The daemon as a process (NG-595).
 *
 * `createDaemon` builds a Fastify instance; this builds the *thing that runs*
 * around it — the pidfile, the rotated and redacted log, the config store, and
 * an end that leaves none of them half-written. `rocky start` runs this in the
 * foreground and `rocky start -d` runs it in a detached child; there is one
 * code path either way, so a backgrounded daemon is not a second
 * implementation that can drift.
 */
import { Writable } from 'node:stream';

import type { FastifyInstance } from 'fastify';

import {
  DEFAULT_KEEP,
  DEFAULT_MAX_BYTES,
  rotatingLogStream,
} from './log-rotation.js';
import {
  inspectPidFile,
  removePidFile,
  writePidFile,
  type InspectOptions,
} from './pidfile.js';
import { rockyPaths, type RockyPaths } from '../config/paths.js';
import { redactingStream } from '../config/redaction.js';
import { ensureInstanceLayout } from '../config/store.js';
import { openConfigStore, type ConfigStore } from '../config/watcher.js';
import {
  startDaemon,
  type DaemonOptions,
  type RunningDaemon,
} from '../server.js';
import { DAEMON_VERSION } from '../version.js';

/** The signals a service manager and a terminal use to ask for a clean end. */
const STOP_SIGNALS = ['SIGTERM', 'SIGINT'] as const;

export interface RunDaemonOptions
  extends Pick<DaemonOptions, 'webRoot'>, InspectOptions {
  paths?: RockyPaths;
  /** Overrides `config.json`'s `server.host`. */
  host?: string;
  /** Overrides `config.json`'s `server.port`. `0` asks for any free port. */
  port?: number;
  logLevel?: string;
  /** Where the log is echoed as well as written — stdout, in the foreground. */
  echo?: Writable;
  maxLogBytes?: number;
  keepLogs?: number;
  /** Off in tests that must not touch the process's own signal handlers. */
  handleSignals?: boolean;
}

export interface DaemonProcess {
  host: string;
  port: number;
  url: string;
  log: FastifyInstance['log'];
  config: ConfigStore;
  /** Settles once the daemon has stopped and cleaned up after itself. */
  stopped: Promise<void>;
  /** Idempotent: stopping an already-stopped daemon is not an error. */
  stop(): Promise<void>;
}

/** Raised when a daemon is already answering for this `~/.rocky`. */
export class DaemonAlreadyRunningError extends Error {
  constructor(
    readonly pid: number,
    readonly url: string,
  ) {
    super(
      `a Rocky daemon is already running as pid ${String(pid)} on ${url} — \`rocky stop\` to end it, or \`rocky restart\` to replace it`,
    );
    this.name = 'DaemonAlreadyRunningError';
  }
}

/**
 * Writes to both, but owns only the first. A foreground `rocky start` should
 * show its log in the terminal *and* leave it where `rocky logs` will find it;
 * ending this must close the file and never stdout, which belongs to the
 * terminal rather than to us.
 */
function teeStream(owned: Writable, echo: Writable): Writable {
  return new Writable({
    write(chunk: Buffer | string, encoding, callback) {
      echo.write(chunk, encoding as BufferEncoding);
      owned.write(chunk, encoding as BufferEncoding, callback);
    },
    final(callback) {
      owned.end(() => {
        callback();
      });
    },
  });
}

export async function runDaemon(
  options: RunDaemonOptions = {},
): Promise<DaemonProcess> {
  const paths = options.paths ?? rockyPaths();

  await ensureInstanceLayout(paths);

  // The config store warns before there is anywhere to warn to — the redaction
  // set it builds is what makes the log safe to write in the first place — so
  // early warnings are held and replayed once the log exists.
  const held: string[] = [];
  const later: { warn?: (message: string) => void } = {};
  const warn = (message: string) => {
    if (later.warn) {
      later.warn(message);
      return;
    }
    held.push(message);
  };

  const config = await openConfigStore(paths, { warn });
  // The redaction set covers credentials only once they have been read.
  await config.readCredentials();

  const existing = await inspectPidFile(paths, { isAlive: options.isAlive });
  if (existing.state === 'running') {
    await config.close();
    throw new DaemonAlreadyRunningError(
      existing.record.pid,
      existing.record.url,
    );
  }
  if (existing.state === 'stale' || existing.state === 'unreadable') {
    // Detected, not obeyed: a daemon that was killed must not leave Rocky
    // unstartable until a human deletes a file.
    warn(existing.reason);
  }

  const file = rotatingLogStream(paths.daemonLog, {
    maxBytes: options.maxLogBytes ?? DEFAULT_MAX_BYTES,
    keep: options.keepLogs ?? DEFAULT_KEEP,
  });
  // Redaction wraps the echo as well as the file: a secret must not reach the
  // developer's terminal either.
  const log = redactingStream(
    options.echo ? teeStream(file, options.echo) : file,
    config.redact,
  );

  let server: RunningDaemon;
  try {
    server = await startDaemon({
      host: options.host ?? config.current.server.host,
      port: options.port ?? config.current.server.port,
      webRoot: options.webRoot,
      logger: { level: options.logLevel ?? 'info', stream: log },
      // Read both values at the point the daemon uses them, so the config
      // watcher's hot reload applies without restarting this process.
      publicUrl: () => config.current.publicUrl,
      webhookSecret: async () =>
        (await config.readCredentials()).linear?.webhookSecret,
      onShutdown: () => {
        void stop();
      },
    });
  } catch (error) {
    await config.close();
    await new Promise<void>((resolve) => log.end(() => resolve()));
    throw error;
  }

  later.warn = (message: string) => {
    server.log.warn(message);
  };
  for (const message of held.splice(0)) {
    later.warn(message);
  }

  await writePidFile(paths, {
    pid: process.pid,
    host: server.host,
    // The bound port, not the requested one: `--port 0` is a real way to start
    // a daemon and `rocky stop` has to reach whatever it got.
    port: server.port,
    url: server.url,
    version: DAEMON_VERSION,
    startedAt: new Date().toISOString(),
  });

  let stopping: Promise<void> | undefined;
  let settle: () => void;
  const stopped = new Promise<void>((resolve) => {
    settle = resolve;
  });

  const onSignal = () => {
    void stop();
  };

  function stop(): Promise<void> {
    // Idempotent, because both a SIGTERM and an API shutdown can arrive for
    // the same stop, and running the teardown twice would be the corruption
    // this is here to prevent.
    stopping ??= (async () => {
      if (options.handleSignals !== false) {
        for (const signal of STOP_SIGNALS) {
          process.removeListener(signal, onSignal);
        }
      }

      await server.close();
      await config.close();
      // Only ours: a slow stop must not delete the pidfile a restart has
      // already written for the daemon that replaced this one.
      await removePidFile(paths, { pid: process.pid });
      // Ending the wrapper flushes it and ends the file under it, so every
      // line pino handed over is on disk before this resolves.
      await new Promise<void>((resolve) => log.end(() => resolve()));
      settle();
    })();

    return stopping;
  }

  if (options.handleSignals !== false) {
    for (const signal of STOP_SIGNALS) {
      process.on(signal, onSignal);
    }
  }

  return {
    host: server.host,
    port: server.port,
    url: server.url,
    log: server.log,
    config,
    stopped,
    stop,
  };
}
