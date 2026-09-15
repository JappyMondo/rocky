# Visual recap building block

`ctx.visualRecap(options)` turns a validated PR, an immutable diff string, or a text deliverable into a hosted review report. It owns the agent calls, screenshot registration, report storage and publication, and returns `{ id, url }`.

```ts
ctx.stage('Visual recap');
const recap = await ctx.visualRecap({
  pr,
  scope: { issue: ctx.issue, validationSummary },
  agent: { harness: 'opencode', mcp: ['playwright'] },
});
```

A PR input is checked against the clean local issue branch and its pushed remote head. The report is generated before the default workflow marks the PR ready or asks for human approval. PR-conversation fixes also generate a recap for the resulting head. For non-code work:

```ts
await ctx.visualRecap({
  title: 'Architecture and dataflow',
  deliverable: reviewedCommentBody,
});
```

A caller may instead pass `diff` for another immutable patch. Generic diff/text subjects need no SCM adapter. Runs need the ordinary Linear-backed production services to publish the report link. Agent options select the harness/model and available capture MCP tools. Analysis and audit calls receive read-only tools; capture receives read/bash plus the configured MCP tools. It may use temporary render inputs, not edit the work being reviewed.

The pipeline for newly admitted runs:

1. Inventory actual application UI changes and supported states. Backend, configuration, docs and README changes do not trigger screenshots or a special no-UI section. Capture a document's rendering only when explicitly requested.
2. Capture each UI variant in its own directory; inspect readability and state. Missing or escaping paths and invalid image artifacts are rejected. Record unavailable UI evidence with a concrete reason.
3. Write the final narrative using completed captures, the clarified acceptance criteria, revision-specific CI/command receipts, separately labelled agent reports, and current repository delivery evidence. Include a decision, one assessment per criterion, concrete before/after scenarios, material gaps and explanatory processing diagrams where useful. A local companion commit does not prove a PR exists. The attached file list and code diffs cover the primary diff; other repositories are assessed through their own evidence and the requirements. The audit must not ask the writer to add companion files to the primary diff.
4. Independently audit the assembled report. Missing requirements, invented evidence, stale capture claims, inaccurate revision attribution, dense introductions and unexplained jargon are blocking report defects. The writer uses one idea per sentence and avoids jargon such as "companion delivery" and "materialization". It limits introductions to 30 words, decision summaries to 30 words and next actions to 20 words each. Precise technical references belong in expandable evidence, never the introduction. An honestly disclosed product or delivery gap is a reason for human attention, not for hiding the report. Two passes are available.
5. Snapshot images, store the immutable report, recheck the PR revision, and publish links to Linear and the PR/MR. For a generic deliverable, publish to Linear only.

The viewer guides readers through goal, before/after changes, relevant screenshots, processing diagrams, requirements, risks/checks, then the decision. Next/Back buttons and a step menu support both guided reading and jumping to a perspective. Each page uses short sentences and everyday words. New reports include a separate goal and short requirement labels; original acceptance wording and evidence stay expandable. Older reports still open using their existing fields. The decision status stays visible on every page. Source diffs and file details are available in a collapsed technical section. Each processing diagram has its own page and opens at its native readable size, with scrolling, zoom and an explicit fit-to-view control. UI captures use the full report width; counts describe visual evidence, not acceptance coverage. Exclusions used for inventory planning stay out of the report's limitations.

Version 2 is captured at admission. Older run journals retain the original stage order and report identity, so upgrading cannot shift their replay positions. Existing reports remain immutable.

## Regenerate a retained PR recap locally

From this source checkout, run:

```sh
node tools/refresh-recap.mjs RUN_ID REPORT_ID [REFRESH_KEY]
```

This invokes the real recap agents with the run's recorded review model and current prompts. It verifies the clean primary head against the remote, gathers per-repository evidence, and writes a separate journal and a new report under the same run. A refresh key selects a distinct immutable regeneration; reuse it to resume an interrupted regeneration. It does not replay implementation, answer the approval checkpoint, publish comments, or merge. The generated report URL is printed on completion. The original checkpoint still refers to its original report; the run lists the new report first.

Links prefer the configured private Tailscale origin, falling back to localhost. Enhanced reports keep screenshots and source snippets in Rocky; external comments carry the report link and summary. The viewer and screenshots stay behind Rocky's normal private UI/API boundary.

Enhanced reports have versioned identities so an older report for the same commit cannot suppress an upgraded recap. Completed stages replay without re-running agents; report files cannot be overwritten. Legacy PR-ready report callbacks remain compatible with old Run snapshots and skip a revision already published by the explicit block. Changes to a workflow/profile apply only to new runs.

The layout takes inspiration from Builder.io's [Visual Recap skill](https://github.com/builderio/skills/blob/main/skills/visual-recap/SKILL.md): explain the shape of the work, then make the load-bearing code and review decisions easy to inspect. No Agent-Native hosting or account is required.
