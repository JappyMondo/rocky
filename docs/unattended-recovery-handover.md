# Rocky reliability handover

Updated 2026-09-26. Continue durable fixes if further failures occur. Do not treat this handover as current run status; refresh the daemon first.

## Current checkpoint, 2026-09-26 17:40 UTC

- Rocky's generic SCM reader now flags a failed-target log with no recognized individual test failure or timeout and tells the CI fixer to inspect test reports or rerun the repository check if needed. The captured 815 KB `test` job log had no Jest failure summary; its GitHub failure annotation only reported exit 1, and the workflow run had no test-report artifact. The separate failed `plugins` job did contain an assertion and retains it without the note. No Attraccess source or Run was manually changed for this fix.
- A project-neutral regression first failed on the missing note, then passed. Four SCM, workflow and snapshot files passed 83 tests; daemon typecheck, lint and formatting passed. Temporary tests against both full captured job logs passed and were removed. The final wording narrows the note to recognized individual test failures and timeouts; the same 83 tests and formatting passed again. The final packaged archive SHA-256 is `5d44578128843f56dc1144e4b40dcd8764fdb8a3b56fb9fb87130e55a77bf42e`; its isolated distribution smoke passed on port 47625.
- The final archive was installed into both global prefixes. Their `dist/boot-child.js` hashes are `83603dc697ad6b4140ac15f8564003ddb6f21c7feaea4494ab8bef72a0b2b7ad`, matching the archive entry; both contain the final diagnostic note. Main and flow-runtime hashes remain as recorded below. Both LaunchAgents restarted, listener PID 84597 matched launchd, `/api/health` returned OK, and ATT-777-5 resumed on Boot 29. The earlier installer script was absent, so this installation used `/tmp/rocky-ci-gap-install.sh` with an EXIT restore trap.
- Latest statuses at that read: ATT-777-5 running UI fixture preparation, ATT-893-3 parked at current-head CI, ATT-764-5, ATT-1098-3 and ATT-920-3 queued. ATT-920-3 has not run under the new install. No complete unattended Run receipt exists. Keep Rocky PR #51 draft and re-read these statuses before reporting them later.

## Scope and operating rules

- Fix recurring failures in Rocky runtime, shipped workflow, or repository configuration. A repaired individual run is verification, not the deliverable.
- Discover repository instructions, commands, CI jobs and contribution rules at run time. Keep repository-specific policies out of generic Rocky prompts and logic.
- Build/install from `/Users/jappy/code/jappyjan/rocky`, branch `fix/unattended-recovery`. The user's main-checkout instruction concerns Rocky development/install; agents may use per-run worktrees.
- Preserve unrelated edits and all dirty/unpublished run work. Do not rewrite frozen snapshots or journals. Positional workflow changes need a version boundary and old-journal replay tests.
- Use `agent-browser` CLI for browser verification. Its documentation is `agent-browser skills get core --full`.
- Installation, safe daemon restarts and retry/replacement runs were authorized. Do not bypass merge approvals or fabricate successful validation.

## Code and installed state

The `fix/unattended-recovery` branch contains the completion gate, retained-run replay repairs, current UI endpoint binding, blocked-fixture recovery, stronger CI log excerpts, mandatory rechecks for previously failed configured commands, journal-safe fixture blocker handling, private UI fixture credential handoff, Docker context socket bridging, and committed CI repair reconciliation. See [the implementation notes](unattended-recovery.md). At the 17:03 UTC checkpoint, signed head `b9589ef` was packed into archive SHA-256 `47c993c37d8185f35bb656963e2b237e48adf795ff1bbedd49ff0b493c24af9b`, passed the isolated distribution smoke test, and was installed into both global prefixes. The later current checkpoint above supersedes that installation. The daemon and ingress LaunchAgents restarted; health is OK and listener PID matched launchd. Both installed `dist/main.js` files hash `2a8fd73fdf83e0a6e6e990c17810d86201e84c381af94970a7c921dab246b601`, both `dist/flow-runtime.js` files hash `2a933dc2c76d41b116df6f46d4f0d2f4b3a61cb6517b775471e8114c6b342c2d`; these stayed the same in the later archive. The earlier `dist/boot-child.js` hash was `2b4cb4f894c2d2c0719512bf83c1da5959b7d32bc061b00e3d6e9a7563f5f92c`. Do not infer installed code from the unchanged Rocky version number. This is not live end-to-end acceptance.

