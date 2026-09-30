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

Setup rejects a home whose recorded daemon or workflow process identity is still alive, before changing its files or database. It initializes the schema without running startup recovery. The daemon claims one SQLite owner, verified against the actual process identity; only an orphaned owner permits startup recovery. A second service cannot downgrade the active owner's run into recovery.

## Current scope and live prerequisites

The daemon/UI and delivery path are implemented and locally tested with a real SQLite database, real local git/check processes, the existing owned fake OpenCode executable, and a fake GitHub transport. These tests are **not live model or GitHub evidence**.

For the supported ATT-764 task, start Docker Desktop and run `rocky-next setup /absolute/path/to/Attraccess` against a clean checkout of the selected base. Setup reads the checkout's Node and pnpm pins, builds an owned development image, checks Chromium availability, and saves the source identity and fixed task. Install the packaged Playwright Chromium first if setup reports it missing (`npx playwright install chromium` from this package). Setup retains its command logs under `ROCKY_NEXT_HOME/attraccess` and never grants live authority. A changed base requires setup again.

Each check uses an isolated image of the actual run commit. It runs the PeopleManagement component tests, a host-controlled 16-case matrix (English/German, resource/group, actions/no actions, shown/hidden header), frontend typecheck, and a real English/German group-page browser smoke. Baseline records the existing group-wording defect; product verification requires group wording while preserving the exact resource subtitle. Only PeopleManagement changes are admitted for this task; deletions and changes outside that directory fail. The archived fixture qualification and its evidence remain separate.

`setup` initializes directories and the DB, checks gh authentication without exposing credentials, and copies an existing non-secret models catalog from `~/.cache/opencode/models.json` if available. Runtime assembly discovers the installed `opencode` path and rechecks it against the supported binary digest; it does not execute an unknown binary to infer compatibility. A different hash/version remains unavailable until separately verified. There is no fallback to another harness or model.

Host authority is intentionally separate from editable task settings. `setup` writes `authority.example.json`. After the actual authority and native qualification steps are accepted, a trusted host integrator creates `authority.json` with:

- `repository`: the explicitly authorized `owner/repository`.
- `liveApproval`, `nativeProbeEvidence`, `authBoundaryApproval`: references to the accepted bounded run authority, pinned native probe results, and direct-subscription auth-boundary decision.
- `qualification`: the existing coordinator `ExecutionQualification` object from that reviewed host decision. Setup does not mint qualifications or synthetic live evidence.
- `task`, `profile`, `checks`: use the fixed ATT-764 task/profile and executable recipe generated by setup in `authority.example.json`. The daemon supplies the phase, owned state root and frozen base. An edited task or substituted check recipe is rejected. No automatic repair loop is enabled.
- `requiredCI`: actual required check names for the target. Missing or pending checks cannot produce a pass.

The runtime's binary/model identity, role prompts and steps, limits, paths and sealed environment are assembled in code; operators do not write a large adapter JSON file. Each admitted run freezes its authority, runtime configuration, task, check plan and budgets in SQLite.

Before a live run, the user must provision OpenCode authentication into the dedicated `ROCKY_NEXT_HOME/opencode-data` XDG data home using the separately reviewed login procedure in [opencode-adapter.md](opencode-adapter.md). Rocky does not read, copy, or proxy `auth.json`. Existing real-user shared authentication is not silently adopted. The native export-envelope/tool-registry and credential-boundary gates still require their accepted evidence; a local fake-CLI pass does not close them.

ATT-764 setup proposes one implementer (12 steps), one reviewer (6 steps), a 30-minute action deadline, 120-minute run deadline and 25,000 harness-reported token threshold checked between agent actions. The live authority must explicitly cover the intended draft PR; merge remains a separate exact-commit approval and action.

