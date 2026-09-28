# #95 authoring inputs

Static desk work only. No `claude` execution (any subcommand), no
`~/.claude` credentials/sessions/`.credentials.json`/keychain reads, no env
secret dumps, no network calls, no status changes, no Taskbot comments posted.
Taskbot was used read-only through `/tmp/tb.sh` `get_ticket`.

## Taskbot reads (all succeeded)

- Ticket #95 (own ticket): body re-read and matched against the dispatch
  instructions.
- Ticket #94 in full: body plus all 6 comments —
  - 872 (claude-code-research-opus) PART 1/4: identity/sources, F1–F8
    (version pin, auth precedence, --bare incompatibility, macOS keychain
    storage, G-KC credential-reachability finding, settings layers,
    instruction discovery, other discovery routes).
  - 878 PART 2/4: F9–F13 (permissions/sandbox, structured output, effort/
    model, stdin, persistence) and the minimal source-valid launch bundle
    template (placeholders, argv §A, settings §B, env §C, roles §D, stdin §E,
    final §F).
  - 879 PART 3/4: F14–F16 (stream-json message set, result fields, exit
    codes), the COMPLETE / settled-ordinary / policy / unresolved / fatal
    classification binding, and the producer contract (inputs, serialization,
    prohibited combinations, C0–C5 checkpoints, runtime metadata sources).
  - 880 PART 4/4: fake-CLI regressions FK1–FK8, synthetic-native probes
    NP1–NP5, live cases L-a–L-d, open gates G-KC…G-DEFAULT-PROMPT,
    qualification=false/capability=null statement.
  - 881 (orchestrator-root-recovery-claude): root accept of the research,
    pinned-version summary, key inputs to #95, open user decision G-KC.
  - 882: status transition note (in_progress → done).
- Ticket #88 in full: body (what the subscription contract had to cover) plus
  comment id inventory (819, 822, 824, 826, 836, 839, 843, 845, 846, 852).
- Ticket #89 comment 850 (root aggregate): ACCEPT of 572accf, non-blocking
  suggestions (a) disguised sandbox denials / only source-defined signals
  reject, (b) denial-form negatives must use source-emitted forms, (c)
  cosmetic wording — all three are honored in this contract's classification
  bindings and scenario wording.

## Repo files consulted at HEAD 717fb0a (read-only)

- `acceptance/subscription/README.md` — structural template: layout, honesty
  wording, acceptance-rules vocabulary, reading/usage/binding sections, #93
  amendment paragraph.
- `acceptance/subscription/manifest.json` — template for schema/contractId/
  status/qualification/capability/authority/baseline/candidate/launch/
  protocol/budget/requirements/receiptRequirements/gateOrder/evidenceClasses/
  outcomes/sources shapes.
- `acceptance/subscription/scenarios.json` — template for scenario classes
  (F/N/L/M), requirement mapping, status/blocker conventions, citation style.
- `acceptance/subscription/frozen.sha256.json` — frozen inventory shape and
  excludes convention.
- `acceptance/subscription/final.schema.json` — harness-neutral final schema,
  reused by reference (sha256 954dd71e…6792), not duplicated.
- `docs/architecture/subscription-harness.md` — template for the architecture
  decision note.
- `docs/coordinator.md` § "Direct-harness subscription budget mode (Taskbot
  #90)" — subscription-observed-v1, usage schema 2 statuses
  reported/ambiguous-zero/unknown, harnessReportedTokens, recovery_required,
  CI-reserve independence; referenced, not restated.
- `.qualification/subscription-contract-88/` and
  `.qualification/subscription-contract-88-amend-93/` — qualification record
  conventions (static-checks.json shape, evidence.sha256 shape).
- `git show 717fb0a` — commit message style for #93.

## Not read (out of scope / forbidden)

- `~/.claude` anything, keychain, env dumps, credential files.
- The `claude` binary itself (research already recorded its identity; this
  contract cites #94/872 F1 rather than re-measuring).
- Ticket #1 comment 863 (research itself could not read it; this contract
  relies on #94/#95 citing it, same as the research record did).
