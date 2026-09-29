# Taskbot #97 handoff checks — Claude Code CLI harness adapter + harness-neutral agent seam

## Environment

- Worktree: `/Users/jappy/.t3/worktrees/rocky/rocky-next`, branch `rocky-next`.
- Baseline HEAD: `0c7cb84408063395b9f39d981d22dabc9d9ca294` (clean tree at start; verified).
- Node: v24.16.0 (pinned `.nvmrc`; PATH exported to `$HOME/.nvm/versions/node/v24.16.0/bin`).
- Build id (post-change): `4fcf49380078c5fc489bb1662a18fe930dfab33e1a0902e4e9ee6bad4c1e4474`
  (sourceCommit 0c7cb84, sourceDirty true pre-commit; see `build.log`).
- Baseline build id (pre-work): `bd90efa0640015af925fc400380b1041c1e63dac647f7c4a74cba518742687fd`.
- Executing model: qwen3.8-max (substitution recorded by root dispatch #97/920; routing assigned
  claude-opus-5-5).

## Commands and results

| Command | Result | Log |
| --- | --- | --- |
| `git rev-parse --show-toplevel` / `git branch --show-current` / `git rev-parse HEAD` | worktree / `rocky-next` / `0c7cb84…` as required | (session record) |
| `npm run build` (baseline, pre-work) | exit 0, buildId bd90efa0… | `baseline-build-prework.log` |
| `npm test` (baseline, pre-work) | 302 tests / 300 pass / **1 fail** / 1 skipped — the failure is `tests/runner.test.mjs` F08 "worker SIGKILL triggers supervised cleanup after expiry", a pre-existing timing race at the untouched baseline (recover-vs-finish window). Standalone rerun of the same file at baseline: 6/6 pass, confirming flake, not regression. | `baseline-test-prework.log` |
| `node --test --test-concurrency=1 tests/runner.test.mjs` (baseline flake probe) | 6 tests / 6 pass / 0 fail | (session record) |
| `npx tsc --noEmit` (Node 24.16.0, post-change) | exit 0, no diagnostics | `typecheck.log` |
| `npm run build` (post-change) | exit 0, dist refreshed, buildId 4fcf4938… | `build.log` |
| `npm test` (post-change full suite, verbatim TAP retained) | **334 tests / 333 pass / 0 fail / 1 skipped** (skip pre-existing); exit 0. New: 32 adapter tests (9 launch + 11 protocol + 12 lifecycle). The baseline-flaky runner F08 passed in this run. | `test-full.log` |
| `npx prettier --check` on every touched/new file | "All matched files use Prettier code style!", exit 0 (after `--write` on 16 files; full suite re-run green after the reformat) | `prettier.log` |
| `git diff --check` | clean (no whitespace errors) | (session record) |
| `git status --porcelain` | only owned paths: `src/agents/seam.ts`, `src/agents/claude-code/**`, narrow edits `src/runner/{index,gate,duplex,process}.ts`, `src/store/index.ts`, `src/index.ts`, tests `tests/claude-code-*.mjs` + `tests/fixtures/claude-code-fake-cli.mjs`, docs `docs/claude-code-adapter.md` (new) + `docs/duplex.md` (factual touch). No `acceptance/**` change. | (session record) |
| `shasum -a 256` over new/touched src, test, fixture and doc files | 26 entries | `evidence.sha256` |

## Test-artifact retention

Adapter tests retain real SQLite stores, raw stream logs and per-run receipts under
`.qualification/claude-code-97/artifacts/**` (default root; `CLAUDE_ARTIFACT_ROOT` overrides) and
per-action RUN trees under owned `mkdtemp` directories in the system temp dir (required: the
staged tree and every ancestor must be free of `.git`/`CLAUDE*.md`/`AGENTS.md`/`.claude`/`.mcp.json`,
which the repository worktree itself cannot satisfy).

## Evidence class and forbidden-path compliance

- All adapter evidence is `owned-fake-cli`: a synthetic Node script fixture
  (`tests/fixtures/claude-code-fake-cli.mjs`) wrapped into an executable pinned-identity file at
  test time. The real `claude` binary was never executed (no subcommand, not even `--version`);
  `~/.claude`, `.credentials.json`, keychain contents and env secret VALUES were never read or
  logged (forbidden-env handling is names-only); no network or model/API calls; frozen
  `acceptance/**` files were read only and are byte-identical (`git status` proves no modification);
  prior `.qualification/**` directories were not touched (new artifacts live under
  `.qualification/claude-code-97/` only).
