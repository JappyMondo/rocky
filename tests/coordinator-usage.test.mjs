import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, copyFileSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import ts from "typescript";
import { Store, validateEvent, validateSnapshot } from "../dist/index.js";
import {
  fixture,
  admission,
  apply,
  baseline,
  implemented,
  finish,
  receipt,
  result,
  knownUsage,
  versions,
  capability,
  retain,
} from "./coordinator-support.mjs";
const unknown = {
  schema: 1,
  status: "unknown",
  reason: "lost-provider-response",
};
function reopen(f) {
  const path = f.store.path;
  f.store.release(f.lease);
  f.store.close();
  f.store = new Store(path, () => 1000);
  f.lease = f.store.claim("run-1", "restarted", versions, 1000000);
}
function revise(f) {
  const s = f.store.coordinatorSnapshot("run-1");
  return apply(f.store, f.lease, {
    type: "revise",
    head: s.head,
    scope: { ...s.scope, revision: s.scope.revision + 1 },
    checkPlan: s.checkPlan,
  });
}
function passes(f) {
  receipt(f, "checks");
  receipt(f, "ci");
  return receipt(f, "review");
}
test("U01 known usage is distinct from charge; source and exact result survive replay/restart", () => {
  const f = fixture("U01");
  baseline(f);
  const active = apply(f.store, f.lease, {
    type: "schedule",
    kind: "implement",
  });
  const event = result(active, {
    outcome: "changed",
    head: "head-2",
    usage: knownUsage(37),
  });
  const s = apply(f.store, f.lease, event, "transport", "known");
  assert.equal(s.budgets.knownTokens, 37);
  assert.equal(s.budgets.reservedTokens, 100);
  assert.equal(s.budgets.legacyReportedTokens, null);
  assert.equal(s.budgets.unknownActions, 0);
  assert.deepEqual(f.store.effect(event.actionKey).receipt, event);
  reopen(f);
  assert.deepEqual(apply(f.store, f.lease, event, "transport", "known"), s);
  assert.deepEqual(
    apply(f.store, f.lease, event, "transport", "redelivered"),
    s,
  );
  for (const changed of [
    { ...event, usage: unknown },
    { ...event, usage: knownUsage(38) },
    {
      ...event,
      usage: {
        ...event.usage,
        source: { ...event.usage.source, reference: "other" },
      },
    },
  ]) {
    assert.throws(
      () => apply(f.store, f.lease, changed, "transport", "known"),
      /inbox-payload-conflict/,
    );
    assert.throws(
      () => apply(f.store, f.lease, changed),
      /action-result-conflict/,
    );
  }
  assert.deepEqual(f.store.coordinatorSnapshot("run-1"), s);
  retain(f, { active, event, s });
  f.store.close();
});
test("U02 unknown drain preserves capacity until real local quiescence; cancel, stale fence and restart cannot refund", () => {
  const f = fixture("U02");
  baseline(f);
  const active = apply(f.store, f.lease, {
    type: "schedule",
    kind: "implement",
  });
  const pending = result(active, {
    usage: unknown,
    outcome: "interrupted",
    quiescent: false,
  });
  let s = apply(f.store, f.lease, pending);
  assert.deepEqual(s.executionUsage, unknown);
  assert.ok(f.store.implementationSlot());
  assert.equal(s.budgets.knownTokens, 0);
  assert.equal(s.budgets.reservedTokens, 100);
  const oldLease = f.lease;
  reopen(f);
  assert.throws(() => apply(f.store, oldLease, { type: "cancel" }), /lease/);
  const before = f.store.coordinatorSnapshot("run-1");
  assert.throws(
    () =>
      apply(f.store, f.lease, {
        ...pending,
        actionKey: "stale",
        quiescent: true,
      }),
    /stale-action-result/,
  );
  assert.throws(
    () => finish(f, { usage: knownUsage(0) }),
    /action-usage-conflict/,
  );
  assert.deepEqual(f.store.coordinatorSnapshot("run-1"), before);
  f.store.cancel("run-1");
  s = finish(f, { usage: unknown, outcome: "changed", head: "never-adopt" });
  assert.equal(s.stage, "cancelled");
  assert.equal(s.head, "head-1");
  assert.equal(s.execution, null);
  assert.equal(f.store.implementationSlot(), null);
  assert.equal(s.budgets.unknownActions, 1);
  assert.equal(s.budgets.knownTokens, 0);
  assert.equal(s.budgets.reservedTokens, 100);
  reopen(f);
  assert.deepEqual(f.store.coordinatorSnapshot("run-1"), s);
  retain(f, { pending, s });
  f.store.close();
});
test("U03 unknown failure preserves bounded retry and later independent delivery, while totals remain incomplete", () => {
  const f = fixture("U03");
  apply(f.store, f.lease, { type: "schedule", kind: "baseline" });
  let s = finish(f, { usage: unknown, outcome: "failed" });
  assert.equal(s.blocker.kind, "environment");
  assert.deepEqual(s.unqualifiedResults, []);
  reopen(f);
  apply(f.store, f.lease, { type: "schedule", kind: "retry_environment" });
  finish(f);
  receipt(f, "baseline");
  apply(f.store, f.lease, { type: "schedule", kind: "implement" });
  finish(f, { outcome: "changed", head: "head-2", tokens: 20 });
  s = passes(f);
  assert.equal(s.stage, "handoff_ready");
  assert.equal(s.budgets.unknownActions, 1);
  assert.equal(s.budgets.environment, 1);
  assert.equal(s.budgets.knownTokens, 20);
  assert.equal(s.budgets.reservedTokens, 100);
  apply(f.store, f.lease, {
    type: "block",
    kind: "environment",
    detail: "repeat failure",
  });
  s = apply(f.store, f.lease, { type: "schedule", kind: "retry_environment" });
  assert.equal(s.execution, null);
  assert.equal(s.blocker.detail, "environment-retry-exhausted");
  retain(f, s);
  f.store.close();
});
test("U04 unknown implementation success cannot be laundered by revision, passes or unrelated successful work; independent repair can recover", () => {
  const f = fixture("U04");
  baseline(f);
  apply(f.store, f.lease, { type: "schedule", kind: "implement" });
  let s = finish(f, {
    usage: unknown,
    outcome: "changed",
    head: "unqualified-head",
  });
  assert.equal(s.head, "head-1");
  assert.equal(s.stage, "recovery_required");
  assert.deepEqual(s.unqualifiedResults, ["implement"]);
  reopen(f);
  revise(f);
  apply(f.store, f.lease, { type: "schedule", kind: "verify" });
  finish(f);
  s = passes(f);
  assert.notEqual(s.stage, "handoff_ready");
  assert.deepEqual(s.unqualifiedResults, ["implement"]);
  receipt(f, "checks", "fail", "independently-failed-current-checks");
  apply(f.store, f.lease, { type: "schedule", kind: "repair_product" });
  s = finish(f, {
    outcome: "changed",
    head: "independently-repaired",
    tokens: 30,
  });
  assert.deepEqual(s.unqualifiedResults, []);
  s = passes(f);
  assert.equal(s.stage, "handoff_ready");
  assert.equal(s.head, "independently-repaired");
  assert.equal(s.budgets.unknownActions, 1);
  assert.equal(s.budgets.knownTokens, 30);
  assert.equal(s.budgets.reservedTokens, 200);
  assert.equal(s.budgets.product, 1);
  receipt(f, "ci", "fail", "ci-failure");
  s = apply(f.store, f.lease, { type: "schedule", kind: "repair_ci" });
  assert.equal(s.budgets.ci, 1);
  assert.equal(s.budgets.reservedTokens, 300);
  retain(f, s);
  f.store.close();
});
test("U05 unknown no-code is not success; malformed or local fake usage cannot release slot", () => {
  const f = fixture("U05");
  baseline(f);
  const active = apply(f.store, f.lease, {
    type: "schedule",
    kind: "implement",
  });
  for (const usage of [
    { ...unknown, schema: 2 },
    { ...unknown, tokens: 0 },
    knownUsage(-1),
    knownUsage(Number.MAX_SAFE_INTEGER + 1),
    {
      ...knownUsage(0),
      source: { kind: "provider-attested", reference: "claim" },
    },
  ])
    assert.throws(() => validateEvent(result(active, { usage }), "transport"));
  assert.throws(
    () => finish(f, { usage: knownUsage(0, false) }),
    /agent-usage-requires-provider-receipt/,
  );
  assert.deepEqual(f.store.coordinatorSnapshot("run-1"), active);
  const s = finish(f, { usage: unknown, outcome: "no_code" });
  assert.equal(s.stage, "recovery_required");
  assert.equal(s.budgets.reservedTokens, 100);
  assert.deepEqual(s.unqualifiedResults, ["implement"]);
  f.store.close();
});
async function oldFixture(name) {
  const f = fixture(name);
  f.store.close();
  const root = f.dir + "/95a-reader";
  for (const file of [
    "store/index",
    "store/json",
    "config/index",
    "evidence/index",
    "coordinator/contracts",
    "coordinator/reducer",
    "coordinator/migration",
  ]) {
    const source = execFileSync(
      "git",
      ["show", `95a76802ef6679860a7a45b6f680fcad0afbdc99:src/${file}.ts`],
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
  const old = await import(root + "/store/index.js");
  f.store = new old.Store(f.dir + "/old.sqlite", () => 1000);
  f.store.admitCoordinator(admission());
  f.lease = f.store.claim("run-1", "old", versions, 1000000);
  return { f, old };
}
test("U06 exact previous95a cannot express unknown; persisted numeric values migrate as legacy reports, not provider usage", async () => {
  const { f, old } = await oldFixture("U06");
  baseline(f);
  const active = apply(f.store, f.lease, {
    type: "schedule",
    kind: "implement",
  });
  const candidate = { ...result(active), usage: unknown };
  delete candidate.tokens;
  assert.throws(
    () => apply(f.store, f.lease, candidate),
    /invalid-contract-fields/,
  );
  const previous = finish(f, {
    outcome: "changed",
    head: "head-2",
    tokens: 41,
  });
  const events = f.store.events("run-1");
  f.store.release(f.lease);
  f.store.close();
  const original = readFileSync(f.dir + "/old.sqlite");
  copyFileSync(f.dir + "/old.sqlite", f.dir + "/migrated.sqlite");
  f.store = new Store(f.dir + "/migrated.sqlite", () => 1000);
  const after = f.store.coordinatorSnapshot("run-1");
  assert.equal(after.schema, 3);
  assert.equal(after.budgets.legacyReportedTokens, 41);
  assert.equal(after.budgets.knownTokens, 0);
  assert.equal(after.budgets.unknownActions, 0);
  assert.equal(after.budgets.reservedTokens, previous.budgets.reservedTokens);
  assert.equal(after.inputDigest, previous.inputDigest);
  assert.equal(after.head, previous.head);
  assert.deepEqual(f.store.events("run-1").slice(0, events.length), events);
  assert.deepEqual(f.store.events("run-1").at(-1).data.previous, previous);
  assert.deepEqual(readFileSync(f.dir + "/old.sqlite"), original);
  f.store.close();
  assert.throws(
    () => new old.Store(f.dir + "/migrated.sqlite"),
    /incompatible-store-schema/,
  );
  retain(f, {
    source: "95a76802ef6679860a7a45b6f680fcad0afbdc99",
    active,
    previous,
    after,
  });
});
test("U07 schema3 outstanding cancellation, legacy pending numeric result and malformed upgrade are conservative/atomic", async () => {
  const { f } = await oldFixture("U07");
  baseline(f);
  const active = apply(f.store, f.lease, {
    type: "schedule",
    kind: "implement",
  });
  f.store.ingestCoordinator(
    "run-1",
    "transport",
    "pending-old",
    result(active, { tokens: 19, outcome: "changed", head: "old-output" }),
  );
  f.store.cancel("run-1");
  const effect = f.store.effect(active.execution.key);
  f.store.release(f.lease);
  f.store.close();
  copyFileSync(f.dir + "/old.sqlite", f.dir + "/bad.sqlite");
  const bad = new DatabaseSync(f.dir + "/bad.sqlite");
  bad.prepare("UPDATE coordinator_snapshots SET data=?").run(
    JSON.stringify({
      ...active,
      budgets: { ...active.budgets, reportedTokens: -1 },
    }),
  );
  bad.close();
  assert.throws(() => new Store(f.dir + "/bad.sqlite"), /invalid-counter/);
  const check = new DatabaseSync(f.dir + "/bad.sqlite");
  assert.equal(check.prepare("PRAGMA user_version").get().user_version, 3);
  check.close();
  f.store = new Store(f.dir + "/old.sqlite", () => 1000);
  f.lease = f.store.claim("run-1", "old", versions, 1000000);
  const migrated = f.store.coordinatorSnapshot("run-1");
  assert.equal(migrated.stage, "cancelling");
  assert.deepEqual(migrated.execution, active.execution);
  assert.deepEqual(f.store.effect(effect.key), effect);
  assert.throws(
    () =>
      f.store.applyCoordinator(
        f.lease,
        migrated.revision,
        "transport",
        "pending-old",
      ),
    /invalid-contract-fields/,
  );
  assert.ok(f.store.implementationSlot());
  const s = finish(f, { usage: unknown, outcome: "interrupted" });
  assert.equal(s.stage, "cancelled");
  assert.equal(s.budgets.reservedTokens, 100);
  assert.equal(s.budgets.unknownActions, 1);
  assert.equal(s.head, "head-1");
  reopen(f);
  assert.deepEqual(f.store.coordinatorSnapshot("run-1"), s);
  assert.throws(() => validateSnapshot({ ...s, schema: 99 }), /incompatible/);
  retain(f, { active, migrated, s });
  f.store.close();
});

test("U08 lost start response remains charged across restart; unknown reconciliation cannot admit unreserved work", async () => {
  const f = fixture("U08");
  baseline(f);
  const s = apply(f.store, f.lease, { type: "schedule", kind: "implement" });
  let sends = 0;
  const transport = {
    versions,
    capability,
    begin() {
      sends++;
      throw new Error("synthetic-lost-response");
    },
    interrupt() {},
  };
  await assert.rejects(
    () => f.store.dispatchCoordinator(f.lease, s.execution.key, transport),
    /synthetic-lost-response/,
  );
  reopen(f);
  await assert.rejects(
    () => f.store.dispatchCoordinator(f.lease, s.execution.key, transport),
    /stale-slot-fence|reconciliation-required/,
  );
  assert.equal(sends, 1);
  assert.equal(f.store.effect(s.execution.key).state, "sending");
  assert.equal(
    f.store.coordinatorSnapshot("run-1").budgets.reservedTokens,
    100,
  );
  assert.ok(f.store.implementationSlot());
  const after = finish(f, { usage: unknown, outcome: "interrupted" });
  assert.equal(after.budgets.unknownActions, 1);
  assert.equal(after.budgets.knownTokens, 0);
  assert.equal(after.budgets.reservedTokens, 100);
  assert.equal(after.stage, "recovery_required");
  assert.deepEqual(f.store.effect(s.execution.key).receipt.usage, unknown);
  retain(f, { s, after, sends });
  f.store.close();
});
test("U09 unknown success cannot refund token allowance for a repair and deterministic zero must be explicit", () => {
  const f = fixture("U09");
  const initial = f.store.coordinatorSnapshot("run-1");
  f.store.close();
  // Owned fixture narrows limits before any action; production revisions cannot edit limits.
  const sql = new DatabaseSync(f.dir + "/state.sqlite");
  initial.limits.totalTokens = 100;
  sql
    .prepare("UPDATE coordinator_snapshots SET data=?")
    .run(JSON.stringify(initial));
  sql.close();
  f.store = new Store(f.dir + "/state.sqlite", () => 1000);
  apply(f.store, f.lease, { type: "schedule", kind: "baseline" });
  finish(f, { usage: knownUsage(0, false) });
  receipt(f, "baseline");
  apply(f.store, f.lease, { type: "schedule", kind: "implement" });
  finish(f, { usage: unknown, outcome: "changed", head: "unknown-head" });
  revise(f);
  receipt(f, "checks", "fail");
  const s = apply(f.store, f.lease, {
    type: "schedule",
    kind: "repair_product",
  });
  assert.equal(s.blocker.kind, "budget");
  assert.equal(s.execution, null);
  assert.equal(s.budgets.reservedTokens, 100);
  assert.equal(s.budgets.product, 0);
  assert.deepEqual(s.unqualifiedResults, ["implement"]);
  f.store.close();
});
test("U10 an unknown failed agent action remains charged without preventing independent CI repair and qualified handoff", () => {
  const f = fixture("U10");
  implemented(f);
  apply(f.store, f.lease, { type: "schedule", kind: "review" });
  let s = finish(f, {
    usage: unknown,
    outcome: "failed",
    detail: "lost review provider response",
  });
  assert.equal(s.budgets.reservedTokens, 200);
  assert.deepEqual(s.unqualifiedResults, []);
  reopen(f);
  receipt(f, "ci", "fail", "real-local-fixture-ci-failure");
  apply(f.store, f.lease, { type: "schedule", kind: "repair_ci" });
  finish(f, { outcome: "changed", head: "ci-repaired", tokens: 25 });
  s = passes(f);
  assert.equal(s.stage, "handoff_ready");
  assert.equal(s.budgets.reservedTokens, 300);
  assert.equal(s.budgets.knownTokens, 75);
  assert.equal(s.budgets.unknownActions, 1);
  assert.equal(s.budgets.ci, 1);
  retain(f, s);
  f.store.close();
});
