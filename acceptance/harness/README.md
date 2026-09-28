# Independent harness contract (#59)

This is a proposed protected acceptance contract and a minimal synthetic native
probe, **not a qualified coding harness**. Taskbot #59 comments 476/477 define
H01–H10; sole authoring lease is epic comment 494. Independent review must accept
these files before producer qualification. No production transport, token gateway,
approval or `HardLimitsCapability` is implemented here.

`manifest.json` is normative. Contract acceptance, synthetic native evidence,
synthetic gateway evidence, real provider proof and target coding acceptance are
separate gates. A fake Responses server cannot attest a real model or output cap.
Elapsed limits mean local execution/no new dispatch within the fixed deadline,
with cleanup time reserved inside it and remote token exposure still reserved.
They do not promise instantaneous provider cancellation.

## Current result: native feasibility blocked

Both attempts are retained below
`.qualification/harness-contract-59/`:

| Attempt                            | Actual observation                                                                                                                                            | Interpretation                                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `attempt-2026-09-28T01-22-15.360Z` | Strict roster guard rejected `request_user_input` and goal tools before native dispatch.                                                                      | Configuration preparation failed; no containment evidence.                                       |
| `attempt-2026-09-28T01-24-06.796Z` | Corrected tool configuration reached three native `exec_command` calls. Allowed write/read exited 134, no file created; protected read/write also exited 134. | Positive control failed. Unchanged canary does not establish denial. Root cause remains unknown. |

The second app-server turn completed and the original driver exited zero. Those
are retained transport observations, **not an accepted pass**. The checker rejects
that pattern. The original driver also dispatched the remaining two operations
after the failed positive control; the final driver stops at the first failure.
The false-pass condition has checker unit coverage. The repaired driver has not
been rerun natively.

In both attempts Codex appended a trusted-project entry for
`/Users/jappy/code/jappyjan/rocky` to the **owned private** config despite synthetic
cwd and an empty `.git` marker. Prelaunch hashes differ from retained config
hashes. The checker independently rejects this change. No effective sterile
boundary is claimed; incidental ancestor/Git discovery is unresolved. No real
auth/config was intentionally supplied or inspected, and the only configured
inference endpoint was owned loopback with a fake credential.

`assessment/corrections.json` preserves both findings. Reconstructed requested
config prefixes match each original prelaunch SHA256 exactly; the original
postlaunch files are unchanged. `historical-source-bindings.json` identifies exact
loaded source snapshots. The exit134 attempt's entire loaded source is retained
and hash-verified. The earlier roster-rejected attempt lacks exact historical
`probe.mjs` bytes: its original hash/config/evidence remain, but reverse-edit
reconstruction did not match, so no substitute is presented. This is an explicit
historical evidence gap. Future attempts snapshot source before dispatch.

Normal cleanup in both attempts found no surviving registered process group,
closed the endpoint and received guardian normal-stop/exit0 within the 60-second
total bound. Guardian recovery was not exercised. No service remains running.
Schema generation is retained under `schema-discovery/`; it used the same pinned
binary with a separate sterile HOME/CODEX_HOME and no model calls.

**No more native execution under lease494.** The manifest locks the driver while
#61 independently diagnoses exit134 and project discovery. Do not disable that
guard merely to repeat the known failure. The smallest next design question is a
valid synthetic repository-root isolation strategy plus exact native runtime
startup requirements, without granting broad filesystem reads. There is no
evidence yet identifying a specific missing permission as the cause of 134.

## Files and interpretation

- `probe.mjs`: one owned loopback SSE endpoint, one pinned app-server and three
  ordered native operations. Uses only fake credentials/canaries. Requires exact
  root/branch before writes. Total 60 seconds reserves 10 for cleanup; bounded
  request/log sizes and no automatic inference retries. Raw requests, argv,
  environment allowlist, config, schema inventory, loaded source, tool roster,
  native command events, terminal and cleanup are retained privately.
- `guardian.mjs`: bounded recovery of the explicitly registered process group,
  guarded by leader PID/start/group identity. Unknown identity remains unresolved.
  This basic guardian is not proof of H05 detached-descendant containment.
- `check.mjs`: verifies artifact bytes and required references, prelaunch config
  identity, dispatch/start/result/roundtrip order, matching IPC IDs/items/terminal,
  native positive control, ordinary OS denial, file hashes, and normal cleanup.
  It never emits a capability or approval, including on minimal-probe pass.
- `check.test.mjs`: generated unit fixtures exercise false-pass rejection. Unit
  fixtures are not native evidence. Tests create only owned ignored selftest data.
- `common.mjs`: exact root guard, hashes, private writes and process observation.

The full H01–H10 matrix remains explicit in the manifest. Only basic H02-P01 was
attempted. H01 failed effective-config validation. H03 alternate paths/ambient
authority, full H04 protocol faults, H05 descendants/recovery, H06 lost-start,
H07/H08 gateway and H09 live provider probes are **unexecuted/blocked**. H10's
production authority loader is also absent. No broad stub implementation stands
in for those gates. #8 comment488 records absent API access in inspected references;
credentials or ChatGPT auth extraction must never be inferred.

## Review commands

From the exact canonical root on `rocky-next`:

```sh
node --test acceptance/harness/check.test.mjs
node --check acceptance/harness/probe.mjs
node_modules/.bin/prettier --check acceptance/harness
node acceptance/harness/check.mjs .qualification/harness-contract-59/attempt-2026-09-28T01-24-06.796Z
```

The last command must exit 1 (`loaded-config-changed`); it is a retained negative
acceptance result. Native reproduction is intentionally locked pending #61 and a
new explicit lease. Do not launch `probe.mjs` as a reviewer. The final evidence
index binds all retained files and symlink metadata without following runtime
links. Raw synthetic Codex state/log databases are retained for diagnosis; caches
are not promoted to immutable runtime identities.

Trust model: the independent evaluator and host are trusted collectors; solver
and producer assertions are not. Hashes establish retained bytes, not immunity
to a trusted host forging a complete transcript. Admission needs a separate
independent review of exact contract/runtime/config/tool/provider identities and
all relevant receipts. A schema-shaped `hardTokenLimit: true` flag is not proof.
