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

The PR path plans, implements and opens a draft, then validates commands,
acceptance criteria, UI evidence, code review and CI. Repairs return to validation
within the configured cap. A visual recap precedes publication and the human
merge checkpoint. Steering and branch updates require revalidation. Requests
that prohibit merge end at PR handoff. The manual `address-pr-conversations`
trigger retains the review-thread repair and recap path.

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
in a non-parkable step. Retries and existing runs retain their captured graph and
model selections. Node IDs remain stable when renamed or repositioned.

Legacy TypeScript profiles remain executable and editable for compatibility.
**Reset to default** installs the new JSON graph and shipped prompts/schemas,
preserving repositories, connection settings, rules, grants, and literal
commands/states/limits from the old Config block. Configuration expressions that
would require executing TypeScript are rejected with a migration error. Custom
workflow logic is replaced only by an explicit reset, not inferred or silently
translated. Existing TypeScript run snapshots are not modified.

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
