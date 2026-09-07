# The ctx Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide the journal-backed `WorkflowContext` members required by NG-597, including deterministic parallel calls, command execution, ports, and stage propagation.

**Architecture:** Keep `replay.ts` responsible for journal sequencing and add a daemon context factory that adapts its raw Step primitive to `@rocky/sdk` types. A small Run-lifecycle wrapper reserves ports before a Boot and owns background process-group cleanup at terminal outcomes. External operations remain injected and are not implemented here.

**Tech Stack:** TypeScript, Node.js `child_process`, Zod, Vitest, Nx, pnpm.

---

## File Structure

- Modify: `packages/sdk/src/ctx.ts` — publish the completed context type surface without runtime behavior.
- Modify: `packages/sdk/src/index.ts` — re-export new context-only types.
- Create: `packages/sdk/src/ctx.spec.ts` — compile-time usage fixtures for workflow authors.
- Modify: `packages/daemon/src/run/journal.ts` — validate the parent-held parallel sub-journal shape.
- Modify: `packages/daemon/src/run/replay.ts` — expose the raw Step adapter and maintain stage and JSON guarantees for nested work.
- Modify: `packages/daemon/src/run/replay.spec.ts` — prove serial Step semantics still hold and cover the parallel sub-journal engine.
- Modify: `packages/daemon/src/run/header.ts` — persist per-Boot port reservations.
- Modify: `packages/daemon/src/run/header.spec.ts` — prove header port validation and renewal updates.
- Create: `packages/daemon/src/run/context.ts` — translate the SDK surface into raw journal Steps with injected external services.
- Create: `packages/daemon/src/run/context.spec.ts` — cover `step`, `exec`, `changedFiles`, `parallel`, and `stage` through the public context.
- Create: `packages/daemon/src/run/lifecycle.ts` — reserve ports, run a Workflow Boot, and clean terminal background process groups.
- Create: `packages/daemon/src/run/lifecycle.spec.ts` — cover port renewal and terminal process-group cleanup, including a grandchild.

### Task 1: Publish the SDK Context Contract

**Files:**
- Modify: `packages/sdk/src/ctx.ts:22-176`
- Modify: `packages/sdk/src/index.ts:23-38`
- Create: `packages/sdk/src/ctx.spec.ts`

- [ ] **Step 1: Write a failing SDK type fixture for the new members.**

```ts
import { describe, expect, it } from 'vitest';
import type { WorkflowContext } from './ctx.js';

describe('WorkflowContext', () => {
  it('permits the authoring surface without introducing runtime exports', () => {
    const useContext = async (ctx: WorkflowContext) => {
      const ports: number[] = ctx.ports;
      ctx.stage('Code review');
      const value = await ctx.step('derive title', () => ({ ports }));
      const results = await ctx.parallel([1, 2], async (item) =>
        ctx.exec(`printf ${item}`),
      );
      const background = await ctx.exec('pnpm dev', { background: true });
      return { value, results, background };
    };

    expect(useContext).toBeTypeOf('function');
  });
});
```

- [ ] **Step 2: Run the SDK test to verify type checking fails.**

Run: `pnpm nx test sdk --testFile=packages/sdk/src/ctx.spec.ts`

Expected: compilation failure because `ports`, `stage`, and `parallel` do not exist and `background` is not accepted.

- [ ] **Step 3: Add only the missing SDK types and signatures.**

```ts
export interface BackgroundExecResult {
  pid: number;
}

export interface ParallelOptions {
  label?: string;
}

export interface WorkflowContext {
  readonly issue: Issue;
  readonly branch: string;
  readonly ports: number[];
  stage(label: string): void;
  exec(cmd: string, opts?: { label?: string }): Promise<ExecResult>;
  exec(
    cmd: string,
    opts: { background: true; label?: string },
  ): Promise<BackgroundExecResult>;
  step<T>(label: string, fn: () => T | Promise<T>): Promise<T>;
  parallel<T, R>(
    items: readonly T[],
    fn: (item: T, index: number) => Promise<R>,
    opts?: ParallelOptions,
  ): Promise<R[]>;
}
```

Keep existing future-ticket members (`agent`, `checkpoint`, `post`, `scm`, and `linear`) unchanged. Export `BackgroundExecResult` and `ParallelOptions` as types from `index.ts`; do not add a runtime export.

- [ ] **Step 4: Run the focused SDK tests and purity guard.**

Run: `pnpm nx test sdk --testFile=packages/sdk/src/ctx.spec.ts --testFile=packages/sdk/src/purity.spec.ts`

Expected: PASS; the runtime export and dependency lists remain unchanged.

- [ ] **Step 5: Commit the SDK contract.**

