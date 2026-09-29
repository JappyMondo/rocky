# Taskbot #98 handoff checks — OpenCode CLI harness adapter (PoC)

## Environment

- Worktree: `/Users/jappy/.t3/worktrees/rocky/rocky-next`, branch `rocky-next`
  (verified `git rev-parse --show-toplevel` + `git branch --show-current` at
  start and before commit).
- Baseline HEAD: `48f434de5801df62f0a63b7a54e59c34d4dc516d` (clean tree at
  start; verified).
- Node: v24.16.0 (pinned; PATH exported to
  `$HOME/.nvm/versions/node/v24.16.0/bin`). The build rejects any other Node
  (`scripts/build.mjs`).
- Baseline build id (pre-work): `73f377234707998c4c063008f4001884c33240c3b78bfbc90ad5d89283de05e8`
  (sourceCommit 48f434d, sourceDirty false; `baseline-build-prework.log`).
- Post-change build id (pre-commit): `ca0afbcfd74f02ab2b2aa5ec450b46b9f791f0e3acef9d4a75059b6fadd6eaef`
  (sourceCommit 48f434d, sourceDirty true; `build.log`).
- Executing model: harness `alibaba-token-plan/qwen3.8-max` (opencode), agent
  `opencode-adapter-98`, per root dispatch #98/1000.

## Commands and results

| Command | Result | Log |
| --- | --- | --- |
| `npm run typecheck` (baseline, pre-work) | exit 0 | `baseline-typecheck-prework.log` |
| `npm run build` (baseline, pre-work) | exit 0, buildId 73f37723… | `baseline-build-prework.log` |
| `npm test` (baseline, pre-work) | **378 tests / 377 pass / 0 fail / 1 skipped** (skip pre-existing), exit 0 | `baseline-test-prework.log` |
| `npm run typecheck` (post-change) | exit 0 | `typecheck.log` |
| `npm run build` (post-change, pre-commit) | exit 0, buildId ca0afbcf… | `build.log` |
| `npm test` (post-change full suite, pre-commit) | **399 tests / 398 pass / 0 fail / 1 skipped** (skip pre-existing; baseline 378 + 21 new opencode tests), exit 0 | `test-full-precommit.log` |
| `npx prettier --check <touched files>` | exit 0, all files Prettier-clean | `prettier.log` |
| `git diff --check` | clean | (session record) |

Flake note (honest, pre-existing, NOT owned by this ticket): two earlier
full-suite attempts each showed timing failures in PRE-EXISTING tests —
`tests/runner.test.mjs` F08 "worker SIGKILL … no duplicate launch" (both
attempts) and `claude-code-lifecycle` L11 (first attempt only, while the
implementer was concurrently running targeted opencode batches). **F08 is
demonstrably flaky standalone with zero opencode code involved:** running
`node --test tests/runner.test.mjs` alone failed F08 in 2/3 then 3/4
consecutive attempts under current desktop load (its 550 ms
SIGKILL/cleanup race window is load-sensitive), and passed standalone when
the machine was quieter. L11 also passed standalone. The authoritative
uncontended full-suite run recorded above is completely green (399/398/0/1
skip). No opencode code path is involved in either test; runner.test.mjs is
outside this ticket's ownership, so the flake is reported, not fixed.

## Real vs mocked

- Evidence class: **owned-fake-cli** (`tests/fixtures/opencode-fake-cli.mjs`,
  wrapped into an executable pinned-binary fixture). Real spawned processes,
  real process-group SIGTERM/SIGKILL, real SQLite stores, real file IO.