Important recent commits:

- `b9589ef`: a CI fixer that commits a locally checked repair but returns `unresolved` now has its branch reconciled before exhaustion on new snapshots. Changed heads return through configured validation and current-head CI; old journals retain their step sequence. The project-neutral workflow suite passed 117 tests with 61 expected skips, including new and pre-change replay cases.
- `8a79455`: bound UI fixture tool searches and require a truthful blocked handoff when unsupported previews cannot be produced.
- `2b2497b`: bridge a live Unix socket from the active Docker CLI context into configured commands when no default socket or explicit `DOCKER_HOST` exists. Project-neutral socket tests and 56 environment/command tests pass.
- `25ca6b6`: pass locally generated UI fixture credentials by a private Run file reference to the independent inspector, verify path and mode, and prohibit credential values in results. Forty-five focused UI recovery tests pass.
- `58ab0dd`: prioritize actual failed-test and timeout markers in bounded CI job excerpts. The real ATT-920 job excerpt now contains its timed-out test.
- `bfacc65`: detect a later interrupted configured install and rerun its matching setup probe in the same old journal Step before dependency verification; 111 environment and replay tests pass.
- `7d77c08`: refuse to save a ready recap when its own requirement list has a gap or unverified item.
- `6d3d11f`: refresh the handover after the host reboot.
- `86803fc`: keep diagnostic evidence outside Git worktrees so it cannot block pushes; this commit is signed and GitHub verified. The tree was packaged and installed before the signing amend.
- `ab9a950`: default to one concurrent Run to avoid overloading a typical local host; the local configuration also explicitly sets one.
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

## Handover correction, 2026-09-26 17:13 UTC

The user explicitly requires a **Rocky-only durable repair**. Stop manual repair, push, or retry of individual repository Runs. Use those Runs only as evidence and as unattended acceptance tests of Rocky's generic runtime, profile, and shipped workflow. I manually pushed ATT-920-2's retained signed Attraccess commit `36b2fac7` to draft PR #1888 while successor ATT-920-3 was queued. That was a single-run intervention and **does not verify** `ciUnresolvedCommitVersion: 1` live. The new current-head `test` job then failed in `api:test`; the available GitHub job log names the target but does not expose a clear Jest failure summary. `crap-score` was still pending at this checkpoint. A fresh agent should first improve Rocky's generic CI evidence/fixer path if needed, then let an unattended fresh-snapshot Run demonstrate recovery. Do not add Attraccess-specific checks or timeout policy to Rocky.

Rocky PR #51 at signed head `517e0e8` is still draft; all four current-head checks passed. Installed code remains `b9589ef` with archive and runtime hashes above; `517e0e8` changed only this handover. Local concurrency was lowered back to `maxRuns: 1` after two active repository Runs drove host load above 50. ATT-777-5 and ATT-893-3 were running; ATT-764-5, ATT-1098-3 and ATT-920-3 were queued. No new live Run had completed successfully. This checkpoint is deliberately not a claim that Rocky is autonomous yet.

## Live recovery update, 2026-09-26 17:04 UTC

