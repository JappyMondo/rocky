import test from "node:test";
import assert from "node:assert/strict";
import {
  FaultProof,
  FAULT_PROVENANCE,
  expectFailure,
  injectedTimeout,
} from "./fault-proof.mjs";
import { ObservationFailure } from "./assertions.mjs";

for (const [id, [classification, operation, reason]] of Object.entries(
  FAULT_PROVENANCE,
)) {
  test(
    id +
      " cannot pass same-class prerequisite/recovery failure or incomplete proof",
    () => {
      const start = () => new FaultProof(id, classification);
      const early = start();
      early.fail(
        new ObservationFailure(classification, id, "unrelated prerequisite"),
      );
      assert.equal(early.passed(), false);
      const recovery = start();
      recovery.prerequisites({ verified: true });
      recovery.inject({ operation });
      recovery.observe(classification, reason);
      assert.equal(recovery.passed(), false);
      recovery.fail(
        new ObservationFailure(classification, id, "recovery failed"),
      );
      assert.equal(recovery.passed(), false);
      assert.throws(() => recovery.finish());
      const absent = start();
      absent.prerequisites({ verified: true });
      absent.inject({ operation });
      assert.throws(() => absent.contain({ contained: true }));
      assert.equal(absent.passed(), false);
      const complete = start();
      complete.prerequisites({ verified: true });
      complete.inject({ operation });
      complete.observe(classification, reason);
      complete.contain({ contained: true });
      assert.equal(complete.passed(), false);
      complete.finish();
      assert.equal(complete.passed(), true);
      complete.fail(new Error("late failure"));
      assert.equal(complete.passed(), false);
    },
  );
}
test("exact failed assertion excludes same-class fixture error", async () => {
  await assert.rejects(
    expectFailure(
      () => {
        throw new ObservationFailure(
          "fixture_failed",
          "ENV06",
          "fixture-admin-read",
        );
      },
      "fixture_failed",
      "ENV09",
      "2fa-fixture-already-consumed",
    ),
  );
  await assert.rejects(
    expectFailure(
      () => {},
      "fixture_failed",
      "ENV09",
      "2fa-fixture-already-consumed",
    ),
  );
});
test("X04 only accepts the injected 250ms wait timeout, never login/capture/other timeout", async () => {
  const timeout = (message) =>
    Object.assign(new Error(message), { name: "TimeoutError" });
  for (const message of [
    "locator.fill: Timeout 250ms exceeded.",
    "page.screenshot: Timeout 250ms exceeded.",
    "page.waitForFunction: Timeout 15000ms exceeded.",
  ])
    await assert.rejects(
      injectedTimeout(() => {
        throw timeout(message);
      }),
    );
  assert.equal(
    (
      await injectedTimeout(() => {
        throw timeout("page.waitForFunction: Timeout 250ms exceeded.");
      })
    ).timeoutMs,
    250,
  );
  const p = new FaultProof("X04", "environment_failed");
  p.prerequisites({ ready: true });
  p.fail(timeout("login timed out"));
  assert.equal(p.passed(), false);
});
