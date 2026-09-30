# Rocky Next recovery handover — 2026-09-30

Resume from the user's selected checkout `/Users/jappy/code/jappy/rocky`, branch exactly `rocky-next`. Taskbot project `rocky-next` is the work-state authority; read epic #1 and tickets #8, #13, #113, #115 before changing anything. Root owns ticket transitions and independent acceptance. New dispatches use `gpt-6.1-sol` under the routing table in [the orchestrator prompt](rocky-next-orchestrator-prompt.md). Keep one explicit mutation lease.

## Integrated scope

The recovered operator application is present at original commit `a7e1291`. Recovery commits were applied in order:

| Original  | Integrated | Scope                                                            |
| --------- | ---------- | ---------------------------------------------------------------- |
| `9721e7f` | `5444ac4`  | OpenCode S1–S6 hardening and bounded native evidence             |
| `07b8ebf` | `1d17dcc`  | Supervisor and lease-observation regressions                     |
| `bfef407` | `7a74b10`  | Observation-only stale-owner waits and follow-up native evidence |

`1a49d6e` completes the current-head ATT-764 recipe and portable archived inventory regression. `7fe30bb` connects setup and checks to the operator workflow, freezes the validated authority/runtime/target, preserves scoped repository instructions, rejects out-of-scope copies, and fences cancellation. `0ecadb5` records the user model override. The subsequent handover commits add the target conventional commit/PR title, signed commits using the workspace's configured host identity, verified preferred binary discovery, and current native-evidence documentation.

All 13 original WIP files were preserved in private backup `/Users/jappy/.rocky-next-integration-20260930/original-wip/`, with SHA256 manifest beside it. Protected `acceptance/**` remains unchanged. No target source edits, paid model turns, target remote writes, service replacement, or live authority provisioning were performed.

## Checks and review instance

Node `24.16.0` and npm `11.13.0` are installed and used. Typecheck/build passed; the focused current/operator/runner/OpenCode check passed 39/39 before the final title/signing change. Both exact frozen source inventory digests were recovered from 3,468 actual blobs of official upstream commit `afa58e8a5eadfb340f317e6ec3227af0cf9b6c54`. The provenance regression retains both pinned digests and all its drift assertions. Runtime archived checkout/history/blob verification remains separate and intact.

Integration completed three consecutive gates on clean `d35c528`: each reported 413 tests, 412 passed, no failures, and one existing browser skip. Their authoritative results and build/package identity are in `/Users/jappy/.rocky-next-integration-20260930/evidence/check-summary.json`; logs use `full-2.log`, `full-3.log`, `full-4.log`. `full-1.log` tests the earlier `0ecadb5` artifact and is not one of those final gates. All artifact-root variables select private `artifacts/` under that same scratch root.

The owned review daemon will use `/Users/jappy/.rocky-next-review-20260930`, a free `127.0.0.1` port, and no `authority.json` or live OpenCode authentication. Its exact PID/URL live in that home's `daemon.json`; private `evidence/review-instance.json` binds them to the packaged build identity. Root must inspect that instance and arrange independent fixed-revision Standards/Spec review. During that review, the mutation owner may write ignored check evidence only; source/docs/tests remain frozen until reviewers stop and root transfers the lease.

Taskbot #117 repairs the independent `d35c528` findings: acknowledged merge requests with read-only later reconciliation, fenced/revision-aware projections that preserve cancellation and sent-effect receipts, stable ATT-764 issue admission with explicit quiescent/reconciled predecessor reruns, CI attempt identity and approval/merge bundle rechecks, and active-owner setup rejection with orphan-only startup recovery. The nine original failed-before scenarios are retained in `/Users/jappy/.rocky-next-repair-117-20260930/evidence/red.log`; strengthened focused, final typecheck/build/full-suite/package results and exact final identities belong in that directory's `check-summary.json`. Inspect that actual artifact before accepting the repair. Its source remains frozen for independent re-review after handoff. The explicit rerun action and truthful merge-status refresh are narrow UI changes; guided review #114 remains pending.

Independent review rejected candidate `9c85e426a56497ad902f9a94f200d5f03df2114f` despite its green full suite. Its tests/package and exact identities remain preserved in `check-summary-rejected-9c85e42.json`. A new source window repairs cancelled local/native action settlement and a production GitHub workflow-attempt change during the final status await. All four actual-process/SQLite/production-collector regressions failed against that unchanged candidate in `red-settlement-9c85.log`; the repaired source retains exact native usage, applies proven quiescence before stopping further work, and rereads CI identities after collecting all results. Current final verification and independent acceptance remain in the actual summary and Taskbot #117, not the rejected candidate's green logs.

## Remaining gates and next actions

1. Inspect final test/build/package evidence and independent review; repair actionable findings under a new explicit source-mutation window. Local green tests do not complete the MVP.
2. Choose the current target base before running heavy Attraccess setup. The retained current checkout was `b76da498`; root's read-only GitHub observation found later main `1959c870`. Confirm ATT-764 still applies to the selected base, then prepare and verify that exact head. The Docker/browser recipe has not been executed by this recovery session.
3. The approved OpenCode `1.18.33` identity (`139ddeb6a46ba276827bb8f79c7b28208621746e4fd6914d9ae71cc1a0a57524`, 144800738 bytes) was restored exactly at `/opt/homebrew/Cellar/opencode/1.18.33/bin/opencode` and verified in #4 comment 1079. Existing binaries/symlinks remain preserved. Installation does not provision auth or establish native/live qualification.
4. Obtain accepted bounded live authority, credential-boundary decision and execution qualification; the user provisions authentication into the dedicated data home using the reviewed login procedure. Rocky does not read/copy/proxy OpenCode auth. Native evidence proves empty export and error-envelope observations only. Billable stream/assistant-usage shapes and effective role rosters still need first-#14-live evidence before accepted live admission.
5. Confirm actual target signing and GitHub delivery behavior. The current target ruleset requires signed commits, conventional headers, required checks, thread resolution and a merge queue. Local signing uses a disposable test key; target-side verification and queue behavior remain live gates. GitHub must report confirmed merge before manual closeout.
6. Execute the authorized live proof-of-concept, retain failed attempts and exact build/commit identities, then apply the MVP completion gate in the orchestrator prompt. Broader benchmarks, automatic CI repair and Linear automation remain deferred.

Operate with [docs/operating.md](docs/operating.md). Stop only this owned review instance with the same `ROCKY_NEXT_HOME`; preserve its state and evidence for review.
