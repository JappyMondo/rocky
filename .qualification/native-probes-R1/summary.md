# R1 native probe batch — SUMMARY (Taskbot #108, sole mutation lease)

Plan: #105 comments 954-957, root-accepted #968. Frozen at HEAD 651b1481c0962be528744888eb010c65ecf5bf9c.
Build: buildId df430fcc6ecaf8652c29e564377c0c7ca4a0adb12deda5e318cb713247db9f19 (sourceDirty false), node v24.16.0, macOS 26.6.2 arm64.
Drivers hashed BEFORE first spawn: drivers.sha256 (+ two documented post-freeze addenda for the remediation re-run and the
json-schema diagnostic). Evidence: probes/<id>/{verdict.md,verdict.json,meta.json,*.log,inventories/}. Consumed list: consumed.md.

## Verdict table (probe → tier → verdict → gate/scenario fed → notable observation)
| probe | tier | verdict | gate/scenario fed | notable observation |
|---|---|---|---|---|
| CC-P0 | precond | PASS | G-VERSION | claude 2.1.283 measured sha256 d8cb1e5c…d21e / 225036032B = pin. ~/.local/bin/claude symlink drifted → 2.1.284 (NEVER spawned). |
| CX-P0 | precond | PASS | G-VERSION | codex 0.157.1 measured sha256 27ceb5f9…6a7d / 238223808B = pin. |
| CC-P1 | A | PASS | N01 / CC04 / G-MANAGED | Named pre-spawn refusals: claude-config-dir-forbidden + claude-instruction-files-present + claude-managed-layer-present; prepareLaunch zero-spawn (no INP rendered, 0 command rows); SessionStart-hook sentinel untouched. Real-host managed/MDM layers ALL ABSENT (lstat names only). |
| CC-P7i | A | PASS | N05 10MB cap (adapter half) | prompt-over-limit pre-spawn (0 command rows); validateClaudeCodeConfig rejects maxPromptBytes>10MB (invalid-claude-config:limits.maxPromptBytes). |
| CX-P2a | A | PASS | N01 / F1 | codex-override-key-not-dot-free (dotted path-key), codex-override-forbidden-key:sandbox_mode, codex-override-unknown-key; dot-free path-keyed inline table round-trips (admitted). F1 effective defense = dot-free key audit (tomlRoundTrip inequality path unreachable for the conservative grammar — noted honestly). |
| CX-P2c | A | PASS | N01 / F7 | codex-forbidden-flag:--sandbox (never-pass fires first; the specific codex-forbidden-sandbox-named-permissions is a redundant shadowed defense) + producer rejects sandbox_mode. Tier-B native shape SKIPPED per plan ("if safely observable without a thread" — --sandbox risks a thread). |
| CC-P2 | B | PASS (corrected) | N05 F12/F14/F16 + FK3 | All 5 native refusal shapes match claims (exact stderr captured). (e) --effort=bogus ⇒ WARN-only ("Unknown --effort value 'bogus' — ignoring it") + proceed to auth failure ⇒ FK3 producer-rejection duty CONFIRMED. Initial auto-verdict was a heuristic FALSE POSITIVE (regex matched "Unknown" in a Warning); corrected from retained evidence, NO re-run. |
| CC-P3 | B | PASS | G-SET / N04 | DIRECTION B CONFIRMED: invalid --settings (unknown key; malformed JSON) SILENTLY IGNORED — byte-identical auth-failure frame sequence to the valid baseline. ⇒ shipped fail-closed validateClaudeSettingsBytes is BOUND MANDATORY; G-SET effectiveness closure defers to CC-L2 (LIVE). |
| CC-P7ii | B | PASS | N05 10MB cap (native half) | 10MB+1 stdin ⇒ exit 1 in 182ms, "Error: piped stdin input exceeds 10MB", no hang, not timedOut. |
| CC-P5 | A | **PRODUCT_FAILURE_CANDIDATE** (corrected) | G-WRITES (PASS sub-finding) + contract structured-output | G-WRITES: CFG gains {.claude.json, backups/, sessions/} all inside synthetic CFG despite --no-session-persistence + DISABLE_FILE_CHECKPOINTING; PH gains none; USER/LOGNAME track envOptions.user; empty-input refuses pre-spawn (prompt-empty, zero writes). BUT the pinned claude REJECTS the contract's inline --json-schema (draft 2020-12): "no schema with key or ref https://json-schema.org/draft/2020-12/schema" ⇒ every claude structured-output launch fails at startup. Adapter correctly fails closed (fatal:startup-refusal|init-missing|no-result, usage unknown). |
| CC-P6 | B | PASS | N05 signals / G-SIGTERM(F12) / G-SIGINT / N01 hook | (i) SessionStart hook EXECUTES pre-auth with NO model turn (hook_started/hook_response frames; sentinel written inside tempRoot) ⇒ adapter disableAllHooks:true + empty --setting-sources + hostile-config refusal (CC-P1) are LOAD-BEARING. (ii)/(iii) SIGTERM@10s / SIGINT@8s NEVER DELIVERED — unauth claude auth-fails in ~250ms, preempting the signals ⇒ G-SIGTERM/F12(143/no-result) and G-SIGINT stay UNKNOWN-WITH-OBSERVATION (CC-L3 LIVE needed). Bonus: bare-argv init frame (permissionMode=default, full DEFAULT roster) — NOT adapter-constrained. |
| CX-P1 | B | PASS | argv-surface binding | ALL frozen-template flags present in `codex exec --help` (--json --color --skip-git-repo-check --ignore-user-config --ignore-rules --strict-config --output-schema --model --ephemeral -c --image). Presence evidence only, not runtime attestation. |
| CX-P2b | B | PASS | N01 strict-config / F9 | Unknown -c key under --strict-config ⇒ exit 1 "Error loading config.toml: unknown configuration field `rocky_unknown_probe_key`", NO thread.started, stdin not consumed. PLAN AMBIGUITY recorded: cannot be driven via prepareLaunch→begin (adapter rejects unknown keys pre-spawn = CX-P2a), so observed Tier-B. |
| CX-P3 | A | **PRODUCT_FAILURE_CANDIDATE** (corrected) | auth-absence fail-closed (S09/L01-adj) + BONUS partial G-FRAME-SHAPE | Zero-billing HELD (401×10, no model processing, turn.failed, no usage frame) and adapter settled fatal correctly, BUT codex EMITTED thread.started + turn.started and CONTACTED wss→https api.openai.com/v1/responses (401) ⇒ contradicts plan premise "terminates before any thread/model start" + observable "no partial thread.started". Refinement: CONFIG error refuses pre-thread (CX-P2b); AUTH error starts a thread then 401s. Bonus zero-cost native G-FRAME-SHAPE: thread.started/turn.started/error/item/turn.failed field shapes. NOT an L01 pass. |
| CX-P4 | A | PASS | F5 trust-persistence (refusal half) | config.toml BYTE-IDENTICAL (sha256 e20e1626…, 88B pre==post, drift=null, no projects./trust_level written) EVEN THOUGH a thread started ⇒ the explicit projects.<src>.trust_level=untrusted override prevented persistence under the real thread-start condition. Full F5 (writable-cwd model turn) credit-blocked. |
| CX-P5 | B | PASS | N06 partial / F9 duplex | Early config error exits (exit 1) without reading stdin; delayed post-exit prompt write records the attempted-unknown duplex shape. Zero model call. |
| CC-P8 | static | PASS | G-MODEL (enumeration half) | 99 refined candidate model IDs (opus 37 / sonnet 37 / haiku 17 / instant 3 / legacy 5) from bounded read-only grep of the pinned bundle; command+binary hashed; output-capped. BUNDLE STRINGS, NOT runtime-attested (resolvability only via CC-L1, LIVE, not run). Forward IDs present (claude-opus-4-5/4-6/4-7/4-8/5/5-5, claude-sonnet-4-5/4-6/5, claude-haiku-4-5). availableModels-context pattern matched 0 lines. |

