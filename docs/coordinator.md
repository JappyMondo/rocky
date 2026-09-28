# Durable coordinator contract slice

Taskbot #53 implements local coordinator state and dispatch contracts. It does **not** implement or qualify a live Codex harness, Attraccess coding check selection, independent target acceptance, GitHub publication, or a successful coding delivery. The existing accepted environment qualification is historical evidence and is unchanged.

## Ownership and persistence

`Store.admitCoordinator` creates a versioned scope/snapshot and repository/issue ownership in the same SQLite database as foundation runs, append-only events, effects and commands. A repository/issue has one current run. An explicit rerun names the previous terminal, quiescent run and a new rerun identity; old owners cannot revive it after transfer. Workspace identity stays attached to its run.

`ingestCoordinator` deduplicates by `(source, eventId)`. An identical retry is harmless, but changed payload or run identity under that key is rejected. IDs must therefore include the upstream source namespace. Sources are trusted host entrypoints, **not authentication**. An agent result can report changed/no-code/failed/interrupted execution; it cannot submit authoritative check, review, CI or approval verdicts through this entrypoint.

`applyCoordinator(lease, expectedRevision, source, eventId)` starts `BEGIN IMMEDIATE`, validates fencing/versions/revision, reduces the persisted event, and atomically writes the consumed inbox marker, new snapshot, monotonically reserved budgets, global slot, existing effect outbox intent and append-only transition event. An exception rolls everything back. A retry of a consumed event returns current state without spending again. The transaction only runs synchronous local code.

Coordinator snapshots cannot be changed with the older generic `transition` or `revise` APIs. Foundation cancellation still immediately revokes dispatch; the next coordinator event incorporates it. The coordinator schema is 1, separate from SQLite storage schema 2 and pinned workflow/adapter/prompt/runner/build versions. Unknown snapshot or storage versions fail closed. Version changes do not silently upgrade an active run.

## Schema compatibility

Opening an owned schema-1 database upgrades it additively, transactionally to schema 2. Existing runs, events, effects and command payloads remain unchanged. SQLite 0 means a fresh database. Versions other than 0, 1 and 2 are rejected. The previous schema-1 reader rejects schema 2; downgrade is unsupported. Drain old processes and make an offline database backup before an operator chooses to open an existing database with this build. No retained environment database was migrated during this task. Tests construct an owned v1 database, migrate an owned copy, verify preserved records and rejection by the previous reader.

## Execution capacity, waits and cancellation

There is exactly one durable execution slot across coordinator run IDs, distinct from each run lease. Reserving any action occupies it. Expiry or release of the run lease never frees the slot. The lease fence that reserved the action must still match at initial dispatch. A new owner may reconcile the recorded action, but cannot silently start it again. After an ambiguous/lost start response the effect stays `sending` and a second dispatch refuses.

A trusted result for the exact action and input digest must attest quiescence before slot release; all foundation command records for that run must also be finished. A cancellation, version change, input revision, unquiesced result or deadline violation cannot authorize further work. Cancellation persists first; `interruptCoordinator` then calls the trusted transport's bounded interruption entrypoint. An interruption acknowledgement is not a completion receipt. Invalidated/late results may settle execution ownership but cannot adopt code or mint readiness.

External waits persist reason, wake time, deadline and resume stage before execution capacity is released. Quiescence still gates release. Successful code results during draining update the head and resume at verification. Early wake refuses; deadline expiry records an access blocker. The same run/workspace resumes; it is not recreated.

## Budgets and evidence

Each run reserves one environment retry, two product/CI repair attempts with at most one usable by product repair, one review correction and one disagreement decision. CI observation and CI repair remain reachable after subjective review exhaustion. The total token and elapsed ceilings remain global and may independently prevent any action. Head/scope revisions do not reset counters. Repeated unchanged failure signatures and no-op repair results stop rather than looping.

Every action reserves elapsed allowance before dispatch; agent actions also reserve token allowance. Reservations are never refunded in this first implementation, including after crashes or cancellation. This deliberately conservative policy prevents double-spend. Actual reported token usage is recorded separately. Elapsed accounting uses a persisted high-water timestamp, so clock rollback cannot lower usage. Every dispatch has a deadline bounded by both its allowance and the total run deadline. Scheduler ticks can expose deadline exhaustion without dispatch. A reported hard-cap overrun is a recovery failure, not extra authorized budget.

`HardLimitsCapability` and `CoordinatorTransport` are a **trusted integration seam**, not proof that any installed provider enforces a cap. Missing capability blocks admission; a changed capability/version blocks dispatch. The future harness must independently establish hard elapsed/token enforcement, synchronous start, no hidden retry, stable action identity, isolated authority, and complete process/tool quiescence. Merely setting these fields or receiving token notifications is not production qualification. No live transport is supplied here; tests inject explicitly labelled local contract transports.

`registerCoordinatorReceipt` is only for trusted coordinator-owned check/CI/review/approval collectors. It reads the existing content-addressed `Evidence` artifact, validates referenced artifacts and exact scope/head/base/build/check-plan/coordinator-input binding, then registers a durable evidence event. Failure signatures and diagnostics availability are part of the hashed receipt. The apply transaction rechecks identity so a queued receipt cannot cross a revision. All dependent receipts invalidate on a head/scope/plan change; new checks/CI invalidate review and approval. Failed CI with unavailable diagnostics remains failed and has a repair route. Content hashes establish integrity, not producer identity: production isolation must keep this API, SQLite and evidence storage outside the agent write boundary.

`handoff_ready` means current local contract evidence has checks, CI and review passes. It is not a remote PR, merged change, tracker closeout or live acceptance claim. `no_code` is separate and cannot count as a coding handoff. There are explicit environment/access/hardware/capability/budget/engineering/recovery blockers.

## Validation and next integration

Run `npm run typecheck`, `npm run build`, then `node --test --test-concurrency=1 tests/coordinator-store.test.mjs tests/coordinator-reducer.test.mjs tests/store.test.mjs tests/evidence-config.test.mjs tests/runner.test.mjs`.

The coordinator tests retain uniquely named SQLite/evidence artifacts under `.qualification/coordinator-53/`. They exercise real concurrent child processes, SIGKILL while the public apply transaction holds a write lock and after commit, atomic rollback, deduplication, schema migration, rerun/fencing/capacity, dispatch uncertainty, cancellation, waits, independent repair budgets, stale evidence and hard-capability rejection. Injected transports establish only the local contract. Independent Standards and Spec reviews and later live harness/check-planner/authority/acceptance work remain required.
