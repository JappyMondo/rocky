# Amendment log — ticket #111 (PFC-1), contract `rocky-claude-code-95-v1`

Sole mutation lease; baseline HEAD `674fffed12a0d7d387f37d0a5edec757bfa4d16c`, clean tree.
Finding (root-accepted): R1 #108 CC-P5 + zero-turn draft-isolation diagnostic
(`.qualification/native-probes-R1/probes/CC-P5/`): pinned claude 2.1.283's `--json-schema`
validator lacks the draft-2020-12 meta-schema in its bundled registry, so the frozen contract's
inline reuse of `acceptance/subscription/final.schema.json` (`"$schema":
"https://json-schema.org/draft/2020-12/schema"`) is rejected at startup (exit 1, `no schema with
key or ref`, zero frames) — every claude structured-output launch fails. The same body with
`$schema="http://json-schema.org/draft-07/schema#"` is ACCEPTED (init emitted, proceeds to auth
failure); `$schema` omitted also accepted. Root design decision (binding): the wire projection is
the canonical-minified frozen schema with `$schema` REPLACED by the draft-07 IRI (explicit
dialect, never omission); host-side validation authority remains the frozen 2020-12 bytes,
unchanged.

Vocabulary audit (precondition, PASS): the frozen body uses only
`$schema/$id/title/type/additionalProperties/required/properties/const/enum/minLength/maxLength/pattern`
— every keyword exists in draft-07 with identical semantics; no `prefixItems`,
`dependentSchemas`, `$dynamicRef`, `unevaluatedProperties`, 2020-12 `contains` semantics or any
other 2020-12-exclusive vocabulary is present, so the draft-07 reading is semantically identical
(static check `C-vocabulary-audit`; test-enforced by the X11 reference evaluator's
unknown-keyword fail-closed guard).

Static authorship only: no scenario executed, `qualification=false`, `capability=null`,
`executionAuthorized=false` unchanged; scenario status counts unchanged (14 unexecuted + 10
blocked). No barrier weakened: the projection adds a fail-closed dialect guard and a pinned
projection hash; host re-validation authority is untouched. One authorized zero-turn native
confirmation probe (unauth; zero billable turns) recorded under `native-probe/`.

## acceptance/claude-code/manifest.json

| #   | Site                                             | Old (short quote)                                                              | New (short quote)                                                                                                                                                                       | Citation / rationale                                                                                                              |
| --- | ------------------------------------------------ | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| M1  | `authority`                                      | `…"#93"`                                                                        | `…"#93", "#108/R1 (CC-P5 + zero-turn draft-isolation diagnostic)", "#111"`                                                                                                                 | Provenance of the amendment authority.                                                                                              |
| M2  | `reuseByReference[final.schema.json].reused`     | "…re-validated by the host. This contract ships no second schema file."         | appended: "#111 amendment (wire projection): the --json-schema wire value is a deterministic projection of these frozen bytes — canonical-minified, with ONLY \"$schema\" replaced by \"http://json-schema.org/draft-07/schema#\"… projection hash (sha256 c02efee9…b1a6e3…) is pinned with the launch bundle." | R1 #108 CC-P5 + diag-json-schema; root design decision (#111). The reuse claim stays true: the projection is derived at launch preparation, never shipped as a second file. |
| M3  | `launch.argvTemplate[17]`                        | `"--json-schema=<canonical-minified-request-schema-json>"`                      | `"--json-schema=<canonical-minified-projected-request-schema-json>"`                                                                                                                       | The template element now names the projected wire bytes (M2 rule).                                                                  |
| M4  | `launch.argvTemplateNotes` (new note)            | —                                                                               | "--json-schema carries the WIRE PROJECTION of the frozen request schema (#111 amendment)… The producer fail-closes if the source \"$schema\" is not exactly the frozen 2020-12 IRI or the projection derivation is non-deterministic; the projection hash is pinned…" | R1 #108 CC-P5 (native rejection of the frozen IRI; draft-07 accepted). Fail-closed + pin requirements from the #111 root decision.  |
| M5  | `launch.immutableBeforeStart[5]`                 | "request schema canonical bytes"                                                | "request schema projected canonical wire bytes (draft-07 projection of the frozen 2020-12 schema, #111) and its pinned projection sha256"                                                   | The immutable pre-start element is the projected wire value + its hash pin.                                                          |
| M6  | `protocol.structuredOutput`                      | "…the flag is a request, not evidence (source: #94/878 F10, section F)."         | appended: "#111 amendment: the inline value is the wire projection… host re-validation authority remains the frozen 2020-12 bytes and the projection hash is pinned."                        | R1 #108 CC-P5 + diagnostic; keeps request-not-evidence and host authority semantics intact.                                          |
| M7  | `protocol.finalSchema`                           | "acceptance/subscription/final.schema.json (reused by reference; sha256 954dd71e…)" | appended: "Host validation authority UNCHANGED by the #111 wire projection: only the --json-schema wire bytes carry the draft-07 $schema replacement (projection sha256 c02efee9…)…"        | The frozen raw-file hash citation stays; the projection hash is recorded beside it.                                                  |
| M8  | `requirements[CC07].gate`                        | "Structured final: inline canonical-minified --json-schema request…"             | "…the inline value is the #111 draft-07 wire projection of the frozen 2020-12 schema (semantically identical body; pinned projection hash; fail-closed dialect guard)… the host always re-validates against the full protected FROZEN schema…" | CC07 gate now states the wire rule and the unchanged host authority; no predicate weakened (structured_output still REQUIRED).        |
| M9  | `sources` (new entry)                            | —                                                                               | `{kind:"repo", ref:".qualification/native-probes-R1/probes/CC-P5/ … at 674fffe", note:"R1 #108 zero-turn native evidence for the #111 request-schema wire projection…"}`                   | Every changed claim cites its evidence; also cites the #111 confirmation probe directory.                                             |

