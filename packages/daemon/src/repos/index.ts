/**
 * The filesystem side of a Run (NG-521): Rocky's own clones, a worktree per
 * Run and member repo, the per-repo mutex and the sweep.
 *
 * Nothing in here touches the developer's working copies, ever.
 */
import { rockyPaths, type RockyPaths } from '../config/paths.js';
import type { RockyIdentity } from '../config/schema.js';
import { KeyedMutex } from './mutex.js';
import type { RepoContext } from './context.js';

export {
  DEFAULT_GIT_TIMEOUT_MS,
  GitError,
  git,
  gitOk,
  type GitOptions,
  type GitResult,
} from './git.js';

export { KeyedMutex, type Release } from './mutex.js';

export type { CloneRef, RepoContext, RepoRef } from './context.js';

export {
  CloneError,
  cloneStatus,
  ensureClone,
  isCloned,
  type CloneOutcome,
  type CloneStatus,
} from './clone.js';

export {
  WorkspaceError,
  createWorkspace,
  removeWorkspace,
  type Adoption,
  type CreateWorkspaceOptions,
  type Workspace,
  type WorkspaceMember,
} from './workspace.js';

export {
  adoptRemoteMoves,
  failsTheRun,
  type AdoptOptions,
  type AdoptOutcome,
} from './adopt.js';

export { sweep, type SweepOptions, type SweepReport } from './sweep.js';

export {
  followConfigReloads,
  reconcileClones,
  type FollowOptions,
  type Follower,
  type ReconcileReport,
  type ReloadSource,
} from './reconcile.js';

/**
 * One context per Rocky instance. The mutex is created here rather than
 * passed in because sharing exactly one is the whole guarantee: two contexts
 * over the same `~/.rocky` would each hold a private lock and serialize
 * nothing.
 */
export function createRepoContext(options: {
  identity: RockyIdentity;
  paths?: RockyPaths;
  log?(message: string): void;
}): RepoContext {
  return {
    paths: options.paths ?? rockyPaths(),
    mutex: new KeyedMutex(),
    identity: options.identity,
    log: options.log,
  };
}
