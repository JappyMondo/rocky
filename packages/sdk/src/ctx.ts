/**
 * The `ctx` surface a Workflow is handed, and the data types that flow through
 * it. Types only — the daemon brings every implementation.
 *
 * Settled by NG-572 (and its 2026-08-28 amendment), NG-578 and NG-580. Members
 * whose signature no resolution has pinned yet are deliberately absent rather
 * than guessed; the tickets that own them add them.
 */
import type { z } from 'zod';

// ── Data a Workflow can see ────────────────────────────────────────────────

/** The Linear issue this Run was delegated for, snapshotted at Run start. */
export interface Issue {
  identifier: string;
  title: string;
  description: string;
  url: string;
  labels: string[];
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface Pr {
  number: number;
  url: string;
  headSha: string;
}

/** One failed CI job, with a lazily-fetched log tail (NG-580). */
export interface FailedJob {
  name: string;
  failedSteps: string[];
  logTail: string;
}

export interface CiResult {
  status: 'passed' | 'failed';
  failedJobs: FailedJob[];
}

/** A human review thread on a PR, pre-anchored to a file and line (NG-580). */
export interface ReviewThread {
  id: string;
  path: string;
  line?: number;
  body: string;
}

/**
 * Why a refusable SCM operation refused. Normalised on GitLab's
 * `detailed_merge_status` shape; GitHub's opaque `BLOCKED` maps into it
 * (NG-580).
 */
export type ScmRefusal = {
  refused: true;
  reason: string;
};

export type CheckpointAnswer =
  | { decision: 'approve' }
  | { decision: 'reject'; reason?: string }
  | { decision: 'steer'; message: string };

export type RunOutcome = 'merged' | 'rejected' | 'exhausted';

// ── The SCM seam (NG-580 — eight ops) ──────────────────────────────────────

export interface ScmOps {
  /** Find-or-create, keyed on the branch name: a Step is at-least-once. */
  openPr(opts: { title: string; body: string; draft?: boolean }): Promise<Pr>;
  /** GitLab has no draft boolean — the adapter shims the title prefix. */
  markDraft(pr: Pr, draft: boolean): Promise<void>;
  /** Parks the Run until the head pipeline finishes. */
  waitForCi(pr: Pr): Promise<CiResult>;
  /** The ci-fixer's alternative to a code fix when it judges a job flaky. */
  retryFailedJobs(pr: Pr): Promise<void>;
  /** GitHub update-branch / GitLab rebase, through the platform. */
  updateBranch(pr: Pr): Promise<'updated' | 'clean' | 'conflict' | ScmRefusal>;
  /**
   * Idempotent "ensure auto-merge is armed for head SHA X". A no-op on GitHub,
   * and exactly the re-arm GitLab needs after every fix push.
   */
  armAutoMerge(pr: Pr): Promise<void | ScmRefusal>;
  reviewThreads(pr: Pr): Promise<ReviewThread[]>;
  /** Exactly one reply per thread; resolved where the platform supports it. */
  replyToThread(threadId: string, body: string): Promise<void>;
}

// ── The Linear seam (NG-578) ───────────────────────────────────────────────

export interface LinearOps {
  /**
   * Move the issue to a workflow state by name, matched case-insensitively
   * against the issue's team. An unknown name fails the Step with an error
   * listing the team's actual state names — no fuzzy matching, no silent skip.
   */
  setState(name: string): Promise<void>;
}

// ── ctx ────────────────────────────────────────────────────────────────────

export interface AgentCallOpts<S extends z.ZodType = z.ZodType> {
  /** JSON-serialisable context handed to the Agent verbatim. */
  input?: unknown;
  /**
   * The Agent's output contract, at the call site. The runner appends
   * `summary` to every schema, which is what makes this optional.
   */
  schema?: S;
  /** Display-only Step name for the journal and web UI, e.g. "review 3/5". */
  label?: string;
  harness?: string;
  model?: string;
  /** The portable tool grants: `read`, `edit`, `bash`. */
  capabilities?: ('read' | 'edit' | 'bash')[];
  /** Names of servers declared in `.rocky/mcp.json`. */
  mcp?: string[];
}

/**
 * Every method here is a journaled Step. Code *between* Steps is unrestricted
 * and simply re-executes on every Boot — which is safe because a completed
 * Step hands back its recorded result without touching the world.
 *
 * Arbitrary code that must not re-execute goes through `ctx.step`.
 */
export interface WorkflowContext {
  readonly issue: Issue;
  /** Linear's own `gitBranchName`; the Run's worktree is checked out on it. */
  readonly branch: string;

  /**
   * Run an Agent — either a named prompt from `.rocky/agents/<name>.md`, or an
   * inline one. The markdown carries no frontmatter: everything else is here.
   */
  agent<S extends z.ZodType>(
    agent: string | { prompt: string },
    opts: AgentCallOpts<S> & { schema: S },
  ): Promise<z.infer<S>>;
  agent(
    agent: string | { prompt: string },
    opts?: AgentCallOpts,
  ): Promise<{ summary: string }>;

  /** Run a shell command in the Run's workspace. One journaled Step. */
  exec(cmd: string, opts?: { label?: string }): Promise<ExecResult>;

  /**
   * Journal arbitrary code: the callback runs once, its JSON-serialisable
   * return is recorded, and replay hands the recorded value back. Never parks.
   */
  step<T>(label: string, fn: () => T | Promise<T>): Promise<T>;

  /**
   * Park the Run for a human. Tells Linear intervention is needed, links into
   * the web UI, and blocks until it has an Answer. Rocky enforces the
   * blocking; Linear's own gate is advisory.
   */
  checkpoint(opts: { title: string; body: string }): Promise<CheckpointAnswer>;

  /** Post markdown into the Run's Linear thread. One journaled Step. */
  post(markdown: string): Promise<void>;

  /** Changed files of this Run's branch against its base. Journaled. */
  changedFiles(): Promise<string[]>;

  readonly scm: ScmOps;
  readonly linear: LinearOps;
}

export type Workflow = (ctx: WorkflowContext) => Promise<RunOutcome>;
