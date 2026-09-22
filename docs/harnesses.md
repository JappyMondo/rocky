# Harness Configuration And Verification

Rocky has three code-owned adapters, `claude-code`, `opencode` and `codex`. Model identifiers
pass through verbatim; there is no Rocky model registry or configurable adapter registry.

## Instance Configuration

Native command/environment/storage settings belong in `~/.rocky/config.json`.
Agent harness/model/effort selections belong in the profile’s `models` map, keyed by the workflow’s [named slots](workflow-models.md):

```json
{
  "harnesses": {
    "codex": {
      "command": "codex",
      "sessionStorage": "codex"
    },
    "opencode": {
      "command": "opencode",
      "sessionStorage": "rocky"
    },
    "claude-code": {
      "command": "claude",
      "env": { "CLAUDE_CODE_OAUTH_TOKEN": "${WORK_CLAUDE_TOKEN}" }
    }
  }
}
```

`command` and `env` use Rocky's `${VAR}` expansion. Keep secrets in the environment,
not literal JSON. Agent prompts, Capabilities and named MCP grants are chosen at each Workflow call site; spread `ctx.models.<slot>` to use a configured model selection.

## Codex CLI

Select `codex` in setup or in a profile's model slots, with an explicit model ID
and reasoning effort. Rocky passes these as `--model` and
`model_reasoning_effort`. Install a compatible Codex CLI (the native fixture is
verified with 0.153.4), then use `codex login`, or configure `CODEX_API_KEY` through
the harness environment. Doctor uses `codex login status` and never displays the
API key that command can print. An offline login check does not prove model access.

