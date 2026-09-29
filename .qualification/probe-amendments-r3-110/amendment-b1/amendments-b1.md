# amendment-b1 — #110/R3-B1 repair log (CC-P3 observation wording)

Sole-mutation-lease repair of ONE blocking review finding (B-1, spec review of
`f3c809a..15b28af`) plus spec suggestion (a). Baseline
`15b28affbeaf922ea2751590a11ef222ea9bc6d0`, branch `rocky-next`, ONE commit.
qualification=false, capability=null; NO scenario executed, NO status enum
changed, NO gate closed, no `src/**`/`tests/**` change, no
subscription-contract change, retained probe evidence bytes UNTOUCHED
(re-measured in `evidence-b1.sha256.json`).

## The finding (B-1)

Four sites recorded the CC-P3 observation STRONGER than the evidence: they
claimed invalid `--settings` produced a "byte-identical auth-failure frame
sequence to the valid baseline". The retained raw captures contradict literal
byte identity — the three stdout captures have DIFFERENT sha256s
(baseline-valid `45de2867…`/3705 B, unknown-key `591e8457…`/3702 B,
malformed-json `b42fde16…`/3705 B) because per-run identifiers differ
(`session_id`, uuids, socket path, cwd, durations) — and the malformed-json
init frame observably carries `permissionMode:"default"` vs the baseline's
`"dontAsk"` (the settings file was dropped wholesale, which STRENGTHENS the
silent-ignore hazard). The driver only compared exitCode + first 200 stderr
chars (`.qualification/native-probes-R1/drivers/run-phase3.mjs:198`,
`sameShape`). Direction B itself (silent ignore), the
`validateClaudeSettingsBytes`-mandatory consequence, and G-SET-stays-open
remain fully supported and are UNCHANGED by this repair.

Replacement claim at every site (adapted to each voice, citations kept):
invalid `--settings` (unknown key; malformed JSON) was silently ignored —
same exit 1, empty stderr, no settings mention anywhere in output, and the
same auth-failure frame SHAPE as the valid baseline (synthetic assistant
"Not logged in" frame + result `is_error:true` / `terminal_reason:api_error`);
raw captures NOT byte-identical (per-run identifiers differ; captures retained
in `probes/CC-P3/`); the malformed run's init frame reverted `permissionMode`
to `default` vs baseline `dontAsk`; cites the CC-P3 captures +
`drivers/run-phase3.mjs:198` sameShape. Direction B confirmed;
`validateClaudeSettingsBytes` pre-spawn validation remains evidence-bound
mandatory; G-SET effectiveness closure still requires CC-L2 (LIVE, NOT run).

## Site 1 — `acceptance/claude-code/manifest.json` G-SET gate (~line 658)

- OLD: `…DIRECTION B natively confirmed — invalid --settings (unknown key; malformed JSON) is SILENTLY IGNORED, producing a byte-identical auth-failure frame sequence to the valid baseline, zero turns.`
- NEW: `…DIRECTION B natively confirmed — invalid --settings (unknown key; malformed JSON) is SILENTLY IGNORED: same exit 1, empty stderr, no settings mention anywhere in output, and the same auth-failure frame SHAPE as the valid baseline (synthetic assistant 'Not logged in' frame + result is_error:true / terminal_reason:api_error), zero turns. NOT byte-identical: the three retained stdout captures have distinct sha256s because per-run identifiers differ (session_id/uuids/socket path/cwd/durations), the driver's sameShape check covered only exitCode + first 200 stderr chars (drivers/run-phase3.mjs:198), and the malformed-settings run's init frame observably reverted permissionMode to 'default' vs the baseline's 'dontAsk' — the settings file was dropped wholesale, which STRENGTHENS the silent-ignore hazard.`
- Trailing source line extended with the CC-P3 stdout captures + `run-phase3.mjs:198 sameShape` + `#110/R3-B1 correction`. Consequence/gate-open sentences UNCHANGED.
- Evidence: `probes/CC-P3/stdout-{baseline-valid,unknown-key,malformed-json}.log` (hashes/sizes above re-measured; init frames carry `permissionMode` `dontAsk`/`dontAsk`/`default`; result frames `"Not logged in · Please run /login"`, `is_error:true`, `terminal_reason:"api_error"`), `drivers/run-phase3.mjs:198`.

