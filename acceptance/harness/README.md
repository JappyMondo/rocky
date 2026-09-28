# Independent harness contract (#59)

This is a proposed protected acceptance contract and a minimal synthetic native
probe, **not a qualified coding harness**. Taskbot #59 comments 476/477 define
H01–H10; authoring and repair authority is recorded below. Independent review must accept
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
synthetic cwd pretrust is prepared separately; both were subsequently exercised in the single lease 551 attempt. Historical
startup 134 is not retroactively attributed to a specific missing permission.

## One bounded native continuation (#64, lease 551/553)

The historical invocation, now durably consumed, was
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

The lease 551 static selftests and its one attempt wrote only beneath
`.qualification/harness-native-64/`; prior 970/621/632-entry evidence inventories
remain unchanged. The accepted checker changes only its exact allowed evidence
root list; its assessment/provenance/operation semantics and H01–H10 are frozen.
Independent source/result review is required after the stopped handoff.

## Prepared continuation identity (#64, static lease 613)

After static acceptance609, lease613 prepares a distinct one-shot identity for a
possible future native attempt. **This is not execution permission.** Independent
#69 Phase A acceptance and a separate explicit root execution lease must precede
any invocation. No new approval or capability is generated by the gate.

The prospective command is
`node acceptance/harness/probe.mjs --execute-ticket-64-lease-613 --source-commit <reviewed-clean-source-commit>`.
The handoff supplies its exact committed revision. The receipt path is fixed:
`.qualification/harness-native-64/lease-613-consumed.json`. The old551 flag still
maps only to its permanently consumed `lease-551-consumed.json`; changing the
source revision does not create another receipt or reset either identity.

`nativeGatePath()` derives the path from the complete validated invocation
identity. Root, branch, clean matching commit and exact argv are required. New
metadata explicitly records `preparationOnly` and the separate root execution
lease prerequisite, one maximum attempt, 60-second total and 10-second cleanup
reserve. Consumption performs exclusive private creation, writes the exact
receipt, fsyncs the file, closes it, and fsyncs the containing directory before
any owned endpoint/process launch. Partial writes or fsync failures stop dispatch
and leave the identity consumed. The launcher supplies no alternate filesystem.

`native-gate.test.mjs` maps only the storage IO beneath
`.qualification/harness-native-64-continuation/`, while exercising the actual
canonical-path guards, exclusive writes and fsync calls. No native evidence root
is mutated by those static tests. Failure injection verifies that neither file
nor directory fsync failure can proceed to a simulated dispatch, and reuse fails
even at another source revision. The accepted checker, settlement, config, policy,
commands, manifest, provenance and limits remain byte-identical to `b04f83f`.
The old integration test file is retained unchanged; do not run its historical
storage-writing tests as part of this preparation. Targeted Phase A validation:

```sh
node --test acceptance/harness/native-gate.test.mjs
```

## Independent loaded-config repair (lease 573)

SPEC-65-01 found that the launcher had moved its actual config into the runtime
tree while the independent checker still required only the private snapshot.
`loadedConfigLayout()` now derives the actual path from the admitted canonical
attempt root: native-64 uses `runtime/codex-home/config.toml`; the historical
roots use `private/codex-home/config.toml`. `checkAttempt()` supplies that derived
layout to the verifier, requires the actual file in its verified inventory,
binds `inputs.env.CODEX_HOME`, and compares actual bytes, snapshot bytes and
`inputs.configSha256`. Config-after summaries are not identity authority.

Static config regressions retain and execute the exact old assertion block from
commit `8930b48`. They reproduce its acceptance of missing runtime bytes, changed
runtime bytes with a refreshed inventory, and wrong/missing CODEX_HOME, then
require rejection at the repaired boundary. These are explicitly config-boundary
selftests, not claims that a full native attempt passed. Additional controls cover
missing inventory membership, snapshot mismatch and both supported layouts.
Relocated test artifacts live only under `.qualification/harness-native-64-repair/`;
the actual checker always derives layout from its admitted directory itself.

