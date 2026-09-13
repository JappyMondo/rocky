# Configurable workflows

Rocky 0.1 stores new workflows as versioned JSON graphs and executes their
connections directly. **Profiles → Workflow** opens the XYFlow editor. It uses
Rocky's existing colors, a dotted canvas, compact nodes, a searchable node
picker, and a settings panel inspired by n8n's workflow editor.

Select a node to configure its action and output destinations. Drag nodes to
arrange them; drag from an output handle to another node's input to connect them.
The destination dropdowns provide the same connection editing without dragging.
Each output has exactly one destination. Use a Condition for branching; connect
an output back to an earlier node for a loop. Unconnected nodes, missing required
parameters, invalid settings and ambiguous connections block saving and admission.

The editor supports undo/redo, duplicate/delete, pan/zoom, a minimap, full-screen
editing, notes and JSON import/export. **Save profile** publishes the graph for
future runs. Import changes the draft; save it to publish. Export carries the
flow and model role declarations, without the profile's model selections,
credentials, prompts or repository membership.

## Node types

| Group | Nodes |
| --- | --- |
| Triggers | Linear delegation, named manual request |
| Actions | AI agent, shell command, question, run-thread update, Linear state |
| Logic | Condition, approval checkpoint, finish |
| Delivery | Clarify scope, reviewed comment, plan, implement/open draft, validation, acceptance review, UI inspection, code review, CI, visual recap, ready for review, merge approval, approved merge, PR conversations |

AI agent nodes contain an editable prompt, a model slot, JSON input, native tool
grants, MCP server names, optional output JSON schema and timeout. The profile
selects each slot's harness/model/effort in **General → Workflow models**.
Without an output schema, an agent returns its `summary`. A schema must declare
`type: object`; its fields are returned alongside that summary.
Profile grants and the normal runtime tool policy still apply.

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

Delivery nodes are packaged, tested Rocky operations, using the profile's prompts
and Review, Implementation and Planner model slots. Their internal structured
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

## Storage, replay and migration

Profiles retain the existing `workflow.source` wire field for compatibility;
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

The shared contract is `packages/local-contracts/src/flow.ts`. The interpreter,
delivery operations and literal migration are in `packages/daemon/src/flow/`.
Tests exercise default-flow parity against the legacy implementation, generic
branching/data mapping, durable checkpoint replay, profile persistence/conflicts,
JSON child loading and editor mutations. `pnpm test:distribution` also loads a
JSON flow through the packed runtime outside the workspace.
