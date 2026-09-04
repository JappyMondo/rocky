# Rocky 🦝

An AI development-lifecycle platform. Rocky the raccoon takes a ticket and hands you back a mergeable pull request.

## What it does

You delegate a Linear issue to Rocky. A daemon on your own machine picks it up and runs a workflow defined in your repo: plan, implement, check the change against the ticket, look at the UI if the change touches it, review the code, open the PR, watch CI, and keep fixing until everything is green. Only then does it call you in — once, at the end, with a diff, screenshots and a green pipeline — and after you approve, it merges through the platform's own merge controls.

Reviewing still happens, but it is an internal stage whose complaints feed a fixer, not a pile of comments on your PR. The PR is an output, not a conversation.

## Configured in your repo

Everything Rocky does for a repo lives in that repo, as files you can read and edit:

```
.rocky/
  workflow.ts      # a config block, then the pipeline, as imperative TypeScript
  schemas.ts       # the agent output contracts, as ordinary zod values
  mcp.json         # MCP servers; the only file Rocky reads outside a run
  agents/*.md      # one file per agent: prompt only, no frontmatter
  rules/*.md       # plain-markdown review rules
```

Model, tools and output schema are given where an agent is *called*, in `workflow.ts`, not in the agent's own file — so the one place that answers "what could this step touch" is the call site.

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
| **Agent** | A prompt file in `.rocky/agents/`, run with the model, tools and output schema its call site gives it. |
| **Checkpoint** | The human-in-the-loop Step. Notifies Linear, links to the web UI, and blocks until answered. |
| **Complaint** | One objection a reviewing Step emits and a fixer Step consumes. |
| **Check** | One thing the UI inspector must verify in the running app. |
| **Observation** | What a failed Check produces — a url, screenshots and prose. Becomes a Complaint once anchored to a file. |
| **Harness** | The agent CLI behind a Step. |

## Working on Rocky itself

An Nx workspace, pnpm, Node 24. Four buildable pieces:

```
packages/daemon   @rocky/daemon  the long-running local process: API + web UI on one port
packages/cli      rocky          the thin client; `npx rocky` is the distribution
packages/sdk      @rocky/sdk     types and Trigger builders for a repo's .rocky/ — never behaviour
apps/web          web            the Vite/React shell the daemon serves
```

```sh
pnpm install
pnpm exec prettier --check .                         # CI checks this repo-wide
pnpm exec nx run-many -t build typecheck lint        # what CI runs on main
pnpm exec nx run-many -t test --coverage             # the coverage gate, as CI runs it
pnpm exec nx build @rocky/daemon                     # builds web and bundles it in
node packages/cli/dist/main.js setup                 # the first-run wizard
node packages/cli/dist/main.js start                 # http://127.0.0.1:7625
```

A pull request checks only the projects it touched (`nx affected`); a push to `main` re-checks everything, so a wrong `affected` answer can never leave `main` unverified. Each project pins `coverage.thresholds` in its `vitest.config.mts` at the level it currently holds, which is what makes a coverage drop fail the build in CI and locally alike — raise them when you raise coverage. Task results are cached in GitHub's own Actions cache rather than Nx Cloud, so no third party sits in the loop of a repo that will hold provider and SCM credentials, and dependencies are gated at high severity by `pnpm audit` and `dependency-review`. Node comes from `.nvmrc` alone — Rocky ships as a daemon whose runtime we control, so there is no version matrix.

Two `image-size` advisories are waived in `pnpm.auditConfig.ignoreGhsas` (`GHSA-w3rx-r6r6-pgpr`, `GHSA-5p2g-fcmc-qvqq`): both are denial-of-service parsers reached only through `less`, an optional peer of Vite that pnpm installs but nothing here invokes — no file in this repo is Less — and neither has a patched release to upgrade to. A waiver is per-GHSA and belongs there rather than in a lowered `--audit-level`, which would silently waive the next real advisory too. Drop them the moment `image-size` ships a fix.

`main` is protected: the `CI` job is the required status check, commits must be signed, a pull request needs one approving review, and history stays linear — merges are squashes ([NG-562](https://linear.app/digimondo/issue/NG-562)).

`rocky setup` is the interactive first-run wizard: it asks for your public URL first — a Linear webhook URL is fixed when the OAuth app is created and cannot be changed afterwards — then prints a manifest URL to hand to a workspace admin, takes the app's credentials, runs the OAuth flow locally, and verifies the endpoint with a self-ping. See [docs/public-endpoint.md](docs/public-endpoint.md) for tunnel recipes.

`rocky start` serves the API and the web UI on one port, `127.0.0.1:7625` by default (7625 spells ROCK); `--host` and `--port` move it, and there is no auth in v1 under any binding. The public endpoint fronts the webhook only, never the web UI. Most of the rest of the command table is stubbed — each stub names the ticket that owns its semantics.

### The daemon's lifecycle

```sh
rocky start                 # foreground; the log goes to the terminal and to the file
rocky start -d              # background: writes ~/.rocky/daemon.pid, logs to ~/.rocky/logs/
rocky status                # version, address, pid and uptime of the running daemon
rocky logs -f               # follow the live log, across rotations
rocky restart               # stop, then start -d again
rocky stop                  # asks over the local API, falls back to SIGTERM
rocky doctor                # config, endpoint and harness sign-in; non-zero if anything fails
rocky service install       # a launchd (macOS) or systemd (Linux) *user* unit, for boot
```

`~/.rocky/logs/daemon.log` is size-rotated — 5 MB, five kept — so a daemon left running for months cannot fill the disk. A pidfile whose process is gone is reported and replaced rather than obeyed, so a killed daemon never leaves Rocky unstartable.

The service unit is per-user on both platforms and never system-level: Rocky runs as you, inheriting your harness logins, SSH agent and git credentials, so there is no `sudo` anywhere in the install path.

## Status

Pre-implementation. The workspace is scaffolded ([NG-515](https://linear.app/digimondo/issue/NG-515)); the design is being settled ticket by ticket on the wayfinder map, [Rocky as an AI development-lifecycle platform](https://linear.app/digimondo/issue/NG-566).

## Project management

Tickets live in Linear (Niotix Grid team). All tickets carry the repository label so Cyrus can map them to this repo.
