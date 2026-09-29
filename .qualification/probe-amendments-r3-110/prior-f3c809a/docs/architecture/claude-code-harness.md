# Claude Code harness decision

User scope decision #1/863 (Taskbot #94 body): Claude Code CLI is the first
harness after the accepted direct-subscription Codex contract. The protected
[`rocky-claude-code-95-v1` contract](../../acceptance/claude-code/README.md) is
the normative acceptance boundary for it. Its qualification is false and
capability null. This document grants no native, auth, login, account, model,
target or remote execution. It mirrors
[subscription-harness.md](subscription-harness.md) for the Claude Code
specifics and reuses the harness-neutral seam — immutable invocation → observed
result/usage/quiescence — by reference.

The candidate is one fresh pinned Claude Code 2.1.283 `claude -p` invocation
per action, headless `--output-format=stream-json --verbose`, spawned at the
absolute versioned binary path with a host-measured hash re-checked at guarded
start, never the auto-update symlink and never the Homebrew 2.1.236 build
(source: #94/872 F1). Keep the existing owned runner, durable action identity,
synchronous guarded start, fences, raw-output collection and physical cleanup;
add only the sealed positive-allowlist environment, the one-shot raw UTF-8
stdin plus single EOF, and the stream-json interpreter bound in the contract.
A crash around input/start/final/cancel reconciles without blind replay, and
prompt consumption is evidenced only by `system/init` (source: #94/878 F12).

Auth is subscription OAuth only. Rocky does not read, copy, symlink or proxy
tokens: the run uses a dedicated `CLAUDE_CONFIG_DIR` with a one-time
user-performed `/login`, whose keychain entry is suffixed by the config-dir
hash and therefore separate from the user's own login (source: #94/872 F4).
Because `ANTHROPIC_API_KEY` is always honored in `-p` without approval and
provider/token/profile env vars outrank subscription OAuth, the sealed
environment forbids every `ANTHROPIC_*`/`CLAUDE_CODE_USE_*`/token-bearing key,
and settings `env`/`apiKeyHelper` routes are closed by `--setting-sources=`
plus a Rocky-owned allowlisted `--settings` file (source: #94/872 F2; #94/878
§B/§C). `init.apiKeySource=="none"` and `modelUsage.provider=="firstParty"`
are retained as nonsecret post-hoc signals only. The model-reachable keychain
risk (Seatbelt allows SecurityServer/securityd mach lookups) is gate G-KC,
**decided**: the user accepted the risk on 2026-09-28 (#95/883, #1/884), so the
contract records it as an explicit, user-accepted visible limitation — not a
qualified containment claim. No separate macOS user and no probe are required
before proceeding; synthetic proof N03 remains optional defense-in-depth
evidence; all other protections above remain required; the decision is
revisited if the deployment moves to a shared/multi-user host (source:
#94/872 F5; #94/880; decision D-15).

Instruction discovery is sealed, not merely ignored: no user/project/local
settings layers, no CLAUDE.md/AGENTS.md/.claude in the staged tree or any
ancestor, hooks/plugins/skills/subagents/MCP/auto-memory/background tasks off
via the pinned controls, and a fail-closed managed/MDM/server-managed
inventory — managed layers cannot be disabled, so any presence refuses the
profile (source: #94/872 F6–F8). Invalid `--settings` are silently ignored in
`-p`, so settings bytes are canonical and hash-bound and gate G-SET requires a
native positive control (source: #94/872 F6; #94/880 NP4).

Roles: implementer Bash/Read/Edit/Write/Glob/Grep with the Seatbelt sandbox
confined to the staged source and scratch, no network; reviewer
Read/Glob/Grep with `--restricted`, no shell and no `--add-dir`, so writes are
impossible by tool absence (source: #94/878 §A/§D). Both roles use
`--permission-mode=dontAsk` with `--permission-prompts=none` and the fixed
tool deny list; denials are observed from the authoritative
`result.permission_denials` record, and sandbox denials surfacing as ordinary
Bash output stay ordinary failures per #89/850(a) with containment resting on
the independent oracle.

The structured final arrives via `--json-schema` as the synthetic
`StructuredOutput` tool pair in `result.structured_output`; the host always
re-validates it against the harness-neutral
`acceptance/subscription/final.schema.json` (reused by reference) and the
action/input/role binding. `success` without `structured_output` is failure
(source: #94/878 F10).

## Production adapter path, not implemented here

The `subscription-observed-v1` budget mode already exists in the coordinator
(schema 8 / snapshot schema 4, `docs/coordinator.md` § #90) and explicitly
anticipates this harness: agent results report `usage.schema: 2` with
`source: "native-harness-telemetry"`, and the adapter normalizes "Claude
Code's final result usage" into the reported/ambiguous-zero/unknown subset
semantics. No new coordinator migration is required for the budget mode
itself; what remains is the separately leased Claude Code adapter (spawn
bundle, stream interpreter, usage mapper) plus its independently approved
qualification binding `{ schema: 1, id, harness: "claude-code", contractId:
"rocky-claude-code-95-v1", budgetMode: "subscription-observed-v1", binding:
sha256 }` — a null qualification blocks agent work, and this package ships no
loader and no approved binding (source: docs/coordinator.md § #90).

Sequence: independent static contract review of #95 → user decision on G-KC
(satisfied — recorded 2026-09-28: risk accepted, #95/883, #1/884) →
adapter work with owned fake-CLI evidence (F01–F14) → separately authorized
synthetic-native qualification in a disposable environment (N01–N06) →
separately authorized live-subscription proof with explicit user authorization
(L01–L04) → independently bound admission → production use under the existing
budget stops. The codex subscription contract, its scenarios and the
historical gateway artifacts keep their original meanings and outcomes; a
Claude Code pass never marks a codex or gateway gate passed.

Source basis: Taskbot #94 research comments 872/878/879/880 (root accept 881),
whose own sources are official code.claude.com docs fetched 2026-09-28,
read-only strings of the pinned binary sha256 `d8cb1e5c…d21e`, and the
anthropics/claude-code CHANGELOG. Source correspondence, installed-binary
identity and live backend attestation remain deliberately separate claims.
This note grants no execution and passes no scenario.
