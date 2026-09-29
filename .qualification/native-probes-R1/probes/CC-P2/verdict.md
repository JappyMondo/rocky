# CC-P2 — verdict PASS (corrected classification; see correction note)

- tier: B (pre-adapter native refusal shapes; sealed shipped env, unauth synthetic CFG)
- gate/scenario fed: N05 refusal shapes (F12/F14/F16); FK3 producer-rejection duty
- hypothesis: native claude refuses invalid input pre-model with the claimed shapes, and only WARNS
  (does not reject) on an off-table --effort value, confirming the adapter's assertClaudeArgv must reject it.
- criterion (plan, quoted): PART2 CC-P2: "PASS: matches claim or exact divergence retained (PRODUCT_FAILURE
  candidate ⇒ amendment). REJECT: silent acceptance of invalid input."
- expected: nonzero exits for (a)-(d) matching the claimed shapes; (e) warns on bogus effort and PROCEEDS to auth failure.
- observed: ALL FIVE sub-cases match the frozen claims (exact native bytes quoted below).
- class: native-refusal-shapes-match-claims
- zero billable turns: confirmed (result frame total_cost_usd=0, modelUsage={}, all usage tokens 0, is_error=true,
  terminal_reason=api_error, synthetic assistant "Not logged in · Please run /login", error=authentication_failed).

## CORRECTION NOTE (honest, post-hoc; NO re-run, NO new spawn)
The driver's initial automatic verdict was PRODUCT_FAILURE_CANDIDATE (preserved verbatim in
verdict-initial-auto.json). That was a FALSE POSITIVE caused by a driver classification bug, not a product
divergence. The buggy heuristic was:
    eEffortRejected = /effort/i.test(stderr) && /invalid|unknown|expected|allowed/i.test(stderr)
It matched the word "Unknown" inside the WARNING string
    "Warning: Unknown --effort value 'bogus' — ignoring it and using the default effort. Valid values: low, medium, high, xhigh, max."
which is a warn-and-proceed, NOT a hard rejection. The retained raw evidence (meta.json + captures) shows the CLI
WARNED, then PROCEEDED (emitted system/init, reached auth failure, exit 1) — exactly the claimed FK3 behavior
"warn-only-and-proceed-to-auth-failure". The raw captures are ground truth and are unchanged; only the computed
CLASS was wrong. Corrected verdict = PASS. The consumed-probe entry stands (CC-P2 was NOT re-spawned).

## Exact native observations (from retained captures)
- (a) empty stdin ⇒ exit 1, stderr: `Error: Input must be provided either through stdin or as a prompt argument when using --print`  → matches F12 claim.
- (b) whitespace-only stdin ⇒ exit 1, stderr: `Error: Input contained only whitespace. Provide a prompt with text through stdin or as a prompt argument when using --print`  → matches.
- (c) stream-json WITHOUT --verbose ⇒ exit 1, stderr: `Error: When using --print, --output-format=stream-json requires --verbose`  → matches F14[B].
- (d) --json-schema={invalid ⇒ exit 1, stderr: `Error: --json-schema is not valid JSON: JSON Parse error: Expected '}'`  → matches.
- (e) --effort=bogus ⇒ stderr WARNING (above), then stdout emitted `system/init` and proceeded to auth failure
  (assistant frame model="<synthetic>", error="authentication_failed", is_api_error_message=true, text "Not logged in ·
  Please run /login"; result frame is_error=true, subtype="success", terminal_reason="api_error", num_turns=1,
  total_cost_usd=0, modelUsage={}, all usage tokens 0), exit 1 → matches FK3 "warn-only-and-proceed-to-auth-failure".
  CONFIRMS the producer-rejection duty: the CLI does NOT reject off-table effort (only warns + uses default), so the
  adapter's assertClaudeArgv (claude-effort-off-table) is the REQUIRED enforcement.

## Cross-cutting native finding (feeds adapter stream-classifier understanding)
The native auth-failure result frame carries `subtype:"success"` while `is_error:true` and `terminal_reason:"api_error"`.
A classifier keying on subtype alone would misread auth failure as success. (CC-P5 shows the shipped adapter settles
this shape as blocked/needs_engineering — i.e., it does NOT treat it as success.) startup_failure_reason frames did NOT
appear under CLAUDE_CODE_STARTUP_FAILURE_RESULTS=1 for these input-validation refusals (they exit before startup); the
auth-failure path instead surfaces via the synthetic assistant + is_error result frame.

Notes: 5 bounded native spawns, one owned process group each, all inside the wall cap (each exited in <600ms; no
timeout, no orphan). Zero billable turns (unauth synthetic CFG + private synthetic HOME).
