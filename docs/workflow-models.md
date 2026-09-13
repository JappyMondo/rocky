# Named workflow models

New workflows declare roles in their JSON `models` object. Open **Profiles →
Workflow → Flow settings → Model slots** to edit them, and **General → Workflow
models** to choose each harness, model and effort. AI agent nodes select a slot;
packaged delivery nodes use `review`, `implementation` and `planner`. The runtime
exposes the captured choices through `ctx.models`.

See [configurable flows](flows.md) for the JSON format. The TypeScript examples
below describe the retained legacy workflow format and existing run snapshots.

A legacy workflow declares the roles it needs. The local profile supplies the harness,
model and variant/effort for each role. Changing a selection in **Profiles →
General → Workflow models** does not change the workflow's source.

```ts
import {
  linear,
  type WorkflowContext,
  type WorkflowModelSlots,
} from '@rocky/sdk';

export const models = {
  review: { name: 'Review', description: 'Inspect changes without editing.' },
  implementation: { name: 'Implementation' },
  planner: { name: 'Planner' },
} satisfies WorkflowModelSlots;

async function main(ctx: WorkflowContext) {
  const plan = await ctx.agent('planner', {
    ...ctx.models.planner,
    tools: ['read'],
    input: ctx.issue,
  });
  await ctx.agent('implementer', {
    ...ctx.models.implementation,
    tools: ['read', 'edit', 'bash'],
    input: plan,
  });
  await ctx.agent('reviewer', {
    ...ctx.models.review,
    tools: ['read'],
  });
  return 'completed' as const;
}

export default [linear.onDelegate(main)];
```

Keys are workflow identifiers, such as `review` or `MODEL_REVIEW`. Every value
has a nonempty display `name` and an optional `description`. Keys must be unique
JavaScript-style identifiers using ASCII letters, digits and underscores; they
cannot start with a digit. `__proto__`, `prototype`, `constructor` and `then` are
reserved. Declare at most 64 slots. All triggers in the module share these slots.
Use `export const models = {};` for a workflow that needs none.

The named export is required for new runs. It must be a literal object with
literal names/descriptions. Type annotations, `as const` and `satisfies` are
supported; computed keys, spreads, imported declarations and function calls are
not. Rocky reads this metadata without importing or executing the workflow.

## Configure a profile

The form contains one set of harness, model and variant/effort controls per slot.
OpenCode and Claude Code can be mixed within one workflow. Selecting a different
harness clears that slot's model and effort so you can choose compatible values.
Both native CLIs must be installed and authenticated if you use both harnesses.

The profile's JSON stores the selections separately:

```json
{
  "models": {
    "review": {
      "harness": "opencode",
      "model": "provider/review-model",
      "effort": "high"
    },
    "implementation": {
      "harness": "claude-code",
      "model": "full-claude-model-id",
      "effort": "high"
    },
    "planner": {
      "harness": "opencode",
      "model": "provider/planning-model",
      "effort": "low"
    }
  }
}
```

These IDs are placeholders. Use full identifiers and variants supported by your
provider; `opencode models` lists OpenCode IDs. Blank values and `auto`/`default`
are rejected. A named slot selects harness/model/effort only: tools, MCP grants,
prompts, schemas and timeouts remain controlled by the workflow's agent call.
Explicit options after the spread override the selected fields, so leave those
fields to the slot when you want the UI to control them.

The browser editor refreshes slot metadata as you edit the source. Switch to
**General** to configure added slots before saving. After editing the external
`.workflow.ts` file, reload the profile page; unchanged slot keys retain their
selections. Removed slots disappear from the form. A model-only save leaves
workflow source byte-for-byte unchanged.

The shipped workflow declares `review`, `implementation` and `planner`.
CLI `--harness`, `--model`, and `--variant` initialize review and implementation;
planning uses the same choice unless all `--fast-*` overrides are provided.
The UI can then change all three independently. Setup defaults are suggestions
for new profiles, not live overrides of configured slots.

## Runs, retries and migration

Admission validates the declaration and requires exactly one complete selection
per slot before preparing a snapshot. The profile, including selections, is
copied into the run. `ctx.models` and each selection are immutable. Reading an
unknown slot throws a configuration error instead of silently selecting a
harness default. Reading selections creates no journal Step.

Profile changes affect new runs. Resume, replay and failed-step retry keep the
run's captured settings, including harness choice. Full IDs pin names, not
provider behavior or provider-side aliases/variant definitions.

Older profiles remain readable and editable but need migration before starting
new runs. Add the `models` export, replace inline constants with
`...ctx.models.<slot>` and configure the slots in the UI. Alternatively use
**Profiles → Workflow → Reset to default**, which installs the JSON delivery flow, prompts and schemas while preserving
literal commands, states and limits from the Config block and other profile settings.
Existing run snapshots can still resume with their original inline choices.

## Local API

- `GET /api/profile-defaults` returns `modelSlots` and per-slot `modelSuggestions`.
- `POST /api/workflow-model-slots` with `{ "source": "..." }` previews declarations
  without executing source or saving a profile.
- Profile responses include `modelSlots` and saved `models`. An invalid or legacy
  declaration is reported as `modelError` so it can still be repaired.
- `PUT /api/profiles` accepts a named `models` map. Existing-profile updates need
  the current `revision`; model-only updates can omit source and repositories.
  Missing/extra slots are rejected without writing the profile.
- Reset requires the current `revision` and choices for every slot of the current
  shipped default. Custom slot names from the replaced workflow are discarded.
