# Rocky 🦝

An AI development-lifecycle platform. Rocky the raccoon takes a ticket and hands you back a mergeable pull request.

## What it does

You delegate a Linear issue to Rocky. A daemon on your own machine picks it up and runs a workflow defined in your repo: plan, implement, check the change against the ticket, look at the UI if the change touches it, review the code, open the PR, watch CI, and keep fixing until everything is green. Only then does it call you in — once, at the end, with a diff, screenshots and a green pipeline — and after you approve, it merges through the platform's own merge controls.

Reviewing still happens, but it is an internal stage whose complaints feed a fixer, not a pile of comments on your PR. The PR is an output, not a conversation.

## Configured in your repo

Everything Rocky does for a repo lives in that repo, as files you can read and edit:

```
.rocky/
  config.ts        # repo-level knobs: how to run the app, tests, dev server
  workflow.ts      # the pipeline itself, as imperative TypeScript
  agents/*.md      # one file per agent: prompt, model, output schema, tools
  rules/*.md       # plain-markdown review rules
```

The shipped defaults *are* those files, so customising means editing something already visible, and opting out means deleting a directory and a line. Rocky refuses to work on a repo without `.rocky/` — and that refusal hands over the fix: it inspects the repo, generates a config tuned to what it found, opens a PR, and asks you to merge it and re-delegate.

## How it runs

- **A daemon per developer**, on your machine, as you — using the toolchain and CLI credentials you already have. Its own clone and a worktree per run live under `~/.rocky`, so it never touches your working copies.
- **One Linear app per developer**, so the thread shows whose machine is working. No coordinator, no claim protocol.
- **Agent harnesses**: Claude Code and opencode ship tested; the others are configurable but untested. Rocky wraps the official CLIs and never hand-rolls an agent loop.
- **Runs are journaled**, so one survives a daemon restart or a sleeping laptop and resumes at the last completed step.
- **A local, keyboard-first web UI** bound to localhost, plus a thin `rocky` CLI. It renders live runs, diffs, screenshots and the checkpoints waiting on you.

GitHub and GitLab are both first-class, including the awkward parts: merge queues, merge trains, and merge-when-pipeline-succeeds.

## Vocabulary

| Term | Meaning |
| --- | --- |
| **Workflow** | The TypeScript definition in `.rocky/workflow.ts`. |
| **Run** | One execution of a Workflow for one Linear issue. |
| **Step** | One journaled unit inside a Run: an Agent call, a shell command, or a Checkpoint. |
| **Agent** | A named prompt + model + output schema + tool policy, as a file in `.rocky/agents/`. |
| **Checkpoint** | The human-in-the-loop Step. Notifies Linear, links to the web UI, and blocks until answered. |
| **Complaint** | One objection a reviewing Step emits and a fixer Step consumes. |
| **Harness** | The agent CLI behind a Step. |

## Status

Pre-implementation. The design is being settled ticket by ticket on the wayfinder map, [Rocky as an AI development-lifecycle platform](https://linear.app/digimondo/issue/NG-566).

## Project management

Tickets live in Linear (Niotix Grid team). All tickets carry the repository label so Cyrus can map them to this repo.
