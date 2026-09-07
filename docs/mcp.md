# MCP Plumbing And OAuth

NG-599 implements declarations, login, credentials and per-attempt/Preflight
primitives. It does **not** wire a production `ctx.agent` or Preflight Run.
Native Harness configuration and child lifetime belong to NG-530/NG-643;
Agent execution to NG-544; journaled Preflight to NG-605.

## Declaration

`.rocky/mcp.json` is JSON, not executable code. No `oauth`, tool policy or
Rocky-specific keys are accepted:

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp", "--output-dir", "${ROCKY_SCREENSHOT_DIR}"]
    },
    "api": { "type": "http", "url": "https://example.com/mcp" },
    "manual-auth": {
      "type": "sse",
      "url": "https://example.com/sse",
      "headers": { "Authorization": "Bearer ${API_TOKEN}" }
    }
  }
}
```

Stdio supports `command`, optional `args` and `env`, and optional `type: "stdio"`.
Remote supports `url`, optional `headers`, and `type: "http"` (default) or `"sse"`.
Missing files mean no declared servers; malformed files fail with their path.
Unknown server names fail at the affected Agent Step, naming the file and known
names. Declaring a server does not grant it to an Agent.

Rocky expands string values once, before adapter translation. `${VAR}` requires
a value; `${VAR:-default}` uses the default when unset or empty. Expansion is
not recursive and does not run a shell. Run-supplied `ROCKY_RUN_DIR`,
`ROCKY_SCREENSHOT_DIR` and `ROCKY_PORT` override the environment. Callers supply
the Run environment after resolving instance/repo secrets. Expanded config and
headers are secret-bearing: never persist them in the Journal or mirror them
into Linear. The raw snapshot remains the source on a later Boot.

## Login

From the repo root:

```sh
rocky mcp login api
rocky mcp login api --client-id registered-client --callback-port 8765
rocky mcp login api --client-id registered-client --client-secret secret --callback-port 8765
```

Login reads only the selected server from `mcp.json`; unrelated Run-only
placeholders do not need values. It never imports the Workflow or starts the
daemon. It opens the system browser, discovers RFC 9728 protected-resource and
RFC 8414/OIDC authorization-server metadata, registers a public client when DCR
is available, and exchanges an authorization code with S256 PKCE and random
state. State, code and verifier stay in memory, never in the credential file.
Both OAuth and OIDC discovery must explicitly advertise `S256` in
`code_challenge_methods_supported`. Absent, empty or incompatible methods fail
before registration or browser launch, as required by the
[MCP authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#authorization-code-protection).

The temporary callback is `http://127.0.0.1:<port>/callback`, with an ephemeral
port by default. Pre-registered clients can use `--callback-port` to match their
registered URI. It is loopback-only, is not a daemon/public-ingress route, and
closes on success, denial, failure, timeout or SIGINT. Login has a two-minute
deadline across the entire operation, including opener completion, code
exchange and credential-lock acquisition, even after the code arrives. Each
HTTP request has a ten-second deadline, including body consumption. Abort
closes the callback immediately; the operation also awaits lock/file cleanup.
HTTPS is required for OAuth and Bearer injection except on loopback. Token requests never follow
redirects. Issuer and resource binding are checked; error responses are not
quoted into errors or logs.

`MCP_OAUTH_LIMITS` exports the fixed Rocky v1 resource ceilings (these are not
maxima prescribed by OAuth):

| Data | Ceiling |
| --- | --- |
| One decoded OAuth HTTP response, including resource/AS metadata, DCR, tokens and errors | 256 KiB |
| Each credential string, including access/refresh tokens, scope and client credentials | 16 KiB UTF-8 |
| One stored URL-keyed OAuth credential | 64 KiB serialized JSON |
| The complete MCP credential section written by OAuth | 1 MiB serialized JSON |

HTTP bytes are counted while consuming the **decompressed** stream, not from
`Content-Length`; chunked and gzip bodies cannot bypass the ceiling. Storage
counts UTF-8 bytes of JSON with two-space indentation. Oversized values fail
with a named error rather than being truncated or written. A failed login or
refresh preserves the previous file and unrelated Linear/repo secrets. Old
oversized MCP entries can be replaced by logging into the same URL again;
remove unused entries if the entire MCP section would still exceed its ceiling.

No DCR means a named error explaining both alternatives: pre-register a client
and use `--client-id` / `--client-secret`, or supply an environment-expanded
Authorization header. Client-secret flags are visible to shell history/process
inspection; avoid pasting them into shared sessions. No auth block is added to
the repo and neither Harness's own OAuth commands or token store are used.

## Consumer Contract

Exports come from `@rocky/daemon` (internally `src/mcp/index.ts`):

```ts
const declarations = await readMcpConfig(`${snapshotDir}/mcp.json`);
const config = expandMcpConfig(declarations, {
  env: runEnv,
  run: { runDir, screenshotDir, port: ports[0] },
});

// Inside NG-605's journaled Preflight, not on replay:
const refreshedNames = await preflightMcp(config, { paths, signal });

// Immediately before EACH live Agent attempt, including a resumed conversation:
const mcpServers = await resolveMcpServers(config, agentOptions.mcp ?? [], {
  paths,
  signal,
});
// Pass only this list as HarnessInvocation.mcpServers.
```

- `parseMcpConfig(raw, file?) -> McpConfig` validates and normalizes the standard
  shape. `mcpConfigSchema` is its Zod schema. `readMcpConfig(file)` reads it.
  Declaration, expansion and unknown-name errors are `ConfigError` instances
  naming the file. The Agent caller must treat resolution failures as fatal
  configuration errors, not spend the generic attempt ladder on them.