```bash
git add packages/sdk/src/ctx.ts packages/sdk/src/index.ts packages/sdk/src/ctx.spec.ts
git commit -m "feat(sdk): add ctx execution surface"
```

### Task 2: Add a Deterministic Parallel Sub-Journal Primitive

**Files:**
- Modify: `packages/daemon/src/run/journal.ts:97-120`
- Modify: `packages/daemon/src/run/replay.ts:62-93,192-317`
- Modify: `packages/daemon/src/run/replay.spec.ts`

- [ ] **Step 1: Write failing replay tests for branch-local sequences and count divergence.**

```ts
it('replays parallel branches by index despite reverse settlement order', async () => {
  const calls: string[] = [];
  const workflow = async (ctx: BootContext) => {
    await ctx.parallel([10, 20], async (branch) => {
      await ctx.step('first', {}, async () => {
        calls.push(`first:${branch.index}`);
        return { status: 'done', result: branch.item };
      });
      await ctx.step('second', {}, async () => ({ status: 'done', result: 'ok' }));
    });
    await ctx.step('checkpoint', {}, async () => ({ status: 'waiting' }));
    return 'merged';
  };

  await boot(workflow);
  calls.length = 0;
  await boot(workflow);
  expect(calls).toEqual([]);
});

it('fails when a replayed parallel item count changes', async () => {
  await boot(parkingParallelWith([1, 2]));
  const result = await boot(parkingParallelWith([1, 2, 3]));
  expect(result.status === 'failed' && result.error.name).toBe('DivergenceError');
});
```

- [ ] **Step 2: Run the focused replay tests to verify they fail.**

Run: `pnpm nx test daemon --testFile=packages/daemon/src/run/replay.spec.ts`

Expected: TypeScript failure because `BootContext.parallel` does not exist.

- [ ] **Step 3: Define the recursive journal shape and validate it.**

```ts
export interface ParallelJournal {
  count: number;
  branches: JournalEntry[][];
}

const entrySchema = z.object({
  v: z.number().int(),
  seq: z.number().int().min(0),
  step: z.string().min(1),
  label: z.string().optional(),
  status: z.enum(['running', 'done', 'waiting', 'failed']),
  result: z.unknown().optional(),
  stage: z.string().optional(),
  boot: z.number().int().min(1),
  startedAt: z.string(),
  ms: z.number().optional(),
  sessionId: z.string().optional(),
  attempts: z.array(attemptSchema).optional(),
  error: recordedErrorSchema.optional(),
  parallel: z
    .object({
      count: z.number().int().min(0),
      branches: z.array(z.array(z.lazy(() => entrySchema))),
    })
    .optional(),
});
```

Require `branches.length === count` with a Zod refinement. A top-level `parallel` Step owns one normal sequence; its branch entries are nested values, not new JSONL lines. Preserve the `running` and settled parent writes so a kill remains at-least-once.

- [ ] **Step 4: Implement `BootContext.parallel` with independent branch runners.**

```ts
parallel<T>(
  key: string,
  items: readonly T[],
  options: StepOptions,
  run: (branch: BootContext, item: T, index: number) => Promise<unknown>,
): Promise<unknown[]>;
```

Allocate the parent sequence with the normal `step` path. On its live path, create one branch runner per index, each with sequence zero and only that index's previous sub-journal. Execute branches with `Promise.all`; record results in input order, not settlement order. Replay each settled branch entry before executing its unfinished suffix. Compare the recorded `count` before opening any branch and fail with `DivergenceError` when it differs. Give nested `parallel` calls the same recursive mechanism.

- [ ] **Step 5: Add regression tests for nested parallel work and serial behavior.**

```ts
it('keeps nested branch sequences independent', async () => {
  // Each outer index owns an inner parent; each inner index starts at sub-seq 0.
});

it('continues to stamp serial Steps after a parallel parent at the next seq', async () => {
  // Parent consumes one top-level seq; the following exec is top-level seq + 1.
});
```

- [ ] **Step 6: Run replay and journal tests.**

Run: `pnpm nx test daemon --testFile=packages/daemon/src/run/replay.spec.ts --testFile=packages/daemon/src/run/journal.spec.ts`

Expected: PASS, including deterministic replay, nesting, and changed-count divergence.

- [ ] **Step 7: Commit the parallel primitive.**

```bash
git add packages/daemon/src/run/journal.ts packages/daemon/src/run/replay.ts packages/daemon/src/run/replay.spec.ts
git commit -m "feat(daemon): journal deterministic parallel steps"
```

### Task 3: Build the Context Factory and Command Adapter

**Files:**
- Create: `packages/daemon/src/run/context.ts`
- Create: `packages/daemon/src/run/context.spec.ts`

- [ ] **Step 1: Write failing public-context tests for `step`, `stage`, and changed files.**