Codex uses `codex exec --json` and `codex exec resume <thread-id>`. Rocky records
raw JSONL, native token usage, tool activity and final text. It verifies the
thread ID against the Step Transcript before resuming; it never resumes `--last`.
See the [official noninteractive CLI documentation](https://learn.chatgpt.com/docs/non-interactive-mode).

`sessionStorage: "codex"` is the Codex default and its only supported storage mode.
Native resumable sessions and authentication remain in the configured `CODEX_HOME`
(normally `~/.codex`); Rocky does not relocate or copy credentials. Rocky's raw
Transcript remains under the Run. Deleting a Run does not remove native Codex
sessions; both stores must survive for continuation. Run-owned native Codex
session storage is not supported.

Rocky ignores user configuration and execpolicy rules, marks the checkout's Codex
configuration untrusted, and disables hooks, plugins, skills, apps, subagents and
web/image tools. Existing user model/provider defaults therefore do not select
the model for Rocky. Managed Codex policy can still restrict execution.

The `read` grant supplies a private `rocky_read` MCP server with `read_file`,
`list_directory`, `glob_files` and literal `search_files` tools. It does not enable
a shell. `bash` enables Codex's shell tools; `edit` enables workspace writes via
Codex's native permission profile. Without `edit`, native writes are denied except
to explicitly granted evidence directories. Codex may still advertise `apply_patch`
in read-only turns; native permissions reject repository writes. Shell network
access follows `bash`. No sandbox or approval bypass is used.

Named MCP grants support stdio and streamable HTTP; legacy SSE is rejected with
a configuration fix. Servers are required, and resolved headers are supplied
through per-attempt environment variables. Private stdio launch files are removed
after execution. The `rocky_read` server name is reserved.

`rocky upgrade` remains an interactive content-negotiation command for Claude Code
and OpenCode; it does not use this noninteractive adapter.

## OpenCode and Claude session storage

`sessionStorage: "rocky" | "opencode"` defaults to `rocky`. OpenCode implements this
using `OPENCODE_DB`: `rocky` gives each Step `<transcript>.opencode.db`.
Parallel Steps never initialize or write the same SQLite store. Resumes of older
conversations fall back to `sessions/opencode.db` when no per-Step database exists.
Configuration/Agent probes always use a disposable database, including for legacy
resumes, so a read-only probe cannot contend with a live session; `opencode` leaves the native store selection unchanged. Retention of a
Run does not remove sessions kept in the ordinary OpenCode store. OpenCode auth,
caches and logs remain in the CLI's ordinary locations. Rocky does not copy or edit
that credential store. Claude routes only its native session artifacts into a
per-Step directory under the Run's `sessions/`; `opencode` storage is not a Claude
mode.

Claude retains the configured execution environment, including a host `CLAUDE_CONFIG_DIR`,
for authentication. Rocky disables user/project settings and routes only the native
session artifacts using its SessionStart hook. Doctor runs that exact execution probe
and reports its identity only when the probe reports one; it fails closed if that
identity differs from the configured probe. Rocky never extracts keychain secrets,
relocates credentials, or changes the login. Local session-routing fixtures do not
prove an authenticated Claude continuation; that remains a live acceptance gate.

## Policy Enforcement

OpenCode configuration was verified against CLI `1.18.29`. Rocky reads compatible
settings from global `config.json`, `opencode.json` and `opencode.jsonc`, explicit
`OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR` and `OPENCODE_CONFIG_CONTENT`, and checkout
`opencode.json`/`.jsonc` plus `.opencode/opencode.json`/`.jsonc`. Provider/model,
enabled/disabled providers, instructions and compaction settings survive. Tool
permissions, custom Agents, plugins and MCP entries do not confer grants.

Rocky writes private ephemeral config, supplies sanitized `XDG_CONFIG_HOME`, sets
`OPENCODE_DISABLE_PROJECT_CONFIG`, `OPENCODE_TEST_HOME`, `OPENCODE_PURE` and its own
`OPENCODE_PERMISSION`, and selects its `rocky` Agent. This avoids the native loader
rewriting repository config or discovering arbitrary `.opencode/tools` and plugins.
It runs `debug config` and `debug agent rocky` under that environment and refuses
effective policy conflicts before the conversation. A CLI upgrade must retain these
contracts and pass the native policy tests; incompatible probes fail closed.

Claude uses an explicit built-in `--tools` list, `dontAsk`, disabled hooks/skills,
isolated settings and `--strict-mcp-config`. No adapter uses permission bypass,
`opencode serve`, a structured-output SDK path, or Harness-native MCP OAuth.
Capabilities are tool grants, not an OS sandbox: granting `bash` permits shell
effects, and granting a powerful MCP tool deliberately grants its effects.

## Caller Contract

`getHarnessAdapter(name)` returns `HarnessAdapter | undefined`, exposing `run`,
`resume` and `checkAuth`. Doctor uses its auth-only view. The
production Agent uses the same adapter; the configured native account still
needs to pass live authentication and execution checks.

`HarnessInvocation` takes resolved `command`/`env`, `cwd`, `prompt`, optional model,
Capabilities, resolved MCP servers, `sessionStorage`, a unique Step `transcriptPath`,
optional `signal`/`timeoutMs`, and `onEvent(event, sessionId)`. The caller puts the
Transcript under `runs/<runId>/sessions/`. `run` always starts a new conversation;
only `resume` supplies a session ID, verified against that Step's Transcript.
Native session state and the same Transcript must both survive to resume.

MCP input is `{ name, config }`, where `config` is the resolved ecosystem
declaration: `type: 'stdio'`, `command`, `args`, `env`, or `type: 'http' | 'sse'`,
`url`, `headers`. The MCP lane expands environment references and obtains fresh
authorization before each call in `config.headers.Authorization`. The adapters pass
that resolved header through unchanged, render only private native config, and remove
it after child settlement. They never read or rewrite `.rocky/mcp.json`.

Raw stdout is appended to a mode-0600 Transcript before event delivery. Timeouts and
cancellation terminate only the owned process group, including descendants.
`HarnessResult` contains raw final `text`, parsed `events`, `sessionId` and optional
native `usage`. Missing usage stays absent; costs are never priced from tokens.
An exit status alone is not success: NG-544 extracts and validates the result tag.
`HarnessError.retryable === false` identifies recognized model/auth/policy failures;
the caller owns retries and the Step-wide clock. No conversation crosses Steps.

## Verification Gates

Run with Node 24 and installed dependencies. Focused tests avoid daemon listeners:

```sh
pnpm exec vitest run --config packages/daemon/vitest.config.mts packages/daemon/src/harness packages/daemon/src/doctor/doctor.spec.ts packages/daemon/src/config/schema.spec.ts
ROCKY_OPENCODE_POLICY_TESTS=1 pnpm exec vitest run --config packages/daemon/vitest.config.mts packages/daemon/src/harness/policy.spec.ts packages/daemon/src/harness/opencode-cli.spec.ts
ROCKY_REAL_OPENCODE_TESTS=1 pnpm exec vitest run --config packages/daemon/vitest.config.mts packages/daemon/src/harness/live.spec.ts
ROCKY_REAL_CLAUDE_TESTS=1 pnpm exec vitest run --config packages/daemon/vitest.config.mts packages/daemon/src/harness/live.spec.ts
ROCKY_CODEX_POLICY_TESTS=1 pnpm exec vitest run --config packages/daemon/vitest.config.mts packages/daemon/src/harness/codex-cli.spec.ts
ROCKY_REAL_CODEX_TESTS=1 pnpm exec vitest run --config packages/daemon/vitest.config.mts packages/daemon/src/harness/live.spec.ts
```

The live Codex gate uses the installed CLI and existing authentication. It checks
a real MCP file read and same-thread continuation, then runs a disposable coding
ticket through Rocky's Agent runner: repair a failing fixture, execute its tests,
validate the structured result, record usage and reload the completed Run without
another invocation. It creates no external ticket. `ROCKY_CODEX_MODEL` and
`ROCKY_CODEX_EFFORT` optionally pin the selection; otherwise Codex uses its built-in
default. Temporary workspaces are removed unless `ROCKY_KEEP_PROBE=1`.

The native OpenCode policy suite uses a local model-protocol fixture and local MCP
server: it checks actual offered tools, static Bearer headers, tool boundaries,
native continuation and unchanged repository bytes, not just generated JSON.
It is not evidence of a live model account. Live tests are separately gated and
`ROCKY_OPENCODE_MODEL` optionally pins their model; otherwise OpenCode selects its
configured default.

The inherited `opencode-1.17.7-tool-call.jsonl` came from NG-530's prior parser work.
The redacted `opencode-1.18.29-live.jsonl` was captured in this lane with a real
file-read tool call and same-session continuation recalling its word. It preserves
the native event sequence and usage, including the CLI's reported zero cost.
`claude-synthetic.jsonl` and `harness-cli.mjs` are synthetic, not recorded successful
Claude runs. NG-643 still requires a redacted authenticated Claude tool stream and
successful live continuation. The last reported inference failure was
`oauth_org_not_allowed`; an offline `loggedIn: true` does not clear that gate.
Full daemon coverage and integrated Preflight/Agent/Steer acceptance remain separate
integration gates. Neither these fixtures nor a registered adapter close those tickets.

## Missing tools and validation

Every Agent prompt describes its actual Capability and MCP grants. Read-only file
inspection does not require Git metadata reads; worktree branches are checked with
Git when modifications are needed. Agents with `bash` also receive `ROCKY_NODE`
and `ROCKY_MERMAID_CHECK`. Pipe Markdown to `"$ROCKY_NODE"
"$ROCKY_MERMAID_CHECK"`, or use `--source` for one diagram. The bundled checker
reads stdin, writes JSON with the exact input hash and per-diagram Mermaid parser
results, and changes no repository files. Exit codes are 0 (valid), 1 (invalid
syntax), and 2 (validator unavailable). Parsing is explicitly not rendering.

A required operation blocked by missing tools/access has an alternative response:
`<blocked>{"reason":"…","requiredTool":"…","fix":"…"}</blocked>`.
The runner records `AgentBlockedError` immediately, preserving the session and
usage. It does not apply schema-repair nudges or automatic retries to that response.
Recognized native tool permission rejections likewise stop with a named fix;
ordinary missing-file and search errors remain available for the Agent to resolve.
No failure automatically widens grants. Fix the Workflow call site or configuration
before retrying; changed Workflow grants require a new Run snapshot.

Agents with shell access are told to check the installed `agent-browser` CLI before
assuming a browser is missing. Each Step gets a stable, distinct
`ROCKY_BROWSER_SESSION`. Recap captures receive a local preview URL only when a
recorded body exactly matches the requested deliverable; they use its actual
rendered content, not transcript source or an invented preview. A missing browser
for a required capture stops the capture sequence with the blocked envelope.

Profile creation, workflow seeding and reset require explicit harness, model and variant/effort selections for every declared slot. They are stored in the profile `models` map and read before every Run Boot, then exposed through `ctx.models` as an immutable view for that Boot. The adapters pass them via `--model` plus OpenCode `--variant` or Claude Code `--effort`. Use full model IDs when avoiding moving aliases. Supported variants remain model-specific ([OpenCode models](https://opencode.ai/docs/models/), [Claude Code model configuration](https://code.claude.com/docs/en/model-config)); Rocky accepts explicit names rather than maintaining a stale model catalog. This pins the selected names, not provider behavior or user-defined variant definitions.
