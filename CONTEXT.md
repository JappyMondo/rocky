# CONTEXT

Glossary of the Rocky domain. Terms are canonical: use them exactly as defined here in code, tickets and UI copy.

The vocabulary of the PR-comment review product Rocky used to be — Findings as review comments, Review verdicts, the rule-learning loop, the multi-user web app — was retired wholesale by [NG-571](https://linear.app/digimondo/issue/NG-571). What follows is the seed vocabulary of the development-lifecycle platform that replaced it, settled while charting [NG-566](https://linear.app/digimondo/issue/NG-566). It is deliberately thin; the map's grilling tickets grow it as they resolve.

## Terms

- **Workflow**: A repo's pipeline, written as imperative TypeScript in its `.rocky/workflow.ts`. Repo-level knobs live beside it in `.rocky/config.ts` as data; the pipeline stays code.
- **Run**: One execution of a Workflow for one Linear issue.
- **Step**: One journaled unit inside a Run: an Agent call, a shell command, or a Checkpoint. Journaling is what lets a Run outlive a daemon restart or a sleeping laptop and resume at the last completed Step.
- **Agent**: A named prompt, model and tool policy, defined as a markdown file in `.rocky/agents/`. Its output schema lives in TypeScript at the call site (`.rocky/schemas.ts`), so the Workflow's types and the runner's validation are the same zod value ([NG-572](https://linear.app/digimondo/issue/NG-572)).
- **Checkpoint**: The human-in-the-loop Step, placeable anywhere in a Workflow. It tells Linear that intervention is needed, links to the web UI where the human approves, rejects or steers by chat, and blocks until answered. _Avoid_: approval gate.
- **Complaint**: One objection a reviewing Step emits and a fixer Step consumes. _Avoid_: Finding, which named a PR review comment in the retired reviewer product.
- **Harness**: The agent CLI behind a Step. Claude Code and opencode ship tested; others are configurable but untested. _Avoid_: Provider.
