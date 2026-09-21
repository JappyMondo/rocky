# Configurable workflows

Rocky 0.2 stores workflows as version 2 JSON graphs and executes their
connections directly. **Profiles → Workflow** opens the XYFlow editor. It uses
Rocky's existing colors, a dotted canvas, compact nodes, a searchable node
picker, and a settings panel inspired by n8n's workflow editor.

Select a node to configure its action and output destinations. Drag nodes to
arrange them, or use **Auto layout** to arrange the workflow from left to right,
lay out every component group beneath its coordinator, and fit the current view. Undo restores the previous arrangement. Drag from an
output handle to another node's input to connect them.
The destination dropdowns provide the same connection editing without dragging.
Hover a node or connection to highlight its full upstream and downstream path;
unrelated branches fade until the pointer leaves. Connected AI components are
included in the highlight. Double-click a coordinator or choose **Open components**
to focus its agents and dependencies. **← Workflow** returns to the overview.
Each output has exactly one destination. Use a Condition for branching; connect
an output back to an earlier node for a loop. Unconnected nodes, missing required
parameters, invalid settings and ambiguous connections block saving and admission.

The editor supports undo/redo, duplicate/delete, pan/zoom, a minimap, full-screen
editing, notes and JSON import/export. **Save profile** publishes the graph for
future runs. Import changes the draft; save it to publish. Export carries the
flow and model role declarations, without the profile's model selections,
credentials or repository membership. Inline prompts and custom model selections
are part of the exported graph; profile prompt references need the matching local files.

## Node types

| Group | Nodes |
| --- | --- |
| Triggers | Linear delegation, named manual request |
| Actions | AI agent, shell command, question, run-thread update, Linear state |
| AI components | Model, prompt, workspace tool, MCP tools, output schema |
| Logic | Condition, approval checkpoint, finish |
| Delivery | Clarify scope, reviewed comment, plan, implement/open draft, validation, acceptance review, UI inspection, code review, CI, visual recap, ready for review, merge approval, approved merge, PR conversations |

AI agents coordinate connected components. Each agent requires exactly one model
and one prompt, and accepts any number of tools. Models can use a profile slot or
an explicit harness/model/effort. Prompts can contain editable instructions or
reference a snapshotted profile prompt by name. Each workspace tool grants read,
edit or bash; an MCP tools node grants a named configured server. No tool
connections means no tool grants. The profile's runtime policy still applies.

Select a Prompt component with **Prompt source → profile** to edit its
**Profile prompt instructions** in place. **Save profile** saves the prompt
alongside the flow for future runs. Every node referencing the same profile
prompt shares those edits. A missing prompt can be created from this panel.
**Use inline copy** copies the current instructions into the selected component,
where they can be customized independently and included in JSON exports. Graph
undo restores the reference; edits to shared profile instructions remain in the
profile draft. Concurrent profile saves reject stale revisions.

Use the node settings dropdowns to create, reuse, replace or disconnect a
component, or connect its top socket to a matching socket on its consumer. Dashed
component connections are dependencies, not execution branches. A provider may
be shared. Deleting a coordinator removes exclusively owned components and
preserves components used elsewhere; undo restores the whole edit.

An agent may be a step in the workflow or a component attached beneath a delivery
coordinator. The coordinator supplies task input and the required structured
result contract. The agent's Input field can map that task input through `$ref`;
it defaults to the full input. A standalone agent can connect an optional output
schema (`type: object`); its result includes those fields and a `summary`.

Questions and checkpoints park durably. Questions return `answered` or
`cancelled`; checkpoints return `approve`, `reject` or `steer`. Commands branch on
`success` or `failure`. Conditions support equals, not-equals, contains, truthy
and numeric greater-than. Finish selects completed, rejected or exhausted;
`merged` is reported only after an actual platform merge succeeds.

## Default delivery flow

The shipped `packages/daemon/content/.rocky/workflow.json` ports the previous
default. Delegation first clarifies scope and records the agreed delivery
contract. It then chooses reviewed Linear comment delivery or PR delivery.

