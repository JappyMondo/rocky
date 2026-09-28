# Independent harness contract (#59)

This is a proposed protected acceptance contract and a minimal synthetic native
probe, **not a qualified coding harness**. Taskbot #59 comments 476/477 define
H01–H10; sole authoring lease is epic comment 494. Independent review must accept
these files before producer qualification. No production transport, token gateway,
approval or `HardLimitsCapability` is implemented here.

## Static repair after rejected review (#62)

Review findings 511/512 rejected the first checker. Lease 518 repairs all three
without rerunning Codex or changing the old evidence:

1. `fixture.mjs` derives the exact allowed source/scratch and protected canary
   paths from the admitted attempt directory. The checker requires the complete
   fixed commands, shell, workdir, login flag, output bound and native command
   representation. A different denied path or command that prints a denial fails.
2. `provenance.mjs` reads a **reviewer-selected Git revision**, independently of
   the bundle, and derives its entire source inventory and manifest identity.
   The checker requires that revision in admission/inputs, matching contract
   identities, every retained source byte, and all 440 exact-binary schema files
   matching the protected schema inventory digest. Missing, changed, duplicate or
   extra retained source/schema bytes fail. `sourceFrozen: true` is insufficient.
3. Final agent-message start/completion must have the same thread and turn as
   the invocation, with both events preceding the terminal. Wrong/missing IDs or
   a final message after completion fail.

`assess()` is only the operation-sequence subcheck. It explicitly returns an
operations-only reason; callers must use `checkAttempt()` for full artifact and
provenance verification. The CLI defaults its trusted reference to canonical Git
HEAD, or takes an explicit reviewer-selected commit as its third argument. The
bundle never chooses that trusted revision. No revision is treated as independent
approval simply because it exists in Git.

The new tests load the unchanged rejected checker from commit `c13930b` into the
new repair evidence directory. They reproduce its false passes against wrong
targets, printed denial, missing/changed provenance, wrong-turn final messages and
post-terminal messages, then require rejection by the repaired path. Generated
unit data remains explicitly selftest evidence. `binding.test.mjs` additionally
uses real committed source objects and the 440 retained schemas through the same
provenance verifier; run it only at clean committed source.

Lease 518 artifacts remain under `.qualification/harness-contract-59-repair/`. The old
970-entry index and all old artifacts are preserved. Historical attempts lack the
new required bindings and continue to fail; they are never upgraded retroactively.

## Invocation identity repair (lease 536)

Reviews 531/532 found that consistently absent IDs still compared equal and an
empty startup response could resolve bookkeeping. The checker now requires one
unique, ordered, correlated `thread/start` and `turn/start` request/response pair.
It checks the required startup object/array/string/integer fields against the
bound 0.157.1 schema shapes and this finite probe's fresh-thread subset. RPC IDs
must be nonblank strings or safe integers; thread, turn and item IDs must be
nonblank strings without control characters. These operational identity rules
are deliberately stricter than the generated schema's unconstrained strings.

The correlated thread response must equal retained `thread.json`; the turn
request must name its thread. Observations and lifecycle events are checked
against the response-derived thread/turn, never used as identity authority.
Missing, malformed, duplicate, conflicting or unresolved startup chains fail.
Item identities are unique across the invocation, and terminal evidence must
follow the turn response with no pending request or item. This is a startup and
identity boundary validator, not a general-purpose JSON Schema implementation.

Lease 536 selftests wrote only to
`.qualification/harness-contract-59-identity-repair/`. They load the unchanged
rejected `d3d126a` checker and compare serialized JSON evidence, including global
absent/null/empty/malformed IDs and missing/conflicting/duplicate startup chains.
Already-rejected duplicate/missing responses stay rejected; they are not claimed
as new false-pass fixes. Positive fixtures include required actual-shaped thread
and turn response fields instead of `{}`. The old 970- and 621-entry inventories,
candidate, native failures and all provenance evidence remain unchanged. No
launcher/profile changes or native/server/schema/model/auth/API execution occur
in this repair. Independent rereview remains required; no capability is issued.

## Conservative policy candidate, still locked

`policy.mjs` renders the static candidate accepted in #63 comment 521 and root
comment 522. The concrete fragment and environment are retained under
`.qualification/harness-contract-59-repair/attempt-policy-candidate-2026-09-28/`.
This is a policy/pretrust/environment fragment, not a live provider configuration.

