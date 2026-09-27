# Attraccess environment adapter

This package prepares the frozen Attraccess `afa58e8a5eadfb340f317e6ec3227af0cf9b6c54` environment under `.qualification/attraccess`. It does not authorize target development. Taskbot #21 permits only disposable dependency, generated, fixture and runtime writes. The protected environment contract is `acceptance/environment/manifest.json` v1.0.1, SHA256 `a63f0b550ae355440b36a71b55c28cc1ed6e19219603340ff809a3283a223177`.

## Preparation and execution

Run from the exact Rocky worktree on branch `rocky-next`, using pinned host Node24.16.0/npm11.13.0:

```sh
npm ci --ignore-scripts
npm run typecheck
npm run build
npm test
node scripts/prepare-attraccess.mjs
ROCKY_ADAPTER_ROOT=/absolute/package-smoke/installation/node_modules/@jappymondo/rocky-next \
  node scripts/prepare-attraccess-runtime.mjs .qualification/attraccess/prepare-TIMESTAMP
```

After committing the checked source, run `npm run build && npm run smoke`; use the retained installed package root from the smoke receipt for final live preparation. Builds refuse a matching live adapter process marker, and installed artifacts are kept immutable. Never rebuild while live preparation is running.

Every script creates a unique attempt directory, SQLite run/command/outbox journal, bounded command logs, immutable content-addressed evidence and an outcome file. Failure is retained; a later attempt never overwrites it. Image preparation copies an independent detached Git snapshot, preserving existing commit/tree metadata without target commits, branches, shared writable links or parent-repository discovery. The build context wraps `source/` so the target's production `.dockerignore` cannot remove protected source files. The Dockerfile uses the target's development dependency stage, exact Node24.19.0 and pnpm10.34.5, and a pinned Node image. Full production/firmware build is outside this environment gate.

