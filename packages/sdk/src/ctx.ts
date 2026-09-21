/**
 * The `ctx` surface a Workflow is handed, and the data types that flow through
 * it. Types only — the daemon brings every implementation.
 *
 * Settled by NG-572 (and its 2026-08-28 amendment), NG-578 and NG-580. Members
 * whose signature no resolution has pinned yet are deliberately absent rather
 * than guessed; the tickets that own them add them.
 */
import type { z } from 'zod';
import type { ApprovedCheckpoint, ScmOps, ScmPr } from './scm.js';
export type {
  ApprovedCheckpoint,
  CiResult,
  FailedJob,
  Pr,
  ReviewThread,
  ScmOps,
  ScmRefusal,
} from './scm.js';

// ── Data a Workflow can see ────────────────────────────────────────────────

/** The Linear issue this Run was delegated for, snapshotted at Run start. */
/** A comment captured at admission, including replies from earlier sessions. */
export interface IssueComment {
  id: string;
  body: string;
  createdAt: string;
  userId: string | null;
  sessionId: string | null;
  parentId: string | null;
}

export interface Issue {
  identifier: string;
  title: string;
  description: string;
  url: string;
  labels: string[];
  /** Old run snapshots may predate comment hydration. Ordered oldest first. */
  comments?: IssueComment[];
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface BackgroundExecResult {
  pid: number;
}

export interface ParallelOptions {
  label?: string;
}

export type CheckpointAnswer =
  | ApprovedCheckpoint
  | { decision: 'reject'; reason?: string }
  | { decision: 'steer'; message: string };

export interface Question {
  title: string;
  body: string;
  options?: string[];
}
export type QuestionAnswer = { answer: string } | { cancelled: true };

export type RunOutcome = 'merged' | 'rejected' | 'exhausted' | 'completed';

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
  /** Passed verbatim to the Harness. */
  model?: string;
  effort?: string;
  /** Agent call timeout in milliseconds. */
  timeout?: number;
  /** The portable tool grants: `read`, `edit`, `bash`. */
  tools?: ('read' | 'edit' | 'bash')[];
  /** Names of servers declared in `.rocky/mcp.json`. */
  mcp?: string[];
}

export type RecapAgentRole = 'inventory' | 'narrative' | 'capture' | 'audit';
export interface ConfiguredAgent {
  prompt: string | { prompt: string };
  options: AgentCallOpts;
}

/** Generate, host and publish a visual recap of a PR or another deliverable. */
export interface VisualRecapOptions {
  pr?: ScmPr;
  diff?: string;
  deliverable?: string;
  title?: string;
  scope?: unknown;
  agent?: AgentCallOpts;
  /** Explicit agents for each recap task. Omit for legacy SDK workflows. */
  /** Resolve an agent against the current recap subtask input. */
  agents?: Record<RecapAgentRole, (input: unknown) => ConfiguredAgent>;
}

export interface VisualRecapResult {
  id: string;
  url: string;
}

/**
 * Every method except stage is a journaled Step. Code *between* Steps is unrestricted
 * and simply re-executes on every Boot — which is safe because a completed
 * Step normally hands back its recorded result without touching the world.
 * Background exec is the exception: it restarts on working Boots, not polls.
 *
 * Arbitrary code that must not re-execute goes through `ctx.step`.
 */
/** Literal metadata exported as `models` by a workflow module. */
export type WorkflowModelSlots = Readonly<
  Record<
    string,
    {
      name: string;
      description?: string;
    }
  >
>;

/** Selected in the profile UI; immutable for the lifetime of a run. */
export interface AgentModelSelection {
  readonly harness: 'opencode' | 'claude-code';
  readonly model: string;
  readonly effort: string;
}

export interface WorkflowContext {
  /** Spread a named selection into agent options: `...ctx.models.review`. */
  readonly models: Readonly<Record<string, AgentModelSelection>>;
  readonly issue: Issue;
  /** Linear's own `gitBranchName`; the Run's worktree is checked out on it. */
  readonly branch: string;
  /** Ports reserved for this Boot. The array itself remains mutable to callers. */
  readonly ports: number[];
  /** True while the next context operation will replay a previously recorded Step. */
  readonly replaying: boolean;

  /** Display-only: takes no seq, stamps later entries, and re-executes on replay. */
  stage(label: string): void;

  /**
   * Run an Agent — either a named prompt from `.rocky/agents/<name>.md`, or an
   * inline one. The markdown carries no frontmatter: everything else is here.
   */
  agent<S extends z.ZodType>(
    agent: string,
    opts: AgentCallOpts<S> & { schema: S },
  ): Promise<z.infer<S> & { summary: string }>;
  agent<S extends z.ZodType>(
    agent: { prompt: string },
    opts: AgentCallOpts<S> & { schema: S; label: string },
  ): Promise<z.infer<S> & { summary: string }>;
  agent(agent: string, opts?: AgentCallOpts): Promise<{ summary: string }>;
  agent(
    agent: { prompt: string },
    opts: AgentCallOpts & { label: string },
  ): Promise<{ summary: string }>;

  /** Start a shell command in the background. One journaled Step. */
  exec(
    cmd: string,
    opts: { background: true; label?: string },
  ): Promise<BackgroundExecResult>;
  /** Run a shell command in the Run's workspace. One journaled Step. */
  exec(
    cmd: string,
    opts?: { label?: string; timeoutMs?: number },
  ): Promise<ExecResult>;

  /**
   * Journal arbitrary code: the callback runs once, its JSON-serialisable
   * return is recorded, and replay hands the recorded value back. Never parks.
   */
  step<T>(label: string, fn: () => T | Promise<T>): Promise<T>;

  /** Journal one parent Step while running each item in its own branch. */
  parallel<T, R>(
    items: readonly T[],
    fn: (item: T, index: number) => Promise<R>,
    opts?: ParallelOptions,
  ): Promise<R[]>;

  /**
   * Park the Run for a human. Tells Linear intervention is needed, links into
   * the web UI, and blocks until it has an Answer. Rocky enforces the
   * blocking; Linear's own gate is advisory.
   */
  checkpoint(opts: { title: string; body: string }): Promise<CheckpointAnswer>;

  /** Ask for clarification and park durably until the human replies. */
  question(opts: Question): Promise<QuestionAnswer>;

  /** Post an explicit, durable comment on the Linear issue. */
  comment(markdown: string): Promise<void>;

  /** Post markdown into the Run's Linear thread. One journaled Step. */
  post(markdown: string): Promise<void>;

  /** Changed files of this Run's branch against its base. Journaled. */
  changedFiles(): Promise<string[]>;

  /** Runs evidence capture and synthesis, then links the report in Linear and the supplied PR/MR.
   * Requires a PR, nonempty diff, or nonempty deliverable. Restart-safe.
   */
  visualRecap(options: VisualRecapOptions): Promise<VisualRecapResult>;

  readonly scm: ScmOps;
  readonly linear: LinearOps;
}

export interface WorkflowInput {
  members: readonly {
    name: string;
    path: string;
    lead: boolean;
    baseBranch?: string;
  }[];
}

export type Workflow = (
  ctx: WorkflowContext,
  input: WorkflowInput,
) => Promise<RunOutcome>;