## PRODUCT_FAILURE_CANDIDATEs (drive R3 / amendment — runner does NOT edit acceptance/**)
### PFC-1 (CC-P5): pinned claude 2.1.283 rejects the contract's inline --json-schema (draft 2020-12)
- Frozen contract claim (acceptance/claude-code/manifest.json): the harness-neutral final schema
  (acceptance/subscription/final.schema.json, `$schema: https://json-schema.org/draft/2020-12/schema`) is "reused by
  reference" as inline `--json-schema=<canonical-minified-request-schema-json>`; "This contract ships no second schema
  file"; structured output is the synthetic StructuredOutput tool pair; `result.structured_output` REQUIRED for success.
- Observed native behavior: claude 2.1.283 exits 1 at STARTUP — `Error: --json-schema is not a valid JSON Schema: no schema
  with key or ref "https://json-schema.org/draft/2020-12/schema"` (0 frames). A structured-output launch cannot start.
- Root cause ISOLATED (diag-json-schema.mjs, zero-turn): SAME schema body, only `$schema` differs → 2020-12 REJECTED;
  draft-07 ACCEPTED (init emitted); `$schema` removed ACCEPTED; minimal/no-meta ACCEPTED. ⇒ the pinned claude --json-schema
  validator does not have the 2020-12 meta-schema registered (bundled-registry limitation, NOT network — draft-07 resolves
  in the same sealed env). Claude-specific: codex --output-schema (file path) did not reject the same 2020-12 schema at startup.
