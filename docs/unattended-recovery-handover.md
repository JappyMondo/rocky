# Rocky reliability handover

Updated 2026-09-26. Continue durable fixes if further failures occur. Do not treat this handover as current run status; refresh the daemon first.

## Scope and operating rules

- Fix recurring failures in Rocky runtime, shipped workflow, or repository configuration. A repaired individual run is verification, not the deliverable.
- Discover repository instructions, commands, CI jobs and contribution rules at run time. Keep repository-specific policies out of generic Rocky prompts and logic.
- Build/install from `/Users/jappy/code/jappyjan/rocky`, branch `fix/unattended-recovery`. The user's main-checkout instruction concerns Rocky development/install; agents may use per-run worktrees.
- Preserve unrelated edits and all dirty/unpublished run work. Do not rewrite frozen snapshots or journals. Positional workflow changes need a version boundary and old-journal replay tests.
- Use `agent-browser` CLI for browser verification. Its documentation is `agent-browser skills get core --full`.
- Installation, safe daemon restarts and retry/replacement runs were authorized. Do not bypass merge approvals or fabricate successful validation.

## Code and installed state

The `fix/unattended-recovery` branch contains the completion gate, retained-run replay repairs, current UI endpoint binding, blocked-fixture recovery, stronger CI log excerpts, mandatory rechecks for previously failed configured commands, and journal-safe fixture blocker handling. See [the implementation notes](unattended-recovery.md). The local `rocky-0.2.0.tgz` has SHA-256 `db00045fa3be4f156a5a88c5f1364f1281ea8b894de53e70de13d85a0e8e4bec`. It passed the isolated distribution smoke test and was installed into both global prefixes at 11:58 UTC. Both installed `dist/main.js` files have SHA-256 `b6ea8f439e15dc5ca5a884ab9e9fba7622082ce842abd88b39ce9b765050c453`, both `dist/boot-child.js` files have SHA-256 `2fa6bcf2cc03cb5c24dd2a26b9318b9721dbd894afb216b19cc835a336ba9252`, and both `dist/flow-runtime.js` files have SHA-256 `360e01e50f383004c3059c7380192486be7b41f546fd8d9d6ed119480c82ca14`; these match the archive. Daemon and ingress LaunchAgents restarted and health returned OK. All four checks passed on the previous head of draft PR [#51](https://github.com/JappyMondo/rocky/pull/51); the new blocker change has not yet completed CI. This is not live end-to-end acceptance.

Important recent commits:

- Current blocker change: accept a validated agent blocker inside the journaled fixture Step on new recovery snapshots, then route it through bounded repair; older snapshots retain the exception path.
- `f0133e5`, `d7d6268`: preserve actual CI assertions in bounded log excerpts and force previously failed configured validation commands into subsequent new-snapshot validation rounds; then format the changes.
- `0cd1e37`: route blocked UI fixture preparation through bounded environment repair on new snapshots; preserve old journal order.
- `23f80bd`: gate comment and PR handoffs on recap readiness, reuse successful setup receipts on retained runs, bind UI plans to the current endpoint, and preserve old journal replay.
- `4f2b173`: create and grant only the Run screenshot directory to an opted-in fixture preparer.
- `5dccb09`: preserve `summary` when validating a discriminated-union agent result; ATT-764-4 had returned valid setup JSON that the wrapper rejected.
- `36fa317`: cover navigation from a hidden settled attempt; web function coverage cleared its unchanged CI threshold.
- `e2d9106`: classify GitHub check-run retry HTTP 404 and stop repeating the same refused request after fixer review on new snapshots; preserve old-journal replay.
- `467a6eb`: versioned UI fixture preparation before inspection, exact planned-check coverage, source provenance, relative URLs, screenshot evidence, bounded setup/recheck, source changes return through validation.
- `540ae24`: per-ticket cleanup locking so long removal does not block unrelated controls.
- `df2657c`: safe published workspace/cache cleanup, free-disk admission guard, authorized environment repair command IDs.
- `5ac0cc1`: configured host validation handoff when agent sandbox cannot run a command.
- `f990ab1`: transient service recheck polling and 60-second launchd shutdown grace.
- `d53e482`, `b040c86`: same-session maintenance continuation and planned shutdowns excluded from crash-loop accounting.
- Earlier commits cover refinement comments/prior answers, fresh-snapshot restart, CI retry SHA synchronization, worktree adoption, service provisioning for validation/recaps, settled runs and ticket grouping.

The original `/Users/jappy/.t3/worktrees/rocky/t3code-48f9ab53` checkout had no commits missing from the recovery branch at the previous handover. Recheck the main checkout and remote before further edits.

## Live recovery update, 2026-09-26 12:00 UTC

- ATT-764-5 failed at fixture Step 84 after its agent emitted a valid `<blocked>` envelope for unsupported read-only/header previews and a resource detail request that did not complete. Rocky's agent runtime threw `AgentBlockedError`, bypassing the structured blocked-result path and leaving a failed journal receipt. The new opt-in `blockedAsResult` converts that envelope *inside* the journaled Step only when the configured schema accepts it. An integration test with the real delivery and journal replay path passed after an initial implementation failed on replay. ATT-764-5's Step 84 retry was accepted and is **queued**; this is not yet live verification of recovery. Payload: `/tmp/rocky-durable-retry-ATT-764-5.json`.
- ATT-920-2's CI fixer received the exact WAGO audit assertion. The full local plugin E2E target passed, isolated reruns passed, and the fixer requested a GitHub job retry without changing source. The rerun `plugins` and aggregate `precommit-check` are now green. CI Step 185 is done, but the Run is **queued** for its next review; it has not completed.
- ATT-777-4 exhausted because a seeded admin required an existing authenticator code and signup returned HTTP 500. Fresh successor ATT-777-5 is **running** with `uiFixtureRecoveryVersion: 1` and `validationRecheckVersion: 1`. A source-backed option to seed a separate isolated user was steered to it; no browser verdict yet.
- ATT-893-3 is **running** its first compliance-review fixer. ATT-1098-3 has green PR CI but is **queued** after its old-snapshot validation omitted a locally failed plugin check. Its held steer requires that exact check to pass before completion.
- Tests for the new blocker handoff: eight focused delivery/replay integration cases, five agent blocker cases, and 119 workflow/UI-fixture cases passed with 59 expected skips. Daemon and SDK typecheck/lint passed. The installed archive passed isolated distribution smoke. No new live Run has completed all required work successfully.

## Earlier live recovery audit, 2026-09-26 11:26 UTC

- ATT-776-1 was historically marked `completed` even though its recap said the comment and closure were unverified. Its explanatory comment existed in Linear, but the issue was In Review. The issue was moved to Done and read back with `completedAt` set. The historical recap remains a record of the earlier incomplete handoff. New snapshots gate completion on a ready recap and confirmed Linear state; the project-neutral non-ready and old-journal replay tests pass.
- ATT-920-2 passed the previously failing setup replay and local test, lint, typecheck, build, seed and E2E commands. A CodeQL CI failure was repaired on PR #1888 and its rerun passed. The later `plugins` CI job failed in `audit-hooks.integration.spec.ts`: the stalled rotation dispatch test expected two audit records and got one. The old bounded CI excerpt lost this assertion after many warning matches. The new extractor was verified against the real job log and preserves it. The run is **queued** for its CI fixer; a steer with the exact failure evidence is held for the next agent turn. No successful CI repair has been observed.
- ATT-893-2 finished **exhausted** after nine independent UI checks passed and five remained blocked by missing fixtures/permissions and a plugin page. Fresh-snapshot successor ATT-893-3 is **queued** with UI fixture recovery enabled.
- ATT-1098-3 has repeatedly failed the configured local `attraccess/plugins` command on WAGO shell Jest timeouts. Its fixer reran narrower suites serially, and the next optional command selection omitted the failed configured check. New snapshots now force such checks back into the next validation round. This older run is **parked** at CI Step 300; PR #1886 checks passed except `containerize` still pending. A steer explicitly requires the exact failed local command to pass before completion. Green CI alone does not resolve the local failure.
- ATT-777-4 resumed its retained setup retry and is **running** an independent UI inspector at Step 140. ATT-764-5 is a fresh-snapshot successor to exhausted ATT-764-4 with `uiFixtureRecoveryVersion: 1` and is **running**. Neither has a successful final verdict yet.
- ATT-764-4 ended **finished/exhausted** at Step 84: the resource People route stayed loading and several role/header variants had no supported preview. The fresh-snapshot recovery path is installed, but has not yet been live-verified in ATT-764-5.
- Local `concurrency.maxRuns` was reduced from 3 to 1 at 10:29 UTC because three parallel heavy repository runs coincided with a load average above 140 on an eight-core host. It was raised to 2 at 11:26 UTC after load fell below 3 to let two UI-heavy recovery runs progress. Monitor load as validation resumes. No run failure has been attributed to host load yet.
- Typecheck, daemon lint, project-neutral delivery/environment and replay tests, SDK contract tests, isolated distribution smoke, and all four GitHub PR checks passed for the current source. **No new live run has yet completed all required work successfully.**

## Prior verification and remaining uncertainty

- Environment integration: 38 tests passed, including blocked-fixture repair and both sides of its snapshot boundary. Workflow: 115 passed and 59 skipped; snapshot: 12 passed. Daemon typecheck and lint passed. Distribution smoke passed on isolated port 47625.
- New CI excerpt and validation recheck tests passed with four affected test files totaling 157 passed and 59 skipped. The real 181 KB ATT-920 job log was temporarily tested against the extractor: the bounded result retained the failed test name and `Expected length: 2` / `Received length: 1`. The temporary fixture was removed. The pre-change journal replay test still passes. Packaging and the isolated distribution smoke passed for the installed archive.
- ATT-764-3 and ATT-764-4 were **finished/exhausted**, not successful. ATT-764-5 is the first live attempt with the new blocked-fixture path.
- ATT-1089-4 exhausted after an external Kody Code Review failure reported no available upstream accounts. GitHub returned HTTP 404 to its check-run retry. The installed fix prevents repeating the refused request in **new** snapshots; ATT-1089-4 remains exhausted and its PR #1887 remains draft with failed CI.
- ATT-842-2 exhausted with real registration errors and missing controlled accounts, inboxes and issued links. This is not a Rocky success.

## Runtime locations and controls

Daemon `http://127.0.0.1:7625`, ingress 7626. Health `/api/health`; run list `/api/runs`; detail `/api/runs/ID` returns run, steps and controls. Filter output because full transcripts are large.

Run data: `~/.rocky/runs/ID`; frozen workflow: `snapshot/workflow.json`. Profiles: `~/.rocky/profiles`; clones: `~/.rocky/repos`; logs: `~/.rocky/logs/daemon.log`, `launchd.out.log`, `launchd.err.log`. Do not print credential files or full environment configuration.

Control requests require JSON and `Origin: http://127.0.0.1:7625`:

- `POST /api/runs/ID/retry-step`: `{expectedBoot, stepKey, requestId}`. Use the current retry control's step key and boot number.
- `POST /api/runs/ID/restart`: `{expectedBoot, requestId}`. Latest failed/exhausted run only; returns successor with current workflow snapshot and hydrated ticket context. Old journal remains intact.
- `requestId` is a UUID. Save payload before sending and reuse it after uncertain transport results; do not create duplicate successors.

Latest retry payload: `/tmp/rocky-durable-retry-ATT-764-5.json`. Recent restart payloads: `/tmp/rocky-durable-restart-ATT-777-4.json`, `/tmp/rocky-durable-restart-ATT-764-4.json`, and `/tmp/rocky-durable-restart-ATT-893-2.json`. Temporary files are conveniences and may disappear.

## Diagnostic sequence for another failure

1. Refresh **all latest ticket attempts**, then inspect failing run details, final journal receipts, agent diagnostics and current PR/CI evidence. Distinguish failed, exhausted, parked, queued and completed.
2. Check snapshot versions before assuming new workflow paths apply. Old runs do not gain inserted steps merely because the daemon was upgraded.
3. Reproduce the failure in a project-neutral regression. Trace failed CI logs to the fixer and real repository checks; ensure CI repair remains reachable despite review exhaustion.
4. For UI fixture failures, inspect `Prepare UI fixtures`, `UI fixture readiness`, source-before/after and inspector receipts. A reachable server or preparer claim is not a visual pass. External credentials/permission remain explicit blockers.
5. Fix the shared cause, test old journal replay and applicable recovery bounds, package/install, then verify with a fresh snapshot when required. Do not claim queue admission as successful delivery.
6. Verify storage, Docker and auth only when evidence warrants it. OrbStack was started during prior recovery; auth worked then but can expire. Never interpret stale daemon stderr as a current process failure without checking timestamps/PIDs.

Fixture implementation: `packages/daemon/src/flow/ui-fixtures.ts`, `flow/delivery.ts`; regression integration: `environment/ensure.spec.ts`; snapshot migration: `run/snapshot.ts`; settings: `packages/local-contracts/src/flow.ts`.

Potential follow-up edges to investigate only if reproduced: setup failures currently propagate out of the three-pass helper; manual dependency denial throws before provisioning. The source guard fingerprints tracked changes, not untracked fixture files. Readiness receipts validate file/provenance boundaries; independent browser inspection remains responsible for actual visual correctness.

## Build and local installation

Use Node 24.19.0 from `/Users/jappy/.nvm/versions/node/v24.19.0/bin` first in PATH; set `NX_DAEMON=false NX_SKIP_REMOTE_CACHE=true`. Run relevant checks before packaging.

```sh
pnpm --dir packages/cli pack --pack-destination /Users/jappy/code/jappyjan/rocky/dist/tarballs
ROCKY_DISTRIBUTION_PORT=47625 pnpm test:distribution
```

Tarball: `dist/tarballs/rocky-0.2.0.tgz`. Install this local archive, not the public npm package, into both prefixes `/opt/homebrew` and `/Users/jappy/.nvm/versions/node/v24.19.0` using `npm install --global --prefix PREFIX --ignore-scripts --no-audit --no-fund ARCHIVE`.

Existing `/tmp/rocky-install-fixed.sh` stops ingress and daemon LaunchAgents, installs both, and restores services via an EXIT trap. Inspect it before reuse. LaunchAgents live under `~/Library/LaunchAgents/com.digimondo.rocky{,.ingress}.plist`, launchctl domain `gui/$(id -u)`. Preserve ExitTimeOut=60, allow owned workers to stop and planned-shutdown markers to flush. Avoid API mutations during restart. Verify health, actual listener process and installed archive bytes afterward.

Recent logs: `/tmp/rocky-fixtures-{final-integration,final-checks,distribution,pack,install}.log` and `/tmp/rocky-fixtures-tests.log`.

## Workspace cleanup and remembered product decisions

Cleanup requires clean work and HEAD proven on a remote branch; failed runs retain repositories for retry. Preserve screenshots/root evidence and unknown paths. Recognized orphan package caches may be reclaimed. Periodic cleanup retries every five minutes. Free-disk admission defaults to 5 GiB; queued work resumes automatically after recovery. Previous cleanup reclaimed roughly 30 GiB; recheck current free space.

ATT-1098 user decision: global system default language is chosen during first server setup; existing installations default to German. Attractap uses system language on unauthenticated screens and per-user language on authenticated screens. Refinement decisions must be posted to the ticket so later runs inherit them; do not ask the user to repeat recorded decisions.
