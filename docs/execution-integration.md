# Execution Integration

Production composition lives in `lifecycle/production-composition.ts`,
`run/execution.ts` and `run/production.ts`. It connects verified Linear intake,
local profile snapshots, the scheduler/Boot workers, harnesses, MCP, SCM and the
local API. `getHarnessAdapter` loads the native adapter when an Agent Step runs.

Profiles are machine-local. Explicit membership selects the Run's repositories
and first-member lead; otherwise legacy repository/group routing supplies them.
Missing profiles fail admission with a fix. Target-repository `.rocky/` files
are ignored. The retained repository loader and built-in Onboarding path are
legacy/injected seams, not the default profile setup flow.

## Admission And Identity

`RunScheduler.admit({ issueIdentifier, requestId?, manual?, prepare })` owns the
one-live-Run check. `prepare(runId, signal)` only runs if admission can start new
work; it must not run on HTTP ingress. Concurrent requests for one issue serialize,
but a slow import does not hold the scheduler's cancellation/Boot mutation lock.
The callback returns `DelegateInput`, optionally including prepared `snapshotDir`,
`profile`, `linear`, and `execution`. The scheduler stages the snapshot and header outside
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
  members: [{ name, path, lead, url, baseBranch }],
  reviewReports: true
}
```

`execution` and the frozen `profile` are required for normal production Runs;
`linear` is present for delegated, session-backed Runs only. The historical
`source: 'repository'` enum also names profile-backed execution; it does not mean
that a repository supplies Workflow configuration. Missing execution metadata
fails with a named fix rather than being invented for older headers.
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

## Available services and verification

Both delegated and manual admission hydrate the Linear issue and its complete
paginated comment history. Manual API requests may select `profileId`, but do
not acquire an Agent Session. Production attaches Linear mirrors, Questions,
Checkpoints, Steers, SCM and report publication only when a Run has its Linear
identity and a stored access token. Local-only Agent/shell Workflows can run
without those services; the shipped SCM-dependent manual Trigger cannot.

Session-backed Runs perform journaled MCP preflight before Workflow content.
SCM resolution/preflight is deferred until the first SCM operation, so a Linear
comment deliverable does not require PR authority. Older journals keep their
legacy preflight ordering. See [workflow loading](workflow-loading.md).

The local API uses the same scheduler for manual admission, cancellation and
eligible failed-step retries. Retry keeps the frozen profile and completed
work; releasing a terminal Linear session instead enables a fresh delegation.
Neither operation silently starts a new snapshot from edited content.

Production-composition and runtime tests cover these seams; the distribution
smoke tests installed worker/loader assets. Live account access, both harnesses,
GitHub/GitLab behavior and external endpoint delivery require their corresponding
live verification. Unit fixtures are not evidence that every combination works.