- Adapter behavior CORRECT (fails closed: fatal/startup-refusal, usage unknown, no false success). Divergence is the frozen
  contract's request-schema draft vs the pinned claude validator. Candidate resolution for root: use draft-07 (verified
  accepted) or omit `$schema` for the claude --json-schema request projection; host still re-validates structured_output
  against the FULL protected schema. Affects EVERY claude structured-output launch against the pinned binary.

### PFC-2 (CX-P3): auth-absent codex starts a thread + contacts the model API (contradicts the plan's "before thread start" premise)
- Frozen plan premise (#105 PART3 zero-call guarantee): credential-less CODEX_HOME ⇒ "every case terminates at config/auth
  refusal BEFORE any thread/model start"; CX-P3 observable "no partial thread.started".
- Observed native behavior: codex 0.157.1 (full valid adapter bundle, credential-less CODEX_HOME) emits thread.started +
  turn.started, contacts wss://api.openai.com/v1/responses then https://api.openai.com/v1/responses (WS→HTTPS transport
  fallback), receives 401 Unauthorized on every attempt (10 reconnects), then turn.failed; exit 1; 14 JSONL frames.
- HELD: zero billable turn (401 = no model processing, no tokens/cost, no usage frame); fail-closed (adapter fatal/failed,
  no proposal/head authority); no forced login/logout; no API-key auth fallback (WS→HTTPS is transport, not auth).
- Divergence: fail-closed point for AUTH-absence is the API-layer 401 AFTER thread start + model-endpoint contact, NOT a
  pre-thread refusal. Refinement: CONFIG-error (CX-P2b unknown -c key) DOES refuse pre-thread; only AUTH-error starts a thread.
- Bonus: partial native G-FRAME-SHAPE attestation (was credit-blocked) for opening/error frames at zero cost.
- For root/R3: decide whether the contract/plan zero-call rationale needs amendment to state that auth-absent codex starts a
  thread and fails at API 401 (zero-billing still guaranteed by the 401), and whether any codex scenario keyed on
  "no thread.started before auth" must be revised.

## ENVIRONMENT_FAILUREs / driver faults
- NONE in any plan probe (CC-P0..CC-P8, CX-P0..CX-P5). No identity drift, no two-consecutive ENVIRONMENT_FAILURE, no CLI
  wall-cap timeout (every spawn exited inside its cap), no containment breach, no orphan process, no leftover temp root.
- One DIAGNOSTIC driver fault (diag-json-schema.mjs first attempt: missing mkdir cwd ⇒ exit -2 / no data). Fixed, re-hashed
  (addendum 2b), re-run once (within "at most one re-run"). This was a diagnostic, not a plan probe.
- One EVIDENCE-CAPTURE defect (run-phase3/run-phase4 read 0-byte Tier-A native logs). Remediated by a documented single
  re-run (run-remediate.mjs, addendum) capturing command.duplex.frames + receipts + run-tree walks. This defect is why
  CC-P5 and CX-P3 were re-classified (see corrections). Original evidence preserved (verdict-initial-auto.json).

## Verdict corrections (transparent; original auto-verdicts preserved as verdict-initial-auto.json)
- CC-P2: PRODUCT_FAILURE_CANDIDATE → PASS. Cause: heuristic regex false-matched "Unknown" inside a WARNING string. Corrected
  from retained raw evidence; NO re-run / NO new spawn.
- CC-P5: PASS → PRODUCT_FAILURE_CANDIDATE. Cause: 0-byte native capture hid the --json-schema startup refusal; remediation
  re-run (duplex.frames) revealed it.
- CX-P3: PASS → PRODUCT_FAILURE_CANDIDATE. Cause: 0-byte native capture mis-read threadStarted=false; remediation re-run
  (duplex.frames) showed thread.started=true.

## Skipped / ambiguous steps (recorded honestly, never improvised)
- CX-P2(c) Tier-B native shape of --sandbox+named-permissions: SKIPPED — spawning real codex with --sandbox risks a
  thread/model start, which the zero-call guarantee forbids; plan said "if safely observable without a thread" (it is not).
- CX-P2(b) plan Tier-A label: AMBIGUOUS — an unknown -c key cannot be driven through prepareLaunch→begin (the shipped
  producer rejects unknown keys pre-spawn = CX-P2a). Observed the native strict-config refusal Tier-B instead; ambiguity recorded.