The PR path plans and implements the work, then opens a draft PR in each changed
repository. Each repository uses its configured target branch. Unchanged
repositories get no PR. Reviewers see the combined changes with repository names
on file paths. CI and a recap are required for each PR before the set is ready.
One checkpoint lists every PR and the reviewed revisions. All branch checks run
before merging starts. Rocky marks the issue Done only after every PR merges.
Merges happen one at a time; separate repositories cannot merge atomically.

Repairs return to validation within the configured cap. Steering and branch
updates require fresh checks and approval. Requests that prohibit merge end at
PR handoff. The manual `address-pr-conversations` trigger reads review threads
across the changed repositories and refreshes their recaps after repairs.

**Flow settings → Pull requests** chooses **Every changed repository** or
**Main repository only**. New flows default to every changed repository. Flows
saved before this option keep their old behavior until updated. Running and
paused runs keep their frozen setting so their recorded steps remain replayable.
Updating a profile applies to future runs.

**Repositories without CI** lists members that have no pipeline. Rocky skips
CI only for those named repositories and records the reason in validation.
A pending or missing pipeline in any other repository still blocks delivery.

Delivery nodes are packaged Rocky coordinators. Their agent roles resolve only
the agents connected in the graph. The default graph explicitly connects profile
prompts and Review, Implementation and Planner model slots; these can be replaced
without changing coordinator code. Visual recap connects separate inventory,
writing, screenshot and audit agents. Their internal structured
review schemas and integration logic live in the daemon; users do not need to
write TypeScript to connect, reorder, add or remove flow nodes. These operations
have prerequisites: planning needs clarified scope, implementation needs a plan,
PR checks need an opened PR, publication needs a recap, and merge needs the
approved checkpoint. Violations fail explicitly. Use general-purpose nodes when
building a workflow that does not follow that delivery contract.

**Flow settings** configures install/test/lint/build commands, optional app start
command and URL, review cycles, CI repair attempts, CI log length, UI readiness,
Linear state names, and the overall transition limit. UI inspection uses the
profile's Playwright MCP configuration. The default limit is 500 transitions;
reaching it fails with a loop diagnostic.

New flows enable **Install dependencies before implementation and review
continuation** (`settings.workspaceSetup`). The install command runs as a
journaled step before the implementer and again when continuing an exhausted
review, because a released worktree loses ignored dependencies. It runs from
the lead repository; for a nested project use, for example,
`cd monorepo && pnpm install --frozen-lockfile`. Use an idempotent command.
Installation failure stops work with its command output. An empty command
skips this step, so configure repository setup before delegating work.

Older frozen flows omit this flag and keep their original step ordering.
Enable it in the profile editor for future runs; resetting a profile to the
default also enables it while preserving commands. Existing run snapshots
remain unchanged. A failed older run can use retry recovery instructions to
prepare its retained workspace.

The validation node executes only the configured test, lint and build commands.
Implementation and repair agents own additional required integration tests and
benchmarks. They should install supported local dependencies and use disposable
test services where available. External environments or access that cannot be
provided locally remain explicit blockers; review must not treat a skipped test
or a proposed benchmark command as successful execution evidence.

## Data references

Each boot starts with `issue`, `workspace`, `input` and `nodes`. `input` holds the
previous node's result; `nodes.<id>` holds the latest result from that node on the
current path. The trigger's output is the issue. Agent nodes expose their
structured result; commands expose `exitCode`, `stdout` and `stderr`.

Use a data path in text:

```text
Finished inspecting {{issue.identifier}}: {{nodes.inspect.summary}}
```

Use a `$ref` object to preserve an input's JSON type:

```json
{
  "issue": { "$ref": "issue" },
  "review": { "$ref": "nodes.inspect" }
}
```

References support property paths, not JavaScript expressions. An unavailable
reference fails with the path and a connection hint. Prototype access is
rejected. Shell commands are literal configuration: reference templates are not
expanded into a shell command.

