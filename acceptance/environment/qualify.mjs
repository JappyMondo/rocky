import {
  readFileSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  ROOT,
  runtime,
  attemptRoot,
  writePrivate,
  sha,
  json,
} from "./runtime.mjs";
import { verifyBinding } from "./binding.mjs";
import { evaluateCycle } from "./evaluator.mjs";
import { evaluateFault } from "./faults.mjs";

// There is deliberately no flag that fabricates approval or promotes preparation.
const [admissionPath, approvalPath] = process.argv.slice(2);
if (!admissionPath || !approvalPath)
  throw Error(
    "usage: qualify.mjs <immutable-admission.json> <real-independent-approval.json>",
  );
const rt = await runtime(),
  approval = json(approvalPath),
  binding = verifyBinding(rt, admissionPath, approval);
const contract = json(join(ROOT, "acceptance/environment/manifest.json"));
if (
  contract.policy.concurrency !== 1 ||
  contract.policy.max_environment_retries_per_cycle !== 1 ||
  contract.cycles.length !== 10 ||
  contract.adversarial.length !== 11
)
  throw Error("protected-series-shape-drift");
const lockPath = join(rt.api.TARGET.root, "qualification-series.lock"),
  token = randomUUID();
const lock = openSync(lockPath, "wx", 0o600);
writeSync(
  lock,
  JSON.stringify({ token, pid: process.pid, admissionSha256: binding.sha256 }),
);
fsyncSync(lock);
closeSync(lock);
const series = attemptRoot("qualification-series"),
  ledger = openSync(join(series.root, "attempt-ledger.jsonl"), "wx", 0o600),
  attempts = [],
  prior = [];
const summary = {
  id: series.id,
  scope: "qualification",
  startedAt: new Date().toISOString(),
  admissionSha256: binding.sha256,
  approval: {
    path: approvalPath,
    sha256: sha(readFileSync(approvalPath)),
    reviewer: approval.reviewer,
    ticket: approval.ticket,
  },
  requiredCycles: 10,
  requiredFaults: 11,
  status: "running",
};
writePrivate(join(series.root, "series-start.json"), summary);
const append = (value) => {
  writeSync(ledger, JSON.stringify(value) + "\n");
  fsyncSync(ledger);
};
try {
  for (const cycle of contract.cycles) {
    let completed = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      verifyBinding(rt, admissionPath, approval);
      const a = attemptRoot(series.id + "-" + cycle.id + "-attempt-" + attempt);
      append({
        event: "attempt-start",
        kind: "cycle",
        cycle: cycle.id,
        attempt,
        ...a,
        at: new Date().toISOString(),
      });
      const result = await evaluateCycle(rt, cycle, {
        ...a,
        admissionPath,
        approval,
        prior,
      });
      const retained = {
        kind: "cycle",
        cycle: cycle.id,
        attempt,
        status: result.status,
        outcome: {
          path: join(a.root, "outcome.json"),
          sha256: sha(readFileSync(join(a.root, "outcome.json"))),
        },
      };
      attempts.push(retained);
      append({ event: "attempt-finished", ...retained });
      if (result.status === "passed") {
        completed = true;
        prior.push(json(join(a.root, "private-next-sentinel.json")));
        break;
      }
      if (
        !["setup_failed", "environment_failed"].includes(result.status) ||
        attempt === 2
      )
        break;
    }
    if (!completed) throw Error("cycle-not-complete:" + cycle.id);
  }
  for (const fault of contract.adversarial) {
    verifyBinding(rt, admissionPath, approval);
    const a = attemptRoot(series.id + "-" + fault.id);
    append({
      event: "attempt-start",
      kind: "fault",
      fault: fault.id,
      attempt: 1,
      ...a,
      at: new Date().toISOString(),
    });
    const result = await evaluateFault(rt, fault, {
      ...a,
      admissionPath,
      approval,
      prior,
    });
    const retained = {
      kind: "fault",
      fault: fault.id,
      attempt: 1,
      status: result.status,
      observedClass: result.observedClass,
      expectedClass: result.expectedClass,
      outcome: {
        path: join(a.root, "outcome.json"),
        sha256: sha(readFileSync(join(a.root, "outcome.json"))),
      },
    };
    attempts.push(retained);
    append({ event: "attempt-finished", ...retained });
    if (result.status !== "passed")
      throw Error("fault-not-contained:" + fault.id);
  }
  summary.status = "passed";
} catch (error) {
  summary.status = "failed";
  summary.stopReason = error.message;
  append({
    event: "series-stopped",
    reason: error.message,
    at: new Date().toISOString(),
  });
} finally {
  closeSync(ledger);
  summary.attempts = attempts;
  summary.cleanCompletions = attempts.filter(
    (a) => a.kind === "cycle" && a.status === "passed",
  ).length;
  summary.firstAttemptPasses = attempts.filter(
    (a) => a.kind === "cycle" && a.status === "passed" && a.attempt === 1,
  ).length;
  summary.recoveredCompletions =
    summary.cleanCompletions - summary.firstAttemptPasses;
  summary.faultPasses = attempts.filter(
    (a) => a.kind === "fault" && a.status === "passed",
  ).length;
  summary.notStartedCycles = contract.cycles
    .filter((c) => !attempts.some((a) => a.cycle === c.id))
    .map((c) => c.id);
  summary.notStartedFaults = contract.adversarial
    .filter((f) => !attempts.some((a) => a.fault === f.id))
    .map((f) => f.id);
  summary.finishedAt = new Date().toISOString();
  writePrivate(join(series.root, "summary.json"), summary);
  if (json(lockPath).token === token) unlinkSync(lockPath);
  console.log(
    JSON.stringify({
      root: series.root,
      status: summary.status,
      cleanCompletions: summary.cleanCompletions,
      firstAttemptPasses: summary.firstAttemptPasses,
      recoveredCompletions: summary.recoveredCompletions,
      faultPasses: summary.faultPasses,
    }),
  );
}
if (summary.status !== "passed") process.exitCode = 1;
