# Verified environments

Rocky can verify explicit environment recipes in disposable onboarding clones and
in Run workspaces. This is a capability verifier and bounded recovery mechanism,
not automatic support for arbitrary repositories. The machine-local profile is
executable authority; repository documentation and discovery output are evidence.
Discovery never executes setup or silently authorizes its suggestions.

## Configuration and discovery

Unified repository catalogs accept an optional `environment` object:

```json
{
  "version": 1,
  "capabilities": [
    {
      "id": "local-login",
      "kind": "login",
      "baseline": true,
      "sources": [{ "path": "README.md", "section": "Local development" }],
      "setup": ["app/install", "app/migrate", "app/seed"],
      "services": ["app/frontend"],
      "verify": "app/login-smoke",
      "checks": ["local-login", "authenticated-feature"],
      "authentication": { "kind": "documented-local", "reference": "README.md" },
      "fixture": "simulated"
    }
  ]
}
```

All executable references are existing repository-qualified catalog IDs. Capability
kinds are `runtime`, `dependencies`, `browser`, `login`, `fixture`, and `feature`.
`baseline` capabilities run before implementation; UI triage may additionally
request task-specific capability IDs. UI validation requires a verified browser
capability. Do not put the behavior that the ticket is intended to implement in a
baseline check: baseline checks prove development prerequisites, not acceptance
of a future change.

Read-only discovery looks for runtime/package-manager versions, install and start
scripts, service dependencies, migrations, seeds, browser prerequisites, local
login documentation and fixture recipes. The proposal is explicitly unverified.
The UI exposes proposed environment JSON separately: review/save it through the
profile configuration editor along with its referenced catalog entries. It is not
silently applied when applying individual command/service suggestions. Source
references must be repository-relative files; execution verifies their existence
and rejects symlink escapes. Conflicting versions or missing smoke scripts need a
recipe correction, not an invented passing command.

Setup requires `automation.workspaceSetup: true`; referenced commands must not
have `manual` policy. Save only setup scripts that are idempotent, reversible and
use isolated data in the assigned workspace. Setup is at-least-once, including
restart and repair. This authorization does **not** imply permission for global
runtime installation, paid resources, destructive database resets, or external
credential acquisition. Rocky does not infer that authority from repository prose.
A checkout is filesystem isolation, not an OS security sandbox for arbitrary shell
scripts: inspect executable recipes before authorizing them.

Authentication uses either a source document reference (`documented-local`) or a
machine environment-variable name (`secret-env`). A local login reference must
also be one of the evidence sources. Never save credential values in recipes.
Documented local accounts can be used by smoke scripts and inspectors without an
unnecessary question. Real credentials require the machine's existing secure
configuration/tool access. Verification does not put their values in context.

## Executable evidence

A verifier must actually exercise every configured check and print one JSON object:

```json
{
  "status": "passed",
  "checks": [
    { "id": "local-login", "executed": true, "passed": true },
    { "id": "authenticated-feature", "executed": true, "passed": true }
  ]
}
```

Exit zero is necessary but insufficient. Missing, duplicate, skipped and failed
assertions cannot pass. Use real login and authenticated feature requests, not
just a port probe or homepage HTTP 200. Verifier semantics remain trusted profile
code; Rocky cannot prove that a dishonest verifier performed its assertions.

A verifier can return `{"status":"blocked","reason":"credentials"}` (also
`permission`, `external`, or `unsupported`), or
`{"status":"failed","reason":"product"}`. These preserve the distinction
between missing environment support, human/external requirements, and a product
defect. Human and product blockers are not blindly retried as setup failures.
A product blocker from a prerequisite verifier stops with its classification;
ordinary executed UI defects still use the existing product review/fixer flow.
Do not use simulated fixture success to claim a real integration works.

The supervisor captures verifier output only in memory, then writes a temporary
0600 receipt containing allowlisted status/reason and configured assertion IDs and
booleans. Arbitrary stdout/stderr and unknown fields never enter that receipt,
agent context, or journal. The receipt file is removed after use. Regular catalog
commands outside environment provisioning retain the existing runner redaction
behavior. As with other local commands, a configured script can itself write files;
Rocky cannot prevent that merely by sanitizing its captured output.

## Services, endpoints and cleanup

Commands and services can declare endpoint injection:

```json
"endpointEnv": {
  "API_URL": { "service": "app/backend", "endpoint": "http" }
}
```

A service must also declare the referenced service in `dependsOn`. Dependencies
start first, and actual resolved endpoints are injected into dependent service and
verifier environments. Assigned ports are OS-chosen per launch, with in-process
leases; there are no offsets or machine-specific paths. The close/bind handoff
cannot be atomic for arbitrary applications. A losing bind is handled by bounded
restart with a fresh candidate. Applications must honor the assigned port or use
a supported dynamic endpoint locator.

Versioned local environments accept credential-free loopback HTTP(S) endpoints
without query strings/fragments. JSON endpoint files must be refreshed on launch;
a pre-existing file pointing at another live server is not fresh evidence.
Readiness checks process liveness as well as HTTP response. Capabilities then
verify dependencies, authentication, fixtures and feature access as configured.

