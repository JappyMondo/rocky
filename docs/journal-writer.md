# Journal Writer

`JournalWriter.open(path): Promise<JournalWriter>` is the exclusive daemon-owned
writer for one Run. The daemon's Run map must create it once per path and retain
that instance until all users have stopped. There is no cross-process lock: Boot
children must send appends over IPC, never open an independent writer. Reopening
is only permitted after the previous owner has stopped receiving operations.

## API

- `append(entry: JournalEntry, options?: AppendOptions): Promise<void>` writes a positional Step snapshot (including nested branches and runner `$end`).
- `put(key: string, value: unknown): Promise<void>` writes safe plain JSON control data, with a nonempty key.
- `get(key: string): Promise<unknown>` returns a detached latest value, or `undefined` for a missing key.
- `read(): Promise<Journal>` returns a fresh detached Journal snapshot.
- `Journal.getControl(key: string): unknown` reads a detached control value from that snapshot.

All operations are serialized in invocation order. Inputs are captured by value
at invocation, not when their queued write begins. Writes flush before resolving.
Validation/storage failures latch: later operations reject rather than authorize
more effects. `$end` is a barrier: subsequent Step/control writes fail, including
already queued writes; read/get remain available on a healthy terminal writer.

Control lines are `{ v: 1, kind: 'control', key, value, recordedAt }` in the same
`journal.jsonl`. They have no sequence or Boot and never appear in `entries`,
`latest`, interrupted counts or replay. Last value per key wins. Unknown fields,
incompatible versions and ordinary records after `$end` are corruption.

`open` repairs a torn tail only at exclusive owner startup. Later reads use
non-repairing `readJournal`. Direct `appendEntry` remains for standalone `runBoot`
tests, not a second production writer. Caller code must provide only safe persisted
data; this layer has no token/config knowledge or redaction policy. Terminal
mirroring must reserve and settle its durable control effects before `$end`;
this API does not permit post-terminal acknowledgements.

## Verification

The writer, Journal, non-repairing reader and replay suites cover the shared
persistence contract. Writer coverage includes reopen, racing operations, invocation-time
snapshots, nested Steps, failed/Steer attempts, terminal barriers, malformed
controls, torn tails and latched validation/storage failures. Focused TypeScript
checking passes. ESLint passes its available rules; the Nx module-boundary rule
is skipped when no cached project graph exists.

This is not evidence of child IPC, scheduler cancellation or live Linear
composition. Production children and controls share this writer through `run/execution.ts`; no live credentials, network
effects or power-loss fault injection were used in these tests.

## Explicit Step retry

`JournalWriter.retry(requestId, stepKey, resetControls?)` is the sole exception to
the terminal barrier. The scheduler authorizes it only for the final failed Agent
or exec Step, including a failed parallel group whose completed branches can be
reused. Structural failures, older Runs superseded by another Run for the same
issue, cancelled/finished/live Runs, and stale Boot numbers are refused. A frozen
terminal Linear response also prevents retry, preserving its publication identity.

A flushed `kind: "retry"` record follows the prior failed `$end`. The old bytes
remain intact. Readers project that marker as a waiting Step, clear only specified
integration closing guards, and preserve earlier outcomes, completed branches and
failure attempts. Agent retries carry previous human directions into a fresh
conversation. The next Boot continues the same Workflow snapshot. A marker
committed before a header-write failure recovers as queued on restart; request IDs
make repeated HTTP requests idempotent. No ordinary append can cross `$end`.

Failed workspaces are retained for retry until normal retention. For an older Run
whose clean workspace was already released, Rocky can restore local worktrees only
if their branches still match recorded revisions. It never resets a branch or
replaces a retained worktree. Retry cannot recreate removed non-repository files
or external services; use a new Run when earlier results depend on those.