- `expandMcpConfig(config, { env?, run? }) -> McpConfig` returns a new expanded,
  validated config. Do this from the immutable snapshot at Run start/Boot,
  **not** from the live repo or repeatedly between attempts.
- `selectMcpServers(config, names) -> McpServer[]` validates all requested names
  and deduplicates them. Selection alone does not inject credentials.
- `resolveMcpServers(expandedConfig, names, options?) -> Promise<McpServer[]>`
  re-reads credentials under a cross-process lock and refreshes stale tokens
  with a 60-second expiry skew. No background timer or mid-attempt rotation.
- `preflightMcp(expandedConfig, options?) -> Promise<string[]>` forces refresh
  even for unexpired stored credentials, once per URL, and returns safe names
  only. It has a 30-second operation deadline, including lock waits. Stdio and
  never-logged-in servers cause no OAuth requests. It checks **every** stored snapshot-named remote
  credential, including one now overridden by a manual header; remove obsolete
  stored entries when abandoning Rocky-managed auth.
- `mcpUnauthorized(name) -> McpAuthError` is the adapter/Agent seam for an actual
  MCP 401/unauthorized report. The error has `fatal: true` and an exact `fix`
  command. Fail the affected Step/Run, do not retry it as a generic tool failure
  or invent a Checkpoint. Non-auth tool failures remain the attempt ladder.
- `loginMcpServer(declarations, name, options) -> Promise<{ server, url }>` is
  the CLI login seam. `options.openBrowser(URL, signal)` is required; `paths`, `env`,
  client flags, callback port, deadlines and cancellation are optional.
  Existing one-argument openers remain assignable, but openers should observe
  the signal to stop their own I/O. The CLI forwards it to its launcher process.
  Login rejects and cleans up even when a supplied opener ignores cancellation.

`McpAuthOptions` contains `paths?`, `fetch?`, `now?`, `signal?`,
`requestTimeoutMs?`. Production defaults use `rockyPaths()`, `fetch` and
`Date.now`. The clock and HTTP boundary are injectable for deterministic tests.

`McpServer` is structurally compatible with the existing Harness contract:

```ts
type McpServer = {
  name: string;
  config:
    | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
    | { type: 'http' | 'sse'; url: string; headers?: Record<string, string> };
};
```

OAuth arrives as ordinary `config.headers.Authorization: "Bearer ..."`.
The older optional `authorization` field on `ResolvedMcpServer` is not populated.
An explicit case-insensitive Authorization header takes precedence at
attempt-render. Never-logged-in remotes pass through without a fabricated token:
only the server's first rejection establishes whether auth is required.

Adapters must enforce the effective Step policy against personal, global and
repo configuration, including empty MCP grants; disable native OAuth fallback;
translate these configs without expanding environment variables again; write
ephemeral native configs with secret permissions; and own MCP process lifetime
inside the Agent call. This module starts no MCP processes and never imports
either adapter. Returned configs must not be logged. Feed their secret-bearing
values into the existing redactor before any diagnostic output, including
manual headers and stdio env/args, and keep raw Harness configs out of Transcripts.

## Credentials And Concurrency

`~/.rocky/credentials.json` (`ROCKY_HOME` can relocate it) holds `mcp` entries
keyed by normalized full server URL: scheme/host normalization and default-port
normalization follow `URL.href`; paths and query remain distinct. A login for
one repo-local alias updates every alias of that URL. Stdio never gets a token
entry. Each entry stores the registered client, bound issuer/resource/token
endpoint, tokens and absolute expiry. All credential strings participate in the
existing instance redaction set.

The root is 0700 and credentials are 0600, including exclusive randomly named
temporary files before atomic rename. Credential symlinks are refused. A
heartbeat-backed file lock serializes CLI and Boot processes; it reclaims stale
locks after 30 seconds and bounds acquisition retries to roughly 20 seconds.
Refresh and login **token exchange plus persistence** occur under that lock;
the human browser wait does not. Rotated refresh tokens are re-read after
acquiring the lock. If a refresh response omits a new refresh token, the old
one survives. Failure does not delete other servers, Linear tokens or repo
secrets. External token issuance followed by a process/power failure before
persistence remains an unavoidable re-login case, not exactly-once OAuth.

All credential read-modify-write consumers must use
`updateCredentials(paths, current => next, options?)` rather than reading then
calling `writeCredentials` with an old snapshot. The existing setup writer now
does so. `options` accepts `{ signal?: AbortSignal }`.
The optional third argument is `CredentialUpdateOptions`; existing two-argument
callers, including `writeCredentials`, keep their contract. Acquisition retries
are abortable; a cancelled waiter cannot acquire a lock later. The callback is
also an abortable wait: its late result is never persisted, and the lock is
released before rejection. Capture the same signal in callback I/O so external
effects can stop too. Do not nest credential updates or wait for a human inside
their callback.

Cancellation is checked again before writing and before the atomic rename.
An already-started rename cannot be undone; cleanup and lock release finish
before returning. Cancellation cannot revoke a token already issued by an
external authorization server, so cancelling an exchange/refresh can still
require re-login, just as a crash between issuance and persistence can.

## Remaining Acceptance

Local HTTP fixtures demonstrate OAuth/PKCE/callbacks, safe errors, URL aliases,
token rotation, Preflight failures, CLI wiring and concurrent OS-process
refresh. They are not captured real-Harness evidence. NG-599 remains open until
NG-544, NG-530, NG-643 and NG-605 demonstrate an actual Agent call through both
Harnesses, snapshot/Journal integration and early Run failure. Live tests that
expose Rocky publicly also require NG-651. Independent review and green current
head CI remain required before merge; merge alone does not waive these gates.