The historical native attempt remains failed. Lease 551 is consumed; this repair
does not change the launcher, policy, denial criteria or authorize any native run.

`manifest.json` is normative. Contract acceptance, synthetic native evidence,
synthetic gateway evidence, real provider proof and target coding acceptance are
separate gates. A fake Responses server cannot attest a real model or output cap.
Elapsed limits mean local execution/no new dispatch within the fixed deadline,
with cleanup time reserved inside it and remote token exposure still reserved.
They do not promise instantaneous provider cancellation.

## Source-bound terminal-denial variant (#68, lease extension 579)

Independent recommendation #67/575 and root approval #59/576 authorize the
separately versioned `source-bound-terminal-denial-v1` observation mechanism.
Contract v3 retains the H01–H10 requirement array byte-for-byte as JSON data.
This static implementation has **not been exercised natively or independently
approved**. Gate 551 remains consumed; this work neither resets it nor grants a
new invocation. No production gateway or capability is created.

`settlement.mjs` joins the authenticated native provider result and matching
command events by exact call ID within the original 50-second work deadline.
The positive source/scratch control always needs native start/completion, exit
zero, exact output and independently reread effects. The normal eventful denial
path retains its existing checks. Result-before-events is handled by an
observable same-call join, without a silence timer or changing the command.

For the two fixed private operations only, a zero-event result can provisionally
settle through the alternate. Metadata must begin at byte zero and match the
pinned native formatter: Chunk ID, finite four-decimal wall time, terminal integer
exit, original token count, then Output. The exit must be 1–127 and the entire
body must be the operation-specific OS diagnostic naming the exact canary path.
The read form was observed historically. The two explicit `/bin/sh:` redirection
forms are prospective write grammars; they have not been observed in a completed
native probe. Unknown output fails. Running sessions, truncation, parser errors,
stdout/header spoofing, altered commands/args, unrelated denials and missing or
reused result identities fail.

A provisional result is accepted only after the complete journal has no native
events for that call, a matching final message precedes completed terminal,
stdout reaches EOF, app-server exits normally and owned resources are quiescent
inside the original 60-second total. Any late/partial/conflicting event fails;
there is no retrospective path switch. All three operations and four complete
provider round trips are mandatory. Repeated cumulative provider history is an
immutable reference to old envelopes; it cannot count as a fresh operation.
The provider envelope has no thread/turn fields: its association is explicitly
derived from the sole startup-correlated owned invocation, not an invented field.

`settlement-provenance.mjs` additionally requires the exact actual runtime config,
private snapshot and recomputed reviewed policy/config; exact binary, platform,
shell and sandbox executable hashes; retained pinned source bytes and all bound
schemas; no launcher/thread/turn permission overrides; stable observed helpers
and owned process identity before dispatch; authenticated loopback request
receipts; unchanged private oracle with no transcript leak; source/scratch files;
and normal guardian shutdown. `native-config.mjs` is the unchanged renderer
extracted from the prior launcher, checked against the exact historical bytes.
Source correspondence is **not reproducible-build attestation**, and neither a
typed denial discriminator nor a branch trace is claimed.

New static evidence lives only under `.qualification/harness-settlement-68/` and
the earlier config-repair namespace. `settlement-fixtures.mjs` supplies explicitly
synthetic actual-shaped IPC/provider sequences; unit success proves checker
mechanics, never native containment. The pure provenance verifier has a test-only
file relocation argument; production `checkAttempt()` always derives authority
from the admitted canonical directory and never accepts that argument from a
bundle. Existing 970 + 621 + 632 + 1179 historical evidence entries remain fixed.

The single lease 551 attempt
`.qualification/harness-native-64/attempt-2026-09-28T02-35-51.938Z` established the
allowed source/scratch control and stable config/helpers. Its private read
returned an OS denial without command events, then the old join rejected it;
private write and successful final completion are absent. Its original outcome
and current complete-bundle recheck remain **FAIL**. This variant does not turn
that incomplete historical attempt into a pass. A fresh native trial requires
independent source review and separate root-granted authority.