ATT-764 commits and PRs use the conventional title `fix(frontend): correct group people permissions subtitle`; task text remains in the run record. Target commits use the host identity configured in the owned workspace and require Git signing. Configure a GitHub-recognized signing key and verified email before live work. Successful local fixture signing does not prove target-side acceptance. A queued merge is an external wait; only GitHub's confirmed merged state permits closeout.

## Workflow and handoff

A run clones the selected base branch into owned storage, executes the frozen baseline checks, runs the existing OpenCode implementer, commits the actual resulting tree, and runs the frozen product checks. The original checkout is untouched. Host git operations own commits and publication. Changes to `.github/` stop for separate review. An agent cannot supply a successful check receipt.

The draft PR uses a unique `rocky/<run-id>` branch and the verified commit. Draft creation, ready-for-review and merge use durable outbox intents. Unresolved effects are not automatically retried. CI is observed every 30 seconds until the run deadline. Click **Refresh CI** for an immediate observation of checks for the PR head and integration SHA; failed CI stops for an operator. Once CI passes, the independent read-only OpenCode reviewer receives the diff and structured evidence. Its settled result and unchanged tree are required before human handoff. The MVP uses one implementation and one review; it does not automatically consume repair budgets.

ATT-764 has one stable repository/issue identity; supported manual fixture tasks use a digest of their task text. Starting another run while that issue waits for CI, approval or a merge outcome refuses. **Start a rerun of `<run>`** explicitly names the predecessor. It becomes available only after cancellation, no-code completion or closeout, with no outstanding execution, unfinished command or unresolved external effect. A successful queue acknowledgement is still an outstanding merge outcome until the approved head is observed merged. Retain the predecessor's workspace and receipts.

CI discovery binds the actual GitHub check-run IDs, workflow run IDs/attempt numbers and commit-status IDs. Rocky begins the durable collector before fetching its results, then rereads upstream identities after all result reads. An attempt change during collection discards that bundle and invalidates review/approval. Approval and merge repeat this observation; a new attempt on the same commit invalidates review/approval. Identical polling with a new timestamp retains the existing evidence. A changed or conflicting bundle refuses the requested action and requires current evidence and independent review.

Review the diff and click **Approve `<commit>`**. Approval records that exact SHA, PR base/integration identity and timestamp. **Merge approved commit** is a separate action; it rechecks remote inputs and CI, marks the draft ready, then uses GitHub's expected-head merge guard. It never uses an admin bypass. GitHub must confirm a merge commit before the UI permits manual closeout. Record a closeout note; Linear automation is deferred.

A successful GitHub merge command records **merge requested**, including the approved head and acknowledgement time. GitHub may enqueue the PR or enable auto-merge; this is not confirmation of merge. **Refresh merge status** only reads GitHub and never sends the request again. It recognizes a later matching merged head before handling the changed base/integration SHA, then offers the separate manual closeout action. An ambiguous send also permits inspection/reconciliation, never automatic retry. See the [GitHub CLI queue behavior](https://cli.github.com/manual/gh_pr_merge).

Cancellation remains authoritative across awaited publication, CI, approval and merge operations. It stops new work; an already-sent external operation can still complete. Its durable receipt and later read-only PR observations are retained while the run stays cancelled. Cancellation does not withdraw an already-sent merge queue request. **Cancel run** is available during preparation, blocked or waiting states, and active work. Completed merged, closed or no-code workflows refuse cancellation.

Finished local checks and settled native agent results still drain the cancelled run's durable execution and slot. Native usage remains unchanged, and cancelled results cannot adopt code or create readiness. A safe explicit rerun becomes available only after command quiescence and external-effect reconciliation are established; an interruption acknowledgement alone does not make it available. Restart preserves the cancelled predecessor and its receipts.

Token totals are harness-reported usage. Thresholds stop another automatic agent action when reached or unresolved; they are not a provider-verified or mid-turn spending ceiling. Process deadlines and bounded role steps remain enforced by the existing runner/adapter. Unknown lifecycle or usage evidence cannot be reported as successful delivery.
