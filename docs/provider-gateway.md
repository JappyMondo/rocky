# Bounded provider reservation primitive

`ProviderGateway` is a local accounting primitive with an injected trusted provider.
Its `capability` is **null**. There is no live provider implementation, default
credential lookup, Codex adapter, or qualified model route. Synthetic HTTP tests
establish local mechanics only. The coordinator still refuses unqualified agent
work; tests explicitly use its existing injected test capability.

The only prospective downstream route is HTTP/1.1 `POST /v1/responses` on a new
`127.0.0.1` ephemeral listener. The returned random bearer is an action-local
capability, not an upstream credential. Only the future trusted provider adapter
may hold an upstream credential in memory. Never include it in request data,
count results, observations, exceptions, or provider receipts.

A separate opt-in [stock ingress contract](stock-gateway.md) adds receive-time
admission and causal history. The exact-preapproval mode described below remains
available. Current Store schema 7 preserves the original schema 6 ledger.

## Host admission and exact input

The trusted host constructs the gateway with the exact durable `Action` and
`Lease`, then calls `approve({ id, body, outputCap, assertCurrent })`. Approval is
not exposed over HTTP. Each new generation or retry requires a separately
approved ID; an HTTP caller cannot mint one. IDs that already have durable
records cannot be approved again, even after restart or successful completion.
Approval alone neither counts nor reserves nor sends.

The supported projection freezes canonical UTF-8 JSON for model, effort,
instructions, local function tool declarations, input messages, `stream:true`
and `store:false`. Only `gpt-6-sol/medium` and `gpt-6-astra/high` are accepted.
Unknown fields, remote schema references, server tools, opaque previous response
state, file references, remote image URLs and auxiliary endpoints fail closed.
Input items currently support text and inline high-detail PNG messages only;
this is not a complete native conversation/tool-result protocol implementation.
The caller must send the exact approved canonical bytes, not merely equivalent
JSON. The host retains the frozen string; subsequent mutation of its original
object cannot change counting or generation.

`assertCurrent` is a required, synchronous trusted authority check. It must
validate the current profile and every prepared image against independently
approved artifact/run/action/role/head/scope/scenario/fixture/hash/decoded-pixel/
MIME/dimension/detail/expiry/revocation information. The gateway checks only
bounded canonical inline encoding and PNG signature; **it does not decode images
or grant artifact authority**. Image resolution, decoding, transformation and
manifest verification remain future coordinator work. Validate trusted bytes
once, then count/send these same frozen bytes; do not reopen a model-selected
path. The guard runs at approval, before counting, after counting, and inside the
actual-send fence. A changed/revoked image after counting prevents generation.
Revocation cannot recall an already-sent image or stop remote inference.

## Count, charge, dispatch and recovery

The injected `TrustedProvider.count` receives the frozen body and digest. It
must return exactly `{ schema:1, digest, inputTokens }`, with an authoritative
nonnegative safe integer count of **all input, including cached input**. A failed,
missing, malformed or mismatched count never authorizes generation. Fake counts
are not evidence of actual provider accounting or image compatibility.

Store schema 6 adds the request ledger and monotonic action revocation to the
existing FULL-synchronous SQLite database. Prior schema 5 snapshots, actions,
slots, events, cancellation and reservations remain unchanged. Older readers
refuse schema 6. Each transition is also retained in append-only events.

| Durable state              | Meaning on restart                                                                                             |
| -------------------------- | -------------------------------------------------------------------------------------------------------------- |
| No record                  | No gateway admission was committed; nothing is replayed automatically.                                         |
| `counting`                 | Count started or may have started; no generation charge yet. Blocks new attempts pending explicit recovery.    |
| `reserved`                 | `R = I + O` fully charged, but no durable send attempt yet. Gateway does not resume or replay it.              |
| `sending`                  | Send attempt committed **before** I/O; request may or may not have reached the provider. Never blindly replay. |
| `unknown`                  | Dispatch/stream/usage is unresolved. Full charge and outstanding exclusion remain.                             |
| `completed` / `incomplete` | Bounded complete stream with validated terminal usage observed; full original charge remains.                  |
| `rejected`                 | Admission/count/guard failed before a send attempt; any already committed charge remains.                      |

Reservation is atomic across Store connections. There is one outstanding count
or generation per action and `sum(R) <= action.tokens`. `O` is a host-selected
positive output bound, including reasoning and nonvisible output. No charge is
refunded for low actual usage, refusal, failure, timeout, cancellation or restart.
Actual usage is a separate nullable record, never the reservation and never zero
when unknown. A terminal `incomplete` response is not successful completion.
This primitive does not manufacture a coordinator result, release its execution
slot, or turn a known receipt into a delivery/capability claim.

