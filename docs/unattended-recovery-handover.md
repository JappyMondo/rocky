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

The previous installed commit was `4f2b173` (fixture screenshot write grant). New completion, replay and UI endpoint repairs are currently working changes on `fix/unattended-recovery`; inspect [the implementation notes](unattended-recovery.md). The new local `rocky-0.2.0.tgz` has SHA-256 `6953289b9ab9723ab746fabdd01635d2b0e715aeb61024ed8d0f635c80557ac7`. It passed the isolated distribution smoke test and was installed into both global prefixes. The installed `boot-child.js` hash matches the tarball in both prefixes (`3276693d5c0a9f84e924a4007abec4f1a7a717365984456a3bb3880ca9c715c5`); daemon health returned OK. Draft PR [#51](https://github.com/JappyMondo/rocky/pull/51) still pointed at the previous commit when this paragraph was written; refresh its head and CI before claiming review readiness.

Important recent commits:

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

The main checkout was clean at the previous handover; the changes above are now in progress here. The original `/Users/jappy/.t3/worktrees/rocky/t3code-48f9ab53` checkout had no commits missing from the recovery branch at that time.

## Live recovery audit, 2026-09-26 10:02 UTC

- ATT-776-1 was historically marked `completed` even though its recap said the comment and closure were unverified. Its explanatory comment existed in Linear, but the issue was In Review. The issue was moved to Done and read back with `completedAt` set. The historical recap remains a record of the earlier incomplete handoff. New snapshots gate completion on a ready recap and confirmed Linear state; the project-neutral non-ready and old-journal replay tests pass.
- ATT-920-2 exposed a second replay edge during live retry: calling an empty background command still restarted that Step and failed. The revised runtime reuses the old successful background receipt at the same sequence. Retry selection now points to Step 10 before its waiting fixer Step 144. A live retry of Step 10 on Boot 119 recorded a successful setup receipt, reran `attraccess/verify-runtime`, and reached the compliance-reviewer fixer at Step 144. It is **running**, not recovered yet.
- ATT-893-2 was retried at Step 118 after installing the endpoint binding repair. The UI inspector is running on Boot 130. No passing independent sweep has been observed yet.
- ATT-764-4 was retried at Step 70 after adding the missing validation responsibility handoff. Fixture preparation is running on Boot 4. No complete fixture set or inspector result has been observed yet.
- Typecheck, daemon lint (0 errors), 153 targeted delivery/environment tests, 84 Linear/snapshot tests, 78 replay/retry tests, SDK contract tests, and isolated distribution smoke test passed for this change set. Live acceptance remains pending for the three retries above.

## Prior verification and remaining uncertainty

- Fixture helper, environment integration, snapshot and workflow regressions passed. Final expanded environment integration: 35 tests passed, including source-change revalidation and old/new journal replay.
- Daemon typecheck/lint passed (lint: 0 errors, 78 existing warnings). Latest focused agent/fixture regressions: 45 passed; the union-result and screenshot-grant tests were red before their fixes. Web coverage passed at 93.84% functions against 93.77% required. Local packaged distribution smoke test passed on isolated port 47625.
- Both installed distributions matched the tested tarball's main and boot child bytes and contain the new version flag. Daemon health returned OK after restart. Browser UI has not been rechecked in this update.
- ATT-764-3 was **finished/exhausted**, not successful. It reached real UI states but lacked repeatable fixtures for some planned variants. Its published clean worktree was removed safely; root screenshot evidence was retained.
- **ATT-764-4** has `settings.uiFixtureVersion: 1`. Its first preparation retry exposed the union-result bug; the second exposed the missing screenshot grant. After both installed fixes, its retained Step 57 returned `setup` for configured `attraccess/seed-ui`. Host `install` and `seed-ui` exited 0; runtime and browser capabilities reverified. It is now running `Prepare UI fixtures 1/attraccess/web/2` at Step 70. The agent reached the seeded login but reported a browser command stall. **No complete fixture set or independent inspector result has yet been demonstrated.** Inspect the eventual Step 70 receipt before claiming success.
- **ATT-893-2** failed during UI inspection after its recorded frontend URL `localhost:4201` displayed a different app. The later listener on port 4201 belonged to ATT-777-4. This suggests an endpoint ownership or service-lifecycle problem after maintenance, but the exact mechanism is unproven. Preserve its retained workspace and journal; establish a project-neutral repro before another runtime fix or retry.
- ATT-1089-4 exhausted after an external Kody Code Review failure reported no available upstream accounts. GitHub returned HTTP 404 to its check-run retry. Rocky repeated that refusal through 15 fixer attempts. The installed fix prevents this loop in **new** snapshots; ATT-1089-4 remains exhausted and its PR #1887 remains draft with failed CI. Do not treat local validation as a pass or restart it until there is a useful recovery path for the provider failure.
- Latest live sample: ATT-764-4 and ATT-1098-3 running; ATT-1079-4 and ATT-777-4 parked; ATT-842-2 and ATT-1089-4 finished/exhausted; ATT-893-2 failed as above; ATT-920-2 failed with `EnvironmentBlocked` after a previously verified `attraccess/install` failed on a later Boot; ATT-776-1 completed. Parked does not inherently mean failed; inspect its controls/checkpoint. Historical failed attempts remain visible until settled.

## Runtime locations and controls

Daemon `http://127.0.0.1:7625`, ingress 7626. Health `/api/health`; run list `/api/runs`; detail `/api/runs/ID` returns run, steps and controls. Filter output because full transcripts are large.

Run data: `~/.rocky/runs/ID`; frozen workflow: `snapshot/workflow.json`. Profiles: `~/.rocky/profiles`; clones: `~/.rocky/repos`; logs: `~/.rocky/logs/daemon.log`, `launchd.out.log`, `launchd.err.log`. Do not print credential files or full environment configuration.

Control requests require JSON and `Origin: http://127.0.0.1:7625`:

- `POST /api/runs/ID/retry-step`: `{expectedBoot, stepKey, requestId}`. Use the current retry control's step key and boot number.
- `POST /api/runs/ID/restart`: `{expectedBoot, requestId}`. Latest failed/exhausted run only; returns successor with current workflow snapshot and hydrated ticket context. Old journal remains intact.
- `requestId` is a UUID. Save payload before sending and reuse it after uncertain transport results; do not create duplicate successors.

Latest restart payload: `/tmp/rocky-fixtures-restart-ATT-764-3.json`. Temporary files are conveniences and may disappear.

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
