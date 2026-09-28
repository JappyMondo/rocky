# Stock ingress contract v1

`ProviderGateway` optionally takes `{ contract, assertCurrent }` as its fifth
constructor argument. The host registers `StockContract` before listening. The
original host `approve()` mode remains separate and unchanged; modes cannot be
mixed on an action. `listen()` returns the action bearer, complete `url`, and
`baseUrl` ending in `/v1` for a future stock configuration.

This is a local primitive, not a Codex adapter or provider qualification.
`capability` remains null. There is no default count, send, auth lookup, native
launch, or recovery replay. The future typed adapter and real provider/image
qualification are separate gates.

## Host authority and receive-time admission

The version is `stock-responses-v1`. The immutable host contract pins invocation,
action key/input digest/head, role, binary/source/schema/config identities,
selected Sol/medium or Astra/high model, exact instructions, tools, custom grammar,
output JSON schema, profile, initial text, preauthorized later turns, output cap,
and correlation/header values. Existing action/lease/version guards remain in
force. These identity strings record the host binding; they do not attest to a
binary or grant a capability. The required synchronous `assertCurrent` validates
current host profile authority at admission and actual dispatch/forwarding.

Initial native message IDs may bind on first arrival, but only after comparing
all initial role/content to host-audited input. They never authorize text or a
second spend. Later input must retain the complete prior body input exactly,
including bound IDs. Every call/result extension must match the preceding durable
provider response: exact call ID, name, raw JSON arguments or custom input, and
one string result for each call. Native-added `fc_`/`fco_` IDs are supported for
retained function history. Unproved native-added custom item IDs are unsupported;
source-only custom fixtures use exact provider calls and string results without
new item IDs.
Provider calls are preserved in order and interleaved with their results. A new
turn requires a separately preauthorized host turn after the exact assistant
response. A changed ID, UUID, header, metadata, or replay cannot create progress.

A single SQLite transaction freezes the accepted complete canonical body,
retains its original wire SHA-256 and bounded diagnostic header digest, allocates
`stock-N`, consumes a unique semantic progression, and creates the counting
record. Failure rolls all of this back. Durable prior state, not an in-memory
request map or `x-client-request-id`, determines admission. Ambiguous/counting,
reserved, sending, unknown, incomplete, and unfinished-forwarding predecessors
block progression. No automatic reconciliation or retry API is added.

Strict fatal UTF-8 and duplicate-key-rejecting bounded JSON parsing precede
admission. Profile/body fields are exact; unknown remote/opaque fields, schema
references, server tools, previous-response state, reasoning items, structured
tool results, and images are unsupported. The restricted profile excludes
`view_image`. Its presence in the retained four-tool compatibility profile does
not authorize a new native profile or visual workflow. Text-only support here
does not waive the later trusted inline-image/counting requirement.

The allowed body is the pinned profile (`model`, `instructions`, `tools`,
`tool_choice:auto`, boolean `parallel_tool_calls`, `reasoning`, `store:false`,
`stream:true`, `include:["reasoning.encrypted_content"]`, `text`) plus `input`,
`prompt_cache_key`, and `client_metadata`. Requesting the retained include flag
does not admit opaque reasoning in history or responses. Function tools are
`exec_command`, `write_stdin`, and compatibility-only `view_image`; custom
`apply_patch` pins the complete Lark grammar. Primitive function arguments are
checked against the pinned declaration. The retained synthetic exec call has
`login:false` outside its old schema; that exact exception exists only in
`retained-compatibility`. Custom strings are preserved, not interpreted by a new
grammar engine. Tool execution belongs to the later adapter/native boundary.

Stock HTTP accepts the existing framing/auth headers plus `accept`, `originator`,
`user-agent`, `x-codex-beta-features`, `x-codex-window-id`,
`x-codex-turn-metadata`, `x-client-request-id`, `session-id`, and `thread-id`.
No `x-rocky-request-id` is required or allowed. Identity/model/turn correlations
must match the host contract. Enumerated sandbox/analytics/timing/workspace
metadata remains bounded diagnostic data, not a claim of policy enforcement.
Full metadata stays in the counted body; received HTTP headers stay local.
Bearer/Authorization are excluded from retained diagnostic headers and fixtures.

## Count, response accounting and forwarding

The trusted count adapter receives the entire frozen expanded body. It must reject
unsupported shapes and return authoritative input count I bound to that digest.
Generation changes only the intentional `max_output_tokens:O`. Existing atomic
I+O reservations, one outstanding request, full charges without refund, actual
send fencing/cancel/deadline guards, and unknown-usage behavior remain unchanged.
Fake counts prove these mechanics only.

The stock parser buffers at most the existing 1 MiB before forwarding. It handles
arbitrary byte/UTF-8 fragmentation, data-only SSE, comments, multiline data,
CRLF, and optional matching `event` fields. Existing 64 KiB event, 1024 event,
connection, request, and deadline limits remain. Unknown SSE fields/events,
invalid UTF-8, duplicate/conflicting IDs, incomplete frames, trailing state,
non-null errors, and malformed/missing usage fail closed.

The observed compatibility lifecycle is `response.created`, ordered
`response.output_item.done` items, and one `response.completed` or
`response.incomplete`. Done-only calls require no invented added event. Retained
function calls and assistant text messages are supported; custom string calls
and narrow assistant added/text-delta/done cases are explicitly source-only.
Added messages must finish with matching ID/content/deltas. Provider response
and call IDs cannot be reused across the durable action history. Terminal output,
when supplied, must exactly match retained done items. Only
`max_output_tokens` incomplete details are supported; incomplete is never success.

Terminal input/output/total counts are mandatory and must agree with I, O and the
sum. Optional nested cached-input and reasoning-output counts are bounded by their
parents. Missing breakdowns remain null; missing primary counts produce unknown
usage. Actual usage is never the reservation or invented zero.

Terminal validation and accounting commit before any response/tool bytes leave
the gateway. A separate forwarding latch progresses `pending` → `sending` →
`finished`; `sending` commits before local HTTP writes. `finished` means the local
HTTP finish event was observed and persisted, not that native code consumed or
executed the result. Pending/sending states survive a crash and block replay and
new progression even with known provider usage. Physical/native application
completion, structured final validation, and tool quiescence remain later adapter
responsibilities; a gateway receipt cannot deliver a coordinator result.

Store schema 7 adds stock contracts/progression uniqueness to schema 6 without
rewriting prior provider records, reservations, revocation, actions, slots or
cancellation. Previous readers refuse the new schema.

## Evidence boundaries

`tests/fixtures/stock-native-v1.json` is a credential-free, deduplicated tracked
fixture derived from the untouched retained four-request native synthetic probe.
It retains original request/journal/roster hashes and transformation provenance.
Tests explicitly rebind historical gpt-5.4/medium to Astra/high and original zero
usage to coherent fake usage; neither proves model availability or production
protocol compatibility. Normal tests require no untracked evidence tree. Test
commands remain inert data, never execute target code, and all effects stay in
owned fake HTTP processes and fresh SQLite/artifact directories.
