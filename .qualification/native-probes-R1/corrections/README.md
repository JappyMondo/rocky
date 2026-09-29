# Correction notes — R1 native-probe evidence + #111 probe artifacts (append-only, #110/R3)

Written under Taskbot #110 (R3 wording amendment, sole mutation lease, baseline
`f3c809a9941314e59f5da3b941ab796c214ade84`). These are APPEND-ONLY correction
notes recording the non-blocking evidence-hygiene findings F2/F3/F4 from the root
acceptance of #111 (comment 978, independent Standards+Spec review of the fixed
range `674fffe..f3c809a`). NO retained evidence byte is edited: the files named
below stay exactly as committed; this note is the correction of record. Probe
verdicts, classifications and the accepted results (15 PASS / 2
PRODUCT_FAILURE_CANDIDATE, root triage #108 comment 972) are UNAFFECTED — every
correction below is a wording/precision fix, and each cost-based zero-turn claim
stands on `total_cost_usd=0` + `modelUsage={}` (claude) or 401×10 with no usage
frame (codex).

## F2 — #111 native-probe verdict.md line 29: "no assistant/model frame"

- File (retained, unedited):
  `.qualification/claude-code-contract-95-amend-pfc1-111/native-probe/verdict.md`
  line 29 — "the run terminated at the auth failure with zero cost, empty
  modelUsage and no assistant/model frame".
- Precise correction (verified against the retained
  `native-probe/probe-stdout.log` under #110): the stream DID contain ONE
  assistant frame — a SYNTHETIC auth-error frame with `message.model:
  "<synthetic>"`, `is_api_error_message: true`, `stop_reason:
  "stop_sequence"` and ALL-ZERO usage (`input_tokens: 0`, `output_tokens: 0`,
  cache subsets 0) — and no REAL model frame. The zero-billable-turn claim is
  UNAFFECTED and stands on the result frame's `total_cost_usd: 0` +
  `modelUsage: {}` (+ `is_error: true`, `terminal_reason: "api_error"`).
- Cross-reference: this synthetic auth-error assistant frame is the same native
  shape the R1 verdicts already describe precisely (e.g.
  `.qualification/native-probes-R1/probes/CC-P2/verdict.md` case (e):
  'synthetic assistant frame model="<synthetic>", error="authentication_failed",
  is_api_error_message=true, text "Not logged in · Please run /login"'), so the
  R1 batch evidence itself needed no correction — only the #111 probe verdict's
  summary line.
- Source finding: #111 root acceptance comment 978, finding F2.

## F3 — #111 static-checks.json: "32 derivations" not reproducible from retained evidence

- File (retained, unedited):
  `.qualification/claude-code-contract-95-amend-pfc1-111/static-checks.json`,
  check `C-projection-determinism` — "projection: 32 derivations
  byte-identical; …".
- Correction: the retained evidence does not reproduce a count of 32. The
  shipped determinism test (X10 in `tests/claude-code-launch.test.mjs`)
  performs 24 OUTER re-projections (3 source variants — frozen text, pretty,
  key-shuffled — × 8 iterations each) plus the initial derivation; the
  suite-run check log asserting "32" was not retained in a form that
  reproduces that number. The determinism CONCLUSION is unaffected: every
  derivation is asserted byte-identical and hash-pinned
  (`c02efee93dbeffb0e6f6153ba6d465804af4f31cb163d95ab76fe9f4b5b1a6e3`) in the
  retained test, and the #111 spec review independently recomputed the
  projection from the frozen source and matched every pin.
- Source finding: #111 root acceptance comment 978, finding F3 ("'32
  derivations' not reproducible from retained evidence (X10 does 24 outer)").

## F4 — num_turns: 1 in the aborted auth-failure result frames

- Files (retained, unedited):
  `.qualification/claude-code-contract-95-amend-pfc1-111/native-probe/probe.json`
  (`observations.resultFrame.num_turns = 1`) and the R1 claude auth-failure
  frames described in `.qualification/native-probes-R1/probes/CC-P2/verdict.md`
  (case (e): `num_turns=1`).
- Correction/clarification: the native `num_turns: 1` COUNTS THE ABORTED AUTH
  TURN itself — the CLI counts the failed authentication exchange as one turn.
  It does not indicate any model processing. All cost-based zero-turn claims
  are UNAFFECTED and never rested on `num_turns`: they rest on
  `total_cost_usd: 0`, `modelUsage: {}`, all-zero usage tokens and (codex)
  401×10 with no usage frame. The contract already classifies `num_turns` as
  informational-only (`acceptance/claude-code/manifest.json`
  `protocol.informationalOnly`), consistent with this reading.
- Source finding: #111 root acceptance comment 978, finding F4.

## Provenance of this note

- Written by: implementation agent r3-amend-110 (Taskbot #110, R3), 2026-09-29.
- Authority: #110 dispatch ("correction NOTE files under
  `.qualification/native-probes-R1/corrections/` … append-only notes; NEVER
  edit retained probe evidence bytes"); underlying findings: #111 root
  acceptance comment 978 (non-blocking findings folded into #110 per root's
  instruction there).
- Companion note (F1 + evidence.sha256 format, for the #111 directory):
  `.qualification/claude-code-contract-95-amend-pfc1-111/corrections/README.md`.
- No scenario executed; no status flipped; no verdict changed by this note.
