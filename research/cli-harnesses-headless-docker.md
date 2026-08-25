# Can Claude Code and opencode run headless inside a Docker container on subscription auth?

Research for NG-481 (wayfinder). Researched 2026-08-25. All claims cite primary sources; anything not verifiable from a primary source is marked **unverified** or **inference**.

## Question

Can Claude Code and opencode run headless inside a single Docker container (Node.js/NestJS service spawning them as child processes, one per review run, killable mid-run, global concurrency cap default 2) using a **user's subscription auth**, and under what constraints? We wrap only the official CLIs ("harness-for-the-harness") — no token extraction.

## TL;DR / Answer

- **Claude Code: yes, and it is the officially sanctioned path.** `claude -p` is the documented non-interactive mode with `text`/`json`/`stream-json` output, documented exit-code and SIGTERM/SIGINT semantics ([headless docs](https://code.claude.com/docs/en/headless)). On Linux, subscription OAuth credentials live in a plain file `~/.claude/.credentials.json` (no keychain), relocatable via `CLAUDE_CONFIG_DIR` — so a mounted volume survives restarts ([authentication docs](https://code.claude.com/docs/en/authentication#credential-management)). The interactive login has a documented paste-a-code fallback "common in WSL2, SSH sessions, and containers", and `claude setup-token` mints a one-year subscription OAuth token for `CLAUDE_CODE_OAUTH_TOKEN` in "CI pipelines, scripts, or other environments where interactive browser login isn't available" ([authentication docs](https://code.claude.com/docs/en/authentication#generate-a-long-lived-token)).
- **Policy: hosting the *unmodified* Claude Code binary where each end user signs in with their own subscription is explicitly permitted** under Anthropic's Claude Code legal page — with hard conditions: binary unmodified, no auth method removed, and the platform must never "collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow" ([legal & compliance](https://code.claude.com/docs/en/legal-and-compliance)). Consumer OAuth in any *other* harness (including apps built on the Agent SDK directly) is prohibited.
- **opencode: headless works (`opencode run`, `opencode serve`), but Claude Pro/Max subscription auth is dead.** opencode removed Claude Pro/Max login in v1.3.0 because "Anthropic explicitly prohibits this" ([opencode providers docs](https://opencode.ai/docs/providers/)); Anthropic also enforces this server-side (secondary sources, see §3). opencode in our container is only viable with API keys (Anthropic API, OpenRouter, Ollama, 75+ providers) or the non-Anthropic subscriptions opencode still supports (ChatGPT Plus, GitHub Copilot, GitLab Duo).
- **Size**: Claude Code Linux x64 binary ≈ 392 MB unpacked ([npm](https://www.npmjs.com/package/@anthropic-ai/claude-code)); opencode Linux x64 binary ≈ 185 MB unpacked ([npm](https://www.npmjs.com/package/opencode-linux-x64)). Both are self-contained native binaries; neither needs Node/Bun at runtime. Claude Code's documented hardware floor is 4 GB+ RAM ([setup docs](https://code.claude.com/docs/en/setup#system-requirements)).
- **OpenAI-compatible API fallback**: confirmed — the OpenAI SDK takes a `baseURL` option, and both Ollama (`http://localhost:11434/v1/`) and OpenRouter (`https://openrouter.ai/api/v1`) document drop-in use of the OpenAI SDK against their chat-completions endpoints (§5).

---

## 1. Headless invocation

### Claude Code (`claude -p`)

Primary sources: [Run Claude Code programmatically](https://code.claude.com/docs/en/headless), [CLI reference](https://code.claude.com/docs/en/cli-reference).

- **Invocation**: `claude -p "<prompt>" [flags]` (`-p` = `--print`). Also reads the prompt/data from stdin (piped stdin capped at **10 MB**; exceeding it exits non-zero with a clear error). ([headless docs](https://code.claude.com/docs/en/headless))
- **Output formats** (`--output-format`): `text` (default), `json` (single object with `result`, `session_id`, `total_cost_usd`, usage metadata), `stream-json` (newline-delimited JSON events; combine with `--verbose --include-partial-messages` for token-level streaming; the last line is a `result` message with final text, cost, and session metadata). ([headless docs](https://code.claude.com/docs/en/headless#get-structured-output))
- **Schema-validated output**: `--output-format json --json-schema '<schema>'` returns the structured payload in `structured_output`; an invalid schema exits with `Error: --json-schema is not a valid JSON Schema`. ([headless docs](https://code.claude.com/docs/en/headless#get-structured-output))
- **Stream events useful to a supervisor**: `system/init` (first event: model, tools, MCP/plugin load status incl. `mcp_server_errors` for CI gating), `system/api_retry` (retry/backoff visibility with `error` categories like `rate_limit`, `overloaded`, `billing_error`), subagent messages tagged with `parent_tool_use_id`. ([headless docs](https://code.claude.com/docs/en/headless#stream-responses))
- **Exit codes**: "Claude Code exits with code 0 on success and a non-zero code when the run fails, so your scripts can branch on the exit status." Invalid flags error to stderr before the run; failures *inside* the run (e.g. missing auth) are printed as the result on stdout. ([headless docs](https://code.claude.com/docs/en/headless#basic-usage))
- **Kill semantics** (documented — directly relevant to "killable mid-run"):
  - **SIGTERM → exit code 143**; Claude Code terminates the process tree of any running Bash command, runs `SessionEnd` hooks, and leaves the in-progress turn unfinished (resumable later with `--resume`).
  - **SIGINT** ends the current turn cleanly instead of abandoning it. ([headless docs, "Stop a run with SIGTERM"](https://code.claude.com/docs/en/headless#stop-a-run-with-sigterm))
- **Run bounding**: `--max-turns N` (exits with error when the limit is hit) and `--max-budget-usd X` cap agentic loops; there is **no built-in wall-clock timeout flag** in the CLI reference — the spawner must enforce timeouts itself (**absence claim; verified against the [CLI reference](https://code.claude.com/docs/en/cli-reference)** as of 2026-08-25).
- **Sessions**: `--continue` / `--resume <session_id>`; capture `session_id` from `--output-format json`. `--no-session-persistence` disables writing sessions to disk. ([headless docs](https://code.claude.com/docs/en/headless#continue-conversations), [CLI reference](https://code.claude.com/docs/en/cli-reference))
- **Permissions in `-p` mode**: default starting mode is Manual; use `--allowedTools "Read,Grep,..."` (permission-rule syntax, e.g. `Bash(git diff *)`) and/or `--permission-mode` (`dontAsk` for locked-down CI-style runs, `acceptEdits`, `auto`). ([headless docs](https://code.claude.com/docs/en/headless#auto-approve-tools))
- **`--bare` caveat (critical for us)**: `--bare` skips loading hooks/skills/CLAUDE.md for reproducible fast startup, **but "In bare mode, Claude Code never reads OAuth credentials or the system keychain"** and "does not read `CLAUDE_CODE_OAUTH_TOKEN`" — bare mode requires `ANTHROPIC_API_KEY`/`apiKeyHelper`. **Subscription auth is incompatible with `--bare`.** ([headless docs](https://code.claude.com/docs/en/headless#start-faster-with-bare-mode), [authentication docs](https://code.claude.com/docs/en/authentication#generate-a-long-lived-token))
- **Background-task hygiene**: background shells Claude started are terminated ~5 s after the final result; background subagents are waited on up to a 10-minute cap (`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`). ([headless docs](https://code.claude.com/docs/en/headless#background-tasks-at-exit))

### opencode (`opencode run`)

Primary sources: [opencode CLI docs](https://opencode.ai/docs/cli/), [opencode server docs](https://opencode.ai/docs/server/).

- **Invocation**: `opencode run [message..]` — "non-interactive mode by passing prompts directly", for scripting/automation. Key flags: `--model/-m provider/model`, `--agent`, `--session/-s <id>`, `--continue/-c`, `--file/-f`, `--title`, `--dir`, `--auto` (auto-approve non-denied permissions), `--variant`, `--thinking`. ([CLI docs](https://opencode.ai/docs/cli/))
- **Structured output**: `--format` with values `default` (formatted) or `json` ("raw JSON events") — an event stream, not a single JSON document. ([CLI docs](https://opencode.ai/docs/cli/))
- **Logging**: global `--print-logs` writes logs to stderr. ([CLI docs](https://opencode.ai/docs/cli/))
- **Exit codes / timeout flags**: **not documented** in the CLI docs (**unverified**; assume 0/non-zero and enforce timeouts in the spawner).
- **Server alternative**: `opencode serve --port 4096 --hostname 127.0.0.1` runs a headless HTTP server exposing an **OpenAPI 3.1** REST API (spec at `/doc`; sessions, messages, files, providers endpoints; optional basic auth via `OPENCODE_SERVER_PASSWORD`/`OPENCODE_SERVER_USERNAME`). For a long-lived container this is arguably a better integration seam than per-run child processes, though it inverts our kill-per-run model. ([server docs](https://opencode.ai/docs/server/))

## 2. Auth persistence in a container

### Claude Code

Primary source: [Authentication](https://code.claude.com/docs/en/authentication).

- **Storage on Linux**: "credentials are stored in `~/.claude/.credentials.json` with file mode `0600`." macOS uses the encrypted Keychain; **on Linux there is no keychain dependency**, so no keyring daemon is needed in Docker. "If you've set the `CLAUDE_CONFIG_DIR` environment variable on Linux or Windows, the `.credentials.json` file lives under that directory instead." ([credential management](https://code.claude.com/docs/en/authentication#credential-management))
- **Volume persistence**: because credentials are an ordinary file under `~/.claude` (or `CLAUDE_CONFIG_DIR`), mounting that directory as a Docker volume persists login across container restarts (**inference from the documented file location**; the docs don't discuss Docker volumes explicitly). Note the uninstall docs show additional state at `~/.claude.json` (settings/state, separate from credentials), so mount the home dir or both paths ([setup docs](https://code.claude.com/docs/en/setup#remove-configuration-files)).
- **Login flow without a local browser** (documented, container-friendly): first run of `claude` opens a browser URL; "If your browser shows a login code instead of redirecting back after you sign in, paste it into the terminal at the `Paste code here if prompted` prompt. This happens when the browser can't reach Claude Code's local callback server, which is common in WSL2, SSH sessions, and containers." So a **one-time interactive `docker exec -it <container> claude` login** works: user opens the URL on their host browser, pastes the code back. ([Log in to Claude Code](https://code.claude.com/docs/en/authentication#log-in-to-claude-code))
- **Long-lived token alternative**: `claude setup-token` — "For CI pipelines, scripts, or other environments where interactive browser login isn't available, generate a **one-year** OAuth token". It runs the same browser authorization flow, prints the token (never saves it), and you export it as `CLAUDE_CODE_OAUTH_TOKEN`. "This token authenticates with your Claude subscription and requires a Pro, Max, Team, or Enterprise plan. It can only make model requests." ([Generate a long-lived token](https://code.claude.com/docs/en/authentication#generate-a-long-lived-token))
- **Credential lifetime**: an interactive `/login` credential expires (Claude Code warns 3 days out: "Your login expires in 3 days · run /login to renew"; "A background session ... that outlives the login stops making progress once the credential expires"). For an unattended container the 1-year `setup-token` is the robust option; a mounted `/login` credential will periodically need a re-login. ([Renew an expiring login](https://code.claude.com/docs/en/authentication#renew-an-expiring-login))
- **Auth precedence** (when several are present): cloud provider vars → `ANTHROPIC_AUTH_TOKEN` → `ANTHROPIC_API_KEY` → `apiKeyHelper` → `CLAUDE_CODE_OAUTH_TOKEN` → Anthropic profiles → subscription OAuth from `/login`. Make sure the container doesn't leak a stray `ANTHROPIC_API_KEY` if subscription auth is intended. ([Authentication precedence](https://code.claude.com/docs/en/authentication#authentication-precedence))

### opencode

Primary sources: [opencode CLI docs](https://opencode.ai/docs/cli/), [providers docs](https://opencode.ai/docs/providers/), [troubleshooting docs](https://opencode.ai/docs/troubleshooting/).

- **Storage**: `opencode auth login` stores credentials ("API keys, OAuth tokens") in **`~/.local/share/opencode/auth.json`**; logs at `~/.local/share/opencode/log/`, config at `~/.config/opencode/opencode.json(c)`. Mounting `~/.local/share/opencode` (plus `~/.config/opencode` for config) as a volume persists auth across restarts (**inference from documented file locations**). ([CLI docs](https://opencode.ai/docs/cli/), [troubleshooting](https://opencode.ai/docs/troubleshooting/))
- **Login flow**: `opencode auth login` is an interactive provider picker (paste API key, or browser OAuth for supported subscriptions) — run once via `docker exec -it`. `opencode auth list` shows configured providers. ([CLI docs](https://opencode.ai/docs/cli/))
- **Claude subscription: not available.** The providers docs state opencode previously bundled Claude Pro/Max support and **removed it in v1.3.0** because "Anthropic explicitly prohibits this"; they point instead to subscriptions that allow third-party tooling: "ChatGPT Plus, Github Copilot, Gitlab Duo". Anthropic API keys still work as a normal provider. ([providers docs](https://opencode.ai/docs/providers/))

## 3. Terms-of-service and practical constraints

Primary source: [Claude Code — Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) (the "Authentication and credential use" policy lives here; usage is also governed by the [Consumer Terms](https://www.anthropic.com/legal/consumer-terms), [Commercial Terms](https://www.anthropic.com/legal/commercial-terms), and [Usage Policy](https://www.anthropic.com/legal/aup)).

What the policy says, near-verbatim:

1. **OAuth is subscription-only and Claude-Code-only**: "OAuth authentication is intended exclusively for purchasers of Claude Free, Pro, Max, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications."
2. **Third-party harnesses must use API keys**: "Developers building products or services that interact with Claude's capabilities, **including those using the Agent SDK**, should use API key authentication... Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow."
3. **The carve-out that matters for agent-rocky-reviewer** — "Can customers offer Claude Code in their products?": "preinstalling or running Claude Code in your products or services (e.g. in hosted sandboxes or other agent infrastructure)" is allowed under the Commercial Terms **provided**: (a) "The Claude Code binary must not be modified" and no built-in auth method may be removed/disabled; (b) "Customers may not pay for, resell, or intermediate Claude usage on their end users' behalf. Each end user must authenticate with their own Anthropic API key, Claude subscription plan credentials, or 3P inference provider credential... billed directly to the end user." And explicitly: the credential rules do not "prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code as described [above]."
4. **Usage-limit assumption**: "Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and the Agent SDK." Heavy automated fan-out is outside that assumption.
5. **Enforcement**: "Anthropic reserves the right to take measures to enforce these restrictions and may do so without prior notice."

**Subscription auth in CI/automation of Claude Code itself is officially blessed**: the [GitHub Actions docs](https://code.claude.com/docs/en/github-actions) document storing `CLAUDE_CODE_OAUTH_TOKEN` ("an OAuth token that authenticates with your Claude subscription, available on Pro, Max, Team, and Enterprise plans. Generate one by running `claude setup-token`") as a repo secret to run the Claude Code action; "If you authenticate with an OAuth token, runs use your Claude subscription instead of API billing." They note an OAuth token "is tied to the subscription of the person who ran `claude setup-token`" and recommend API keys for org-shared secrets.

**Application to agent-rocky-reviewer** (interpretation, flagged as such):

- Spawning the **unmodified official `claude` binary**, where **the deploying user logs in with their own subscription through Anthropic's own flow** (interactive login inside the container, or a `setup-token` the user generated themselves and put in their own env), matches the documented allowed pattern (§3.3 above + the GitHub Actions CI pattern). The product must not proxy, extract, or re-serve tokens, must not bundle a shared credential, and must not resell usage.
- Where it gets gray: a *multi-tenant hosted* version where our service holds many users' tokens would look like "intermediating credentials on behalf of users" — prohibited. A **self-hosted, single-user container** (user's own infra, user's own token) is the defensible shape. The legal page says to [contact sales](https://www.anthropic.com/contact-sales) "for questions about permitted authentication methods for your use case."
- **opencode + Claude subscription is categorically out**: opencode removed it ([providers docs](https://opencode.ai/docs/providers/)); secondary reporting says Anthropic added server-side enforcement rejecting consumer OAuth outside Claude Code/claude.ai (Jan–Feb 2026) — see [The Register, "Anthropic clarifies ban on third-party tool access to Claude" (2026-02-20)](https://www.theregister.com/2026/02/20/anthropic_clarifies_ban_third_party_claude_access/) and [alternativeto.net coverage](https://alternativeto.net/news/2026/2/anthropic-officially-bans-using-subscription-authentication-for-third-party-tools) (**secondary sources**; the primary policy text is the legal page above).

**Rate limits under subscription** (primary: [What is the Max plan? — support.claude.com](https://support.claude.com/en/articles/11049741-what-is-the-max-plan)): usage is session-based — "Your session-based usage limit will reset every five hours" — plus a weekly cap that "resets at a fixed time each week"; Max 5x/20x are multiples of Pro's per-session allowance; Claude and Claude Code **share the same usage pool**; and Anthropic "may limit your usage in other ways, such as weekly and monthly caps... at our discretion." No documented cap on *concurrent* CLI processes exists (**absence claim**) — parallel runs simply drain the shared 5-hour/weekly budget faster, and Anthropic's cost guidance recommends "concurrency controls to limit parallel runs" ([GitHub Actions docs](https://code.claude.com/docs/en/github-actions#manage-costs)).

## 4. Resource profile

### Claude Code

- **Distribution**: the npm package `@anthropic-ai/claude-code` (v2.1.245) is a ~179 KB launcher with **no runtime dependencies**; the real binary comes via platform optional dependencies incl. `@anthropic-ai/claude-code-linux-x64`, `-linux-arm64`, and **musl variants** (`-linux-x64-musl`, `-linux-arm64-musl`) ([npm registry metadata](https://registry.npmjs.org/@anthropic-ai/claude-code/latest)). The Linux x64 binary package is **391,949,178 bytes (~374 MiB) unpacked** ([npm registry](https://registry.npmjs.org/@anthropic-ai/claude-code-linux-x64/latest)).
- **Runtime requirements**: the npm route declares `node >= 22` for install, but "the installed `claude` binary does not itself invoke Node" — it's a native binary; the native installer (`curl -fsSL https://claude.ai/install.sh | bash`) and signed **apt/dnf/apk repositories** avoid Node entirely. Alpine/musl needs `bash curl libgcc libstdc++ ripgrep` plus `USE_BUILTIN_RIPGREP=0`. ([setup docs](https://code.claude.com/docs/en/setup))
- **Hardware floor**: "4 GB+ RAM, x64 or ARM64", Ubuntu 20.04+/Debian 10+/Alpine 3.19+ ([system requirements](https://code.claude.com/docs/en/setup#system-requirements)). Per-process memory under load is **not documented** (unverified).
- **Auto-update in containers**: native installs "automatically update in the background"; for reproducible images set `DISABLE_AUTOUPDATER=1` (or `DISABLE_UPDATES`) in settings env ([setup docs](https://code.claude.com/docs/en/setup#disable-auto-updates)).

### opencode

- **Distribution**: npm `opencode-ai` (v1.18.23) is an ~8 KB wrapper; platform binaries via optional deps (`opencode-linux-x64`, `-arm64`, musl and baseline variants). `opencode-linux-x64` is **184,584,458 bytes (~176 MiB) unpacked** ([npm registry](https://registry.npmjs.org/opencode-linux-x64/latest)). Also installable via `curl -fsSL https://opencode.ai/install | bash` as a **single binary** (repo shows a Bun-based build) — no separate Node/Bun runtime required ([github.com/anomalyco/opencode](https://github.com/anomalyco/opencode); note: the project now lives under the **anomalyco** org — `github.com/sst/opencode` resolves there). MIT licensed ([repo](https://github.com/anomalyco/opencode)).
- **Memory footprint**: not documented (**unverified**).

**Image-size takeaway**: bundling both CLIs adds roughly **550–600 MB** to the image (374 + 176 MiB unpacked binaries) on top of the Node base image for the NestJS service. Claude Code publishes musl builds and an apk repo, so an Alpine base is viable for both.

## 5. OpenAI-compatible API path (comparison baseline)

- **OpenAI SDK configurable base URL**: the official `openai-node` client constructor accepts a `baseURL` option (e.g. `new OpenAI({ apiKey, baseURL: 'https://mtls.api.openai.com/v1', ... })` in the README's own example) ([openai-node README](https://github.com/openai/openai-node/blob/master/README.md)).
- **Ollama** exposes OpenAI-compatible endpoints — `/v1/chat/completions`, `/v1/completions`, `/v1/models`, `/v1/embeddings`, `/v1/responses` — and documents using the OpenAI JS SDK with `baseURL: "http://localhost:11434/v1/", apiKey: "ollama"` (key "required but ignored") ([Ollama OpenAI compatibility docs](https://docs.ollama.com/api/openai-compatibility), also [in-repo](https://github.com/ollama/ollama/blob/main/docs/api/openai-compatibility.mdx)).
- **OpenRouter** is a documented drop-in for the OpenAI SDK: `new OpenAI({ baseURL: 'https://openrouter.ai/api/v1', apiKey: '<OPENROUTER_API_KEY>' })`, full `chat.completions.create()` compatibility ([OpenRouter quickstart](https://openrouter.ai/docs/quickstart)).

So a plain chat-completions reviewer backend with one configurable `baseURL` covers OpenAI, Ollama, OpenRouter, and any other OpenAI-compatible server — the simplest, ToS-cleanest fallback when a user has no Claude subscription.

## Design implications for the NestJS child-process spawner

**Claude Code adapter (subscription-auth mode):**

- **Spawn**: `claude -p "<prompt>" --output-format stream-json --verbose --include-partial-messages --max-turns <N> --allowedTools "<explicit list>"` (or `--permission-mode dontAsk` for read-only review runs). Parse NDJSON per line; treat the final `result` event as the run outcome; surface `system/api_retry` (`rate_limit`, `overloaded`, `billing_error`) in run status. For schema-shaped review output use `--output-format json --json-schema` and read `structured_output`. ([headless docs](https://code.claude.com/docs/en/headless))
- **Do NOT pass `--bare`** — it disables OAuth/`CLAUDE_CODE_OAUTH_TOKEN` reading ([headless docs](https://code.claude.com/docs/en/headless#start-faster-with-bare-mode)). Instead control context by running in a clean review workdir; consider `--no-session-persistence` if resume isn't needed.
- **Kill/timeout**: no CLI timeout flag exists → enforce wall-clock timeout in the spawner. Escalation: **SIGINT** (ends the turn cleanly) → grace period → **SIGTERM** (expect exit 143; Claude Code kills its own Bash process tree and runs SessionEnd hooks) → SIGKILL as last resort. Treat exit 0 = success, 143 = killed, other non-zero = failure; also check stdout `result` for in-run failures like missing auth. ([headless docs](https://code.claude.com/docs/en/headless#stop-a-run-with-sigterm))
- **Volumes/env**: run as a fixed non-root user; set `CLAUDE_CONFIG_DIR=/data/claude` and mount `/data` as a named volume (credentials at `<dir>/.credentials.json`, mode 0600); also persist `~/.claude.json` (or just mount the whole home). Set `DISABLE_AUTOUPDATER=1` for image reproducibility. Ensure no stray `ANTHROPIC_API_KEY` in the container env (it outranks subscription auth). ([authentication docs](https://code.claude.com/docs/en/authentication), [setup docs](https://code.claude.com/docs/en/setup))
- **Login UX** (two supported options, both completing through Anthropic's own flow):
  1. One-time `docker exec -it rocky claude` → user opens the printed URL in their host browser → pastes the code back (documented container path). Credential persists on the volume but **expires periodically** → surface `claude auth status` (exit 0/1, JSON) as a health check and prompt re-login.
  2. User runs `claude setup-token` on their own machine (1-year subscription token) and sets `CLAUDE_CODE_OAUTH_TOKEN` in the container env — mirrors Anthropic's documented CI pattern. ([authentication docs](https://code.claude.com/docs/en/authentication#generate-a-long-lived-token))
- **ToS guardrails to bake in**: never read/copy/proxy `.credentials.json` or tokens; ship the unmodified official binary via the signed apt/apk repo or npm; single-user/self-hosted deployment model; document that usage draws on the user's shared 5-hour/weekly subscription pool and that "advertised usage limits assume ordinary, individual usage". Concurrency cap 2 is compatible (no per-process cap exists; limits are usage-based). ([legal & compliance](https://code.claude.com/docs/en/legal-and-compliance), [Max plan article](https://support.claude.com/en/articles/11049741-what-is-the-max-plan))

**opencode adapter:**

- Only offer it with **API-key providers** (Anthropic API key, OpenRouter, Ollama, etc.) or opencode's supported non-Anthropic subscriptions (ChatGPT Plus, Copilot, GitLab Duo) — never advertise Claude Pro/Max through opencode. ([providers docs](https://opencode.ai/docs/providers/))
- Spawn: `opencode run --model <provider/model> --format json --print-logs [--auto] "<prompt>"`; treat the `json` format as an event stream. Exit codes undocumented → rely on stream contents + non-zero exit as failure heuristic. Mount `~/.local/share/opencode` (auth.json, logs) and `~/.config/opencode` (config) as volumes; one-time `docker exec -it rocky opencode auth login`. ([CLI docs](https://opencode.ai/docs/cli/))
- Alternative seam: keep one long-lived `opencode serve` in the container and drive review runs over its OpenAPI 3.1 REST API (per-session cancel instead of process kill). ([server docs](https://opencode.ai/docs/server/))

**Fallback adapter**: OpenAI SDK with configurable `baseURL` (§5) — zero binary weight, no ToS ambiguity, covers Ollama/OpenRouter/custom backends.

---

### Source index

- Claude Code headless: https://code.claude.com/docs/en/headless
- Claude Code CLI reference: https://code.claude.com/docs/en/cli-reference
- Claude Code authentication & credential storage: https://code.claude.com/docs/en/authentication
- Claude Code legal & compliance (auth/credential policy): https://code.claude.com/docs/en/legal-and-compliance
- Claude Code GitHub Actions (subscription token in CI): https://code.claude.com/docs/en/github-actions
- Claude Code setup (system reqs, installers, Alpine, npm): https://code.claude.com/docs/en/setup
- Max plan usage limits: https://support.claude.com/en/articles/11049741-what-is-the-max-plan
- opencode CLI (run/auth): https://opencode.ai/docs/cli/ · providers: https://opencode.ai/docs/providers/ · server: https://opencode.ai/docs/server/ · troubleshooting (paths): https://opencode.ai/docs/troubleshooting/
- opencode repo (org: anomalyco, ex-sst): https://github.com/anomalyco/opencode
- npm registry: https://registry.npmjs.org/@anthropic-ai/claude-code/latest · https://registry.npmjs.org/@anthropic-ai/claude-code-linux-x64/latest · https://registry.npmjs.org/opencode-ai/latest · https://registry.npmjs.org/opencode-linux-x64/latest
- OpenAI SDK baseURL: https://github.com/openai/openai-node/blob/master/README.md
- Ollama OpenAI compatibility: https://docs.ollama.com/api/openai-compatibility
- OpenRouter quickstart: https://openrouter.ai/docs/quickstart
- Secondary (enforcement timeline only): https://www.theregister.com/2026/02/20/anthropic_clarifies_ban_third_party_claude_access/
