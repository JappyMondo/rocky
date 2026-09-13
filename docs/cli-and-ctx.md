# CLI and Workflow context contract

This is the implemented surface of the current checkout. CLI registration is in
`packages/cli/src/cli.ts`; deliberate failures remain in `commands.ts`.
The SDK declares Workflow APIs; the daemon implements their behavior.

## CLI

| Command                                                   | Current behavior                                                                                                    |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `rocky setup`                                             | Interactive public endpoint, Linear app/OAuth and model setup; installs and starts daemon and ingress user services |
| `rocky start [-d]`                                        | Foreground or detached daemon                                                                                       |
| `rocky stop`, `restart`, `status`                         | Local lifecycle, pidfile and version checks; restart is explicit                                                    |
| `rocky logs [-f] [-n <count>]`                            | Daemon log, separate from per-Step Transcripts                                                                      |
| `rocky doctor`                                            | Configuration, endpoint identity and native harness authentication checks                                           |
| `rocky service install\|uninstall`                        | Install/load or unload/remove daemon and ingress launchd/systemd user units                                         |
| `rocky repo add <url>`                                    | Clone and create a local default profile and Linear label route; requires explicit model choices                    |
| `rocky repo list`, `remove <name>`                        | List repositories/groups or remove an instance route                                                                |
| `rocky repo profile list`, `export <id>`, `import <file>` | Manage portable local profile definitions                                                                           |
| `rocky repo profile use <repo> <id>`                      | Assign a profile for the matching repository remote                                                                 |
| `rocky repo profile seed <repo>`                          | Replace a configured repository's profile with installed defaults; requires model choices                           |
| `rocky repo profile delete <id>`                          | Delete an unassigned profile; assigned profiles are refused                                                         |
| `rocky mcp login <server> --repo <name>`                  | Authenticate a remote MCP declaration from the repository's assigned local profile                                  |
| `rocky init`, `rocky upgrade`                             | Failing stubs; legacy content helpers exist but are not registered                                                  |
| `rocky trigger <name> <issue>`                            | Failing stub; use the local UI/API for manual admission                                                             |
| `rocky-ingress [--port <port>] [--daemon-port <port>]`    | Loopback webhook/ping/OAuth-callback filter, managed by setup for normal use                                        |

Address options are shown in each command's `--help`. Instance configuration and
a live pidfile supply omitted addresses. Bind changes require a daemon restart.
Installing Rocky does not install or authenticate a harness.

### Repository and model setup

In a terminal, `rocky repo add <url>` and `rocky repo profile seed <repo>` ask for
a review/implementation selection and a planning selection. Each includes harness, model and variant/effort. Setup choices are suggestions.
Noninteractive callers must provide `--harness`, `--model` and `--variant` together.
Planning reuses them unless all three `--fast-harness`, `--fast-model` and
`--fast-variant` options are supplied. Missing or partial choices fail before
cloning or writing. The model and variant are passed to the selected native CLI;
Rocky does not maintain a provider model catalog. These choices initialize the default’s named slots. The UI can change review, implementation and planner independently without rewriting source; see [named models](workflow-models.md).

`repo add` also accepts `--name`, `--label` and `--base-branch`. It creates local
profile content, never a target-repository `.rocky/`. Edit commands, prompts and
MCP grants in **Profiles**. `profile seed` replaces content; it is not a merge of
customizations. Profile updates apply to new Runs, not existing snapshots.

### Manual admission

**New run** calls `POST /api/triggers` with `{ trigger, issue, profileId? }`.
The trigger is a registered manual name and the issue is resolved through Linear,
including its comment history. An explicit profile selects its whole membership;
otherwise issue-label routing applies. Admission returns 201, or a named 409
refusal if the issue already has a live Run. No branch is reset on refusal.

Manual Runs have no Linear Agent Session. They can execute local Agent/shell
work, but production does not attach session-backed questions, checkpoints,
Linear posts/comments/state changes, visual-recap publication or SCM services.
In particular, the shipped `address-pr-conversations` manual Trigger is not an
end-to-end usable local path merely because it is listed. CLI `trigger` does not
call this API yet and exits nonzero.

## Workflow context

| Surface                              | Runtime behavior                                                                                                                             |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `issue`, `branch`, `ports`           | Run/Boot data; new issue snapshots include paginated comment history                                                                         |
| `models`                             | Immutable named harness/model/effort selections captured in the Run profile; spread `ctx.models.<slot>` into agent options                   |
| `agent`                              | Named frozen prompt or inline prompt; harness/tools/MCP/model/effort chosen at the call site; validates structured output and adds `summary` |
| `exec`, `step`, `changedFiles`       | Journaled shell work, arbitrary JSON-returning effects and Git changes                                                                       |
| `parallel`                           | One parent entry and index-keyed branch journals, with ordered results                                                                       |
| `stage`                              | Display marker; no journal sequence number                                                                                                   |
| `question`                           | Durable written clarification; does not approve a merge                                                                                      |
| `checkpoint`                         | Durable approve/reject/Steer decision; approved answer is required for merge                                                                 |
| `post`, `comment`, `linear.setState` | Linear activity, explicit durable comment and exact state-name selection                                                                     |
| `scm`                                | Platform PR/MR, CI, thread, draft, branch-update and approved merge operations                                                               |
| `visualRecap`                        | Generate, retain and publish a report for a PR, diff or text deliverable                                                                     |

The Linear/control/SCM/report operations above require the session-backed
production services. SDK declarations alone do not supply those integrations.
See [execution integration](execution-integration.md), [visual review](visual-review.md)
and [visual recaps](visual-recap.md).

`ctx.parallel` callbacks capture the same context; async-local routing selects
the branch journal. Raw concurrent context calls through `Promise.all` are
unsupported. For example:

```ts
const results = await ctx.parallel(
  ['lint', 'test'],
  async (command, index) => ctx.exec(command, { label: `check ${index + 1}` }),
  { label: 'checks' },
);
```

`models`, `ports` and `stage` are not Steps. Background `exec` respawns on working Boots;
polls do not start new Steps or background commands. Ordinary code between Steps
runs again from the top on each Boot. Effectful Steps are at-least-once, so use
idempotent operations and journal outcomes that must survive restart. Eligible
failed-step retry preserves the snapshot and earlier results; see [Run runtime](run-runtime.md)
and [Journal retry](journal-writer.md#explicit-step-retry).

There is no `ctx.interruptions()`, `ctx.sandbox` or `ctx.loop` API. The SDK contains
types, Trigger builders and Zod, not the shipped default Workflow or daemon.
