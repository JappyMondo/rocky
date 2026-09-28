import test from "node:test";
import assert from "node:assert/strict";
import {
  fixture,
  migratedBudgets,
  apply,
  result,
  receipt,
  baseline,
  finish,
  implemented,
  versions,
  capability,
  coordinatorModule,
  retain,
} from "./coordinator-support.mjs";
const {
  Store,
  identity,
  validateEvent,
  validateAction,
  validateSnapshot,
  validateScope,
} = coordinatorModule;
let seq = 0;
function begin(f, kind, key = `collector-${++seq}`) {
  return f.store.beginCoordinatorObservation?.(f.lease, kind, key);
}
function queue(f, kind, outcome, observation = begin(f, kind)) {
  const s = f.store.coordinatorSnapshot(f.lease.runId),
    id = `queued-${++seq}`;
  const data = {
    schema: 1,
    kind,
    inputs: {
      head: s.head,
      base: s.scope.base,
      scope: identity(s.scope),
      scenario: "local-regression",
      fixture: "synthetic",
      command: kind,
      toolchain: "node24",
      build: s.versions.build,
      checkPlan: s.checkPlan,
      coordinatorInput: s.inputDigest,
    },
    outcome,
    artifacts: [],
    signature: `${kind}-${outcome}`,
    diagnostics: "available",
    ...(observation ? { observation } : {}),
  };
  const ref = f.evidence.record(data);
  f.store.registerCoordinatorReceipt(f.lease, id, kind, f.evidence, ref);
  return { id, ref, data, observation };
}
function consume(f, q) {
  return f.store.applyCoordinator(
    f.lease,
    f.store.coordinatorSnapshot(f.lease.runId).revision,
    "evidence",
    q.id,
  );
}

