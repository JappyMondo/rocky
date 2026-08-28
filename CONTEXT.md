# CONTEXT

Glossary of the Rocky domain. Terms are canonical: use them exactly as defined here in code, tickets and UI copy.

The vocabulary of the PR-comment review product Rocky used to be — Findings as review comments, Review verdicts, the rule-learning loop, the multi-user web app — was retired wholesale by [NG-571](https://linear.app/digimondo/issue/NG-571). What follows is the seed vocabulary of the development-lifecycle platform that replaced it, settled while charting [NG-566](https://linear.app/digimondo/issue/NG-566). It is deliberately thin; the map's grilling tickets grow it as they resolve.

## Terms

- **Workflow**: A repo's pipeline, written as imperative TypeScript in its `.rocky/workflow.ts`. Repo-level knobs live beside it in `.rocky/config.ts` as data; the pipeline stays code.
- **Run**: One execution of a Workflow for one Linear issue.
- **Parked**: The state of a Run whose current Step cannot complete yet because it is waiting on the world — a human at a Checkpoint, or CI. A parked Run holds nothing open, so it can outlive the process that started it.
- **Step**: One journaled unit inside a Run: an Agent call, a shell command, or a Checkpoint. Journaling is what lets a Run outlive a daemon restart or a sleeping laptop and resume at the last completed Step.
- **Agent**: A named prompt, model and tool policy, defined as a markdown file in `.rocky/agents/`. Its output schema lives in TypeScript at the call site (`.rocky/schemas.ts`), so the Workflow's types and the runner's validation are the same zod value ([NG-572](https://linear.app/digimondo/issue/NG-572)).
- **Checkpoint**: The human-in-the-loop Step, placeable anywhere in a Workflow. It tells Linear that intervention is needed and links to the web UI, then parks the Run until it has an Answer. Rocky enforces that blocking itself; Linear's own gate is advisory ([NG-576](https://linear.app/digimondo/issue/NG-576)). _Avoid_: approval gate.
- **Answer**: A human's resolution of a Checkpoint: approve, reject, or steer. Steer carries the human's own words back into the Run; which Step receives them is the Workflow's choice, not the Checkpoint's. A Checkpoint has exactly one Answer however many surfaces it was offered on ([NG-576](https://linear.app/digimondo/issue/NG-576)).
- **Complaint**: One objection a reviewing Step emits and a fixer Step consumes. _Avoid_: Finding, which named a PR review comment in the retired reviewer product.
- **Transcript**: The raw turn-by-turn output of the Harness behind one Step. Folded by default wherever it appears — the Step's own result is what is read, and the Transcript is one click away. _Avoid_: chatter.
- **Harness**: The agent CLI behind a Step. Claude Code and opencode ship tested; others are configurable but untested. _Avoid_: Provider.