## Storage and replay

Profiles store the graph in the `workflow.source` wire field;
for a flow it contains JSON text. `workflow.triggers` is derived from its trigger
nodes. The external `profiles/flows/<id>.json` is authoritative for flow profiles.
A leftover `.workflow.ts` cannot override a flow. External JSON edits must be
valid and are reflected after reloading the profile.

Admission validates the flow, models and MCP declarations, then snapshots the
JSON as `runs/<id>/snapshot/workflow.json`, alongside the profile and prompts.
The loader selects JSON when present and otherwise loads legacy TypeScript.
The interpreter reconstructs node outputs and delivery state on every boot by
replaying the normal journaled context operations; it never wraps a whole node
in a non-parkable step. Retries and existing runs retain their captured graph,
while model selections come from the current local profile at each Boot. Node
IDs remain stable when renamed or repositioned.

Legacy TypeScript profiles remain executable and editable for compatibility.
**Reset to default** installs the new JSON graph and shipped prompts/schemas,
preserving repositories, connection settings, rules, grants, and literal
commands/states/limits from the old Config block. Configuration expressions that
would require executing TypeScript are rejected with a migration error. Custom
workflow logic is replaced only by an explicit reset, not inferred or silently
translated. Existing TypeScript run snapshots are not modified.

## Discover repository commands with AI

### Unified profiles

Profiles can opt into `configurationVersion: 1`. In these profiles, `repos`
owns stable repository IDs, remote/branch details, named `commands`, independent
`services`, CI availability and access overrides. `automation` owns execution
policy and limits. Flow settings are no longer a second editable copy of these
values. Repository IDs and command/service IDs, not folder names, identify
workflow references and cross-repository prerequisites.

The profile editor has Repositories, Agents & access, Automation and Workflow
sections, with one profile draft, a sticky save bar and Discard changes. Routing
changes participate in the same save request, with both profile and routing
revision checks. The repository editor has Repository, Commands, Dev services
and Access sections. Existing profiles show a migration preview; conflicting
legacy values require an explicit choice. Merely opening the editor does not
migrate anything. Old run snapshots are never rewritten.

Each named command has a purpose, working directory, timeout, environment and
prerequisites. Selection is `required`, `agent` or `manual`. Required validation
checks always run; the planner selects relevant optional checks and the journal
records selections and omissions. Explicit prerequisites run before dependents,
even when marked manual. A failed prerequisite fails validation. Custom shell
commands remain available through existing agent tool grants and workflow
command nodes; they never silently become saved recipes.

**Test saved command** explicitly starts a local run in an isolated worktree,
including the command's prerequisites. It uses the saved profile revision and
configured environment/accounts, produces normal run logs, and can be cancelled
from the run page. The generated test flow has no agents, pull requests or Linear
effects. Unsaved commands cannot be tested; saving alone never runs them.

Dev services have separate startup, optional shutdown, readiness and named
endpoint configuration. Endpoint locators support assigned ports, output regexes,
JSON files, resolver commands, and fixed URLs. Resolver commands print only a
URL or numeric port. JSON paths are relative to the repository root; execution
working directories cannot escape it through symlinks. `${VARIABLE}` environment
values reference existing variables without embedding their contents in commands.
Secrets belong in credentials/environment, not literal command or env fields.

Catalog shells lazily load an existing nvm installation when a command calls
`nvm` (using `NVM_DIR`, or `$HOME/.nvm`). They do not install nvm or Node or
automatically select a version. Prefer `nvm use && npm test` with a suitable
`cwd` and `.nvmrc`; missing tools fail with an actionable error. Discovery
prefers small, source-backed commands and existing scripts, puts directories in
`cwd`, avoids duplicated version pins and shell bootstrap boilerplate, and
reports version conflicts and external prerequisites instead of suggesting
global tool installations. Existing saved commands are not rewritten.

