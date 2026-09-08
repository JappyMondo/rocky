# CLI and Workflow context contract

This reconciles [NG-618](https://linear.app/digimondo/issue/NG-618) against the
current distribution, Runtime and MCP OAuth slices. It is not a claim that the
remaining MVP integration already runs. Recheck the tables when the Harness and
shipped-content lanes land.

## CLI

[ADR 0003](adr/0003-vendored-rocky-upgraded-by-conversation.md) amends NG-578's
"complete for v1" list with `rocky upgrade`. NG-580's manual Trigger adds
`rocky trigger <name> <issue>`; retain that scaffolded name and argument order.

| Command | Current implementation | Contract/owner |
| --- | --- | --- |
| `rocky setup` | Implemented wizard | NG-600; stable endpoint first, admin-assisted app creation, local OAuth |
| `rocky start [-d]` | Implemented | NG-595; foreground or detached daemon |
| `rocky stop`, `restart`, `status` | Implemented | NG-595; local API, pidfile, explicit restart on version mismatch |
| `rocky logs [-f]` | Implemented | NG-595; daemon log, not per-Run Transcript |
| `rocky doctor` | Implemented | NG-595/651; config, local/public ping identity, Harness sign-in; NG-628 owns adapter auth adoption |
| `rocky service install\|uninstall` | Implemented | NG-595; launchd/systemd user unit |
| `rocky repo add <url>`, `list`, `remove <name>` | Implemented | NG-521; Rocky-owned clones |
| `rocky init` | Named failing stub | NG-607 implements NG-581's uncommitted default `.rocky/` copy |
| `rocky upgrade` | Named failing stub | NG-608 implements ADR 0003's interactive comparison, not an automatic merge |
| `rocky mcp login <server>` | Implemented | NG-599/583; URL-keyed machine OAuth is documented in [MCP OAuth](mcp.md) |
| `rocky trigger <name> <issue>` | Named failing stub | NG-580; admission/loader/local API wiring follows NG-540/598/609 |
| `rocky-ingress [--port <port>] [--daemon-port <port>]` | Implemented operator utility | NG-651; separate webhook/ping-only filter, not a tunnel manager |

The first binary's full lifecycle also accepts `--host`/`--port` where shown by
`rocky --help` and command help. Config and a live pidfile supply omitted
addresses. Bind changes require a restart; the public ingress recipe requires
IPv4 loopback. Installing the package does not install or sign into a Harness.

### Manual Trigger refusal

`<name>` is the registered manual Trigger name; `<issue>` identifies its Linear
issue. There are no Linear comment commands or PR-review wake events. All
Triggers share the one-live-Run-per-issue invariant. Any non-terminal Run wins,
even if a newer ordinal is already terminal (the NG-540 delivery decision).

Once implemented, a refused firing must exit nonzero, write a diagnostic on
stderr naming the issue and live Run, and neither allocate a Run nor reset the
issue's branch. It must not print a successful admission. For example:

```text
Refused: NG-123 already has live Run NG-123-1.
```

The punctuation is illustrative, not a JSON or wire format. The current stub
instead exits 1 naming NG-580 as the owner; it does not perform admission. Final
refusal integration tests belong with the command's real scheduler/API wiring.

## Workflow context

The installed `@rocky/sdk` in this slice exports the following types, not their
daemon implementations:

| Surface | Current SDK | Settled source |
| --- | --- | --- |
| `issue`, `branch` | Readonly data | NG-574/580; immutable Run snapshot |
| `agent`, `exec`, `step`, `checkpoint`, `post`, `changedFiles` | Declared | NG-572 as amended by NG-575; effects are journaled |
| `scm` | Eight declared operations | NG-580; platform API only, git remains `exec`/Agent bash |
| `linear.setState(name)` | Declared | NG-578; case-insensitive exact state name, named failure on unknown state |
| `ports`, background `exec`, `parallel`, `stage` | Implemented | NG-597/631; [Run Runtime](run-runtime.md) defines their replay and parking behavior |

`ctx.parallel` was **not dropped**. NG-597, informed by NG-577 section 5,
specifies one parent Journal entry and an index-keyed sub-Journal per branch,
independent of settlement order and safe to nest. A changed item count is
divergence; raw concurrent `ctx` calls via `Promise.all` are unsupported and must
be caught, not silently corrupt the Journal. NG-597 owns the exact callback type,
branch-local context, result ordering and mixed Parked/failing-branch behavior.
Do not infer those from a prototype or add a second implementation here.

### Runtime integration

The merged runtime exposes these declaration shapes (named result/options types
expanded):

```ts
readonly ports: number[];
stage(label: string): void;
exec(cmd: string, opts: { background: true; label?: string }): Promise<{ pid: number }>;
parallel<T, R>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<R>,
  opts?: { label?: string },
): Promise<R[]>;
```

The callback captures the same `ctx`; it does not receive a second context
parameter. Async-local routing supplies branch-local Journals. `ports` is a
readonly property holding a mutable array, not a deeply readonly array. The
runtime corrects CONTEXT's Step definition to exclude `stage()` and replaces
ADR 0005's stale member count with the named surface. Its poll Boots retry waits
without starting new Steps or background commands; working Boots renew those
resources. The isolated SDK consumer typechecks these members from the packed
SDK.

A valid example is:

```ts
const results = await ctx.parallel(['lint', 'test'], async (command, index) => {
  return ctx.exec(command, { label: `check ${index + 1}` });
}, { label: 'checks' });
```

`ports` and `stage` are not Steps. Ports are Run data reserved at Boot; `stage`
is a display-only marker, consuming no sequence number. Background `exec` is an
explicit exception to replaying an old result: it must respawn rather than
return a dead PID. NG-597 owns its process-group lifecycle and terminal cleanup.
Ordinary effectful Steps remain at-least-once, not an exactly-once promise.

No `ctx.interruptions()` (ADR 0005), `ctx.sandbox` (ADR 0001), or `ctx.loop`
combinator is restored. Ordinary code between Steps may perform I/O and reruns
on Boot; wrap effects in `step` when their outcome must be journaled.

## Remaining reconciliation

NG-618 remains open while CLI Trigger admission and the Onboarding/upgrade work
remain unimplemented. Use the existing NG-597/631 tickets, not competing edits,
for runtime behavior. Re-run the SDK-only consumer typecheck when that surface
changes. Trigger admission and NG-608 functionality must likewise stop being
called implemented merely because their command names exist.
