# Amendment log — ticket #93, contract `rocky-subscription-88-v1`

Sole mutation lease; baseline HEAD `234818e3bfa75df18609985f59a9d7df16b4843a`
(owned contract paths byte-identical to accepted `572accf`). Pinned source:
codex 0.157.1 @ `36650394c5b38c2990ccf2a3457165ca3e9d9726`, findings F1–F12 in
#92 comments 857–860. Requirement items: (1) todo-complete predicate,
(2) F1–F10 contradictions/silences, (3) #89/850(a)/(b)/(c) non-blocking
suggestions. Static authorship only: no scenario executed, `qualification=false`,
`capability=null` unchanged. No other barrier weakened; every amendment either
corrects a disproved claim or adds/strengthens a requirement, each with an inline
source citation.

## acceptance/subscription/README.md

| #   | Change                                                                                                                                                                                          | Item | Source                                            | Rationale                                                                                                                                                     |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | "Reading exec output": added prompt-consumption rule — consumption evidenced only by a subsequent `thread.started`; a pipe-buffered write proves nothing.                                         | 2    | #92 F9 (codex 0.157.1 @36650394)                  | Stdin is read before thread start and an early config error exits without reading; contract was silent on what evidences consumption.                          |
| A2  | Replaced "A started todo list must settle with every task complete" with: a started `todo_list` must settle like any other started item, but task state is informational only, never evidence. | 1    | #92 F10 (event_processor_with_jsonl_output.rs:514-523) | Exec synthesizes todo completion at every turn end regardless of steps done, so the old predicate proved nothing; the lifecycle settle barrier is retained.    |
| A2b | Final-message rule: "follow every settled tool/plan" → "follow every settled tool; plan/todo task state is informational and cannot corroborate a final".                                       | 1    | #92 F10                                            | Same disproved predicate relied on plan state as corroboration.                                                                                                |
| A3  | Stated the runtime rule for disguised sandbox denials: only source-defined signals (declined status, error item/event, `turn.failed`) reject; denial-looking-ordinary stays ordinary in-band.   | 3    | #89/850(a) (from #89/849 suggestion 1)            | Removes the misreading that the adapter must detect denials in-band; containment for that class rests on N02–N05 and the protected-state oracle.                |
| A4  | Error-surface clarification: config warnings, deprecations, reroutes, lag drops are error items; `will_retry` reconnects are error events; all reject fail-closed. Interrupted turn = no terminal + exit 1 ⇒ interrupted/unknown. | 2    | #92 F10                                           | Contract said "error event/item rejects" but was silent that benign-looking warnings/reroutes/lag land in that class; fail-closed is per #92 PART3 §6.          |
| A5  | "Binding and review": receipts must retain post-run rehash of discovery inventory and shared CODEX_HOME `config.toml`; drift ⇒ stale/unknown.                                                    | 2    | #92 F5/F6                                         | Trust persistence mutates shared config and global instructions may be re-read per turn; the contract had no post-run drift requirement.                        |
| A6  | Repair paragraph: "F04's unchanged" → "F04's retained"; long lines 88/158 rewrapped to ~80 columns.                                                                                               | 3    | #89/850(c) (from #89/848 suggestions 2/3)         | Cosmetic precision and wrap consistency.                                                                                                                       |
| A7  | New amendment-provenance paragraph for #93 with archive pointer.                                                                                                                                  | 1/2/3 | #93                                               | Honest provenance; re-freezing executes/passes nothing.                                                                                                         |

## acceptance/subscription/manifest.json

| #   | Change                                                                                                                             | Item | Source                     | Rationale                                                                                                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------- | ---- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| B1  | `authority` += `#92/857/858/859/860`, `#93`.                                                                                        | 1/2/3 | #93                        | Provenance of the amendment authority.                                                                                                           |
| B2  | New `launch.configOverrides`: `serialization` (TOML round-trip required; silent raw-string fallback), `mergeSemantics` (deep-merge; no map erasure; fail-closed inventory only), `strictValidation`, `userLayerScope`. | 2    | #92 F1, F2, F3, F4         | Contract was silent on -c parse/merge semantics; guessed keys and erasure assumptions must be rejected at admission.                              |
| B3  | New `launch.forbiddenLaunchInputs`: `--sandbox`/`sandbox_mode` with named `default_permissions`; `forced_login_method`/`forced_chatgpt_workspace_id`; auth-bearing env keys. | 2    | #92 F7, F8                 | Sandbox overrides silently force legacy syntax and drop named permissions; forced-login keys log out shared auth; `load_auth` honours auth env keys. |
| B4  | New `launch.input.consumptionEvidence` (thread.started-only).                                                                       | 2    | #92 F9                     | Machine-readable twin of A1.                                                                                                                     |
| B5  | New `launch.auth.trustPersistence`: explicit untrusted override for the staged root + projectless tree + post-run `config.toml` byte check. | 2    | #92 F5                     | Required behavior the contract only implied via "untrusted staged project"; the shared-store write route is now named and must be prevented/verified. |
| B6  | `successRequires`: "all observed tools settled … every plan complete" → "all observed items settled … todo/plan task state informational only" with citation. | 1    | #92 F10                    | Disproved predicate removed; settle barrier retained (and broadened honestly to items, matching the existing unresolved-item rejection).          |
| B7  | New `toolOutcomeClasses.errorItemSurface` (warnings/deprecations/reroutes/lag as error items, `will_retry` as error event, interrupted = no terminal + exit 1, no ephemeral backfill). | 2    | #92 F10                    | Machine-readable twin of A4; distinguishes the error class per source.                                                                            |
| B8  | `receiptRequirements` += post-run rehash of discovery inventory and shared `config.toml`; drift ⇒ stale/unknown.                     | 2    | #92 F5/F6                  | Machine-readable twin of A5.                                                                                                                      |