`prepared-runtime.json` supplies the actual immutable images, full source inventory, installed browser executable and built Shelly ZIP. A preparation receipt is not qualification success. The independent evaluator (#27) must bind these values, exact installed Rocky build, its own scenario/fixture file inventories, selectors/DTOs, commands and limits. Reviewer #28 separately approves the final artifact hash. No qualification is authorized by this document or an implementer receipt.

```js
import { AttraccessEnvironment } from "@jappymondo/rocky-next";
const environment = new AttraccessEnvironment(prepared, "E01-attempt-1", {
  purpose: "qualification",
  admissionPath,
  approval,
});
try {
  const session = await environment.provision("admin_resources");
  const readiness = await environment.start(session);
  const fixtures = await environment.provisionAccounts(session);
  await environment.runScenario(
    session,
    {
      id: "E01",
      locale: "en",
      viewport: { width: 1440, height: 900 },
      admissionPath,
      approval,
    },
    async (browser, currentSession) => {
      // Independent evaluator owns all product assertions and classifications.
      // browser.page/context are real Playwright objects; screenshot(name) masks
      // common secret controls. Raw trace and credentials remain private.
    },
  );
  await environment.verifySource(session);
} finally {
  await environment.stop();
}
```

Omitting authority selects preparation mode, which refuses `runScenario`. Qualification validates the reviewed binding before creating resources and again before each scenario. The evaluator is trusted code; a callback is not a security sandbox. It must retain its independently reviewed file identity and cannot use an arbitrary replacement callback as evidence.

Public controls: `api(session)`, `isolationProbe(session)`, `restart(session,{pluginMode:'enabled'|'disabled'})`, `fault(session,'service-death'|'cancel'|'browser-timeout'|'storage-exhaustion')`, `exec(session,args)`, `readiness(session)`, `verifySource(session)`, `stop()`. `provision` optionally takes explicit owned host ports for collision testing; Docker must refuse an occupied foreign port. No operation accepts a foreign PID for signaling. `environment.api(session)` returns an `ApiSession` whose request initiation is fenced by the durable lease. It provides cookie-based local requests/JSON/login; it accepts only explicit `http://127.0.0.1:PORT` origins and rejects redirects. Independent observers must use the session's mapped origin.

## Isolation and lifecycle

The app and Mailpit use an owned internal network. The app is created with that permanent network as its primary Docker network and the `app` alias. Dependency bootstrap adds a temporary preparation-network attachment, disconnected and removed before serve. Docker retains the creation-time network mode across container restarts, so the primary network must outlive all enabled, disabled and re-enabled plugin instances. Docker29 does not publish ports for internal-only containers. A small owned read-only forwarding container therefore joins an ingress bridge and internal network. Its only destinations are the fixed app3000/frontend4200/Mailpit8025 endpoints; it does not accept arbitrary destinations. Only its three ingress ports publish explicitly on `127.0.0.1`. No SMTP host port, host network, Docker socket mount, shared service or Compose startup is used. Runtime negative-egress evidence must use an owned external-side sentinel, never a LAN/device probe.

Docker mutations have durable outbox intents before dispatch. Each attempt uses a unique ownership label; cleanup re-discovers resources by that label to reconcile a create whose response was lost, inspects exact ownership before removal, and records empty owned-container/network listings afterward. A detached guardian expires the durable lease and cleans only those labels. The app's PID1 helper independently exits when its read-only ownership heartbeat expires. Only target fixture data is writable in the app mount; the foundation SQLite journal, guardian scripts and browser trace/artifact directories stay outside it. The ingress script is mounted read-only. Browser process identity is retained for guardian cleanup; ordinary close retains its private trace and closes the actual browser server.

Numeric limits are exported as `LIMITS` and bound in admission: setup30min, serve4min, browser2min, teardown30s, command cleanup3s, log8MiB, app memory8GiB/CPU4/PIDs512, one browser context, lease10s and minimum20GiB host free space. The temporary `/fault` filesystem is64KiB: exhaustion writes only there, never fills host storage. Native Nx modules load from generated `/app/.nx/native`; default `/tmp` is non-executable and cannot load native `.node` cache files. App service output is capped8MiB; private raw trace/browser artifacts are retained. Run cycles sequentially and remove owned container writable layers after each cycle; reuse immutable images. Preserve source snapshots, DBs, logs, traces and failed attempt evidence. If the20GiB gate fails, stop; never prune unrelated resources or delete retained evidence to force admission.

## Fixtures and source checks

Admin/resource fixtures use the real seed with explicit `--db /app/storage/cycle/attraccess.sqlite`. The seed always grants administrator, so member/denied/fresh2FA users register through the real API and verify their own exact-recipient Mailpit message. Message selection captures prior IDs, parses HTML anchors, requires configured frontend origin, `/verify-email`, exact email and one unique token. Private seed stdout/passwords, cookies, email tokens and TOTP material are never public evidence. Member receives only the additional `resources.update` role; denied receives no such grant. The evaluator verifies actual effective permissions and resource/group linkage.

The current target migration removes the legacy `frontend_url` setting. Set `ATTRACCESS_URL` and `ATTRACCESS_PUBLIC_INTERNET_URL` to the mapped frontend app origin; its Vite proxy serves `/api`. Direct API probes still use the separately mapped API origin. Email links derive from the main application URL, and exact-origin matching must not be weakened. Matching-recipient raw messages are retained privately before parsing.

Fresh install omits the seed and app URL/license/SMTP preseeds. Configure all settings before creating the admin: source `first-time-setup` POST requires zero users. The repository community fixture key must yield actual license validity. Fresh2FA uses a new verified account and actual UI enrollment, never a reused secret. Account controls mount only after opening their SettingsDirectory row.

Shelly comes from the real `plugin-shelly:zip` target. Upload schedules an API restart: supported `RESTART_BY_EXIT=true` prevents a detached replacement. Explicit adapter restart kills the complete owned container before a fresh serve, retains DB/plugins, and requires fresh readiness. Disabled mode sets `DISABLE_PLUGINS=true`; enabled mode removes it completely. A false string is not a safe equivalent. Device/firmware registry GETs are permitted only while empty; no add/discovery/probe/firmware/hardware traffic. Frontend navigation can remain when backend plugins are disabled; this is source behavior, not a promised disappearance.

Before bootstrap and after preparation/scenarios, verify all3468 frozen source bytes and modes inside `/app`, exact detached Git root/commit/tree, and enumerate generated outputs against the declared list. Also verify the original read-only checkout before/after. `.dev-serve-ports.json` must agree with actual mapped endpoints and fresh HTTP/browser responses. File existence alone is insufficient. Later coding checks still require frozen base/head affected core lint/typecheck/test/e2e, CRAP, applicable plugin/generator/packaging/firmware/guard and current-head CI receipts; this environment gate does not replace them.

## Dependency evidence

Playwright1.58.2 Chromium extraction hung on pinned host Node24.16.0. Its failed archive, sample and foundation cancellation are retained. [Upstream issue41000](https://github.com/microsoft/playwright/issues/41000) reports the exact Node24.16.0 extraction hang and successful1.60.0 workaround; [official1.60.0 release](https://github.com/microsoft/playwright/releases/tag/v1.60.0) establishes the pinned release. Actual1.60.0 extraction, Chrome148.0.7778.96 launch/version, executable hash, trace and process shutdown are separate preparation evidence. This dependency repair precedes admission and does not change qualification retry caps.

The Nx cache relocation is a [documented environment setting](https://nx.dev/docs/reference/environment-variables), independently confirmed in the pinned installed loader. The internal-network publication limitation is tracked in [Moby discussion53256](https://github.com/moby/moby/discussions/53256); [Docker port-publishing documentation](https://docs.docker.com/engine/network/port-publishing/) describes loopback publication. Actual topology/ingress/negative-egress receipts remain required.

## Review repairs and recovery evidence

Cleanup uses one aggregate 30-second deadline across browser shutdown and every Docker operation. Each Docker client receives only the remaining budget and is killed with SIGKILL at its timeout. Concurrent parent/guardian cleanup is serialized by a process-identity lock; only a dead holder can be displaced. Missing already-removed resources are idempotent. Every attempt retains its own receipt; missing final listings mean unknown remaining resources, never success. `stop()` always closes the command store, renewal timer and active build marker, including failure. An incomplete stop rejects with `CleanupIncomplete.receipt`; calling `stop()` again performs bounded reconciliation, while successful stop is cached.

The guardian has one explicitly separate recovery window, at most the existing 30-second teardown budget, after ownership expiry. Its receipts record deadline, attempts and complete versus reconciliation-required. This is crash recovery, not an extension that turns failed teardown into a passing ENV13 result or adds qualification retries. If Docker remains unavailable, the guardian exits with durable incomplete state; a later explicit `cleanOwned(ownership)` reconciliation must obtain empty-resource proof. Each attempt independently preserves errors and remaining-resource uncertainty.

Standalone image probes and runtime namespace probes have stable labeled container names persisted before a durable create/start intent. They never rely on `docker run --rm` or host-client death as daemon cleanup proof. `OwnedProbes` starts an independent guardian, captures logs and exit status, and reconciles its label even if create/start responses were lost. Preparation scripts accept `ROCKY_ADAPTER_ROOT` for the immutable installed package. `tests/owned-recovery.mjs` performs supporting real-Docker delay, lost-response and parent/client-death regressions against receipt-owned resources while preserving a separate sentinel; it is not product qualification.

Admission rehashes every compiled file and recomputes the build manifest identity, rejecting added/missing/changed files. It also binds complete resolved production dependency trees, including actual Playwright/playwright-core executable implementation and optional installed dependencies; package metadata alone is insufficient. Required binding fields are `installedBuildInventorySha256`, `runtimeDependenciesSha256`, `driverTreeSha256` and `runtimePackageSha256`, produced by `runtimeIntegrity()`. Every scenario revalidates these fields before execution. Source inventory and both container/host verifiers share normalized regular/executable/symlink mode checks in both directions.

Screenshots mask read-only plaintext inputs (the frozen target's TOTP secret `TextField isReadOnly`), SVG/canvas QR renderings, password and OTP controls. `otpauthUrl` is redacted in durable HTTP receipts; raw traces remain private. `fault(session,'browser-timeout')` executes an actual bounded Playwright `waitForFunction(() => false)` and returns the observed TimeoutError and elapsed time without killing the browser. `browser-death` is the separate explicit close control. This supporting timeout mechanism is available to the independent evaluator; only its reviewed X04 assertions can establish qualification behavior. Primary API references: [Playwright waitForFunction](https://playwright.dev/docs/api/class-page#page-wait-for-function) and [Node execFile timeout/killSignal](https://nodejs.org/api/child_process.html#child_processexecfilefile-args-options-callback).

### Pending Docker transport reconciliation (S2-R)

Every Docker mutation first persists its immutable request and outbox intent. Actual dispatch runs in a detached receipt keeper that checks the same fenced lease again immediately before starting Docker. Its worker identity, client observation, dispatch record and terminal outcome survive preparer death; its live process marker also prevents replacement of the loaded build. The keeper uses the original operation timeout and does not renew cancelled work. It has one dispatch only, with bounded output, and exits after persisting its terminal outcome. An unstarted keeper cannot cross the Store guard after cleanup commits cancellation.

Cleanup seals the run through the Store API before scanning labels. It reads durable outbox and transport state and records `pendingMutations` in every cleanup receipt. Empty labels while a create is still pending are explicitly INCOMPLETE. Cleanup waits within its existing shared deadline for a terminal transport outcome, then removes the owned resources. A lost create response requires positive stable-name plus ownership-label observation; instantaneous absence or client death is never proof that Docker aborted a request. The observation is persisted before removal. Confirmed terminal non-creating operations cannot materialize a new resource after removal, while their uncertain business effect stays unresolved in the outbox.

If the keeper dies or the daemon outcome remains unknown, `stop`/`close` rejects, never writes `stopped.json` and never caches success. The guardian's existing separate bounded recovery window retains reconciliation-required state if uncertainty persists. Manual later reconciliation must resolve that uncertainty before claiming cleanup; no policy timeout or qualification retry allowance grows. Store has an optional 1–5000ms busy timeout with its original 5000ms default unchanged; cleanup uses 1ms so SQLite writer contention cannot hide a five-second wait beyond the shared deadline.

`tests/late-create-recovery.mjs` holds an actual receipt-owned Docker create in its transport, triggers cancellation or kills the preparer, observes an empty INCOMPLETE cleanup receipt, and only then releases the create. It verifies terminal receipt, removal, keeper/client exit and a foreign sentinel's survival. `tests/mutation-recovery.test.mjs` separately tests unresolved/unknown create outcomes and a real SQLite writer lock. These are supporting regressions, not qualification cycles.

Supporting restart regression (preparation only): `ROCKY_ADAPTER_ROOT=<clean installed package> node tests/attraccess-restart.mjs`. It retains every attempt under `.qualification/attraccess/repair36-restart-*`, uploads the exact frozen Shelly ZIP, observes automatic API exit, and checks three explicit restarts, actual instance changes, runtime topology and routes, controlled negative egress, source integrity, and foreign-sentinel survival through normal cleanup. It imports no independent evaluator code and grants no qualification approval.

Each `pnpm serve` generation sets the supported `NX_WORKSPACE_DATA_DIRECTORY` to its own `/app/.nx/rocky-service-<sequence>` directory, recorded in service-generation, process and readiness receipts. Restarting a container resets its PID namespace while retaining its writable layer; reusing Nx running-task records can mistake a new PID/command for an old live task. Fresh generated state avoids that collision without deleting prior state or changing target source. See [Nx environment variables](https://nx.dev/docs/reference/environment-variables).
