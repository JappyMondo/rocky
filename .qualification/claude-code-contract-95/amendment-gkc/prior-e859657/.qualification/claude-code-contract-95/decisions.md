# #95 authoring decisions

Every design decision carries its citation. `[D]`/`[B]`/`[P]` markers are the
research record's own legend, quoted through #94.

## D-01 New namespace, reused semantics

Requirements are `CC01`–`CC12`; scenarios are `F01`–`F14` (owned-fake-cli),
`N01`–`N06` (synthetic-native), `L01`–`L04` (live-subscription). No `M`
migration class is authored: unlike #88, there is no legacy snapshot to
migrate, because `subscription-observed-v1` already exists in the coordinator
(storage schema 8 / snapshot schema 4) and already names Claude Code as a
consumer (source: `docs/coordinator.md` § #90). Harness-neutral semantics
(outcome vocabulary, denominator retention, classification, duplex input,
final schema, budget mode, no-authority-from-a-final) are **reused by
reference** per the ticket, recorded in `manifest.json` `reuseByReference`
with the referenced artifacts' frozen hashes where they exist.

## D-02 Contract file set

`acceptance/claude-code/{README.md, manifest.json, scenarios.json,
frozen.sha256.json}` plus `docs/architecture/claude-code-harness.md`. No
`final.schema.json` is shipped here: the schema is harness-neutral and already
frozen at `acceptance/subscription/final.schema.json`; duplicating it would
fork the proposal shape. The manifest references it by path + sha256.

## D-03 Version pin and identity

Pinned candidate is 2.1.283 at the absolute versioned path with the
host-measured sha256 `d8cb1e5c…d21e`, 225,036,032 bytes, BUILD_TIME
2026-09-25T00:44:42Z. The symlink `~/.local/bin/claude`, Homebrew 2.1.236
(sha256 `6bc4ba99…7848`) and versions 2.1.233/2.1.238 are named as forbidden
alternates; a missing binary is unavailable, never substituted (source:
#94/872 F1; #94/880 G-VERSION). `sourceIsReproducibleBinaryAttestation: false`
and `backendAttestation: null` are retained because bundle strings are not
runtime proof (source: #94/872 legend).

## D-04 Dedicated config dir only (H1)

Auth mode is H1: fresh parent HOME plus a dedicated `CLAUDE_CONFIG_DIR` with a
user-performed one-time `/login`, giving its own keychain entry
`Claude Code-credentials-<sha8(CFG)>` and refresh, sharing nothing with the
user's settings/CLAUDE.md/skills/plugins/MCP (source: #94/872 F4; #94/878 §C).
H2 (shared real HOME, no `CLAUDE_CONFIG_DIR`) is **rejected by this contract**,
not merely left open: it shares the user's keychain entry, refresh,
`~/.claude.json` and `~/.claude` writes, and gate G-RACE's refresh-rotation
race is unproven either way (source: #94/880 G-RACE). The producer treats
`CLAUDE_CONFIG_DIR` present in shared mode, or missing in dedicated mode, as a
pre-spawn rejection (source: #94/879 producer contract 3).

## D-05 api_retry accepted and recorded

Research asked #95 to decide whether a completed run after `system/api_retry`
counts, recommending allowed-and-recorded (source: #94/879 F16 note; #94/880
FK5(p)/G-RETRY). Decision: **accepted**, with every retry event retained in
evidence; retries are not fatal by themselves and are not silently dropped.
Scenario F10 encodes it. The separate question of a model fallback without
`--fallback-model` stays open and is detected through `modelUsage` keys, which
are fatal on mismatch (source: #94/879 FATAL).

## D-06 Default system prompt not replaced

`--system-prompt`/`--system-prompt-file` replace Anthropic's default prompt and
were listed as "use only if #95 decides so" (source: #94/878 §A). Decision:
**do not replace**. Only `--append-system-prompt-file` is used, so the default
prompt is bound solely by the version pin, and G-DEFAULT-PROMPT stays open
rather than being widened by a replacement surface (source: #94/880).

## D-07 Never-pass list carried verbatim

The whole `Never pass` list from research §A is carried into
`launch.neverPassFlags` with `--safe-mode` kept and annotated as excluded
because its interaction with Rocky's settings semantics was unverified — an
honest omission rather than a judgment that it is safe (source: #94/878 §A).
`--add-dir` is on the never-pass list even though research mentions a possible
later need, because its directories are sandbox-writable and would break the
reviewer's read-only-source design (source: #94/878 §D).

## D-08 Denial authority

`result.permission_denials` is the authoritative, source-defined denial record
for this harness, and `system/permission_denied` is best-effort and skips the
PreToolUse-hook path (source: #94/879 F14/F15; #94/880 FK5(h)). This answers
#89/850(b) for Claude Code without inventing a denial form. Sandbox violations
that surface as ordinary Bash output stay ordinary failures per #89/850(a),
with containment resting on the independent oracle and N01–N06, never on
relabelling.

## D-09 Exit codes are not evidence

The manifest and README state that exit 0 can accompany **no result at all** in
stream-json mode and that exit is 1 only when the last result has `is_error` or
the transport closed permanently, so exit code alone never establishes success
(source: #94/879 F16 [B]). Scenarios F06(a) and F09 encode it.

## D-10 Cancellation is SIGTERM-only

SIGTERM exits 143, kills the Bash tree and leaves no result, so it classifies
unknown with no interrupt acknowledgement claimed. SIGINT frames/exit are
unobserved, so SIGINT is not used and G-SIGINT stays open (source: #94/879
F16, producer contract 4; #94/880 FK7/G-SIGINT).

## D-11 Usage mapping is a mapping, not a fork

Only `result.modelUsage` feeds the harness-reported total; `result.usage`
(main loop only) and per-message assistant usage are explicitly not action
totals (source: #94/879 F15; `docs/coordinator.md` § #90 "Per-message interim
reports are not an action total"). Subset rules are stated so thinking tokens
are never added on top of `outputTokens`, which already includes them, and
cache read/creation are separate components (source: #94/879 usage note).
`total_cost_usd` is a client estimate and `num_turns` informational; neither
becomes a receipt or budget input. Threshold, planning-charge, overrun,
`recovery_required` and CI-reserve semantics are referenced, not restated.

## D-12 Informational-only list

Todo/plan state, `total_cost_usd`, `num_turns`, `duration_ms`/`duration_api_ms`
and the requested effort are all recorded as informational in
`protocol.informationalOnly`. The todo/plan rule mirrors the #93-amended
subscription contract; research records no Claude-Code-specific
todo-synthesis behavior, so the rule is stated as a reuse of the amended
neutral rule and **not** as a pinned-source claim about Claude Code (honesty
item H-03 below).

## D-13 Deliberate omissions

- **No executable launcher, adapter, parser or checker.** The ticket scopes
  #95 to contract authoring; #97 owns fake-CLI implementation.
- **No `M` migration scenarios** (D-01).
- **No model/effort role table values.** Research requested the exact full
  model ID from #95/#90 and recorded only an example
  (`claude-opus-5-5/high`); inventing a table would be a guess, so it is open
  gate **G-MODEL** with the validation rule (producer validates effort because
  the CLI only warns; served ID comes from `modelUsage`/`assistant.message.model`)
  stated instead (source: #94/878 §A, F11).
- **No `--json-schema` request-schema content.** The schema bytes are a
  run-config input bound by sha256; only its inline canonical-minified form and
  the host re-validation duty are specified (source: #94/878 §F).
- **No native/live execution, no capability, no approval.** All 24 scenarios
  are unexecuted or blocked; G-KC is flagged blocking for the implementer role
  and echoed in `gateOrder` as a user decision, matching root comment 881.
- **Sandbox network scope** stays `[P]`: the docs conflict on whether
  `sandbox.network` is honored from CLI `--settings` ("User or managed" vs
  "user, managed, or CLI --settings"), so the manifest records the conflict
  instead of picking a side (source: #94/878 F9 bullet).
- **Settings keys whose effects were not traced** (modelOverrides/
  availableModels, env, apiKeyHelper/awsAuthRefresh/otelHeadersHelper,
  fallbackModel, pluginConfigs, statusLine, outputStyle) are prohibited rather
  than configured, per research §B (source: #94/878 §B).

## D-14 Open gates carried

All 13 gates from research PART 4 §C plus G-MODEL (14 total) are carried into
`manifest.json` `openGates` with citations, each mapped to the scenario that can
close it: G-KC → N03 (blocking, implementer), G-SET → N04, G-MANAGED →
inventory + refuse, G-HOME/G-WRITES/G-RACE → N06 (G-RACE is additionally
mooted for this contract by D-04's rejection of shared mode H2, and is carried
because the residual refresh-rotation race is unproven), G-VERSION → F01 + C1
rehash, G-INIT-VALUES → N02/L03, G-SIGINT → N05, G-RETRY → F10 (decided part) +
modelUsage fatal, G-EFFORT → L04, G-CLAUDEMD-MANAGED → inventory,
G-DEFAULT-PROMPT → D-06, G-MODEL → run config freeze. None is closed here
(source: #94/880 §C "none closed by this research").

## Honesty list: claims not groundable in #94

- **H-01** Whether `StructuredOutput` appears in `init.tools`, and whether
  `--restricted` composes with explicit `--tools`/`--setting-sources=`:
  research marks both `[P]`. Encoded as G-INIT-VALUES and probed by N02/L03;
  `successRequires` says "(+StructuredOutput where proven)".
- **H-02** Exact `init` values for skills/slash_commands under this profile:
  `[P]`; encoded as "within the approved (expected empty) set" plus
  G-INIT-VALUES.
- **H-03** No Claude-Code-specific todo/plan synthesis behavior is recorded in
  #94 (Claude Code's plan/todo tooling was not researched as a stream surface).
  The informational-only rule is therefore a reuse of the amended neutral rule,
  not a pinned-source claim about this CLI.
- **H-04** `init` does not echo effort "to local clients" [D]; whether any
  other surface reveals applied effort is unknown → G-EFFORT, L04.
- **H-05** Whether `--safe-mode` would drop Rocky's settings semantics is
  unverified; the flag is excluded for that reason, not because it is known
  harmful (source: #94/878 §A parenthetical).
- **H-06** Reviewer write-impossibility rests on tool absence and is marked
  `[P roster]` by research; N02 must observe it (source: #94/878 §D).
- **H-07** `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS=1` is `[D only]` — docs
  without bundle corroboration — so subagent suppression is also verified by
  roster denial and N01, not by the env var alone (source: #94/872 F8).
- **H-08** Prompt-consumption evidence ("init means the prompt was accepted")
  is `[P]`; N05 must confirm or replace it (source: #94/878 F12).
- **H-09** Research could not read #1 comment 863 in full (its own tool
  spilled the result into a forbidden path), so the user scope decision is
  taken from #94/#95/#97 citing it — same basis as the research record, and
  recorded here rather than assumed.
