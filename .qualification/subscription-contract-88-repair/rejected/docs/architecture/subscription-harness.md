# Direct subscription harness decision

Taskbot #8/804/816, #1/806/820 and accepted #87/814/815/817 choose one direct pinned
Codex `exec --json` harness using its own subscription login. Separate API credentials
and the experimental Responses gateway are not prerequisites. The protected
[v1 contract](../../acceptance/subscription/README.md) is the normative acceptance
boundary. Its qualification is false and capability null. This document grants no
native, auth, login/status, account, model, target or remote execution.

Keep the existing owned runner, durable action identity, synchronous guarded start,
fences, raw-output collection and physical cleanup. Add only a sealed positive
allowlist launch environment, one-shot raw UTF-8 input plus EOF, and the typed fresh
exec interpreter. Prepare immutable artifacts before start; revalidate the bundle
at physical spawn. A crash around input/start/final/cancel is reconciled without
blind replay. There is no standalone app-server handshake, gateway listener or
late thread/turn binding in this route. The harness-neutral seam is immutable
invocation → observed result/usage/quiescence; other harnesses are deferred.

The trusted CLI parent may access and normally refresh one designated existing
harness-owned subscription store. Rocky does not read, copy, symlink or proxy
tokens. Explicit nonsecret auth-storage backend and recognized account mode are
required because ignoring user config may remove the storage setting. Preserve
login: do not apply forced-login settings that can log out incompatible shared auth.
An incompatible/unknown mode stops before model work with no API fallback. Later
qualification must close account/mode races without retaining identity secrets or
raw status output. Native auth refresh may write the shared store.

Private runtime HOME/TMP, SQLite/log/artifact paths are distinct from shared
CODEX_HOME; no sterile-home claim. Ephemeral session mode avoids session persistence
but does not imply no native writes under CODEX_HOME. If an existing-home profile
cannot qualify, a persistent Rocky-specific home with ordinary harness login is a
separate setup decision, not token transplantation or a fresh-home-per-action fix.

`--ignore-user-config` and `--ignore-rules` suppress specific layers only. Global
CODEX_HOME AGENTS files, system/package/managed/cloud layers and project/ancestor
discovery require an approved nonsecret inventory and actual effective-policy
qualification. Unknown keys or nested-map override guesses cannot prove routes
absent. Conflicting administrative policy blocks; it is never bypassed. Pin named
permissions and disable unapproved MCP, plugins, hooks, apps, skills discovery,
web/network, subagents, code mode, memories and shell snapshots using source-valid
controls, then observe the resulting native behavior. Exact override bytes remain
an explicit blocked prerequisite, not an invented qualified profile.

The parent/tool distinction must survive shell, patch and every non-shell route:
deny model access to auth, keyring, parent env/FD/process/IPC, private sessions,
coordinator, real Git, evidence and acceptance/oracles. A 0700 directory or sanitized
shell environment alone does not enforce this. Use synthetic sentinels and positive
controls; historical two-command H02-P01 evidence does not qualify this profile.
Keep staged source writable only for implementers; reviewers get read-only source
and bounded diagnostic scratch. Git, check selection/execution, browser receipts,
publication and tracker authority remain with the coordinator.

Visual workflow remains mandatory: trusted scripted browser checks and current
head/fixture/role/locale/viewport-bound screenshots feed bounded subjective review.
The exact exec approved-image input/transform path needs native qualification;
arbitrary `view_image` remains unavailable unless separately proven. A missing image
route blocks relevant UI work instead of turning it into text-only acceptance.

## Required production migration, not implemented here

At baseline `b1cc77dc7aa0d0394f59e0bc9dc6de2bfad13704`, coordinator schema 3
requires `HardLimitsCapability` booleans; `TokenUsage` permits only provider receipts
or local-no-model; `reducer.ts` treats usage above allocation as
`hard-token-contract-violated`. Transport comments promise full-action actual usage.
Do not connect direct exec by pretending those contracts already fit.

Introduce an explicit versioned `subscription-observed-v1` budget/evidence branch
and independent execution/containment qualification binding. Separate actual,
reported and planning quantities; retain nonsecret native telemetry provenance,
missing/zero ambiguity, overruns and the stop-before-next-agent rule. Hard aggregate
tokens are unsupported. Pin finite elapsed/attempt/resource bounds and the existing
independent CI repair entitlement. Preserve every old strict validation, unknown
success barrier and record; migration must not admit old runs or turn native usage
into provider receipts. New policy requires deliberate new-run/revision authority,
fresh input identity and independent binding; interrupted old work must reconcile
or drain under its original meaning first. Relevant checks/review/approval stale
across that boundary. Regression matrix M01–M05 is predeclared in the contract.

Sequence: independent #89 contract review → separately leased/reviewed policy
migration → direct adapter with owned fake CLI evidence → separately authorized
synthetic native containment/discovery/visual qualification → subscription/model
functional qualification → independently bound admission → real backend/UI coding
and unchanged delivery/benchmark gates. Gateway and historical harness artifacts
remain experimental evidence with their original outcomes; they cannot satisfy
new subscription gates automatically.

Source basis: accepted #87/814/815 pins official Codex source
`36650394c5b38c2990ccf2a3457165ca3e9d9726`; exact paths/hashes are in the manifest.
[Official authentication documentation](https://learn.chatgpt.com/docs/auth)
supports the subscription route, not current account/model availability. The source
correspondence, installed candidate identity and live runtime/backend attestation
are deliberately separate claims.
