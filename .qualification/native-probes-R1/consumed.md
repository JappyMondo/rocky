# R1 consumed-probe list (no silent re-runs)

- CC-P0 2026-09-29T07:02:32.792Z verdict=PASS
- CX-P0 2026-09-29T07:02:32.900Z verdict=PASS
- CC-P1 2026-09-29T07:02:41.903Z verdict=PASS
- CC-P7i 2026-09-29T07:02:41.922Z verdict=PASS
- CX-P2a 2026-09-29T07:02:41.923Z verdict=PASS
- CX-P2c 2026-09-29T07:02:41.923Z verdict=PASS
- CC-P2 2026-09-29T07:04:38.325Z verdict=PRODUCT_FAILURE_CANDIDATE
  # CORRECTION (post-hoc, NO re-run/NO new spawn): initial auto verdict was a driver-heuristic FALSE POSITIVE
  # (regex matched "Unknown" inside a WARNING string). Retained raw evidence shows all 5 sub-cases match the frozen
  # claims; corrected verdict=PASS. Original preserved at probes/CC-P2/verdict-initial-auto.json. Consumed ONCE; not re-spawned.
- CC-P3 2026-09-29T07:04:39.371Z verdict=PASS
- CC-P7ii 2026-09-29T07:04:39.556Z verdict=PASS
- CC-P5 2026-09-29T07:04:41.512Z verdict=PASS
  # CORRECTION (documented single remediation re-run, zero-turn): initial native captures were 0 bytes (driver log-path
  # read defect). Re-run captured command.duplex.frames + receipt + run-tree walk ⇒ corrected verdict=PRODUCT_FAILURE_CANDIDATE
  # (pinned claude 2.1.283 rejects the contract's --json-schema draft 2020-12; G-WRITES sub-observation still PASS-quality).
  # Original preserved at probes/CC-P5/verdict-initial-auto.json; remediation evidence at probes/CC-P5/rerun-*.json + diag-json-schema.json.
- CC-P6 2026-09-29T07:04:45.269Z verdict=PASS
- CX-P1 2026-09-29T07:15:51.270Z verdict=PASS
- CX-P2b 2026-09-29T07:15:51.313Z verdict=PASS
- CX-P3 2026-09-29T07:16:07.962Z verdict=PASS
  # CORRECTION (documented single remediation re-run, zero-call): initial capture 0 bytes ⇒ threadStarted mis-read false.
  # Re-run captured 14 frames ⇒ threadStarted=TRUE (thread.started + turn.started + model-endpoint contact + 401 + turn.failed).
  # Corrected verdict=PRODUCT_FAILURE_CANDIDATE (plan's "before thread start"/"no partial thread.started" premise contradicted;
  # zero-billing HELD via 401; adapter settled fatal correctly). Original at probes/CX-P3/verdict-initial-auto.json; re-run at rerun-cx-p3.json.
- CX-P4 2026-09-29T07:16:24.290Z verdict=PASS
  # RE-RUN CONFIRMED (remediation, zero-call): config.toml byte-identical (sha256 e20e1626…, 88B pre==post, drift=null,
  # no trust_level) EVEN THOUGH a thread started ⇒ F5 untrusted-projects override prevented persistence. Verdict stands PASS. Evidence at rerun-cx-p4.json.
- CX-P5 2026-09-29T07:16:24.304Z verdict=PASS

## Remediation + diagnostic spawns (post-freeze, hashed addenda; all zero-turn/zero-call, bounded, documented — NOT silent re-runs)
- run-remediate.mjs (drivers.sha256 ADDENDUM): single documented re-run of CC-P5 + CX-P3 + CX-P4 to remediate the Tier-A
  native-capture log-read defect (captured command.duplex.frames + receipts + run-tree walks). Original evidence preserved.
- diag-json-schema.mjs (drivers.sha256 ADDENDUM 2/2b): Tier-B draft-isolation diagnostic for the CC-P5 --json-schema
  rejection (5 schema variants; first attempt hit a driver bug — missing mkdir cwd ⇒ exit -2/no data — fixed, re-hashed, re-run once).
- No plan probe (CC-P0..CC-P8, CX-P0..CX-P5) was silently re-run; consumed entries above are the single authoritative run each,
  with corrections/re-runs explicitly annotated. No STOP trigger fired (no identity drift, no two-consecutive ENVIRONMENT_FAILURE,
  no wall-cap timeout, no containment breach).
