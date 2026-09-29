# CX-P3 — verdict PRODUCT_FAILURE_CANDIDATE (corrected; zero-billing held, adapter correct)

- tier: A (CodexExecAdapter.prepareLaunch→begin via store dispatch; real pinned codex 0.157.1)
- gate/scenario fed: auth-absence fail-closed (S09/L01-adjacent honesty); BONUS partial G-FRAME-SHAPE
- criterion (plan, quoted): PART3 CX-P3: "Observables: refusal shape (exact stderr/JSONL error event names/exit code),
  no API fallback, no forced login/logout side effects, no partial thread.started, sealed-env key list retained (names
  only). PASS: fail-closed pre-model refusal with bounded nonsecret classification. This is NOT an L01 pass."
  Zero-call premise (PART3): "every case terminates at config/auth refusal BEFORE any thread/model start."
- class: fail-closed-at-API-401 (zero-billing held) BUT thread.started emitted + model endpoint contacted ⇒ divergence
  from the plan's "before thread start" / "no partial thread.started" premise.

## CORRECTION NOTE (honest, post-hoc; documented single re-run for an evidence-capture defect)
The initial run's verdict was PASS with `threadStarted=false`, but that was based on a 0-byte native capture (driver
log-path read defect). The authoritative frames retained by the shipped gate (command.duplex.frames) show `threadStarted=TRUE`.
A documented single remediation re-run (run-remediate.mjs, hashed addendum, zero-call) captured the full frame lifecycle +
receipt + run-tree walk. Original verdict preserved at verdict-initial-auto.json; remediation evidence at rerun-cx-p3.json.
The re-run was NOT silent (recorded in consumed.md).

## Observed native lifecycle (14 frames, command.duplex.frames; exit 1)
0  thread.started {thread_id}
1  turn.started
2-5  error "Reconnecting... 2/5..5/5 (unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: wss://api.openai.com/v1/responses)"
6  item "Falling back from WebSockets to HTTPS transport. ... 401 ..."
7-11 error "Reconnecting... 1/5..5/5 (... 401 ... url: https://api.openai.com/v1/responses ... request id ...)"
12 error "unexpected status 401 Unauthorized ... https://api.openai.com/v1/responses"
13 turn.failed {error: 401 Unauthorized}
Native stderr (run-tree log): `ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 401 Unauthorized, url: wss://api.openai.com/v1/responses` (repeated).
Adapter receipt settlement: classification=fatal, detail=`codex-fatal:error-event|error-event|error-event|error-event`,
outcome=failed, reasons=[error-event×10, turn-failed, item-id-shape, no-final]. Sealed-env key names: HOME, CODEX_HOME,
TMPDIR, PATH, LANG (no auth-bearing key).

## Classification (honest, nuanced)
- ZERO-BILLING GUARANTEE: HELD. Every model-endpoint contact returned 401 Unauthorized (no bearer/basic auth) ⇒ no model
  processing, no tokens, no cost; turn.failed; no usage frame. The unauth synthetic CODEX_HOME makes a billable turn impossible.
- FAIL-CLOSED: HELD. exit 1; adapter settled fatal/failed (NOT success), no proposal, no head authority; no forced
  login/logout side effect; no API-key fallback (the WS→HTTPS switch is a TRANSPORT fallback, not an auth fallback).
- DIVERGENCE (⇒ PRODUCT_FAILURE_CANDIDATE for R3): the plan's zero-call premise "terminates at config/auth refusal BEFORE
  any thread/model start" and the CX-P3 observable "no partial thread.started" are CONTRADICTED. Native codex, given the
  full valid adapter bundle and a credential-less CODEX_HOME, EMITS thread.started + turn.started, CONTACTS the model API
  endpoint (wss then https api.openai.com/v1/responses), and only then fails at API-layer 401. So the fail-closed point for
  auth-absence is the API 401 (after thread start + endpoint contact), NOT a pre-thread config/auth refusal.
  Contrast (important refinement): a CONFIG error DOES refuse pre-thread — CX-P2(b) unknown `-c` key under --strict-config
  exits 1 with `Error loading config.toml: unknown configuration field ...` and NO thread.started. So: config-error ⇒
  pre-thread refusal; auth-error (valid config, no creds) ⇒ thread.started + model-endpoint contact + 401.
- Network note: the api.openai.com contact is the CLI's own unavoidable startup/model endpoint, unauth (401), recorded and
  never billed — within the granted authority (PART1: "startup endpoint contact is recorded, never billed"). It is recorded
  here honestly because the plan's premise said no thread/model contact would occur.
- CODEX_HOME writes: installation_id + tmp/arg0 helpers were created (expected; the contract states "no claim of no
  CODEX_HOME writes"). config.toml specifically is unchanged (see CX-P4, F5 PASS).

## BONUS — partial G-FRAME-SHAPE evidence (zero-cost)
The plan marked codex G-FRAME-SHAPE credit-blocked ("needs a real event stream"). This auth-failure run produced a REAL
native exec-JSONL stream at zero cost, attesting frame names/shapes for the lifecycle-opening + error path:
`thread.started{thread_id}`, `turn.started{}`, `error{message}`, `item{...}`, `turn.failed{error{message}}`. Completion/usage
frames (turn.completed with usage, final agent_message) remain credit-blocked (need a successful model turn). This is a
native attestation (not bundle strings) for the opening/error frames only.

## Verdict rationale
Flagged PRODUCT_FAILURE_CANDIDATE (not PASS) because a frozen plan observable ("no partial thread.started") and the
zero-call premise ("before any thread/model start") are contradicted by native behavior; root/R3 adjudicate whether the
contract/plan zero-call rationale needs amendment. The safety-critical property (zero billable turn) and the adapter's
fail-closed handling both HELD, so this is a model-of-where-fail-closed-occurs correction, not a billing/containment failure.
NOT an L01 pass. Zero model call. No orphan processes; temp roots deleted after evidence copy.
