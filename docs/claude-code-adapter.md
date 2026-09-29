# Claude Code CLI harness adapter and the harness-neutral agent seam

Taskbot #97 implements the first production-shaped harness adapter: one fresh
pinned Claude Code `claude -p --output-format stream-json` invocation per agent
action, bound to the frozen
[`rocky-claude-code-95-v1` contract](../acceptance/claude-code/README.md), plus
the small harness-neutral input/result seam in `src/agents/seam.ts` that the
future codex exec (#81) and OpenCode (#98) adapters reuse. The architecture
note [claude-code-harness.md](architecture/claude-code-harness.md) remains the
decision record; this page describes the implementation.

**Status honesty up front:** `qualification=false`, `capability=null`,
`executionAuthorized=false` in the frozen contract are unchanged by this
package. The adapter ships **no approved qualification binding and no loader**;
it requires an explicitly host-frozen `ExecutionQualification` and refuses to
run without one. Everything here is validated with an **owned fake CLI**
(evidence class `owned-fake-cli`): synthetic native qualification (N01–N06) and
live-subscription proof (L01–L04) are separately granted root steps, and the
open gates G-SET, G-MANAGED, G-HOME, G-INIT-VALUES, G-MODEL, G-EFFORT,
G-SIGINT, G-WRITES, G-VERSION and the user-accepted G-KC limitation all remain
open and are recorded as receipt gaps on every run. The model's structured
final is a **proposal only**: it never establishes checks, CI, review, head
adoption or delivery authority.

## The harness-neutral seam (`src/agents/seam.ts`)

Shared, adapter-agnostic shapes (nothing Claude-specific):

- `AgentLaunchBundle` / `sealAgentLaunchBundle` — the immutable audited launch
  bundle: pinned `BinaryIdentity`, exact argv elements, a sealed ordered
  `[key, value]` environment allowlist, cwd, input byte count + sha256,
  rendered input-file bindings and a discovery digest, all bound by a
  `bundleDigest`.
- Input delivery — one-shot raw UTF-8 bytes written once, then a single EOF,
  over the **existing** duplex transport's durable attempted-before-IO
  semantics (`Store.queueDuplexText`, reused not forked: identical conflict,
  claim/attempt-latch and no-resend rules as JSON sends).
- `StrictNdjsonDecoder` / `parseStrictJson` — bounded strict newline-delimited
  JSON: incremental fatal UTF-8 (fragmented multibyte sequences decode
  identically), per-line/total/frame bounds, duplicate-key rejection and no
  silently discarded trailing partial line. The transport-level gate decoder
  keeps its existing JSON-lines framing; protocol-grade strictness is the
  seam's job because both the Claude (#95) and codex (#81) contracts require
  duplicate-key rejection.
- `AgentSettlement` / `settlementToResultEvent` — terminal settlement with
  classification `complete | unresolved | policy-denied | fatal | interrupted`,
  coordinator outcome, quiescence, host-derived head, detail and the validated
  proposal, mapped onto the existing transport `result` event.
- Usage constructors `reportedHarnessUsage` / `ambiguousZeroHarnessUsage` /
  `unknownHarnessUsage` — the #90 `subscription-observed-v1` schema-2 statuses
  with subset semantics (`cachedInput`/`cacheWriteInput` ⊆ `input`,
  `reasoningOutput` ⊆ `output`; subsets never added twice; all-zero is never a
  known zero).
- `validateAgentPrompt` — pre-spawn prompt rules: exact bytes + digest,
  BOM/invalid-UTF-8/empty/whitespace-only/over-limit rejection.
- `deriveTreeHead` — the coordinator result head, derived by the **host** from
  a canonical walk digest of the staged tree; never from a model message.

Narrow seam-preserving extensions to existing owned code (each required by the
frozen contract):

| File                   | Change                                                                                                                                                                                   | Why                                                                                                                                                         |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/runner/index.ts`  | optional sealed `env` on `CommandSpec` + `validateSealedEnvEntries`                                                                                                                      | CC02: the child environment must be an exact positive allowlist with nothing inherited                                                                      |
| `src/runner/gate.ts`   | spawn with `spec.env` verbatim when present; re-measure a bound `binaryIdentity` (path/sha256/size, symlink refusal) inside the guarded start; durable named failure on drift            | CC01/CC12: C1 admission rehash with zero spawn on drift                                                                                                     |
| `src/runner/duplex.ts` | `DuplexBinding.binaryIdentity`, `DuplexStartExtra` (binary identity + bundleDigest joined into the invocation identity), `DuplexRunner.sendText`, frameBytes bound raised 1 MiB → 10 MiB | CC05: the contract admits a one-shot prompt up to min(config, 10 MB) as a single frame; the bundle digest must participate in invocation-conflict detection |
| `src/store/index.ts`   | `queueDuplexText` (exact raw UTF-8 wire, no JSON framing) sharing the existing durable send machinery; `binaryIdentity` shape validation at reservation                                  | CC05: exact-bytes-once stdin with attempted-before-IO and no resend                                                                                         |
| `src/index.ts`         | export `agents/seam.js` and `agents/claude-code/index.js`                                                                                                                                | the export seam                                                                                                                                             |

Default (non-duplex and existing duplex) behavior is byte-identical: the env
fallback, the request-identity composition and the JSON send path are
unchanged when the new optional fields are absent.

## The adapter (`src/agents/claude-code/`)

`ClaudeCodeAdapter` implements `CoordinatorTransport` (`capability` is always
`null`; `qualification`/`versions` come from fail-closed validated config).
Lifecycle per action, mirroring the contract's C0–C5 producer checkpoints:

- **C0 `prepareLaunch(action, {prompt, stage?})`** — synchronous, zero-spawn
  on any rejection: role from the work kind (implementer for
  implement/repairs, reviewer for review/arbitrate; non-agent and strict-mode
  actions refuse); poisoned-source-env scan (any forbidden key present in the
  configured source environment refuses pre-spawn — names only, values are
  never logged); prompt validation; pinned-binary identity (absolute path,
  symlink refusal, host-measured sha256/size, version pinned to 2.1.283 —
  missing/drifted binary makes the profile **unavailable**, never
  substituted); a fresh per-action RUN tree (canonical realpath layout, 0700,
  pairwise non-overlapping grants, SRC/SCR/PH/PT/INP/LOGS); discovery
  inventory (managed/MDM/server-managed presence refuses, dedicated-configDir
  forbidden children refuse, staged tree + all ancestors free of
  `CLAUDE*.md`/`AGENTS.md`/`.claude`/`.mcp.json`/`.git`); settings rendering
  (canonical, duplicate-key-rejected, prohibited-key-rejected, 0400,
  hash-bound); exact argv composition (one `--opt=value` element per option,
  pinned order, never-pass flag rejection, effort table validation because the
  CLI would only warn, role rosters, reviewer `--restricted`, no positional
  prompt); the sealed env allowlist; and the `bundleDigest`. Re-preparing an
  identical action is idempotent; a changed bundle for the same action is a
  named conflict.
- **C1 `begin(action)`** — synchronous initiation inside the dispatch guarded
  start: source-env rescan, full bundle-drift recomputation (INP file rehash,
  argv/env/spawn-binding equality, prompt digest, discovery re-inventory,
  staged-tree head equality — one-byte drift yields zero spawn), then the
  existing durable start (`DuplexRunner.start` with the binary identity and
  bundle digest bound into the invocation identity). The gate re-measures the
  binary hash inside its own guarded spawn transaction.
- **C3 input** — the exact prompt bytes are queued once
  (`queueDuplexText`), then a single EOF send; durable attempted-before-IO,
  conflict detection and no-resend-after-ambiguity come from the existing
  duplex send machinery. Consumption is evidenced **only** by `system/init`;
  an exit-before-read or silently buffered write stays attempted-unknown.
- **C4 observation** — the supervisor/gate bounded raw capture and transport
  framing run unchanged; the adapter independently re-decodes the retained raw
  stdout with `StrictNdjsonDecoder` and classifies with
  `classifyClaudeStream`: the reviewed frame allowlist (unknown types/subtypes
  reject), init identity conjunction, `tool_use`/`tool_result` pairing with
  unique ids, `result.permission_denials` as the authoritative source-defined
  denial form, off-roster tool denials, declined StructuredOutput, assistant
  error/abort classes, api_retry acceptance with recording (decision D-05),
  exactly-one-result and result_index continuity, no post-result frames, the
  exit-code matrix (exit 0 without result is **not** success; exit 1 iff the
  last result `is_error` or transport closure) and separated EOF/quiescence
  facts. Settled ordinary tool failures (including sandbox denials surfacing
  as ordinary Bash output) are recorded and do not alone reject a later
  correctly bound proposal (#89/850(a)).
- **C5 settlement** — post-run re-inventory (managed/MDM/server-managed
  presence, dedicated-configDir children names, staged-tree/ancestor
  instruction files) and binary re-measurement; any drift makes the result
  stale/unknown, never success. Cancellation (SIGTERM to the owned group via
  the existing supervisor), deadline, lease loss and recovery-required settle
  as `interrupted` with unknown usage; a late result after cancel is ignored
  and no interrupt acknowledgement is ever claimed. The structured final is
  re-validated against the frozen
  [final schema](../acceptance/subscription/final.schema.json) semantics and
  the action/input/role binding; `success` without `structured_output` is
  failure. The head is re-derived from the staged tree. A receipt covering the
  manifest `receiptRequirements` (contract hashes, C0/C5 binary measurements,
  bundleDigest, auth-home mode with nonsecret keychain-service derivation
  only, pre/post discovery inventories, init identity, ordered bounded stream
  evidence with truncation reasons, result fields with raw modelUsage and its
  sha256, attempt/evidence-class identities, separated exit/EOF/quiescence
  records, usage outcome, timestamps/deadline/limits and honest gate gaps) is
  written 0600 beside the command logs.

Auth: subscription OAuth belongs to the CLI parent only. Rocky never reads,
copies, symlinks or proxies credentials; the dedicated `CLAUDE_CONFIG_DIR`
isolation, the sealed environment and the forbidden-env regression assertions
carry the exclusivity proof, with `init.apiKeySource=="none"` and
`modelUsage[*].provider=="firstParty"` as nonsecret post-hoc signals only. The
G-KC keychain exposure remains an explicit **user-accepted limitation**
(2026-09-28, #95/883, #1/884), not a containment claim.

## Usage mapping onto `subscription-observed-v1` (docs/coordinator.md § #90)

Usage comes only from `result.modelUsage` of the single terminal result:

- **reported** — positive valid counts for the requested model with provider
  `firstParty`: `input = inputTokens`, `output = outputTokens` (already
  includes thinking), `cachedInput = cacheReadInputTokens`,
  `cacheWriteInput = cacheCreationInputTokens`,
  `reasoningOutput = thinkingTokens`; subsets are never added twice. The
  receipt is the sha256 of the retained raw result line. `total_cost_usd` and
  `num_turns` stay informational and never become receipts or budget inputs.
- **ambiguous-zero** — all-zero or absent `modelUsage` on an otherwise
  complete success run. The coordinator's unknown-success barrier and
  `recovery_required` stop apply unchanged; the head is not adopted.
- **unknown** — interrupted/truncated telemetry, zeroed crash or
  fatal-startup results, SIGTERM with no result, invalid counts
  (negative/fractional/unsafe/inconsistent subsets) and any unresolved
  lifecycle. A fatal observation (auth signal, provider, fallback model key,
  version drift, startup failure) blocks usage mapping entirely: such runs
  never report subscription usage. Zero is never fabricated.

## Requirement coverage (CC01–CC12)

| Req  | Implementation                                                                                 | Tests (owned fake CLI, real processes + SQLite) |
| ---- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| CC01 | pinned identity in `config.ts`/`prepareLaunch`; gate C1 rehash; symlink/refusal rules          | `claude-code-launch` X01, X09                   |
| CC02 | `env.ts` sealed allowlist + forbidden scan; dedicated CFG; nonsecret signals in `stream.ts`    | X04, P06                                        |
| CC03 | `argv.ts` template/rosters/never-pass/effort table                                             | X02, P03/P03b                                   |
| CC04 | `settings.ts` + `discovery.ts` inventories and refusals; C5 drift                              | X03, X06, L06                                   |
| CC05 | `validateAgentPrompt`; `queueDuplexText`; init-only consumption evidence                       | X05, L04, L08                                   |
| CC06 | `StrictNdjsonDecoder` + `classifyClaudeStream` allowlist/pairing/bounds                        | P02, P05, P07, P07z                             |
| CC07 | `final.ts` re-validation + binding; success-without-output failure                             | P01, P04(d/e)                                   |
| CC08 | classification classes incl. authoritative `permission_denials` and ordinary-failure retention | P04–P06, P08                                    |
| CC09 | exit-code matrix; SIGTERM-only cancel; separated EOF/exit/quiescence                           | P04(a/b/f/g), L01–L03, L05                      |
| CC10 | `usage.ts` schema-2 mapping                                                                    | P09, P01                                        |
| CC11 | informational-only handling (todo/plan text, cost, turns, effort)                              | P09(plan), P01                                  |
| CC12 | C0–C5 lifecycle, one spawn per action, drift/rollback/restart reconciliation, receipts         | X07–X09, L07–L12                                |

## Honest limitations and remaining gates

- **Not qualified.** No native (N01–N06) or live (L01–L04) scenario is
  executed or implied. The fake CLI proves the adapter's protocol discipline,
  not the real binary's behavior; G-INIT-VALUES expectations (exact init
  tools/skills/slash_commands, StructuredOutput visibility, `--restricted`
  composition) and G-MODEL role-table IDs are host-frozen config approvals,
  recorded as receipt gaps, awaiting native/live evidence.
- **C5 mid-run binary drift has no e2e mutation test.** Detection code and
  settlement-time measurement exist (C5 rehash plus the drift-comparison path,
  which covers the C5 logic), and C1 drift is end-to-end tested, but no test
  mutates the pinned binary mid-run and asserts the C5 outcome end to end.
  Tracked in follow-up ticket #102.
- **Real-binary (~225 MB) hash performance: chunked, measured on synthetic
  files, not yet on the real binary.** `measureBinaryIdentity` now hashes in
  bounded 4 MiB chunks (synchronous, constant memory, safe inside the
  guarded-start transaction) instead of buffering the whole file. On the dev
  machine (Apple M3, warm page cache) a 225 MB synthetic file measured
  ~88 ms median chunked vs ~105 ms median for the old whole-file buffer, with
  peak RSS delta ~4 MB vs ~225 MB; a 4 KiB file is ~0 ms either way (evidence:
  `.qualification/binary-hash-perf-102/`). The C1 in-transaction cost at real
  binary size is therefore bounded and small (~90 ms class on this hardware),
  but this was measured on synthetic zero-filled and random files on a dev
  machine, not on the actual pinned binary in the qualification environment;
  native/live qualification still re-measures there. Ticket #102.
- **G-SET / G-MANAGED / G-HOME / G-WRITES / G-VERSION / G-SIGINT / G-EFFORT /
  G-DEFAULT-PROMPT** stay open exactly as the contract records them; the
  adapter fail-closes around each (settings audit + inventory refusals,
  SIGTERM-only cancellation, requested-only effort).
- **G-KC** is a user-accepted visible limitation, restated in every receipt.
- **Discovery inventory paths are host config inputs.** Defaults are the
  documented system locations; owned synthetic environments substitute
  explicit paths. The receipt records exactly which paths were inventoried.
- **Cancelled-run child exit detail**: the existing supervisor deliberately
  drops late child-exit messages once cleanup starts, so a cancelled receipt
  records the durable `cancelled` outcome, revocation and quiescence rather
  than the child's exact signal; the SIGTERM→143 mapping is pinned native CLI
  behavior gated by N05 and is never fabricated here.
- **Darwin child-runtime artifact**: a spawned child's own CoreFoundation may
  set `__CF_USER_TEXT_ENCODING` inside the child after exec (uid-derived, not
  inherited). The exec-time environment equals the sealed allowlist exactly;
  tests assert this and tolerate only that named artifact.
- **Escaped descendants** (setsid + closed pipes) remain outside owned-group
  quiescence proof, as documented for the duplex transport; an unfinalized
  child stream is never transport success (L05).

## Validation

`npm run typecheck && npm run build && npm test` under pinned Node v24.16.0.
Adapter tests live in `tests/claude-code-{launch,protocol,lifecycle}.test.mjs`
with the owned fake CLI in `tests/fixtures/claude-code-fake-cli.mjs` and
support in `tests/claude-code-support.mjs`; artifacts retain under
`.qualification/claude-code-97/` (or `CLAUDE_ARTIFACT_ROOT`).
