/**
 * What every repo operation needs to know (NG-521).
 *
 * Three things, and no seam: the layout under `~/.rocky`, the per-repo mutex,
 * and who Rocky commits as. Git itself is not injected — see `git.ts` for why.
 */
import type { RockyPaths } from '../config/paths.js';
import type { RockyIdentity } from '../config/schema.js';
import type { KeyedMutex } from './mutex.js';

export interface RepoContext {
  paths: RockyPaths;
  /**
   * Shared across every operation on this instance. One mutex object is what
   * makes two concurrent Runs on one repo serialize against each other rather
   * than each against a private lock.
   */
  mutex: KeyedMutex;
  /**
   * Written into each worktree at creation, so commit authorship is
   * structural rather than prompt-trusted (NG-580).
   */
  identity: RockyIdentity;
  /** Where a note worth a human's attention goes. The daemon log, in production. */
  log?(message: string): void;
}

/** The part of a repo entry the filesystem side needs. */
export interface RepoRef {
  name: string;
  url: string;
  baseBranch: string;
}

/**
 * All a clone needs. `baseBranch` is a fact about branching, not about
 * cloning, and `rocky repo add` discovers it *from* the clone — so requiring
 * it here would force the caller to invent one before it could know it.
 */
export type CloneRef = Pick<RepoRef, 'name' | 'url'>;
