# Workflow Loading

## Integration Contract

NG-598 owns `run/snapshot.ts` and `run/loading/`. The coordinator owns exports,
admission, header publication and the production Boot child.

`prepareWorkflowSnapshot(context: RepoContext, lead: RepoRef, options?)` refreshes
the owned clone, resolves `refs/remotes/origin/HEAD` under its shared mutex,
and copies the contents of `.rocky/` from that immutable commit. It returns
`{ sourceCommit, snapshotDir, triggers }`. `triggers` contains only
`{ kind: 'linear.onDelegate' }` or `{ kind: 'manual', name }`, never functions.
`options.validationTimeoutMs` bounds the validation child (default 10 seconds).
`options.signal` cancels extraction/validation and cleans staging; the existing
`ensureClone` fetch API does not accept cancellation, so cancellation during
that prerequisite is observed immediately after it returns.

The caller owns the returned staging directory: rename it into
`runs/<runId>/snapshot` BEFORE publishing the header, or remove it after refused
admission. Check existing live Runs before preparation. Persist `sourceCommit`
and the selected descriptor with the header. Failure cleans up staging.
Staging lives under `<Rocky home>/snapshots`, never under `runs/` where scheduler
recovery scans for published Run headers.

`resolveSnapshotTrigger(triggers, selector)` (also exported by `snapshot.ts`)
selects a descriptor or throws a
named-fix `WorkflowLoadError`. `selector` has the same discriminated shape.
Missing delegation binding says to add `linear.onDelegate` or fire a manual
Trigger. `WorkflowLoadError.kind === 'onboarding-required'` is reserved for a
missing lead `.rocky/`; the coordinator must start only built-in Onboarding.

`loadSnapshotWorkflow(snapshotDir, selector): Promise<Workflow>` imports the
snapshot and returns its selected callable. **Call this only in the disposable
runner-owned Boot child, never the HTTP/daemon process.** Validation uses a
separate, bounded process whose entire process group is killed and joined.
The supervisor stays responsive during a blocked import and kills its process
group if the daemon disappears. The import worker inherits that group and has
no captured stdout/stderr pipe for its descendants to keep open. Validation
runs in a scratch copy, including its cwd, so top-level generated files never
enter the snapshot admission publishes.

Node 24 strips erasable TypeScript without a consumer build. The loader resolves
`@rocky/sdk` and `zod` through Rocky's installed package exports, and resolves
snapshot-relative helpers including `.js` imports of `.ts` files. It writes no
loader/config/build artifacts into the snapshot. Each load has an independent
module-cache identity, including relative dependencies.

MCP validation consumes the merged NG-599 `mcp/index.ts` API through
`run/mcp-contract.ts`; there is no substitute parser. Missing Agent files and
unknown MCP call-site names remain Step errors.

## Boundaries

Snapshot extraction rejects symlinks and gitlinks rather than following them.
Relative module imports cannot escape the snapshot, including through symlinks.
These checks are not a sandbox: trusted Workflow code can use Node APIs and
perform effects at module top level, outside a Run and without `ctx`. Child
ownership isolates daemon execution/lifetime, not filesystem permissions.
Workflow code that deliberately starts a new detached process group escapes
that lifetime ownership; this is not an OS sandbox. Bare third-party imports
other than SDK/Zod are refused; vendor helper code inside `.rocky/` instead.

## Verification And Remaining Wiring

Focused tests live at the agreed preparation and load/resolve seams in
`run/snapshot.spec.ts` and `run/loading/loader.spec.ts`. They use real Git,
consumer TypeScript fixtures, a packed SDK with a relocated loader and Zod,
and real child-process owner loss. SDK `dist/` must exist, as with the repo's
normal dependency-build-before-test convention.

NG-599 is in `main`. Focused snapshot tests still inject the public
`readMcpConfig(file)` contract so declaration validation remains isolated; production
uses the merged implementation directly and keeps the snapshot loader free of a
second parser.

Coordinator edits still required: exports, receipt/admission, publication before
header, trigger/sourceCommit persistence, live-Run refusal, built-in Onboarding
handoff, group Trigger input, and per-Boot child composition. The loader does
not claim those end-to-end acceptance criteria.

## Delivery-specific preflight

Production refreshes configured MCP authentication in a bounded, journaled
`preflight.mcp` Step before running repository content. SCM adapters and their
credentials are resolved only when the Workflow first calls `ctx.scm`. That
first call performs the bounded, journaled `preflight.scm` Step before any SCM
operation; subsequent calls in the same branch-local Boot reuse its result.
Replay consumes the recorded probes without repeating their effects.

A Workflow that delivers only a Linear comment therefore does not require SCM
merge, draft, or source-push authority. PR Workflows retain draft and source-update authority checks before the first
SCM action, although those checks now occur
after planning/implementation when that is where the Workflow first uses SCM.
The SCM probe records merge authority but does not require it for PR-only
delivery. Actual merging still requires approval and the platform authority
checks in `armAutoMerge`. Onboarding continues to rely on authority checks at
its individual SCM operations.

Runs whose journal already records the legacy startup `preflight` Step keep
the original combined startup check and Step ordering on every subsequent
Boot. This includes an interrupted probe. They do not insert deferred SCM
preflight later, so existing parked snapshots resume without journal divergence.
