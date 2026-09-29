# Handoff checks — #111 (PFC-1) request-schema wire projection + contract amendment

Worktree `/Users/jappy/.t3/worktrees/rocky/rocky-next`, branch `rocky-next`, baseline HEAD
`674fffed12a0d7d387f37d0a5edec757bfa4d16c` (verified clean at start; verified again before
commit). Node v24.16.0 via nvm. ONE commit; no push/branch/reset.

## Validation (all logs verbatim in this directory)

| Check                              | Result                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------ |
| `npm run typecheck`                | pass (typecheck.log, exit 0)                                             |
| `npm run build`                    | pass (build.log; build run before tests — tests exercise dist)           |
| `npm test` full suite              | pass (test-full.log): **378 tests, 377 pass, 0 fail, 1 skipped** (pre-existing skip). Baseline was 376/375/0/1 → suite GREW by 2 (X10, X11); no test removed; no predicate weakened. Final-state re-run after prettier --write on the test file. |
| `npx prettier --check` touched files | pass (prettier.log; one --write on tests/claude-code-launch.test.mjs before the final suite run) |
| `git diff --check`                 | clean                                                                    |
| `git status` scope                 | only owned paths: acceptance/claude-code/{README.md,manifest.json,frozen.sha256.json}, src/agents/claude-code/{adapter,config,index,projection}.ts, tests/claude-code-launch.test.mjs, docs/claude-code-adapter.md, this evidence dir (static check C-owned-scope) |
| static-checks.json                 | 11/11 pass: strict dup-key JSON parses, frozen rehash (only README+manifest re-frozen), scenarios byte-identical + counts 14 unexecuted/10 blocked, subscription final.schema.json untouched (raw sha256 954dd71e…6792 re-measured), projection determinism (32×) + hash pin, vocabulary audit (no 2020-12-exclusive keyword), prior-674fffe archive integrity, owned scope |

## Vocabulary audit (binding precondition — PASS)

Frozen `acceptance/subscription/final.schema.json` keywords: `$schema, $id, title, type,
additionalProperties, required, properties, const, enum, minLength, maxLength, pattern` — all
draft-07 with identical semantics; NO `prefixItems`/`dependentSchemas`/`$dynamicRef`/
`unevaluatedProperties`/2020-12-`contains`/`$vocabulary`/`$defs`. Draft-07 reading is
semantically identical ⇒ proceeded per the root design decision. Enforced at test time by the
X11 reference evaluator's unknown-keyword fail-closed guard.

## Adapter change summary

- NEW `src/agents/claude-code/projection.ts`: pure deterministic
  `projectClaudeWireRequestSchema(sourceText)` → `{canonical, sha256, sourceCanonical,
  sourceSha256}`; fail-closed on non-exact frozen 2020-12 `$schema`
  (`claude-request-schema-dialect`), non-deterministic derivation
  (`claude-request-schema-projection-nondeterministic`) and body round-trip drift
  (`claude-request-schema-projection-body-drift`); malformed/duplicate-key sources rejected via
  `parseStrictJson`.
- `config.ts`: `requestSchemaCanonical` is now the projected wire bytes; `requestSchemaSha256`
  is the projection hash (**sha256 of the projected canonical bytes** — note the prior field was
  `identity()` of the canonical string, i.e. a hash of the JSON-quoted string; no test or receipt
  pinned the old value); NEW `requestSchemaSourceSha256` pins the frozen source canonical hash.
  `configDigest` composition unchanged (derived fields are not part of it).
- `adapter.ts`: plan `requestSchemaSha256` (existing pin site, flows into the sealed bundle via
  argv/bundleDigest) now carries the projection hash; comment updated. No control-flow change.
- `index.ts`: exports `projection.js`.
- Host authority unchanged: `final.ts`/`stream.ts` untouched; re-validation remains against the
  frozen 2020-12 semantics.

Projection hash (pinned in manifest/README/X10): **sha256
`c02efee93dbeffb0e6f6153ba6d465804af4f31cb163d95ab76fe9f4b5b1a6e3`** (586-byte canonical wire
value); frozen source canonical sha256 `0e1c3a522774776c8954de8db979468faa473904e7cc92735c2f88e16ca0bd51`;
frozen raw file sha256 `954dd71e11a7b45ac86c9b30d96c9ef98d5fd40e2864568d149dd39c15986792`
(unchanged).

