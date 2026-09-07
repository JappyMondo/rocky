# Linear Client

NG-601 client primitives for NG-602/603/629. Implemented in
`packages/daemon/src/linear/client.ts` against installed `@linear/sdk` 92.0.0.
This is local fake-SDK/fake-HTTP evidence, not live app-token qualification.

## Public API

All requested method names are unchanged. The package index exports the public
client, mirror and control types used by composition owners.

| Method | Result and contract |
| --- | --- |
| `session(sessionId)` | `LinearSessionSummary`: `id`, `issueId`, `appUserId`, nullable ISO `dismissedAt`, nullable `delegateId`, `status`. Uses public session and issue reads; missing issue/app-user association names re-delegation and durable session-ID storage as the fix. The caller checks the expected issue and owning app-user identity. |
| `activities(sessionId, { since? } = {})` | `LinearSessionActivity[]`: `id`, `sessionId`, ISO `createdAt`, `content`, `ephemeral`, optional `signal`, `signalMetadata`, `sourceCommentId`. Reads all pages with an inclusive one-second overlap before `since`, dedupes by ID, sorts by timestamp then ID. Never writes a durable cursor. |
| `ensureActivity(options)` | `WriteResult`; accepts a non-ephemeral `PostActivityOptions & { id: string }`. Requires a UUID-v4 persisted by the caller before the effect. Globally looks up that ID before creating and after any create outcome, including ambiguous failure. Verifies ID, session, JSON-equivalent content, signal and metadata. Duplicate errors alone are never success. |
| `ensureComment({ id, issueId, body })` | Same verified find-or-create contract and UUID-v4 requirement for a top-level comment. Verifies returned ID, issue, exact body and absence of a parent. |
| `comments(issueId)` | All pages, deduped and ordered. `LinearCommentSummary` exposes `id`, nullable `issueId`, `body`, ISO `createdAt`, nullable `sessionId`, `userId`, `parentId`. Use with activities' `sourceCommentId` and Run baselines to audit all comments, including platform-created ones. |
| `maintainAttachment({ issueId, title: 'Rocky', url, subtitle?, iconUrl?, metadata? })` | Finds by issue + URL, creates only if absent, reads back identity after create, then updates metadata by actual ID. Never sends a URL update. `metadata` values are strings/numbers. Supply a stable local issue permalink resolving to the latest Run, not a changing Run URL. |
| `setIssueState(issueId, teamId, name)` | Paginated team-state lookup, case-insensitive exact name matching, then issue update. Unknown names list all actual team-state names. |
| `acknowledgeSession(sessionId, runUrl)` | Public `externalUrls: [{ label: 'Rocky', url: runUrl }]` update; no activity, fake HTTPS, or auth signal. Call immediately after durable receipt and before Workflow loading/queueing to meet the ten-second deadline. Scheduling and deadline evidence belong to integration. |

Write methods above return `{ id, success: true }` only after their required
verification/success checks. Existing low-level `postActivity`, `postComment`,
`createAttachment`, `workflowStates`, `findWorkflowState`, `viewer`, `accessToken`
and `uploadFile` remain. `createAttachment` now returns the actual SDK payload ID,
not its proposed UUID. Use `ensure*` for durable replay effects, not `post*`.
Action content requires `{ type: 'action', action, parameter, result? }`, never an
invented `body`. `ensureActivity` rejects ephemeral input: a replacement may have
already removed it before a readback. Use best-effort `postActivity` for live
ephemeral thought/action updates; only persistent activities are durable effects.

## HTTP And Credentials

The public `LinearSdk` constructor accepts Rocky's HTTP transport. Tests inject
`fetch` and use real generated query documents/model hydration without global
production hooks. `LinearSdkLike` remains the fake-SDK seam and now includes the
read/update methods and explicit page information.

The transport observes `Retry-After` (seconds or HTTP date), request, complexity
and endpoint-request budget headers. Reset values are epoch milliseconds. It
honors exhausted budgets on successful responses before subsequent requests and
rechecks concurrent cooldown extensions. Rate-limit rejection retries are capped
at three attempts with exponential backoff and a 30-second cooldown budget; a
longer server delay fails rather than retrying early. Network failures, ordinary
GraphQL errors, partial-data and mixed-error responses are not blindly retried.
The budget bounds retry waits, not arbitrary network latency.