## Site 2 — `acceptance/claude-code/manifest.json` `settings.silentIgnoreWarning` (~line 418)

- OLD: `…invalid --settings (unknown key; malformed JSON) is silently ignored — byte-identical auth-failure frames to the valid baseline (Direction B) — so the shipped fail-closed validateClaudeSettingsBytes pre-spawn validation is evidence-bound mandatory;…`
- NEW: `…invalid --settings (unknown key; malformed JSON) is silently ignored — same exit 1, empty stderr, no settings mention anywhere in output, and the same auth-failure frame SHAPE as the valid baseline (synthetic assistant 'Not logged in' frame + result is_error:true / terminal_reason:api_error) (Direction B); the raw stdout captures are NOT byte-identical (per-run identifiers session_id/uuids/socket path/cwd/durations differ; captures retained in probes/CC-P3/), the driver's sameShape check covered only exitCode + first 200 stderr chars (.qualification/native-probes-R1/drivers/run-phase3.mjs:198), and the malformed-settings run's init frame observably reverted permissionMode to 'default' vs the baseline's 'dontAsk' — the settings file was dropped wholesale, which strengthens the silent-ignore hazard — so the shipped fail-closed validateClaudeSettingsBytes pre-spawn validation is evidence-bound mandatory;…`
- Trailing source extended with captures + `run-phase3.mjs:198` + `#110/R3-B1 correction`. Evidence: same as Site 1.

## Site 3 — `acceptance/claude-code/scenarios.json` N04 `blocker` (~line 186)

- ONLY the N04 `blocker` string changed; `status` stays `"blocked"`; no other
  scenario field, count or top-level key touched (machine-verified in
  `static-checks-b1.json`: field diffs = `[("N04","blocker")]`).
- OLD: `…invalid --settings (unknown key; malformed JSON) is SILENTLY IGNORED, byte-identical auth-failure frames to the valid baseline (Direction B) — so the shipped fail-closed validateClaudeSettingsBytes pre-spawn validation is evidence-bound mandatory.… (source: .qualification/native-probes-R1/probes/CC-P3/verdict.md).`
- NEW: `…invalid --settings (unknown key; malformed JSON) is SILENTLY IGNORED: same exit 1, empty stderr, no settings mention in output, and the same auth-failure frame SHAPE as the valid baseline (Direction B); the raw captures are NOT byte-identical (per-run identifiers session_id/uuids/socket/cwd/durations differ) and the malformed run's init frame observably reverted permissionMode to 'default' vs the baseline's 'dontAsk' (settings dropped wholesale, strengthening the hazard) — so the shipped fail-closed validateClaudeSettingsBytes pre-spawn validation is evidence-bound mandatory.… (source: .qualification/native-probes-R1/probes/CC-P3/verdict.md + stdout captures; .qualification/native-probes-R1/drivers/run-phase3.mjs:198 sameShape; #110/R3-B1).`
- Evidence: same as Site 1.

## Site 4 — `acceptance/claude-code/README.md` (~line 173)

- OLD: `…(PASS) confirmed **Direction B** — invalid --settings (unknown key; malformed JSON) is silently ignored, byte-identical auth-failure frames to the valid baseline — so the shipped fail-closed validateClaudeSettingsBytes pre-spawn validation is evidence-bound mandatory;…`
- NEW: `…(PASS) confirmed **Direction B** — invalid --settings (unknown key; malformed JSON) is silently ignored: same exit 1, empty stderr, no settings mention anywhere in output, and the same auth-failure frame _shape_ as the valid baseline (synthetic assistant "Not logged in" frame + result is_error:true / terminal_reason:api_error). The raw captures are **not** byte-identical — per-run identifiers (session_id, uuids, socket path, cwd, durations) differ — and the malformed run's init frame observably reverted permissionMode to default vs the baseline's dontAsk: the settings file was dropped wholesale, which strengthens the hazard. So the shipped fail-closed validateClaudeSettingsBytes pre-spawn validation is evidence-bound mandatory;…`
- Paragraph trailing source extended with `CC-P3 stdout captures + .qualification/native-probes-R1/drivers/run-phase3.mjs:198 sameShape` and `#110/R3-B1 correction`. Evidence: same as Site 1.