## Tests

- Amended: X02 (argv `--json-schema` element now asserted equal to the projected canonical bytes,
  explicit draft-07 dialect, body-identity round-trip to the frozen canonical, plan pins the
  projection hash) — strengthened, nothing removed.
- NEW X10: projection determinism (repeated + reformatted/shuffled-key sources), hash pin,
  body identity, config/plan pinning, fail-closed dialect guard (5 near-miss IRIs, omitted
  `$schema`, malformed JSON, duplicate keys, non-object) at both projection and
  `validateClaudeCodeConfig` level.
- NEW X11: PROJECTION-EQUIVALENCE over an 18-item corpus (valid final; missing required ×2;
  wrong types ×3; additionalProperties; nested enum/pattern/minLength/maxLength violations;
  boundaries 8192/8193 and 257; array/string/null instances): frozen 2020-12 document and
  projected draft-07 document accept/reject identically under a test-owned reference evaluator
  (unknown-keyword fail-closed), AND both agree with the shipped host validator
  `validateClaudeStructuredFinal`; plus end-to-end: a real spawned fake CLI records
  `--json-schema=<projected bytes>` element-for-element equal to the sealed bundle (the fake CLI
  does not itself schema-validate under its current contract — it records/echoes; recorded-argv
  equality is the fake-side assertion).
- Protocol/lifecycle suites (P01–P09, L01–L12) unchanged and passing: 23/23 before the full run.

## Native probe (exactly ONE authorized zero-turn probe — PASS)

- Binary identity gate FIRST: measured sha256 `d8cb1e5c…d21e`, 225,036,032 bytes at
  `/Users/jappy/.local/share/claude/versions/2.1.283` == pin ⇒ authorized to spawn.
- Fresh temp root `/var/folders/…/T/opencode/pfc1-probe-1790670224801-2NgaPy/`: synthetic UNAUTH
  empty `CLAUDE_CONFIG_DIR`, private empty HOME, sealed env from the shipped
  `buildClaudeSealedEnv`, projected schema from the shipped `dist.projectClaudeWireRequestSchema`,
  argv `-p --output-format=stream-json --verbose --input-format=text --json-schema=<projected>
  --model=claude-sonnet-4-5`, stdin `hi\n`+EOF, wall cap 30 s, bounded capture (R1 CC-P5/P2
  driver pattern).
- Observed (461 ms, exit 1): stderr EMPTY — **no schema rejection**; `system/init` emitted
  (StructuredOutput visible in init.tools); single result frame `"Not logged in · Please run
  /login"`, `is_error:true`, `terminal_reason:"api_error"`, `total_cost_usd:0`, `modelUsage:{}`
  ⇒ startup passed `--json-schema` validation and stopped at auth failure. ZERO model turns.
- Containment: CFG gains `.claude.json`, `backups/…`, `sessions/` (all inside the synthetic CFG,
  same class as R1 CC-P5); synthetic HOME gains none; temp root deleted after evidence copy; no
  orphan processes. Evidence: `native-probe/{verdict.md,probe.json,probe-stdout.log,
  probe-stderr.log,cfg-inventory-{pre,post}.json,probe.mjs}`.
- The probe executes/passes NO acceptance scenario (L03 stays blocked; it needs live authority).

## Anomalies / honest notes

1. During test development the first projection-hash pin was computed with `identity()` (hash of
   the JSON-quoted canonical string) instead of `digest()` (hash of the bytes); caught by X10
   before any commit, corrected in `projection.ts` to true byte hashes per the ticket ("sha256 of
   projected bytes"). The prior config field had the `identity()` quirk; no shipped consumer or
   test pinned it, and the new semantics are byte-exact.
2. `git status` porcelain parsing in the first static-check run mis-sliced the first line
   (script bug, not a repo state issue); corrected and re-run — 11/11 pass.
3. The full suite was run twice (pre- and post-prettier); test-full.log is the FINAL-state run.
4. R1 CC-P5 observed the same CFG startup-write class despite
   `--no-session-persistence`+checkpointing disabled; this probe reproduces that observation
   (already an open G-WRITES gate item; nothing new claimed).

## Commit

ONE commit on `rocky-next`; evidence files force-added per house precedent (small text only:
logs/json/md, no bulky artifacts — the 3.7 KB probe stdout is the largest capture; probe-stderr
is 0 bytes).