`RockyLinearClientOptions.signal` aborts this client's HTTP calls and cooldown
waits, including raw uploads. It is client-scoped, not mutable per Run. The shared
control layer must stop new Run work, cancel relevant in-flight work, and permit
only the final response after Linear `stop`; this client does not infer policy
from reading a stop activity. Do not abort a daemon-wide client to stop one Run.

Concurrent token reads/refreshes on one client share a promise through completed
`save(tokens)`. Later calls reread credentials. The composition owner must make
`save` atomically merge only the Linear token pair/expiry into the latest shared
credentials, preserving MCP and other keys. The delivery handoff's intended seam
is `updateCredentials(paths, current => next)` from NG-599; it is not present in
this bounded client's ownership and was not reimplemented here. Avoid independent
clients/processes racing refresh of the same rotating token; this lock is not a
cross-process refresh transaction.

`uploadFile` sends the supplied bytes unchanged via raw PUT with every signed
header. Preparation/PUT errors do not return an asset URL. The caller supplies
only final passing screenshots via NG-609's confined local byte reader; this
module neither selects screenshots nor validates file provenance. Asset URLs
belong only in Linear, never the local web UI.

## Open Gates

- No real credentials, uploads, sessions, activities or comments were used or created. App-token reads, initial session discovery/recovery and manual Trigger owned-session creation remain integration/live gates. No internal `Issue.agentSessions` or `Comment.agentSessions` fields are used; no arbitrary session reuse is added.
- Exactly two **total** comments remains the mirror layer's acceptance criterion. Automatic elicitation/response/error comments must be measured under the app token. Public association fields are evidence inputs, not proof that the count can be satisfied. An unavoidable third comment is an open platform/spec blocker.
- Ordinary `http://localhost:<port>` is retained verbatim. Attachment, comment, select-body and session-link acceptance/rendering each require live evidence after NG-651 review. The UI stays local; no tunnel/auth workaround was added.
- NG-629's latency-only claim assumes a known session, valid app access and working outbound Linear. Initial missed delegation and total network loss are different cases. Polling cadence, durable cursor advancement, Answer CAS, pending notes, delivery targets and stop policy remain control/runtime responsibilities.
- The delivery document also requires the runtime fixes and stable owner handoffs before integrated acceptance. This client adds no second recovery engine and changes no shared composition files.

## Verification

Focused suite: 53 tests across `client.spec.ts`, `client-http.spec.ts` and
`sdk-adapter.spec.ts`, including red/green slices and regression tests from a
read-only correctness review. No daemon, listeners, full suite or live API fixture.

```sh
PATH=/Users/jappy/.nvm/versions/node/v24.15.0/bin:$PATH NX_DAEMON=false pnpm exec vitest run --config packages/daemon/vitest.config.mts packages/daemon/src/linear/client.spec.ts packages/daemon/src/linear/client-http.spec.ts packages/daemon/src/linear/sdk-adapter.spec.ts
PATH=/Users/jappy/.nvm/versions/node/v24.15.0/bin:$PATH NX_DAEMON=false pnpm exec tsc --ignoreConfig --noEmit --module NodeNext --moduleResolution NodeNext --target ES2022 --lib ES2022 --strict --skipLibCheck --esModuleInterop --types node,vitest packages/daemon/src/linear/client.ts packages/daemon/src/linear/client.spec.ts packages/daemon/src/linear/client-http.spec.ts packages/daemon/src/linear/sdk-adapter.spec.ts
```

The focused strict typecheck and daemon library typecheck
(`pnpm exec tsc -p packages/daemon/tsconfig.lib.json --noEmit`) both pass at final
verification. The spec project check requires unbuilt daemon declaration outputs
(TS6305); the focused command above checks these tests without building or editing
other workers' modules. Formatting and `git diff --check` also pass.