## acceptance/claude-code/README.md

| #   | Site                                          | Old (short quote)                                                       | New (short quote)                                                                                                                                                     | Citation / rationale                                                                     |
| --- | --------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| A1  | §"Reading stream-json output", `--json-schema` paragraph | "…the host always re-validates against `acceptance/subscription/final.schema.json` (by reference) (source: #94/878 F10, §F)." | new subsection "**Request-schema wire projection (#111 amendment).**" — full projection rule, the exact native rejection error, the vocabulary-audit statement, unchanged host authority, fail-closed guard, projection hash pin `c02efee9…b1a6e3` | R1 #108 CC-P5 verdict + diag-json-schema (`.qualification/native-probes-R1/probes/CC-P5/`); CX-P3 (claude-specific). |
| A2  | §"Reuse by reference, not by fork"            | "(`acceptance/subscription/final.schema.json`, sha256 `954dd71e…6792`), the" | "(…sha256 `954dd71e…6792`; its Claude wire projection is defined under \"Reading stream-json output\", #111), the"                                                        | Cross-reference so the reuse paragraph cannot be read as "wire bytes == frozen bytes".        |
| A3  | §"Binding and review" (new provenance paragraph) | —                                                                        | "**Amendment provenance.** … (2) The request-schema wire projection above was amended by **#111** …; prior bytes are archived under `.qualification/claude-code-contract-95-amend-pfc1-111/prior-674fffe/`… `scenarios.json` is **untouched** by #111… Re-freezing executes and passes no scenario; the #111 confirmation probe … is recorded in the amendment evidence directory, not as a scenario pass." | House convention (#93 A7, #95 G-KC amendment): honest provenance + archive pointer.            |

## acceptance/claude-code/frozen.sha256.json

| #   | Change                                                                                             | Citation  |
| --- | ---------------------------------------------------------------------------------------------------- | --------- |
| E1  | Re-froze bytes/sha256 for the two modified files only: README.md (17482→20555, `c145897f…`→`b8f6f5f8…`) and manifest.json (60144→64401, `b124b059…`→`af2dedc2…`); `scenarios.json` and `docs/architecture/claude-code-harness.md` entries unchanged. | #111      |

## Deliberately NOT amended

- **acceptance/subscription/final.schema.json** — FORBIDDEN path and neutral host-validation
  authority; stays byte-identical (raw sha256 `954dd71e…6792` re-measured, static check
  `C-subscription-untouched`).
- **acceptance/claude-code/scenarios.json** — no scenario text depends on the request-schema
  dialect wording: F01's "request schema" drift-injection is dialect-neutral, and L03 already says
  "the projected inline request schema" / "The projected schema is accepted" (the #111 projection
  makes L03's existing wording literally true). Byte-identical to baseline; status counts 14
  unexecuted + 10 blocked unchanged (static check `C-scenarios-untouched`).
- **docs/architecture/claude-code-harness.md** — outside the #111 owned paths; its statement that
  the final schema is "reused by reference" remains accurate (host authority unchanged; the
  projection is an adapter wire detail documented in docs/claude-code-adapter.md).
- **src/agents/seam.ts** — the projection is claude-specific (codex `--output-schema` did not
  reject the 2020-12 schema, CX-P3), so it lives in `src/agents/claude-code/projection.ts`, not
  the harness-neutral seam.
