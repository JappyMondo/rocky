import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { execFileSync } from "node:child_process";
import ts from "typescript";
import {
  fixture,
  admission,
  apply,
  baseline,
  implemented,
  finish,
  receipt,
  result,
  versions,
  capability,
  coordinatorModule,
  retain,
} from "./coordinator-support.mjs";
const { Store } = coordinatorModule;
async function legacy(name, overrides = {}) {
  const f = fixture(name);
  f.store.close();
  const root = f.dir + "/ec9a0cd-reader";
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
    const target = `${root}/${file}.js`;
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
  const OldStore = (await import(root + "/store/index.js")).Store;
  f.store = new OldStore(f.dir + "/legacy.sqlite", () => 1000);
  f.store.admitCoordinator(admission("run-1", overrides));
  f.lease = f.store.claim("run-1", "legacy-owner", versions, 1000000);
  return f;
}
function upgrade(f) {
  const before = {
    run: f.store.get("run-1"),
    snapshot: f.store.coordinatorSnapshot("run-1"),
    slot: f.store.implementationSlot(),
    events: f.store.events("run-1"),
  };
  if (before.snapshot.execution)
    before.effect = f.store.effect(before.snapshot.execution.key);
  f.store.release(f.lease);
  const path = f.store.path;
  f.store.close();
  const bytes = readFileSync(path);
  copyFileSync(path, f.dir + "/upgrade-copy.sqlite");
  f.store = new Store(f.dir + "/upgrade-copy.sqlite", () => 1000);
  assert.deepEqual(readFileSync(path), bytes);
  const after = f.store.coordinatorSnapshot("run-1");
  assert.deepEqual(after.budgets, before.snapshot.budgets);
  assert.deepEqual(after.execution, before.snapshot.execution);
  assert.deepEqual(f.store.implementationSlot(), before.slot);
  if (before.effect)
    assert.deepEqual(f.store.effect(before.effect.key), before.effect);
  f.lease = f.store.claim("run-1", "new-owner", versions, 1000000);
  return before;
}
async function stage(f, name) {
  switch (name) {
    case "admitted":
      break;
    case "baseline":
      apply(f.store, f.lease, { type: "schedule", kind: "baseline" });
      finish(f);
      break;
    case "verifying":
      baseline(f);
      apply(f.store, f.lease, { type: "schedule", kind: "implement" });
      finish(f, { outcome: "changed", head: "head-2" });
      break;
    case "awaiting_delivery_evidence":
      implemented(f);
      break;
    case "handoff_ready":
      implemented(f);
      receipt(f, "ci");
      receipt(f, "review");
      break;
    case "no_code":
      baseline(f);
      apply(f.store, f.lease, { type: "schedule", kind: "implement" });
      finish(f, { outcome: "no_code" });
      break;
    case "blocked":
      apply(f.store, f.lease, {
        type: "block",
        kind: "environment",
        detail: "fixture missing",
      });
      break;
    case "recovery_required":
      apply(f.store, f.lease, {
        type: "block",
        kind: "recovery",
        detail: "old worker ambiguous",
      });
      break;
    case "implementing":
      baseline(f);
      apply(f.store, f.lease, { type: "schedule", kind: "implement" });
      break;
    case "cancelling":
      apply(f.store, f.lease, { type: "schedule", kind: "baseline" });
      apply(f.store, f.lease, { type: "cancel" });
      break;
    case "cancelled":
      apply(f.store, f.lease, { type: "cancel" });
      break;
    default:
      throw Error(name);
  }
}
test("M1 authoritative legacy Store.cancel survives migration for idle and outstanding work", async (t) => {
  for (const outstanding of [false, true])
    await t.test(outstanding ? "outstanding" : "idle", async () => {
      const f = await legacy(`M1-${outstanding}`);
      if (outstanding)
        apply(f.store, f.lease, { type: "schedule", kind: "baseline" });
      f.store.cancel("run-1");
      assert.equal(f.store.get("run-1").cancelled, true);
      assert.equal(f.store.coordinatorSnapshot("run-1").cancelled, false);
      const before = upgrade(f);
      let s = f.store.coordinatorSnapshot("run-1");
      assert.equal(f.store.get("run-1").cancelled, true);
      assert.equal(s.cancelled, true);
      assert.equal(s.stage, outstanding ? "cancelling" : "cancelled");
      assert.throws(
        () => apply(f.store, f.lease, { type: "schedule", kind: "baseline" }),
        /cancelled/,
      );
      if (outstanding) {
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
          /cancelled/,
        );
        assert.equal(calls, 0);
        s = finish(f, { outcome: "changed", head: "never-adopt" });
        assert.equal(s.stage, "cancelled");
        assert.equal(s.head, before.snapshot.head);
        assert.equal(f.store.implementationSlot(), null);
      }
      retain(f, { before, after: s });
      f.store.close();
    });
});
test("M2 quiescent invalidated-evidence stages admit a bounded normal revalidation action", async (t) => {
  for (const [oldStage, target, kind] of [
    ["admitted", "admitted", "baseline"],
    ["baseline", "admitted", "baseline"],
    ["verifying", "verifying", "verify"],
    ["awaiting_delivery_evidence", "verifying", "verify"],
    ["handoff_ready", "verifying", "verify"],
  ])
    await t.test(oldStage, async () => {
      const f = await legacy(`M2-${oldStage}`);
      await stage(f, oldStage);
      const before = upgrade(f);
      const s = f.store.coordinatorSnapshot("run-1");
      assert.equal(s.stage, target);
      assert.deepEqual(s.receipts, {});
      const scheduled = apply(f.store, f.lease, { type: "schedule", kind });
      assert.equal(scheduled.execution.kind, kind);
      assert.equal(
        scheduled.budgets.reservedElapsedMs,
        before.snapshot.budgets.reservedElapsedMs +
          scheduled.execution.elapsedMs,
      );
      retain(f, { before, after: s, scheduled });
      f.store.close();
    });
});
test("M3 saved waits map their resume stage and preserve wake/deadline; ambiguous old waits have an explicit recovery boundary", async (t) => {
  for (const [oldStage, target, kind] of [
    ["admitted", "admitted", "baseline"],
    ["baseline", "admitted", "baseline"],
    ["verifying", "verifying", "verify"],
    ["awaiting_delivery_evidence", "verifying", "verify"],
  ])
    await t.test(oldStage, async () => {
      const f = await legacy(`M3-${oldStage}`);
      await stage(f, oldStage);
      apply(f.store, f.lease, {
        type: "wait",
        reason: "remote wait",
        wakeAt: 1500,
        deadline: 5000,
      });
      const before = upgrade(f);
      let s = f.store.coordinatorSnapshot("run-1");
      assert.equal(s.stage, "waiting_external");
      assert.equal(s.wait.resume, target);
      assert.equal(s.wait.reason, before.snapshot.wait.reason);
      assert.equal(s.wait.wakeAt, 1500);
      assert.equal(s.wait.deadline, 5000);
      f.store.release(f.lease);
      const path = f.store.path;
      f.store.close();
      f.store = new Store(path, () => 1500);
      f.lease = f.store.claim("run-1", "wake-owner", versions, 1000000);
      s = apply(f.store, f.lease, { type: "wake" });
      assert.equal(s.stage, target);
      assert.equal(
        apply(f.store, f.lease, { type: "schedule", kind }).execution.kind,
        kind,
      );
      f.store.close();
    });
  await t.test("ambiguous legacy resume", async () => {
    const f = await legacy("M3-ambiguous");
    apply(f.store, f.lease, { type: "schedule", kind: "baseline" });
    apply(f.store, f.lease, {
      type: "wait",
      reason: "old resume bug",
      wakeAt: 1500,
      deadline: 5000,
    });
    finish(f);
    assert.equal(
      f.store.coordinatorSnapshot("run-1").wait.resume,
      "waiting_external",
    );
    upgrade(f);
    const s = f.store.coordinatorSnapshot("run-1");
    assert.equal(s.stage, "recovery_required");
    assert.equal(s.blocker.kind, "compatibility");
    assert.match(s.blocker.detail, /legacy.*resume/);
    assert.equal(s.wait.resume, "recovery_required");
    f.store.close();
  });
});
test("M4 terminal/blocked/recovery stages and outstanding ownership preserve explicit stop boundaries", async (t) => {
  for (const name of [
    "no_code",
    "blocked",
    "recovery_required",
    "implementing",
    "cancelling",
    "cancelled",
  ])
    await t.test(name, async () => {
      const f = await legacy(`M4-${name}`);
      await stage(f, name);
      const before = upgrade(f);
      let s = f.store.coordinatorSnapshot("run-1");
      assert.equal(
        s.stage,
        name === "implementing" ? "recovery_required" : name,
      );
      if (name === "implementing") {
        assert.equal(s.blocker.kind, "compatibility");
        assert.match(s.blocker.detail, /legacy.*execution/);
        let begins = 0;
        await assert.rejects(
          () =>
            f.store.dispatchCoordinator(f.lease, s.execution.key, {
              versions,
              capability,
              begin: async () => {
                begins++;
                return result(s);
              },
              interrupt() {},
            }),
          /action-no-longer-dispatchable/,
        );
        assert.equal(begins, 0);
        s = finish(f, { outcome: "changed", head: "unreviewed-legacy-head" });
        assert.equal(s.stage, "recovery_required");
        assert.equal(s.head, before.snapshot.head);
        assert.equal(f.store.implementationSlot(), null);
        apply(f.store, f.lease, { type: "cancel" });
        assert.equal(f.store.coordinatorSnapshot("run-1").stage, "cancelled");
      }
      if (name === "blocked") {
        assert.deepEqual(s.blocker, before.snapshot.blocker);
        assert.equal(
          apply(f.store, f.lease, {
            type: "schedule",
            kind: "retry_environment",
          }).budgets.environment,
          before.snapshot.budgets.environment + 1,
        );
      }
      if (name === "no_code")
        assert.throws(
          () => apply(f.store, f.lease, { type: "schedule", kind: "baseline" }),
          /run-not-dispatchable/,
        );
      if (name === "cancelling" || name === "cancelled")
        assert.equal(f.store.get("run-1").cancelled, true);
      retain(f, { before, after: s });
      f.store.close();
    });
});
test("M5 snapshot cancellation is also monotonic if a legacy authoritative row is stale false", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const f = await legacy("M5");
  apply(f.store, f.lease, { type: "cancel" });
  const sql = new DatabaseSync(f.store.path);
  const stale = f.store.get("run-1");
  stale.cancelled = false;
  sql
    .prepare("UPDATE runs SET data=? WHERE id=?")
    .run(JSON.stringify(stale), "run-1");
  sql.close();
  upgrade(f);
  assert.equal(f.store.get("run-1").cancelled, true);
  assert.equal(f.store.coordinatorSnapshot("run-1").cancelled, true);
  f.store.close();
});

test("M6 migration revalidation cannot replenish an exhausted allowance", async () => {
  const f = await legacy("M6", {
    limits: {
      totalTokens: 1000,
      totalElapsedMs: 1000,
      actionTokens: 100,
      actionElapsedMs: 1000,
    },
  });
  await stage(f, "baseline");
  const before = upgrade(f);
  const s = apply(f.store, f.lease, { type: "schedule", kind: "baseline" });
  assert.equal(s.blocker.kind, "budget");
  assert.equal(s.execution, null);
  assert.equal(f.store.implementationSlot(), null);
  assert.deepEqual(s.budgets, before.snapshot.budgets);
  f.store.close();
});
