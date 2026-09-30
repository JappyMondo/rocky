# #113 repair suite outcome

Pinned Node 24.16.0; each full run used `PATH="/Users/jappy/.nvm/versions/node/v24.16.0/bin:$PATH"` and all four `COORDINATOR_ARTIFACT_ROOT`, `CLAUDE_ARTIFACT_ROOT`, `CODEX_ARTIFACT_ROOT`, `OPENCODE_ARTIFACT_ROOT` set to `.qualification/opencode-hardening-112/suite-artifacts`.

1. `repair-suite-1.txt`: runner execution exceeded the tool's 120-second command timeout; incomplete, not green.
2. `repair-suite-2.txt`: 401 tests, 400 pass, 0 fail, 1 existing skip.
3. `repair-suite-3.txt`: 401 tests, 400 pass, 0 fail, 1 existing skip.
4. `repair-suite-4.txt`: ENOSPC while creating `.qualification/tests/...`; 57 failures, not green. Disk had 257 MiB available and 4.1 GiB of prior/generated suite artifacts. Removed only 1,539 ephemeral suite-artifact directories created by this repair's attempts (timestamp epoch >= 1790764400000), preserving logs, native captures and older evidence; disk then had 686 MiB available.

Three consecutive complete greens were **not** achieved. The bounded six-run budget cannot accommodate three new consecutive greens after attempt four; no further suite attempts were made. Focused `tests/runner.test.mjs`: 8/8 pass. `npm run build`, `npm run typecheck`, and Prettier check passed under Node 24.16.0. Re-run the three-green gate after securing sufficient artifact space before accepting the repair.