Only the current execution's process groups are stopped. A replayed cleanup receipt
is never substituted for stopping a newly restarted process. The verified path
does not execute arbitrary service `stop` scripts or remove persistent databases.
Onboarding removes only its own disposable clones. Explicit container lifecycle,
persistent services, and destructive teardown need a separately authorized adapter
or recipe; Rocky does not automatically delete them.

Service output is filtered before writing logs: only credential-free loopback URL
origins are retained. Raw logs are intentionally not environment evidence. Output-regex
locators extract named URL or numeric-port captures inside the supervised filter;
only the endpoint name and normalized URL origin are retained. URL captures that
require a non-root path need an assigned-port, JSON-file, or command locator
instead. Avoid secret-bearing URL paths. Executable
endpoint resolvers retain the existing local resolver mechanism; prefer assigned
ports and explicit dependency endpoint injection for profile environment settings.

## Onboarding and Run behavior

“Verify saved environment” verifies the saved unified profile's baseline in fresh
clones of the locally available configured base revisions. It neither changes the
source checkout nor saves a new profile. The local API is
`GET/POST /api/profiles/:id/verify-environment`, protected by the existing local API
mutation guards. Jobs expose discovering, provisioning, verifying, repairing,
ready, and blocked states, assertion/recipe evidence and actionable blockers.
Onboarding endpoints are historical evidence from disposable services, not URLs
that remain live after the job finishes. Runs verify again.

Onboarding jobs interrupted by daemon loss become blocked and require a new
verification job. Run verification uses the normal journal and supervised runner.
Run contexts carry current endpoints, verified capability IDs/checks, repository
and source references, authentication references, fixture provenance and unverified
capability limitations. UI `ok` results in the new schema require `executed: true`;
unreachable/unexecuted checks have a `blocked` result, never a fabricated pass.

An ensure request defaults to 120 seconds and one repair, with hard ceilings of
600 seconds and two repairs. A repeated blocker stops the loop. Authorized setup,
service restart and live re-verification are the repair actions; no product-code
fixer is invoked. UI inspection has one additional environment restart/recheck
allowance, independent of the product review cap. Unavailable credentials,
permissions and external dependencies stop immediately. Scripts remain bounded
by their own configured timeout and the remaining request budget.

## Journals and migration

Only newly materialized unified Run snapshots get `environmentVersion: 1`.
Existing snapshots without this marker retain the legacy Step order and startup
behavior. Their old journals are not rewritten. New unified Runs without baseline
capability recipes block with a configuration action; discovery alone is not a
migration to verified support. Profile configuration itself stays version 1, with
optional additive environment fields.

An implementation stop saying baseline capabilities are missing means the Run has
no configured baseline verifier; it does not mean the network disconnected or the
model ran out of tokens. Configure source-backed baseline capabilities and their
executable verification commands in the profile, then verify the saved environment.
For the existing Run, use **Repair configuration and resume** with the corrected
repository catalog. Saving a profile alone does not change its frozen snapshot.
Older Rocky builds may mask this blocker with `Implement & open draft: no connection
for exhausted.` Upgrade/restart Rocky and retry that failed Run once to reach the
recoverable configuration stop, then apply the repair.

The existing “Repair configuration and resume” operation now accepts an `execution`
repository array as an alternative to legacy UI settings. It validates the complete
catalog and preserves repository IDs, names, remotes and base branches. Apply it
at the exhausted boundary; it changes this Run's recipes, not the live profile.
The existing append-only retry marker carries the revision, and the coordinator
applies it only after replaying the original stop. Completed implementation and
unaffected review Steps remain intact; affected environment/UI work gets new Steps.
Update the profile separately if future Runs should use the same recipe.

Environment receipts include version, attempt and a recipe digest. Background
setup/probes/services restart on working Boots through the runner, with fresh endpoints; recorded
receipts select the old replay path. Poll Boots consume those receipts without
launching probes, checking stale endpoints, or inspecting/signalling historical
process IDs. A resolved wait queues a working Boot, which verifies live state
before continuing. If a previously passed check is now unavailable
during replay, Rocky fails closed rather than inserting a different branch into
settled history or treating old evidence as current success. Restore the prerequisite
and retry the failed Boot. Automatic arbitrary configuration synthesis and selective
rewriting of already-settled journal branches are intentionally unsupported.

## Remaining scope

Browser installation, MCP authentication/configuration, migrations and fixture
creation require repository-backed commands and authorized profile tool access.
No new machine-wide package-manager or MCP installer is supplied. The inspector
reports absent tools/access as blockers. Required fixture coverage still depends
on the configured capabilities and triage selecting the task-specific recipes.
Custom workflows using raw commands/service nodes do not automatically acquire
delivery's environment orchestration; they must opt into the shared module.
Legacy TypeScript seed-PR onboarding is unchanged; profile onboarding uses the new
verification job. No live niotix profile, daemon, installed build, Run or PR was
modified to test this design.
