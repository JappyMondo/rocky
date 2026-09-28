import { canonical } from "../store/json.js";
import {
  object,
  integer,
  validateSnapshot,
  validateLegacySnapshot,
  type RunSnapshot,
  type Stage,
} from "./contracts.js";

/** Legacy receipts cannot authorize continuation. Map their consumers back to bounded recollection. */
function revalidationStage(stage: unknown): Stage {
  switch (stage) {
    case "admitted":
    case "baseline":
      return "admitted";
    case "verifying":
    case "awaiting_delivery_evidence":
    case "handoff_ready":
      return "verifying";
    case "blocked":
    case "recovery_required":
    case "no_code":
    case "cancelled":
    case "cancelling":
      return stage;
    case "implementing":
    case "waiting_external":
      return "recovery_required";
    default:
      throw new Error("incompatible-legacy-stage");
  }
}
/** Pure declared snapshot1 -> snapshot2 policy. Store archives the original and commits this with its run row. */
export function migrateLegacySnapshot(
  value: unknown,
  authoritativeCancelled: boolean,
): unknown {
  const previous = object(value);
  if (previous.schema !== 1 || typeof previous.cancelled !== "boolean")
    throw new Error("incompatible-coordinator-migration");
  integer(previous.revision);
  const mapped = revalidationStage(previous.stage);
  const next = {
    ...JSON.parse(canonical(previous)),
    schema: 2,
    observations: {},
    receipts: {},
    revision: previous.revision + 1,
  };
  next.cancelled =
    authoritativeCancelled ||
    previous.cancelled ||
    previous.stage === "cancelling" ||
    previous.stage === "cancelled";
  const boundary = (detail: string) => {
    next.stage = "recovery_required";
    next.blocker = { kind: "compatibility", detail };
    if (next.wait) next.wait.resume = "recovery_required";
  };
  if (next.cancelled) {
    next.stage = next.execution ? "cancelling" : "cancelled";
    next.wait = null;
  } else if (next.execution) {
    // The old reservation and slot stay occupied. Only quiescence reconciliation/cancellation may settle them.
    boundary("legacy-execution-reconciliation-required-before-explicit-rerun");
  } else {
    next.stage = mapped;
    if (previous.stage === "implementing")
      boundary("legacy-implementation-result-unavailable");
    if (next.wait) {
      const resume = revalidationStage(next.wait.resume);
      if (
        [
          "waiting_external",
          "implementing",
          "cancelled",
          "cancelling",
          "no_code",
        ].includes(next.wait.resume)
      )
        boundary("legacy-wait-resume-ambiguous");
      else {
        next.wait.resume = resume;
        if (previous.stage === "waiting_external")
          next.stage = "waiting_external";
      }
    } else if (previous.stage === "waiting_external")
      boundary("legacy-wait-record-missing");
    if (next.stage === "blocked" && !next.blocker)
      boundary("legacy-blocker-unavailable");
  }
  validateLegacySnapshot(next);
  return next;
}

/** Schema 2 numeric reports had no usage provenance. Preserve, never promote them. */
export function migrateUsageSnapshot(
  value: unknown,
  authoritativeCancelled: boolean,
): RunSnapshot {
  validateLegacySnapshot(value);
  const previous = JSON.parse(canonical(value));
  const { reportedTokens, ...budgets } = previous.budgets;
  const next: RunSnapshot = {
    ...previous,
    schema: 3,
    revision: previous.revision + 1,
    budgets: {
      ...budgets,
      knownTokens: 0,
      unknownActions: 0,
      legacyReportedTokens: reportedTokens,
    },
    executionUsage: null,
    unqualifiedResults: [],
  };
  next.cancelled =
    authoritativeCancelled ||
    next.cancelled ||
    ["cancelled", "cancelling"].includes(next.stage);
  if (next.cancelled) {
    next.stage = next.execution ? "cancelling" : "cancelled";
    next.wait = null;
  } else if (next.execution) {
    next.stage = "recovery_required";
    next.blocker = {
      kind: "compatibility",
      detail: "legacy-execution-reconciliation-required-before-explicit-rerun",
    };
    if (next.wait) next.wait.resume = "recovery_required";
  } else if (next.stage === "handoff_ready") {
    next.stage = "verifying";
    next.receipts = {};
    next.observations = {};
  }
  validateSnapshot(next);
  return next;
}
