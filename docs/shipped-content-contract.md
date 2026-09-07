# Shipped Content Integration

Scope: NG-606, NG-607, NG-608. Runtime boundary: `51c6a624c96242f536b6eeb3f04bcc1c8a7616c2`, PR #13. These are editable content and deterministic proofs, not live acceptance evidence.

## Assets

The source tree to vendor is `packages/daemon/content/.rocky/`. Package it as raw TypeScript and Markdown, not compiled JavaScript. `workflow.ts` imports only Node built-ins, `@rocky/sdk`, and sibling `schemas.ts`. No default Rule is needed, so `rules/` is absent. Only the delimited Config block, optional Playwright MCP declaration, and explicit-doc-derived `rules/conventions.md` vary during seeding.

The two Trigger names are `linear.onDelegate` and `manual("address-pr-conversations")`. Top-level import is effect-free. Schema builders retain their original Zod refinements for Agent validation; the framework injects and returns `summary` without discarding those refinements. Complaint namespaces are deterministic content stage/pass/branch keys. Renderers consume `complaints`, `resolutions`, `checks`, and `results` from the Journal; replay itself does not interpret them.

## Required Public APIs

Execution integration owns SDK reconciliation: `tools` (not the unshipped scaffold's `capabilities`), `agent<S> -> infer<S> & { summary: string }`, and the neutral `completed` outcome. No compatibility alias or content-aware runner is added here. Snapshot imports must resolve relative file URLs to the immutable snapshot. Workflow process environment provides `ROCKY_RUN_DIR` and `ROCKY_SCREENSHOT_DIR`; background exec restarts on working Boots and is process-group owned by the runtime.

SCM owns the eight-operation contract. Content needs ready-flip description replacement, current-head handles after update/push, bounded CI logs, repo-scoped thread handles, and `armAutoMerge` that parks until an actual merge or an actionable CI/update result. Merely armed/queued must never return merged. Permission refusal stays Parked with a named human-merge fix. No ninth direct-merge operation, CLI auto-merge shortcut, or platform polling engine is implemented in content.

The exact typed result spelling will be reconciled with the SCM lane before integration. Deterministic trace fixtures exercise content decisions and the real Journal, not the external platform behavior. A standalone template typecheck against the reconciled SDK is an integration gate, separate from daemon module typechecking.

Linear/control owns Checkpoint parking and Answers, durable Steers, activity posts and exactly two framework-written comments. Content posts are activities. Onboarding requires actual issue-team states as ordinary input and never changes issue state. Packaging owns asset resolution, public module exports and CLI registration; CLI helpers expose explicit callbacks rather than building another loader or Agent execution engine.

## Acceptance Gates

Both SCM platforms, both Harnesses, effective tool policy, Preflight, loader admission/snapshot, actual CI repair, Checkpoint/Steer recovery, platform-controlled merge and the two-comment contract remain live integration gates. No live fixture is designated here; no product PR, CI retry, seed publication, merge, OAuth exchange or package publication is authorized by these tests. Interactive consent/abort must also be demonstrated in each real native CLI. Independent review and current-head CI remain required before merge.
