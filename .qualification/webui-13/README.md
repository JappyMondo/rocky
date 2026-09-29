# Local operator integration evidence (#13, narrow #10/#12)

Scope: real SQLite, real local git/check processes, existing OpenCode owned fake CLI, fake GitHub transport. No live model/PR/merge evidence or paid calls.

- `typecheck.log`: passed.
- `focused-final.log`: 21 tests; 20 pass, 0 fail, 1 pre-existing browser skip. Includes repaired environment build guard and 7 new operator tests.
- `ci-final.log`: final missing-integration-SHA refusal assertion passed.
- `full-suite.log`: one full run, 406 tests; 403 pass, 2 fail, 1 pre-existing browser skip.
- `full-suite-failures.log`: preserves both original failures. Marker-path failure repaired and unchanged test passed in focused-final. Historical source-provenance still requires an absent archived fixture; not skipped or weakened. F08 passed in the full run.
- `retained/`: copied SQLite, receipts, logs, staged fake agent source; `retained-locations.json` records original paths. These large local artifacts are intentionally not committed.
- `final-build.log`, `package-smoke.log`, `cli-lifecycle.log`, `handoff.json`: final committed artifact/package/daemon verification, produced at handoff.

Current-head Attraccess environment assembly remains unimplemented in this slice and is explicitly blocked in preflight. Qualification/native evidence, isolated auth provisioning, and explicit live-run authority remain required before live execution.