- Signed `b9589ef` is pushed and installed. Daemon and ingress are healthy; the listener PID matches launchd and installed files match the tested archive. The full workflow suite, 12 snapshot tests, daemon and contracts typecheck/lint, formatting, and isolated distribution smoke passed. Rocky PR #51 remains draft; the current-head `check` job is pending while its other reported jobs passed.
- ATT-920-2 **finished/exhausted incorrectly** after its CI fixer made signed local commit `36b2fac7` and passed relevant local checks but reported `unresolved` because it could not push and observe future remote CI. The commit remains in its clean worktree, while Attraccess draft PR #1888 still points to older head `7316252` with failed CI. Fresh successor ATT-920-3 was accepted with `ciUnresolvedCommitVersion: 1` and is **queued**. Its new snapshot is a live verification opportunity, not proof the repair was delivered.
- ATT-777-5 resumed after the planned restart and is **running** its next UI fixture preparation after source validation. ATT-893-3 resumed and is **running** its compliance fixer; its current-head CI had passed, but a reviewer still found a manifest coverage gap. ATT-764-5 and ATT-1098-3 are **queued**. No new Run is fully complete. Local `concurrency.maxRuns` is 2; monitor host load.

## Live recovery update, 2026-09-26 16:35 UTC

- The packaged `2b2497b` build is **installed in both global prefixes**. Both LaunchAgents and the port 7625 listener match the new process; health is OK. The planned restart resumed ATT-764-5's retained fixture-preparer Step 140 in Boot 4.
- ATT-1098-3's configured plugin command returned exit 1 because Testcontainers could not find `/var/run/docker.sock` even though Docker CLI used OrbStack's context. Its fixer confirmed that the focused CC100 enrollment suite and the full plugin command pass with `DOCKER_HOST=unix://$HOME/.orbstack/run/docker.sock`; the run is now **parked** at current-head CI. Its old frozen snapshot omitted the failed plugin command on the next validation round, so the agent's manual full-command pass is the evidence, not a new Rocky validation Step. The Attraccess profile was patched through the revision-checked local API to supply that socket for future snapshots; the installed generic command runner discovers the active Unix context socket for other repositories too.
- ATT-893-3's current-head PR #1882 has **all GitHub checks green** and its CI wait Step is done, but Rocky has only queued its next stage. ATT-777-5's inspector retry and ATT-920-2's CI fixer remain **queued**. ATT-764-5 is **running** fixture preparation after the restart. No new live Run is fully complete.
- All four Rocky PR #51 checks passed on `25ca6b6`; checks on `2b2497b` are still running. Its archive passed isolated distribution smoke. Keep the PR draft until a complete live run supports delivery.

## Live recovery update, 2026-09-26 16:14 UTC

- ATT-777-5's preparer reached six browser states and captured screenshots, but the independent inspector could not access its generated fixture passwords. The run failed at inspector Step 62. A retry of that exact retained Step was accepted with the path to its existing private Run credential file; it is **queued**, not verified. The generic credential-file handoff in `25ca6b6` addresses the recurring workflow cause for future preparations. Do not print the file contents in reports.
- ATT-1098-3 is **running** the exact configured `attraccess/plugins` command at Step 321; it began at 16:04 UTC and has a 30-minute configured timeout. The WAGO shell suite is active. No exit-zero receipt exists yet. Delay the next Rocky install until this command finishes so its result is retained.
- ATT-893-3 is **parked** at current-head CI. The repository test, plugin, lint, and crap-score jobs passed; `containerize` is still running. ATT-920-2 is **queued** behind the active run with its failed CI evidence steered to the fixer. ATT-764-5 is **queued** at its retained setup retry.
- `25ca6b6` passed the 45 focused UI recovery tests, daemon typecheck, lint without new errors, formatting, signed push, and isolated distribution smoke. GitHub PR #51 checks are still pending on this head. **No new live Run has yet completed all required work successfully.**

## Live recovery update, 2026-09-26 15:46 UTC