It includes `:minimal` read plus both exact denies and final root-and-descendant
deny globs for every reviewed shared-temp alias, Applications and broad host
config/database/library exclusion. It keeps writable source/scratch, read-only
synthetic `.git`, and private authority denies. HOME and TMPDIR are owned scratch
paths. A separate runtime CODEX_HOME helper subtree avoids pretending a read can
override a final deny on its parent. The actual selected helper must be inventoried
and hashed before any future dispatch; no helper identity is invented here.

The pinned macOS framework/executable maps, devices including `/dev/fd`, named
mach/syslog/shared-memory services and sandbox extensions are explicit trusted
dependencies. Filesystem denies do not remove those IPC/extension operations.
This is not an IPC-free or generic network-isolation claim. Static source-backed
alias/final-deny reasoning is not runtime shared-temp write proof: **no writes
outside the canonical tree are authorized or attempted**.

At the accepted static checkpoint the candidate was separate from the locked
launcher. The explicit #64 continuation below integrates that reviewed fragment
with actual helper observations. H01 can combine exact immutable
config/binary/no-override route evidence
with actual controls; raw internal policy tracing is optional stronger evidence.
Every full native/H03/gateway/live-provider gate remains unqualified.

The static Git fixture now has its own empty tree, one artificial commit and
`rocky-next` HEAD, ordinary refs/objects, no remotes, copied history or parent links.
Read-only Git tests resolve root/common metadata only inside that fixture. Exact
synthetic cwd pretrust is prepared separately; neither correction has been tested
through app-server yet. Startup 134 remains an unproved policy hypothesis.

## One bounded native continuation (#64, lease 551/553)

The only authorized invocation is
`node acceptance/harness/probe.mjs --execute-ticket-64-lease-551 --source-commit <exact-clean-HEAD>`.
It requires canonical root/branch, a clean matching source revision, and consumes
`.qualification/harness-native-64/lease-551-consumed.json` exclusively and durably
before starting app-server. Reuse fails even if admission or the native control
failed. This authority comes from the actual Taskbot lease, not an approval
generated by this code. The historical manifest lock still prohibits general
native qualification; the explicit lease permits this one investigation only.

The launcher uses `policy.mjs` unchanged: reviewed platform trust, final deny
globs, source/scratch writes, synthetic Git/pretrust, separate runtime CODEX_HOME
and owned HOME/TMPDIR. Config bytes are retained both at their actual runtime
path and at the protected checker snapshot path, then rehashed after thread
startup, before every native dispatch, after completion and after cleanup.
The exact generated helper subtree is inspected before dispatch: one session,
three expected Unix aliases to the pinned Codex binary, and its lock file. All
alias targets and the selected wrapper are retained with the binary digest.
Selection follows the pinned
[arg0 source](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/arg0/src/lib.rs);
it is source-derived evidence, not raw SBPL or intercepted exec telemetry.
Unknown/missing helpers stop the attempt; no permission expansion is inferred.

The 60-second total limit reserves 10 seconds for cleanup. Actual source and
scratch write/read success must precede either private-canary operation. A signal,
missing effect, unknown result, leaked canary, changed config or unaccounted route
stops dispatch. All raw frames, errors, helper/config observations and normal or
guardian cleanup stay retained. No retries, additional probe matrix, outside-temp
creation, real credentials/model/API or target effects are authorized. Shared
temp runtime denial and all broader capabilities remain unproven.

Current static selftests and this one attempt write only beneath
`.qualification/harness-native-64/`; prior 970/621/632-entry evidence inventories
remain unchanged. The accepted checker changes only its exact allowed evidence
root list; its assessment/provenance/operation semantics and H01–H10 are frozen.
Independent source/result review is required after the stopped handoff.

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
node --test acceptance/harness/check.test.mjs acceptance/harness/binding.test.mjs
node --check acceptance/harness/probe.mjs
node_modules/.bin/prettier --check acceptance/harness
node acceptance/harness/check.mjs .qualification/harness-contract-59/attempt-2026-09-28T01-24-06.796Z
```

The last command must exit 1 (missing/current-revision provenance); it is a retained
negative acceptance result. The old checker separately rejected its config change.
Native reproduction is intentionally locked pending independent review and a
new explicit lease. Do not launch `probe.mjs` as a reviewer. The final evidence
index binds all retained files and symlink metadata without following runtime
links. Raw synthetic Codex state/log databases are retained for diagnosis; caches
are not promoted to immutable runtime identities.

Trust model: the independent evaluator and host are trusted collectors; solver
and producer assertions are not. Hashes establish retained bytes, not immunity
to a trusted host forging a complete transcript. Admission needs a separate
independent review of exact contract/runtime/config/tool/provider identities and
all relevant receipts. A schema-shaped `hardTokenLimit: true` flag is not proof.
