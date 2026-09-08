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
incompatible versions and complete records after `$end` are corruption.

`open` repairs a torn tail only at exclusive owner startup. Later reads use
non-repairing `readJournal`. Direct `appendEntry` remains for standalone `runBoot`
tests, not a second production writer. Caller code must provide only safe persisted
data; this layer has no token/config knowledge or redaction policy. Terminal
mirroring must reserve and settle its durable control effects before `$end`;
this API does not permit post-terminal acknowledgements.

## Verification

The focused writer, Journal, non-repairing reader and replay suites pass together
(121 tests). Writer coverage includes reopen, racing operations, invocation-time
snapshots, nested Steps, failed/Steer attempts, terminal barriers, malformed
controls, torn tails and latched validation/storage failures. Focused TypeScript
checking passes. ESLint passes its available rules; the Nx module-boundary rule
is skipped when no cached project graph exists.

This is not evidence of child IPC, scheduler cancellation or live Linear
composition. Those owners must share this writer; no live credentials, network
effects or power-loss fault injection were used in these tests.