- ATT-764-5 reached its bounded environment fixer after the fixture blocker. The fixer restored workspace links and passed 16 focused component tests, but correctly left several live browser states unverified. A planned daemon update interrupted its next `attraccess/install`; replay checked dependencies before resuming it and failed because `node_modules/.bin/nx` was absent. The configured bootstrap was run to completion, the worktree is clean, and the retained Step 95 retry was accepted and is **queued**. The `bfacc65` replay repair prevents that same order failure on future interrupted installs without inserting journal Steps.
- ATT-893-3's fixer added manifest-declared plugin page paths with focused tests. Its next configured local validation passed, and it is **parked** at current-head CI. ATT-777-5 is **running** review; ATT-1098-3 remains **queued** for its exact plugin command.
- ATT-920-2's current-head CI has two failed jobs. `test` names `api:test` without a Jest assertion in its job log. `crap-score` names `api:crap-score` and contains a concrete 30-second timeout in `apps/api/src/mcp/mcp-http.integration.spec.ts:302` under coverage; 2940 other API tests passed. Both job IDs and failure evidence have been steered to its CI fixer. The GitHub Actions run is still in progress on a container build, so Rocky remains **parked** at CI. No current-head green CI receipt exists.
- `bfacc65` passed daemon and SDK typecheck/lint, 111 environment and replay tests, focused recap tests, formatting, and isolated distribution smoke. The installed main, flow runtime and boot child bytes match that package; health is OK. **No new live Run has yet completed all required work successfully.**

## Live recovery update, 2026-09-26 15:24 UTC

- Bitwarden's SSH agent was locked after the reboot. The user unlocked it; `ssh-add -l` succeeded, the Rocky head was amended to a signed commit, pushed, and verified by GitHub. Signing is no longer the observed blocker.
- OrbStack had stopped after the reboot, so the full ATT-1098 plugin check could not start Testcontainers. `orbctl start` restored Docker, and `app.start_at_login` was enabled and read back. ATT-1098-3 is **queued** at retained Step 306 after eight untracked diagnostic logs were moved into its Run evidence directory. Its exact configured plugin command still needs an exit-zero receipt.
- ATT-764-5's fixture Step 84 returned a valid blocked result and is recorded **done**, not failed. This is live evidence that the new journal-safe result path works. It reached Step 85 for a bounded follow-up fixture attempt; missing supported component previews and request-failure browser states remain unresolved. No visual acceptance has been claimed.
- ATT-920-2 pushed signed, GitHub-verified Attraccess head `7316252` to draft PR [#1888](https://github.com/Attraccess/Attraccess/pull/1888). All configured local validation commands passed. Its current-head GitHub `test` job failed in `api:test`, while other checks were green or pending; the job log did not contain a concrete failing assertion. The Run is **parked** at its CI wait and has a held failure-evidence steer for the CI fixer. Do not treat the earlier green CI receipt as current-head proof.
- ATT-777-5 and ATT-893-3 have green current-head PR checks but remain **queued** before final review, UI verification, and handoff. No new live Run has completed all required work successfully.

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

Current `/tmp/rocky-ci-gap-install.sh` stops ingress and daemon LaunchAgents, installs both, and restores services via an EXIT trap. Inspect it before reuse; temporary scripts can disappear. LaunchAgents live under `~/Library/LaunchAgents/com.digimondo.rocky{,.ingress}.plist`, launchctl domain `gui/$(id -u)`. Preserve ExitTimeOut=60, allow owned workers to stop and planned-shutdown markers to flush. Avoid API mutations during restart. Verify health, actual listener process and installed archive bytes afterward.

Recent logs: `/tmp/rocky-fixtures-{final-integration,final-checks,distribution,pack,install}.log` and `/tmp/rocky-fixtures-tests.log`.

## Workspace cleanup and remembered product decisions

Cleanup requires clean work and HEAD proven on a remote branch; failed runs retain repositories for retry. Preserve screenshots/root evidence and unknown paths. Recognized orphan package caches may be reclaimed. Periodic cleanup retries every five minutes. Free-disk admission defaults to 5 GiB; queued work resumes automatically after recovery. Previous cleanup reclaimed roughly 30 GiB; recheck current free space.

ATT-1098 user decision: global system default language is chosen during first server setup; existing installations default to German. Attractap uses system language on unauthenticated screens and per-user language on authenticated screens. Refinement decisions must be posted to the ticket so later runs inherit them; do not ask the user to repeat recorded decisions.
