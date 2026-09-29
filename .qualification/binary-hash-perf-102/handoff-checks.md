# Handoff checks — #102 item 2 (binary-hash-perf-102)

## Change

`measureBinaryIdentity` in `src/runner/process.ts` converted from whole-file
`readFileSync` buffering to a chunked synchronous sha256 (reused 4 MiB
buffer, `openSync`/positional `readSync`/`closeSync`-in-`finally`). Return
shape `{ path, sha256, bytes }` unchanged; `bytes` from the gate `statSync`
size (equals old `buffer.length` for regular files — proven by parity checks
and unchanged tests). Refusals unchanged: non-absolute path/missing →
`binary-identity-missing`, symlink (lstat) → `binary-identity-drift`,
non-regular → `binary-identity-missing`. No async; memory bounded at one
4 MiB chunk; safe inside the guarded-start transaction. No other src changes.

## Measurement results (N=5 per side; dev machine Apple M3, Node v24.16.0, warm page cache)

| case | impl | min ms | median ms | max ms | RSS delta max |
| --- | --- | --- | --- | --- | --- |
| small 4 KiB random | old (readFileSync) | 0.0 | 0.0 | 0.3 | +0.2 MB |
| small 4 KiB random | new (chunked) | 0.0 | 0.0 | 0.1 | +0.1 MB |
| 225 MB zero-filled | old (readFileSync) | 103.4 | 105.2 | 121.4 | +225.3 MB |
| 225 MB zero-filled | new (chunked) | 88.1 | 88.3 | 88.7 | +4.0 MB |
| 225 MB random | old (readFileSync) | 104.0 | 105.7 | 116.1 | +225.0 MB |
| 225 MB random | new (chunked) | 87.6 | 87.9 | 88.9 | +0.1 MB |

sha256/bytes parity old==new asserted and passed for every case. Raw output:
`measurement.log`. Procedure/script: `method.md`, `bench.mjs`. Both 225 MB
files were generated under the pre-approved temp dir only and deleted by the
script after measuring (see cleanup line at end of `measurement.log`).

## Checks

| check | command | result | log |
| --- | --- | --- | --- |
| typecheck | `npm run typecheck` | pass | `typecheck.log` |
| build | `npm run build` | pass (pre-test, dist exercised by suite) | `build.log` |
| full tests | `npm test` | 376 tests / 375 pass / 0 fail / 1 skip | `test-full.log` |
| binary-identity tests | X01/X09 (both adapters), L13, L14 | all green, UNCHANGED — no test edited | `test-full.log` |
| format | `npx prettier --check` on touched files | pass | `prettier.log` |
| whitespace | `git diff --check` | clean | — |
| scope | `git status --porcelain` | only `src/runner/process.ts`, `docs/claude-code-adapter.md` (+ this ignored evidence dir, force-added) | — |

## Docs

`docs/claude-code-adapter.md` honest-limitations bullet updated factually:
chunked hashing implemented; 225 MB synthetic measurement cited (~88 ms
median new vs ~105 ms old, RSS ~4 MB vs ~225 MB, evidence dir referenced);
C1 in-transaction cost stated as bounded/small on this hardware but
explicitly NOT qualified — measured on synthetic files on a dev machine, not
the real pinned binary in the qualification environment.
`docs/codex-exec-adapter.md` has no equivalent whole-file-buffering bullet;
not touched.

## Verdict

The chunked-hashing implementation item of the pre-native perf gate is
closed: behavior identical (tests untouched and green), memory bounded,
C1 in-transaction cost ~90 ms class at 225 MB. The gate's
qualification-environment measurement on the real binary remains open and is
left flagged in the docs (honestly: dev-machine synthetic measurement is
evidence, not qualification).
