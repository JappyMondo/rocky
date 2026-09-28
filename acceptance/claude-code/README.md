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
(`acceptance/subscription/final.schema.json`, sha256 `954dd71e…6792`), the
`subscription-observed-v1` usage schema 2 with statuses
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

**Blocking gate G-KC**: the Seatbelt profile for sandboxed Bash allows
mach-lookup of `com.apple.SecurityServer`/`securityd.xpc`, the sandbox default
read scope is the whole disk with no credential deny list, and Bash deny rules
are bypassable by path/`sh -c`/scripts, so a model-run
`security find-generic-password -w` **may** return the subscription OAuth
tokens without a prompt; research proved neither direction (source: #94/872
F5; #94/880 G-KC/NP3). The shell-bearing implementer profile stays **blocked**
until scenario N03 passes on synthetic sentinels, a Rocky-specific macOS
account is provisioned, or the user explicitly accepts the residual risk. The
reviewer role has no shell and avoids this path.

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
producer validates it, and effort stays requested-only (G-EFFORT, G-MODEL;
source: #94/878 F11).

Discovery sealing: `--setting-sources=` (empty ⇒ no user/project/local
layers), a Rocky-owned canonical `--settings` file whose prohibited keys
(`env`, `apiKeyHelper`, `hooks`, `mcpServers`, model keys, …) are rejected by
the producer, `disableAllHooks`, `--disable-slash-commands` plus the
skill-disable envs, no MCP (`--strict-mcp-config`, `disableClaudeAiConnectors`),
no plugins, no subagents, auto-memory off, background tasks off, and a staged
tree with no `CLAUDE*.md`/`AGENTS.md`/`.claude`/`.mcp.json` in the tree **or
any ancestor** (source: #94/872 F6–F8; #94/878 §B). Managed/MDM/server-managed
layers cannot be disabled, so they are inventoried by hash and **any presence
refuses the profile** until separately reviewed (G-MANAGED). In `-p`, settings
that fail validation are **silently ignored** — an invalid Rocky settings file
could silently disable the sandbox — so settings bytes are canonical,
duplicate-key-rejected and hash-bound, and G-SET requires a native proof plus a
per-run positive control (source: #94/872 F6; #94/880 G-SET/NP4). The
effective sandbox state is not observable in the stream.

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

`--json-schema` is implemented as a synthetic `StructuredOutput` tool pair;
`success` **without** `structured_output` is possible and is treated as
failure; the flag is a request, not evidence — the host always re-validates
against `acceptance/subscription/final.schema.json` (by reference)
(source: #94/878 F10, §F).

Exit codes are **never success evidence alone**: exit is 1 iff the last result
has `is_error:true` or the transport closed permanently — including **exit 0
when no result was emitted**; SIGTERM exits 143, kills the Bash tree and
leaves **no result** (⇒ unknown); SIGINT frames/exit are unobserved
(G-SIGINT), so cancellation is SIGTERM-only with no interrupt acknowledgement
ever claimed; a late result after cancel is ignored (source: #94/879 F16,
producer contract §4; #94/880 FK7). `system/api_retry` events are not fatal;
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

G-KC (blocking, implementer), G-SET, G-MANAGED, G-HOME, G-RACE (mooted for
this contract by the rejection of shared-home mode, carried unproven),
G-WRITES, G-VERSION, G-INIT-VALUES, G-SIGINT, G-RETRY, G-EFFORT,
G-CLAUDEMD-MANAGED, G-DEFAULT-PROMPT and G-MODEL are listed with sources in
`manifest.json` `openGates`. None is closed by this contract; each maps to the
scenario that can close it. Research left these unresolved and they are encoded
as honest gates, not guesses.

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
