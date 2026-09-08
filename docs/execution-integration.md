# Execution Integration

Prerequisite boundary: `main` at `99add03`, which includes runtime PR #13 and MCP
PR #14. Harness successor PR #20 remains a separate runnable-adapter gate; this
lane invokes its `getHarnessAdapter` contract only when an Agent Step runs.

## Admission And Identity

`RunScheduler.admit({ issueIdentifier, requestId?, manual?, prepare })` owns the
one-live-Run check. `prepare(runId, signal)` only runs if admission can start new
work; it must not run on HTTP ingress. Concurrent requests for one issue serialize,
but a slow import does not hold the scheduler's cancellation/Boot mutation lock.
The callback returns `DelegateInput`, optionally including prepared `snapshotDir`,
`linear`, and `execution`. The scheduler stages the snapshot and header outside
`runs/` and publishes the complete Run with one directory rename. The caller
removes its prepared source directory after `admit` settles.

Use a durable transport request ID for redelivery: an already-persisted matching
`requestId` returns `{ kind: 'existing', run }` even after that Run ended. A new
delegation while live returns `nudged`. A new manual request while live is refused,
naming that Run. Other successful admissions return `started`.

The Run header adds optional fields to the persisted v2 foundation format:

```ts
linear: { issueId, teamId, organizationId, appUserId, sessionId }
execution: {
  source: 'repository' | 'onboarding',
  sourceCommit,
  trigger: { kind: 'linear.onDelegate' } | { kind: 'manual', name },
  members: [{ name, path, lead, url, baseBranch }]
}
```

They are required by production execution, not retroactively invented for older
foundation-only headers. Missing production metadata fails with a named fix.
`path` is workspace-relative, currently the repo name. Only `{ name, path, lead }`
is handed to the Workflow as ordinary `WorkflowInput.members`; Linear identity,
source commit and repo descriptors are not added to `ctx.issue`. No expanded
environment or credentials belong in either field.

## Ownership

Execution integration owns `server.ts` and `lifecycle/run-daemon.ts` wiring.
Linear control owns verified-event receipt, issue/session reads and session
acknowledgement before admission, Refusal publication and control intake. Its
receipt must persist before HTTP acknowledgement, outside arbitrary Workflow
imports, and recover before creating new work. Local product owns route handlers;
packaging owns CLI registration. Both use the same admission service.

SCM/Linear external adapters receive branch-local `BootContext` and the Boot's
`AbortSignal`; they journal through those Steps exactly once. The Agent wrapper
and its durable continuation seam are documented in `agent-steps.md`.

`ExecutionOptions.agentSteer` is the concrete parent-side Steer seam. Its
`open`, `take`, `delivered`, and `close` methods take the Run ID and full Step
key; `open` also carries the nearest enclosing parallel group. This matches
`LinearRunControl`'s conversation methods without importing that owner's module.
`openExecution` routes those operations over `RunWorkers` IPC; the child has no
control store and acknowledges a batch only after the Agent Journal records its
same-session continuation.

## Acceptance Gates

The current branch is not an integrated release candidate. Concrete Harness/MCP
handoffs, Linear receipt/control and local API registration, SCM Preflight and
Onboarding content must be composed before end-to-end acceptance. Both actual
Harnesses, app-token Linear behavior, four SCM/Harness smoke cells, installed
package imports and reviewed NG-651 public isolation remain separate gates.
No live public daemon or tunnel is opened by this lane's deterministic tests.
