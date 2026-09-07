# Linear Run Mirroring

`packages/daemon/src/linear/mirror.ts` exports the concrete `LinearRunMirror`.
This is the bounded NG-601 module, not production composition. It implements
NG-577 section 9 and the amendment to NG-576: persistent activities hold Step
records, Transcripts stay local, and the two comments are framework-owned.

## Public API

| Method | Contract |
| --- | --- |
| `start()` | Acknowledge the session via `externalUrls` first, then ensure the start comment and maintain the Rocky attachment. |
| `status({ stepId, title, summary })` | Replace the pending presentation update. Never pass Harness events or Transcript text. |
| `flushStatus()` | Best-effort send the latest pending update as an ephemeral action. The caller schedules a rate-limited cadence; there is no timer or keepalive. |
| `settle({ stepId, title, outcome, summary })` | One persistent action per stable Step ID, with the structured frame, Agent summary and local Step Transcript link. |
| `post(postId, summary)` | One persistent action per stable post ID, never a comment or response. |
| `setState(stepId, name)` | Persist the state intent and delegate case-insensitive exact-name matching to the client. Unknown-state errors retain the team's real names. |
| `beforeElicitation()` | Check the comment budget before NG-602 emits an elicitation. Known auto-commenting elicitation raises a spec/API gate. |
| `setParked(true/false)` | Persist Parked/resumed state and discard pending ephemeral updates. Parked operations cannot touch Linear. |
| `stop()` | Immediately fence further network calls in this owner and discard pending status. Await it to durably persist the fence before releasing ownership. |
| `finish(outcome, presentation)` | Assemble the closing content and emit a terminal response/error. Returns no asset URLs or other presentation payload. |

`RunOutcome` supports `completed`, `rejected`, `cancelled`, `giveUp`, and
`failed` with a required Step ID and reason. Rejection/cancellation are
responses, not errors. Failures name the Step. No method permits a mid-Run
response or an arbitrary Workflow-authored closing body.

`RunPresentation` contains the changed summary, PR links, CI results, Check
results, final passing screenshots and unresolved Complaints with file/line
anchors. NG-606 owns interpreting default Workflow outputs into these fields;
the execution core must not learn their meaning. Only a nonempty all-passing
Check result set permits screenshot uploads. Complete Check coverage and the
selection of the final sweep remain the presentation producer's responsibility.
Cancellation skips uploads even when screenshots were supplied.

## Integration Dependencies

- The client is a `Pick<RockyLinearClient, ...>` using `ensureActivity`,
  `ensureComment`, `maintainAttachment`, `comments`, `acknowledgeSession`,
  `uploadFile`, and `setIssueState`. The `ensure` methods must find-or-create
  and verify the remote object's ID, ownership and frozen payload, including
  after ambiguous create errors. A duplicate-ID error alone is not success.
- Call `start()` immediately on session creation, before loading the Workflow,
  snapshot, worktree or other long-running work. The parent must keep Journal
  access and dispatch fast enough to meet Linear's ten-second acknowledgement
  deadline. This module cannot guarantee a wall-clock deadline during a network
  outage or a stalled store. Acknowledgement is the first network call.
- A single owner serializes each Run's mirror calls. Stable Run, session, issue,
  Step and post identities must survive Boot. Do not construct concurrent owners
  for the same Run; the supplied store has no compare-and-set or lease API.
- The execution owner binds `LinearEffectStore.get/put` to non-positional
  records in the single Journal. Each awaited `put` must be durable and atomic;
  missing keys return `undefined`. There is no production in-memory store,
  sidecar, runtime edit or positional `ctx.step` binding in this module.
- New comment/activity effects persist real UUID-v4 IDs and frozen payloads
  before touching Linear. Restart retries use these originals, not changed
  summaries. Acknowledgement, state, attachment and closing presentation intents
  are also frozen before their effects. Success markers suppress settled work.
- The stop fence cannot undo a request already handed to the client. It prevents
  subsequent calls after that request returns. Client-internal retries and
  multipart upload stages need the execution/client cancellation policy; this
  module cannot cancel an opaque method lacking an AbortSignal. After stop,
  only `finish({ kind: 'cancelled' }, ...)` may make final-confirmation calls.
  Once a terminal identity/payload is durable, it is the committed closing
  intent: even a later stop reconciles that original terminal effect rather
  than inventing a second terminal response. Before that point, cancellation
  replaces the unfinished presentation and performs no uploads.
- NG-609 supplies `readScreenshot(path)` with confinement/existence checks. The
  mirror does not open paths itself. It persists the path, metadata and SHA-256
  before upload, then passes raw bytes to the client. A retry re-reads through
  that confined seam and refuses changed bytes rather than uploading a different
  artifact. The client owns presigned PUTs and exact signed headers. Upload
  results are private mirror records; never project those records into the web
  UI, which serves its own local files.
- `uploadFile` offers no lookup/idempotency key. A crash after an upload but
  before its asset result is durable may leave an orphan and retry the upload.
  It cannot duplicate the terminal activity/comment. Exactly-once asset creation
  would require a different public client API; it is not claimed here.
- The attachment URL is the stable
  `http://localhost:<port>/issues/<issueId>`, title `Rocky`, with the supplied
  raccoon icon. Re-delegation updates metadata, not URL identity. The local-product
  lane owns resolving that permalink to the latest Run. Direct Run and Step
  links remain in the comments/activities.

## Spec/API Gates

`platform` is required: `terminalComments: 'one'`,
`elicitationComments: 'none' | 'one'`, and nonempty qualification `evidence`.
The supported terminal mode requires **both response and error activities** to
produce exactly one readable matching comment. There is no permissive default,
explicit-close fallback, or "two explicit comments" interpretation.

The terminal activity carries the framework-assembled closing body. Its
automatically mirrored comment is the closing comment; Rocky never separately
creates one. The module reads public comments before additional comments and
verifies the matching closing body after terminal emission. A missing or delayed
auto-comment raises `LinearMirroringGateError`; retry after propagation only
re-reads when the terminal effect is already recorded. It does not add a close.

Known auto-commenting elicitation is blocked before emission: start + elicitation
+ terminal would be three. An unexpected existing elicitation artifact blocks
closure before another comment-producing call. No human/platform comment is
deleted. Session association identifies artifacts even when present before
`start`; a baseline excludes historical unrelated comments. New comments without
association are conservatively unclassified and may block the Run, rather than
silently assuming they are human. Qualification must establish public attribution
and visibility. There is no atomic server-side comment budget: external concurrent
writes or behavior changing after qualification remain a platform/API gate.

The HTTP localhost links are plain Markdown, not an invented HTTPS URL or an
`auth` signal. Attachment/external-URL acceptance and rendering are **unverified
live dependencies**. A rejected attachment leaves the start Markdown link in
place and reports the client error; it does not create another comment or claim
the attachment acceptance criterion passed. A rejected acknowledgement fails
before the rest of start. No live workspace, credential or upload was used here.

## Verification

Tests use only the `LinearRunMirror` public seam, a test-owned restartable store,
and a fake public client with actual terminal auto-comment behavior. They are not
evidence of production Journal integration or live Linear qualification.

```sh
PATH=/Users/jappy/.nvm/versions/node/v24.15.0/bin:$PATH NX_DAEMON=false pnpm exec vitest run --config packages/daemon/vitest.config.mts packages/daemon/src/linear/mirror.spec.ts
```

Changed files: `packages/daemon/src/linear/mirror.ts`,
`packages/daemon/src/linear/mirror.spec.ts`, `docs/linear-mirroring.md`.
