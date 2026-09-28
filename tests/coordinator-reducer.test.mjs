import test from "node:test";
import assert from "node:assert/strict";
import {
  Store,
  Evidence,
  identity,
  initialSnapshot,
  reduce,
  validateAction,
} from "../dist/index.js";
import {
  fixture,
  admission,
  versions,
  capability,
  apply,
  result,
  receipt,
  baseline,
  finish,
  implemented,
  retain,
} from "./coordinator-support.mjs";

test("C07 independent repair budgets preserve a CI allowance after exhausted review; head changes never reset counters", () => {
  const f = fixture("C07");
  implemented(f);
  receipt(f, "ci", "fail", "job-failed", { diagnostics: "unavailable" });
  receipt(f, "review", "fail", "finding-1");
  apply(f.store, f.lease, { type: "schedule", kind: "repair_review" });
  finish(f, { outcome: "changed", head: "head-3", tokens: 60 });
  receipt(f, "checks");
  receipt(f, "review", "fail", "finding-2");
  let s = apply(f.store, f.lease, { type: "schedule", kind: "repair_review" });
  assert.equal(s.blocker.detail, "review-correction-exhausted");
  assert.equal(s.budgets.review, 1);
  s = apply(f.store, f.lease, { type: "schedule", kind: "observe_ci" });
  assert.equal(s.execution.kind, "observe_ci");
  finish(f);
  receipt(f, "ci", "fail", "job-failed", { diagnostics: "unavailable" });
  s = apply(f.store, f.lease, { type: "schedule", kind: "repair_ci" });
  assert.equal(s.execution.kind, "repair_ci");
  assert.equal(s.budgets.ci, 1);
  assert.equal(s.budgets.review, 1);
  finish(f, { outcome: "changed", head: "head-4", tokens: 20 });
  receipt(f, "checks", "fail", "test-failed");
  s = apply(f.store, f.lease, { type: "schedule", kind: "repair_product" });
  assert.equal(s.budgets.product, 1);
  finish(f, { outcome: "changed", head: "head-5", tokens: 20 });
  receipt(f, "checks", "fail", "new-test-failed");
  s = apply(f.store, f.lease, { type: "schedule", kind: "repair_product" });
  assert.equal(s.blocker.kind, "needs_engineering");
  receipt(f, "ci", "fail", "job-failed-after-repair");
  s = apply(f.store, f.lease, { type: "schedule", kind: "repair_ci" });
  assert.equal(s.blocker.detail, "ci-repair-exhausted");
  assert.equal(s.budgets.product + s.budgets.ci, 2);
  retain(f, s);
  f.store.close();
});
test("C08 shared product slot cannot consume CI reserve; no-op and repeated signatures are bounded", () => {
  const f = fixture("C08");
  implemented(f);
  receipt(f, "checks", "fail", "same-test");
  apply(f.store, f.lease, { type: "schedule", kind: "repair_product" });
  finish(f, { outcome: "changed", head: "head-3" });
  receipt(f, "checks", "fail", "different-failure");
  let s = apply(f.store, f.lease, { type: "schedule", kind: "repair_product" });
  assert.equal(s.budgets.product, 1);
  assert.match(s.blocker.detail, /ci-reserved/);
  receipt(f, "ci", "fail", "failed-ci");
  s = apply(f.store, f.lease, { type: "schedule", kind: "repair_ci" });
  assert.equal(s.budgets.ci, 1);
  s = finish(f, { outcome: "changed", head: s.head });
  assert.equal(s.blocker.detail, "no-op-repair-or-implementation");
  assert.equal(s.budgets.ci, 1);
  retain(f, s);
  f.store.close();
  const g = fixture("C08-repeat");
  implemented(g);
  receipt(g, "ci", "fail", "identical");
  apply(g.store, g.lease, { type: "schedule", kind: "repair_ci" });
  finish(g, { outcome: "complete" });
  const repeated = apply(g.store, g.lease, {
    type: "schedule",
    kind: "repair_ci",
  });
  assert.equal(repeated.blocker.detail, "repeated-unchanged-failure");
  assert.equal(repeated.budgets.ci, 1);
  g.store.close();
});
test("C09 environment and disagreement budgets are independent; no-code is terminal and not a coding handoff", () => {
  const f = fixture("C09");
  apply(f.store, f.lease, { type: "schedule", kind: "baseline" });
  finish(f, { outcome: "failed" });
  let s = apply(f.store, f.lease, {
    type: "schedule",
    kind: "retry_environment",
  });
  assert.equal(s.budgets.environment, 1);
  finish(f, { outcome: "failed" });
  s = apply(f.store, f.lease, { type: "schedule", kind: "retry_environment" });
  assert.equal(s.blocker.kind, "environment");
  assert.equal(s.budgets.product, 0);
  f.store.close();
  const g = fixture("C09-disagreement");
  implemented(g);
  receipt(g, "review", "fail", "review-dispute");
  apply(g.store, g.lease, { type: "schedule", kind: "arbitrate" });
  finish(g);
  s = apply(g.store, g.lease, { type: "schedule", kind: "arbitrate" });
  assert.equal(s.blocker.detail, "disagreement-exhausted");
  assert.equal(s.budgets.disagreement, 1);
  assert.equal(s.budgets.review, 0);
  g.store.close();
  const h = fixture("C09-no-code");
  baseline(h);
  apply(h.store, h.lease, { type: "schedule", kind: "implement" });
  s = finish(h, { outcome: "no_code" });
  assert.equal(s.stage, "no_code");
  assert.throws(
    () => apply(h.store, h.lease, { type: "schedule", kind: "verify" }),
    /run-not-dispatchable/,
  );
  retain(h, s);
  h.store.close();
});
test("C10 hard capabilities fail closed at admission/dispatch; predispatch reservations and accounting survive reopen/time rollback", async () => {
  const f = fixture("C10");
  f.store.admitCoordinator(admission("unsupported", { capability: null }));
  const unsupported = f.store.claim("unsupported", "owner", versions, 10000);
  assert.equal(
    f.store.coordinatorSnapshot("unsupported").blocker.kind,
    "capability",
  );
  assert.throws(
    () => apply(f.store, unsupported, { type: "schedule", kind: "baseline" }),
    /run-blocked/,
  );
  baseline(f);
  let s = apply(f.store, f.lease, { type: "schedule", kind: "implement" });
  assert.equal(s.budgets.reservedTokens, 100);
  let calls = 0;
  const transport = {
    versions,
    capability: null,
    begin: async () => {
      calls++;
      return result(s);
    },
    interrupt() {},
  };
  await assert.rejects(
    () => f.store.dispatchCoordinator(f.lease, s.execution.key, transport),
    /hard-limits-capability-mismatch/,
  );
  assert.equal(calls, 0);
  assert.equal(f.store.effect(s.execution.key).state, "pending");
  await assert.rejects(
    () =>
      f.store.dispatchCoordinator(f.lease, s.execution.key, {
        ...transport,
        capability,
        versions: { ...versions, runner: "other" },
      }),
    /incompatible-transport-versions/,
  );
  s = finish(f, { outcome: "changed", head: "head-2", tokens: 101 });
  assert.equal(s.blocker.detail, "hard-token-contract-violated");
  assert.equal(s.budgets.reportedTokens, 101);
  f.store.close();
  let now = 1200;
  const reopened = new Store(f.dir + "/state.sqlite", () => now);
  const a = apply(reopened, f.lease, { type: "tick" });
  now = 1100;
  const b = apply(reopened, f.lease, { type: "tick" });
  assert.equal(a.budgets.elapsedMs, b.budgets.elapsedMs);
  assert.equal(b.budgets.reservedTokens, 100);
  retain(f, b);
  reopened.close();
  const limited = initialSnapshot(
    admission("limited", {
      limits: {
        totalTokens: 100,
        totalElapsedMs: 2000,
        actionTokens: 100,
        actionElapsedMs: 1000,
      },
    }),
    1000,
  );
  const first = reduce(
    limited,
    { type: "schedule", kind: "baseline" },
    1000,
  ).snapshot;
  const settled = reduce(first, result(first), 1000).snapshot;
  // Reservation is never refunded; a delayed next action cannot exceed the total hard wall deadline.
  const timed = reduce(settled, { type: "tick" }, 4000).snapshot;
  assert.equal(timed.blocker.kind, "budget");
});
test("C11 authoritative receipts bind head/scope/build/check plan, reject agent verdicts, invalidate checks/review/approval", () => {
  const f = fixture("C11");
  implemented(f);
  receipt(f, "ci");
  let s = receipt(f, "review");
  assert.equal(s.stage, "handoff_ready");
  s = receipt(f, "approval");
  const old = s.receipts.checks.reference;
  assert.throws(
    () =>
      f.store.ingestCoordinator("run-1", "transport", "agent-verdict", {
        type: "receipt",
        kind: "checks",
        receipt: s.receipts.checks,
      }),
    /event-authority-rejected/,
  );
  assert.throws(
    () =>
      f.store.ingestCoordinator("run-1", "evidence", "fake-authority", {
        type: "receipt",
        kind: "checks",
        receipt: s.receipts.checks,
      }),
    /receipt-registration-required/,
  );
  s = apply(f.store, f.lease, {
    type: "revise",
    head: "head-new",
    scope: { ...s.scope, revision: 2, behavior: ["explicit changed scope"] },
    checkPlan: "plan-2",
  });
  assert.deepEqual(s.receipts, {});
  assert.throws(
    () =>
      f.store.registerCoordinatorReceipt(
        f.lease,
        "old",
        "checks",
        f.evidence,
        old,
      ),
    /stale-evidence|stale-observation-inputs/,
  );
  assert.throws(
    () =>
      apply(f.store, f.lease, {
        type: "revise",
        head: s.head,
        scope: { ...s.scope, behavior: ["silent expansion"] },
        checkPlan: s.checkPlan,
      }),
    /scope-revision-required/,
  );
  receipt(f, "checks");
  receipt(f, "ci");
  s = receipt(f, "review");
  assert.equal(s.stage, "handoff_ready");
  s = receipt(f, "ci", "fail", "new-job-attempt");
  assert.equal(s.stage, "awaiting_delivery_evidence");
  assert.equal(s.receipts.review, undefined);
  assert.equal(s.receipts.approval, undefined);
  // A receipt queued under the old inputs must be rechecked inside the apply transaction.
  const current = s.receipts.checks;
  f.store.registerCoordinatorReceipt(
    f.lease,
    "queued",
    "checks",
    f.evidence,
    current.reference,
  );
  apply(f.store, f.lease, {
    type: "revise",
    head: s.head,
    scope: s.scope,
    checkPlan: "plan-3",
  });
  assert.throws(
    () =>
      f.store.applyCoordinator(
        f.lease,
        f.store.coordinatorSnapshot("run-1").revision,
        "evidence",
        "queued",
      ),
    /stale-evidence|stale-observation-inputs/,
  );
  retain(f, f.store.coordinatorSnapshot("run-1"));
  f.store.close();
});
test("C12 persisted long wait retains workspace and slot until quiescent; wake/deadline and late cancellation/version result gates", () => {
  let now = 1000;
  const f = fixture("C12", () => now);
  baseline(f);
  let s = apply(f.store, f.lease, { type: "schedule", kind: "implement" });
  s = apply(f.store, f.lease, {
    type: "wait",
    reason: "external prerequisite",
    wakeAt: 1500,
    deadline: 5000,
  });
  assert.ok(f.store.implementationSlot());
  assert.throws(
    () => apply(f.store, f.lease, { type: "wake" }),
    /wait-not-quiescent/,
  );
  s = finish(f, { outcome: "changed", head: "head-2" });
  assert.equal(s.stage, "waiting_external");
  assert.equal(s.wait.resume, "verifying");
  assert.equal(f.store.implementationSlot(), null);
  f.store.release(f.lease);
  f.store.close();
  const reopened = new Store(f.dir + "/state.sqlite", () => now);
  const lease = reopened.claim("run-1", "new", versions, 10000);
  assert.equal(
    reopened.coordinatorSnapshot("run-1").workspace,
    "synthetic/run-1",
  );
  assert.throws(() => apply(reopened, lease, { type: "wake" }), /wake-not-due/);
  now = 1500;
  s = apply(reopened, lease, { type: "wake" });
  assert.equal(s.stage, "verifying");
  s = apply(reopened, lease, { type: "schedule", kind: "verify" });
  const active = s;
  apply(reopened, lease, {
    type: "incompatible",
    detail: "new workflow unsupported",
  });
  s = apply(reopened, lease, result(active));
  assert.equal(s.stage, "recovery_required");
  assert.equal(reopened.implementationSlot(), null);
  assert.throws(
    () => apply(reopened, lease, { type: "schedule", kind: "verify" }),
    /incompatible-versions/,
  );
  assert.throws(
    () => apply(reopened, lease, result(active)),
    /stale-action-result/,
  );
  retain(f, s);
  reopened.close();
});
test("C13 malformed/non-plain events and action/version fields reject before durable writes; stale results cannot release capacity", () => {
  const f = fixture("C13");
  for (const event of [
    { type: "unknown" },
    { type: "cancel", extra: 1 },
    { type: "schedule", kind: "invented" },
    { type: "tick", bad: Promise.resolve() },
  ])
    assert.throws(() =>
      f.store.ingestCoordinator("run-1", "scheduler", "bad", event),
    );
  const s = apply(f.store, f.lease, { type: "schedule", kind: "baseline" });
  assert.throws(
    () => apply(f.store, f.lease, result(s, { inputDigest: "stale" })),
    /stale-action-result/,
  );
  assert.ok(f.store.implementationSlot());
  assert.throws(
    () => validateAction({ ...s.execution, schema: 2 }),
    /invalid-action/,
  );
  assert.throws(
    () => f.store.claim("run-1", "x", { ...versions, workflow: "2" }, 1000),
    /incompatible-versions/,
  );
  f.store.close();
});
test("C14 injected transport completes via durable result inbox; direct cancel prevents new dispatch but permits cleanup", async () => {
  const f = fixture("C14");
  let s = apply(f.store, f.lease, { type: "schedule", kind: "baseline" });
  let begins = 0,
    interrupts = 0;
  const transport = {
    versions,
    capability,
    begin: async (action) => {
      begins++;
      assert.equal(f.store.effect(action.key).state, "sending");
      return result(s);
    },
    interrupt() {
      interrupts++;
    },
  };
  await f.store.dispatchCoordinator(f.lease, s.execution.key, transport);
  assert.ok(f.store.implementationSlot());
  s = f.store.applyCoordinator(
    f.lease,
    s.revision,
    "transport",
    `result/${s.execution.key}`,
  );
  assert.equal(f.store.implementationSlot(), null);
  assert.equal(begins, 1);
  receipt(f, "baseline");
  s = apply(f.store, f.lease, { type: "schedule", kind: "implement" });
  f.store.cancel("run-1");
  f.store.interruptCoordinator(f.lease, transport);
  assert.equal(interrupts, 1);
  await assert.rejects(
    () => f.store.dispatchCoordinator(f.lease, s.execution.key, transport),
    /cancelled/,
  );
  s = finish(f, { outcome: "changed", head: "must-not-be-adopted" });
  assert.equal(s.stage, "cancelled");
  assert.equal(s.head, "head-1");
  f.store.close();
});
