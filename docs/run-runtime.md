# Run Runtime

Framework contracts for NG-540, NG-597, NG-631 and NG-648. Stage names,
Workflow control flow and application commands remain content. This module
does not implement Trigger loading, Agent/Harness adapters, SCM, Linear intake,
Checkpoint Answers or Steer delivery.

## Wiring

`@rocky/daemon` exports `RunScheduler`, `WorkflowRuntime`,
`createWorkflowContext`, `runBoot`, and the Journal/header contracts. The SDK
remains type-only apart from its existing builders and `z` export.

```ts
const runtime = new WorkflowRuntime({
  paths,
  loadWorkflow, // NG-598: this Run's snapshot, not the live repository
  workspace, // cwd for exec and changedFiles; the Run workspace by default
  baseRef, // configured base for changedFiles
  env, // optional per-Run command environment
  external, // (run, branchLocalSteps, signal) => partial external ctx members
});
const scheduler = await RunScheduler.open({
  paths,
  maxRuns: config.concurrency.maxRuns, // default 3
  boot: runtime.boot,
  cancellation: { kill: runtime.kill, cleanup: preserveWork },
  onError: reportRuntimeError,
});
await scheduler.delegate({ repo: leadRepo, issue, branch, trigger });
await scheduler.drain();
await scheduler.tick(); // timer driver; webhooks may call poll(runId) immediately
await scheduler.sweepRetention(config.retention);
await scheduler.close(); // daemon shutdown, not Run cancellation
await runtime.close();
```

The caller owns timer and HTTP registration. `tick()` uses five minutes for
`checkpoint`; other parking keys use 10, 20, 40, then 60 seconds. One Run has at
most one Boot in flight; `poll` coalesces timer/webhook races. Poll Boots replay
settled Steps and retry existing waits, but cannot execute a new Step or restart
a background command. Resolved waits are journaled before returning `ready`;
the scheduler queues the Run behind existing waiters under the normal cap.

`delegate` returns `{ kind: 'started' | 'nudged', run }`. `manual` requires a
Trigger name and refuses while naming any live Run for the issue, regardless
of ordinal. `open` refuses unreadable history or multiple live Runs rather than
admitting duplicate work. `get` returns a detached header copy. Header version
2 records lead repo, Boot ports and FIFO queue order; incompatible headers are
refused, not guessed. `runs/counters.json` preserves ordinals after retention.

## Context

Members: `issue`, `branch`, `ports`, `agent`, `exec`, `checkpoint`, `post`,
`changedFiles`, `step`, `parallel`, non-journaled `stage`, `scm` and `linear`.
Do not restate a member count. `stage(label)` takes no sequence and sets display
metadata on later entries without teaching the framework product-stage names.

`createWorkflowContext(steps, header, services)` binds the SDK surface to
branch-local Steps. External SCM and other adapters receive `BootContext` and
must journal their operations through it; they are not automatically wrapped
twice. `ctx.checkpoint` is framework-owned: it journals its one Step while its
external adapter returns a raw answer. Effects return `{ status: 'done', result
}` or `{ status: 'waiting' }`.
`EffectHandle.record(attempt)` records failed attempts or Steers without another
sequence. Missing external members name the adapter to wire.

`ctx.parallel(items, fn)` uses the same captured `ctx` inside each callback.
Async-local routing isolates nested branches. Raw concurrent calls on the same
branch fail as divergence. Await every ctx call. Structural failures cannot be
caught away; ordinary failures remain catchable and rethrow identically on replay.
Returned values belong to Workflow code: mutating them cannot change retained
Step outcomes or nested parallel snapshots, on live execution or replay.

`ctx.step` accepts plain JSON data (or void), not classes, handles, functions or
lossy nested values. It must be safe to run twice: a crash between effect and
record repeats that effect. Inter-Step code runs on every Boot. The issue
snapshot is deep-frozen; branch and ports come from the header.

Foreground `exec` captures `{ exitCode, stdout, stderr }`, with a ten-minute
default timeout and 16 MiB output limit. Nonzero exit is a result; timeout/spawn
errors fail the Step. Background `exec` returns `{ pid }`, owns a detached
process group, survives parking within this runtime, and restarts on working
Boots. Prior groups stop before renewal. An IPC supervisor kills the group if
the daemon dies, without trusting persisted PIDs the OS could have reused.
Terminal results stop every owned group, including grandchildren. `close()`
also releases parked children.

This is the approved NG-577 section 2 background-command exception: Parked
means no execution slot or live conversation is required, not that an existing
background process must be killed. Working Boots restart those commands;
poll Boots do not. Resume depends on the Journal, never on a surviving process.

Available loopback ports stay distinct across Runs in this runtime and are
recorded before each working Boot. The reservation socket is released for the
application's bind; an unrelated process stealing the port is an ordinary
startup failure. Poll Boots reuse the recorded values without allocating ports.

## Cancellation Owner

**The scheduler solely owns the cancellation protocol and terminal record.**
`stop` at a Checkpoint belongs to Answer intake. Otherwise the scheduler
persists `cancelRequestedAt`, aborts its Boot, calls `Cancellation.kill`, joins
the Boot, calls `Cancellation.cleanup`, then appends one cancelled `$end` and
updates the header.

The Boot launcher kills and joins the Boot child it owns. `WorkflowRuntime`
currently executes the Workflow in-process and owns exec supervisors; a
subprocess launcher must additionally terminate its own Boot child. Harness
adapters own concrete CLI child lifecycle and observe the supplied signal.
SCM/Linear adapters own cleanup: preserve/push committed branches, make existing
PRs draft with a comment (never close them), then remove worktrees and mirror
the terminal response. Effects must be idempotent. This slice tests the SCM
contract with fakes, not real platform pushes.

A cleanup failure leaves durable cancellation intent on a non-terminal Run.
`stop` retries it; recovery's `tick` retries without resuming the Workflow.
Each retry failure is reported without blocking other Runs' polls or admission.
Result-header retry insertion and writes share cancellation's serialization,
so an older result cannot erase durable cancellation intent.
Concurrent stops share one attempt. If a normal `$end` already won, its outcome
wins. `runBoot` returning `cancelled` means it stopped, not that preservation
completed. Daemon `close` aborts Boots without SCM cleanup or a terminal record;
recovery requeues the same Run.

## Retention And Integrity

Retention is per lead repo: defaults 100 terminal Runs, 40 with sessions and
screenshots. Non-terminal directories are untouched. `artifactsPruned` tells
readers to render "transcript pruned". A terminal Run whose workspace still
exists is retained until its owner preserves and removes that workspace.
Retention is not another cleanup path and never deletes a branch.

Readers reject malformed `$end`, terminal records in parallel branches,
complete records after `$end`, unknown fields and incompatible nested versions.
Only an unterminated tail is torn. Recovery refuses corruption without
truncating earlier work. The header caches the Journal's terminal outcome.
The runtime checks the Journal before loading the Workflow or renewing ports.
An existing terminal record wins; a loader failure is journaled when storage
is usable. An unreadable or unwritable Journal still propagates to the scheduler's
documented header-only failure fallback, without inventing another Run state.

## Prior Art

Adopted NG-540 header changes from `5860cef`, its untracked scheduler/tests,
and NG-597's uncommitted SDK/parallel-Journal work at `64ac0cd`, informed by
their approved designs. Original Cyrus worktrees/delegates remain untouched.
The 2026-09-07 decision supersedes the old newest-ordinal shortcut. Cancellation
records its terminal outcome after cleanup rather than making the header a
second durable authority.
