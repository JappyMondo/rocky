# CC-P5 — verdict PRODUCT_FAILURE_CANDIDATE (corrected; G-WRITES sub-observation PASS)

- tier: A (ClaudeCodeAdapter.prepareLaunch→begin via store dispatch; real pinned claude 2.1.283) + Tier-B diagnostic
- gate/scenario fed: N06 / G-WRITES (+ G-HOME partial); ALSO surfaces a contract-level structured-output divergence
- criterion (plan, quoted): PART2 CC-P5: "PASS: write set inventoried+bounded, all inside CFG/PH/PT; drift classifier
  agrees (gains recorded, not drift). REJECT: write outside ⇒ PRODUCT_FAILURE/containment." Expected startups:
  "empty-input refusal; valid startup ⇒ auth failure".
- class: G-WRITES bounded (PASS) + PRODUCT_FAILURE_CANDIDATE (--json-schema draft-2020-12 rejected by pinned claude)

## CORRECTION NOTE (honest, post-hoc; documented single re-run for an evidence-capture defect)
The initial run's verdict was PASS but its native stdout/stderr captures were 0 bytes (a driver log-path read defect:
it read plan.paths.logs/<last>/{stdout,stderr}.log and missed the files). The authoritative native frames are retained by
the shipped gate in command.duplex.frames; a documented single remediation re-run (run-remediate.mjs, hashed addendum,
zero-turn) captured them plus the receipt and a full run-tree walk. Original verdict preserved at verdict-initial-auto.json;
remediation evidence at rerun-*.json. The re-run was NOT silent (recorded in consumed.md).

## Sub-finding 1 — G-WRITES (PASS-quality observation)
- Empty-input startup: adapter prepareLaunch refuses pre-spawn (`prompt-empty`), zero spawn, zero CFG writes, 0 command rows.
- Valid startup (envOptions.user true AND false): real claude spawned, exit 1. CFG (CLAUDE_CONFIG_DIR) gained:
  `.claude.json`, `backups/`, `backups/.claude.json.backup.<ts>`, `sessions/` — i.e. claude writes config/backup/session
  state at startup DESPITE `--no-session-persistence` + `CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING=1`. ALL gains are inside
  the synthetic CFG (inside the temp root); parentHome (sealed HOME=PH) gains = none. Write set inventoried + bounded.
- USER/LOGNAME dependence: sealed env carried USER+LOGNAME when envOptions.user=true, neither when false (confirmed).
- G-HOME keychain/login residual stays USER-ASSISTED (CC-L0), open. No keychain call observable in bounded captures.

## Sub-finding 2 — PRODUCT_FAILURE_CANDIDATE: pinned claude rejects the contract's --json-schema (draft 2020-12)
- The "valid startup ⇒ auth failure" expectation did NOT reach auth. Native claude exited 1 at STARTUP with stderr:
  `Error: --json-schema is not a valid JSON Schema: no schema with key or ref "https://json-schema.org/draft/2020-12/schema"`
  (zero frames; adapter settled `claude-fatal:startup-refusal|init-missing|no-result`, usage status=unknown — correctly
  NOT reported as success and NOT mapped to subscription usage).
- Frozen contract claim (acceptance/claude-code/manifest.json): the harness-neutral final schema
  (acceptance/subscription/final.schema.json, which declares `"$schema": "https://json-schema.org/draft/2020-12/schema"`)
  is "reused by reference" as the inline `--json-schema=<canonical-minified-request-schema-json>`; "This contract ships no
  second schema file"; structured output is implemented as the synthetic StructuredOutput tool pair and
  `result.structured_output` is REQUIRED for success.
- Observed native behavior (pinned claude 2.1.283): the inline draft-2020-12 request schema is REJECTED at startup, so a
  structured-output launch cannot start at all against the pinned binary.
- Root cause ISOLATED by a bounded zero-turn diagnostic (diag-json-schema.mjs, hashed addendum; Tier-B bare argv, sealed
  unauth CFG; results in diag-json-schema.json): with the SAME schema body, only the `$schema` value differs —
    * `$schema = https://json-schema.org/draft/2020-12/schema`  → REJECTED (no schema with key or ref; no init)
    * `$schema = http://json-schema.org/draft-07/schema#`       → ACCEPTED (system/init emitted, proceeds to auth failure)
    * `$schema` removed (with or without `$id`)                 → ACCEPTED (init emitted)
    * minimal schema, no `$schema`/`$id`                        → ACCEPTED (init emitted)
  ⇒ claude 2.1.283's `--json-schema` validator does NOT have the draft 2020-12 meta-schema registered (a bundled-registry
  limitation, NOT a network/offline artifact — draft-07 resolves in the same sealed env). This is claude-specific: codex's
  `--output-schema` (file path) did not reject the same 2020-12 schema at startup (CX-P3 started a thread).
- Adapter behavior is CORRECT (fails closed: fatal/startup-refusal, usage unknown, no false success, no proposal/head
  authority). The divergence is the frozen contract's request-schema draft vs the pinned claude validator.
- This is EVIDENCE FOR R3/AMENDMENT (the runner does NOT edit acceptance/**). Candidate resolution directions for root:
  use a claude-supported draft (draft-07 verified accepted) or omit `$schema` for the claude `--json-schema` request
  projection, while the host keeps re-validating result.structured_output against the FULL protected schema.

## Zero-turn attestation
Zero billable turns: unauth synthetic CFG + private synthetic HOME; the startup refused at --json-schema before any model
contact, and the diagnostic variants that reached init then hit auth failure (result is_error=true, total_cost_usd=0,
modelUsage={}, all usage tokens 0). No orphan processes; temp roots deleted after evidence copy.
