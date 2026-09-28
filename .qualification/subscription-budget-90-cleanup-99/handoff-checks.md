# Taskbot #99 handoff checks (post-review cleanup of #90/#91)

Baseline commit: c6a47073f3103fa604067aef1d746cf99dc0354f. Branch: rocky-next.
All checks run with pinned Node v24.16.0 (scripts/build.mjs refuses other versions).

## What was inherited vs finished

The predecessor's tree already contained items 1-5 (COORDINATOR_SCHEMA removal,
docs schema-8 + recovery_required wording, schema7->schema8 test-title renames,
reducer overflow-check removal with safety comment, isAgentWork-keyed dispatch
qualification check, and new tests SB11/SB12). Verified each; no source changes
were needed.

SB12 was never proven green because the predecessor ran `npm test` against a
STALE `dist/index.js`: tests/coordinator-support.mjs imports
`../dist/index.js`, and `npm test` does not rebuild. The old compiled dispatch
code still keyed the qualification check on the row's (tampered, falsy)
qualificationId, so the tampered-row dispatch reached `transport.begin()`
(a never-resolving promise) and the test hung. Evidence of the hang:
`sb12-stale-dist-isolated.fail.log` (isolated TAP run, SB12 test-timeout after
60s; run under the shell-default Node v26 before the rebuild diagnosis).

Fix: `npm run build` under Node v24.16.0, then re-run. No test or source
assertions were weakened.

## Final results (this handoff)

- typecheck.log: `npm run typecheck` (tsc --noEmit), exit 0.
- prettier.log: `npx prettier --check` on the seven changed files, exit 0.
- test-full.log: verbatim `npm test` after rebuild: tests 302, pass 301,
  fail 0, cancelled 0, skipped 1 (pinned-browser launch test, pre-existing
  skip), duration_ms ~61.6s. SB12 passes in 17ms.
- prettier-full-repo.log (retained from predecessor): pre-existing repo-wide
  prettier failure on docs/rocky-next-concept.{md,html} and others; out of
  scope for #99, untouched.

Scratch debug file tests/zzz-sb12-debug.mjs deleted before commit.

## Repair phase (#99 repair, post-review, base 01f19144)

Two review findings fixed, docs/comment-only; no behavior, test or
acceptance/** changes:

1. Standards blocker: docs/coordinator.md line 13 still said "SQLite storage
   schema 5"; corrected to "storage schema 8" (matches src/store/index.ts
   PRAGMA user_version=8 and the 0..8 accepted range). The snapshot-schema
   wording and the rest of the sentence were left untouched and remain
   truthful (unknown versions fail closed; no silent upgrade).
2. Reviewer nit: src/coordinator/reducer.ts comment (~lines 350-356) claimed
   the harnessReportedTokens accumulator "cannot overflow". Tightened to cite
   the real guarantees: per-report validateHarnessUsage safe-integer bounds +
   usageStop threshold gating keep accumulation bounded in practice (a single
   enormous safe-integer report could still push the sum past
   Number.MAX_SAFE_INTEGER before the stop engages), and load/save-time
   validateSnapshot integer() revalidation (contracts.ts budgets pass, store
   #saveSnapshot) fails closed on any anomalous value.

Repair validation under pinned Node v24.16.0:

- repair-typecheck.log: `npm run typecheck`, exit 0.
- repair-build.log: `npm run build` (dist refreshed; buildId
  31f62c65...58110, sourceCommit 01f19144, sourceDirty:true as expected
  pre-commit).
- repair-test-full.log: `npm test` against the rebuilt dist: tests 302,
  pass 301, fail 0, skipped 1 (same pre-existing pinned-browser skip).
- repair-prettier.log: `npx prettier --check docs/coordinator.md
  src/coordinator/reducer.ts`, all files conform.

All prior logs retained unchanged.
