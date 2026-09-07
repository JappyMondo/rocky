# Local Product

NG-609, NG-612 and NG-613 share `@rocky/local-contracts`, a type-only wire
package. These are presentation types, not additions to the Workflow SDK or
Complaint-aware replay behavior.

## Registration

`registerLocalApi(app, options)` from `@rocky/daemon` installs an encapsulated
Fastify plugin. The execution lane owns calling it from production assembly.
Do not register it on public ingress. It creates no listener, scheduler,
second Run registry, Answer CAS or Steer intake.

Required services: `runs.list/get/journal`, `LocalArtifacts`, `LocalSettings`.
`runs.list` must read the scheduler's index. `runs.journal` must return a
non-mutating snapshot of complete Journal records. The current runtime's
`openJournal` repairs torn tails and must not be used by a live HTTP reader.

Optional shared services: `currentCheckpoint`, `answer`, `steer`, `steers`,
`manual`, `presentStep`. Omitted control services are advertised unavailable and
return 503, never synthetic success. `answer` must atomically validate the full
Step key and generation and return the winning Answer on conflict. `steer`
must persist the client request UUID before returning a receipt and share
Linear's intake. Its receipt is not proof of delivery. `manual` resolves the
issue and uses the real snapshot/Trigger admission service, naming the live Run
on refusal. `presentStep` supplies recorded native usage and screenshot IDs;
the API never guesses cost from output text.

## HTTP Contract

| Route | Contract |
| --- | --- |
| `GET /api/runs` | `RunList`; 2 s active/queued, 30 s idle polling |
| `GET /api/runs/:id` | `RunDetail`; latest nested Steps, Step-boundary revision |
| `GET /api/runs/:id/steps/:key/transcript` | SSE, URL-encoded full Step key |
| `GET /api/runs/:id/diffs/:diffId` | `DiffView` for recorded base/head identities |
| `GET /api/screenshots/:id` | Confined bytes; not a Linear asset redirect |
| `POST /api/runs/:id/answer` | `{stepKey,generation,answer}`; 409 includes winner |
| `POST /api/runs/:id/steer` | `{requestId,message}`; durable `SteerReceipt` |
| `POST /api/triggers` | `{trigger,issue}`; 201 admitted, 409 named refusal |
| `GET /api/settings` | Redacted `SettingsView` with revision and restart hint |
| `PATCH /api/settings` | `{revision,patch}`; partial known settings sections |

Full Step keys alternate root sequence, parallel branch, child sequence:
`3/0/2`, never a label or a root sequence alone. The current runtime records a
Step's executing Boot, not each later replay visit. The UI therefore identifies
completion before the current Boot without fabricating replay visits or sleep
reasons. Missing native usage components stay missing, including partial totals.

SSE events: `transcript` has JSON `{text,offset}` and an event ID equal to the
end byte offset; `settled` closes the reader. `Last-Event-ID` takes precedence
over `?offset=`, allowing reconnection from durable bytes after a daemon restart.
Reads are incremental with 16 KiB chunks and bounded stream backpressure.
Disconnect/shutdown releases readers. Diffs, lists and structured results do not
stream. `x-rocky-version` is present on local responses, including errors/SSE.

## Artifact Contract

`LocalArtifacts(paths)` exposes `registerScreenshot`, `readScreenshot`,
`listScreenshots`, `registerTranscript`, `transcript`, `saveDiff`, `readDiff`
and `listDiffs`. Registration is an integration call, never an HTTP path input.
Use `readScreenshot(id)` for Linear's upload source as well as the HTTP route:
there is one byte reader, and nothing sends a Transcript to Linear.

Screenshot/session registration is relative to that Run's screenshot/session
directory. Reads use opaque IDs and confinement; unsupported active image
formats are refused. Unknown, malformed and retained-but-pruned artifacts are
distinct 404, 400 and 410 cases. Diff bodies and base/head identities are retained
outside the workspace. A later pass may update annotation state/Resolution, not
move an old anchor onto new source. Content supplies namespaced Complaint IDs,
producing Step, exact revision, file and optional line/side. Directory and
missing-file anchors remain explicit headers, never flat fallback lists.

## Settings And Security

Settings only exposes bind/port, retention, concurrency and redacted MCP status.
It preserves unrelated config keys, serializes API writes and rejects stale
revisions. Config watchers in production own hot retention/cap application;
binding changes only persist a restart hint. No OAuth token or Harness credential
is read by this module. MCP login remains a printed CLI command.

The plugin rejects non-loopback peers/Hosts, forwarded requests and cross-origin
requests. It is defense in depth, not a substitute for NG-651's separate
webhook/ping-only public ingress. A reverse proxy on loopback can conceal its
origin; production must never forward public requests to this listener. No
tunnel or public exposure is part of local browser verification.

## Verification And Integration Gates

`tools/local-product-preview.mjs` serves the built web app against temporary
real Journal/config/artifact files, including three Boots, nested Steps and a
live raw file tail. It binds loopback and leaves its printed temporary root for
evidence. It deliberately supplies no fake Answer/Steer service. This is local
product evidence, not a real-Harness or live-Linear acceptance claim.

Still owned by downstream composition: non-repairing runtime Journal/index
accessors, production route registration behind NG-651, shared Checkpoint/Steer
controls and delivery records, manual admission, MCP status wiring, native
Transcript/usage registration, and NG-606's exact output-to-annotation renderer.
Tests of HTTP callback transport do not close those cross-lane gates.
