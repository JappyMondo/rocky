# Direct subscription acceptance, v1

`manifest.json`, `scenarios.json`, and `final.schema.json` are the protected
`rocky-subscription-88-v1` contract. This is **static authorship**, with no executed
scenario, native qualification, capability, or execution grant. Taskbot #88 and
lease #1/820 authorize these new files; #89 independently reviews them before
production consumes them. The producer cannot edit this acceptance set.

The first candidate is one fresh pinned Codex `exec --json` invocation per action.
Claude Code and OpenCode remain later implementations of the small invocation
seam. No separate API credential, subscription-token proxy, or gateway is required.
The [architecture note](../../docs/architecture/subscription-harness.md) identifies
the production migration; it does not implement it.

## Acceptance rules

Every scenario is mandatory for its stated gate. `unexecuted` means no attempt;
`blocked` means a named missing prerequisite; `unknown` means incomplete or
ambiguous observations. Neither counts as pass. `unsupported` records a required
boundary that cannot be demonstrated and blocks profile admission; it is not a
waiver. `fail` retains a contradictory observation. A static format/hash check is
not a scenario pass. All attempts, rejections, failures and missing artifacts stay
in the denominator; a retry has a new attempt ID and the original remains intact.

Native tests require separate exact, finite authority and predeclared synthetic
resources. They must observe an attempted operation, successful allowed control,
and independent protected-state/non-leak oracle. Missing tools, parser failures,
signals, prose denials and producer booleans do not demonstrate containment. Never
probe real credentials, keyring entries or private host data. Synthetic native
proof precedes any separately authorized subscription/account/model test.

## H01–H10 and concept mapping

| Historical requirement    | New requirement | Preserved substance / explicit replacement                                                                                                                                                                      | Concept requirements                   |
| ------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| H01 identity/config       | S01             | Exact effective inputs and discovery; trusted CLI parent may access designated harness-owned subscription auth. Runtime HOME/TMP is distinct from shared CODEX_HOME.                                            | R03, R05, R13, R28, R30                |
| H02 native allow/deny     | S02             | Implementer source/scratch writes, reviewer source read-only, shell/patch/non-shell/visual routes; protected resources denied.                                                                                  | R11–R14, R28                           |
| H03 alternate/ambient     | S03             | Traversal, cwd, links/rename/future paths, parent env/FD/process/IPC, instructions and network escalation.                                                                                                      | R05, R13, R28                          |
| H04 typed completion      | S04             | Strict exec JSONL, fresh invocation, current final schema, observed item lifecycle and separate EOF/exit/quiescence. Replace unavailable RPC IDs/error:null/server-request map with source-bound exec evidence. | R13, R16, R17                          |
| H05 deadline/quiescence   | S05             | Original deadline, bounded owned interruption/cleanup, detached descendants/lost parent/uncertainty. Physical interruption has no RPC acknowledgement or remote-stop claim.                                     | R22, R23, R31                          |
| H06 start/fence           | S06             | Durable stable invocation, synchronous guarded start, no blind resend/relaunch, stale/cancel/late-result rejection.                                                                                             | R02, R20–R24                           |
| H07 input reservation     | S07             | Replace gateway token reservation with immutable exact input, finite fresh actions/attempts, one slot and local elapsed/byte/resource limits.                                                                   | R01, R13, R15, R31                     |
| H08 accounting faults     | S08             | Replace hard spend proof with terminal reported-usage threshold between actions; unknown/zero ambiguity blocks further automatic agent work, overruns retained, CI allowance preserved.                         | R15, R17, R23, R24                     |
| H09 real provider         | S09             | Subscription mode, exact requested model/effort, reroute rejection and functional availability; telemetry is not a provider ledger, count or output-cap receipt.                                                | R03, R13, R28                          |
| H10 independent authority | S10             | Independent immutable binding, drift rejection, trusted loader, no caller capability flag; live functional and visual gates remain separate.                                                                    | R14, R16, R19, R24, R30, R32, R33, R36 |

This mapping changes only the separately versioned profile. It **never marks
historical gateway H07–H09 passed** or reinterprets old attempts, unresolved usage,
capabilities or `rocky-harness-59-v3`. Historical concepts and acceptance artifacts
remain unchanged. Concept §8's token-ceiling interpretation is explicitly replaced
for this new mode by #8/816; finite workflow bounds and all other delivery gates
remain. No-code outcomes still do not count as coding success.

## Reading exec output

