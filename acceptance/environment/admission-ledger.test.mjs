import test from "node:test";
import assert from "node:assert/strict";
import {
  readFileSync,
  readdirSync,
  statSync,
  openSync,
  closeSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { admissionAttempt, ADMISSION_ROOT } from "./admission-ledger.mjs";
import { ROOT, attemptRoot, writePrivate } from "./runtime.mjs";

test("all preflight failures retain private attempted/rejected receipts with no qualification effects", async () => {
  const { root } = attemptRoot("admission-supporting-regression");
  const supplied = join(root, "synthetic-input.json");
  writePrivate(supplied, { synthetic: true, neverApproval: true });
  const lock = join(root, "synthetic.lock");
  closeSync(openSync(lock, "wx", 0o600));
  let resourceEffects = 0;
  for (const phase of [
    "runtime",
    "approval",
    "binding",
    "source",
    "concurrency",
    "cycle-revalidation",
  ]) {
    let error;
    try {
      await admissionAttempt(
        {
          phase: "supporting-" + phase,
          admissionPath: supplied,
          approvalPath: join(root, "missing.json"),
        },
        () => {
          if (phase === "concurrency") openSync(lock, "wx");
          throw Error(phase + "-rejected");
        },
      );
      resourceEffects++;
    } catch (e) {
      error = e;
    }
    const events = readFileSync(error.admissionReceipt.path, "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.deepEqual(
      events.map((e) => e.event),
      ["admission-attempt", "admission-rejected"],
    );
    assert.equal(events[0].inputs.admission.readable, true);
    assert.equal(events[0].inputs.approval.readable, false);
    assert.ok(events.every((e) => e.qualificationEffectsStarted === false));
    assert.equal(statSync(error.admissionReceipt.path).mode & 0o077, 0);
    if (phase === "concurrency") assert.equal(events[1].errorCode, "EEXIST");
  }
  assert.equal(resourceEffects, 0);
});
test("actual CLI missing approval is retained; wrong root performs no receipt writes", () => {
  const cli = join(ROOT, "acceptance/environment/qualify.mjs");
  const before = readdirSync(ADMISSION_ROOT).length;
  assert.throws(() =>
    execFileSync(process.execPath, [cli], { cwd: ROOT, stdio: "pipe" }),
  );
  assert.equal(readdirSync(ADMISSION_ROOT).length, before + 1);
  assert.throws(() =>
    execFileSync(process.execPath, [cli], { cwd: "/tmp", stdio: "pipe" }),
  );
  assert.equal(readdirSync(ADMISSION_ROOT).length, before + 1);
});
