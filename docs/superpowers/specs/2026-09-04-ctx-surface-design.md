# The ctx Surface Design

## Scope

NG-597 adds the workflow-facing context members that have no external platform
integration: immutable Run data, journal-backed arbitrary Steps, command
execution, deterministic parallel work, ports, stages, and changed-files. It
does not implement Agent, Checkpoint, posting, SCM, or Linear operations.

## Architecture

The journal runner remains responsible only for deterministic Step recording and
replay. A daemon-side context factory adapts that primitive into the SDK's
`WorkflowContext`, receiving the immutable Run header and narrow injected Run
services. Future tickets supply the remaining external members through the same
factory rather than coupling them to the replay engine.

## Context Members

- `issue` and `branch` come from the Run header and never change during a Run.
- `ports` is an ordinary `number[]` reserved at Boot and persisted in the Run
  header. The context property is immutable during that Boot.
- `stage(label)` is non-journaled, consumes no sequence number, and stamps
  later journal entries in the current Boot.
- `step(label, fn)` executes `fn` through the journal primitive. Its value is
  JSON round-tripped before the settle entry is written, so non-serialisable
  values fail on the live path. A thrown callback is a normal failed Step and
  does not park.
- `exec(cmd, opts)` is a journaled Step. Foreground commands resolve their
  captured exit result. Background commands start in a new process group and
  return the leader PID. Unlike foreground commands, a completed background
  command re-spawns on every Boot: a recorded PID is not a reusable process
  handle.
- `changedFiles()` is a journaled Step supplied by an injected changed-files
  service.
- `parallel(items, fn)` records a parent Step with the item count and a
  deterministic sub-journal keyed by index. Calls in different branches use
  independent sequences, so settlement timing and nesting cannot alter replay.
  A different item count is a divergence.

## Lifecycle

Before every Boot, the Run service reserves ports and writes them into the
header. A later Boot re-reserves ports rather than trusting a stale reservation.
When a Run reaches any terminal result, the service sends a signal to every
tracked background process group. Parked Runs retain their processes and
worktree; every background command re-spawns on the next Boot.

## Error Handling

Journal divergence remains fatal. Step callback errors are journaled and replay
as the same ordinary exception. Invalid JSON results fail at record time.
Changing a parallel item count reports divergence before branch work executes.
Command timeout behavior uses one daemon-owned default and reports a failed
Step.

## Testing

Tests will be written first for each acceptance criterion: replay through
ordinary control flow; record-time JSON failure; deterministic parallel replay
and item-count divergence; detached process-group cleanup including a
grandchild; and stage stamping without sequence consumption. Tests also cover
ports in the Run header and their renewed reservation on subsequent Boots.
