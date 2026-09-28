# Owned bounded duplex transport

`DuplexRunner` is a trusted host primitive for newline-delimited plain JSON over
an owned command's stdin/stdout. It is not a Codex protocol adapter or a model
capability: `capability` is always `null`. Do not use it as an untrusted agent tool.

A coordinator transport can synchronously call `start(lease, action, spec, limits)`
inside `begin(action)`, then return its application observation promise. Start
requires the exact persisted action in `sending`, its current input, versions,
lease, global slot fence and unexpired high-water deadline. It reserves the
existing command record and initiates its existing supervisor inside the same
`guardedStart`. Nested Store transactions use savepoints; an outer rollback
removes nested reservations. The new supervisor's Store open waits for that
transaction to end, and will not launch a gate or target without its durable row.
Directories from a rolled-back start may remain as diagnostic evidence.

An invocation is keyed by `action.key`; a duplicate identical start returns the
existing command ID, including after restart. Conflicting spec/action/limits are
rejected. It never relaunches an existing invocation. Observe/recover the existing
command; missing or uncertain supervisor identity means `recovery-required`.
Storage schema 5 prevents an older reader from owning the new duplex commands;
existing schema-4 snapshots, budgets and records are preserved when upgraded.

`send(lease, id, sendKey, frame)` and `end(lease, id, sendKey)` reserve bounded input
in SQLite. An identical send returns its previous state; a conflicting payload
fails. `queued` has not been attempted, `writing` is ambiguous, and `written`
means the OS pipe callback completed, **not** application acknowledgement.
The gate commits `writing`, commits a one-shot attempt latch, then rechecks the
exact action, fence, cancellation, revocation and deadline under the transaction
that initiates the write. It permits one write in flight and waits for its
callback before claiming another. Cancellation cannot retract bytes already
accepted by the OS. No new write is initiated after its guard rejects. A crash,
callback loss or guard failure never makes `writing` eligible for retry. The
low-level write API refuses an enclosing transaction because its attempt latch
must commit before the pipe side effect.

The decoder accepts fragmented/multiple frames, strict UTF-8 and plain JSON only.
Partial EOF, malformed UTF-8/JSON, oversized frames, excessive frame count or
captured byte limits fail the stream. Input/output totals are bounded (at most
16 MiB each), frames at most 1 MiB, counts at most 4096; stderr and raw stdout
logs have their own command limit, at most 16 MiB each for duplex. These are
retained/accepted-stream bounds, not a claim that a child cannot generate more
bytes before termination. Persist only synthetic or approved nonsensitive
payloads: the queue, frames, command arguments and logs are durable, not a secret
store. Runtime environments retain the existing minimal runner allowlist.

`interrupt` durably revokes the invocation. It does not assert completion.
`wait` reports local `quiescent` only after the existing supervisor observes both
pipe EOFs and absence of the owned process group after bounded TERM/KILL cleanup.
The persisted `stdoutEof`/`stderrEof` observations describe the supervisor's
carrier pipes only. `childStdoutEof`/`childStderrEof` come only from the gate's
child streams; `decoderComplete` comes only from successful decoder finalization
after all accepted output was parsed. Missing fields on older schema-5 records
are not completion evidence. Killing a carrier never sets the child or decoder
fields. A physically quiescent invocation whose child streams were not finalized
records `duplex-stream-incomplete` (unless an earlier failure already explains it)
and cannot be transport success. This includes direct-child exit0 with a
same-group descendant still holding stdout, even when every observed frame was
complete. Physical quiescence can still support failed/interrupted settlement;
it does not classify an unfinalized stream as complete.

The group leader stays owned during normal cleanup. Darwin uses its documented
`ps -g` group selection because a negative-PGID signal-zero probe can return
EPERM even after group disappearance; only status 1 with empty stdout/stderr
proves absence. Permission, timeout, malformed output and identity failures
remain unknown. Other POSIX hosts require ESRCH from the group existence probe.
The supervisor records a cleanup error when observation fails, and retains
`recovery-required`; coordinator capacity cannot be released in that state.

This is **owned-process-group** quiescence. A descendant that deliberately escapes
the group with setsid/setpgid and closes inherited pipes is outside this ownership
proof. Filesystem/network/credential containment and escaped-process prevention
require the separately qualified runtime. No native/model containment or token
enforcement is established here. The production capability remains unavailable.

EOF, a process exit code, a complete JSON frame and local quiescence are never an
application final. A later typed protocol adapter must check correlated final
messages, errors, pending requests/tools and usage before producing a coordinator
result. The primitive does not manufacture that result. Tests use an explicitly
injected transport capability for charged agent-shaped synthetic invocations;
unknown usage preserves the full reserved charge and cannot qualify a successful
handoff. Existing coordinator result/receipt and budget semantics are unchanged.
