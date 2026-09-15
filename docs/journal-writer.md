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
the terminal barrier. The scheduler authorizes it for the final unfinished Step,
including a failed parallel group whose completed branches can be reused. If all
Steps completed, the failed `$end` is the retry target: replay reuses completed
Steps and resumes workflow code, including delivery operations between Steps.
If the final Step is an `exec` result with a nonzero exit code, retry reopens
that command instead of reusing its cached output. `ctx.exec` still returns exit
codes normally so workflows can handle expected failures. Earlier commands and
commands with downstream work are not invalidated. Historical markers that only
reopened `$end` remain readable and preserve their original replay behavior.
Explicit retries are available regardless of Step type or recorded error name;
unresolved problems may fail again. Older Runs superseded by another Run for the
same issue, cancelled/finished/live Runs, and stale Boot numbers are refused.
Frozen terminal Linear payloads and publication receipts are retained: a local
retry does not replace a previously published terminal response.

A flushed `kind: "retry"` record follows the prior failed `$end`. The old bytes
remain intact. Readers project that marker as a waiting Step (or remove only the
active terminal barrier for a `$end` retry), clear only specified
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

## Continuing exhausted reviews

A retry record with `continueExhausted: true` reopens only the `$end` of a
finished, exhausted Run. It increments the durable `review:continuations`
allowance and keeps every completed Step and the original journal bytes.
The scheduler checks the expected Boot, rejects active or superseded Runs,
and deduplicates request IDs. Only retained JSON delivery flows support this
operation; their frozen review limit determines the new batch size.

The delivery runtime replays each prior batch, including its exhaustion effects,
before consuming one allowance. It repairs the outstanding complaints, resets
review and CI counters, and starts another bounded batch. Comment deliverables
retain their last draft and review feedback. Planning, implementation and prior
publication effects are reused. Each explicit continuation has its own frozen
closing report and screenshot identities; previous reports remain unchanged.

When exhaustion continuation restores a released worktree, the issue branch may
have advanced from the initial workspace Step through the Run's own commits.
It restores that retained descendant tip without resetting it; the new batch
refreshes the PR revision and runs fresh validation and review. Ordinary failed
Step retries still require the recorded revision when restoring a released
worktree. Unrelated replacement histories remain ineligible for either path.
