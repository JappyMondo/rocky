# Local foundation

This package supplies local primitives for the coordinator. It does not implement the Attraccess adapter, coding workflow, GitHub/Linear delivery, operator server or live acceptance. The protected v1.0.0 acceptance documents remain owned by Taskbot #9; implementation tests under `tests/` are not independent acceptance approval.

Use Node **24.16.0**, npm **11.13.0**, and the committed npm lockfile:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm run build
npm test
```

Build embeds the exact Git commit, dirty-source flag, Node version, package version and SHA-256 of compiled files in `dist/build-identity.json`. Commit source before a release build. From a clean committed checkout, `npm run build && npm run smoke` packs the artifact and installs it under `.qualification/package-smoke/`, verifies every installed compiled file against the embedded manifest and executes the installed CLI and SQLite API without using source files. The tarball digest, installed identity and results stay in that directory. Nothing installs globally or publishes remotely. `rocky-next identity` and `rocky-next config [file.json]` are the complete CLI surface in this slice.

Configuration uses one validated effective view with per-key release/operator provenance. Capacity is currently exactly one. Credentials are `env:VARIABLE_NAME` references, resolved separately only by the consumer. Public configuration never reads environment secret values. Arbitrary secret-bearing configuration keys and literal credential values are rejected without echoing values. Treat run data, command arguments and raw command logs as private; this foundation does not claim to scrub arbitrary program output.

## Store and effect contract

`Store.admit()` freezes input/version/configuration identity. `claim()` requires exact workflow, adapter, prompt, runner and build versions. SQLite WAL with FULL synchronization backs atomic transitions, append-only events, fencing tokens and effect intents. Claims use `BEGIN IMMEDIATE`, a persisted monotonically increasing token, owner and expiry. Every mutation by a worker checks the current token, versions and deadline. Cancellation is a separately authorized control operation and persists without needing a worker lease. Schema mismatch stops at an explicit boundary; no migration is implicit.

`transition(lease, stage, intent)` commits state, event and immutable operation identity atomically. Reusing a key with another payload/kind/run fails. `dispatch()` first durably marks a committed intent as sending, then reacquires a transactional guard at the actual transport initiation seam. The adapter's `begin(effect)` must initiate the request synchronously and return its completion promise. It must not defer request initiation, retry internally or start new writes after resolving. This is an internal trusted adapter contract, not a sandbox for arbitrary code. Cancellation/claim serialization defines which request began first; an already initiated request can finish after cancellation. Lost responses and sending states require read-only `reconcile()` by stable identity. An unknown/not-found observation never grants automatic replay. Confirmation after cancellation is allowed; stale owners cannot confirm. There is no exactly-once network claim.

The store deliberately does not choose delivery stages or acceptance policy. Later coordinator code owns valid transitions and approval gates. `guardedStart()` is the internal synchronous initiation seam shared with the runner; never await inside its callback. SQLite transaction callbacks do not wrap an entire network wait.

## Owned commands and recovery

`CommandRunner.start()` reserves the command durably and starts an isolated supervisor. The supervisor persists its process identity, launches a gated process-group leader, persists that identity, then permits the gate to initiate the target only under another live lease/cancel transaction. No shell is inserted. Commands receive a minimal environment (PATH plus private workspace HOME/TMPDIR); secret injection and repository environment policy belong to later adapter work.

The supervisor drains stdout/stderr continuously, stores and fsyncs bounded prefixes, records truncation, and retains content-addressed final log artifacts. Deadline, cancellation and lease loss terminate the complete owned POSIX process group with TERM then KILL within the configured grace plus polling/scheduling time. The gate stays alive through cleanup to preserve group identity. The waiting worker renews its lease; a killed worker stops renewing, so the surviving supervisor cleans up after expiry. The command outcome is independent from run progression and never turns a timeout into success.

Recovery observes the persisted supervisor instead of launching a duplicate. Missing/reused/uncertain process identity produces `recovery-required`, never an arbitrary PID kill. A live supervisor completes cleanup using its capability even after the worker lease changes. If the supervisor dies, IPC disconnect makes the gated group kill itself; recovery still conservatively records uncertainty. Starting reservations without a supervisor become recovery-required after a bounded startup wait. No workspace or evidence cleanup deletes unpublished data.

Supported process containment is POSIX process groups on macOS/Linux. This is not a hostile-process sandbox: a command must not detach descendants into another session or deliberately impersonate process identities. Fingerprints use PID/start-time/command observations; the owned gate lifetime prevents normal PID reuse while cleanup runs. Stronger OS containment is needed before running adversarial programs. Windows is rejected explicitly.

## Evidence and readiness

`Evidence` stores SHA-256-addressed bytes via exclusive temporary files and atomic hard links. Existing bytes are integrity checked, never silently overwritten. Receipts include head, base, scope, scenario, fixture, command and toolchain; all must match for reuse. Missing/tampered bytes fail evidence validation. Display/report retries do not mutate input identity. Historical browser evidence is separate from live readiness: `withFreshReadiness()` probes for every new execution; CI observation can reuse valid historical evidence without starting an application.

## Verification and boundaries

`npm test` executes retained local synthetic fixtures for F01-F11 under `.qualification/tests/`, including actual forked competing claimers, killed uncommitted SQLite transactions, crash after a fake ledger write, killed command workers, owned descendants, cancellation, timeout and an unrelated live sentinel. Every attempt log must be retained by the caller. Fake ledger reconciliation establishes only local behavior; real platform, browser and delivery acceptance remain later gates.

Primary API references consulted: [Node SQLite](https://nodejs.org/api/sqlite.html) and [Node child processes](https://nodejs.org/api/child_process.html). Node's built-in SQLite remains an experimental dependency in the pinned Node 24 line; changing that runtime requires compatibility qualification.

## Minimal API invocation

```js
import { Store, CommandRunner, Evidence } from "@jappymondo/rocky-next";
const store = new Store("/owned/run/state.sqlite");
const versions = {
  workflow: "wf-1",
  adapter: "aa-1",
  prompt: "p-1",
  runner: "r-1",
  build: "build-A",
};
store.admit({
  id: "synthetic-001",
  head: "H",
  base: "B",
  scope: "scope-v1",
  versions,
});
const lease = store.claim("synthetic-001", "worker-A", versions, 5000);
const command = await new CommandRunner(store).run(lease, {
  file: process.execPath,
  args: ["-e", 'console.log("local check")'],
  cwd: "/owned/workspace",
  outputDir: "/owned/run/commands",
  timeoutMs: 1000,
  cleanupMs: 100,
  logBytes: 4096,
});
// Inspect command.result.outcome and immutable log artifact hashes before recording check evidence.
store.transition(lease, "publication-pending", {
  key: "synthetic-001/local-effect/1",
  kind: "local-fixture",
  payload: { head: "H" },
});
// Production adapters must implement the trusted synchronous begin contract above.
await store.dispatch(lease, "synthetic-001/local-effect/1", {
  begin: () => Promise.resolve({ remoteId: "synthetic-only" }),
});
store.close();
```

For deliberate death tests, `tests/worker.mjs` exposes `claim`, `uncommitted`, `effect`, and `command` modes to forked test parents. These are disposable test helpers, excluded from installed package files. The library exports declaration files for all public types; internal `gate.js`/`supervisor.js` are package-owned subprocess entry points.