```ts
it('fails a non-serialisable ctx.step result on its executing Boot', async () => {
  const result = await bootWorkflow(async (ctx) => {
    await ctx.step('bad return', () => BigInt(1));
    return 'merged';
  });
  expect(result.status === 'failed' && result.error.message).toMatch(/serial/);
});

it('replays an ordinary ctx.step result without invoking its callback', async () => {
  let calls = 0;
  // Park after step, boot again, and assert calls remains one.
});

it('stamps entries after ctx.stage without consuming a sequence', async () => {
  // Assert stage and top-level seqs 0, 1, then $end at 2.
});
```

- [ ] **Step 2: Run the focused context tests to verify they fail.**

Run: `pnpm nx test daemon --testFile=packages/daemon/src/run/context.spec.ts`

Expected: FAIL because the context factory and its test helper do not exist.

- [ ] **Step 3: Implement the injected service boundary and factory.**

```ts
export interface ContextServices {
  changedFiles(): Promise<string[]>;
  exec(command: string, opts: { background: boolean }): Promise<
    ExecResult | BackgroundExecResult
  >;
  trackProcessGroup(pid: number): void;
  external: Pick<WorkflowContext, 'agent' | 'checkpoint' | 'post' | 'scm' | 'linear'>;
}

export function createWorkflowContext(
  runner: BootContext,
  header: Pick<RunHeader, 'issue' | 'branch' | 'ports'>,
  services: ContextServices,
): WorkflowContext;
```

Use stable journal keys: `step`, `exec`, `changedFiles`, and `parallel`. `ctx.step(label, fn)` uses `label` as display metadata rather than a replay key, so changing display copy does not diverge. Call `runner.stage(label)` directly. Route foreground `exec` and `changedFiles` through `runner.step`; route background `exec` through a replay-aware effect that re-spawns when its parent entry is replayed and records the new PID for cleanup. Never use `Promise.all` outside the runner-owned `parallel` implementation.

- [ ] **Step 4: Add failing command behavior tests.**

```ts
it('captures a foreground command exit result', async () => {
  const result = await runContextExec('printf rocky');
  expect(result).toEqual({ exitCode: 0, stdout: 'rocky', stderr: '' });
});

it('re-spawns a completed background command on a subsequent Boot', async () => {
  // Park after background exec; on Boot two assert a distinct live PID.
});
```

- [ ] **Step 5: Implement the Node command runner with one default timeout.**

```ts
const DEFAULT_EXEC_TIMEOUT_MS = 10 * 60 * 1000;

const child = spawn(command, {
  cwd: workspace,
  shell: true,
  detached: background,
  stdio: background ? 'ignore' : 'pipe',
});
```

For a background command, call `child.unref()` and return `{ pid }` only after asserting `pid` is defined. For a foreground command, collect stdout/stderr, resolve on `close`, and reject on process error or timeout after killing the child process group. Do not expose a per-call timeout option.

- [ ] **Step 6: Run the complete context test file.**

Run: `pnpm nx test daemon --testFile=packages/daemon/src/run/context.spec.ts`

Expected: PASS, including record-time JSON failure, foreground output capture, background re-spawn, stage stamps, and changed-files replay.

- [ ] **Step 7: Commit the context factory.**

```bash
git add packages/daemon/src/run/context.ts packages/daemon/src/run/context.spec.ts
git commit -m "feat(daemon): add journal-backed workflow context"
```

### Task 4: Add Port Reservation and Terminal Cleanup Lifecycle

**Files:**
- Modify: `packages/daemon/src/run/header.ts:30-139`
- Modify: `packages/daemon/src/run/header.spec.ts`
- Create: `packages/daemon/src/run/lifecycle.ts`
- Create: `packages/daemon/src/run/lifecycle.spec.ts`

- [ ] **Step 1: Write failing header tests for ports.**

```ts
it('round-trips the ports reserved for a Run', async () => {
  await writeRunHeader(paths, header({ ports: [41001, 41002] }));
  await expect(readRunHeader(paths, 'NG-601-1')).resolves.toMatchObject({
    ports: [41001, 41002],
  });
});

it('rejects duplicate and invalid ports', async () => {
  // Write raw headers with [41001, 41001] and [70000].
});
```

- [ ] **Step 2: Run header tests to verify they fail.**

Run: `pnpm nx test daemon --testFile=packages/daemon/src/run/header.spec.ts`

Expected: TypeScript failure because `RunHeader.ports` does not exist.

- [ ] **Step 3: Persist validated ports in the header.**

```ts
const portsSchema = z
  .array(z.number().int().min(1).max(65_535))
  .refine((ports) => new Set(ports).size === ports.length, 'ports must be unique');

export interface RunHeader {
  v: number;
  runId: string;
  trigger?: string;
  issue: Issue;
  branch: string;
  ports: number[];
  pr?: Pr;
  status: RunStatus;
  outcome?: RunOutcome;
  reason?: string;
  boots: number;
  createdAt: string;
  endedAt?: string;
  error?: RecordedError;
}
```

