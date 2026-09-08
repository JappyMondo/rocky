# Agent Steps

NG-544 uses `createAgent(steps, options)` from `run/agent.ts`, returning the SDK
`WorkflowContext['agent']`. Production composition supplies a branch-local
`BootContext`, immutable `.rocky/` `snapshotDir`, `cwd`, `sessionDir`, default
`harness` name, and `harnesses[name] = { command, env, sessionStorage }`.
Optional `signal`, incremental `onEvent(identity, event, sessionId)`, and the
per-Boot `resolveServers` callback are runtime concerns, not Workflow options.
`adapterFor` and `resolveServers` are programmable Harness/MCP boundary seams;
production defaults load `getHarnessAdapter`, parse/expand the immutable
`mcp.json` once per Boot, and call `resolveMcpServers` before each invocation.

## Durable Boundary

`EffectHandle.identity` is a stable full nested branch/sequence key within a Run.
`record(attempt): Promise<void>` and `update(progress): Promise<void>` append and
flush running Journal snapshots before returning. `progress` returns a detached
copy. `record(attempt, progress)` updates both in one flushed snapshot, so a
recorded failure cannot reboot at the old retry number. Writes serialize,
unawaited writes drain before settlement, closed handles
reject late writes, and storage failures latch across branches. `progress` is a
Journal field, not sidecar state. Attempt kinds remain `failed` and `steer`.
`handle.fail(error)` latches a Run-fatal named configuration failure; Agent uses
it for a missing snapshot prompt, which Workflow code cannot catch away.

## Steer Integration

`AgentOptions.steer.register(handle)` receives an `AgentContinuation`:

```ts
interface AgentTurn { id: string; ids?: string[]; note: string }
interface AgentContinuation {
  readonly identity: string;
  readonly label: string;
  readonly group?: string;
  steer(turn: AgentTurn): Promise<void>;
}
```

Registration may be awaited and returns an unregister function. A production
registry is `run/steer-bridge.ts`: it asks the parent to open a full Step-keyed
conversation, including the nearest enclosing parallel group, takes a batched
`{ ids, message }` only at a Harness-safe boundary,
and acknowledges those IDs only after `record({ kind: 'steer' })` flushes the
same-session continuation. Registration enqueues pending turns, including those
from between Steps. Calls while a Harness turn runs wait for either the adapter's
`turn-boundary` event or invocation settlement, never cutting an arbitrary tool
call short. A resolved promise means the verbatim note and known same-session
continuation are durable, not that the model has completed the turn. IDs deduplicate
re-delivery within this Step.
At unregister, unresolved deliveries reject and remain pending in control storage.
Each parallel Agent registers independently with its full identity.

The Agent persists attempt number/start/deadline, session, nudge history, usage,
pending turns and intended continuation before external invocation. Known
continuations survive a crash; arbitrary in-flight invocations cold-run the
current worktree. No reset, no cross-Step sessions, and no timeout reset on Steer
or schema repair. At-least-once delivery remains possible across a crash during
resume. Control records between Steps remain the control service's responsibility.

## Acceptance Scope

Focused `runBoot` tests exercise the Journal boundary and a programmable Harness
with MCP preparation. `run/production.spec.ts` covers the production Boot seam
with a snapshotted prompt/MCP declaration and a programmable Harness. Both real
Harnesses, live account authentication and Linear intake remain separate
integration gates. No live external delegation is performed by these tests.
