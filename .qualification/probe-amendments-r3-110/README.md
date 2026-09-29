# probe-amendments-r3-110 — evidence directory (Taskbot #110, R3)

Root-owned status/gate WORDING amendment of `acceptance/claude-code/**` and
`acceptance/subscription/**` (+ factual notes in the two
`docs/architecture/*-harness.md`) consuming the root-accepted R1 #108 zero-turn
native-probe evidence (triage comment 972) and the #111 native confirmation
probe (acceptance comment 978). Sole mutation lease; baseline
`f3c809a9941314e59f5da3b941ab796c214ade84`; branch `rocky-next`; ONE commit.

**Cardinal discipline (machine-verified in `static-checks.json`):** no scenario
executed; no `status` enum changed; counts before == after (claude-code 14
unexecuted + 10 blocked; subscription 18 unexecuted + 11 blocked); scenario
diffs touch ONLY `blocker` strings (7 lines); no gate closed; every claim cites
probe evidence that exists on disk (46 unique cited paths script-verified);
`acceptance/subscription/final.schema.json` untouched (`954dd71e…6792`); no
`src/**`/`tests/**` change; full suite green (378 tests / 377 pass / 0 fail /
1 pre-existing skip); prior bytes of every modified file archived under
`prior-f3c809a/` and verified equal to `git show f3c809a:<path>`.

## Contents

- `amendments.md` — the amendment log (site → old → new → evidence cite →
  rationale), plus "no change needed" determinations and the honesty list of
  what the evidence did NOT support.
- `static-checks.py` — the read-only static-check driver (deterministic;
  re-runnable at the baseline tree).
- `static-checks.json` — results: 8/8 pass (strict dup-key JSON parse;
  scenario status/field discipline; frozen re-hash both dirs; final.schema
  untouched; prior-archive integrity; citation existence; src/tests untouched;
  `git diff --check` clean).
- `evidence.sha256` — JSON inventory (NOT `shasum -c` format) of every file in
  this directory, the two append-only correction notes, all amended repo paths
  with prior+amended hashes, and the re-measured untouched authority hash.
- `build.log`, `typecheck.log`, `test-full.log`, `prettier.log`,
  `git-diff-check.log` — retained command logs (no trailing blank lines; the
  F1 finding on the #111 typecheck.log was not repeated here).
- `prior-f3c809a/` — prior-byte archive of all 10 modified files.

## Companion correction notes (append-only; retained evidence bytes NEVER edited)

- `.qualification/native-probes-R1/corrections/README.md` — F2/F3/F4 from the
  #111 root acceptance (comment 978): the synthetic-assistant-frame wording
  fix, the "32 derivations" count correction (X10 does 24 outer), and the
  `num_turns:1` aborted-auth-turn clarification.
- `.qualification/claude-code-contract-95-amend-pfc1-111/corrections/README.md`
  — F1 (retained typecheck.log trailing blank line; literal `git diff --check`
  over `674fffe..f3c809a` flags it; the source tree itself is clean) + the
  evidence.sha256 JSON-inventory format note.

No scenario was executed by this amendment; probes are not scenario
executions; `qualification=false`, `capability=null`,
`executionAuthorized=false` unchanged in both contracts.