## Completion repair after review 590/591 (lease 596)

SPEC65-01 remains fixed. SPEC65-02/03 exposed contradictory success transcripts
that the previous checker accepted. The repair is confined to completion and
its typed error/lifecycle conditions; policy, native commands, limits and the
consumed execution gate are unchanged.

The start response, started-turn notification and successful terminal now
require an explicitly null `turn.error`. This is stricter than the generated
schema's optional field and matches retained pinned-native start/completed
frames. Started turns must be `inProgress`; the terminal must be `completed`.
Typed `thread/status/changed` and thread-start status evidence must use a valid
non-error state; `systemError` and `error` notifications contradict successful
acceptance anywhere in the complete transcript. Fresh thread-start evidence
cannot contain failed or other historical turns.

Both final IPC item events must follow **every settlement receipt and the fourth
emitted final message**, whose text must match the completed IPC message. The
separate SSE `response.completed` frame need not precede the IPC final pair;
that independent channel ordering is preserved. Item activity, thread-start or
turn-start/completion after terminal is rejected even when late items would
empty the pending set again. Benign status/usage notifications can still arrive
after terminal and before EOF.

`completion.test.mjs` snapshots all unchanged `f90eee32` harness source directly
from Git and runs its actual `assess()` against the same serialized mutated
fixtures as the repaired checker. Twenty old-pass/new-reject cases cover typed
errors, early final/emission ordering and post-terminal lifecycle. Four positive
variants preserve eventful/alternate result ordering, startup notifications
before their RPC responses, final IPC before SSE completion, and late benign
notifications. Three already-rejected cases stay rejected and are not presented
as new fixes. This is full operation assessment with actual-shaped synthetic
transcripts, not native execution or complete artifact qualification.

All current static tests write only to
`.qualification/harness-settlement-68-repair/`. The prior 8,585 evidence entries
and six indices remain immutable; old source/schema inputs are read only. Run
committed-source binding checks only from a clean revision. The historical 8930
full bundle remains failed, and independent #65 rereview is required. Gate551
remains consumed; no fresh execution authority is implemented.

## Current result: native feasibility blocked

The two original attempts are retained below
`.qualification/harness-contract-59/`:

| Attempt                            | Actual observation                                                                                                                                            | Interpretation                                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `attempt-2026-09-28T01-22-15.360Z` | Strict roster guard rejected `request_user_input` and goal tools before native dispatch.                                                                      | Configuration preparation failed; no containment evidence.                                       |
| `attempt-2026-09-28T01-24-06.796Z` | Corrected tool configuration reached three native `exec_command` calls. Allowed write/read exited 134, no file created; protected read/write also exited 134. | Positive control failed. Unchanged canary does not establish denial. Root cause remains unknown. |

The second app-server turn completed and the original driver exited zero. Those
are retained transport observations, **not an accepted pass**. The checker rejects
that pattern. The original driver also dispatched the remaining two operations
after the failed positive control; the final driver stops at the first failure.
The false-pass condition has checker unit coverage. The corrected candidate later reached the native positive control under lease 551;
that separate attempt is described below.

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
node --test acceptance/harness/check.test.mjs acceptance/harness/config-binding.test.mjs acceptance/harness/settlement.test.mjs acceptance/harness/settlement-provenance.test.mjs acceptance/harness/completion.test.mjs acceptance/harness/binding.test.mjs
node --check acceptance/harness/probe.mjs
node_modules/.bin/prettier --check acceptance/harness
node acceptance/harness/check.mjs .qualification/harness-native-64/attempt-2026-09-28T02-35-51.938Z 8930b4849eb9ae5bb2176fda9e8712826c69244c
```

The last command must exit 1 with `recorded-attempt-error`; it is a retained
negative acceptance result. The unchanged native-integration tests write into the
closed historical namespace and are not part of this static repair rerun.
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
