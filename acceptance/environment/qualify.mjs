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
import { admissionAttempt, rejection } from "./admission-ledger.mjs";
import { workspace } from "./runtime.mjs";

// No flag fabricates approval or promotes preparation. Ledger exists before any
// runtime import, approval read, binding validation or concurrency/start check.
async function main() {
  workspace();
  const [admissionPath, approvalPath] = process.argv.slice(2);
  let rt,
    approval,
    binding,
    contract,
    lockPath,
    token,
    lockOwned = false;
  try {
    const admissionReceipts = [];
    const preflight = await admissionAttempt(
      { phase: "series-start", admissionPath, approvalPath },
      async (checkpoint) => {
        if (!admissionPath || !approvalPath)
          throw Error("missing-admission-or-approval-path");
        checkpoint("runtime-load-and-integrity");
        rt = await runtime();
        checkpoint("approval-read");
        approval = json(approvalPath);
        checkpoint("binding-validation");
        binding = verifyBinding(rt, admissionPath, approval);
        checkpoint("protected-series-policy");
        contract = json(join(ROOT, "acceptance/environment/manifest.json"));
        if (
          contract.policy.concurrency !== 1 ||
          contract.policy.max_environment_retries_per_cycle !== 1 ||
          contract.cycles.length !== 10 ||
          contract.adversarial.length !== 11
        )
          throw Error("protected-series-shape-drift");
        lockPath = join(rt.api.TARGET.root, "qualification-series.lock");
        token = randomUUID();
        checkpoint("exclusive-series-lock");
        const lock = openSync(lockPath, "wx", 0o600);
        lockOwned = true;
        try {
          writeSync(
            lock,
            JSON.stringify({
              token,
              pid: process.pid,
              admissionSha256: binding.sha256,
            }),
          );
          fsyncSync(lock);
        } finally {
          closeSync(lock);
        }
      },
    );
    admissionReceipts.push(preflight.receipt);
    let series, ledger;
    const start = await admissionAttempt(
      { phase: "series-record-start", admissionPath, approvalPath },
      () => {
        series = attemptRoot("qualification-series");
        ledger = openSync(
          join(series.root, "attempt-ledger.jsonl"),
          "wx",
          0o600,
        );
      },
    );
    admissionReceipts.push(start.receipt);
    const attempts = [],
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
          const validation = await admissionAttempt(
            {
              phase: "cycle-" + cycle.id.toLowerCase() + "-attempt-" + attempt,
              seriesId: series.id,
              admissionPath,
              approvalPath,
            },
            () => verifyBinding(rt, admissionPath, approval),
          );
          admissionReceipts.push(validation.receipt);
          const a = attemptRoot(
            series.id + "-" + cycle.id + "-attempt-" + attempt,
          );
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
            approvalPath,
            prior,
          });
          if (result.admissionReceipt)
            admissionReceipts.push(result.admissionReceipt);
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
        const validation = await admissionAttempt(
          {
            phase: "fault-" + fault.id.toLowerCase(),
            seriesId: series.id,
            admissionPath,
            approvalPath,
          },
          () => verifyBinding(rt, admissionPath, approval),
        );
        admissionReceipts.push(validation.receipt);
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
          approvalPath,
          prior,
        });
        if (result.admissionReceipt)
          admissionReceipts.push(result.admissionReceipt);
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
      summary.stopReason = rejection(error);
      if (error.admissionReceipt)
        admissionReceipts.push(error.admissionReceipt);
      append({
        event: "series-stopped",
        reason: rejection(error),
        at: new Date().toISOString(),
      });
    } finally {
      closeSync(ledger);
      summary.attempts = attempts;
      summary.admissionAttempts = admissionReceipts;
      summary.admissionRejections = admissionReceipts.filter((r) =>
        readFileSync(r.path, "utf8").includes("admission-rejected"),
      );
      summary.accountingPolicy =
        "Admission rejections retained separately; never count as scored attempts or clean completions";
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
  } finally {
    if (lockOwned) {
      // Exact exclusive creation is our authority even if writing its token failed.
      const text = readFileSync(lockPath, "utf8");
      if (!text || json(lockPath).token === token) unlinkSync(lockPath);
      else throw Error("qualification-lock-ownership-unconfirmed");
    }
  }
}
main().catch((error) => {
  console.error(
    JSON.stringify({
      status: "admission-or-start-rejected",
      ...rejection(error),
      ...(error.admissionReceipt ? { receipt: error.admissionReceipt } : {}),
    }),
  );
  process.exitCode = 1;
});
