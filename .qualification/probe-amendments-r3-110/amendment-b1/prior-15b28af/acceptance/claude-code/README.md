# Claude Code CLI acceptance, v1

`manifest.json` and `scenarios.json` are the protected `rocky-claude-code-95-v1`
contract. This is **static authorship**, with no executed scenario, native
qualification, capability, or execution grant. Taskbot #95 (user scope decision
#1/863: Claude Code is the first harness) and its sole mutation lease authorize
these new files; independent review precedes any production use. The producer
cannot edit this acceptance set.

The candidate is one fresh pinned Claude Code `claude -p` invocation per action
in headless stream-json mode, authenticated only by its own subscription OAuth.
No separate API credential, token proxy, or gateway is required or permitted.
The [architecture note](../../docs/architecture/claude-code-harness.md)
identifies the production adapter path; it does not implement it.

## Reuse by reference, not by fork

The harness-neutral acceptance semantics live in
[`acceptance/subscription/**`](../subscription/README.md)
(`rocky-subscription-88-v1`, including the #93 amendment at this baseline) and
in `docs/coordinator.md` § "Direct-harness subscription budget mode (Taskbot
#90)". They are reused **by reference**: the outcome vocabulary
(unexecuted/pass/fail/blocked/unknown/unsupported), denominator retention,
native-test evidence rules, the settled-ordinary vs unresolved vs policy/fatal
classification per #89/850(a)/(b)/(c), duplex attempted-before-IO input
semantics, the proposed-action final schema
(`acceptance/subscription/final.schema.json`, sha256 `954dd71e…6792`; its
Claude wire projection is defined under "Reading stream-json output", #111),
the `subscription-observed-v1` usage schema 2 with statuses
reported/ambiguous-zero/unknown, and the rule that a model final never
establishes head/checks/CI/review authority. This contract adds only
Claude-Code-specific argv/env/auth/discovery/event/role/stream bindings. Where
this file and the referenced artifacts overlap, the referenced artifact governs
the neutral semantics and this contract governs the Claude Code binding.

Every harness-specific claim below cites the #94 research record (comments 872,
878, 879, 880; root accept 881) and, through it, the underlying pinned sources:
official docs at code.claude.com fetched 2026-09-28 [D], read-only strings of
the pinned binary [B], and items the research could not prove [P], which stay
open gates. Nothing here is invented behavior.

## Identity and version pin

The pinned candidate is Claude Code **2.1.283**, the native Bun single-file
Mach-O at `/Users/jappy/.local/share/claude/versions/2.1.283` (225,036,032
bytes, sha256 `d8cb1e5c79684cc12a8bfc813e3a2073406921b6245744b3009be3ab5651d21e`,
BUILD_TIME 2026-09-25T00:44:42Z; source: #94/872 F1 [B]). Rocky always spawns
the absolute versioned path and re-measures the hash at admission checkpoint
C1: the `~/.local/bin/claude` symlink moves on auto-update, the Homebrew
2.1.236 build predates `--permission-prompts` and AGENTS.md reading, and other
installed versions (2.1.233/2.1.238) are not the candidate (source: #94/872
F1). A missing or changed binary makes the profile **unavailable**, never
substituted (G-VERSION). Bundle strings are not runtime proof and not a
reproducible build; backend attestation stays null.

## Subscription-only auth, sealed environment

Auth precedence puts provider switches, `ANTHROPIC_AUTH_TOKEN`,
`ANTHROPIC_API_KEY` (which in `-p` is **always** used when present, with no
approval), `apiKeyHelper`, `CLAUDE_CODE_OAUTH_TOKEN` and profile/federation
credentials **above** subscription OAuth (source: #94/872 F2). Any of them
leaking through the process env, an `env` block in any loaded settings layer
(including a repository's `.claude/settings.json`, whose env and apiKeyHelper
are honored by `-p` even in an untrusted folder), a managed `env` block, an
active profile under `~/.config/anthropic`, or `ANTHROPIC_BASE_URL` silently
switches billing off the subscription. Therefore:

- The child environment is a **sealed positive allowlist** with nothing
  inherited: a fresh parent HOME, a dedicated `CLAUDE_CONFIG_DIR`, a minimal
  PATH/LANG/TMPDIR, and the fixed disable switches (manifest
  `launch.environment.allowlist`; source: #94/878 §C).
- The forbidden list is regression-asserted always-absent and includes
  `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`,
  `ANTHROPIC_PROFILE`, every `ANTHROPIC_*` and `CLAUDE_CODE_USE_*`,
  `CLAUDE_CODE_OAUTH_TOKEN` and every `CLAUDE_CODE_*TOKEN*`/`*_FILE_DESCRIPTOR`
  credential var, `CLAUDE_CODE_MANAGED_SETTINGS_PATH`,
  `CLAUDE_SECURESTORAGE_CONFIG_DIR`, `CLAUDE_CODE_SIMPLE`, proxy/TLS/cloud/SCM
  families, and `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` (it disables sandbox
  auto-allow) (source: #94/878 §C; #94/880 FK3).
- `--bare` / `CLAUDE_CODE_SIMPLE=1` are strictly API-key-or-apiKeyHelper auth
  and incompatible with subscription; `CLAUDE_CODE_OAUTH_TOKEN` would mean
  Rocky holds a token. Both are rejected (source: #94/872 F3).
- Auth mode is **dedicated config dir (H1)**: `HOME=<PH>`,
  `CLAUDE_CONFIG_DIR=<CFG>`, and one interactive `/login` performed by the
  user in that dir, which gets its own keychain entry
  `Claude Code-credentials-<sha8(CFG)>` and its own refresh, sharing no user
  settings, CLAUDE.md, skills, plugins or MCP. Shared-home mode H2 is rejected
  (G-RACE) (source: #94/872 F4; #94/878 §C).
- **Rocky never reads, copies, symlinks or proxies credentials.** The keychain
  service name is derived only as a nonsecret identifier; no keychain call is
  made. Post-hoc signals are nonsecret only: `init.apiKeySource` must be
  `none` and every `modelUsage[*].provider` must be `firstParty`; `none` does
  not distinguish subscription OAuth from a bearer token or profile, so the
  sealed environment — not the signal — carries the exclusivity proof (source:
  #94/872 F2/F4).

**G-KC — user-accepted limitation**: the Seatbelt profile for sandboxed Bash
allows mach-lookup of `com.apple.SecurityServer`/`securityd.xpc`, the sandbox
default read scope is the whole disk with no credential deny list, and Bash
deny rules are bypassable by path/`sh -c`/scripts, so a model-run
`security find-generic-password -w` **may** return the subscription OAuth
tokens without a prompt; research proved neither direction (source: #94/872
F5; #94/880 G-KC/NP3). The user **accepted this risk on 2026-09-28** (#95/883,
mirrored #1/884), and this contract records it as an **explicit, user-accepted
visible limitation** for the final report — **not** a qualified containment
claim. Per the recorded decision: no separate macOS user account; no
sandbox-denial probe is required before proceeding — scenario N03 remains
available as **optional** defense-in-depth evidence, never a blocking
prerequisite; every other protection in this section (dedicated
`CLAUDE_CONFIG_DIR` with one-time user `/login`, sealed environment, forbidden
API envs, Rocky never reading/copying/proxying credentials, discovery pinning,
no shell for the reviewer) **remains required**; and the decision is revisited
if the deployment moves to a shared/multi-user host. Consequence: the
shell-bearing implementer profile no longer waits on G-KC; it remains blocked
by its other honest gates (G-SET, G-MANAGED, G-INIT-VALUES, G-MODEL) and
separately granted native/live authority. The reviewer role has no shell and
avoids this path entirely.

## Argv, roles and discovery sealing

The exact headless argv template is in `manifest.json`
(`launch.argvTemplate`): `-p --output-format=stream-json --verbose
--input-format=text --no-session-persistence --setting-sources=
--settings=… --strict-mcp-config --disable-slash-commands
--permission-mode=dontAsk --permission-prompts=none --model=… --effort=…
--max-turns=… --tools=… --allowedTools=… --disallowedTools=… --json-schema=…
--append-system-prompt-file=…`, no positional prompt. Because Commander
variadic options swallow following args, **every option is exactly one argv
element in `--opt=value` form** (source: #94/878 §A [B]). The never-pass list
(bypass flags, resume/session family, `--mcp-config`, plugin/agent flags,
`--fallback-model`, `--system-prompt(-file)`, `--max-budget-usd`, debug
family, `--add-dir`, …) is rejected pre-spawn (source: #94/878 §A).

Roles: implementer `--tools=Bash,Read,Edit,Write,Glob,Grep`; reviewer
`--tools=Read,Glob,Grep` plus `--restricted`, never `--add-dir` (its dirs are
sandbox-writable, so an add-dir read-only design is not source-valid), and any
reviewer write is impossible by tool absence [P roster]. Both roles carry the
fixed deny list (Agent, Workflow, Skill, web tools, MCP tools `mcp__*`, …)
(source: #94/878 §A/§D). Model/effort come only from an approved role table;
an unknown `--effort` merely warns and silently uses the default, so the
producer validates it — natively confirmed zero-turn (R1 #108 CC-P2 e: the
exact `Warning: Unknown --effort value …` then proceed to auth failure, so the
producer-rejection duty is load-bearing) — and effort stays requested-only
(G-EFFORT, G-MODEL; source: #94/878 F11;
`.qualification/native-probes-R1/probes/CC-P2/verdict.md`). The G-MODEL
enumeration half now has a finite candidate list (99 refined bundle-string IDs,
R1 #108 CC-P8 — NOT runtime-attested; resolvability only via CC-L1); per user
decision #1 2026-09-29 (c) the IDs stay configurable and the role table is
host-frozen.

Discovery sealing: `--setting-sources=` (empty ⇒ no user/project/local
layers), a Rocky-owned canonical `--settings` file whose prohibited keys
(`env`, `apiKeyHelper`, `hooks`, `mcpServers`, model keys, …) are rejected by
the producer, `disableAllHooks`, `--disable-slash-commands` plus the
skill-disable envs, no MCP (`--strict-mcp-config`, `disableClaudeAiConnectors`),
no plugins, no subagents, auto-memory off, background tasks off, and a staged
tree with no `CLAUDE*.md`/`AGENTS.md`/`.claude`/`.mcp.json` in the tree **or
any ancestor** (source: #94/872 F6–F8; #94/878 §B). Managed/MDM/server-managed
layers cannot be disabled, so they are inventoried by hash and **any presence
refuses the profile** until separately reviewed (G-MANAGED); on the R1 #108
probe host the real managed/MDM layers were re-observed ALL ABSENT (lstat
names-only, contents never read) and the named pre-spawn refusals
(`claude-config-dir-forbidden` / `claude-instruction-files-present` /
`claude-managed-layer-present`) were observed with zero spawn and the
SessionStart-hook sentinel untouched (CC-P1, PASS) — the per-run
presence-refusal requirement is unchanged. In `-p`, settings
that fail validation are **silently ignored** — an invalid Rocky settings file
could silently disable the sandbox — so settings bytes are canonical,
duplicate-key-rejected and hash-bound, and G-SET requires a native proof plus a
per-run positive control (source: #94/872 F6; #94/880 G-SET/NP4). The
silent-ignore direction now has its native zero-turn proof: R1 #108 CC-P3
(PASS) confirmed **Direction B** — invalid `--settings` (unknown key; malformed
JSON) is silently ignored, byte-identical auth-failure frames to the valid
baseline — so the shipped fail-closed `validateClaudeSettingsBytes` pre-spawn
validation is evidence-bound mandatory; G-SET stays open pending the
effectiveness half (per-run positive control under CC-L2, LIVE, not run). The
effective sandbox state is not observable in the stream. A hostile
SessionStart hook was also natively observed firing **pre-auth with no model
turn** (hook_started/hook_response frames; CC-P6 i), which makes
`disableAllHooks:true`, the empty `--setting-sources=` and the hostile-config
discovery refusals load-bearing (source:
`.qualification/native-probes-R1/probes/CC-P1,CC-P3,CC-P6/`; #108 root triage
comment 972; #110/R3 wording amendment — observation only, no scenario
executed).

## Reading stream-json output

Bounded raw stdout/stderr capture precedes strict incremental UTF-8 decoding of
complete newline-delimited JSON objects with finite byte/frame/line limits and
duplicate-key rejection; overflow, invalid encoding, trailing partial data or
unknown types are never silently discarded (reused by reference from the
subscription reading rules; framing facts source: #94/879 F14). The documented
message union is **open** (36 members), so an unknown type/subtype off the
reviewed allowlist rejects.

The success conjunction (manifest `protocol.successRequires`; source: #94/879
COMPLETE) requires: exactly one `system/init` first with nonblank session_id,
`claude_code_version=="2.1.283"`, `cwd==SRC`, `apiKeySource=="none"`, empty
mcp_servers/plugins, approved-empty skills/slash_commands [P exact values,
G-INIT-VALUES], the exact role roster and `permissionMode=="dontAsk"`; every
`tool_use` id unique with exactly one later matching `tool_result`; exactly one
`result` with subtype `success`, `is_error` false, `terminal_reason`
`completed` if present, and `structured_output` valid against the full
protected schema and bound to action/input/role; empty `permission_denials` and
no `system/permission_denied`; no `assistant.error`, no `aborted:true`, no
frames after result; every `modelUsage` key equal to the requested model with
provider `firstParty`; stdout **and** stderr EOF, exit 0 and independent owned
physical quiescence; unchanged fence/deadline.

Classification (source: #94/879; #89/850):

- **Settled ordinary failure** — a `tool_result` with `is_error:true` whose id
  is not in `permission_denials` and has no `permission_denied` event (a
  nonzero Bash test run; an Edit mismatch later corrected with a distinct
  tool_use_id). Seatbelt violations surface as ordinary Bash output and stay
  ordinary per #89/850(a); containment rests on the independent oracle and
  native qualification, never relabelling.
- **Policy denial** — any `result.permission_denials` entry (the
  **authoritative source-defined denial form**, answering #89/850(b) for this
  harness) or `system/permission_denied` event, any off-roster `tool_use`, any
  denied StructuredOutput. Rejects.
- **Unresolved/unknown** — tool_use without tool_result; duplicate/orphan
  tool_result; no result or more than one; a `result_index` gap; any signal;
  subtype ≠ success; success with `is_error:true`; success without
  `structured_output`; aborted assistant; malformed/partial/oversized frames;
  invalid UTF-8; duplicate keys; unknown types. Rejects.
- **Fatal** — startup error; `assistant.error`
  authentication_failed/oauth_org_not_allowed/billing_error/account_on_hold;
  model_not_found; `apiKeySource≠"none"`; provider ≠ firstParty; a modelUsage
  key ≠ the requested model (silent fallback); a changed
  `claude_code_version`. Rejects.

Native zero-turn observation (R1 #108 CC-P2/CC-P5, root-accepted comment 972;
#110/R3 wording amendment): the unauth auth-failure path surfaces as ONE
**synthetic** assistant frame (`model:"<synthetic>"`,
`is_api_error_message:true`, zero usage) plus a result frame carrying
`subtype:"success"` **with** `is_error:true` and `terminal_reason:"api_error"`
— a subtype-only classifier would misread auth failure as success; the shipped
adapter settles this shape fatal correctly (source:
`.qualification/native-probes-R1/probes/CC-P2/verdict.md`,
`probes/CC-P5/verdict.md`).

`--json-schema` is implemented as a synthetic `StructuredOutput` tool pair;
`success` **without** `structured_output` is possible and is treated as
failure; the flag is a request, not evidence — the host always re-validates
against `acceptance/subscription/final.schema.json` (by reference)
(source: #94/878 F10, §F).

**Request-schema wire projection (#111 amendment).** The inline `--json-schema`
value is the **wire projection** of the frozen schema: the canonical-minified
`acceptance/subscription/final.schema.json` bytes with **only** `"$schema"`
replaced by `"http://json-schema.org/draft-07/schema#"` (explicit dialect,
never omission). Reason: the pinned claude 2.1.283 `--json-schema` validator
does not carry the draft-2020-12 meta-schema in its bundled registry, so the
frozen IRI is rejected at startup (`Error: --json-schema is not a valid JSON
Schema: no schema with key or ref "https://json-schema.org/draft/2020-12/schema"`,
exit 1, zero frames — every structured-output launch would fail), while the
same body under the draft-07 IRI is accepted and startup proceeds to auth
failure (source: R1 #108 CC-P5 verdict + `diag-json-schema` zero-turn
draft-isolation diagnostic,
`.qualification/native-probes-R1/probes/CC-P5/`; a bundled-registry
limitation of the pinned binary, not a network artifact, and claude-specific —
codex `--output-schema` did not reject the same 2020-12 schema at startup,
CX-P3). The frozen body uses **no draft-2020-12-exclusive vocabulary** (only
`$schema`/`$id`/`title`/`type`/`properties`/`required`/`additionalProperties`/
`const`/`enum`/`minLength`/`maxLength`/`pattern`), so the draft-07 reading is
semantically identical. **Host-side validation authority is unchanged**: the
frozen 2020-12 `final.schema.json` bytes remain the schema every
`result.structured_output` is re-validated against; the projection is a
request-wire detail derived at launch preparation, never a second shipped
schema file and never evidence. The producer fail-closes if the source
`"$schema"` is not exactly the frozen 2020-12 IRI or the projection derivation
is non-deterministic, and the projection hash is pinned (sha256
`c02efee93dbeffb0e6f6153ba6d465804af4f31cb163d95ab76fe9f4b5b1a6e3` of the
projected canonical bytes; #111).

Exit codes are **never success evidence alone**: exit is 1 iff the last result
has `is_error:true` or the transport closed permanently — including **exit 0
when no result was emitted**; SIGTERM exits 143, kills the Bash tree and
leaves **no result** (⇒ unknown); SIGINT frames/exit are unobserved
(G-SIGINT), so cancellation is SIGTERM-only with no interrupt acknowledgement
ever claimed; a late result after cancel is ignored (source: #94/879 F16,
producer contract §4; #94/880 FK7). As of R1 #108 neither signal shape is
natively observed, **with observation**: unauth auth-failure (~250–260 ms)
preempted the scheduled T+10s SIGTERM / T+8s SIGINT, so no signal was ever
delivered to a live process (CC-P6 ii/iii) — the 143-no-result (FK7/F12) and
SIGINT shapes stay unknown-with-observation, needing CC-L3 (LIVE, not run)
(source: `.qualification/native-probes-R1/probes/CC-P6/verdict.md`; #110/R3).
`system/api_retry` events are not fatal;
a retrying run that later satisfies the full conjunction is **accepted with the
retries recorded** (decision D-05, adopting the research recommendation;
source: #94/879; #94/880 G-RETRY).

Stdin: exact approved UTF-8 bytes written once, then a single EOF; ≤ min(config,
10 MB); BOM/invalid/empty/whitespace-only/over-limit rejected before spawn;
consumption is evidenced only by `system/init` (the input checks run before
init), so an exit-before-read stays attempted-unknown with no resend
(source: #94/878 F12, §E; #94/880 FK4). Durable attempted-before-IO intent and
no-blind-replay semantics are reused by reference from the accepted duplex
contract.

## Usage and authority

Usage comes **only** from `result.modelUsage` (it includes subagents,
compaction and internal calls): sum `inputTokens + outputTokens` per model;
cache read/creation and thinking tokens are subsets or separate components and
are never added twice — `outputTokens` already includes thinking. Positive
valid numbers map to schema-2 status `reported` (never established actual
consumption); all-zero or absent telemetry is `ambiguous-zero`; interrupted,
truncated or zeroed-crash telemetry is `unknown`. `total_cost_usd` is a client
estimate and `num_turns` informational: neither is ever a provider receipt or
budget input. Threshold stops, planning charges, overruns, `recovery_required`
for a successful action with unresolved usage and CI-reserve independence are
exactly the referenced #90 `subscription-observed-v1` mode — not restated or
forked here (source: #94/879 usage note; #94/880 FK6; docs/coordinator.md).

Todo/plan task state is **informational only**, mirroring the #93-amended
subscription rule: no plan-complete predicate is a success barrier;
planned-work verification rests on the observed stream history, the staged diff
and independent host checks. The model's final is only a proposal — never an
authoritative check, review, CI, approval, head adoption or delivery receipt
(by reference).

## Open gates

G-KC (decision recorded: risk accepted by the user 2026-09-28, #95/883 and
#1/884, carried as an explicit user-accepted limitation; N03 optional
defense-in-depth), G-SET, G-MANAGED, G-HOME, G-RACE (mooted for this contract
by the rejection of shared-home mode, carried unproven), G-WRITES, G-VERSION,
G-INIT-VALUES, G-SIGINT, G-RETRY (api_retry half decided, D-05), G-EFFORT,
G-CLAUDEMD-MANAGED, G-DEFAULT-PROMPT and G-MODEL are listed with sources in
`manifest.json` `openGates`. None is closed by this contract — the decided
halves of G-KC (D-15) and G-RETRY (D-05) are recorded decisions whose unproven
residuals stay carried; each remaining gate maps to the scenario that can close
it. Research left these unresolved and they are encoded as honest gates, not
guesses.

**R1 native observations (#110/R3 wording amendment).** Since the root-accepted
R1 #108 zero-turn native probe batch (comment 972, 2026-09-29), several gates
carry "observed (partial)" annotations in `manifest.json` `openGates` —
**none is closed and no scenario was executed or flipped**: G-SET (Direction B
silent-ignore natively confirmed, CC-P3; effectiveness closure still needs
CC-L2 LIVE), G-MANAGED (probe-host managed/MDM layers observed ABSENT,
lstat names-only, CC-P1; per-run presence refusal unchanged), G-WRITES
(startup write set `.claude.json`/`backups/`/`sessions/` observed bounded
inside the synthetic CFG despite `--no-session-persistence` +
`CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING=1`, CC-P5 and the #111 probe;
auth-refresh/LIVE surfaces still open), G-INIT-VALUES (bare-argv DEFAULT init
frame CC-P6 and the #111 projected-schema-subset init frame with
`StructuredOutput` present in `init.tools` are **partially observed** — NOT
adapter-constrained, NOT proven; the full roster stays gated to CC-L1),
G-SIGINT plus the SIGTERM 143-no-result shape (unknown-**with-observation**:
signals never delivered because unauth auth-failure preempted them, CC-P6;
CC-L3 LIVE needed) and G-MODEL (enumeration half only: 99 bundle-string
candidate IDs, CC-P8 — NOT runtime-attested; resolvability only via CC-L1).
Probes are not scenario executions; all 24 scenarios remain unexecuted or
blocked (14 + 10).

## Binding and review

Receipts bind the items in `manifest.json` `receiptRequirements`, including the
host-measured binary hash at C0 and C1, the bundleDigest, the pre/post
discovery inventory (managed/MDM/server-managed paths, configDir children
names, staged tree and ancestors), the init identity fields and the separated
EOF/exit/quiescence records; drift during a run makes the result stale/unknown
(source: #94/879 producer contract; #94/880 FK8). Only a trusted loader may
resolve an independently approved immutable binding; the contract author and
production author cannot supply independent approval. `frozen.sha256.json`
binds the contract files; `.qualification/claude-code-contract-95/` contains
static checks only. No executable launcher, adapter or qualification checker
ships here. All 24 scenarios are frozen unexecuted or blocked;
`qualification=false`, `capability=null`, `executionAuthorized=false`.
Re-freezing this static contract does not execute or pass any scenario.

**Amendment provenance.** (1) The G-KC user decision was recorded by the #95
amendment (2026-09-28; prior bytes archived under
`.qualification/claude-code-contract-95/amendment-gkc/prior-e859657/`). (2)
The request-schema wire projection above was amended by **#111** (2026-09-29,
sole mutation lease; baseline `674fffe`) on the root-accepted R1 #108 CC-P5
finding plus its zero-turn draft-isolation diagnostic; prior bytes are
archived under
`.qualification/claude-code-contract-95-amend-pfc1-111/prior-674fffe/`, and
every changed claim there carries its citation. `scenarios.json` is
**untouched** by #111 (no scenario text depends on the request-schema dialect
wording; status counts remain 14 unexecuted + 10 blocked). Only
`README.md` and `manifest.json` changed, and `frozen.sha256.json` re-freezes
those two entries only. The amendment executes and passes no scenario; the
#111 confirmation probe (projected schema accepted at native startup, zero
model turns, unauth) is recorded in the amendment evidence directory, not as
a scenario pass. (3) The **R3 wording amendment (#110**, 2026-09-29, sole
mutation lease; baseline `f3c809a`) records the root-accepted R1 #108
zero-turn native-probe observations and the #111 native confirmation in the
`openGates`, gate-adjacent and scenario-**blocker** texts cited above:
wording-only, every change cited to
`.qualification/native-probes-R1/probes/<ID>/` or
`.qualification/claude-code-contract-95-amend-pfc1-111/native-probe/`; no
scenario executed, no `status` flipped (14 unexecuted + 10 blocked unchanged),
no gate closed. Prior bytes are archived under
`.qualification/probe-amendments-r3-110/prior-f3c809a/` with an amendments
log; `frozen.sha256.json` re-freezes the changed files only.
