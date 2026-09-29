# Operate Rocky Next locally

Use the repository-pinned Node **24.16.0** and npm **11.13.0**. From a clean checkout:

```sh
npm ci
npm run build
npm link
rocky-next setup
rocky-next start
```

Alternatively, without changing your global Node installation:

```sh
npm exec --yes --package=node@24.16.0 --package=npm@11.13.0 -- npm ci
npm exec --yes --package=node@24.16.0 --package=npm@11.13.0 -- npm run build
npm exec --yes --package=node@24.16.0 --package=npm@11.13.0 -- node dist/cli.js setup
npm exec --yes --package=node@24.16.0 --package=npm@11.13.0 -- node dist/cli.js start
```

`start` prints the local URL. Configuration, tasks, run history, evidence, exact-commit approval, merge and manual closeout live in the web UI. `rocky-next status` reports the owned process and URL; `rocky-next stop` drains active work. `identity` prints the packaged build identity. `config` retains the legacy foundation diagnostic command; operator configuration belongs in the UI.

`ROCKY_NEXT_HOME` selects the private state directory (default `~/.rocky-next`). `ROCKY_NEXT_PORT` selects the loopback port (default 4737; use 0 for a free port). Start and stop with the same home. Rocky binds only `127.0.0.1`; use the printed address, not a hostname alias. Foreign Host/Origin and cross-site requests are rejected. There is no account/authentication system; the single local user controls the daemon. Do not proxy it to a network.

The state directory holds SQLite state, immutable evidence blobs, action logs, isolated source copies and the daemon log. Preserve it for diagnosis. A crashed daemon never relaunches an interrupted agent or repeats an unresolved external write. The UI marks interrupted work as requiring reconciliation. Inspect owned command/effect records and the remote PR before any manual recovery. No automatic crash-resume or cleanup of unpublished work is claimed. After confirming no daemon is running, a stale `daemon.lock` may be removed to restart.

## Current scope and live prerequisites

The daemon/UI and delivery path are implemented and locally tested with a real SQLite database, real local git/check processes, the existing owned fake OpenCode executable, and a fake GitHub transport. These tests are **not live model or GitHub evidence**.

**Current-head Attraccess environment integration is not implemented in this slice.** The historical `AttraccessEnvironment` consumes hardcoded fixture source/tree, admission and image identities in `src/attraccess/policy.ts`; it cannot yet verify the new run workspace. The UI explicitly blocks that target until this integration is completed. The next integration must parameterize the existing environment source/admission boundary and bind setup, checks and the scoped browser scenario to the run commit. Do not reuse the archived fixture's acceptance evidence for a new target head.

`setup` initializes directories and the DB, checks gh authentication without exposing credentials, and copies an existing non-secret models catalog from `~/.cache/opencode/models.json` if available. Runtime assembly discovers the installed `opencode` path and rechecks it against the supported binary digest; it does not execute an unknown binary to infer compatibility. A different hash/version remains unavailable until separately verified. There is no fallback to another harness or model.

Host authority is intentionally separate from editable task settings. `setup` writes `authority.example.json`. After the actual authority and native qualification steps are accepted, a trusted host integrator creates `authority.json` with:

- `repository`: the explicitly authorized `owner/repository`.
- `liveApproval`, `nativeProbeEvidence`, `authBoundaryApproval`: references to the accepted bounded run authority, pinned native probe results, and direct-subscription auth-boundary decision.
- `qualification`: the existing coordinator `ExecutionQualification` object from that reviewed host decision. Setup does not mint qualifications or synthetic live evidence.
- `checks`: reviewed executable check recipes `{ "name": "...", "file": "/absolute/executable", "args": ["..."] }`. They run in the isolated target workspace. Use actual target checks; an empty list is rejected. No automatic repair loop is enabled.
- `requiredCI`: actual required check names for the target. Missing or pending checks cannot produce a pass.

The runtime's binary/model identity, role prompts and steps, limits, paths and sealed environment are assembled in code; operators do not write a large adapter JSON file. Each admitted run freezes its authority, runtime configuration, task, check plan and budgets in SQLite.

Before a live run, the user must provision OpenCode authentication into the dedicated `ROCKY_NEXT_HOME/opencode-data` XDG data home using the separately reviewed login procedure in [opencode-adapter.md](opencode-adapter.md). Rocky does not read, copy, or proxy `auth.json`. Existing real-user shared authentication is not silently adopted. The native export-envelope/tool-registry and credential-boundary gates still require their accepted evidence; a local fake-CLI pass does not close them.

## Workflow and handoff

A run clones the selected base branch into owned storage, executes the frozen baseline checks, runs the existing OpenCode implementer, commits the actual resulting tree, and runs the frozen product checks. The original checkout is untouched. Host git operations own commits and publication. Changes to `.github/` stop for separate review. An agent cannot supply a successful check receipt.

The draft PR uses a unique `rocky/<run-id>` branch and the verified commit. Draft creation, ready-for-review and merge use durable outbox intents. Unresolved effects are not automatically retried. CI is observed every 30 seconds until the run deadline. Click **Refresh CI** for an immediate observation of checks for the PR head and integration SHA; failed CI stops for an operator. Once CI passes, the independent read-only OpenCode reviewer receives the diff and structured evidence. Its settled result and unchanged tree are required before human handoff. The MVP uses one implementation and one review; it does not automatically consume repair budgets.

Review the diff and click **Approve `<commit>`**. Approval records that exact SHA, PR base/integration identity and timestamp. **Merge approved commit** is a separate action; it rechecks remote inputs and CI, marks the draft ready, then uses GitHub's expected-head merge guard. It never uses an admin bypass. GitHub must confirm a merge commit before the UI permits manual closeout. Record a closeout note; Linear automation is deferred.

Token totals are harness-reported usage. Thresholds stop another automatic agent action when reached or unresolved; they are not a provider-verified or mid-turn spending ceiling. Process deadlines and bounded role steps remain enforced by the existing runner/adapter. Unknown lifecycle or usage evidence cannot be reported as successful delivery.
