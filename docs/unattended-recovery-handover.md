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

Runtime commit installed and byte-verified in both global locations: `e2d9106` (bounded CI retry refusal). All recovery commits are on `fix/unattended-recovery`; inspect its history and [the implementation notes](unattended-recovery.md).

Important recent commits:

- `e2d9106`: classify GitHub check-run retry HTTP 404 and stop repeating the same refused request after fixer review on new snapshots; preserve old-journal replay.
- `467a6eb`: versioned UI fixture preparation before inspection, exact planned-check coverage, source provenance, relative URLs, screenshot evidence, bounded setup/recheck, source changes return through validation.
- `540ae24`: per-ticket cleanup locking so long removal does not block unrelated controls.
- `df2657c`: safe published workspace/cache cleanup, free-disk admission guard, authorized environment repair command IDs.
- `5ac0cc1`: configured host validation handoff when agent sandbox cannot run a command.
- `f990ab1`: transient service recheck polling and 60-second launchd shutdown grace.
- `d53e482`, `b040c86`: same-session maintenance continuation and planned shutdowns excluded from crash-loop accounting.
- Earlier commits cover refinement comments/prior answers, fresh-snapshot restart, CI retry SHA synchronization, worktree adoption, service provisioning for validation/recaps, settled runs and ticket grouping.

Both main checkout and the original `/Users/jappy/.t3/worktrees/rocky/t3code-48f9ab53` checkout were clean at handover. The original worktree branch has no commits missing from the main recovery branch.

## Latest verification and remaining uncertainty

- Fixture helper, environment integration, snapshot and workflow regressions passed. Final expanded environment integration: 35 tests passed, including source-change revalidation and old/new journal replay.
- Daemon typecheck/lint passed (lint: 0 errors, 78 existing warnings). CI/workflow/SCM/snapshot regressions: 176 passed, 55 skipped; the new refusal test was red before the fix and passed afterward. Local packaged distribution smoke test passed on isolated port 47625.
- Both installed distributions matched the tested tarball's main and boot child bytes and contain the new version flag. Daemon health returned OK after restart. Browser UI has not been rechecked in this update.
- ATT-764-3 was **finished/exhausted**, not successful. It reached real UI states but lacked repeatable fixtures for some planned variants. Its published clean worktree was removed safely; root screenshot evidence was retained.
- Restart created **ATT-764-4**, with `snapshot/workflow.json` containing `settings.uiFixtureVersion: 1`. It remains queued. **No live end-to-end fixture-stage success has yet been demonstrated.** Observe its actual preparation and inspector results when admitted.
- ATT-1089-4 exhausted after an external Kody Code Review failure reported no available upstream accounts. GitHub returned HTTP 404 to its check-run retry. Rocky repeated that refusal through 15 fixer attempts. The installed fix prevents this loop in **new** snapshots; ATT-1089-4 remains exhausted and its PR #1887 remains draft with failed CI. Do not treat local validation as a pass or restart it until there is a useful recovery path for the provider failure.
- Latest live sample after installation: ATT-764-4 queued; ATT-777-4, ATT-893-2 and ATT-842-2 running; ATT-1079-4, ATT-920-2 and ATT-1098-3 parked; ATT-1089-4 finished/exhausted; ATT-776-1 completed. Parked does not inherently mean failed; inspect its controls/checkpoint. Historical failed attempts remain visible until settled.

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