- The **installed real opencode binary was NEVER executed** (no subcommand, not
  even `--version`) — this ticket's own harness runs inside opencode. No real
  model calls, no network, no credential bytes read
  (`~/.local/share/opencode/auth.json` untouched; only path-string comparisons).
  Frame/part/export shapes were pinned by READING the read-only v1.18.32
  source clone at `/tmp/oc-src` (left by #104 research):
  `cli/cmd/run.ts` emit sites, `cli/cmd/export.ts` (`{info, messages}`
  envelope, stdout-only JSON), `packages/schema/src/v1/session.ts` part
  shapes, `tool/registry.ts` + `tool/shell/id.ts` tool IDs,
  `core/src/v1/permission.ts` (`PermissionRejectedError`).
- Live qualification is deferred to #14 and additionally gated on an explicit
  user G-AUTHFILE decision.

## Seam/runner/store extensions

**None.** The #97 seam absorbed OpenCode with ZERO extensions, same as codex
(#81). The only edit outside the owned new files is the single export line in
`src/index.ts` (`export * from "./agents/opencode/index.js";`).

## File inventory (new unless noted)

- `src/agents/opencode/config.ts` — fail-closed config validation: pinned
  identity (1.18.32), on-table model only, role table (model/steps/prompt),
  Rocky-owned dataHome, pinned catalog, managed paths, limits.
- `src/agents/opencode/env.ts` — sealed 20-entry positive allowlist +
  forbidden source-env families (provider keys, auth/config injection, XDG,
  proxy/TLS, OTEL) + sealed-list audit.
- `src/agents/opencode/launch.ts` — exact 5-element argv + re-audit +
  never-pass list; sealed OPENCODE_CONFIG_CONTENT render + strict re-audit
  (required/prohibited keys, substitution vectors, role permission tables);
  per-action RUN tree; data-dir isolation fail-closed (shared-user-data-dir
  unrepresentable); names-only isolation inventory + admission + drift.
- `src/agents/opencode/stream.ts` — strict NDJSON classification: closed event
  set, frame/part shape consumption, session-ID binding, roster + permission-
  refusal POLICY rules, settled-ordinary, final-text protocol with host
  re-validation (`validateOpencodeStructuredFinal`), lifecycle conjunctions,
  exit-code matrix (no result/done event exists).
- `src/agents/opencode/export.ts` — post-run `opencode export <sessionID>`
  bounded child (sealed env, timeout, maxBuffer), strict `{info,messages}`
  parse, served modelID/providerID/version/directory checks (mismatch fatal),
  aggregate tokens + step_finish cross-check (divergence ⇒ unknown), raw
  retention 0600.
- `src/agents/opencode/usage.ts` — schema-2 mapping: export-aggregate-only
  reported / ambiguous-zero / unknown rules; cost never consumed.
- `src/agents/opencode/receipt.ts` — lean receipt: identity C0/C1/C5, bundle +
  config-content digests, isolation inventory pre/post + drift, stream/export
  summaries, settlement, usage, head pre/post, honest gaps list.
- `src/agents/opencode/adapter.ts` — `OpencodeAdapter`
  (`CoordinatorTransport`): prepare/begin/settle lifecycle reusing
  guardedStart + DuplexRunner + queueDuplexText exactly like codex-exec;
  cancellation SIGTERM→KILL via the existing supervisor; deadline/fence/
  no-resend inherited; export audit as required success conjunct.
- `src/agents/opencode/index.ts` — package re-exports.
- `src/index.ts` — MODIFIED: one export line.
- `tests/fixtures/opencode-fake-cli.mjs` — owned fake CLI (run + export modes,
  scripted frames/faults, records argv/env/cwd/stdin, separate export record).
- `tests/opencode-support.mjs` — fixtures, config builder, script/export-doc
  builders, dispatch/settle helpers (real SQLite under
  `.qualification/opencode-98/artifacts`).
- `tests/opencode-launch.test.mjs` — X01–X07.
- `tests/opencode-protocol.test.mjs` — P01–P09.
- `tests/opencode-lifecycle.test.mjs` — L01–L05.
- `docs/opencode-adapter.md` — direct adapter documentation incl. the
  one-time user auth-provisioning procedure and the gaps table.

## Coverage map (rule → test)

| Rule (#104 ref) | Test |
| --- | --- |
| Pinned identity; symlink/truncated/missing/version/off-table refusals; zero spawn (F1/F2, FK1) | X01 |
| Argv exact shape; role→agent; never-pass flags; no positional prompt; off-table model (F9, FK2/FK3) | X02 |
| Sealed env allowlist equality; poisoned source env pre-spawn refusal (F5/F6, FK3) | X03 |
| Config content: canonical strict JSON, required pins, prohibited keys, duplicate keys, {env:}/{file:} vectors (F13/F14, FK2) | X04 |
| Isolation fail-closed: shared user data dir (equal/inside/containing), missing dataHome, managed layer, catalog missing/drift, staged-tree purity (F7/F8/F13) | X05 |
| Role permission tables: reviewer tool-absence read-only, implementer containment, subagent_depth 0 (F17/F18) | X06 |
| Spawn binding equality: recorded argv/env/cwd/stdin == bundle; export child sealed-env equality (FK1) | X07 |
| Complete conjunction: EOF+exit0+final+export audit → proposal-only, host head, reported usage 1540, gaps recorded (F21/F25/F27) | P01 |
| Export audit required conjunct: missing session/malformed/shape drift ⇒ unresolved+unknown, never success (F25, FK9) | P02 |
| Export served-identity mismatches (model/provider/version/directory/assistant-error) ⇒ FATAL (PART 4 §3, FK8) | P03 |
| Stream faults: garbage line + duplicate key ⇒ fatal malformed-NDJSON; truncation ⇒ unresolved; unknown type ⇒ drift tripwire (F22, FK5) | P04 |
| Completion semantics: exit0 no-text, zero stdout, startup refusal fatal, error event fatal (F21/F23, FK5) | P05 |
| Tool classification: permission refusal ⇒ POLICY; ordinary failure settled-ordinary; off-roster implementer/reviewer ⇒ POLICY (F12/F17, PART 4 §3) | P06 |
| Final-text protocol: last text carrier; unparsable/mis-bound/competing finals; tool-after-final (F27) | P07 |
| Usage: all-zero ⇒ ambiguous-zero + real-reducer recovery_required barrier; step_finish divergence ⇒ unknown; no step_finish ⇒ unknown; SessionInfo.tokens divergence ⇒ unknown; cost never a receipt (PART 4 §5, FK6) | P08 |
| Session identity binding: export must be the streamed session; second sessionID ⇒ unresolved (F19/F25, FK9) | P09 |
| Cancellation SIGTERM-only: interrupted/unknown, late stdout ignored, group dies, sentinel survives, no interrupt ack, export never ran (F24, FK7) | L01 |
| Deadline: original deadline stops run, reserved cleanup, never restarted | L02 |
| Stdin: exact bytes once + one EOF; exit-before-read attempted-unknown no resend; durable send intent reserved/claimed/attempted across reopen, different-bytes conflict (F23, FK4) | L03 (+X07) |
| Restart reconciliation: idempotent prepare, observation-only begin, no resend, changed-bundle conflict (FK1) | L04 |
| Post-run drift: staged instruction files, catalog mutation, C5 binary drift ⇒ unresolved/unknown, never success (FK8) | L05 |

## Usage-mapping decisions (#90 schema 2)

- Reported totals come ONLY from the export-audit aggregate (assistant-message
  token sums); the stream has no aggregate frame and per-step values are only
  a cross-check. `receipt` = sha256 of the retained raw export bytes.
- absent/all-zero aggregate on a complete audited stream ⇒ `ambiguous-zero`
  (never a known zero); interrupted/unresolved lifecycle, unavailable or fatal
  export audit, aggregate-vs-step_finish (or SessionInfo.tokens) divergence,
  missing step_finish telemetry, inconsistent subsets ⇒ `unknown`.
- Subsets (cache read/write ⊆ input, reasoning ⊆ output) pass through as
  observed, never added twice (G-USAGE-COMPONENTS open). `cost` (zero-priced
  catalog) is never consumed.
- Successful result with unresolved usage keeps the unknown-success barrier
  and stops the run `recovery_required` (asserted against the real reducer in
  P08a/b/c).

## Gaps / gates documented (never papered over)

G-AUTHFILE (**explicit user decision REQUIRED before any live run**; not
decided yet), G-SIG, G-USAGE-COMPONENTS, G-NPM (CFG pre-materialization not
implemented — fresh per-action CFG, inventoried), G-DEFAULT-PROMPT (agent
prompt REPLACES the default system prompt), G-ROSTER, G-MANAGED,
G-EXPORT-AUTHORITY, G-EFFORT, G-WRITES (data/config-dir write growth recorded,
not natively bounded), NP1–NP5 native probes unexecuted (NP1 isolation
positive control non-negotiable before live: an isolation failure would arm
the user's 5 real MCP servers incl. Taskbot mutation tools), LIVE deferred to
#14. All are emitted into every receipt (`opencodeReceiptGaps`) and documented
in `docs/opencode-adapter.md`.

## Questions for the reviewer

1. **dataHome granularity:** #104's root decision says "dedicated XDG_DATA_HOME
   per run-tree" with ONE-TIME provisioning; this adapter realizes it as a
   host-config-level dedicated Rocky-owned dir (provisioned once by the user),
   with per-action fresh XDG_CONFIG/CACHE/STATE and a per-action isolated
   OPENCODE_DB. Per-action data dirs would make one-time provisioning
   impossible. Interpretation flagged; user may veto.
2. **Malformed-NDJSON class:** #104 PART 4 §3 lists malformed NDJSON as FATAL
   (codex-exec's older contract classified decode faults unresolved). Followed
   #104: garbage/duplicate-key ⇒ fatal; trailing partial line (truncation) ⇒
   unresolved. Confirm this split is the intended reading.
3. **Reasoning events:** pinned argv never passes `--thinking`, so a
   `reasoning` event is treated as a drift tripwire (unresolved) rather than
   accepted silently. Confirm.
4. **Off-roster tool names:** implementer roster pinned to native tool IDs
   {bash, read, glob, grep, edit, write, todowrite, apply_patch}; reviewer
   {read, glob, grep}. There is no native `list` tool in the pinned registry
   (the `list` permission key exists but binds no builtin tool); the reviewer
   permission table still carries `list:'allow'` per research F18. Confirm.
5. **Export shape authority:** the `{info, messages}` envelope and field names
   were pinned by reading the v1.18.32 source clone (export.ts run() +
   schema/v1/session.ts), not by executing the binary (forbidden in #98).
   NP-class native confirmation remains open before live.
