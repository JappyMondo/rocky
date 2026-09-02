/**
 * The live view of the instance config (NG-578).
 *
 * The daemon watches `config.json` and reloads everything live **except**
 * bind/port, which needs `rocky restart`. Repo and group edits apply to new
 * Runs only, matching snapshot semantics — which falls out of `current` being
 * a value a Run holds onto rather than something it reads per Step.
 * Credentials are re-read on demand.
 */
import { watch, type FSWatcher } from 'node:fs';

import { rockyPaths, type RockyPaths } from './paths.js';
import {
  buildRedactionSet,
  createRedactor,
  type Redactor,
} from './redaction.js';
import {
  ensureInstanceLayout,
  readCredentials,
  readInstanceConfig,
} from './store.js';
import type { Credentials, InstanceConfig } from './schema.js';

/** The fields a reload cannot apply, because the socket is already open. */
const RESTART_ONLY = ['host', 'port'] as const;

export type RestartOnlyField = (typeof RESTART_ONLY)[number];

export interface ReloadReport {
  config: InstanceConfig;
  /** Empty when the reload applied in full. */
  restartRequired: RestartOnlyField[];
  /** Set exactly when `restartRequired` is not empty. */
  restartHint?: string;
}

export interface BoundServer {
  host: string;
  port: number;
}

export interface ConfigStore {
  /**
   * The newest good config. A Run takes this once at start and keeps it, which
   * is what makes repo and group edits apply to new Runs only.
   */
  readonly current: InstanceConfig;
  /**
   * What the daemon actually bound, frozen at open. This — not
   * `current.server` — is the truth about the running socket.
   */
  readonly boundServer: BoundServer;
  /**
   * One stable function over a set that reloads update in place. The daemon
   * wires this into its log destination once, at boot, and it stays correct as
   * secrets come and go.
   */
  readonly redact: Redactor;
  /** Re-read `config.json` now. Throws if it cannot be used. */
  reload(): Promise<ReloadReport>;
  /** Re-read `credentials.json`. Never cached — see NG-578. */
  readCredentials(): Promise<Credentials>;
  /** Resolves on the next reload the watcher drives. */
  nextReload(): Promise<ReloadReport>;
  /** A reload the watcher drove and could not apply. */
  onError(listener: (error: unknown) => void): void;
  close(): Promise<void>;
}

export interface OpenOptions {
  /** Where the restart hint and the credentials-mode warning go. */
  warn?(message: string): void;
  /** Off in tests that drive `reload()` themselves. */
  watch?: boolean;
  /** Coalescing window: an editor's save is rarely one filesystem event. */
  debounceMs?: number;
}

export async function openConfigStore(
  paths: RockyPaths = rockyPaths(),
  options: OpenOptions = {},
): Promise<ConfigStore> {
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const debounceMs = options.debounceMs ?? 30;

  await ensureInstanceLayout(paths);

  let current = await readInstanceConfig(paths);
  let credentials = await readCredentials(paths, { warn });

  const boundServer: BoundServer = { ...current.server };

  // Mutable, so the one `redact` handed out at boot keeps working.
  let secrets = createRedactor(buildRedactionSet(current, credentials));
  const redact: Redactor = (text) => secrets(text);
  const refreshSecrets = () => {
    secrets = createRedactor(buildRedactionSet(current, credentials));
  };

  const reloadListeners = new Set<(report: ReloadReport) => void>();
  const errorListeners = new Set<(error: unknown) => void>();

  const apply = (next: InstanceConfig): ReloadReport => {
    const restartRequired = RESTART_ONLY.filter(
      (field) => next.server[field] !== boundServer[field],
    );

    current = next;
    refreshSecrets();

    if (restartRequired.length === 0) {
      return { config: next, restartRequired };
    }

    const moved = restartRequired
      .map((field) => `${field} ${boundServer[field]} → ${next.server[field]}`)
      .join(', ');
    const restartHint = `config.json changed ${moved}, which cannot be applied to a socket that is already open — run \`rocky restart\` to pick it up. Everything else in the reload has been applied.`;

    warn(restartHint);
    return { config: next, restartRequired, restartHint };
  };

  const store: ConfigStore = {
    get current() {
      return current;
    },
    get boundServer() {
      return { ...boundServer };
    },
    redact,

    async reload() {
      // Reading and parsing before assigning is what keeps the last good
      // config in place when the file is mid-edit or simply wrong.
      return apply(await readInstanceConfig(paths));
    },

    async readCredentials() {
      credentials = await readCredentials(paths, { warn });
      refreshSecrets();
      return credentials;
    },

    nextReload() {
      return new Promise<ReloadReport>((resolve) => {
        const once = (report: ReloadReport) => {
          reloadListeners.delete(once);
          resolve(report);
        };
        reloadListeners.add(once);
      });
    },

    onError(listener) {
      errorListeners.add(listener);
    },

    async close() {
      watcher?.close();
      watcher = undefined;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };

  let watcher: FSWatcher | undefined;
  let timer: NodeJS.Timeout | undefined;

  if (options.watch !== false) {
    // The directory, not the file: an atomic write replaces the inode, and a
    // watch on the old one stops seeing anything. Rocky's own writes go
    // through `writeAtomic`, so this is the normal case rather than the odd
    // one.
    watcher = watch(paths.root, (_event, filename) => {
      if (filename !== null && filename !== 'config.json') {
        return;
      }

      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        timer = undefined;
        void (async () => {
          try {
            const report = await store.reload();
            for (const listener of [...reloadListeners]) {
              listener(report);
            }
          } catch (error) {
            // A bad edit must not take the daemon down, and it must not
            // silently leave it on a config nobody can see any more.
            warn(String(error));
            for (const listener of [...errorListeners]) {
              listener(error);
            }
          }
        })();
      }, debounceMs);
      timer.unref?.();
    });
  }

  return store;
}