## Site 5 (spec suggestion a) — `acceptance/claude-code/manifest.json` G-MANAGED gate (~line 662)

- Finding: the G-MANAGED annotation cited `probes/CC-P1/verdict.md` for the
  real-host managed-layer ABSENCE; the actual absence inventory lives in
  `.qualification/native-probes-R1/environment.md:25-32`. CC-P1 supports only
  the synthetic present-layer refusal half (its verdict records the
  `claude-managed-layer-present` refusal against a synthetic layer, zero
  spawn), so the CC-P1 cite is KEPT for that half.
- OLD: `OBSERVED (partial, R1 #108 CC-P1, PASS): the real host managed/MDM layers were re-inventoried on the probe host and are ALL ABSENT (lstat names-only; contents never read), and the shipped discovery refusal claude-managed-layer-present fires pre-spawn against a synthetic present layer (zero spawn). … (source: .qualification/native-probes-R1/probes/CC-P1/verdict.md; #110/R3).`
- NEW: `OBSERVED (partial, R1 #108): the real host managed/MDM layers were re-inventoried on the probe host and are ALL ABSENT (lstat names-only; contents never read; inventory: .qualification/native-probes-R1/environment.md:25-32), and the shipped discovery refusal claude-managed-layer-present fires pre-spawn against a synthetic present layer (zero spawn) (CC-P1, PASS). … (source: .qualification/native-probes-R1/environment.md:25-32 (real-host absence inventory); .qualification/native-probes-R1/probes/CC-P1/verdict.md (synthetic present-layer refusal); #110/R3; #110/R3-B1).`
- Evidence: `environment.md:25-32` (heading `## G-MANAGED real-host managed-layer inventory`, seven `→ absent` entries); `probes/CC-P1/verdict.md` observed.C refusal string.
- Determination (no change): the batch note at manifest ~line 733 summarizes
  the whole R1 probe batch and cites no verdict.md for the absence; the README
  G-MANAGED sentence cites the probe DIRECTORIES collectively at paragraph
  end. Both left untouched to keep the repair minimal; the finding named the
  single G-MANAGED annotation citing `CC-P1/verdict.md`.

## Frozen re-freeze

`acceptance/claude-code/frozen.sha256.json` re-hashed for the three changed
files only (README.md, manifest.json, scenarios.json);
`docs/architecture/claude-code-harness.md` entry byte-identical to baseline
(`184e9477…fc08e`, 7699 B) — machine-verified in `static-checks-b1.json`.
Final frozen entries: README.md 26068 B `ce7c782c…`, manifest.json 75568 B
`c3cd8629…`, scenarios.json 32455 B `570da0a3…` (full hashes in the frozen
file).

## Static checks (`static-checks-b1.py` → `static-checks-b1.json`: 12/12 PASS)

dup-key JSON parse (3 files); scenario counts unchanged AND equal 14
unexecuted + 10 blocked; scenarios diff = ONLY N04 `blocker`; frozen re-hash
matches disk and untouched entry stable; zero remaining "byte-identical …
frame" claims tied to CC-P3 in the three text files (remaining occurrences of
"byte-identical" are explicit NOT-byte-identical negations); prior-archive ==
`git show 15b28af:<path>` for all four files; only the four owned files
changed vs baseline; `git diff --check` clean; evidence facts re-verified
(capture hashes/sizes, permissionMode default-vs-dontAsk revert, sameShape at
run-phase3.mjs:198, environment.md:25 heading). `prettier --check` clean on
all four touched files (one iteration: `*shape*` → `_shape_` in README).

## Suite

`npm run build` exit 0; `npm run typecheck` exit 0; `npm test` exit 0 —
**378 tests / 377 pass / 0 fail / 1 pre-existing skip** (unchanged from the
R3 amendment; contract hashes are computed at runtime by
`tests/claude-code-support.mjs`, not hardcoded, so no test edits were needed
or made).

## Prior bytes

`prior-15b28af/acceptance/claude-code/{manifest.json,scenarios.json,README.md,frozen.sha256.json}`
— each verified equal to `git show 15b28affbeaf922ea2751590a11ef222ea9bc6d0:<path>`.
