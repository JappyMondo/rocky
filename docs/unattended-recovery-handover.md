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

Commits `23f80bd` and `0cd1e37` on `fix/unattended-recovery` contain the completion gate, retained-run replay repairs, current UI endpoint binding and blocked-fixture recovery. See [the implementation notes](unattended-recovery.md). The local `rocky-0.2.0.tgz` has SHA-256 `eb77d33ecc7bae6200b656cb6f6684d933424e0d5de511ab0af9ccd41dbe8324`. It passed the isolated distribution smoke test and was installed into both global prefixes. Both installed `dist/main.js` files have SHA-256 `b8b72b24948f3ba8ea05dba2c8fa6027fa132258fc477a354b85b8743a5d08b2`, matching the archive. Daemon health returned OK. Draft PR [#51](https://github.com/JappyMondo/rocky/pull/51) had all four checks green on `0cd1e37` at 10:28 UTC. This is not live end-to-end acceptance.

Important recent commits:

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

The main checkout was clean after the two pushed commits. The original `/Users/jappy/.t3/worktrees/rocky/t3code-48f9ab53` checkout had no commits missing from the recovery branch at the previous handover.

## Live recovery audit, 2026-09-26 10:30 UTC

- ATT-776-1 was historically marked `completed` even though its recap said the comment and closure were unverified. Its explanatory comment existed in Linear, but the issue was In Review. The issue was moved to Done and read back with `completedAt` set. The historical recap remains a record of the earlier incomplete handoff. New snapshots gate completion on a ready recap and confirmed Linear state; the project-neutral non-ready and old-journal replay tests pass.
- ATT-920-2 passed the previously failing setup replay and local test, lint, typecheck, build, seed and E2E commands. It reached CI; a CodeQL alert failed, and the CI fixer is running at Step 161. This is **running**, not recovered.
- ATT-893-2 was retried at Step 118 after installing the endpoint binding repair. Its UI inspector is actively using the current browser endpoint and remains **running**. No passing independent sweep has been observed yet.
- ATT-1098-3 passed the previously failing setup replay and is **running** `Validate attraccess/plugins` at Step 220.
- ATT-777-4 has an accepted retained retry at its failed setup Step 10 and is **queued**. ATT-764-5 is a fresh-snapshot successor to exhausted ATT-764-4 with `uiFixtureRecoveryVersion: 1`; it too is **queued**. Neither queued run is a recovery result.
- ATT-764-4 ended **finished/exhausted** at Step 84: the resource People route stayed loading and several role/header variants had no supported preview. The fresh-snapshot recovery path is installed, but has not yet been live-verified in ATT-764-5.
- Local `concurrency.maxRuns` was reduced from 3 to 1 at 10:29 UTC because three parallel heavy repository runs coincided with a load average above 140 on an eight-core host. Existing active runs continue; the lower limit only controls later admission. No run failure has been attributed to host load yet.
- Typecheck, daemon lint, project-neutral delivery/environment and replay tests, SDK contract tests, isolated distribution smoke and all four GitHub PR checks passed for the current source. **No new live run has yet completed all required work successfully.**

## Prior verification and remaining uncertainty

- Environment integration: 38 tests passed, including blocked-fixture repair and both sides of its snapshot boundary. Workflow: 115 passed and 59 skipped; snapshot: 12 passed. Daemon typecheck and lint passed. Distribution smoke passed on isolated port 47625.
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