- Live subscription qualification (L01–L04) was NOT attempted: it is a separate root-granted step
  requiring explicit user authorization. Synthetic-native qualification (N01–N06) likewise remains
  separately authorized. The adapter ships no approved qualification binding; production admission
  stays unavailable until one is independently approved.

## Post-commit revalidation

- Commit: `c5c1f44782fb8e2dc6a9d886a1f80c0e983e1f6b` (one clean commit on `rocky-next`, parent
  `0c7cb84408063395b9f39d981d22dabc9d9ca294`); `git status --porcelain` empty afterwards.
- `npx tsc --noEmit` post-commit: exit 0.
- `npm run build` post-commit: exit 0, sourceCommit `c5c1f44…`, sourceDirty **false**, buildId
  `a763026afa6ff400890f0f5a9f8eefa522d8cf7924a9f87ec5a5e721eb04907a` (`build-postcommit.log`).
- `npm test` post-commit (verbatim TAP retained): **334 tests / 333 pass / 0 fail / 1 skipped**
  (skip pre-existing), exit 0 (`test-full-postcommit.log`).
- `evidence.sha256` covers the committed bytes of every new/touched src, test, fixture and doc
  file (computed pre-commit; the commit did not alter file contents).

## Repair phase (post-review #101)

Implementation was ACCEPTED by both reviewers with zero blocking findings; this phase touched no
logic, no `src/**`, no `acceptance/**` and no test assertion. Baseline for the repair: commit
`c5c1f44782fb8e2dc6a9d886a1f80c0e983e1f6b`, clean tree (verified). Exactly three repairs:

1. **Evidence durability** (review suggestion 1, precedent #90/#93/#95/#99): the small files under
   `.qualification/claude-code-97/` are force-added (`git add -f`) past the `.gitignore` rule —
   typecheck.log, build.log, build-postcommit.log, test-full.log, test-full-postcommit.log,
   prettier.log, baseline-build-prework.log, baseline-test-prework.log, evidence.sha256,
   handoff-checks.md — plus this phase's repair-typecheck.log, build-postcommit2.log,
   repair-test-full.log and repair-prettier.log. `artifacts/**` (bulky per-run SQLite stores and
   raw stream logs) is deliberately NOT committed and remains on-disk only, per the same
   precedent.
2. **Docs gaps** (standards finding F-2): `docs/claude-code-adapter.md` honest-limitations now
   records the two gaps previously only in Taskbot comment 921 — (a) C5 mid-run binary-drift has
   detection code and settlement-time measurement but no e2e mutation test (C1 drift is
   e2e-tested; C5 logic covered by the drift-comparison path; follow-up #102), and (b) real
   ~225 MB binary hash performance is untested (`measureBinaryIdentity` buffers the whole file
   and hashes at C0/C1/C5, C1 inside the guarded-start transaction); chunked hashing plus
   measurement required before native/live qualification (follow-up #102).
3. **Test-ID disambiguation** (spec suggestion 7): header comment added to
   `tests/claude-code-lifecycle.test.mjs` noting its adapter lifecycle IDs L01–L12 are NOT the
   frozen contract's live-subscription scenarios L01–L04 in
   `acceptance/claude-code/scenarios.json`, which remain unexecuted. Comment-only; no rename, no
   assertion changed.

Repair-phase checks (Node v24.16.0, PATH exported):

| Command | Result | Log |
| --- | --- | --- |
| `npm run typecheck` | exit 0 | `repair-typecheck.log` |
| `npm run build` | exit 0, dist refreshed, buildId `fe1dcc1f50a6052c89f47585773a4313b428124fad2f2b1d429aa62a0e932b68` (sourceCommit `c5c1f44…`, sourceDirty true — the two repair edits were uncommitted at build time) | `build-postcommit2.log` |
| `npm test` (full suite) | **334 tests / 333 pass / 0 fail / 1 skipped** (skip pre-existing), exit 0 | `repair-test-full.log` |
| `npx prettier --check` on the two touched files | All matched files use Prettier code style!, exit 0 | `repair-prettier.log` |
| `git diff --check` | clean | (session record) |

`evidence.sha256` update: the file hashes the 26 delivered src/test/fixture/doc files and has no
note convention (pure `shasum` lines), so the two entries whose bytes changed in this phase were
recomputed honestly in place — `docs/claude-code-adapter.md` and
`tests/claude-code-lifecycle.test.mjs`; the other 24 entries are untouched. `shasum -a 256 -c`
over all 26 entries: every file OK.
