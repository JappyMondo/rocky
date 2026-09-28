import test from "node:test";
import assert from "node:assert/strict";
import {
  fixture,
  apply,
  baseline,
  finish,
  receipt,
  versions,
  retain,
  coordinatorModule,
} from "./coordinator-support.mjs";
const { Store } = coordinatorModule;
const usage = {
  schema: 1,
  status: "unknown",
  reason: "lost-provider-response",
};
function reopen(f) {
  const path = f.store.path;
  f.store.release(f.lease);
  f.store.close();
  f.store = new Store(path, () => 1000);
  f.lease = f.store.claim("run-1", "drain-restarted", versions, 1000000);
}
function reviseAndVerify(f) {
  const s = f.store.coordinatorSnapshot("run-1");
  apply(f.store, f.lease, {
    type: "revise",
    head: s.head,
    scope: { ...s.scope, revision: s.scope.revision + 1 },
    checkPlan: s.checkPlan,
  });
  apply(f.store, f.lease, { type: "schedule", kind: "verify" });
  finish(f);
  receipt(f, "checks");
  receipt(f, "ci");
  return receipt(f, "review");
}
for (const claim of ["changed", "no_code"])
  for (const drain of ["failed", "interrupted"])
    test(`D01 unknown ${claim} before quiescence survives restart and ${drain} drain; only same-role success recovers`, () => {
      const f = fixture(`D01-${claim}-${drain}`);
      baseline(f);
      const active = apply(f.store, f.lease, {
        type: "schedule",
        kind: "implement",
      });
      const first = finish(f, {
        usage,
        outcome: claim,
        head: claim === "changed" ? "unqualified-head" : active.head,
        quiescent: false,
      });
      assert.deepEqual(first.execution, active.execution);
      assert.deepEqual(first.executionUsage, usage);
      assert.ok(f.store.implementationSlot());
      assert.equal(first.budgets.reservedTokens, 100);
      assert.equal(first.budgets.unknownActions, 0);
      reopen(f);
      assert.deepEqual(f.store.coordinatorSnapshot("run-1"), first);
      const settled = finish(f, { usage, outcome: drain, quiescent: true });
      assert.equal(f.store.implementationSlot(), null);
      assert.equal(settled.head, active.head);
      assert.equal(settled.budgets.reservedTokens, 100);
      assert.equal(settled.budgets.unknownActions, 1);
      const beforeRepair = reviseAndVerify(f);
      receipt(f, "checks", "fail", "independent-current-failure");
      apply(f.store, f.lease, { type: "schedule", kind: "repair_product" });
      finish(f, {
        outcome: "changed",
        head: "independent-repaired-head",
        tokens: 27,
      });
      receipt(f, "checks");
      receipt(f, "ci");
      const recovered = receipt(f, "review");
      retain(f, { active, first, settled, beforeRepair, recovered });
      f.store.close();
      // The rejected build reaches false handoff here; retain the whole sequence before asserting.
      assert.notEqual(
        beforeRepair.stage,
        "handoff_ready",
        "unrelated verification must not launder the earlier unknown success claim",
      );
      assert.deepEqual(first.unqualifiedResults, ["implement"]);
      assert.deepEqual(settled.unqualifiedResults, ["implement"]);
      assert.deepEqual(beforeRepair.unqualifiedResults, ["implement"]);
      assert.equal(recovered.stage, "handoff_ready");
      assert.deepEqual(recovered.unqualifiedResults, []);
      assert.equal(recovered.budgets.reservedTokens, 200);
      assert.equal(recovered.budgets.knownTokens, 27);
      assert.equal(recovered.budgets.unknownActions, 1);
      assert.equal(recovered.budgets.product, 1);
    });
for (const outcome of ["failed", "interrupted"])
  test(`D02 unknown ${outcome}-only drain creates no success barrier and retains bounded recovery`, () => {
    const f = fixture(`D02-${outcome}`);
    baseline(f);
    apply(f.store, f.lease, { type: "schedule", kind: "implement" });
    const first = finish(f, { usage, outcome, quiescent: false });
    reopen(f);
    const settled = finish(f, { usage, outcome, quiescent: true });
    assert.deepEqual(first.unqualifiedResults, []);
    assert.deepEqual(settled.unqualifiedResults, []);
    const recovered = reviseAndVerify(f);
    assert.equal(recovered.stage, "handoff_ready");
    assert.equal(recovered.budgets.reservedTokens, 100);
    assert.equal(recovered.budgets.unknownActions, 1);
    assert.equal(recovered.budgets.product, 0);
    retain(f, { first, settled, recovered });
    f.store.close();
  });
