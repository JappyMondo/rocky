# Boot Worker

## Integration Contract

`run/worker.ts` exports `RunWorkers` with constructor options
`{ paths: RockyPaths, config: () => InstanceConfig, childModule?: URL, onEvent?, onRequest? }`.
`childModule` is test injection only; production defaults to
`new URL('./boot-child.js', import.meta.url)` in the compiled daemon.

- `boot(run: RunHeader, kind: 'run' | 'poll', signal: AbortSignal): Promise<BootResult>`
- `kill(run: RunHeader): Promise<void>`
- `close(): Promise<void>`

Methods are bound and can be passed directly to the scheduler. `onEvent` receives
`(runId: string, stepKey: string, event: unknown)`; it is optional display output,
not another durable record. The coordinator owns exports and `boot-child.ts`.

Parent-to-child IPC is `{ type: 'boot', run, kind, root: paths.root, config: config() }`
and `{ type: 'abort' }`. Child-to-parent IPC is `{ type: 'result', result }`,
`{ type: 'error', error: { name, message, stack? } }`, or
`{ type: 'event', runId, stepKey, event }`. Configuration is never logged or
journaled by the supervisor. The child must observe abort and IPC disconnect,
close its WorkflowRuntime, and load the snapshot afresh on every Boot.

## Parent Services

`BootRequest` is an exported, finite union:

```ts
type BootRequest =
  | { kind: 'append'; entry: JournalEntry; options?: AppendOptions }
  | { kind: 'workspace' }
  | { kind: 'control-get'; key: string }
  | { kind: 'control-put'; key: string; value: unknown }
  | { kind: 'agent-steer-open'; stepKey: string; label: string; group?: string }
  | { kind: 'agent-steer-take'; stepKey: string }
  | { kind: 'agent-steer-delivered'; stepKey: string; ids: string[] }
  | { kind: 'agent-steer-close'; stepKey: string };
```

`onRequest(runId, request, signal): Promise<unknown>` handles these operations
in the parent. `signal` is the same AbortSignal passed to `boot`. The coordinator
owns JournalWriter, the shared RepoContext mutex and execution wiring; the Boot
child must not create another writer or RepoContext. `agent-steer-*` requests
bridge the child Agent registry to parent-owned Linear control: open/take/delivered/
close correspond to its full Step-keyed conversation API. The child validates a
returned batch before it reaches an Agent and never writes control state itself.

Child requests are `{ type: 'request', id: string, request: BootRequest }`.
Replies are `{ type: 'reply', id, result? }` or
`{ type: 'reply', id, error: { name, message } }`, relayed by the watchdog.
A missing handler returns a named fix to configure `RunWorkers.onRequest`.

Boot completion, `kill`, and `close` join all accepted parent requests, including
requests still settling after child exit. New requests after a result or during
shutdown are refused. The scheduler aborts the Boot signal before `kill`; the
handler must observe that signal and settle after finishing or undoing its own
work. Joining has no artificial timeout: returning while workspace creation is
still mutating would race cancellation preservation.

The parent tracks each successfully opened Agent conversation. If a child exits
before its unregister request, it closes those conversations with a fresh cleanup
signal before releasing the worker, returning undelivered Steers to control storage
for the next Boot. A child never owns or reconstructs that durable control state.

## Ownership

One child per live Run is retained across `parked` and `ready` results. Concurrent
Boots for the same Run are refused. Terminal results and rejected Boots stop and
join the child before settling. `kill`, signal abort, and `close` first send abort,
allow bounded cleanup grace, then terminate the owned process group. No persisted
PID is trusted. Cancellation records and preservation remain scheduler-owned.
Cleanup allows 150 ms after abort, sends SIGTERM to the owned group, then sends
SIGKILL after another 150 ms and joins the Boot child before the watchdog exits.
A late result after an explicit kill cannot bypass that join.

An independent IPC watchdog owns the detached Boot process group. Daemon death
closes its IPC and triggers cleanup even if the Boot child cannot service its
event loop. Commands that create their own detached groups must retain their own
IPC lifetime supervisor, as `startCommand` does. This is process ownership, not
a sandbox against trusted Workflow code deliberately escaping its lifetime.

## Verification

`worker.spec.ts` exercises the approved public `boot`/`kill`/`close` seam with real
processes through `worker-fixture.mjs`. Coverage includes sequential polls,
ready-child retention, per-Run isolation, configuration refresh, terminal joins,
rejected Boots, IPC serialization errors, overlapping Boots, abort delivery and
a late Parked response during kill. Daemon SIGKILL tests cover both direct
grandchildren and detached commands owned by `startCommand`, while the Boot
child is stuck in synchronous code. Parent-service tests cover all four request
kinds, correlated replies, void results, named handler failures, exact Boot signal
identity, and joins that outlive child exit or an early Parked result. Production
Workflow loading/composition is the coordinator's separate integration seam.