- CC-P8 availableModels/alias-context pattern matched 0 lines (that literal is not grep-matchable in the bundle); model-family
  IDs came from the claude-* and dated-name patterns instead. Recorded.
- CC-P6 signal shapes (G-SIGTERM/F12, G-SIGINT): NOT OBSERVABLE under zero-turn (unauth auth-failure preempts the T+10s/T+8s
  signals). Kept UNKNOWN-WITH-OBSERVATION per the plan's allowed outcome; CC-L3 (LIVE, not run) is the closure path.

## G-MODEL candidate IDs (CC-P8 — BUNDLE STRINGS, NOT runtime-attested)
99 refined candidates (probes/CC-P8/refined-model-candidates.json). Representative: claude-opus-4-1(-20250805),
claude-opus-4-5(-20251101), claude-opus-4-6, claude-opus-4-7, claude-opus-4-8, claude-opus-5, claude-opus-5-5,
claude-sonnet-4-5(-20250929), claude-sonnet-4-6, claude-sonnet-5, claude-haiku-4-5(-20251001), claude-3-5-sonnet/-haiku,
claude-3-7-sonnet, claude-3-opus, claude-instant-1.2, claude-2.1. Resolvability of ANY candidate (incl. the host role-table
models) is established ONLY by CC-L1 modelUsage/assistant.message.model (LIVE, NOT run) or stays open. qwen3.8-max /
OpenCode-chain resolvability is #104, out of scope.

## Attestations
- ZERO billable model turns: every claude spawn used a fresh synthetic UNAUTH CLAUDE_CONFIG_DIR + private synthetic HOME;
  every codex spawn used a synthetic unauth CODEX_HOME. Auth-failure frames confirm it (claude: result is_error=true,
  total_cost_usd=0, modelUsage={}, all usage tokens 0, "Not logged in · Please run /login"; codex: 401 Unauthorized ×10,
  turn.failed, no usage frame). The CLI's unavoidable startup endpoint contact (codex→api.openai.com 401) was recorded, never billed.
- ZERO LIVE-QUOTA probes run: CC-L0/CC-L1/CC-L2/CC-L3/CC-L4 ALL not run (R2 batch, blocked by R1 triage + per-probe user go-ahead + CC-L0 login).
- NEVER-TOUCH honored: real ~/.claude, ~/.claude.json, ~/.config/anthropic, real ~/.codex/config.toml, keychains, auth bytes,
  user global config, target repos never read/touched. Managed layers lstat/name-only (all absent). Pinned binaries read/hash only.
- Consumed-probe count: 17 plan probes (CC-P0,P1,P2,P3,P5,P6,P7i,P7ii,P8; CX-P0,P1,P2a,P2b,P2c,P3,P4,P5) each consumed ONCE,
  + 1 documented remediation re-run (CC-P5,CX-P3,CX-P4) + 1 diagnostic (CC-P5 json-schema, re-run once after a driver-bug fix).
  No plan probe silently re-run. No git mutations during probes; tracked tree clean (acceptance/src/tests/docs untouched vs HEAD).
- No STOP trigger fired. Batch completed in plan order (1 identity → 2 zero-spawn → 3 claude → 4 codex → 5 G-MODEL).

## Surprises (honest)
1. The pinned claude rejects the contract's own draft-2020-12 request schema (PFC-1) — a runtime incompatibility invisible to
   bundle-strings research; it would break every claude structured-output launch. draft-07 works.
2. Auth-absent codex does NOT stop before thread start (PFC-2) — it starts a thread+turn and hits the model API for 401. The
   zero-billing guarantee still holds (401), but the plan's mental model of "pre-thread refusal" was wrong for the auth path.
3. claude writes .claude.json + backups/ + sessions/ into CLAUDE_CONFIG_DIR at startup even with --no-session-persistence and
   CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING=1 (G-WRITES) — bounded inside CFG, but the disable switches do not prevent state files.
4. The native auth-failure result frame carries subtype:"success" WITH is_error:true / terminal_reason:"api_error" — a
   subtype-only classifier would misread auth failure as success; the shipped adapter correctly settles it as fatal/blocked.
5. SessionStart hooks fire pre-auth with no model turn (CC-P6 i) — concrete proof the adapter's disableAllHooks is load-bearing.
6. The Tier-A native-capture log-read defect initially masked findings 1 and 2 (0-byte captures); the duplex.frames retained by
   the shipped gate were the authoritative source that the remediation re-run recovered. Lesson: capture gate-retained frames,
   not just supervisor log files.
