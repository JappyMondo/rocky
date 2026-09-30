# Direct OpenCode CLI harness adapter (PoC)

Taskbot #98 implements the PoC live-harness adapter: one fresh pinned
`opencode run --format=json` invocation per agent action on the
`alibaba-token-plan/qwen3.8-max` token-plan subscription. Per the user decision
of 2026-09-29 this is a **lean PoC harness with NO protected-contract
ceremony** (#106/#107 cancelled): the adapter is implemented directly against
the #104 research bundle (ticket comments 958–965, facts F1–F27, fake-CLI
regression cases FK1–FK9, native probes NP1–NP5) and consumes the shared
harness-neutral seam `src/agents/seam.ts` (#97) exactly like the claude-code
(#97) and codex-exec (#81) adapters.

**Current evidence.** Unit/integration tests use owned fake CLI processes and real SQLite; no paid model turn was executed by the recovery session. The recovered #113 native evidence under `.qualification/opencode-hardening-112/native/` records bounded synthetic zero-turn execution of the approved 1.18.33 binary: an empty `{info,messages}` export, missing-session refusal, error-event envelopes and tool-registry responses. Those historical responses do not establish effective role rosters, successful billable stream shapes or assistant usage. Separately authorized #118 zero-turn debug-agent probes now establish the actual rendered ATT-764 role rosters after an explicit `invalid` deny repair; the genuine CFG dependency tree stayed unchanged. Both native attempts are retained privately and described in the host-admission guide. Successful billable stream/export/assistant-usage observations remain open. Root decision #113 comment 1063 approves the 1.18.33 pin and requires the remaining billable observations from the first #14 live evidence before counting live admission accepted. The earlier #104 source research was against 1.18.32 and remains historical source evidence. Conditional manifest/worker/positive-observation admission is implemented in [host admission](opencode-host-admission.md), but no approved live qualification binding ships; `capability` is always `null`; the synthetic test qualification grants nothing.
The model's final text is a **proposal only** — it never establishes checks,
CI, review or head authority (host `deriveTreeHead` only). **G-AUTHFILE
requires an explicit user decision before any live run** (see Gaps). No
credential bytes are ever read: `~/.local/share/opencode/auth.json` and the
fixture data dir's `auth.json` are inspected as metadata only (regular-file type, UID, exact mode and canonical private parents).

## Shared seam and host worker

The adapter reuses `AgentLaunchBundle`, strict decoding, protocol/usage constructors, `DuplexRunner`, Store fencing and supervised native cleanup. #118 adds an explicit observation-only waiter mode (default unchanged) so the clean per-action adapter worker cannot renew the host lease. The host alone stages source, applies results and performs Git/GitHub effects. The worker shares the original lease/fence and checks its actual clean process environment; it does not bypass poisoned-source admission. The host independently validates retained native evidence before source adoption or publication. See [host admission](opencode-host-admission.md) for the bounded handshake, cancellation and first-live requirements.

## Pinned identity and launch bundle

- **Binary (F1/F2):** absolute Cellar path
  `/opt/homebrew/Cellar/opencode/1.18.33/bin/opencode`, sha256
  `139ddeb6a46ba276827bb8f79c7b28208621746e4fd6914d9ae71cc1a0a57524`,
  144,800,738 bytes, version `1.18.33` (root #113 decision 1063). Never the `/opt/homebrew/bin` symlink.
  Re-measured at C0 (prepare), C1 (inside the guarded start) and C5
  (settlement); missing/drift ⇒ profile **unavailable**, never substituted.
- **Argv (F9/F10, PART 4 §1):** exactly
  `[run, --format=json, --model=alibaba-token-plan/qwen3.8-max, --agent=rocky-<role>, --dir=<SRC>]`.
  Every option a single element; the prompt is **never** positional — it is
  delivered as exact bytes on stdin, read-to-EOF by the child, once, with a
  single EOF and no resend after ambiguity. `assertOpencodeArgv` re-audits the
  composed argv and rejects the never-pass list (`--auto`/`--yolo`/
  `--dangerously-skip-permissions`, `--continue`/`--session`/`--fork`,
  `--share`/`--attach`, `--password`/`--username`/`--port`,
  `--interactive`/`--mini`/`--demo`, `--command`/`--file`, `--variant`,
  `--thinking`, `--print-logs`/`--log-level`, `--pure` as a flag, `--title`).
- **Sealed env (F6/F14, PART 4 §1):** a positive allowlist of exactly 20
  entries — private `HOME`/`TMPDIR`, `PWD=<SRC>`, minimal `PATH`, `LANG`,
  `XDG_CONFIG_HOME`/`XDG_CACHE_HOME`/`XDG_STATE_HOME` (fresh per action),
  `XDG_DATA_HOME` (the Rocky-owned dedicated data dir), `OPENCODE_DB`
  (per-action isolated DB), `OPENCODE_MODELS_PATH` (pinned catalog),
  `OPENCODE_CONFIG_CONTENT` (the sealed config, the ONLY config source) and
  the disable set (`OPENCODE_DISABLE_PROJECT_CONFIG`,
  `OPENCODE_DISABLE_MODELS_FETCH`, `OPENCODE_DISABLE_AUTOUPDATE`,
  `OPENCODE_DISABLE_DEFAULT_PLUGINS`, `OPENCODE_DISABLE_CLAUDE_CODE`,
  `OPENCODE_DISABLE_EXTERNAL_SKILLS`, `OPENCODE_DISABLE_PRUNE`,
  `OPENCODE_PURE`). Nothing is inherited. A source environment carrying any
  forbidden key refuses pre-spawn (names only): provider key families
  (`ALIBABA_TOKEN_PLAN_API_KEY`, `OPENAI_*`, `ANTHROPIC_*`, `DEEPSEEK_*`, …,
  any `*_API_KEY`), auth-store/config injection (`OPENCODE_AUTH_CONTENT`,
  `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`, `OPENCODE_MODELS_URL`,
  `OPENCODE_SERVER_*`), `XDG_*` overrides, proxy/TLS vectors
  (`*_PROXY`/`NO_PROXY`/`ALL_PROXY`/`NODE_EXTRA_CA_CERTS`), `OTEL_*`,
  `SSH_AUTH_SOCK`.
- **Sealed config content (F13–F18):** canonical strict JSON rendered by the
  adapter and independently re-audited (`assertOpencodeConfigContent`):
  `enabled_providers:["alibaba-token-plan"]` (no side-call can route to another
  provider), `small_model` pinned to the same on-table model,
  `share:"disabled"`, `autoupdate:false`, `snapshot:false`,
  `subagent_depth:0`, and both role agents with `model`/`prompt`/`steps`/
  `permission` exactly per the role table. Prohibited keys refuse (`mcp`,
  `plugin`, `instructions`, `provider`, `default_agent`, `tools`, `formatter`,
  `lsp`, `skills`, `experimental`, `hooks`); duplicate keys refuse
  (strict parse); `{env:…}`/`{file:…}` substitution substrings refuse
  anywhere. **The agent `prompt` REPLACES the default system prompt (F15,
  G-DEFAULT-PROMPT): the sealed prompt bytes are the WHOLE system prompt.**
- **Roles (F17/F18):** implementer — `edit`/`bash`/`read` allowed,
  `task`/`webfetch`/`websearch`/`skill`/`question` denied,
  `external_directory` DENY (cwd-containment explicit and observable as tool
  errors). Reviewer — `'*':'deny'` + `read`/`glob`/`grep`/`list` allow: the
  denied tools are **removed from the model's roster entirely** (tool absence),
  so read-only is genuinely enforceable; any off-roster `tool_use` observed in
  the stream is a contract violation (POLICY), never an ordinary failure.
  `agent.steps` is the max-turns analogue.

## Auth and data-dir isolation (root decision, provisional)

Auth is a plain 0600 file (`$XDG_DATA_HOME/opencode/auth.json`, F3/F7). The
root decision from the #104 acceptance (routine-choice authority; **user may
veto**) is encoded as the only representable mode:

- `dataHome` is a **dedicated Rocky-owned directory** named by host config,
  with **one-time user-assisted auth provisioning** into it. The adapter
  **never reads, copies, symlinks or proxies** `auth.json`; it records only
  path-existence metadata (`authProvisioned`).
- **Provisioning procedure (user-performed, documented, NOT implemented
  here):** create the Rocky-owned data dir (0700); once, with
  `XDG_DATA_HOME=<dataHome>`, run the real `opencode auth login --provider alibaba-token-plan` for the
  `alibaba-token-plan` provider as the user; verify
  `<dataHome>/opencode/auth.json` exists (0600). Live runs additionally require
  the explicit user G-AUTHFILE decision below.
- **Shared-user-data-dir mode is unrepresentable:** a `dataHome` equal to,
  inside, or containing `~/.local/share/opencode` refuses
  (`opencode-shared-user-data-dir`, including realpath aliases); a missing
  (unprovisioned) data dir refuses. Per action, `XDG_CONFIG_HOME`/cache/state
  are fresh inside the RUN tree and `OPENCODE_DB` is a per-action file, so
  sessions never share the DB even though the data dir is shared across the
  run. (Interpretation note: #104's "per run-tree" data dir is realized as a
  host-config-level dedicated dir because auth provisioning is one-time;
  flagged for the reviewer.)
- Isolation admission also refuses: any present **managed layer** (F13 7/8 —
  `/Library/Application Support/opencode/*`, the MDM plist; cannot be
  overridden by config), catalog absence/hash drift, and staged-tree impurity
  (`AGENTS.md`/`CLAUDE.md`/`CONTEXT.md`/`opencode.json(c)`/`.opencode`/`.git`
  in SRC or ancestor `.git`) — all re-inventoried at C1 and C5, drift ⇒
  unresolved/unknown.

## Stream contract and settlement

`run --format=json` emits NDJSON `{type, timestamp, sessionID, part|error}`
with the CLOSED event set `{tool_use, step_start, step_finish, text,
reasoning, error}` (F19; every emit site). There is **no result/done event**
(F21): completion is the conjunction of clean strict decode (bounded, fatal
UTF-8, duplicate-key and partial-line rejection), both carrier EOFs + child
EOFs + decoder completion + physical quiescence, exit 0, ≥1 completed text
part, zero `error` events, no policy violation, a host-revalidated final, and
the **mandatory post-run export audit**. Classification (PART 4 §3):

- **complete** — the full conjunction holds; the LAST text part parses
  strictly against the protected final schema and the action/input/role
  binding (F27 route (a); success without a parseable final is failure; two
  competing schema-shaped finals refuse; tool activity after the final
  refuses). Outcome comes from the proposal; head is host-derived.
- **policy-denied** — a tool error whose text matches a permission-refusal
  shape (`PermissionRejectedError`/rejected-permission wording; run
  auto-rejects every ask, F12) or any off-roster `tool_use`.
- **fatal** — any `error` event (F21 forces exit 1), malformed NDJSON
  (garbage line, duplicate key), nonzero exit with zero events + stderr
  (startup refusal), export-audit served-identity mismatch
  (modelID/providerID/version/directory/assistant-error).
- **unresolved** — truncated stream, unknown event type (drift tripwire),
  missing EOF/quiescence, exit 0 without a text part, nonzero exit without an
  error event, session-ID anomalies, export audit unavailable (spawn failure,
  timeout, parse/shape failure, missing session), isolation drift.
- **interrupted** — decided by the adapter from cancellation/deadline/
  lease-loss/recovery facts; late stdout after cancel is ignored and no
  interrupt acknowledgement is ever claimed (G-SIG).
- A tool error that is an **ordinary** failure (test failure, edit mismatch)
  is settled-ordinary: recorded, and a later good final is still accepted.

**Export audit (F25, required success conjunct).** After quiescence the
adapter spawns `opencode export <sessionID>` as a bounded second child (same
pinned binary, same sealed env, same isolated `OPENCODE_DB`, timeout +
maxBuffer) and strictly parses the pinned `{info, messages}` envelope (source
`cli/cmd/export.ts`; pretty JSON, stdout-only). It recovers what the live
stream cannot: served **modelID/providerID** per assistant message (mismatch
⇒ fatal), **version** echo vs the pin, **directory** vs SRC, and **aggregate
tokens**. Raw export bytes are retained 0600 in the RUN tree; the usage
receipt is their sha256. Export unavailability is never success.

## Usage → #90 schema 2

Reported totals come ONLY from the export aggregate (assistant-message token
sums): `reported` with subset semantics (`cachedInput`/`cacheWriteInput`
subsets of `input`, `reasoningOutput` a subset of `output` — never added
twice); `ambiguous-zero` when the aggregate is all-zero on a complete audited
stream (never a known zero); `unknown` for interrupted/unresolved lifecycles,
unavailable/fatal export audits, export-vs-`step_finish` (or
`SessionInfo.tokens`) divergence, missing `step_finish` telemetry, or
inconsistent subsets. The `cost` field is a zero-priced client-side catalog
estimate (F4/F25) and is **never** consumed or a receipt. The adapter retains unknown/ambiguous usage honestly. Live observation and host adoption refuse it before copying or committing source; the reducer retains its unknown-success barrier for diagnostic/fake settlements (P08).

## Gaps and gates (honest, recorded in every receipt)

| Gate               | Status                                                                                                                                                                                                                                                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **G-AUTHFILE**     | auth.json is a plain 0600 file; bash-obfuscation reachability unprobed (F7 [P], NP3). **NOT decided by the user — an explicit user decision is REQUIRED before any live run.** The Claude D-15 keychain acceptance does NOT transfer.                                                                                  |
| G-SIG              | Signal semantics unprobed (F24 [P]); SIGTERM-only, exit-by-signal ⇒ unknown, no interrupt ack ever claimed.                                                                                                                                                                                                            |
| G-USAGE-COMPONENTS | Whether export aggregate `output` already includes reasoning/cache components is unproven (F25 [P], NP5); subsets pass through as observed, never summed.                                                                                                                                                              |
| G-NPM              | Config bootstrap can install `@opencode-ai/plugin` into config dirs (F14b). #118 now pre-materializes a genuine pinned full tree/lock and verifies it; actual zero-turn startup preserved that tree. In-process network exclusion/full write oracle remain deferred.                                                   |
| G-DEFAULT-PROMPT   | Agent prompt REPLACES the default system prompt; the sealed bytes are the whole prompt (F15).                                                                                                                                                                                                                          |
| G-ROSTER           | Actual #118 rendered-role debug-agent probes establish effective availability: implementer bash/read/glob/grep/edit/write/todowrite; reviewer read/glob/grep. The rejected first attempt exposed `invalid` and drove an explicit deny. Successful-turn tool/error shapes remain unobserved.                            |
| G-MANAGED          | Managed/MDM layers absent at inventory; unhighest-overridable; presence ⇒ unavailable (F13).                                                                                                                                                                                                                           |
| G-EXPORT-AUTHORITY | Export is a second process against the same isolated DB after quiescence; WAL ordering/locking [P].                                                                                                                                                                                                                    |
| G-EFFORT           | No `--variant` passed; effort is requested-only elsewhere, never echoed.                                                                                                                                                                                                                                               |
| G-WRITES           | Data/config-dir write growth (logs, auto-seeded config) is recorded in the receipt inventory, not natively bounded.                                                                                                                                                                                                    |
| NP1–NP5            | Bounded #113 export/error probes and #118 effective-roster/config/dependency-startup observations are retained. Successful billable stream/export/assistant usage, authfile reachability and full native lifecycle remain open. Decision 1063 defers billable-only observations to #14 before accepted live admission. |
| LIVE               | Live qualification is #14 only, additionally gated on the explicit user G-AUTHFILE decision.                                                                                                                                                                                                                           |

## Tests

`tests/opencode-{launch,protocol,lifecycle}.test.mjs` (21 tests: 7 X + 9 P + 5
L) over `tests/opencode-support.mjs` and the owned fake CLI
`tests/fixtures/opencode-fake-cli.mjs` — real spawned processes, real SQLite
stores, artifacts under `.qualification/opencode-98/artifacts`. Coverage map:
FK1 identity/binding (X01, X07, L04), FK2 serializer (X02, X04), FK3
forbidden env/flags/roles (X02, X03), FK4 stdin (X07, L03), FK5 stream
classification (P04–P07), FK6 usage (P01, P08), FK7 cancel (L01), FK8 drift
(L05, P03), FK9 export plumbing (P02, P03, P09), isolation fail-closed (X05,
X06), deadline (L02), restart reconciliation + no-resend (L03, L04).

The #118 clean worker and conditional host manifest add metadata-only auth admission, genuine dependency pre-materialization, immutable export/receipt retention, transactional export start, and independent host observation checks. Bounded native zero-turn roster and unchanged genuine dependency startup are now observed; first paid-turn stream/export/usage shapes remain pending; see [the complete admission procedure](opencode-host-admission.md).