## acceptance/subscription/scenarios.json

| #   | Change                                                                                                                     | Item | Source             | Rationale                                                                                                                            |
| --- | -------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | F01 `expected` += -c values must round-trip a real TOML parser; silent raw-string fallback rejected pre-spawn.               | 2    | #92 F1/F3          | F01 already rejected unknown overrides; the silent-degradation failure mode was untested.                                              |
| C2  | F04 `procedure`: "incomplete todo" → "started todo_list left unresolved without completion (no ephemeral backfill)"; added explicit note that a completed todo's task state is informational and not a rejection class. | 1    | #92 F10            | The old injection relied on the disproved predicate; the unresolved-item lifecycle barrier is retained and is source-backed.           |
| C3  | F06 `expected` += prompt consumption evidenced only by subsequent thread.started; pipe-buffered write stays attempted-unknown, no resend. | 2    | #92 F9             | Sharpens the existing no-replay barrier with the source's read ordering.                                                               |
| C4  | F13 `procedure`: authority-denied patch negative must use a denial form the pinned source actually emits for file_change, else route via error/turn.failed/declined or defer to N03; never invent a status. | 3    | #89/850(b)         | Prevents the fake CLI from fabricating a patch-denial status that 0.157.1 does not emit.                                               |
| C5  | N01 `expected` += shared config.toml and approved global instruction bytes rehash unchanged post-run; trust persistence prevented by explicit untrusted override + projectless tree. | 2    | #92 F5/F6          | Native discovery scenario is the right home for the drift/persistence regression.                                                      |

## docs/architecture/subscription-harness.md

| #   | Change                                                                                          | Item | Source         | Rationale                                                                       |
| --- | ----------------------------------------------------------------------------------------------- | ---- | -------------- | -------------------------------------------------------------------------------- |
| D1  | Auth paragraph: named trust persistence as a second shared-store write route with the F5 mitigation/verification. | 2    | #92 F5         | The note already covered auth-refresh writes; this write route was missing.        |
| D2  | Interpreter paragraph: error-surface fail-closed summary; todo/plan state informational.         | 1/2  | #92 F10        | Keeps the architecture note consistent with the amended contract.                |
| D3  | Closing amendment-provenance paragraph with archive pointer.                                     | 1/2/3 | #93            | Honest provenance; grants no execution.                                          |

## acceptance/subscription/frozen.sha256.json

| #   | Change                                                                       | Item | Source | Rationale                                                              |
| --- | ---------------------------------------------------------------------------- | ---- | ------ | ----------------------------------------------------------------------- |
| E1  | Re-froze bytes/sha256 for the four modified files; `final.schema.json` entry unchanged. | 1/2/3 | #93    | The frozen inventory must bind current bytes; the schema itself is untouched. |

## Findings deliberately NOT amended

- **F3** (strict-config validates -c): contract already correct — `--strict-config`
  is in `argvTemplate` and F01 rejects unknown overrides; only a clarifying
  `strictValidation` line was added inside B2.
- **F4** (ignore-flag scope): the architecture note already says ignore flags
  suppress specific layers only and never suffice; B2's `userLayerScope` is a
  cited clarification, not a semantic change.
- **F10 all-zero usage**: contract already honest — `ambiguous-zero` status,
  F08/M03 scenarios, README usage section. Unchanged.
- **F10 ephemeral backfill**: contract already correct — N06 "No summary backfill
  assumption in ephemeral mode" and unresolved-item rejection. Cited in B7/C2
  wording only.
- **F11/F12**: outside the ticket's F1–F10 amendment scope. F11's substance
  (legacy-key notices surface as error items) is covered by A4/B7; F12
  (CODEX_HOME/tmp/arg0 helper root) is a permission-profile design detail for the
  blocked profile/#81 producer, not acceptance-contract text.
- **#89/848 suggestion 1** (repair artifact-inventory omission): cannot act —
  `.qualification/subscription-contract-88-repair/**` is pre-existing evidence
  that must be preserved untouched; the bytes are already covered by
  `rejected-source-inventory.json`.
- **#92 gates G1–G13**: research gates, not contract claims; the contract's
  blocked/unexecuted statuses and `gateOrder` already reflect them.
