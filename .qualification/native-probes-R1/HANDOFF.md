# R1 HANDOFF — native-probes-R1 (Taskbot #108) — READBACK THEN STOP (#64 pattern)

Sole mutation lease held. Zero-turn / zero-call batch ONLY (CC-P0..CC-P8 + CX-P0..CX-P5). NO CC-L* LIVE probe run.
Plan authority: #105 comments 954-957, root-accepted #968, frozen at HEAD 651b1481c0962be528744888eb010c65ecf5bf9c.
Full detail: summary.md (verdict table + PFCs + corrections), per-probe probes/<id>/verdict.md, evidence-index.json.

## READBACK
- Identity preconditions PASS: claude 2.1.283 = d8cb1e5c…d21e / 225036032B; codex 0.157.1 = 27ceb5f9…6a7d / 238223808B.
  No FULL STOP. (~/.local/bin/claude symlink drifted → 2.1.284; NEVER spawned — only the absolute versioned pins.)
- Executed in strict plan order: (1) identity, (2) zero-spawn denials CC-P1/CC-P7i/CX-P2a/CX-P2c, (3) claude
  CC-P2/CC-P3/CC-P7ii/CC-P5/CC-P6, (4) codex CX-P1/CX-P2b/CX-P3/CX-P4/CX-P5, (5) CC-P8 G-MODEL.
- Verdicts: 15 PASS, 2 PRODUCT_FAILURE_CANDIDATE (CC-P5, CX-P3). 0 ENVIRONMENT_FAILURE in plan probes. No STOP trigger.
- PRODUCT_FAILURE_CANDIDATEs (for R3; runner does NOT edit acceptance/**):
  * PFC-1 (CC-P5): pinned claude 2.1.283 REJECTS the contract's inline --json-schema (draft 2020-12) — "no schema with key
    or ref". Diagnostic-isolated: draft-07 / no-$schema ACCEPTED. Affects every claude structured-output launch. Adapter
    fails closed correctly. Resolution direction for root: draft-07 or omit $schema for the claude request projection.
  * PFC-2 (CX-P3): auth-absent codex EMITS thread.started + turn.started and CONTACTS api.openai.com/v1/responses (401×10),
    contradicting the plan's "terminates before any thread/model start" / "no partial thread.started". Zero-billing HELD
    (401, no processing); adapter settled fatal correctly. Refinement: config-error refuses pre-thread; auth-error starts a thread.
- Corrections (transparent, originals preserved as verdict-initial-auto.json): CC-P2 PFC→PASS (heuristic false positive on a
  WARNING string; no re-run); CC-P5 PASS→PFC and CX-P3 PASS→PFC (0-byte Tier-A native capture defect; recovered via a
  documented single remediation re-run reading gate-retained command.duplex.frames).
- Key PASS findings: CC-P3 Direction B (invalid --settings SILENTLY IGNORED ⇒ validateClaudeSettingsBytes bound mandatory);
  CC-P7ii native 10MB stdin cap enforced; CC-P6(i) SessionStart hook fires pre-auth with no model turn (disableAllHooks
  load-bearing); CX-P4 config.toml byte-identical even though a thread started (F5 untrusted-override held); CX-P2b unknown
  -c key refused pre-thread; CC-P8 99 bundle-string model-ID candidates (NOT runtime-attested).
- G-MODEL candidate IDs (CC-P8, bundle strings only): opus 37 / sonnet 37 / haiku 17 / instant 3 / legacy 5 — see
  probes/CC-P8/refined-model-candidates.json. Resolvability only via CC-L1 (LIVE, not run).
- Gates still OPEN/unknown after R1: G-SIGTERM/F12(143/no-result) and G-SIGINT (signal preempted by zero-turn auth-failure;
  CC-L3 LIVE needed); G-SET effectiveness (CC-L2 LIVE); G-INIT-VALUES adapter-constrained (CC-L1 LIVE); G-HOME keychain/login
  residual (CC-L0 user-assisted); codex G-FRAME-SHAPE completion/usage frames + N02-N08 (credit-blocked).

## ATTESTATIONS
- ZERO billable model turns (unauth synthetic CFG/CODEX_HOME + private synthetic HOME on every spawn; auth-failure frames
  confirm total_cost_usd=0 / modelUsage={} / 401). CLI startup endpoint contact (codex→api.openai.com 401) recorded, never billed.
- ZERO LIVE-QUOTA probes run (CC-L0..CC-L4 all not run).
- NEVER-TOUCH honored (real ~/.claude, ~/.claude.json, ~/.config/anthropic, real ~/.codex config.toml, keychains, auth bytes,
  user global config, target repos never read/touched; managed layers lstat/name-only, all absent; pins read/hash only).
- Bounded: every spawn one owned process group, wall caps respected (30s/45s/60s; no timeout hit), captures ≤4MiB (all far under).
- No orphan pinned-binary processes; all temp roots deleted after evidence copy.
- No git mutations DURING probes; tracked tree clean; acceptance/**, src/**, tests/**, docs/** untouched vs HEAD.
- Writes: .qualification/native-probes-R1/** only. Consumed list: consumed.md (17 plan probes consumed once each; remediation
  re-run + diagnostic documented, not silent). Drivers hashed before first spawn: drivers.sha256 (+2 documented addenda).

## Single evidence-retention commit (the ONLY git mutation, at the very end)
Subject: "Execute R1 zero-turn native probe batch (#108)". Body states what passed/rejected/diverged, the corrections, that
the LIVE batch was NOT run, and the PFCs for R3. Trailer: Co-Authored-By: OpenCode qwen3.8-max <noreply@opencode.ai>.

STOP after readback. Probe runners never edit acceptance/**, never mint qualification/capability; no probe pass is a scenario
pass until root binds it via R3.
