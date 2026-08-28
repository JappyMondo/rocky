# Sandcastle capability audit: where Sandcastle stops and Rocky must build

Research for NG-568 (wayfinder). Researched 2026-08-28.

**Primary source**: the Sandcastle source code, read at commit
`e99f832f26dc9d245c019a9ddd19fa5dee792427` (`main`, "Merge pull request #832 from
mattpocock/changeset-release/main", 2026-06-29) — the tip of
<https://github.com/mattpocock/sandcastle> as of this audit
(`git ls-remote origin main` confirms). Published as `@ai-hero/sandcastle@0.12.0`.
Secondary primary sources: the in-repo ADRs under `docs/adr/`, the GitHub issue
tracker, and the npm registry. **The README was deliberately not used.** Every
claim below cites a file path and symbol; absence claims are marked and were
verified by exhaustive grep over `src/`.

## Question

Sandcastle is a pinned hard dependency wrapped behind Rocky's own `ctx` object
(`ctx.agent()` / `ctx.exec()` / `ctx.checkpoint()`, with `ctx.sandbox` as the
documented escape hatch). Where exactly is the seam between "Sandcastle does
this" and "Rocky must build this"?

## TL;DR / Answer

The shallow read was accurate about the API surface — `run()`, `createSandbox()`,
`createWorktree()`, `interactive()`, three branch strategies, `Output.object()`
with retries, `resume()` / `fork()`, streaming hooks, six harnesses all exist as
described. It was wrong about the *shape* of that surface in four ways that
matter:

1. **Sandcastle is a CLI-shaped library, not a daemon-shaped one.** Every
   sandbox registers a synchronous `docker rm -f` on `process.on("exit")`
   (`src/shutdownRegistry.ts` `registerShutdown`, `src/sandboxes/docker.ts`
   `removeContainerSync`), the container name is never exposed on any handle,
   and there is no reattach API. A `Sandbox` handle cannot survive a daemon
   restart — but the **git worktree can and does** (`src/createWorktree.ts`
   `createWorktree` registers no shutdown hook). The durable unit for a
   suspended Rocky Run is (repo, branch, sessionId), not a `Sandbox`.
2. **`Output.object()` does not exist on the warm path.** It is a `run()`-only
   option (`src/run.ts` `RunOptions.output`); `SandboxRunOptions` and
   `WorktreeRunOptions` have no `output` field, and `extractStructuredOutput` is
   not exported from `src/index.ts`. Rocky's capped review loop inside one warm
   sandbox must do its own tag extraction.
3. **Concurrent Runs against the same repo are actively unsafe today**, not
   merely unguarded. `pruneStale()` runs on *every* `createSandbox()` /
   `createWorktree()` and recursively deletes worktree directories git no longer
   considers active (`src/WorktreeManager.ts` `pruneStale`); the designed
   mitigation (ADR 0007 worktree locking) is **not implemented** in 0.12.0.
   Issue #849 documents siblings mutually annihilating.
4. **There is zero MCP surface** — `grep -ri mcp src/` returns exactly one
   comment in `src/run.ts`. Rocky owns 100% of per-Agent MCP config.

The wrapped-`ctx` decision survives all of this. Nothing in Sandcastle leaks a
type Rocky cannot hide, and `ctx.sandbox` covers the escape hatch. See
[§11](#11-what-would-make-the-wrapped-ctx-decision-wrong) for the two things
that come closest to invalidating it.

---

## 1. Long-lived Runs: can a sandbox and worktree survive a Checkpoint?

**The worktree survives; the container must be treated as disposable.**

What `createSandbox()` actually holds open (`src/createSandbox.ts`
`createSandbox`, lines ~904-1136):

| Resource | Where | Survives host process exit? |
| --- | --- | --- |
| Git worktree at `<repo>/.sandcastle/worktrees/<branch-with-slashes-as-dashes>` | Host disk, via `git worktree add` (`src/WorktreeManager.ts` `create`) | **Yes** — plain on-disk git state |
| Detached container `sandcastle-<uuid>` | `docker run -d ... <image>` (`src/DockerLifecycle.ts` `startContainer`) | **No** — see below |
| `Sandbox` handle (closures over `containerName`, `worktreePath`, `SandboxService`) | Node heap (`src/createSandbox.ts` `buildSandboxHandle`) | **No** — in-memory only |
| Child processes | One `docker exec` per `exec`/`run` call, spawned and reaped per call (`src/sandboxes/docker.ts` `exec`) | n/a — nothing held between calls |
| Temp files | Only transiently, inside session capture (`src/AgentProvider.ts` `readSandboxFile`/`writeSandboxFile` write to `os.tmpdir()` and `rm` in a `finally`) | n/a |
| Signal listeners | One shared set of `exit`/`SIGINT`/`SIGTERM` handlers (`src/shutdownRegistry.ts` `attachListeners`) | n/a |

The container is nominally long-lived: the scaffolded images use
`ENTRYPOINT ["sleep", "infinity"]` (`src/InitService.ts`
`CLAUDE_CODE_DOCKERFILE`, line 239, and the five sibling Dockerfile constants),
so the container is an idle host and every run is a `docker exec`. There is no
TTL, no idle reaper, no auto-stop for `docker()`/`podman()`. Left alone, it will
sit for days.

But it is bound to the *host process* lifetime, not the Run lifetime:
`src/sandboxes/docker.ts` registers

```ts
const removeContainerSync = () => {
  try { execFileSync("docker", ["rm", "-f", containerName], { stdio: "ignore" }); } catch {}
};
const unregisterShutdown = registerShutdown(removeContainerSync);
```

and `src/shutdownRegistry.ts` `handleExit` fans that out on a plain
`process.on("exit")`. A graceful Rocky daemon restart therefore **force-removes
every live container**. A `SIGKILL`ed daemon leaves them running — and
unreachable, because `containerName` is a closure variable that appears on no
public type (`BindMountSandboxHandle` in `src/SandboxProvider.ts` exposes only
`worktreePath`, `exec`, `interactiveExec`, `copyFileIn`, `copyFileOut`,
`close`). That is a container leak Rocky must reap itself; the
`sandcastle-<uuid>` name prefix is the only affordance.

`Sandbox.close()` is also not a plain teardown: it preserves the worktree when
dirty and removes it when clean (`src/createSandbox.ts` `doClose` →
`WorktreeManager.hasUncommittedChanges`), returning
`CloseResult.preservedWorktreePath`. Preserved worktrees are never reclaimed and
there is no opt-out (issue #931).

**The seam Sandcastle does give Rocky** is `createWorktree()`
(`src/createWorktree.ts` `createWorktree` → `Worktree`): the worktree is created
once and outlives any number of sandboxes, and `Worktree` exposes
`run()`, `interactive()`, `createSandbox()`, `close()`. It registers no shutdown
hook, so the worktree is durable. Combined with ADR 0003 worktree reuse
(`WorktreeManager.create` returns the existing managed worktree when the branch
collides, fast-forwarding from `origin/<branch>` when clean and strictly
behind), Rocky can *reconstruct* a handle after a restart by calling
`createWorktree({ branchStrategy: { type: "branch", branch } })` with the same
branch name.

**So: Rocky must tear down and reconstruct the sandbox, but not the worktree.**
Checkpoint state to persist is `(hostRepoDir, branch, lastSessionId)`. The
reconstruct cost is container boot + `onSandboxReady` hooks.

> **Domain-model conflict worth resolving before this is built.** Rocky's
> `CONTEXT.md` currently defines **Review run** as explicitly non-resumable:
> "A run interrupted by a service restart returns to `queued` and re-runs from
> scratch against the current head; **runs are never resumed mid-flight**."
> The glossary has no `Checkpoint`, no `Workflow`, and no `Sandcastle` term at
> all. So the ticket's premise — a Run that suspends at a Checkpoint for hours
> or days — is a newer direction that contradicts the recorded model. The
> finding above happens to *favour* the recorded model (restart-from-scratch is
> exactly what Sandcastle's process-bound sandbox lifetime makes cheap and
> safe), so this is a decision to take deliberately rather than a gap to
> engineer around: either Checkpoints enter the glossary with resume semantics
> and Rocky builds the reconstruction subsystem in §1, or Review runs stay
> restart-from-scratch and `ctx.checkpoint()` means something narrower (a
> resumable *agent session* within one live process, which Sandcastle does give
> us — see §2).

## 2. Resume semantics

### How capture and resume actually work

Per ADR 0012, each agent provider owns its session storage
(`AgentSessionStorage` in `src/AgentProvider.ts`: `captureToHost`,
`resumeIntoSandbox`, `readHostSession`, `existsOnHost`, `hostSessionFilePath`,
`findByIdOnHost`). The orchestrator's capture gate is (`src/Orchestrator.ts`,
in `orchestrate`):

```ts
if (provider.captureSessions && provider.sessionStorage && sessionId && bindMountHandle)
```

All four conditions must hold. `bindMountHandle` is only non-`undefined` when
`options.sandbox.tag === "bind-mount"` (`src/createSandbox.ts`, the
`bindMountHandle` narrowing) — so **capture never runs for `noSandbox()`,
`vercel()`, or `daytona()`**.

Capture is a JSONL copy with a `cwd` rewrite: `captureToHost` reads
`<sandboxProjectsDir>/<encoded-sandbox-cwd>/<id>.jsonl` out via
`copyFileOut`, rewrites every `cwd` field sandbox→host (`src/SessionStore.ts`
`transferClaudeSession`, `encodeProjectPath`), and writes it to
`~/.claude/projects/<encoded-host-repo-dir>/<id>.jsonl`
(`claudeHostSessionPath`). `resumeIntoSandbox` does the inverse. Claude subagent
/ workflow transcripts under `<sessionId>/subagents/` are captured best-effort
(`listClaudeSubagentSessionsInSandbox`; individual failures log and continue,
main-session failure is fatal).

**Per harness** (`src/AgentProvider.ts`):

| Harness | `captureSessions` | `sessionStorage` | `parseSessionUsage` | Resume / fork |
| --- | --- | --- | --- | --- |
| `claudeCode` | `true` (default) | yes | **yes** (only provider) | `--resume <id>` + `--fork-session` |
| `codex` | `true` (default) | yes | no (usage from stream) | `codex exec ... fork` |
| `pi` | `true` (default) | yes | no (issue #863) | `pi --session <id>` |
| `cursor` | `false` | none | no | none |
| **`opencode`** | **`false`** | **none** | **no** | **none** |
| `copilot` | `false` | none | no | none |

`opencode`'s non-resumability is a **deliberate won't-fix**, not an oversight:
ADR 0016 ("Resume support requires filesystem-backed session storage") closes
issue #566 because opencode's conversation state lives in a private SQLite
schema. Note that opencode *does* surface a session id
(`parseOpenCodeStreamLine` emits `session_id` from `step_start.sessionID`), so
Rocky can log it — but Sandcastle will not resume it and `SandboxRunResult.resume`
is simply absent for that provider (`src/createSandbox.ts`: `resume`/`fork` are
attached only `if (provider.sessionStorage && lastIteration?.sessionId)`).

### The `resumeSession` + `maxIterations > 1` incompatibility

The check is a hard throw at entry, in three places
(`src/run.ts` `run`, `src/createSandbox.ts` `run`, and the same guard in
`createWorktree`):

```ts
throw new Error("resumeSession cannot be combined with maxIterations > 1. " +
  "Resume applies to iteration 1 only; multi-iteration resume semantics are not supported.");
```

ADR 0011 gives the reason: each iteration produces its own session JSONL and its
own id, so "resume X and run 5 iterations" is ambiguous about which session
iteration 2 continues. `resumeSession` is applied to iteration 1 only
(`src/Orchestrator.ts`: `const iterationResumeSession = i === 1 ? options.resumeSession : undefined`).

**What this means for Rocky's capped review loops:** Sandcastle's
`maxIterations` loop and its resume mechanism are mutually exclusive, so a
capped loop that *carries conversation state* cannot be expressed as
`maxIterations: N`. Rocky must own the loop: call `sandbox.run({ maxIterations: 1 })`
once, then chain `result.resume(prompt)` up to the cap, counting iterations
itself and enforcing its own stop condition. This is the documented intent (ADR
0011: "Multi-step workflows are expressed by chaining `.resume()` calls"), and
`.resume()` conveniently re-enters the *same* warm sandbox
(`src/createSandbox.ts`: `resume` calls `sandboxHandle.run({...})`). Sandcastle's
own `maxIterations` loop is then only useful for the stateless
"prompt-again-from-scratch until completion signal" pattern — which is not what
a review loop wants. **`ctx.checkpoint()`-capped loops are Rocky's code, not a
thin wrapper over `maxIterations`.**

### Does resume survive a daemon restart?

**Yes — the session id is persistable, not in-memory.** The captured JSONL is an
ordinary file on the host at a path derived from `(hostRepoDir, sessionId)`, and
`hostRepoDir` (not the worktree path) is the key
(`src/Orchestrator.ts` passes `hostCwd: hostRepoDir` to `captureToHost`;
`claudeHostSessionPath` in `src/SessionStore.ts`). Because the sandbox-side cwd
is always the fixed `SANDBOX_REPO_DIR = "/home/agent/workspace"`
(`src/SandboxFactory.ts`), a *new* container on the *same* branch can resume an
*old* session: the rewrite is symmetric. `assertResumeSessionExists`
(`src/resumePrecheck.ts`) fails fast with the expected path if the file is gone.

Caveats Rocky must handle:
- Only for bind-mount providers. In `noSandbox()` mode nothing is captured;
  the agent writes its session in place and `assertResumeSessionExists`
  branches to `findByIdOnHost(resumeSession)`, a scan by id
  (`src/resumePrecheck.ts`, `sandboxTag === "none"` path). Resume still works,
  but the file lives under the *worktree*-derived encoded path, so it breaks if
  Rocky renames or relocates the worktree.
- `~/.claude/projects/...` is outside Rocky's control. Retention, disk
  pressure, and a user running `claude` cleanup can silently invalidate a
  Checkpoint. Rocky should either copy the JSONL into its own state dir or
  treat resume as best-effort with a re-prompt fallback. (`hostProjectsDir` is
  overridable per provider: `claudeCode(model, { sessionStorage: { hostProjectsDir } })`
  — this is the cleanest lever, and worth using.)
- Issue #942: in 0.12.0 `run().resume()/fork()` spread the original options
  into the re-run and leak `promptArgs` into an inline-prompt call, throwing
  `PromptError: promptArgs is only supported with promptFile`. The same
  spread pattern is in `src/createSandbox.ts` `resume` (`{...runOptions, ...resumeOptions, prompt: nextPrompt}`),
  so Rocky should pass `promptArgs: undefined` explicitly on resume.

## 3. `noSandbox()` on the host: what it does and does not isolate

`src/sandboxes/no-sandbox.ts` `noSandbox` is 171 lines and isolates **nothing**:

- `exec` is `spawn("sh", ["-c", command], { cwd, env: processEnv })` where
  `processEnv = { ...process.env, ...createOptions.env }` — the agent inherits
  the daemon's **entire** environment, including secrets Rocky never intended to
  share.
- `close()` is an explicit no-op ("No-op — no container to tear down").
- `sudo` is silently ignored ("sudo is a no-op for no-sandbox — the user is
  already on the host").
- No uid change, no filesystem confinement, no network policy, no resource
  limits. The `cwd` default is the worktree path, but nothing prevents the agent
  from writing anywhere the daemon user can write.

**Worse than the docstring admits.** The file header claims: "Does not pass
`--dangerously-skip-permissions` to the agent — the user manages permissions
themselves." That is true for `interactive()` (`src/interactive.ts` line 398:
`dangerouslySkipPermissions: sandboxProvider.tag !== "none"`) and for
`createWorktree`'s interactive path (`src/createWorktree.ts` line 434, same
guard), but **false for every AFK run**: `src/Orchestrator.ts` line 143 passes
`dangerouslySkipPermissions: true` unconditionally, and `src/createSandbox.ts`
line 631 (the `Sandbox.interactive()` path) hardcodes `true` as well. So
`run({ sandbox: noSandbox() })` runs `claude --dangerously-skip-permissions` as
the daemon user with the daemon's full env.

The only lever is provider-level: `claudeCode(model, { permissionMode })` takes
precedence over the bypass flag (`src/AgentProvider.ts` `claudeCode.buildPrintCommand`:
`options?.permissionMode ? " --permission-mode ..." : dangerouslySkipPermissions ? " --dangerously-skip-permissions" : ""`).
`permissionMode: "auto"` is the documented AFK-on-host option (CHANGELOG 0.8.0).
**If Rocky ever offers host mode, `permissionMode` must be non-optional in the
Rocky config surface.**

### How it locates worktrees

Identically to the container providers — `noSandbox()` is a provider, not a
different code path for worktrees. `WorktreeManager.create` puts every worktree
at `<hostRepoDir>/.sandcastle/worktrees/<name>`, hard-coded
(issue #530 asks for configurability; open PR #961 proposes a `stateDir`
option). Two special cases:

- **`head` strategy + `noSandbox()`**: no worktree at all. `src/SandboxFactory.ts`
  `WorktreeDockerSandboxFactory` short-circuits (`if (sandboxProvider.tag === "none")`
  then `if (isHeadMode)`) and passes `hostRepoDir` directly as both
  `hostWorktreePath` and `sandboxRepoPath`. **The agent works in the user's real
  checkout.** `head` is the *default* for non-isolated providers
  (`src/run.ts`: `options.branchStrategy ?? (isolated ? merge-to-head : { type: "head" })`).
- `branch` / `merge-to-head` + `noSandbox()`: normal worktree under
  `.sandcastle/worktrees/`.

### Concurrent Runs on the same repo

This is the sharpest edge in the whole audit. Four distinct hazards:

1. **`pruneStale()` deletes live siblings.** Every `createSandbox()` and
   `createWorktree()` call begins with `WorktreeManager.pruneStale(hostRepoDir)`
   (`src/createSandbox.ts`, `src/createWorktree.ts`, and `pruneAndCreate` in
   `src/SandboxFactory.ts`). `pruneStale` runs `git worktree prune` and then
   `fs.remove(entryPath, { recursive: true, force: true })` for every directory
   under `.sandcastle/worktrees/` that git does not list as active. Issue #849
   ("Concurrent branch-strategy worktrees delete each other") documents the full
   mechanism: in-container git repairs the *shared* admin `gitdir` back-pointer
   to `/home/agent/workspace/.git`, which is invalid on the host, so the next
   sibling's `git worktree prune` deletes a **still-running** worktree's admin
   dir. Related: issue #642 (the pre-flight collision check is repo-global, not
   `repoDir`-scoped), issue #854, issue #855.
2. **Same-branch collisions silently share a directory.** `WorktreeManager.create`
   reuses a colliding managed worktree — `console.warn` if dirty,
   `fastForwardFromOrigin` if clean — and returns the same path to both callers
   (ADR 0003). ADR 0007 designed a PID-based lock file at
   `.sandcastle/locks/<name>.lock` to close exactly this hole. **It is not
   implemented**: `grep -rn "\.sandcastle/locks" src/` returns nothing; the only
   hits in the repo are inside the ADR itself. So the stated mitigation for the
   stated risk does not exist in 0.12.0.
3. **`~/.gitconfig.lock` contention.** `withSandboxLifecycle` runs
   `git config --global user.name/user.email` to propagate host git identity
   (`src/SandboxLifecycle.ts`, lines ~237-260). Under `noSandbox()` that writes
   the *host's real* `~/.gitconfig`, and concurrent Runs contend (issues #917
   and #919, exit 255). Sandcastle already mitigates a narrower case — the
   `NO_CONFIG_LOCK_FLAGS` (`-c branch.autoSetupMerge=false -c push.autoSetupRemote=false`)
   in `src/WorktreeManager.ts` exist specifically to avoid a `.git/config.lock`
   race — but the global-config write is unguarded.
4. `head` strategy under any concurrency means two agents in one working tree.

**Rocky must serialise or lock Runs per repo itself.** A per-repo mutex in the
daemon plus a distinct branch per Run (never `head`, never the same branch
twice) is the minimum. Note that even a distinct branch does not fully protect
against hazard 1, which is triggered by the shared `.git` plus prune, not by
branch collision.

## 4. Structured output

`Output.object({ tag, schema, maxRetries })` and `Output.string({ tag, maxRetries })`
live in `src/Output.ts`; extraction in `src/extractStructuredOutput.ts`.

**How it extracts.** It is *not* a harness-native JSON-schema mode. It is XML-tag
scraping of the agent's text output: `findLastTagContent(stdout, tag)` takes the
**last** `<tag>...</tag>` pair, `unwrapFences` strips an optional
```` ```json ```` fence, `JSON.parse`, then Standard Schema validation via
`definition.schema["~standard"].validate(parsed)`. `Output.string` trims and
returns; no parse, no validation.

The input `stdout` is the orchestrator's `agentOutput`, which is
`resultText || execResult.stdout` (`src/Orchestrator.ts` `invokeAgent`), where
`resultText` is the **last** `result` stream event. For `claudeCode` that is the
terminal `{ type: "result" }` message — so the tag must appear in the agent's
*final* message, not merely somewhere in the transcript. For `opencode`,
`parseOpenCodeStreamLine` emits a `result` event for **every** text part, so
"last result wins" means the tag must be in the last text part the agent emits.
This is a real per-harness behavioural difference Rocky's prompts must respect.

Two entry-time guards (`src/run.ts` `run`): `maxIterations` must be `1`, and the
resolved prompt must literally contain `<tag>` ("The caller must instruct the
agent to emit the configured tag").

**What invalid output costs.**

- With `maxRetries: 0` (the default): a **throw** — `StructuredOutputError`
  (`src/Output.ts`), which usefully carries `commits`, `branch`,
  `preservedWorktreePath`, `sessionId`, and `sessionFilePath` so the caller can
  recover without losing the Run's side effects. Zero extra tokens.
- With `maxRetries > 0`: `run()` recurses with
  `buildStructuredOutputRetryFeedback(error, retriesRemaining)`
  (`src/run.ts`) — a short prompt quoting the error, the parser detail, and the
  previous matched output, ending "Emit only a corrected `<tag>` block. Do not
  change files or run commands." It resumes the failed session
  (`resumeSession: error.sessionId`) so the agent keeps its context. Cost:
  one extra agent turn per retry over a *warm* session, plus — and this is the
  part to budget for — **a full new sandbox and worktree per retry**, because
  the recursion goes through the top-level `run()`, which creates its own
  worktree and container. Retries are validated at entry:
  `maxRetries > 0 && !provider.sessionStorage` throws
  "requires an agent provider that supports session resumption ... Use
  claudeCode, codex, or pi".

**Does it work on every harness Rocky cares about?**

| | Claude Code | opencode |
| --- | --- | --- |
| `Output.object` extraction + validation | yes | yes (tag scraping is harness-agnostic) |
| `maxRetries > 0` | yes | **no — throws at entry** (`!provider.sessionStorage`) |
| Tag must be in the final message | terminal `result` event | last text part |

**The bigger gap: `Output` is not available on the warm path at all.**
`RunOptions.output` exists only on `src/run.ts`; `SandboxRunOptions`
(`src/createSandbox.ts`) and `WorktreeRunOptions` (`src/createWorktree.ts`) have
no `output` field — verified by grep. `extractStructuredOutput` is not exported
from `src/index.ts` (only `Output` and `StructuredOutputError` are). So a Rocky
review loop that lives inside one `createSandbox()` gets **no** structured
output, no validation, and no retry from Sandcastle: it must scrape
`SandboxRunResult.stdout` itself. That is ~40 lines Rocky owns
(`findLastTagContent` + fence unwrap + Zod parse + a retry-via-`.resume()`
loop), and it is the more valuable version anyway, because Rocky's retry can
stay in the warm sandbox instead of paying a container boot.

Minor supply-chain note: `src/Output.ts` imports
`import type { StandardSchemaV1 } from "@standard-schema/spec"`, which is
**not declared** in `package.json` (checked: absent from `dependencies`,
`devDependencies`, and `peerDependencies`). It resolves transitively via `zod`.
Issue #864. Rocky should declare `@standard-schema/spec` directly or its build
will break on a dependency-tree change.

## 5. Streaming and usage

### What `onAgentStreamEvent` emits

`AgentStreamEvent` (`src/AgentStreamEmitter.ts`) has exactly three variants:

```ts
| { type: "text";     message: string; iteration: number; timestamp: Date }
| { type: "toolCall"; name: string; formattedArgs: string; iteration: number; timestamp: Date }
| { type: "raw";      line: string;   iteration: number; timestamp: Date }
```

Wiring constraints, all load-bearing for a live UI:

- **File-logging mode only.** `buildAgentStreamHandler` (`src/run.ts`) reads
  `logging.type === "file" ? logging.onAgentStreamEvent : undefined`. In
  `{ type: "stdout" }` mode the callback is silently ignored. Rocky must always
  pass `logging: { type: "file", path, onAgentStreamEvent }` — which also means
  a log file is always written to `.sandcastle/logs/` by default
  (`buildLogFilename`).
- **Errors are swallowed** — deliberately, in two layers
  (`agentStreamEmitterLayer` and `buildAgentStreamHandler`): "a broken
  forwarder must not kill the run". Rocky gets no signal if its own event sink
  throws.
- `text` events are **debounced/coalesced** through `TextDeltaBuffer`
  (`src/Orchestrator.ts`: `new TextDeltaBuffer((chunk) => ...)`), which exists
  to turn Pi's single-token chunks into readable multi-word lines. Good for a
  log, lossy for a token-by-token UI.
- `toolCall` events are **allowlist-filtered and lossy**. `TOOL_ARG_FIELDS`
  (`src/AgentProvider.ts`) covers only `Bash`, `WebSearch`, `WebFetch`, `Agent`;
  a `tool_use` block for any other tool is `continue`d and **never surfaces as
  a `toolCall` event at all**. Reads, writes, and edits — the events a review UI
  most wants — are dropped for Claude Code. (Cursor's parser special-cases
  `Read`/`Write`; opencode's `OPENCODE_TOOL_ARG_FIELDS` covers `bash`,
  `webfetch`, `task` and falls back to a JSON dump of the whole input, so
  opencode actually surfaces *more* tools than Claude Code.)
- `raw` (added in 0.10.0) is the escape hatch: every stdout line verbatim,
  emitted **before** parsing. For a real live UI, **Rocky should parse `raw`
  itself** and treat `text`/`toolCall` as a convenience. That is the honest
  answer to "the web UI wants to render progress live".

Per-harness stream fidelity differs a lot: `parseStreamJsonLine` (Claude Code)
handles `assistant`/`result`/`system.init`; `parseOpenCodeStreamLine` handles
`step_start`/`text`/`tool_use`/`error`; Cursor, Copilot, Codex, and Pi each have
their own parser. Pi silently drops lowercase `tool_execution_start` events
(issue #910).

### Token / usage reliability

`IterationUsage` (`src/AgentProvider.ts`) is four raw counts: `inputTokens`,
`cacheCreationInputTokens`, `cacheReadInputTokens`, `outputTokens`. Populated
from one of two sources (`src/Orchestrator.ts`): a `usage` stream event
(Codex's `turn.completed`), else `provider.parseSessionUsage(content)` — which
**only `claudeCode` implements** (`src/AgentProvider.ts` `claudeCode.parseSessionUsage`).

Three hard limits for "report cost per Run":

1. **No cost, ever.** No USD figure anywhere in `src/`; ADR 0005
   ("Usage exposes raw token counts, not context window percentage") explains
   that even the context-window size is unavailable and a model→size lookup
   table was rejected as stale-prone. Rocky must own its own price table and
   compute cost from the raw counts.
2. **It is a snapshot, not a total.** `parseSessionUsage` scans the captured
   JSONL backwards and returns the usage of the **last** `assistant` message —
   so `outputTokens` is that one message's output, not the Run's. Summing
   `iterations[].usage` does not give a Run total. (Issue #898 reports the
   related confusion for Codex.) Rocky must either sum the JSONL itself or
   parse `raw` events.
3. **It requires bind-mount + capture.** Usage rides on the same
   `bindMountHandle` gate as session capture, so **`claudeCode()` + `noSandbox()`
   yields `usage: undefined`** — `parseStreamJsonLine` emits no `usage` events,
   and capture never runs. And **`opencode` yields `usage: undefined` in every
   mode** (`captureSessions: false`, no `parseSessionUsage`, no `usage` stream
   event). Rocky's cost-per-Run feature is therefore Claude-Code-in-Docker-only
   unless Rocky parses usage out of `raw` lines itself. Note this was broken
   even on the warm path until 0.11.0 (`bce86dd` fixed `reuseFactoryLayer`
   dropping `bindMountHandle`, leaving `iterations[].usage` permanently
   `undefined` for `createSandbox().run()`).

Also relevant to a supervising daemon: `Docker` and `Podman` `exec` report a
signal-killed process as success (issue #933) — `proc.on("close", code => ... exitCode: code ?? 0)`
in `src/sandboxes/docker.ts` coerces `null` (signal death) to `0`. Rocky cannot
trust `ExecResult.exitCode` to distinguish "clean success" from "OOM-killed".

## 6. Long-running side processes (dev server across `run()` calls)

**Yes, the container supports it; no, Sandcastle gives you no help.**

The mechanics work: the container is `docker run -d` with
`ENTRYPOINT ["sleep","infinity"]` (`src/DockerLifecycle.ts` `startContainer`,
`src/InitService.ts` Dockerfile templates), and every operation is a separate
`docker exec` (`src/sandboxes/docker.ts` `exec`). Nothing in `run()` restarts or
cleans the container between calls — `Sandbox.run()` reuses the same handle via
`reuseFactoryLayer` (`src/createSandbox.ts`). A process started in exec #1 is
still there in exec #5. `Sandbox.exec(command, options?)` was added in 0.12.0
(`0f577a4`) precisely so "harnesses can run shell commands ... directly in the
same warm sandbox between `run()` calls".

Three things Rocky must build:

1. **Detachment discipline.** `exec` resolves on the child's `close` event
   (`src/sandboxes/docker.ts`, `proc.on("close", ...)`), which does not fire
   while any process holds the pipe open. A naive `npm run dev &` hangs the
   exec forever. Rocky must redirect and detach
   (`nohup ... </dev/null >/tmp/dev.log 2>&1 &`). Sandcastle knows this failure
   mode intimately — ADR 0019 and `completionTimeoutSeconds` exist because
   *agents* hang this way when "a spawned child — a `gh`/git subprocess, a
   long-lived MCP server, etc. — keeps the exec's stdout pipe open"
   (`src/run.ts` `RunOptions.completionTimeoutSeconds`). But that mitigation
   applies only to the agent invocation, not to `Sandbox.exec`.
2. **Reachability.** `DockerOptions` (`src/sandboxes/docker.ts`) has
   `imageName`, `containerUid`, `containerGid`, `selinuxLabel`, `mounts`, `env`,
   `network`, `groups`, `devices`, `maxOutputTailChars`, `cpus` — and **no
   `ports`**. `podman()` likewise (grep: no port handling). No handle type
   exposes a container id, IP, or URL. So Rocky cannot publish a dev-server port
   from a Docker sandbox through Sandcastle at all: it must either attach the
   container to a shared Docker network via `network` and discover the address
   itself (e.g. `sandbox.exec("hostname -i")`, since the container name is not
   exposed), or bypass the provider. By contrast `vercel()` does accept
   `ports?: number[]` (`src/sandboxes/vercel.ts` `VercelOptions`) — but the
   `IsolatedSandboxHandle` interface still has no accessor for the resulting
   URL, so it is unusable through Sandcastle's abstraction.
3. **Lifetime supervision.** No health check, no restart, no reaper. If the dev
   server dies, `run()` succeeds anyway.

## 7. MCP

**Sandcastle has no MCP configuration surface whatsoever.** Exhaustive grep over
`src/` for `mcp` (case-insensitive) returns exactly one hit — a comment in
`src/run.ts` line 373 describing a hanging-process cause. Nothing in
`src/templates/`. No `mcpServers` option on any provider, no
`--mcp-config` flag in any `buildPrintCommand` (`src/AgentProvider.ts`), no
`.mcp.json` handling.

So Rocky owns per-Agent MCP config end to end. The available injection points,
best first:

1. **Write the config file into the worktree.** `Sandbox.worktreePath` is public
   (`src/createSandbox.ts` `Sandbox.worktreePath`), so Rocky can write
   `.mcp.json` (or `.claude/settings.json`) into the worktree before the run,
   or use `copyToWorktree: string[]` on `createSandbox()`/`createWorktree()` to
   copy a prepared file in at creation time. Note `copyToWorktree` is rejected
   with the `head` strategy on `run()` ("In head mode the host working
   directory is bind-mounted directly").
2. **`hooks.sandbox.onSandboxReady`** (`SandboxHooks` in
   `src/SandboxLifecycle.ts`) — an array of `{ command, sudo?, timeoutMs? }`
   run inside the sandbox after start. Good for `claude mcp add ...`. Two traps:
   `createSandbox()` **ignores** the per-hook `timeoutMs` (issue #907), and
   `createSandbox()` **ignores non-zero exit codes** from sandbox
   `onSandboxReady` hooks, so failed MCP setup is indistinguishable from success
   (issue #943 — verified in `src/createSandbox.ts`, where the hook loop calls
   `sandbox.exec(...)` without checking `exitCode`, unlike `execOk` in
   `src/SandboxLifecycle.ts`).
3. **Mounts.** `docker({ mounts: [{ hostPath, sandboxPath }] })` with `~`
   expansion against `sandboxHomedir` (`src/mountUtils.ts` `resolveUserMounts`,
   `processFileMountParents`).
4. **Env vars** — but see the `createSandbox()` env bug in §8.

For the UI inspector's browser MCP server specifically, note the compounding
problem: an MCP server that keeps stdout open is the exact scenario
`completionTimeoutSeconds` was invented for (ADR 0019), so Rocky should expect
to tune it (default 60s) rather than accept the default.

## 8. Credentials in host mode

Sandcastle's credential model is **env vars carried in `.sandcastle/.env`**, not
credential-file mounts.

- `resolveEnv(repoDir)` (`src/EnvResolver.ts`) parses
  `<repoDir>/.sandcastle/.env` and then, **only for keys declared in that file**,
  falls back to `process.env[key]`. Precedence: `.sandcastle/.env` >
  `process.env`. Repo-root `.env` is explicitly not in the chain. So for
  container providers, an env var Rocky sets on the daemon reaches the agent
  **only if the key is also listed in `.sandcastle/.env`** — a non-obvious
  coupling that will bite anyone expecting normal env inheritance.
- `mergeProviderEnv` (`src/mergeProviderEnv.ts`) layers
  `resolvedEnv` < `sandboxProviderEnv` < `agentProviderEnv`, and **throws** if
  the agent and sandbox providers declare overlapping keys.
- The scaffolded `.env` contains `CLAUDE_CODE_OAUTH_TOKEN=` with a commented
  `ANTHROPIC_API_KEY=` fallback, plus `GH_TOKEN=` for the GitHub issue tracker
  (`src/InitService.ts`, lines ~418-543); the next-steps copy tells the user to
  run `claude setup-token` on the host (line 650). There is no mounting of
  `~/.claude`, no `gh auth` forwarding, no ssh-agent forwarding anywhere in
  `src/`.

**In host mode (`noSandbox()`) everything simply leaks through, for better and
worse.** `processEnv = { ...process.env, ...createOptions.env }`
(`src/sandboxes/no-sandbox.ts`), and the agent runs as the daemon user in the
daemon's HOME — so `~/.claude/.credentials.json`, `~/.config/gh/hosts.yml`,
`~/.config/glab-cli/`, `~/.gitconfig`, `~/.ssh`, and `SSH_AUTH_SOCK` are all
directly available with no configuration. That is why host mode "just works"
for subscription auth, and also why it is the least contained option: there is
no allowlist, and `.sandcastle/.env` filtering does **not** apply (the filter is
in `resolveEnv`, which only builds the *additional* env; `process.env` is
inherited wholesale regardless).

Two host-mode-specific hazards already noted: git identity is written to the
real `~/.gitconfig` via `git config --global` (`src/SandboxLifecycle.ts`;
issues #917/#919), and AFK runs get `--dangerously-skip-permissions`
unconditionally (§3).

Container mode has no credential story beyond env vars. If Rocky wants
subscription auth in Docker it must mount `~/.claude` via
`docker({ mounts: [...] })` itself, and must additionally work around issue #925
(below) for anything set per-Agent.

**Issue #925 is the one to know about for `ctx.agent()`**: `createSandbox()`
merges `agentProviderEnv: {}` at container-create time (verified in
`src/createSandbox.ts`, the `mergeProviderEnv` call inside the `else` branch of
`isTestMode`), and `docker exec` passes **no `-e` flags**
(`src/sandboxes/docker.ts` `exec` builds `["exec", ...maybe -i, ...maybe -w, containerName, "sh", "-c", cmd]`).
Therefore **a provider's `env` is silently dropped on the warm path** —
`createSandbox(...).run({ agent: claudeCode(m, { env: { ANTHROPIC_API_KEY } }) })`
produces "Not logged in · Please run /login". Top-level `run()` is unaffected
(it merges `agentProviderEnv: provider.env` at create). Issue #900 reports the
same for `createSandboxFromWorktree`. The blessed workaround is a wrapping
provider whose `buildPrintCommand` prefixes `env K=V ... claude ...`. **If Rocky
wants per-Agent credentials or per-Agent models on a warm sandbox, it must ship
that wrapper.**

## 9. Project health

| Dimension | Finding |
| --- | --- |
| Licence | **MIT**, Copyright (c) 2026 Matt Pocock (`LICENSE`; `npm view @ai-hero/sandcastle license` → `MIT`). No CLA, no dual licence. Clean. |
| Version | `0.12.0` (`package.json`, `dist-tags.latest`). Pre-1.0. |
| Release cadence | 44 published versions between 2026-03-26 and **2026-06-29**, i.e. bursts of several releases per week (0.6.0→0.6.3 all on 2026-05-26). Then **nothing for two months** — `npm view time` shows `0.12.0` as the last publish (2026-06-29T20:16Z) and `git ls-remote origin main` confirms the tip commit is from 2026-06-29. |
| Maintenance signal | Issues keep arriving (newest #963, 2026-08-26) but the **last merged PR was #858 on 2026-06-29**. **93 open issues** / 571 closed; ~10 open PRs from July–August unmerged, including community provider additions (#958 Grok, #957 OrcaRouter, #941 Muse) and bug fixes (#962, #959). Development appears **paused, not finished** — the tracker is live, the merge queue is not. |
| Versioning discipline | Changesets-driven (`.changeset/`, `changeset publish`), one changelog entry per change with genuinely detailed prose. **But 0.11.0 exists in `CHANGELOG.md` and is absent from npm** (`npm view versions` jumps 0.10.0 → 0.12.0) — a failed or skipped publish. On 0.x, changesets classifies breaking changes as "Minor", so a `^0.12.0` range can pull breaking changes; and issue #901 ("Update version flow") is open. |
| Breaking-change loudness | **Quiet by convention, loud by prose.** No `BREAKING` markers in `CHANGELOG.md`; behavioural changes land as Minor/Patch. The changelog entries themselves are unusually explicit about behaviour changes (e.g. the 0.11.0 `bce86dd` entry explains exactly which gate silently no-op'd). Pin exactly (`0.12.0`, no caret) and read the changelog on every bump — which is what a pinned hard dependency already implies. |
| Testing | Strong: ~50 `*.test.ts` files alongside ~50 source files, plus dedicated Windows-path suites. Vitest, `tsgo --noEmit` typecheck, Husky + lint-staged, and a `check-public-types-effect-free.mjs` postbuild guard so Effect does not leak into public types. |
| Architecture | Effect-based internals with a Promise-based public API and a documented provider-plugin seam (`createBindMountSandboxProvider` / `createIsolatedSandboxProvider`, `SandboxProvider`, `AgentProvider`). 20 ADRs under `docs/adr/` and an `.out-of-scope/` directory recording rejected requests — this is a well-reasoned codebase, which is why the "designed but unimplemented" ADR 0007 stands out. |

Open issues most likely to bite Rocky, ranked:

1. **#849** concurrent branch-strategy worktrees delete each other (+ #642, #854, #855) — hits Rocky's core concurrency model.
2. **#925 / #900** agent-provider `env` never reaches the container on the `createSandbox` path — hits per-Agent config.
3. **#943** `createSandbox` ignores non-zero exits from `onSandboxReady` hooks — failed MCP/dependency setup looks like success.
4. **#933** Docker/Podman exec reports signal-killed as success — OOM looks like a pass.
5. **#916** Docker provider leaks containers when `create()` times out before returning a handle.
6. **#931** preserved worktrees are never reclaimed, no opt-out — unbounded disk growth.
7. **#942** `resume()`/`fork()` leak `promptArgs` into the inline-prompt re-run.
8. **#864** `@standard-schema/spec` used in public types but undeclared.
9. **#936** `vercel`/`daytona` silently drop `ExecOptions.stdin`, so `claudeCode` gets an empty prompt (blocks isolated providers entirely).
10. **#928** `claudeCode()` always pipes the prompt on stdin, so a `/slash-command` prompt never expands — relevant if Rocky ever wants to invoke a Claude Code slash command as a review entry point.

## 10. Headline artifact: Sandcastle gives us / Rocky must build

| Sandcastle gives us | Rocky must build |
| --- | --- |
| Worktree lifecycle: `git worktree add` under `.sandcastle/worktrees/<name>`, reuse-on-collision with safe fast-forward, orphan pruning (`WorktreeManager.create`/`pruneStale`, ADR 0003) | Per-repo **locking / serialisation** of Runs. ADR 0007's lock file is designed and **not implemented**; `pruneStale` on every create can delete a live sibling (#849). Also a worktree GC policy (#931). |
| Container lifecycle: detached `docker run -d`, UID/GID pre-flight, bind mounts incl. worktree-aware `.git` resolution, SELinux labels, `--cpus`, `--network`, `--device`, `--group-add` (`sandboxes/docker.ts`, `DockerLifecycle.startContainer`, `SandboxFactory.resolveGitMounts`) | **Sandbox persistence across a daemon restart**: reconstruct from `(repo, branch, sessionId)` via `createWorktree` + `createSandbox`; reap orphaned `sandcastle-*` containers left by a `SIGKILL`. No reattach API, no container id exposed. |
| Three branch strategies (`head`, `merge-to-head`, `branch`) with merge-back, commit collection, and dirty-worktree preservation (`SandboxLifecycle.withSandboxLifecycle`) | Branch **naming and allocation policy** per Run, plus never using `head` for concurrent Runs. Rocky's own conflict/merge-failure handling beyond the "To retry: git merge X" message. |
| Six harnesses behind one `AgentProvider` interface: flag construction, stream parsing, permission-mode plumbing (`AgentProvider.ts`) | A **per-Agent env wrapper** (`buildPrintCommand` prefixing `env K=V`) because `createSandbox().run()` drops provider env (#925). Also opencode's argv-inlined prompt has no size guard (unlike Cursor/Copilot's 120 KB checks). |
| Agent invocation with idle timeout, completion-signal detection, post-signal grace window, `AbortSignal` cancellation that kills the in-flight subprocess (`Orchestrator.invokeAgent`, ADR 0019) | **Wall-clock timeouts and budget caps** (only *idle* timeouts exist). Kill/cancel is per-run; nothing bounds total Run duration or spend. |
| Session capture + `resume()` / `fork()` for Claude Code, Codex, Pi, with host↔sandbox `cwd` rewriting and a persistable session id (`AgentSessionStorage`, `SessionStore.transferClaudeSession`, ADR 0012/0018) | The **capped review loop itself** — `maxIterations > 1` is incompatible with `resumeSession` (ADR 0011), so Rocky chains `.resume()` and counts. Plus **resume for opencode**: won't-fix per ADR 0016, so Rocky must re-prompt with its own context. Plus custody of the session JSONL (set `sessionStorage.hostProjectsDir`). |
| `Output.object()`/`Output.string()` tag extraction, fence unwrapping, Standard Schema validation, and session-resuming retries — **on `run()` only** | **Structured output on the warm path.** `SandboxRunOptions` has no `output`; `extractStructuredOutput` is unexported. Rocky re-implements extraction + a retry loop that stays in the warm sandbox. Also declare `@standard-schema/spec` (#864). |
| Streaming: `onAgentStreamEvent` with `text`, `toolCall`, `raw` variants, per-line and real-time (`AgentStreamEmitter`, `buildAgentStreamHandler`) | **Live-progress fidelity**: parse `raw` yourself. `toolCall` is allowlisted to 4 tools for Claude Code (Read/Write/Edit are dropped), `text` is coalesced by `TextDeltaBuffer`, and callbacks only fire in `logging.type === "file"` mode. |
| Raw token counts for Claude Code (`IterationUsage`, `parseSessionUsage`) | **Cost per Run**: price tables, USD arithmetic, and Run-level totals (usage is a last-message *snapshot*, ADR 0005). Plus usage for opencode and for any host-mode run — both `undefined` today. |
| A warm container that outlives many `run()` calls, plus `Sandbox.exec()` (0.12.0) for tests/lints/dev servers between runs | **Side-process management**: detached-launch discipline (a naive `&` hangs the exec), health checks, restart, and **port exposure** — `docker()`/`podman()` have no `ports` option and no handle exposes an address. |
| Lifecycle hooks (`hooks.host.onWorktreeReady`, `hooks.host/sandbox.onSandboxReady`), `copyToWorktree`, mounts, `.sandcastle/.env` resolution | **All MCP configuration.** Zero MCP surface in Sandcastle. Rocky writes `.mcp.json`/settings into the worktree or runs `claude mcp add` via a hook — and must check hook exit codes itself (#943) and enforce its own hook timeouts (#907). |
| Host mode via `noSandbox()`: full credential/env pass-through, so `~/.claude`, `gh`/`glab`, and ssh-agent just work | **All isolation and safety in host mode.** No env allowlist, no fs confinement, no uid change, and AFK runs pass `--dangerously-skip-permissions` unconditionally (`Orchestrator.ts:143`) despite the provider docstring's claim. Rocky must force `claudeCode({ permissionMode })` and avoid concurrent host Runs (`~/.gitconfig.lock`, #917/#919). |
| `interactive()` for a human at a TTY | **Any interactive/PTY surface for the web UI.** `Sandbox.interactive()` hardcodes `stdin: process.stdin, stdout: process.stdout, stderr: process.stderr` (`createSandbox.ts` ~line 634) — it hijacks the daemon's stdio and is unusable from a server. |
| Effect-free public types, changesets changelog, 20 ADRs, ~50 test files | **Version vigilance**: pin exactly; 0.x Minor can break; 0.11.0 was never published; no upstream merges for two months while 93 issues sit open. |

## 11. What would make the wrapped-`ctx` decision wrong

Nothing found here invalidates it, but four items deserve explicit flags. Two
are cost adjustments to implementation tickets; two are genuine (if bounded)
threats to the abstraction.

**Not a threat, but re-price these tickets:**

0. **The premise may be wrong before Sandcastle is.** `CONTEXT.md` says Review
   runs are "never resumed mid-flight" and re-run from scratch after a service
   restart; the ticket assumes Runs suspend at Checkpoints for hours or days.
   Settle that first (see the callout in §1) — it changes whether item 1 below
   is a subsystem or a no-op.

1. **`ctx.checkpoint()` is not thin.** The map's implicit assumption — that a
   Checkpoint suspends a live sandbox — is **wrong**. A `Sandbox` cannot survive
   a daemon restart (§1), so `ctx.checkpoint()` must serialise
   `(repo, branch, sessionId)`, tear the container down, and reconstruct on
   resume. That is a real subsystem (state store, reconstruction, container
   reaping, session-JSONL custody), not a wrapper method. Upside: because the
   worktree and the session JSONL are both plain on-disk state keyed by
   `hostRepoDir`, reconstruction is genuinely achievable — the seam exists,
   it just has to be built.
2. **`ctx.agent()` inside a warm sandbox loses two things the shallow read
   credited to Sandcastle**: structured output (`Output` is `run()`-only, §4)
   and per-Agent env (#925, §8). Both are Rocky-side code. The warm-sandbox
   review loop ticket should absorb tag extraction + validation + retry, and an
   env-prefixing provider wrapper.

**Closest to making the decision wrong:**

3. **Concurrency is unsafe at the layer `ctx` cannot hide.** Rocky's model is
   several Runs per repo. Sandcastle's `pruneStale`-on-every-create plus the
   shared-`.git` path asymmetry means siblings can delete each other's
   worktrees mid-run (#849), the designed lock does not exist (ADR 0007), and
   the global-gitconfig write contends in host mode (#917/#919). This is not a
   leaky *type* — `ctx` can still hide the API — but it is a leaky *guarantee*:
   Rocky must impose a per-repo serialisation lock **above** `ctx`, which
   constrains Rocky's own scheduler design and caps parallelism per repo. If it
   later turns out that even serialised-per-repo Runs corrupt each other (the
   #849 mechanism is triggered by prune + shared `.git`, not by branch
   collision), the honest options become forking Sandcastle's
   `WorktreeManager`, one clone per Run instead of one worktree per Run, or
   dropping bind-mount providers. **This is the one to spike before committing
   to the concurrency story.**
4. **The upstream is paused.** Last merged PR 2026-06-29; two months of no
   commits; 93 open issues including several that hit Rocky directly; community
   PRs unmerged. A pinned hard dependency on a paused MIT project is a *fork
   decision waiting to happen* — and the fixes Rocky needs most (#849 locking,
   #925 env, #943 hook exit codes) are all small, well-diagnosed patches in a
   well-tested codebase. That is the mitigating fact: forking or vendoring is
   cheap here. But the `ctx` wrapper should be written so that swapping
   Sandcastle for a fork is a one-file change — i.e. **keep `ctx.sandbox` typed
   as Rocky's own interface, not as Sandcastle's `Sandbox`**, or the escape
   hatch becomes the thing that welds Rocky to an unmaintained dependency.

Two smaller flags: `interactive()` is unusable from a daemon (hardcoded
`process.stdin`), so any "attach a terminal" UI feature is 100% Rocky-built; and
the isolated providers (`vercel`, `daytona`) are effectively broken for
Claude Code today because they drop `exec` stdin (#936), so "swap in a cloud
sandbox later" is not currently a working escape valve.

---

## Source index

Read at `mattpocock/sandcastle@e99f832f26dc9d245c019a9ddd19fa5dee792427`
(`@ai-hero/sandcastle@0.12.0`):

- Public API: `src/index.ts`
- Entry points: `src/run.ts` (`run`, `RunOptions`, `LoggingOption`, `Timeouts`, `buildStructuredOutputRetryFeedback`), `src/createSandbox.ts` (`createSandbox`, `buildSandboxHandle`, `Sandbox`, `SandboxRunOptions`), `src/createWorktree.ts` (`createWorktree`, `Worktree`), `src/interactive.ts`
- Core loop: `src/Orchestrator.ts` (`orchestrate`, `invokeAgent`, `IterationResult`, `IterationUsage`), `src/SandboxLifecycle.ts` (`withSandboxLifecycle`, `SandboxHooks`), `src/SandboxFactory.ts` (`WorktreeDockerSandboxFactory`, `resolveGitMounts`, `SANDBOX_REPO_DIR`)
- Providers: `src/SandboxProvider.ts`, `src/sandboxes/docker.ts`, `src/sandboxes/podman.ts`, `src/sandboxes/no-sandbox.ts`, `src/sandboxes/vercel.ts`, `src/sandboxes/daytona.ts`, `src/DockerLifecycle.ts`
- Agents: `src/AgentProvider.ts` (`claudeCode`, `codex`, `pi`, `cursor`, `opencode`, `copilot`, `AgentSessionStorage`, `parseStreamJsonLine`, `parseOpenCodeStreamLine`), `src/SessionStore.ts`, `src/resumePrecheck.ts`
- Output & streaming: `src/Output.ts`, `src/extractStructuredOutput.ts`, `src/AgentStreamEmitter.ts`, `src/TextDeltaBuffer.ts`
- Infrastructure: `src/WorktreeManager.ts`, `src/shutdownRegistry.ts`, `src/EnvResolver.ts`, `src/mergeProviderEnv.ts`, `src/InitService.ts` (Dockerfile + `.env` templates), `src/boundedTail.ts`
- ADRs: `docs/adr/0003-reuse-worktree-by-default.md`, `0005-usage-raw-tokens-no-percentage.md`, `0007-worktree-locking.md` (**designed, not implemented**), `0010-structured-output.md`, `0011-resume-is-one-iteration.md`, `0012-agent-provider-owned-session-storage.md`, `0015-no-sandbox-in-run-and-create-sandbox.md`, `0016-resume-requires-filesystem-backed-sessions.md`, `0018-fork-is-session-only.md`, `0019-completion-timeout-for-hanging-process.md`
- `CHANGELOG.md`, `package.json`, `LICENSE`
- npm registry: `npm view @ai-hero/sandcastle` (version 0.12.0, MIT, 44 versions, `time` map showing the 2026-06-29 last publish and the missing 0.11.0)
- GitHub: `gh issue list`/`gh pr list` on `mattpocock/sandcastle` — issues #849, #642, #854, #855, #863, #864, #898, #900, #907, #910, #916, #917, #919, #925, #928, #931, #933, #936, #942, #943, #963; open PRs #941, #944, #945, #957, #958, #959, #961, #962; last merged PR #858