Workflow command nodes can select a configured command; Start dev service nodes
select a configured service and expose named endpoints to subsequent nodes.
Stop dev services shuts down these services in reverse order; finishing the flow
also cleans them up. Services used by UI inspection are chosen independently
and automatically bring up their dependencies. The run records resolved endpoints
as evidence, but rediscovers dynamic ports after restart.

At admission, Rocky validates the catalog and materializes it into the immutable
flow snapshot. Resetting the workflow preserves repository configuration and
automation policy. Legacy profiles and historical snapshots retain their original
execution path until explicitly migrated. Storage remains machine-local JSON;
this change does not introduce a database or read committed `.rocky` settings.

In a saved Flow profile, each repository row has **Discover with AI**. The
profile model inspects repository source with read-only tools and proposes
install, test, lint, build and independent UI startup recipes. The checkout must
already exist and its origin must match the saved repository URL. For Rocky's
bare clones, discovery creates a temporary detached checkout of the configured
base branch from local refs, disables checkout hooks, and removes the checkout
after inspection. It does not borrow or modify existing Run worktrees or fetch
from the remote. Discovery
does not install dependencies, run the proposed commands or save profile changes.

Edit the suggested names, directories, commands and endpoints directly; remove
unwanted suggestions, then choose **Apply to draft** and **Save profile**.
Existing settings are preserved. Prerequisites cannot be removed while another
suggestion depends on them;
the normal profile revision check protects the final save. UI suggestions can
use an assigned port, a named URL/port capture from server output, or a
repository-relative JSON file and JSON pointer for dynamic endpoints.

Discovery can be cancelled. Results survive page reloads; a job interrupted by
a daemon restart is marked failed and can be retried. Configure a profile model
and its harness authentication before starting discovery.

## Validation

Version 1 JSON flows are unsupported. There is no format migration or automatic
conversion; replace them with a version 2 flow before starting new runs. Historical
version 1 run snapshots remain unchanged and cannot resume on this release.

The shared contract is `packages/local-contracts/src/flow.ts`. The interpreter,
delivery operations and literal migration are in `packages/daemon/src/flow/`.
Tests exercise default-flow parity against the legacy implementation, generic
branching/data mapping, durable checkpoint replay, profile persistence/conflicts,
JSON child loading and editor mutations. `pnpm test:distribution` also loads a
JSON flow through the packed runtime outside the workspace.

An exhausted delivery flow can be continued from its Run page for another batch
of the snapshotted `reviewCap` rounds. Existing work, review complaints and draft
content survive. The continuation allowance is journaled; it does not edit the
profile or snapshot. Each batch remains bounded and needs another explicit
continuation if it also exhausts its allowance. A CI continuation revalidates the
current branch and polls fresh CI before dispatching any repair. It does not
send the previous pipeline failure to the review fixer.

### Review severity, history and incremental scope

Code reviewers report all findings together and classify each as `nit-pick`,
`should-fix` or `must-fix`. The delivery runtime removes nit picks from the active
complaints; they cannot invoke a fixer or exhaust a review batch. Both remaining
categories require resolution before the flow proceeds.

Every code reviewer and fixer receives the shared `reviewHistory`, including
issues from other review roles, fixer notes, and independent verification results.
History IDs remain unique when old continuation batches reused complaint IDs.
A fixer's `fixed` resolution records a claim; a reviewer must independently verify
it. Reviewers assess each non-ignored prior issue as `fixed`, `open` or `dismissed`
using its history ID. Open issues return to the fixer under that ID instead of
being reported as new findings. Prior results without these fields remain replayable.

Each reviewer gets the full diff on its first pass. Later passes receive only
`git diff <last-reviewed-head>..HEAD`, with the boundary in `reviewScope`. New
findings must arise from these changes or behavior they affect. Unchanged code
is context for checking known issues, not a fresh whole-PR review. The history
and revision boundaries rebuild from existing journaled results across restarts
and exhaustion continuations; no completed Step is invalidated by this protocol.
