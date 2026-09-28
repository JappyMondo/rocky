export const coordinatorModule = await import(
  process.env.COORDINATOR_TEST_MODULE ?? "../dist/index.js"
);
const { Store, Evidence, identity } = coordinatorModule;
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
export const versions = {
  workflow: "coordinator-1",
  adapter: "test-only",
  prompt: "1",
  runner: "injected-contract-only",
  build: "local-test",
};
export const capability = {
  id: "injected-contract-only-hard-limits",
  hardTokenLimit: true,
  hardElapsedLimit: true,
};
export function admission(runId = "run-1", overrides = {}) {
  return {
    runId,
    repository: "synthetic-repository",
    issue: runId,
    rerun: "first",
    previousRunId: null,
    workspace: `synthetic/${runId}`,
    versions,
    scope: {
      schema: 1,
      revision: 1,
      behavior: ["bounded change"],
      exclusions: [],
      surfaces: ["test"],
      fixtureIds: ["synthetic"],
      acceptanceManifest: "local-contract-not-holdout",
      base: "base",
      deliveryMode: "pr-only",
    },
    head: "head-1",
    checkPlan: "plan-1",
    limits: {
      totalTokens: 10000,
      totalElapsedMs: 1000000,
      actionTokens: 100,
      actionElapsedMs: 1000,
    },
    capability,
    ...overrides,
  };
}
export function fixture(name, clock = () => 1000) {
  const dir = resolve(
    process.env.COORDINATOR_ARTIFACT_ROOT ?? ".qualification/coordinator-53",
    `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  const store = new Store(`${dir}/state.sqlite`, clock);
  const input = admission();
  store.admitCoordinator(input);
  const lease = store.claim(input.runId, "owner", versions, 1000000);
  return { dir, store, lease, evidence: new Evidence(`${dir}/evidence`) };
}
let seq = 0;
export function apply(
  store,
  lease,
  event,
  source = event.type === "result"
    ? "transport"
    : ["schedule", "wake", "tick"].includes(event.type)
      ? "scheduler"
      : "control",
  id = `event-${++seq}`,
) {
  store.ingestCoordinator(lease.runId, source, id, event);
  return store.applyCoordinator(
    lease,
    store.coordinatorSnapshot(lease.runId).revision,
    source,
    id,
  );
}
export function knownUsage(tokens = 0, provider = true) {
  return {
    schema: 1,
    status: "known",
    tokens,
    source: {
      kind: provider ? "provider-receipt" : "local-no-model",
      reference: "synthetic-contract-receipt-not-provider-proof",
    },
  };
}
export function migratedBudgets(b) {
  const { reportedTokens, ...rest } = b;
  return {
    ...rest,
    knownTokens: 0,
    unknownActions: 0,
    legacyReportedTokens: reportedTokens,
  };
}
export function result(s, overrides = {}) {
  const { tokens = 0, ...other } = overrides;
  return {
    type: "result",
    actionKey: s.execution.key,
    inputDigest: s.execution.inputDigest,
    quiescent: true,
    ...(s.schema < 3 ? { tokens } : { usage: knownUsage(tokens) }),
    outcome: "complete",
    head: s.head,
    detail: "local injected transport contract",
    ...other,
  };
}
export function receipt(
  f,
  kind,
  outcome = "pass",
  signature = `${kind}-${outcome}`,
  extra = {},
) {
  const observation = f.store.beginCoordinatorObservation?.(
    f.lease,
    kind,
    `attempt-${++seq}`,
  );
  const s = f.store.coordinatorSnapshot(f.lease.runId);
  const r = {
    schema: 1,
    kind,
    inputs: {
      head: s.head,
      base: s.scope.base,
      scope: identity(s.scope),
      scenario: "local-contract",
      fixture: "synthetic",
      command: kind,
      toolchain: "node24",
      build: s.versions.build,
      checkPlan: s.checkPlan,
      coordinatorInput: s.inputDigest,
    },
    outcome,
    artifacts: [],
    signature,
    diagnostics: "available",
    ...(observation ? { observation } : {}),
    ...extra,
  };
  const ref = f.evidence.record(r);
  const id = `receipt-${++seq}`;
  f.store.registerCoordinatorReceipt(f.lease, id, kind, f.evidence, ref);
  return f.store.applyCoordinator(f.lease, s.revision, "evidence", id);
}
export function finish(f, overrides = {}) {
  return apply(
    f.store,
    f.lease,
    result(f.store.coordinatorSnapshot(f.lease.runId), overrides),
  );
}
export function baseline(f) {
  apply(f.store, f.lease, { type: "schedule", kind: "baseline" });
  finish(f);
  receipt(f, "baseline");
}
export function implemented(f) {
  baseline(f);
  apply(f.store, f.lease, { type: "schedule", kind: "implement" });
  finish(f, { outcome: "changed", head: "head-2", tokens: 50 });
  apply(f.store, f.lease, { type: "schedule", kind: "verify" });
  finish(f);
  receipt(f, "checks");
}
export function retain(f, data) {
  writeFileSync(`${f.dir}/result.json`, JSON.stringify(data, null, 2));
}