test("R1 superseded same-input CI/check/review pass cannot overwrite newer failed attempt or restore handoff", () => {
  for (const kind of ["ci", "checks", "review"]) {
    const f = fixture(`R1-${kind}`);
    implemented(f);
    receipt(f, "ci");
    receipt(f, "review");
    const old = queue(f, kind, "pass");
    const failed = queue(f, kind, "fail");
    consume(f, failed);
    assert.throws(() => consume(f, old), /superseded-observation/);
    assert.equal(
      f.store.coordinatorSnapshot("run-1").receipts[kind].outcome,
      "fail",
    );
    assert.notEqual(
      f.store.coordinatorSnapshot("run-1").stage,
      "handoff_ready",
    );
    retain(f, { old, failed, snapshot: f.store.coordinatorSnapshot("run-1") });
    f.store.close();
  }
});
test("R2 review/approval must refer to the actual evidence bundle, even with same code and a fresh inbox ID", () => {
  for (const changed of ["checks", "ci"]) {
    const f = fixture(`R2-${changed}`);
    implemented(f);
    receipt(f, "ci");
    const old = queue(f, "review", "pass");
    receipt(f, changed);
    assert.throws(() => consume(f, old), /stale-evidence-bundle/);
    assert.equal(
      f.store.coordinatorSnapshot("run-1").receipts.review,
      undefined,
    );
    receipt(f, "review");
    const approval = queue(f, "approval", "pass");
    receipt(f, "review", "fail", "new blocking review");
    assert.throws(() => consume(f, approval), /stale-evidence-bundle/);
    assert.notEqual(
      f.store.coordinatorSnapshot("run-1").stage,
      "handoff_ready",
    );
    f.store.close();
  }
});
test("R3 all noncoding actions retain their resume stage through wait/drain/reopen/wake", async (t) => {
  for (const kind of [
    "baseline",
    "verify",
    "observe_ci",
    "review",
    "retry_environment",
    "arbitrate",
  ])
    await t.test(kind, () => {
      let now = 1000;
      const f = fixture(`R3-${kind}`, () => now);
      if (kind === "verify") {
        baseline(f);
        apply(f.store, f.lease, { type: "schedule", kind: "implement" });
        finish(f, { outcome: "changed", head: "head-2" });
      }
      if (["observe_ci", "review", "arbitrate"].includes(kind)) implemented(f);
      if (kind === "retry_environment")
        apply(f.store, f.lease, {
          type: "block",
          kind: "environment",
          detail: "fixture unavailable",
        });
      if (kind === "arbitrate") receipt(f, "review", "fail");
      const scheduled = apply(f.store, f.lease, { type: "schedule", kind });
      apply(f.store, f.lease, {
        type: "wait",
        reason: "external response",
        wakeAt: 1500,
        deadline: 4000,
      });
      finish(f);
      const waiting = f.store.coordinatorSnapshot("run-1");
      assert.equal(waiting.wait.resume, scheduled.stage);
      assert.equal(f.store.implementationSlot(), null);
      f.store.release(f.lease);
      f.store.close();
      now = 1500;
      const reopened = new Store(f.dir + "/state.sqlite", () => now);
      const lease = reopened.claim("run-1", "reopened", versions, 10000);
      const awake = apply(reopened, lease, { type: "wake" });
      assert.equal(awake.stage, scheduled.stage);
      assert.equal(awake.wait, null);
      assert.equal(awake.workspace, scheduled.workspace);
      reopened.close();
    });
});
test("R4 runtime enums reject arrays/objects/numbers at public entrypoints without spending or storing them", () => {
  const f = fixture("R4");
  const before = f.store.coordinatorSnapshot("run-1");
  for (const value of [["schedule"], { value: "schedule" }, 0, null])
    assert.throws(() =>
      f.store.ingestCoordinator("run-1", "scheduler", `type-${++seq}`, {
        type: value,
        kind: "baseline",
      }),
    );
  for (const value of [["baseline"], { value: "baseline" }, 0, null])
    assert.throws(() =>
      f.store.ingestCoordinator("run-1", "scheduler", `kind-${++seq}`, {
        type: "schedule",
        kind: value,
      }),
    );
  for (const source of [["scheduler"], { value: "scheduler" }, 0, null])
    assert.throws(() =>
      f.store.ingestCoordinator("run-1", source, `source-${++seq}`, {
        type: "schedule",
        kind: "baseline",
      }),
    );
  assert.deepEqual(f.store.coordinatorSnapshot("run-1"), before);
  assert.equal(f.store.implementationSlot(), null);
  const s = apply(f.store, f.lease, { type: "schedule", kind: "baseline" });
  for (const v of [["complete"], { value: "complete" }, 0, null])
    assert.throws(() =>
      f.store.ingestCoordinator(
        "run-1",
        "transport",
        `outcome-${++seq}`,
        result(s, { outcome: v }),
      ),
    );
  assert.throws(() => validateAction({ ...s.execution, kind: ["baseline"] }));
  assert.throws(() => validateSnapshot({ ...s, stage: ["baseline"] }));
  assert.throws(() =>
    validateSnapshot({ ...s, blocker: { kind: ["environment"], detail: "x" } }),
  );
  assert.throws(() => validateScope({ ...s.scope, deliveryMode: ["pr-only"] }));
  assert.throws(() =>
    validateEvent(
      { type: "block", kind: ["environment"], detail: "x" },
      "control",
    ),
  );
  f.store.close();
});
test("R5 an action observed past deadline cannot dispatch after raw-clock rollback", async () => {
  let now = 1000;
  const f = fixture("R5", () => now);
  const s = apply(f.store, f.lease, { type: "schedule", kind: "baseline" });
  now = 2100;
  apply(f.store, f.lease, { type: "tick" });
  now = 1500;
  let calls = 0;
  await assert.rejects(
    () =>
      f.store.dispatchCoordinator(f.lease, s.execution.key, {
        versions,
        capability,
        begin: async () => {
          calls++;
          return result(s);
        },
        interrupt() {},
      }),
    /action-deadline-exceeded|action-no-longer-dispatchable/,
  );
  assert.equal(calls, 0);
  assert.equal(f.store.effect(s.execution.key).state, "pending");
  assert.ok(f.store.implementationSlot());
  const after = apply(f.store, f.lease, { type: "tick" });
  assert.equal(after.budgets.observedAt, 2100);
  assert.equal(after.budgets.elapsedMs, 1100);
  f.store.close();
});

