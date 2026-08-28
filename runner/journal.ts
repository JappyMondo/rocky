/**
 * PROTOTYPE (NG-572) — a ~100-line deterministic-replay runner.
 *
 * The model under test: the journal is an ordered list of Step results. On
 * every boot the workflow function runs from the top; each ctx.* call checks
 * the journal at its sequence position — a completed entry returns its
 * recorded result without touching the world, anything else executes for
 * real and is recorded. Plain TypeScript between Steps simply re-executes,
 * which is safe because all effects and nondeterminism live behind ctx.
 *
 * A Step that cannot complete yet (CI still running, Checkpoint unanswered)
 * is recorded as `waiting` and parks the Run: the process can exit, the
 * journal persists, and the next boot retries exactly that Step.
 */
import {
  type CheckpointAnswer,
  type CiResult,
  type ExecResult,
  type Issue,
  type Pr,
  type RunOutcome,
  type Workflow,
  type WorkflowContext,
} from "@rocky/sdk";

export const PENDING = Symbol("pending");
export type Pending = typeof PENDING;

export interface JournalEntry {
  seq: number;
  step: string; // e.g. "agent:reviewer", "exec:git push", "checkpoint"
  label?: string;
  status: "done" | "waiting";
  result?: unknown;
}

export class Parked extends Error {
  constructor(public entry: JournalEntry) {
    super(`parked at #${entry.seq} ${entry.label ?? entry.step}`);
  }
}

/** Everything the runner does to the outside world, fakeable for the demo. */
export interface World {
  agent(name: string, input: unknown): unknown;
  exec(cmd: string): ExecResult;
  post(markdown: string): void;
  changedFiles(): string[];
  openPr(opts: { title: string; body: string; draft?: boolean }): Pr;
  markDraft(pr: Pr): void;
  waitForCi(pr: Pr): CiResult | Pending;
  updateBranch(pr: Pr): "updated" | "clean" | "conflict";
  armAutoMerge(pr: Pr): void;
  checkpoint(opts: { title: string; body: string }): CheckpointAnswer | Pending;
}

export interface BootReport {
  outcome?: RunOutcome;
  parkedAt?: JournalEntry;
  replayed: number;
  executed: number;
}

/** One daemon boot: replay the journal, run live from where it ends. */
export async function boot(
  workflow: Workflow,
  world: World,
  issue: Issue,
  journal: JournalEntry[],
): Promise<BootReport> {
  let seq = 0;
  const counters = { replayed: 0, executed: 0 };

  function step<T>(key: string, perform: () => T | Pending, label?: string): T {
    const i = seq++;
    const existing = journal[i];
    if (existing && existing.step !== key) {
      throw new Error(
        `non-deterministic workflow: journal #${i} recorded "${existing.step}" but replay asked for "${key}"`,
      );
    }
    if (existing?.status === "done") {
      counters.replayed++;
      return existing.result as T;
    }
    const result = perform(); // waiting entries retry their effect here
    if (result === PENDING) {
      journal[i] = { seq: i, step: key, label, status: "waiting" };
      throw new Parked(journal[i]);
    }
    counters.executed++;
    journal[i] = { seq: i, step: key, label, status: "done", result };
    return result;
  }

  const ctx: WorkflowContext = {
    issue,
    branch: `${issue.identifier.toLowerCase()}-branch`,
    agent: async (name, opts) =>
      step(
        `agent:${name}`,
        () => opts.schema.parse(world.agent(name, opts.input)),
        opts.label,
      ),
    exec: async (cmd, opts) => step(`exec:${cmd}`, () => world.exec(cmd), opts?.label),
    post: async (md) => step("post", () => world.post(md)),
    changedFiles: async () => step("changedFiles", () => world.changedFiles()),
    checkpoint: async (opts) => step("checkpoint", () => world.checkpoint(opts), opts.title),
    scm: {
      openPr: async (opts) => step("scm:openPr", () => world.openPr(opts)),
      markDraft: async (pr) => step("scm:markDraft", () => world.markDraft(pr)),
      waitForCi: async (pr) => step("scm:waitForCi", () => world.waitForCi(pr)),
      updateBranch: async (pr) => step("scm:updateBranch", () => world.updateBranch(pr)),
      armAutoMerge: async (pr) => step("scm:armAutoMerge", () => world.armAutoMerge(pr)),
    },
  };

  try {
    const outcome = await workflow(ctx);
    return { outcome, ...counters };
  } catch (e) {
    if (e instanceof Parked) return { parkedAt: e.entry, ...counters };
    throw e;
  }
}
