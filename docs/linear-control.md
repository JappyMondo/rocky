# Linear Control

NG-601/602/603/629 composition contract. Production server, lifecycle and
Agent execution belong to NG-598/544. This lane does not register HTTP routes
or start a daemon. All links stay on `http://localhost:<port>`.

## Runtime Handoff

`LinearRunControl` is one instance per Run, shared by webhook, local API,
Boot reconciliation and timers. It serializes intake and awaits persistence
before acknowledging an Answer or Steer. Construct it with the Run's owned
Linear session, issue/app identity, local Run URL and a `LinearControlStore`:

```ts
interface LinearControlStore {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
}
```

This is a view of **runner-owned non-positional records in the same Journal**,
not permission to add a sidecar or put human words only in `run.json`.
`put` appends and syncs a record; `get` folds to the last recorded value.
The runtime owner is implementing that public seam. The control store key is
`linear:control`; mirror effects use distinct `linear-mirror:` keys. A single
Run writer must serialize these records with Step attempts and `$end`.
Nothing may acknowledge intake after `$end`. Terminal effect IDs must be
reserved before ending and terminal mirroring must be ordered with that writer.

Inside the runtime's `steps.step('checkpoint', { label }, handle => ...)`, call
`control.checkpoint(handle.identity, { title, body, label, digest })`. Use the full
nested Step key, e.g. `3/0/2`, never the label or root sequence alone. It returns
the ordinary `{ status: 'waiting' }` or `{ status: 'done', result: Answer }`.
The runtime journals the outcome. On retry an emitted Checkpoint only reads
for an Answer; it never emits again. Generation, UUID-v4 effect ID and frozen
body are durable before the first elicitation. Options carry generation-specific
opaque values. A local Answer requires that generation, not just a Run ID.

The local API calls `answer({ requestId, stepKey, generation, answer })` for a
Checkpoint and `steer({ requestId, message })` for a running Run. Both enter the
same serialized durable intake as Linear prompts. `answer()` validates the full
Step key and generation, then returns either the accepted Answer or the durable
winner for a conflict. A stop fences effects immediately, but cannot overtake an
Answer that was already queued in that intake. A Linear prompt uses source
`linear`, activity ID, original `createdAt`, signal and body. Internal intake
results are `accepted`, `already answered`, `duplicate`, `ended`. Never interpret
free text into approve/reject;
it is a verbatim Steer-as-Answer at a Checkpoint.

`waiting()` supplies the current decision surface. `pendingSteers()` supplies
still-undelivered words for the Checkpoint/closing presentation without consuming
them. A losing old-generation Answer cannot answer a later re-ask.

## Local Product Handoff

The local-product adapter must use only these read-only control methods, never
decode `linear:control` records:

| Method | Contract |
| --- | --- |
| `currentCheckpoint()` | The unresolved Checkpoint for the decision surface, if any. It includes the full Step key, generation, frozen title and body. |
| `checkpointSnapshot({ stepKey, generation })` | That exact Checkpoint, including its settled winning Answer. Use this identity for a 409 conflict response; it cannot accidentally address a later re-ask. |
| `answer({ requestId, stepKey, generation, answer })` | Performs the same CAS as Linear intake and returns `{ kind: 'accepted' | 'already-answered', answer }`. |
| `steer({ requestId, message })` | Persists a local Compose request through the shared intake and returns its durable receipt. A waiting Checkpoint instead requires `answer()` with `decision: 'steer'`. |
| `steers()` | Every durable receipt, including already delivered records. |

A `SteerSnapshot` is `{ id, source, requestId, message, receivedAt, state,
targets }`; every target is `{ stepKey, delivered }`. `message` is verbatim,
`state: 'delivered'` means it has no remaining recipient to deliver to, while
each target retains its own delivery outcome. `state: 'held'` is not a lost
message. A local wire contract that currently exposes only target strings must
retain this per-target delivery information before claiming a receipt is
delivered.

## Agent Handoff

NG-544 opens a live conversation with
`openConversation({ stepKey, label, group? })`. A fan-out group is its enclosing
parallel Step key. At an adapter-proven safe tool-result boundary, call
`takeSteers(stepKey)`. If present it returns `{ ids, message }`: messages in arrival
order joined with two newlines, with each message itself unaltered. There is
at most one in-flight batch per Step. The execution owner durably records the
`steer` attempt, gracefully shuts down/flushes, and resumes **the same session**
with exactly `message`. No input splicing or SIGINT on intake.

Only after continuation accepts that user turn, call `delivered(stepKey, ids)`.
Per-target acknowledgements survive partial parallel delivery and restart. A
sibling that opens later in a bound fan-out group gets its own target even after
another branch has reached a boundary.
The delivery/ack crash window is at-least-once, not distributed exactly-once.
`closeConversation(stepKey)` moves any outstanding recipient back to pending
for the next Agent; it never silently consumes it. A cold retry with the same
Step key can recover an unacknowledged target. No new Steer timeout is introduced;
NG-544's existing attempt deadline covers continuations and schema repairs.

## Recovery And Stop

Call `reconcile()` before every Boot, including queued work. It checks current
session ownership/dismissal/delegation and processes prompt history through
the same intake. Full overlapping scans are currently preferred over a cursor
that could lose a delayed prompt; durable activity-ID dedupe is authoritative.
The client paginates. A future high-water mark in `run.json` is only a cache.
`tick()` runs the 60-second backstop while conversations are live; the runtime
scheduler already owns the five-minute Checkpoint cadence and admission cap.
`wake` schedules `scheduler.poll(runId)` without awaiting the current Boot. It
follows the durable receipt before the best-effort notice; an unsent notice stays
durable for retry and cannot reject an Answer or Steer.

Wire synchronous `halt` to abort owned processes and fence network/product
effects immediately. After recording stop (and a reject Answer if waiting),
`cancel` enqueues scheduler cancellation. It must **not await the reconciling
Boot** or it deadlocks. The scheduler remains sole terminal owner. Stop cleanup
preserves dirty/unpushed work locally and sends only the final confirmation:
no push, draft, issue-state change or Workflow continuation. This needs the
runtime's explicit stop-at-Checkpoint cancellation handshake, not a normal
requeue of the reject Answer.

## Gates

Do not claim live Linear app-token authority from the user's MCP. Local tests
never mutate real issues. Real session discovery, localhost rendering, automatic
comment behavior, final image rendering and authenticated both-Harness
continuations remain separately qualified integration gates. An elicitation
that creates an unavoidable third total comment is a spec/API blocker, not
permission to promise two explicit comments. NG-651 review precedes any live
inbound/outage fixture. Known session + valid credentials + reachable outbound
Linear is the boundary of the dead-endpoint recovery claim.
