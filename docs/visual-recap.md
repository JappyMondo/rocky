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

The pipeline:

1. Inventory meaningful supported visual variants from the actual changes: routes, screens, dialogs, roles, states, themes, breakpoints and locales. Record exclusions with reasons.
2. Explain key changes and select files/annotations. Rocky attaches the actual unified patch for those files; it does not accept model-authored replacement code diffs. Every annotation must refer to a selected file and actual diff line.
3. Capture each inventoried variant separately. Each capture gets its own report/pass/variant directory. Missing files, escaping paths, symlinks outside the directory and invalid image artifacts are rejected. Unavailable variants require an explicit reason and remain visible in coverage and limitations.
4. Audit the full recap independently against the source and ticket. Blocking problems trigger another complete pass, capped at two. A failing recap is not published.
5. Snapshot images, store the immutable report, recheck the PR revision, and publish links to Linear and the PR/MR. For a generic deliverable, publish to Linear only.

The viewer provides keyboard-accessible key-change tabs, summaries, highlighted diffs and annotations, file footprint, processing diagrams, grouped screenshot galleries, verification, and review sections for security, permissions, routes, data, compatibility, operations, testing and other concerns. Unknown or unverified evidence must be labelled honestly; a report is not a security certification.

Links prefer the configured private Tailscale origin, falling back to localhost. Enhanced reports keep screenshots and source snippets in Rocky; external comments carry the report link and summary. The viewer and screenshots stay behind Rocky's normal private UI/API boundary.

Enhanced reports have versioned identities so an old basic report for the same commit cannot suppress them. Completed stages replay without re-running agents; report files cannot be overwritten. Legacy PR-ready report callbacks remain compatible with old Run snapshots and skip a revision already published by the explicit block. Changes to a workflow/profile apply only to new runs.

The layout takes inspiration from Builder.io's [Visual Recap skill](https://github.com/builderio/skills/blob/main/skills/visual-recap/SKILL.md): explain the shape of the work, then make the load-bearing code and review decisions easy to inspect. No Agent-Native hosting or account is required.
