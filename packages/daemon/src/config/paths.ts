/**
 * Everything machine-local lives under one root (NG-578):
 *
 * ```
 * ~/.rocky/
 * ├── config.json          # repos, groups, bind/port, retention — no secrets
 * ├── credentials.json     # 0600 — Linear OAuth token(s), per-repo secrets
 * ├── daemon.pid
 * ├── logs/daemon.log
 * ├── repos/<repoName>/    # Rocky's own clone, nothing else inside
 * └── runs/<runId>/        # e.g. NG-601-1
 *     ├── journal.jsonl
 *     ├── run.json
 *     ├── snapshot/        # the lead repo's .rocky/ as of Run start
 *     ├── sessions/        # harness session records = Transcripts
 *     ├── screenshots/
 *     └── workspace/<repoName>/   # one git worktree per group member
 * ```
 *
 * NG-594 owns the paths only. The clones are NG-521's, the pidfile and the log
 * are NG-595's, and the journal, snapshot and sessions are NG-596's and
 * NG-598's.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The env var that moves the root, which is how a test gets a temp one. */
export const ROCKY_HOME_ENV = 'ROCKY_HOME';

export function defaultRockyHome(
  env: Record<string, string | undefined> = process.env,
): string {
  return env[ROCKY_HOME_ENV] ?? join(homedir(), '.rocky');
}

/**
 * Repo names and run ids become directory names, and repo names arrive from a
 * file a human is allowed to hand-edit. Anything that could resolve outside
 * the root is refused rather than normalised into something plausible.
 */
function assertSegment(kind: string, name: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') {
    throw new Error(
      `${JSON.stringify(name)} is not a valid ${kind} — letters, digits, dot, dash and underscore only`,
    );
  }
  return name;
}

/** Where one Run's files live. */
export interface RunPaths {
  dir: string;
  /** Append-only, and the Run's only durable truth (NG-574). */
  journal: string;
  /** The Run header — a pure cache of the journal (NG-574). */
  runJson: string;
  /** The lead repo's `.rocky/` as of Run start. */
  snapshotDir: string;
  /** Harness session records; the session record is the Transcript (NG-579). */
  sessionsDir: string;
  screenshotsDir: string;
  /** The parent handed to the agent: one child per repo, grouped or not. */
  workspaceDir: string;
  /** One member repo's worktree inside the workspace. */
  workspaceRepo(repoName: string): string;
}

export interface RockyPaths {
  root: string;
  configFile: string;
  credentialsFile: string;
  pidFile: string;
  logsDir: string;
  daemonLog: string;
  reposDir: string;
  /** Rocky's own clone of one repo. */
  repo(repoName: string): string;
  runsDir: string;
  run(runId: string): RunPaths;
}

export function rockyPaths(root: string = defaultRockyHome()): RockyPaths {
  const reposDir = join(root, 'repos');
  const runsDir = join(root, 'runs');
  const logsDir = join(root, 'logs');

  return {
    root,
    configFile: join(root, 'config.json'),
    credentialsFile: join(root, 'credentials.json'),
    pidFile: join(root, 'daemon.pid'),
    logsDir,
    daemonLog: join(logsDir, 'daemon.log'),
    reposDir,
    repo: (repoName) => join(reposDir, assertSegment('repo name', repoName)),
    runsDir,
    run(runId) {
      const dir = join(runsDir, assertSegment('run id', runId));
      const workspaceDir = join(dir, 'workspace');

      return {
        dir,
        journal: join(dir, 'journal.jsonl'),
        runJson: join(dir, 'run.json'),
        snapshotDir: join(dir, 'snapshot'),
        sessionsDir: join(dir, 'sessions'),
        screenshotsDir: join(dir, 'screenshots'),
        workspaceDir,
        workspaceRepo: (repoName) =>
          join(workspaceDir, assertSegment('repo name', repoName)),
      };
    },
  };
}
