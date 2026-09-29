# Method — #102 item 2 binary-identity chunked-hash performance

## What changed in src

`src/runner/process.ts` `measureBinaryIdentity` only. Before: `readFileSync`
buffered the whole file, then one `sha256.update(buffer)`; `bytes` came from
`buffer.length`. After: refusals are unchanged and in the same order
(non-absolute/non-string path → `binary-identity-missing`; symlink via
`lstatSync` → `binary-identity-drift`; non-regular via `statSync` →
`binary-identity-missing`), then a single `crypto` sha256 is updated from a
reused 4 MiB `Buffer.allocUnsafe` chunk via `openSync`/`readSync` (explicit
positional reads, `closeSync` in `finally`). Fully synchronous; bounded memory
(4 MiB buffer); safe to call inside the guarded-start transaction. `bytes` is
taken from `stat.size` of the same `statSync` whose `isFile()` gate was
already required — for a regular file this equals the number of bytes read to
EOF and equals the old `buffer.length` (verified by parity checks below and by
the unchanged X01/X09/L13/L14 tests). Return shape `{ path, sha256, bytes }`
unchanged; durable error names/semantics unchanged. No other src file touched.

## Measurement procedure

Script: `bench.mjs` in this directory (retained artifact). Run:

    export PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH"
    npm run build   # bench imports the shipped dist/runner/process.js
    node .qualification/binary-hash-perf-102/bench.mjs 2>&1 | tee .qualification/binary-hash-perf-102/measurement.log

- The "new" side imports the actual built `measureBinaryIdentity` from
  `dist/runner/process.js` — it measures the shipped code, not a copy.
- The "old" side is the pre-#102 implementation replicated inline in the
  script (readFileSync + one-shot sha256). No old code is kept in src.
- N=5 runs per side per case; reports min/median/max wall ms
  (`performance.now`) and RSS delta per run (`process.memoryUsage().rss`
  before/after each call, no forced GC — worst-case allocation shows up as
  the max/median delta).
- Cases:
  - `small-4KiB-random`: 4096-byte random file — the fake-CLI scale used in
    tests; proves no small-file regression.
  - `225MB-zero-filled`: exactly 235,929,600 bytes of zeros.
  - `225MB-random`: exactly 235,929,600 bytes from `crypto.randomBytes`
    (4 MiB random chunk rewritten). Both kinds measured because
    compression/filesystem caching behavior differs (APFS does not
    transparently compress these temp files; results confirmed near-identical
    timings for zero vs random).
- Parity: for every case the script asserts old and new return identical
  `sha256` and `bytes`, and fails loudly otherwise. All parities passed.

## File generation and cleanup

Big files were created ONLY under the pre-approved temp dir
`/var/folders/0s/94wd01s17jsdg_7jk3zfqsd40000gn/T/opencode/binary-hash-perf-102/`,
never inside the repo. The script deletes that whole directory in a `finally`
block; `measurement.log` ends with the cleanup line confirming deletion. The
225 MB files never entered the repo and no longer exist.

## Environment

Node v24.16.0 (darwin arm64), Apple M3 8-core, 16 GB RAM, measurements on
this dev machine with a warm page cache (N=5 repeated reads). The real
qualification environment may differ; numbers are order-of-magnitude evidence
that the C1 in-transaction cost is bounded (~90 ms class, ~4 MB RSS), not a
qualification measurement on the real pinned binary.
