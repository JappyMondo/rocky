# Harness Configuration And Verification

Rocky has two code-owned adapters, `claude-code` and `opencode`. Model identifiers
pass through verbatim; there is no Rocky model registry or configurable third adapter.

## Instance Configuration

The Harness block belongs in `~/.rocky/config.json`, not `.rocky/workflow.ts`:

```json
{
  "harnesses": {
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
not literal JSON. Agent prompts, models, Capabilities and named MCP grants are still
chosen at each Workflow call site.

`sessionStorage: "rocky" | "opencode"` defaults to `rocky`. OpenCode implements this
using `OPENCODE_DB`: `rocky` overrides it with `sessions/opencode.db` beside the
Transcript; `opencode` leaves the native store selection unchanged. Retention of a
Run does not remove sessions kept in the ordinary OpenCode store. OpenCode auth,
caches and logs remain in the CLI's ordinary locations. Rocky does not copy or edit
that credential store. Claude always keeps native state in a per-Step directory
under the Run's `sessions/`; `opencode` storage is not a Claude mode.

Claude's supported `CLAUDE_CONFIG_DIR` isolation also isolates keychain/file login
state. Doctor detects a login that cannot be used in that isolated directory and
names the fix: `claude login`, then supply `CLAUDE_CODE_OAUTH_TOKEN` (from
`claude setup-token`) or `ANTHROPIC_API_KEY` through the Harness environment.
Rocky never extracts keychain secrets, relocates credentials, or changes the login.
This limitation is explicit, not a claim that a host-only keychain login works.

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
`resume` and `checkAuth`. Doctor uses its auth-only view. Preflight must call that
same method; its production wiring belongs to NG-605.

`HarnessInvocation` takes resolved `command`/`env`, `cwd`, `prompt`, optional model,
Capabilities, resolved MCP servers, `sessionStorage`, a unique Step `transcriptPath`,
optional `signal`/`timeoutMs`, and `onEvent(event, sessionId)`. The caller puts the
Transcript under `runs/<runId>/sessions/`. `run` always starts a new conversation;
only `resume` supplies a session ID, verified against that Step's Transcript.
Native session state and the same Transcript must both survive to resume.

MCP input is `{ name, config, authorization? }`, where `config` is the resolved
ecosystem declaration: `command: string`, `args`, `env`, or `url`, `type`, `headers`.
The MCP lane expands environment references and obtains fresh authorization before
each call. The adapters only render it into native private config and remove that
config after child settlement. They never read or rewrite `.rocky/mcp.json`.

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
```

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
