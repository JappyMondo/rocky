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

MCP validation consumes `readMcpConfig` through `run/mcp-contract.ts`, whose
runtime implementation is NG-599's `mcp/index.ts`. That dependency must be
integrated by the coordinator; there is no substitute parser. Missing Agent files
and unknown MCP call-site names remain Step errors.

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

NG-599 is not yet in this worktree. Focused snapshot tests inject the same public
`readMcpConfig(file)` contract; production loads the actual dependency by name and
fails with a named integration fix if it is absent. This keeps the snapshot loader
free of a second parser while allowing the stacked branch to typecheck.

Coordinator edits still required: exports, receipt/admission, publication before
header, trigger/sourceCommit persistence, live-Run refusal, built-in Onboarding
handoff, group Trigger input, and per-Boot child composition. The loader does
not claim those end-to-end acceptance criteria.
