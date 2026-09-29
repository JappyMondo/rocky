# Direct Codex exec subscription harness adapter

Taskbot #81 implements the second production-shaped harness adapter: one fresh
pinned `codex exec --json` invocation per agent action, bound to the frozen
[`rocky-subscription-88-v1` contract](../acceptance/subscription/README.md) and
its amended (#93) direct-subscription semantics. It is a **consumer** of the
harness-neutral input/result seam in `src/agents/seam.ts` that Taskbot #97 added
for Claude Code; the architecture note
[subscription-harness.md](architecture/subscription-harness.md) remains the
decision record and this page describes the implementation.

**Status honesty up front:** `qualification=false`, `capability=null`,
`nativeExecutionBlocked=true` in the frozen contract are unchanged by this
package. The adapter ships **no approved qualification binding and no loader**;
it requires an explicitly host-frozen `ExecutionQualification` and refuses to run
without one, so production admission stays unavailable. Everything here is
validated with an **owned fake CLI** (evidence class `owned-fake-cli`): synthetic
native qualification (N01–N08) and live-subscription proof (L01–L02) are
separately granted root steps, and **live codex qualification is blocked on
OpenAI credits (an external access gap, not a deferral)** — the real codex binary
is never executed here (no subcommand, not even `--version`). The model's
structured final is a **proposal only**: it never establishes checks, CI, review,
head adoption or delivery authority. No host auth bytes are read, copied,
symlinked or proxied; no raw auth status or key fragments are retained.

## Seam reuse (no fork)

The #97 seam absorbed every harness-neutral need, so this adapter adds **no**
seam/runner/gate/supervisor/Store machinery. It reuses, unchanged:

- `AgentLaunchBundle` / `sealAgentLaunchBundle` — the immutable audited launch
  bundle (pinned `BinaryIdentity`, exact argv, sealed ordered env allowlist, cwd,
  input byte count + sha256, INP file bindings, discovery digest, `bundleDigest`).
- Input delivery — one-shot raw UTF-8 bytes written once then a single EOF over
  the existing duplex transport's durable attempted-before-IO semantics
  (`Store.queueDuplexText` via `DuplexRunner.sendText`/`end`, reused not forked:
  identical conflict, claim/attempt-latch and no-resend rules).
- `StrictNdjsonDecoder` / `parseStrictJson` — bounded strict NDJSON: incremental
  fatal UTF-8, per-line/total/frame bounds, duplicate-key rejection, no silently
  discarded trailing partial line.
- `AgentSettlement` / `settlementToResultEvent` — terminal settlement classes
  (`complete | unresolved | policy-denied | fatal | interrupted`) mapped onto the
  transport `result` event.
- `reportedHarnessUsage` / `ambiguousZeroHarnessUsage` / `unknownHarnessUsage` —
  the #90 `subscription-observed-v1` schema-2 statuses with subset semantics.
- `validateAgentPrompt`, `deriveTreeHead`, and the gate's `binaryIdentity`
  re-measure (C1) plus `bundleDigest` invocation binding.

The **only** edit to existing code is `src/index.ts` adding
`export * from "./agents/codex-exec/index.js";` — the export seam, required so
the adapter and its pure helpers are reachable from the package entrypoint
exactly as `agents/claude-code/index.js` is. Default behavior is byte-identical.

## The adapter (`src/agents/codex-exec/`)

`CodexExecAdapter` implements `CoordinatorTransport` (`capability` is always
`null`; `qualification`/`versions` come from fail-closed validated config).
Lifecycle per action mirrors the contract's C0–C5 producer checkpoints:

- **C0 `prepareLaunch(action, {prompt, stage?, images?})`** — synchronous,
  zero-spawn on any rejection: role from the work kind (implementer for
  implement/repairs, reviewer for review/arbitrate; non-agent and strict-mode
  actions refuse); poisoned-source-env scan (any forbidden auth-bearing key
  present refuses pre-spawn — names only, values never logged); prompt
  validation; pinned-binary identity (absolute path, symlink refusal,
  host-measured sha256/size, version pinned to `0.157.1` and source commit to
  `36650394…` — missing/drift makes the profile **unavailable**, never
  substituted); a fresh per-action **projectless** RUN tree (canonical realpath,
  0700, pairwise non-overlapping grants, SRC/SCR/PH/PT/NAT/INP/LOGS, none inside
  the shared CODEX_HOME); discovery inventory + admission (any present
  system/managed/MDM layer refuses because inherited maps cannot be erased, the
  effective global AGENTS must equal the approved digest, an unapproved
  CODEX_HOME skills root refuses, and the staged tree must carry no
  `.codex`/`.agents`/`AGENTS*.md`/`.git` with no ancestor `.git`); the request
  schema written 0400 and hash-bound; the audited TOML `-c` override set; the
  exact argv; the sealed env allowlist; and the `bundleDigest`. Re-preparing an
  identical action is idempotent; a changed bundle for the same action is a named
  `codex-plan-conflict`.
- **C1 `begin(action)`** — synchronous initiation inside the dispatch guarded
  start: source-env rescan, full bundle-drift recomputation (INP file rehash,
  argv/env/spawn-binding equality, prompt digest, discovery re-inventory +
  admission, staged-tree head equality — one-byte drift yields zero spawn), then
  the existing durable start (`DuplexRunner.start` with the binary identity and
  bundle digest bound into the invocation identity). The gate re-measures the
  binary hash inside its own guarded spawn transaction, so a drifted binary never
  launches (durable `binary-identity-drift` failure).
- **C3 input** — the exact prompt bytes are queued once (`queueDuplexText`), then
  a single EOF send; durable attempted-before-IO, conflict detection and
  no-resend-after-ambiguity come from the existing duplex send machinery.
  Consumption is evidenced **only** by a subsequent `thread.started`: the pinned
  source reads stdin fully before thread start and an early config error exits
  without reading, so a pipe-buffered write proves nothing and stays
  attempted-unknown (F9).
- **C4 observation** — the supervisor/gate bounded raw capture and transport
  framing run unchanged; the adapter independently re-decodes the retained raw
  stdout with `StrictNdjsonDecoder` and classifies with `classifyCodexStream`.
- **C5 settlement** — post-run re-inventory (global AGENTS digest,
  system/managed/MDM presence, CODEX_HOME skills, staged instructions/`.git`)
  **and** a nonsecret sha256/size re-measure of the shared CODEX_HOME
  `config.toml` (F5 trust-persistence byte check) **and** binary re-measurement;
  any drift makes the result stale/unknown, never success. Cancellation (SIGTERM
  to the owned group via the existing supervisor), deadline, lease loss and
  recovery-required settle as `interrupted` with unknown usage; a late terminal
  after cancel is ignored and no interrupt/turn acknowledgement is ever claimed.
  The head is re-derived from the staged tree by the host. A receipt covering the
  manifest `receiptRequirements` is written 0600 beside the command logs.

## Codex-specific interpretation

- **argv (`argv.ts`)** — the frozen template order
  `exec --json --color never --skip-git-repo-check --ignore-user-config
--ignore-rules --strict-config --output-schema <schema> --model <model>
[--image=…] --ephemeral <-c pairs> -- -`. Effort travels as a
  `model_reasoning_effort` override, never a flag. Model/effort come only from
  the approved role table and must be **on-table** (`gpt-6-sol`/`medium` or
  `gpt-6-astra`/`high`; reviewer is always astra/high); unknown or off-table
  config fails closed and is never defaulted (no fallback/reroute). Never-pass
  flags/subcommands (`--sandbox/-s`, `--yolo`, `--add-dir`, `--cd/-C`,
  `--profile/-p`, `-o`, `resume`/`fork`/`review`, …) reject pre-spawn regardless
  of position. The single trailing positional is `-` (forced stdin); the prompt is
  never in argv.
- **TOML overrides (`overrides.ts`)** — each `-c` is exactly one `key=value`
  argv element with a dot-free top-level key. Because the pinned source splits
  the key on every `.` and a value that fails TOML parsing **silently degrades to
  a raw string** (F1), every value is round-tripped through a real (owned) TOML
  value parser with structural equality before admission; path-keyed maps
  (`projects`, permission `filesystem`) are only supplied as inline-table values.
  Keys are an allowlist (the producer-side equivalent of `--strict-config`, F3);
  prohibited keys (`forced_login_method`, `forced_chatgpt_workspace_id`,
  `chatgpt_base_url`, `model_providers`, `mcp_servers`, `hooks`, `sandbox_mode`,
  …) reject. No override assumes map-erasure (F2): only the fail-closed discovery
  inventory establishes absence. The `sandbox_mode`+`default_permissions`
  combination is banned (F7) — `--sandbox` is never-pass and `sandbox_mode` is a
  prohibited key, so a named-permission profile is always selected without a
  legacy sandbox switch.
- **Named permissions (`overrides.ts`)** — model tools are restricted by an
  independently qualified named permission profile (`default_permissions` +
  a single `permissions` inline table): `:minimal` read, scratch write, SRC write
  for implementer / read for reviewer, `network.enabled=false`, and exact-path
  deny entries for the private parent/native/inputs roots, every shared-home
  child except `tmp` plus fixed future credential/session/config names, host deny
  roots and the reused platform deny roots. The shared-home `tmp/arg0` helper root
  is **never** denied (F12). Enforcement across shell/apply_patch/non-shell routes
  is a native gate (N02/N03), not claimed here.
- **Environment (`env.ts`)** — a sealed positive allowlist (private HOME, the
  designated shared CODEX*HOME, private TMPDIR, minimal PATH/LANG, plus
  probe-gated SHELL/USER/LOGNAME) is the complete child env; nothing is
  inherited. Every auth-bearing key (`CODEX_API_KEY`, `OPENAI_API_KEY`,
  `CODEX_ACCESS_TOKEN`, refresh/revoke URL overrides, client-id/base-url
  overrides, proxies, `GIT*\_`/`GH\_\_`, …) is forbidden and refuses the launch
pre-spawn (F8); `CODEX*HOME`is the one permitted`CODEX*\*` key (a path, never a
  credential) and is set by the adapter, not inherited.
- **Trust persistence (`trust.ts`)** — `thread/start` with a writable cwd and no
  `trust_level` would persist `projects.<root>.trust_level="trusted"` into the
  shared config.toml (F5). It is prevented by the explicit untrusted override for
  the canonical staged root, the projectless staged tree, and the post-run
  config.toml byte check; native proof is N01.
- **Stream classification (`stream.ts`)** — a fresh exec JSONL stream, **not**
  external JSON-RPC: no turn id, no `turn.error:null`, no JSON-RPC request id and
  no pending-server-request map are exposed or fabricated. Success requires one
  nonblank `thread.started`, one `turn.started`, unique consistent item
  identities with a valid lifecycle, all observed items settled, one current
  structured final after tool settlement, one `turn.completed` after the final,
  no errors/reroutes/denials/declines, strict complete bounded stdout JSONL and
  stderr EOF, CLI exit zero, independent owned physical quiescence, and unchanged
  admission identity. `command_execution` needs started→completed with a
  non-pending status and integer exit code; `file_change`/`agent_message`/
  `reasoning` may be completed-only; a started `todo_list` must settle but its
  task state is **informational only** (exec synthesizes todo completion at every
  turn end, #93/F10) and is never a success barrier. The error class is broad:
  `item.completed{type:error}` (config warning, deprecation, lag drop, reroute)
  and every top-level `error` event (including `will_retry` reconnects) fail
  closed, as does `turn.failed`; a missing terminal with exit 1 is the interrupted
  shape. Fully observed ordinary nonzero command / failed patch outcomes are
  retained and do **not** alone reject a later correctly bound proposal
  (F12/F13). The final is the **last completed `agent_message`**, re-validated by
  the host against the full protected final schema plus the action/input/role
  binding; earlier progress messages cannot supply it and multiple schema-shaped
  finals fail. Unknown event/item types and extra unknown fields on success-path
  envelopes reject (F03).
- **Usage (`usage.ts`)** — see below.

## Usage mapping onto `subscription-observed-v1` (docs/coordinator.md § #90)

Usage comes **only** from the single terminal `turn.completed` event; exec always
emits a usage object and defaults it to zeros, so absent and all-zero are
indistinguishable at this interface:

- **reported** — positive valid counts: `input = input_tokens`,
  `output = output_tokens`, `cachedInput = cached_input_tokens`,
  `cacheWriteInput = cache_write_input_tokens`,
  `reasoningOutput = reasoning_output_tokens`; the comparison total is
  input + output and subsets are never added twice. The receipt is the sha256 of
  the retained raw `turn.completed` line. Actual provider consumption stays
  unknown; telemetry is never a provider receipt or a hard-token guarantee.
- **ambiguous-zero** — all-zero or absent usage on an otherwise complete turn. The
  coordinator's unknown-success barrier and `recovery_required` stop apply
  unchanged; the head is not adopted.
- **unknown** — interrupted/truncated telemetry (no terminal, exit 1), fatal
  observations (error item/event, `turn.failed`, startup refusal, binary drift),
  invalid counts (negative/fractional/unsafe/inconsistent subsets) and any
  unresolved lifecycle. A fatal observation blocks usage mapping entirely. Zero is
  never fabricated.

Overruns are retained unclipped; a reached threshold or any unresolved usage stops
the next **automatic agent** action between actions, while bounded local verify /
CI observation / cleanup continue within their own limits. Review exhaustion still
cannot consume the reserved CI repair attempt. These reducers live in
`src/coordinator` and are unchanged by this adapter.

## Requirement coverage (S01–S10)

| Req | Implementation                                                                                                   | Tests (owned fake CLI, real processes + SQLite)  |
| --- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| S01 | `config.ts` pins/binary/source-commit; `discovery.ts` inventory+admission; `env.ts` sealing; `trust.ts`          | `codex-exec-launch` X01, X04, X06, X07, X10; L13 |
| S02 | `overrides.ts` named-permission profiles + network off; `stream.ts` forbidden/declined items; reviewer read-only | X11, X12, P03, P10, P12                          |
| S03 | parent/tool env separation (sealed env + shell_environment_policy); private NAT/INP/PH/PT denies                 | X04, X11 (native authority gated N02–N05)        |
| S04 | `stream.ts` typed exec JSONL, final authority, lifecycle/EOF/exit, separate quiescence                           | P01, P02, P04–P08, P10, P11; L05                 |
| S05 | supervisor SIGTERM/KILL, original deadline, escaped descendant, lost supervisor                                  | L01, L02, L03, L05, L09                          |
| S06 | durable start/input intent, synchronous guarded begin, no resend, stale/cancel/duplicate/late                    | L04, L07, L08, L10, L11, L12; X08                |
| S07 | immutable exact input, finite bounds, zero launch after admission failure, C1 rehash                             | X02, X03, X05, X09, X10; P07, P07z, P07y         |
| S08 | `usage.ts` schema-2 mapping, zero ambiguity, overrun, between-action threshold                                   | P09, P09b, P01                                   |
| S09 | on-table model/effort fail-closed, reroute/error fail-closed, no invented provider attestation                   | X01, P05 (live model proof gated L01)            |
| S10 | independent qualification input (no loader), C5 drift, receipt rehash, proposal-only final                       | X08, L06, L13, L14, P01, P11                     |

Frozen F-scenario rules are exercised with owned fakes: F01 (X02/X03/X04/L04),
F02 (P01), F03 (P02/P07/P07z/P07y), F04 (P04/P05/P10), F05 (P05/P06),
F06 (L04/L07/L08/L10), F07 (L01/L02/L03/L05/L09), F08 (P09), F09 (P09b),
F12/F13 (P08). The frozen `acceptance/subscription/**` records themselves stay
untouched and unexecuted.

## Honest limitations and remaining gates

- **Not qualified.** No native (N01–N08) or live (L01–L02) scenario is executed
  or implied. The fake CLI proves the adapter's protocol discipline, not the real
  binary's behavior. **Live codex qualification is blocked on OpenAI credits**
  (external access gap); codex remains required and deprioritized behind the
  Claude chain.
- **G-FRAME-SHAPE.** The exact native exec-JSONL serde field names are an owned
  source-consistent interpretation of the pinned taxonomy; the frozen contract
  pins the event/item names and rules, and the precise native frame shape is gated
  N06. Tests exercise the rules against the owned fake, never a native claim.
- **G-OVERRIDES / G-MODEL / G-EFFORT.** Effective config and the tool roster are
  not observable in `exec --json`; override exactness is producer-audited and
  round-trip validated, but native effectiveness, the served model and applied
  effort are requested-only and gated N01/L01. A silent reroute that does not
  surface as an error item is undetectable in-band (L01).
- **G-AUTH.** Exec output carries no auth mode and Rocky never reads auth bytes;
  nonsecret account/mode classification is a separate harness-owned step with
  residual TOCTOU (G7), not performed here. Unknown auth/discovery/effective-config
  or native policy stays **unavailable**, never a caller-approved boolean.
- **G-TRUST / G-WRITES.** Trust persistence is prevented by the untrusted override
  - projectless tree and detected by a nonsecret config.toml byte check; native
    writes into the shared CODEX_HOME despite overrides/ephemeral (tmp/arg0 helper
    links, auth refresh, caches) are inventoried by name/hash, not natively bounded
    (G4/N01).
- **G-VISUAL.** The reviewer `--image` input transform/delivery and `view_image`
  absence are gated N08; a hash/path request alone is not proof of functional
  image consumption. The visual workflow remains mandatory.
- **G-SIGINT / cancelled-run exit detail.** Cancellation is SIGTERM-only via the
  owned group; the existing supervisor drops late child-exit messages once cleanup
  starts, so a cancelled receipt records the durable `cancelled` outcome,
  revocation and quiescence rather than the child's exact signal. An interrupted
  turn emits no terminal and exits 1; the SIGTERM→exit mapping is pinned native
  behavior gated by N07 and never fabricated.
- **Production admission is unavailable.** No loader and no approved binding ship
  here; a `null` qualification blocks agent work and `capability` is always null.

## Validation

`npm run typecheck && npm run build && npm test` under pinned Node v24.16.0.
Adapter tests live in `tests/codex-exec-{launch,protocol,lifecycle}.test.mjs` with
the owned fake CLI in `tests/fixtures/codex-exec-fake-cli.mjs` and support in
`tests/codex-exec-support.mjs`; artifacts retain under
`.qualification/codex-exec-81/` (or `CODEX_ARTIFACT_ROOT`).
