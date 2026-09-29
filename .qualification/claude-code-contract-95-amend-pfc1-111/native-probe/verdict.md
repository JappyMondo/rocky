# PFC1-111 native probe — verdict PASS (projected draft-07 schema accepted at startup; zero turns)

- ticket: #111 (PFC-1); sole mutation lease; exactly ONE authorized zero-turn native probe (this one)
- binary identity gate: measured sha256 `d8cb1e5c79684cc12a8bfc813e3a2073406921b6245744b3009be3ab5651d21e`,
  225036032 bytes at `/Users/jappy/.local/share/claude/versions/2.1.283` — MATCHES the frozen pin
  (CC-P0/R1) before any spawn.
- hypothesis: the projected wire schema (canonical-minified frozen `final.schema.json` with only
  `$schema` → `http://json-schema.org/draft-07/schema#`, projection sha256
  `c02efee93dbeffb0e6f6153ba6d465804af4f31cb163d95ab76fe9f4b5b1a6e3`, derived by the SHIPPED
  `dist.projectClaudeWireRequestSchema`) passes pinned claude 2.1.283 `--json-schema` startup
  validation, unlike the frozen 2020-12 IRI (R1 #108 CC-P5: exit 1, `no schema with key or ref`,
  zero frames).
- method: mirrors the R1 CC-P5 diag driver (Tier-B bare argv): fresh temp root under
  `/var/folders/.../T/opencode/pfc1-probe-<ts>/`, synthetic UNAUTH empty `CLAUDE_CONFIG_DIR`,
  private empty synthetic HOME, sealed env from the shipped `buildClaudeSealedEnv` (allowlist
  recorded in probe.json), cwd = synthetic src, argv `-p --output-format=stream-json --verbose
  --input-format=text --json-schema=<projected> --model=claude-sonnet-4-5`, one-shot stdin
  `hi\n` + EOF, wall cap 30 s, byte-bounded capture (4 MiB cap), one owned detached group.
- observed (wallMs 461, exit 1, no signal, no timeout):
  - stderr: EMPTY (0 bytes) — no `--json-schema is not a valid JSON Schema` rejection.
  - stdout: `system/init` emitted (session_id present; `StructuredOutput` visible in init.tools),
    then a single `result` frame: `"result":"Not logged in · Please run /login"`, `is_error:true`,
    `terminal_reason:"api_error"`, `total_cost_usd:0`, `modelUsage:{}` ⇒ startup passed schema
    validation and proceeded to AUTH FAILURE, exactly the expected zero-turn outcome.
  - containment: CFG gains `.claude.json`, `backups/`, `backups/.claude.json.backup.<ts>`,
    `sessions/` — all inside the synthetic CFG (same class as R1 CC-P5 sub-finding 1); synthetic
    HOME gains: none. Temp root deleted after evidence copy.
- zero-turn attestation: unauth synthetic CFG + private synthetic HOME; the run terminated at the
  auth failure with zero cost, empty modelUsage and no assistant/model frame; no orphan processes.
- class: startup-schema-accepted / auth-failure (zero turns).
- conclusion: the #111 wire projection is natively confirmed against the pinned binary; the
  frozen 2020-12 contract bytes remain the unchanged host-side validation authority. This probe
  executes and passes NO acceptance scenario (L03 stays blocked; it requires live authority).

Evidence: `probe.json` (full result/observations/inventories/env), `probe-stdout.log`,
`probe-stderr.log`, `cfg-inventory-pre.json`, `cfg-inventory-post.json`, `probe.mjs` (driver).