test("R6 collector issuance survives lost reply/reopen; retries and duplicate receipts cannot advance generations or erase current review", () => {
  const f = fixture("R6");
  implemented(f);
  const token = begin(f, "ci", "stable-action/ci/1");
  const issued = f.store.coordinatorSnapshot("run-1");
  const history = f.store.events("run-1");
  assert.deepEqual(begin(f, "ci", "stable-action/ci/1"), token);
  assert.deepEqual(f.store.coordinatorSnapshot("run-1"), issued);
  assert.deepEqual(f.store.events("run-1"), history);
  f.store.close();
  f.store = new Store(f.dir + "/state.sqlite", () => 1000);
  assert.deepEqual(begin(f, "ci", "stable-action/ci/1"), token);
  const old = queue(f, "ci", "pass", token);
  consume(f, old);
  receipt(f, "review");
  const reviewed = f.store.coordinatorSnapshot("run-1");
  f.store.registerCoordinatorReceipt(
    f.lease,
    "redelivered-ci",
    "ci",
    f.evidence,
    old.ref,
  );
  const duplicate = f.store.applyCoordinator(
    f.lease,
    reviewed.revision,
    "evidence",
    "redelivered-ci",
  );
  assert.deepEqual(duplicate.receipts, reviewed.receipts);
  assert.equal(duplicate.stage, "handoff_ready");
  assert.throws(
    () => queue(f, "ci", "fail", token),
    /observation-result-conflict/,
  );
  const next = begin(f, "ci", "stable-action/ci/2");
  assert.equal(next.generation, token.generation + 1);
  const after = f.store.coordinatorSnapshot("run-1");
  assert.equal(after.receipts.ci, undefined);
  assert.equal(after.receipts.review, undefined);
  assert.deepEqual(begin(f, "ci", "stable-action/ci/1"), token);
  assert.deepEqual(f.store.coordinatorSnapshot("run-1"), after);
  assert.throws(() => queue(f, "ci", "pass", token), /superseded-observation/);
  consume(f, queue(f, "ci", "fail", next));
  assert.equal(
    f.store.coordinatorSnapshot("run-1").receipts.ci.outcome,
    "fail",
  );
  retain(f, { token, next, snapshot: f.store.coordinatorSnapshot("run-1") });
  f.store.close();
});
test("R7 observation issuance rolls back its token/invalidation/revision/event atomically", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const f = fixture("R7");
  implemented(f);
  receipt(f, "ci");
  receipt(f, "review");
  const before = f.store.coordinatorSnapshot("run-1"),
    events = f.store.events("run-1");
  const sql = new DatabaseSync(f.store.path);
  sql.exec(
    "CREATE TRIGGER fail_observation BEFORE INSERT ON coordinator_receipts WHEN NEW.kind='observation' BEGIN SELECT RAISE(ABORT,'injected-observation-failure'); END;",
  );
  assert.throws(
    () => begin(f, "ci", "new-attempt"),
    /injected-observation-failure/,
  );
  assert.deepEqual(f.store.coordinatorSnapshot("run-1"), before);
  assert.deepEqual(f.store.events("run-1"), events);
  sql.exec("DROP TRIGGER fail_observation");
  const token = begin(f, "ci", "new-attempt");
  assert.equal(token.generation, before.observations.ci.generation + 1);
  sql.close();
  f.store.close();
});
test("R8 schema2 owned copy migrates to schema7/snapshot3 with retained old evidence; ec9a0cd reader rejects the new DB", async () => {
  const { copyFileSync, readFileSync } = await import("node:fs");
  const { DatabaseSync } = await import("node:sqlite");
  const { admission } = await import("./coordinator-support.mjs");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { execFileSync } = await import("node:child_process");
  const { dirname } = await import("node:path");
  const ts = (await import("typescript")).default;
  const f = fixture("R8");
  f.store.close();
  const oldRoot = f.dir + "/ec9a0cd-reader";
  for (const file of [
    "store/index",
    "store/json",
    "config/index",
    "evidence/index",
    "coordinator/contracts",
    "coordinator/reducer",
  ]) {
    const source = execFileSync(
      "git",
      ["show", `ec9a0cd88ed70e0ebfc622cd6a4ff93357078453:src/${file}.ts`],
      { encoding: "utf8" },
    );
    const target = `${oldRoot}/${file}.js`;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(
      target,
      ts.transpileModule(source, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ES2022,
        },
      }).outputText,
    );
  }
  const previous = await import(oldRoot + "/store/index.js");
  const path = f.dir + "/old-v2.sqlite";
  const old = new previous.Store(path, () => 1000);
  old.admitCoordinator(admission());
  const lease = old.claim("run-1", "old", versions, 10000);
  for (const kind of ["checks", "ci", "review"]) {
    const s = old.coordinatorSnapshot("run-1");
    const data = {
      schema: 1,
      kind,
      inputs: {
        head: s.head,
        base: s.scope.base,
        scope: identity(s.scope),
        scenario: "old",
        fixture: "old",
        command: kind,
        toolchain: "node",
        build: s.versions.build,
        checkPlan: s.checkPlan,
        coordinatorInput: s.inputDigest,
      },
      outcome: "pass",
      artifacts: [],
      signature: "old-pass",
      diagnostics: "available",
    };
    const ref = f.evidence.record(data);
    old.registerCoordinatorReceipt(lease, kind, kind, f.evidence, ref);
    old.applyCoordinator(lease, s.revision, "evidence", kind);
  }
  const snapshot = old.coordinatorSnapshot("run-1"),
    events = old.events("run-1");
  assert.equal(snapshot.stage, "handoff_ready");
  old.close();
  const bytes = readFileSync(path);
  copyFileSync(path, f.dir + "/migration-copy.sqlite");
  const upgraded = new Store(f.dir + "/migration-copy.sqlite", () => 1000);
  const after = upgraded.coordinatorSnapshot("run-1");
  assert.equal(after.schema, 3);
  assert.deepEqual(after.receipts, {});
  assert.deepEqual(after.observations, {});
  assert.equal(after.stage, "verifying");
  assert.deepEqual(after.budgets, migratedBudgets(snapshot.budgets));
  const newEvents = upgraded.events("run-1");
  assert.deepEqual(newEvents.slice(0, events.length), events);
  assert.deepEqual(newEvents.at(-1).data.previous, snapshot);
  upgraded.close();
  assert.deepEqual(readFileSync(path), bytes);
  assert.throws(
    () => new previous.Store(f.dir + "/migration-copy.sqlite"),
    /incompatible-store-schema/,
  );
  const sql = new DatabaseSync(f.dir + "/migration-copy.sqlite");
  assert.equal(sql.prepare("PRAGMA user_version").get().user_version, 8);
  sql.close();
  retain(f, { snapshot, after, event: newEvents.at(-1) });
});
test("R9 clock rollback cannot restore exhausted total budget after explicit input revision", () => {
  const f = fixture("R9");
  let s = f.store.coordinatorSnapshot("run-1");
  f.store.close();
  let now = 1000;
  f.store = new Store(f.dir + "/state.sqlite", () => now);
  now = 1000 + s.limits.totalElapsedMs; // claim a fresh valid lease at the later wall time
  f.lease = f.store.claim("run-1", "late", versions, 1000000);
  s = apply(f.store, f.lease, { type: "tick" });
  assert.equal(s.blocker.kind, "budget");
  now = 1500;
  s = apply(f.store, f.lease, {
    type: "revise",
    head: "revised",
    scope: s.scope,
    checkPlan: s.checkPlan,
  });
  s = apply(f.store, f.lease, { type: "schedule", kind: "verify" });
  assert.equal(s.blocker.kind, "budget");
  assert.equal(s.execution, null);
  assert.equal(s.budgets.elapsedMs, s.limits.totalElapsedMs);
  f.store.close();
});
