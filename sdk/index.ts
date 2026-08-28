/**
 * PROTOTYPE (NG-572) — the `@rocky/sdk` surface.
 *
 * This is everything a consumer repo needs installed (as a devDependency) for
 * its `.rocky/workflow.ts` and `.rocky/config.ts` to typecheck with no Rocky
 * daemon present. The daemon brings the runtime; this package is types plus
 * two identity functions plus a re-exported `z`.
 */
import { z } from "zod";

// One schema library for everyone: the SDK re-exports zod so a consumer repo
// declares exactly one Rocky-related dependency.
export { z };

// ── Data the workflow can see ───────────────────────────────────────────────

/** The Linear issue this Run was delegated for, snapshotted at Run start. */
export interface Issue {
  identifier: string; // "NG-123"
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

export interface CiResult {
  status: "passed" | "failed";
  /** Structured metadata first; logs only for known-failed jobs, tailed. */
  failedJobs: { name: string; excerpt: string }[];
}

export type CheckpointAnswer =
  | { decision: "approve" }
  | { decision: "reject"; reason?: string }
  | { decision: "steer"; message: string };

export type RunOutcome = "merged" | "rejected" | "exhausted";

// ── SCM operations (the adapter seam lives behind this, NG-580) ────────────

export interface ScmOps {
  openPr(opts: { title: string; body: string; draft?: boolean }): Promise<Pr>;
  markDraft(pr: Pr): Promise<void>;
  /**
   * Parks the Run until the head pipeline finishes. Polling cadence, token
   * limits and platform quirks are the adapter's business, not the workflow's.
   */
  waitForCi(pr: Pr): Promise<CiResult>;
  /** GitHub update-branch / GitLab rebase, through the platform. */
  updateBranch(pr: Pr): Promise<"updated" | "clean" | "conflict">;
  /**
   * Arm the platform's own auto-merge (queue/train aware). Never merges
   * locally. The GitLab adapter re-arms after every push, since a fix push
   * cancels auto-merge there (NG-569).
   */
  armAutoMerge(pr: Pr): Promise<void>;
}

// ── The ctx surface ─────────────────────────────────────────────────────────

export interface AgentCallOpts<S extends z.ZodType> {
  /** JSON-serialisable context handed to the Agent verbatim. */
  input?: unknown;
  /**
   * The Agent's output contract, at the call site. The runner turns it into
   * JSON Schema for the prompt, validates the reply against it, and retries a
   * non-conforming reply as a Step-level failure. The markdown file in
   * `.rocky/agents/` stays prose: prompt, model, tool policy.
   */
  schema: S;
  /** Display-only Step name for the journal and web UI, e.g. "review 3/5". */
  label?: string;
}

/**
 * Every method on this interface is a journaled Step. Everything else in a
 * Workflow is plain TypeScript that re-executes on resume — which is safe
 * exactly because all effects and all nondeterminism are behind `ctx`.
 *
 * Author rules (enforced by lint, NG-574 owns the details):
 *   - no I/O outside ctx (no fs, no fetch, no child_process)
 *   - no Date.now() / Math.random() in workflow code
 */
export interface WorkflowContext {
  readonly issue: Issue;
  /** Linear's own gitBranchName; the Run's worktree is checked out on it. */
  readonly branch: string;

  /** Run a named Agent from `.rocky/agents/<name>.md`. One journaled Step. */
  agent<S extends z.ZodType>(
    name: string,
    opts: AgentCallOpts<S>,
  ): Promise<z.infer<S>>;

  /** Run a shell command in the Run's worktree. One journaled Step. */
  exec(cmd: string, opts?: { label?: string }): Promise<ExecResult>;

  /**
   * Park the Run for a human. Notifies Linear (elicitation + link into the
   * web UI) and blocks until answered. Blocking is enforced here, in the Run
   * loop — Linear's gate is advisory (NG-567).
   */
  checkpoint(opts: { title: string; body: string }): Promise<CheckpointAnswer>;

  /** Post markdown into the Run's Linear thread. One journaled Step. */
  post(markdown: string): Promise<void>;

  /** Changed files of this Run's branch against its base. Journaled. */
  changedFiles(): Promise<string[]>;

  scm: ScmOps;
}

// ── Config (`.rocky/config.ts` is data; the pipeline stays code) ───────────

export interface RepoConfig {
  caps: {
    /** Review-style loops (compliance, UI, code review). Default 5. */
    review: number;
    /** CI fix attempts. Default 3. */
    ci: number;
  };
  /**
   * Declared, not discovered (NG-577). Absent = repo has no UI stage.
   * `{port}` is replaced with the port allocated to this Run.
   */
  ui?: {
    start: string; // e.g. "pnpm dev --port {port}"
    url: string; //   e.g. "http://localhost:{port}"
  };
  /** Harness/model defaults; per-Agent overrides live in the Agent's md. */
  agents?: {
    harness?: "claude-code" | "opencode" | (string & {});
    model?: string;
  };
}

export type Workflow = (ctx: WorkflowContext) => Promise<RunOutcome>;

/** Identity with types: makes `.rocky/workflow.ts` export checkable. */
export function defineWorkflow(fn: Workflow): Workflow {
  return fn;
}

/** Identity with types: makes `.rocky/config.ts` export checkable. */
export function defineConfig(config: RepoConfig): RepoConfig {
  return config;
}
