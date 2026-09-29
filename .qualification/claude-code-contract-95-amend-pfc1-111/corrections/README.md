# Correction notes — #111 amendment evidence (append-only, #110/R3)

Written under Taskbot #110 (R3 wording amendment, sole mutation lease, baseline
`f3c809a9941314e59f5da3b941ab796c214ade84`). APPEND-ONLY notes recording the
non-blocking evidence-hygiene findings from the root acceptance of #111
(comment 978), which folded them into #110. NO retained evidence byte is
edited; the files named below stay exactly as committed. The #111 amendment
itself (contract projection fix, adapter, tests, probe) is unaffected — both
independent reviews ACCEPTED with zero blocking findings.

## F1 — retained typecheck.log has a trailing blank line (whitespace-in-evidence only)

- File (retained, unedited):
  `.qualification/claude-code-contract-95-amend-pfc1-111/typecheck.log`.
- Fact (re-verified under #110): the log's last bytes are `0a 0a` — it ends
  with a trailing BLANK LINE (4 lines total). A literal `git diff --check`
  over the accepted range `674fffe..f3c809a` therefore reports
  `.qualification/claude-code-contract-95-amend-pfc1-111/typecheck.log:4: new
  blank line at EOF`, while the #111 handoff described the range as clean.
- Scope of the defect: WHITESPACE-IN-EVIDENCE ONLY. The source tree itself
  (src/**, tests/**, acceptance/**, docs/**) is clean — `git diff --check`
  flags no source/contract file in that range. No claim of the #111 amendment
  depends on the log's trailing byte; the typecheck itself passed (`tsc
  --noEmit`, zero diagnostics).
- Source finding: #111 root acceptance comment 978, finding F1.

## Evidence-format note — evidence.sha256 is a JSON inventory, not `shasum -c` format

- File (retained, unedited):
  `.qualification/claude-code-contract-95-amend-pfc1-111/evidence.sha256`.
- Clarification: despite the `.sha256` extension, this file is a STRUCTURED
  JSON INVENTORY (`{schema: 1, contractId, ticket, algorithm: "sha256",
  baseline, …, evidenceFiles: [{path, bytes, sha256}, …]}`), not a
  `shasum -c`-compatible digest list. Consumers must PARSE THE JSON and
  re-hash each `path` against its `sha256`; `shasum -c evidence.sha256` will
  fail on format, and such a failure is not an evidence-integrity failure.
  This matches the house convention already used by
  `.qualification/subscription-contract-88-amend-93/evidence.sha256` (also a
  JSON inventory). Spec-review suggestion recorded in #111 comment 978; noted
  here so future readers do not misread the format.

## Companion notes (F2/F3/F4)

The remaining non-blocking findings from #111 comment 978 concern the native
probe verdict wording (F2: "no assistant/model frame" → precisely one
SYNTHETIC auth-error assistant frame, `model:"<synthetic>"`,
`is_api_error_message:true`, zero usage; zero-billable-turn claim stands on
`total_cost_usd=0` + `modelUsage={}`), the projection-determinism count (F3:
"32 derivations" not reproducible from retained evidence; X10 does 24 outer
re-projections) and the aborted-auth-turn `num_turns:1` reading (F4:
cost-based claims unaffected). Their correction notes of record live at
`.qualification/native-probes-R1/corrections/README.md` per the #110 dispatch
placement; they are summarized here for discoverability only — that file, not
this one, is the note of record for F2/F3/F4.

## Provenance of this note

- Written by: implementation agent r3-amend-110 (Taskbot #110, R3), 2026-09-29.
- Authority: #110 dispatch ("correction NOTE files under
  `.qualification/claude-code-contract-95-amend-pfc1-111/corrections/` …
  append-only notes; NEVER edit retained probe evidence bytes").
- No scenario executed; no status flipped; no verdict or acceptance changed by
  this note.
