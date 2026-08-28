# PROTOTYPE — NG-572: the Workflow authoring surface

**Throwaway.** This branch answers one question: *what does a Workflow file
actually look like to write, and is `ctx` the right shape?* Nothing here is
the implementation.

## Run it

```sh
bun install
bun runner/demo.ts     # full Run: 3 daemon deaths, steer, approve, merge
bun x tsc --noEmit     # the consumer-repo typecheck story
```

## What's here

| Path | What it is |
| --- | --- |
| `.rocky/workflow.ts` | **The artifact to react to**: the shipped default Workflow |
| `.rocky/config.ts` | The data-shaped knobs (caps, UI start command, harness default) |
| `.rocky/schemas.ts` | Agent output contracts as repo-owned zod schemas |
| `.rocky/agents/*.md` | Prose-only Agent files (prompt + model + tools frontmatter) |
| `sdk/index.ts` | Everything `@rocky/sdk` must export for `.rocky/` to typecheck |
| `runner/` | ~100-line deterministic-replay runner + scripted world + demo |
| `alternative/workflow.declarative.ts` | The graph version, written to be sure; it loses |

## The decisions this prototype takes (react to these)

1. **Deterministic replay** is the journal model: on resume the workflow
   function re-runs from the top and every completed `ctx.*` call returns its
   recorded result. Plain TypeScript between Steps re-executes; only `ctx`
   touches the world. Author rules: no I/O outside ctx, no `Date.now()`, no
   `Math.random()`. The demo kills the daemon three times to prove it.
2. **Schemas live in TypeScript at the call site** (`schemas.ts`), not in the
   Agent markdown. The workflow's types and the runner's validation are the
   same zod value; markdown stays prose. ⚠️ This amends the map's Agent
   definition ("output schema … in the markdown file").
3. **Loops are plain `for`**, no `ctx.loop` combinator. Replay makes them
   safe; `label:` gives the UI its "review 3/5" rendering; the exhaustion
   path (`giveUp`) is three readable lines of workflow code, not a framework
   feature.
4. **The UI condition is `if (plan.touchesUi && config.ui)`** — the planner
   declares it, config gates it, no config language.
5. **`workflow.ts` vs `config.ts`**: config is data you change without
   rethinking the pipeline (caps, dev-server command, harness default); it is
   imported like any module. Control flow never lives in config.
6. **`ctx` is seven members**: `issue`, `branch`, `agent()`, `exec()`,
   `checkpoint()`, `post()`, `changedFiles()` — plus `scm` with five ops
   (`openPr`, `markDraft`, `waitForCi`, `updateBranch`, `armAutoMerge`).
   Notably absent: a merge *Agent* is only needed for conflicts; arming
   auto-merge is plumbing, not judgement.

## Feeds forward

- The replay model and its author rules constrain NG-574 (journal, resume,
  invalidation) — the "waiting Step retries its effect on reboot" mechanic is
  the suspension story.
- The schema-location amendment and the Complaint/Plan placeholder shapes are
  NG-575's to settle properly.
- `ctx.scm`'s five operations are the workflow-facing contract NG-580 designs
  behind.
