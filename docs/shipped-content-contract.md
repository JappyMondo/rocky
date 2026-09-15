# Shipped Content Integration

This describes the editable defaults used to create local profiles and the
retained legacy seeding helpers. Production execution, packaging and SDK
composition are implemented; deterministic tests are distinct from live acceptance.

## Assets

The template tree is `packages/daemon/content/.rocky/`, packaged as JSON flow configuration, prompts, schemas, and retained legacy
TypeScript. `workflow.json` is the default; its delivery nodes use the packaged
coordinators in `src/flow/delivery.ts` and their structured schemas. Agent, model,
prompt and tool choices are explicit attachment nodes in the version 2 graph. Production copies its content into machine-local profiles, not
into target repositories; admission ignores target-repository `.rocky/`. `workflow.ts` imports only Node built-ins, `@rocky/sdk`, and sibling `schemas.ts`. No default Rule is needed, so `rules/` is absent. Seeding customizes JSON flow settings and the legacy Config block, optional Playwright MCP declaration, and explicit-doc-derived `rules/conventions.md`.

The two Trigger names are `linear.onDelegate` and `manual("address-pr-conversations")`. Top-level import is effect-free. Schema builders retain their original Zod refinements for Agent validation; the framework injects and returns `summary` without discarding those refinements. Complaint namespaces are deterministic content stage/pass/branch keys. Renderers consume `complaints`, `resolutions`, `checks`, and `results` from the Journal; replay itself does not interpret them.

## Required Public APIs

The SDK/runtime contract uses `tools` (not the unshipped scaffold's `capabilities`), `agent<S> -> infer<S> & { summary: string }`, and the neutral `completed` outcome. No compatibility alias or content-aware runner is added here. Snapshot imports must resolve relative file URLs to the immutable snapshot. Workflow process environment provides `ROCKY_RUN_DIR` and `ROCKY_SCREENSHOT_DIR`; background exec restarts on working Boots and is process-group owned by the runtime.

SCM owns the eight-operation contract. Content needs ready-flip description replacement, current-head handles after update/push, bounded CI logs, repo-scoped thread handles, and `armAutoMerge` that parks until an actual merge or an actionable CI/update result. Merely armed/queued must never return merged. The SCM layer returns or parks on supported refusals with named fixes; the
Workflow handles recoverable CI/head/update results and fails on other refusals. No ninth direct-merge operation, CLI auto-merge shortcut, or platform polling engine is implemented in content.

The result types are defined in `packages/sdk/src/scm.ts` and implemented by
`packages/daemon/src/scm/`. The default merge path passes the approved
Checkpoint answer to `armAutoMerge(pr, answer)`. Deterministic trace fixtures exercise content decisions and the real Journal, not the external platform behavior. The content suite and installed-distribution checks exercise template/SDK
loading separately from daemon module typechecking.

Linear/control owns Checkpoint parking and Answers, durable Steers, activity posts and exactly two framework-written comments. Content posts are activities; explicit `ctx.comment` calls publish durable deliverables separately from the two framework-owned lifecycle comments. Onboarding requires actual issue-team states as ordinary input and never changes issue state. Packaging owns asset resolution, public module exports and CLI registration; CLI helpers expose explicit callbacks rather than building another loader or Agent execution engine.

## Acceptance Gates

Both SCM platforms, both Harnesses, effective tool policy, Preflight, loader admission/snapshot, actual CI repair, Checkpoint/Steer recovery, platform-controlled merge and Linear activity delivery remain live integration gates. No live fixture is designated here; no product PR, CI retry, seed publication, merge, OAuth exchange or package publication is authorized by these tests. Interactive consent/abort must also be demonstrated in each real native CLI. Independent review and current-head CI remain required before merge.

## Delivery and validation

The refiner resolves an explicit delivery contract before implementation. Ticket instructions and clarification answers override defaults. `pull-request` retains code review, UI inspection when applicable, CI, and human approval before merge; `merge: false` ends after handing off the validated PR. `linear-comment` uses read-only preparation and parallel acceptance/accuracy review of the complete body, a bounded revision loop, and awaited `ctx.comment` publication. It never enters implementation, push, PR, CI or merge stages. `stateChanges: false` preserves the issue state. Unsupported delivery exceptions require clarification instead of silently running the default route.

Scope decisions are activities; the final requested content is a comment. Comment completion means publication succeeded, not merely that an agent returned a summary. Exhausted reviews publish their blockers as activity and never publish an unapproved artifact. Journal replay reuses the frozen body and the explicit comment's durable identity.

For PRs, configured test/lint/build commands run as journaled workflow gates each validation cycle. Failures enter the bounded fixer loop even when the implementer claims success. Reviews and CI re-run after repairs. Human checkpoint steering is carried into the effective ticket and invalidates prior UI checks so the next sweep covers the updated request.

These deterministic tests establish routing, validation gating and replay behavior, not a measured human acceptance rate. Remaining limits include multi-repository PR delivery (the default SCM route targets the lead), arbitrary external deliverable destinations, and live rendering/execution evidence that requires tools absent from a given read-only agent. Explicit unsupported requirements must be clarified; reviewers must report missing evidence honestly.

Comment preparation/review grants `read` and `bash` for local inspection and
validation, while its prompts prohibit repository or external-service changes.
The Workflow checks the bundled Mermaid validator before drafting and validates
each exact replacement body before review. Syntax failures return to the writer;
a missing validator stops immediately. Reviews receive parser evidence and an
explicit `before-publication` contract: publication-worded criteria are checked
for content/destination readiness, then `ctx.comment` publishes and verifies the
exact body and issue. Missing publication receipts before approval cannot enter
the content-repair loop. Other required-but-unavailable tools use the runner's
blocked response, not a content complaint. Screenshot/layout validation remains
separate from syntax parsing and cannot be claimed from parser success.