Bump `RUN_HEADER_VERSION`, initialize a new Run with `ports: []`, and require the array in persisted headers. Do not treat an old header as compatible: it lacks required Run state.

- [ ] **Step 4: Write failing lifecycle tests for reservation and terminal cleanup.**

```ts
it('re-reserves ports on each Boot and writes the current reservation', async () => {
  const reservePorts = vi.fn().mockResolvedValueOnce([41001]).mockResolvedValueOnce([41002]);
  await bootRun({ reservePorts, workflow: parkAfterOneStep });
  await bootRun({ reservePorts, workflow: finishAfterOneStep });
  expect(reservePorts).toHaveBeenCalledTimes(2);
  expect((await readRunHeader(paths, runId)).ports).toEqual([41002]);
});

it('kills a background process group and its grandchild after terminal completion', async () => {
  // Spawn a detached shell which backgrounds a child, write both PIDs to temp files,
  // finish the Run, then assert process.kill(pid, 0) throws ESRCH for both.
});
```

- [ ] **Step 5: Implement the lifecycle wrapper.**

```ts
export interface RunLifecycleServices extends ContextServices {
  reservePorts(): Promise<number[]>;
  killProcessGroup(pid: number): Promise<void>;
}

export async function bootWorkflowRun(
  options: WorkflowRunBootOptions,
): Promise<BootResult> {
  const ports = await options.services.reservePorts();
  const header = { ...options.header, ports };
  await writeRunHeader(options.paths, header);
  const groups = new Set<number>();
  const result = await runBoot({
    journalPath: options.paths.run(header.runId).journal,
    workflow: (runner) =>
      options.workflow(
        createWorkflowContext(runner, header, {
          ...options.services,
          trackProcessGroup: (pid) => groups.add(pid),
        }),
      ),
  });
  if (result.status === 'finished' || result.status === 'failed') {
    await Promise.all([...groups].map(options.services.killProcessGroup));
  }
  return result;
}
```

Implement POSIX cleanup as `process.kill(-pid, 'SIGTERM')`, ignoring `ESRCH`; then wait briefly and send `SIGKILL` to any group that remains. Keep groups alive for a parked result. Ensure the context factory calls `trackProcessGroup` every time it starts a background command, including a Boot re-spawn.

- [ ] **Step 6: Run lifecycle and header tests.**

Run: `pnpm nx test daemon --testFile=packages/daemon/src/run/header.spec.ts --testFile=packages/daemon/src/run/lifecycle.spec.ts`

Expected: PASS; the grandchild is dead after terminal completion and not killed on park.

- [ ] **Step 7: Commit the lifecycle seam.**

```bash
git add packages/daemon/src/run/header.ts packages/daemon/src/run/header.spec.ts packages/daemon/src/run/lifecycle.ts packages/daemon/src/run/lifecycle.spec.ts
git commit -m "feat(daemon): manage ctx ports and background processes"
```

### Task 5: Verify the Complete Slice

**Files:**
- Modify: `docs/superpowers/specs/2026-09-04-ctx-surface-design.md` only if implementation exposed a source-of-truth mismatch.

- [ ] **Step 1: Run all affected tests with coverage.**

Run: `pnpm nx test sdk --coverage && pnpm nx test daemon --coverage`

Expected: PASS with no coverage decrease.

- [ ] **Step 2: Run affected linting and type checks.**

Run: `pnpm nx run-many -t lint,typecheck --projects=sdk,daemon`

Expected: PASS.

- [ ] **Step 3: Run formatting verification.**

Run: `pnpm exec prettier --check packages/sdk/src/ctx.ts packages/sdk/src/ctx.spec.ts packages/sdk/src/index.ts packages/daemon/src/run/journal.ts packages/daemon/src/run/replay.ts packages/daemon/src/run/replay.spec.ts packages/daemon/src/run/header.ts packages/daemon/src/run/header.spec.ts packages/daemon/src/run/context.ts packages/daemon/src/run/context.spec.ts packages/daemon/src/run/lifecycle.ts packages/daemon/src/run/lifecycle.spec.ts`

Expected: all files are formatted.

- [ ] **Step 4: Inspect the final change set before shipping.**

Run: `git status --short && git diff --check && git diff main...HEAD --stat`

Expected: only NG-597 files are changed; no whitespace errors.

- [ ] **Step 5: Rebase and create the reviewable change.**

Run: `git fetch origin main && git rebase origin/main`

Expected: clean rebase; resolve only conflicts within this slice, then run Steps 1–4 again before opening the PR.
