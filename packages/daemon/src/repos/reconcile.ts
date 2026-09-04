/**
 * Keeping `~/.rocky/repos` in step with `config.json` (NG-521, NG-578).
 *
 * There are two ways a repo entry appears. `rocky repo add` is the one with a
 * human at a terminal, and it clones eagerly so a bad url or a missing SSH key
 * fails there and then rather than inside a Run an hour later. The other is a
 * hand-edit that the config watcher picks up — and nobody is watching then, so
 * the daemon clones it itself, and every outcome including the failures is a
 * value the caller can put in front of a human.
 *
 * Nothing here removes a clone. A repo entry deleted from `config.json` leaves
 * its clone alone: it may hold the only copy of a parked Run's branch, and
 * NG-574's rule is that Rocky never destroys work.
 */
import { ensureClone } from './clone.js';
import type { CloneRef, RepoContext } from './context.js';

export interface ReconcileReport {
  /** Repos cloned for the first time by this pass. */
  cloned: string[];
  /** Repos that were already there, and have now been fetched. */
  updated: string[];
  failures: { repo: string; message: string }[];
}

export async function reconcileClones(
  ctx: RepoContext,
  repos: readonly CloneRef[],
): Promise<ReconcileReport> {
  const report: ReconcileReport = { cloned: [], updated: [], failures: [] };

  // Sequential: a hand-edit that adds three repos at once should not open
  // three fetches on one uplink, and the mutex would serialize them anyway if
  // they happened to be the same repo.
  for (const repo of repos) {
    try {
      const outcome = await ensureClone(ctx, repo);
      (outcome.state === 'created' ? report.cloned : report.updated).push(
        repo.name,
      );
    } catch (error) {
      // One bad entry must not cost the others their clone.
      report.failures.push({
        repo: repo.name,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return report;
}

/** The subset of `ConfigStore` this needs, so a test can pass a small one. */
export interface ReloadSource {
  readonly current: { repos: readonly CloneRef[] };
  nextReload(): Promise<unknown>;
}

export interface FollowOptions {
  /** Called after every reload, failures included. The daemon log, in production. */
  onReport?(report: ReconcileReport): void;
}

export interface Follower {
  close(): void;
}

/**
 * Reconcile after every config reload the watcher drives, for as long as the
 * daemon is up. NG-595 owns calling this at boot; NG-521 owns what it does.
 *
 * `nextReload()` is a one-shot promise, so this re-arms in a loop rather than
 * registering a listener — which also means a `close()` between reloads leaves
 * one promise pending forever, and that is fine: it settles at the next reload
 * and the loop checks the flag before doing anything with it.
 */
export function followConfigReloads(
  ctx: RepoContext,
  store: ReloadSource,
  options: FollowOptions = {},
): Follower {
  let following = true;

  void (async () => {
    while (following) {
      await store.nextReload();
      if (!following) {
        return;
      }

      const report = await reconcileClones(ctx, store.current.repos);
      if (following) {
        options.onReport?.(report);
      }
    }
  })();

  return {
    close() {
      following = false;
    },
  };
}
