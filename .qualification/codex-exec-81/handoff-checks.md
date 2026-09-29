# Taskbot #81 handoff checks — direct Codex exec subscription harness adapter

## Environment

- Worktree: `/Users/jappy/.t3/worktrees/rocky/rocky-next`, branch `rocky-next`
  (verified `git rev-parse --show-toplevel` + `git branch --show-current` at start
  and before commit).
- Baseline HEAD: `84a699d9a4a07ace7dc66f11ab32bf433545112f` (clean tree at start;
  verified).
- Node: v24.16.0 (pinned; PATH exported to `$HOME/.nvm/versions/node/v24.16.0/bin`).
  npm 11.13.0. The build rejects any other Node (`scripts/build.mjs`).
- Baseline build id (pre-work): `cbd12f831eebb0a09dd1aa2eec296a44db01ffdb0e07dcb9108965a3ed4bede8`
  (sourceCommit 84a699d, sourceDirty false; `baseline-build-prework.log`).
- Post-change build id (pre-commit): `eda1ee5cf39adb474b570ca980f1e274ec3118ccd0107324f6950cfa2432717e`
  (sourceCommit 84a699d, sourceDirty true; `build.log`).
- Executing model: qwen3.8-max (substitution recorded by root dispatch #81/933;
  routing assigned gpt-6-astra/high → claude-opus-5-5 per #865; harness cannot
  select — executing on qwen3.8-max per #99/885 precedent).

## Commands and results

| Command | Result | Log |
| --- | --- | --- |
| `git rev-parse --show-toplevel` / `git branch --show-current` / `git rev-parse HEAD` | worktree / `rocky-next` / `84a699d…` as required | (session record) |
| `npm run typecheck` (baseline, pre-work) | exit 0, no diagnostics | `baseline-typecheck-prework.log` |
| `npm run build` (baseline, pre-work) | exit 0, buildId cbd12f83… | `baseline-build-prework.log` |
| `npm test` (baseline, pre-work) | **334 tests / 333 pass / 0 fail / 1 skipped** (skip pre-existing), exit 0 | `baseline-test-prework.log` |
| `npm run typecheck` (post-change) | exit 0, no diagnostics | `typecheck.log` |
| `npm run build` (post-change, pre-commit) | exit 0, dist refreshed, buildId eda1ee5c… | `build.log` |
| `npm test` (post-change full suite, pre-commit, verbatim TAP retained) | **376 tests / 375 pass / 0 fail / 1 skipped** (skip pre-existing), exit 0. New: **42 adapter tests** (12 launch + 16 protocol + 14 lifecycle). | `test-full-precommit.log` |
| `npx prettier --write` then `--check` on every touched/new file | "All matched files use Prettier code style!", exit 0 (full suite re-run green after the reformat) | `prettier.log` |
| `git diff --check` | clean (no whitespace errors) | (session record) |
| `git status --porcelain` | only owned paths: `src/index.ts` (export seam), `src/agents/codex-exec/**` (new), `tests/codex-exec-{launch,protocol,lifecycle}.test.mjs` + `tests/codex-exec-support.mjs` + `tests/fixtures/codex-exec-fake-cli.mjs` (new), `docs/codex-exec-adapter.md` (new). No `acceptance/**`, no `src/agents/claude-code/**`, no `src/coordinator`, no `src/runner`, no `src/store`, no `src/agents/seam.ts` change. | (session record) |
| `shasum -a 256` over new/touched src, test, fixture and doc files | 20 entries | `evidence.sha256` |

## Seam reuse (no fork)

The #97 harness-neutral seam (`src/agents/seam.ts`) and the existing
runner/gate/supervisor/Store duplex machinery absorbed every harness-neutral need.
This adapter adds **no** seam/runner/gate/supervisor/Store extension. The only edit
to existing code is `src/index.ts` adding
`export * from "./agents/codex-exec/index.js";` (the export seam, mirroring the
existing `agents/claude-code/index.js` export) so the adapter and its pure helpers
are reachable from the package entrypoint. `git status` proves no other existing
file changed; default behavior is byte-identical.

## Test-artifact retention

Adapter tests retain real SQLite stores, raw stream logs and per-run receipts under
`.qualification/codex-exec-81/artifacts/**` (default root; `CODEX_ARTIFACT_ROOT`
overrides) and per-action RUN trees under owned `mkdtemp` directories in the system
temp dir (required: the staged tree and every ancestor must be free of
`.git`/`.codex`/`.agents`/`AGENTS*.md`, which the repository worktree itself cannot
satisfy). The bulky `artifacts/**` are deliberately NOT committed (on-disk only),
per house precedent (#97 repair); the small evidence files (logs, `evidence.sha256`,
this `handoff-checks.md`) are force-added past the `.gitignore` rule.

## Evidence class and forbidden-path compliance

- All adapter evidence is `owned-fake-cli`: a synthetic Node script fixture
  (`tests/fixtures/codex-exec-fake-cli.mjs`) wrapped into an executable
  pinned-identity file at test time. The real `codex` binary was never executed (no
  subcommand, not even `--version`); `~/.codex/auth.json`, host auth bytes, keychain
  contents and env secret VALUES were never read or logged (forbidden-env handling
  is names-only; the shared `config.toml` is measured as a nonsecret sha256/size by
  the host and its content is never retained); no network or model/API calls; frozen
  `acceptance/**` files were read only and are byte-identical (`git status` proves no
  modification); prior `.qualification/**` directories were not touched (new
  artifacts live under `.qualification/codex-exec-81/` only).
- Native qualification (N01–N08) and live-subscription proof (L01–L02) were NOT
  attempted: they are separate root-granted steps. **Live codex qualification is
  blocked on OpenAI credits (external access gap, not a deferral)** per the user
  decision state in dispatch #81/933. The adapter ships no approved qualification
  binding and no loader; production admission stays unavailable until one is
  independently approved. `qualification=false`, `capability=null` are unchanged.

## Coverage gaps (documented, gated, never faked)

- The exact native exec-JSONL serde field names are an owned source-consistent
  interpretation of the pinned taxonomy (G-FRAME-SHAPE); the frozen contract pins
  the event/item names and rules, and the precise native frame shape is gated N06.
  Tests exercise the RULES against the owned fake, never a native claim.
- Effective config / tool roster / served model / applied effort are not observable
  in `exec --json` (G-OVERRIDES/G-MODEL/G-EFFORT); override exactness is
  producer-audited and TOML round-trip validated, native effectiveness gated N01/L01.
- Nonsecret auth account/mode classification is a separate harness-owned step with
  residual TOCTOU (G-AUTH/G7), not performed here; unknown auth/discovery/config
  stays `unavailable`, never a caller-approved boolean.
- Native writes into the shared CODEX_HOME despite overrides/ephemeral (G-WRITES/G4)
  and the reviewer `--image` transform/delivery (G-VISUAL/N08) remain gated.
- Every gap is restated as a receipt gap on every run (`codexReceiptGaps`).

## Post-commit revalidation

Recorded in the final handoff report and in on-disk-only logs under
`.qualification/codex-exec-81/` (`build-postcommit.log`,
`test-full-postcommit.log`) generated after the single clean commit; this
handoff-checks.md is committed once and is not edited after the commit.
