/**
 * The per-repo mutex (NG-521, NG-578).
 *
 * The audit behind ADR 0001 found that Sandcastle's `createWorktree()` calls
 * `pruneStale()`, which recursively deletes worktrees git no longer considers
 * active — so concurrent Runs on one repo were actively unsafe, and Rocky took
 * ownership of worktrees precisely so the lock could be its own cheap thing.
 * This is that cheap thing.
 *
 * Two properties are load-bearing:
 *
 * - **Keyed by repo, not global.** Concurrent Runs on one repo are allowed;
 *   only the operations touching the shared clone are serialized (fetch,
 *   `worktree add` / `remove`, the sweep). A grouped Run takes each member's
 *   key for its own clone operations, and one slow fetch on one repo must not
 *   stall another.
 * - **Held for one operation, never for a Run.** A Run parks for days; a lock
 *   held that long would be a deadlock with a nice name.
 *
 * In-process, because the daemon is the single writer of `~/.rocky/repos`
 * (NG-574 §4). `rocky repo add` clones from the terminal instead, which is why
 * the clone path is written to be idempotent rather than to rely on this.
 */

/** Idempotent: calling it twice must not hand the lock to two callers. */
export type Release = () => void;

interface Waiter {
  grant: (release: Release) => void;
}

export class KeyedMutex {
  /** A key is present exactly while it is held. */
  private readonly queues = new Map<string, Waiter[]>();

  /** Whether anything holds `key` right now. For diagnosing a hang. */
  isHeld(key: string): boolean {
    return this.queues.has(key);
  }

  /** How many callers are queued behind the holder. For the same reason. */
  waiting(key: string): number {
    return this.queues.get(key)?.length ?? 0;
  }

  /**
   * Take `key`, returning the release. Prefer `run` — this exists for a caller
   * that spans several git commands and must not let go between them.
   */
  acquire(key: string): Promise<Release> {
    const queue = this.queues.get(key);

    if (queue === undefined) {
      // Registering the empty queue *is* taking the lock, so there is no
      // window between the check and the claim. Single-threaded, but only
      // because nothing is awaited in between — hence no await above.
      this.queues.set(key, []);
      return Promise.resolve(this.releaser(key));
    }

    return new Promise<Release>((grant) => {
      queue.push({ grant });
    });
  }

  /**
   * Run `fn` holding `key`. Releases however `fn` ends: a fetch that fails
   * must not cost every later Run on that repo, and the symptom of a mutex
   * leaked on the error path is a hang rather than an error.
   */
  async run<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    const release = await this.acquire(key);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private releaser(key: string): Release {
    let spent = false;

    return () => {
      if (spent) {
        return;
      }
      spent = true;

      const queue = this.queues.get(key);
      const next = queue?.shift();

      if (next === undefined) {
        this.queues.delete(key);
        return;
      }

      next.grant(this.releaser(key));
    };
  }
}