`dispatchProvider` first commits `sending`, then rechecks the exact action,
versions/input, lease/fence/slot, cancellation, wait/blocker and deadline while
holding the same SQLite write lock used by cancellation. The synchronous image
check runs inside this gate, followed by another action check. Only then does the
trusted `send` callback synchronously initiate I/O. The callback must not await a
preflight. Preparation, reservation and dispatch reject nesting inside an outer
transaction so rollback cannot erase a charge after an external send. A send
throw or crash still leaves the committed attempt. Observations can survive
lease loss; they cannot start new work or reduce charges.

Generation uses exactly the counted projection with the sole addition
`max_output_tokens: O`. The future adapter must enforce that provider cap and
must never retry, follow redirects, use opaque provider state, or choose another
endpoint. This trust contract is an injection seam, not proof about an arbitrary
callback. There is no default adapter and no provider idempotency assumption.

`revoke()` persists action revocation before aborting local observation. It
blocks a replacement gateway for that action after restart. `close()` revokes,
closes owned sockets and drains owned handlers; call it before closing Store.
Closing sockets is not evidence that remote generation stopped. A provider may
continue after cancellation, already covered by the full reserved amount.
Unresolved outstanding records deliberately have no automatic clear/retry API.
A future explicit reconciliation design requires separate review.

## HTTP and observation bounds

The listener requires the exact local Host, bearer, approved request ID, JSON
content type and one explicit Content-Length. Allowed headers are Host,
Authorization, X-Rocky-Request-Id, Content-Type, Content-Length and Connection.
Duplicate/extra headers, query/trailing paths, other methods, chunked/compressed
bodies, CONNECT, upgrades, Expect and connection reuse are rejected. It does not
emit or follow redirects. There is no count, upload, compaction or proxy route.

Limits are fixed: 4 concurrent connections, 64 accepted connections/approved IDs/ledger
attempts, one request per socket, 4 KiB headers, 2 MiB request body, 8 inline
images, 32 local tools, 256 messages with at most 64 parts each, 1 MiB response,
64 KiB SSE event, 1024 events, 5-second header/request/socket idle bounds, and the
smaller of 30 seconds or the action deadline for the listener/count/generation.
The socket idle bound can end observation earlier than the overall deadline.
Ingress observations are capped at 64 plus a final limit marker; exhausting the
bound revokes admission. Parser errors and partial accepted bodies retain bounded
hash/size diagnostics. Logs intentionally omit raw Authorization, arbitrary
headers/routes/errors and upstream error text. The ledger retains private
approved request bytes and hashes, never the bearer or upstream secret.

Responses are buffered within the stated cap, validated through EOF, and only
then returned to the local client. The deliberately small **synthetic** SSE
contract admits text deltas followed by exactly one completed/incomplete event
with exact model and complete input/output/reasoning/total usage. Missing usage,
partial final frames, extra events, excess bytes, inconsistent count/cap/model,
non-200 status or non-SSE content produce unknown usage with full charge. This
parser is not claimed compatible with the real Responses wire schema or all
native event variants. Actual compatibility, model routing, image input counting
and enforced reasoning/output caps remain independent live qualification gates.

An owned gateway URL accounts for traffic addressed to that listener. It is not
a host-wide network deny rule or proof of off-gateway zero egress. Trusted native
binary/config routing and untrusted tool network containment remain separate
requirements. There is no native/API/auth/target-workflow qualification here.

## Local validation

`tests/provider-gateway.test.mjs` uses an owned child HTTP fake provider and real
loopback requests, including malformed TCP framing, forbidden endpoints,
redirects, concurrency, exact charge boundaries, image-bearing projections,
count failures, revocation/fence/deadline changes, incomplete streams and a
provider that continues after local cancellation. A separate read-only SQLite
connection observes the committed `sending` and charge at actual send.

`tests/provider-ledger.test.mjs` kills an owned gateway process at eight windows:
before prepare/count/reserve, after reserve, before/after send, and before/after
receipt persistence. Reopening retains every committed record and does not
replay. It also exercises schema 5 migration from the exact accepted source,
nested-transaction refusal, monotonic revoke and competing Store connections.
Artifacts and all attempts belong in a fresh `.qualification/gateway-79/`
namespace; set `COORDINATOR_ARTIFACT_ROOT` and `FOUNDATION_ARTIFACT_ROOT` when
running affected existing tests. No previous evidence namespace is overwritten.
