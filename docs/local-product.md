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
Transcript files are capped at 100 MiB. Disconnect/shutdown releases readers.
Diffs, lists and structured results do not stream. `x-rocky-version` is present
on local responses, including errors/SSE.

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
producing Step, exact revision, file and optional line/side. Every settled
Complaint carries its Resolution, and annotation screenshots must already be
registered to that Run. Directory and missing-file anchors remain explicit
headers, never flat fallback lists.

## Settings And Security

Settings only exposes bind/port, retention, concurrency and redacted MCP status.
It preserves unrelated config keys, serializes API writes and rejects stale
revisions. Config watchers in production own hot retention/cap application;
binding changes only persist a restart hint. No OAuth token or Harness credential
is read by this module. MCP login remains a printed CLI command.

The plugin rejects non-loopback peers/Hosts, forwarded requests and cross-origin
requests. It is defense in depth, not a substitute for NG-651's separate
webhook/ping/OAuth-callback public ingress. A reverse proxy on loopback can conceal its
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

## Profiles with several repositories

**Add profile** loads Rocky's default workflow using the machine's configured
harness and model. Saving a new profile also stores its default prompts, schemas,
rules, MCP declaration, and secret references locally. The source is editable
before saving, and updates preserve existing custom pipeline content.
`GET /api/profile-defaults` previews the default without creating a profile;
new `PUT /api/profiles` requests may omit workflow and grants to use those defaults.

In **Profiles**, add each repository with a folder name, Git remote URL, and
base branch. One profile owns one workflow and its agent configuration. The
first repository is primary for SCM calls that omit a repository; **Make
primary** changes that default. It does not select workflow files from Git.

A profile can now store its membership without a separate single `remote`:

```json
{
  "v": 1,
  "id": "product",
  "repos": [
    { "name": "web", "url": "git@github.com:acme/web.git", "baseBranch": "main" },
    { "name": "api", "url": "git@github.com:acme/api.git", "baseBranch": "develop" }
  ],
  "workflow": { "source": "...", "triggers": ["implement"] }
}
```

The existing workflow, prompts, schemas, grants, MCP declarations, and environment
fields keep their formats. SSH, HTTPS, file remotes and host/owner/repo shorthand
are accepted. URLs must not embed credentials. Folder names and canonical remotes
must be unique within a profile. A clone folder already bound to another remote
is refused; use another folder name instead of repointing its existing branches.

**New run → Profile** selects a profile explicitly. The local trigger API accepts
`{trigger, issue, profileId?}`. Omitting `profileId` retains issue-label routing.
For Linear delegation, an existing repo entry's `profile` selects the whole
profile, including all its repositories. `rocky repo profile use <repo> <profile>`
can assign a profile to any configured member. New profiles can also be exported
and imported through the existing local CLI commands.

Admission freezes the profile and membership before queuing the Run. Every member
gets a worktree at `~/.rocky/runs/<runId>/workspace/<name>/`, and the agent and shell
commands receive the shared `workspace/` parent. Workflow input contains all
members and their relative paths. Each member uses the Run's branch and its own
base branch. Existing issue branches are adopted without reset. Parked worktrees
and uncommitted changes survive restart; profile edits affect subsequent Runs.

Old profiles containing only `remote` continue to use configured repository/group
membership. The editor fills their existing folder name, transport URL and base
branch from instance configuration. Saving repository rows makes that membership
explicit in the profile. Existing `/profiles` routes remain valid; navigation now
calls this section **Profiles**. Run lists, repository filters and Run detail show
all frozen member repositories.

## Workflow diagrams

The **Workflow** tab starts with an agent-generated Mermaid overview of the
saved workflow: stages, decisions, parallel work, approval checkpoints and
outcomes. Charts run from left to right and initially fit every node inside the
available viewport, including the expanded view. Use the zoom controls to explore
details and **Fit diagram** to return to the complete overview. The
editable TypeScript remains below the diagram, with Mermaid source available
in a disclosure for copying.

The daemon watches saved profile content, including edits to the external
`.workflow.ts` file, every two seconds. It waits for edits to settle before
queuing generation through the profile's configured harness. The auxiliary job
has no tools or MCP servers and does not start a workflow Run. It uses the
instance's default model when that default matches the profile's harness;
otherwise the harness selects its usual model. Temporary agent data is removed
when the job completes or is cancelled.

Diagrams are persisted under `~/.rocky/cache/workflow-diagrams/`, keyed by the
workflow source, trigger names and generator version. Identical workflows share
a cached diagram across profiles and daemon restarts. One generation runs at a
time; superseded queued revisions are skipped, and an older result cannot become
the current workflow's diagram. Browser drafts are only visualized after saving.

`GET /api/profiles/:id/diagram` returns `queued`, `generating`, `ready` or `failed`
along with the source hash, and the Mermaid source when ready. The UI polls this
while the Workflow tab is open. Failed jobs stay cached until the source changes
or **Retry diagram** is selected. **Regenerate** also replaces a completed chart
through `POST /api/profiles/:id/diagram/retry`. Generation has a two-minute timeout;
daemon shutdown cancels its child process. Mermaid renders with strict settings
and the resulting SVG is displayed as an image.