Bind an invocation before writing the bounded immutable UTF-8 prompt once, then
close stdin once. Persist attempted-write before I/O; partial/uncertain write never
permits resend. Do not JSON-stringify plaintext through `DuplexRunner.send`.
Record bounded raw stdout/stderr separately before interpretation. Decode UTF-8
incrementally and strictly, require complete newline-delimited JSON objects and
explicit finite byte/frame/item limits. Overflow, invalid encoding, duplicate JSON
keys, trailing partial data or unknown fields/types cannot be silently discarded.

The source-defined events are in the manifest. Require exactly one nonblank
`thread.started.thread_id`, one `turn.started`, then exactly one `turn.completed`
for success. All items belong to that owned stream; no turn ID or JSON-RPC request
map exists here. Reject reused/conflicting item IDs, type changes, duplicate starts
or completions, updates without the required start, events after terminal and
unsupported active tool kinds. Commands need started → completed with non-pending
status and integer exit code. `file_change` is completed-only; do not invent a
required start. Messages/reasoning can be completed-only. A started todo list must
settle with every task complete. Failed/declined command or failed patch prevents
successful action acceptance, even if a later message claims success; qualification
denial probes are assessed as operation evidence, not successful coding actions.

The last completed `agent_message` must parse as exactly `final.schema.json`, match
the host's action/input/role, and follow every settled tool/plan. Earlier progress
messages cannot supply a final; multiple schema-shaped finals fail. `--output-schema`
does not remove host validation. Implementers may propose `changed`, `no_code` or
`failed`; reviewers may propose `complete` or `failed`. The host checks the actual
staged diff and evidence independently; `failed` never qualifies a successful action.
An `error` event/item, reroute, `turn.failed`,
missing final, unresolved observed item, nonzero exit or stream truncation rejects
success. Complete stdout **and** stderr EOF, exit zero and independent owned
physical quiescence are additional conjuncts. Cancellation or stale identity wins
over a late final. Omitted internal RPC visibility requires source/native proof;
no absence is inferred merely because JSONL does not expose it.

## Usage and authority

For `subscription-observed-v1`, retain exact terminal usage fields and the raw-event
digest. Native telemetry is emitted on `turn.completed`, not continuously. Preserve
input, cached input, cache-write input, output and reasoning output separately;
the comparison total is input + output, without counting subsets twice. Missing
optional cache-write telemetry stays absent in raw evidence; a source-defined zero
default is disclosed. Reject negative/nonintegral/unsafe or inconsistent counts;
absent telemetry, failed/interrupted runs and all-zero totals are `unknown` or
`ambiguous-zero`, never known zero. Positive valid numbers are **reported**, never
independently established actual consumption. Subset/total interpretation itself
requires version qualification.

Before every later automatic agent action, stop if any prior usage is unresolved
or accumulated reported input + output meets/exceeds the configured threshold.
Record an overrun in full, including one larger than the action planning allowance;
do not clip it, refund it, or label it corrupt solely because it exceeded that
allowance. Retain planning charges separately and monotonically. Actual provider
consumption remains unknown: there is no hard aggregate token limit, mid-turn
usage cutoff, or numeric finite overshoot guarantee. A turn can perform multiple
inferences, retries and compactions; local cancellation need not stop remote work.

Local verification, CI observation and cleanup may continue within their own
limits after a usage stop. Review exhaustion cannot consume CI repair attempts;
usage uncertainty/threshold nevertheless blocks **all** further automatic agent
work, including CI repair. Reserved attempts/time/planning allowance do not promise
remaining subscription quota. A revised threshold must not erase old uncertainty,
reset counters or silently upgrade an in-flight run.

The model's final is only a proposal/result, never an authoritative check, review,
CI, approval or delivery receipt. Preserve independent current-input evidence and
unknown-success barriers. A typed final plus telemetry is not delivery acceptance.

## Binding and review

Future receipts must bind contract and scenario hashes, independently selected
source revision, installed binary/helper/platform identities, effective config,
auth backend/classification (nonsecret only), approved discovery/instructions,
role/model/effort, exact argv/environment/prompt/schema/visual inputs, run/action/
lease/head/scope/build/version identities, ordered observations, outcome, pending
items, deadline/cleanup and every artifact hash. The tested binary is compared to
the pinned candidate anew; a source commit or historical hash is not runtime or
reproducible-build attestation. Backend model attestation is a separate nullable
field, never synthesized from the requested model.

Only a trusted loader may resolve an independently approved immutable binding;
the approval references its hash and exact supported budget mode. Revalidate at
admission and physical launch. Missing, changed or self-approved evidence blocks.
The contract author and production author cannot supply independent approval.
`frozen.sha256.json` binds the contract files; the qualification directory contains
static checks only. No executable launcher or qualification checker ships here.
