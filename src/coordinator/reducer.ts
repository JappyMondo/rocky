import { canonical, identity } from "../store/json.js";
import {
  inputDigest,
  isAgentWork,
  terminal,
  validateAction,
  validateSnapshot,
  validateEvent,
  evidenceBundle,
  validateCoordinatorAdmission,
  integer,
  subscription,
  reportedTotal,
  STRICT_BUDGET_MODE,
  SUBSCRIPTION_BUDGET_MODE,
  type Admission,
  type Action,
  type Event,
  type RunSnapshot,
  type WorkKind,
  type Blocker,
} from "./contracts.js";

export function initialSnapshot(
  admission: Admission,
  now: number,
): RunSnapshot {
  validateCoordinatorAdmission(admission);
  integer(now);
  const {
    previousRunId: _,
    budget = { mode: STRICT_BUDGET_MODE },
    qualification = null,
    ...a
  } = JSON.parse(canonical(admission)) as Admission;
  const strict = budget.mode === STRICT_BUDGET_MODE;
  const s: RunSnapshot = {
    ...a,
    ...(budget.mode === STRICT_BUDGET_MODE ? {} : { budget, qualification }),
    schema: strict ? 3 : 4,
    revision: 0,
    inputDigest: "",
    stage: "admitted",
    blocker: null,
    cancelled: false,
    startedAt: now,
    budgets: {
      environment: 0,
      product: 0,
      ci: 0,
      review: 0,
      disagreement: 0,
      reservedTokens: 0,
      knownTokens: 0,
      unknownActions: 0,
      legacyReportedTokens: null,
      ...(strict ? {} : { harnessReportedTokens: 0, harnessAmbiguousZero: 0 }),
      reservedElapsedMs: 0,
      elapsedMs: 0,
      observedAt: now,
    },
    execution: null,
    executionUsage: null,
    unqualifiedResults: [],
    receipts: {},
    observations: {},
    signatures: [],
    wait: null,
  };
  s.inputDigest = inputDigest(s);
  if (strict && !s.capability)
    block(s, "capability", "hard-token-and-elapsed-enforcement-unavailable");
  if (!strict && !s.qualification)
    block(s, "capability", "subscription-execution-qualification-unavailable");
  return s;
}
function block(s: RunSnapshot, kind: Blocker, detail: string) {
  s.blocker = { kind, detail };
  s.stage =
    kind === "recovery" || kind === "compatibility"
      ? "recovery_required"
      : "blocked";
}
function invalidate(s: RunSnapshot) {
  s.receipts = {};
  s.inputDigest = inputDigest(s);
}
function pass(s: RunSnapshot, kind: "baseline" | "checks" | "ci" | "review") {
  return s.receipts[kind]?.outcome === "pass";
}
function ready(s: RunSnapshot) {
  if (
    !s.execution &&
    s.unqualifiedResults.length === 0 &&
    !s.cancelled &&
    !s.blocker &&
    pass(s, "checks") &&
    pass(s, "ci") &&
    pass(s, "review")
  )
    s.stage = "handoff_ready";
}
function permitted(s: RunSnapshot, kind: WorkKind) {
  switch (kind) {
    case "baseline":
      return s.stage === "admitted";
    case "implement":
      return s.stage === "baseline" && pass(s, "baseline");
    case "verify":
      return s.stage === "verifying";
    case "observe_ci":
      return (
        ["awaiting_delivery_evidence", "handoff_ready", "blocked"].includes(
          s.stage,
        ) && pass(s, "checks")
      );
    case "review":
      return (
        s.stage === "awaiting_delivery_evidence" &&
        pass(s, "checks") &&
        !s.receipts.review
      );
    case "repair_product":
      return s.receipts.checks?.outcome === "fail";
    case "repair_ci":
      return s.receipts.ci?.outcome === "fail";
    case "repair_review":
      return s.receipts.review?.outcome === "fail";
    case "retry_environment":
      return s.blocker?.kind === "environment";
    case "arbitrate":
      return s.receipts.review?.outcome === "fail";
  }
}
function schedule(s: RunSnapshot, kind: WorkKind, now: number): Action | null {
  if (s.execution) throw new Error("execution-unquiesced");
  if (
    s.cancelled ||
    [
      "cancelled",
      "cancelling",
      "no_code",
      "recovery_required",
      "waiting_external",
    ].includes(s.stage)
  )
    throw new Error("run-not-dispatchable");
  // Review exhaustion may block subjective work, but must not stop CI observation or its independent repair.
  if (
    s.blocker &&
    !(kind === "retry_environment" && s.blocker.kind === "environment") &&
    !(
      ["observe_ci", "repair_ci"].includes(kind) &&
      ["needs_engineering", "budget"].includes(s.blocker.kind)
    )
  )
    throw new Error("run-blocked");
  if (!permitted(s, kind)) throw new Error("invalid-stage-action");
  const b = s.budgets;
  if (isAgentWork(kind)) {
    if (!subscription(s) && !s.capability) {
      block(s, "capability", "hard-limits-unavailable");
      return null;
    }
    if (subscription(s) && !s.qualification) {
      block(
        s,
        "capability",
        "subscription-execution-qualification-unavailable",
      );
      return null;
    }
    // Single choke point for every automatic agent action, before any counter or charge moves.
    const stop = usageStop(s);
    if (stop) {
      block(s, "budget", stop);
      return null;
    }
  }
  const stop = (detail: string) => {
    block(s, "needs_engineering", detail);
    return null;
  };
  if (kind === "retry_environment" && b.environment >= 1) {
    block(s, "environment", "environment-retry-exhausted");
    return null;
  }
  if (kind === "repair_product" && (b.product >= 1 || b.product + b.ci >= 2))
    return stop("shared-product-repair-exhausted-ci-reserved");
  if (kind === "repair_ci" && b.product + b.ci >= 2)
    return stop("ci-repair-exhausted");
  if (kind === "repair_review" && b.review >= 1)
    return stop("review-correction-exhausted");
  if (kind === "arbitrate" && b.disagreement >= 1)
    return stop("disagreement-exhausted");
  const receipt =
    kind === "repair_ci"
      ? s.receipts.ci
      : kind === "repair_product"
        ? s.receipts.checks
        : ["repair_review", "arbitrate"].includes(kind)
          ? s.receipts.review
          : null;
  if (receipt) {
    const sig = identity({
      kind,
      input: s.inputDigest,
      signature: receipt.signature,
      evidence: receipt.reference,
    });
    if (s.signatures.includes(sig)) return stop("repeated-unchanged-failure");
    s.signatures.push(sig);
  }
  const tokens = isAgentWork(kind) ? s.limits.actionTokens : 0;
  const elapsedMs = s.limits.actionElapsedMs;
  if (
    b.reservedTokens + tokens > s.limits.totalTokens ||
    Math.max(b.elapsedMs, b.reservedElapsedMs) + elapsedMs >
      s.limits.totalElapsedMs
  ) {
    block(
      s,
      "budget",
      subscription(s)
        ? "planning-allowance-exhausted"
        : "hard-total-budget-exhausted",
    );
    return null;
  }
  if (kind === "retry_environment") b.environment++;
  if (kind === "repair_product") b.product++;
  if (kind === "repair_ci") b.ci++;
  if (kind === "repair_review") b.review++;
  if (kind === "arbitrate") b.disagreement++;
  b.reservedTokens += tokens;
  b.reservedElapsedMs += elapsedMs;
  const common = {
    key: `coordinator/${identity([s.runId, s.revision, kind])}`,
    runId: s.runId,
    kind,
    inputDigest: s.inputDigest,
    versions: s.versions,
    tokens,
    elapsedMs,
    deadline: Math.min(now + elapsedMs, s.startedAt + s.limits.totalElapsedMs),
  };
  const action: Action = !subscription(s)
    ? {
        schema: 1,
        ...common,
        capabilityId: isAgentWork(kind) ? s.capability!.id : null,
      }
    : {
        schema: 2,
        ...common,
        budgetMode: SUBSCRIPTION_BUDGET_MODE,
        qualificationId: isAgentWork(kind) ? s.qualification!.id : null,
      };
  validateAction(action);
  s.execution = action;
  s.blocker = null;
  if (
    ["implement", "repair_product", "repair_ci", "repair_review"].includes(kind)
  )
    s.stage = "implementing";
  else if (kind === "baseline" || kind === "retry_environment")
    s.stage = "baseline";
  return action;
}
/** Pure decision function. Store validates source/event and supplies its own time and fenced snapshot. */
export function reduce(
  snapshot: RunSnapshot,
  event: Event,
  now: number,
): { snapshot: RunSnapshot; actions: Action[] } {
  validateSnapshot(snapshot);
  validateEvent(
    event,
    ["observation", "receipt"].includes(event.type)
      ? "evidence"
      : event.type === "result"
        ? "transport"
        : ["schedule", "tick", "wake"].includes(event.type)
          ? "scheduler"
          : "control",
  );
  integer(now);
  const s = JSON.parse(canonical(snapshot)) as RunSnapshot;
  s.revision++;
  s.budgets.observedAt = Math.max(s.budgets.observedAt, now);
  s.budgets.elapsedMs = Math.max(
    s.budgets.elapsedMs,
    s.budgets.observedAt - s.startedAt,
  );
  const actions: Action[] = [];
  // Cancellation and quiescence observations remain legal after deadline/version incompatibility.
  if (event.type === "cancel") {
    s.cancelled = true;
    s.wait = null;
    s.stage = s.execution ? "cancelling" : "cancelled";
    return { snapshot: s, actions };
  }
  if (event.type === "result") {
    const a = s.execution;
    if (!a || a.key !== event.actionKey || a.inputDigest !== event.inputDigest)
      throw new Error("stale-action-result");
    if (
      s.executionUsage &&
      canonical(s.executionUsage) !== canonical(event.usage)
    )
      throw new Error("action-usage-conflict");
    const u = event.usage;
    if (!subscription(s)) {
      if (u.schema !== 1)
        throw new Error("harness-usage-requires-subscription-mode");
      if (
        u.status === "known" &&
        u.source.kind === "local-no-model" &&
        isAgentWork(a.kind)
      )
        throw new Error("agent-usage-requires-provider-receipt");
    } else if (isAgentWork(a.kind)) {
      // Native telemetry is never relabelled as provider receipt or caller known-zero.
      if (u.schema !== 2)
        throw new Error("subscription-agent-usage-requires-harness-telemetry");
      if (u.harness !== s.qualification?.harness)
        throw new Error("usage-harness-mismatch");
    } else if (
      u.schema !== 1 ||
      u.status !== "known" ||
      u.source.kind !== "local-no-model"
    )
      throw new Error("subscription-local-usage-requires-no-model-receipt");
    s.executionUsage = u;
    // Latch the claim before draining: later failure/interruption cannot erase an observed success.
    const successful = !["failed", "interrupted"].includes(event.outcome);
    const unresolved = u.status === "unknown" || u.status === "ambiguous-zero";
    if (successful && unresolved && !s.unqualifiedResults.includes(a.kind))
      s.unqualifiedResults.push(a.kind);
    if (!event.quiescent) {
      block(s, "recovery", "execution-not-quiescent");
      return { snapshot: s, actions };
    }
    s.execution = null;
    s.executionUsage = null;
    const b = s.budgets;
    if (u.status === "known") b.knownTokens += u.tokens;
    else if (u.status === "unknown") b.unknownActions++;
    else if (u.status === "ambiguous-zero") b.harnessAmbiguousZero! += 1;
    // Reported overrun is retained in full: never clipped to the planning charge or refunded.
    // validateHarnessUsage bounds each report's input+output to a safe integer, and usageStop
    // halts scheduling once the threshold is reached, so accumulation stays bounded in
    // practice; a single enormous (still safe-integer) report could push the sum past
    // Number.MAX_SAFE_INTEGER before the stop engages, but load/save-time validateSnapshot
    // integer() revalidation (contracts.ts budgets pass, store #saveSnapshot) then fails
    // closed on the anomalous value, so no separate overflow check is added here.
    else b.harnessReportedTokens = b.harnessReportedTokens! + reportedTotal(u);
    if (u.status === "known" && u.tokens > a.tokens) {
      block(s, "recovery", "hard-token-contract-violated");
      return { snapshot: s, actions };
    }
    if (s.cancelled) {
      s.stage = "cancelled";
      return { snapshot: s, actions };
    }
    if (s.blocker?.kind === "compatibility") return { snapshot: s, actions };
    if (a.inputDigest !== s.inputDigest) {
      block(s, "recovery", "result-inputs-superseded");
      return { snapshot: s, actions };
    }
    if (s.budgets.observedAt > a.deadline) {
      block(s, "budget", "action-deadline-exceeded");
      return { snapshot: s, actions };
    }
    if (event.outcome === "interrupted") {
      block(s, "recovery", event.detail);
      return { snapshot: s, actions };
    }
    if (event.outcome === "failed") {
      block(
        s,
        ["baseline", "retry_environment"].includes(a.kind)
          ? "environment"
          : "needs_engineering",
        event.detail,
      );
      return { snapshot: s, actions };
    }
    if (unresolved) {
      block(
        s,
        "recovery",
        u.status === "unknown"
          ? "successful-result-usage-unknown"
          : "successful-result-usage-ambiguous-zero",
      );
      return { snapshot: s, actions };
    }
    if (
      ["implement", "repair_product", "repair_ci", "repair_review"].includes(
        a.kind,
      )
    ) {
      if (
        a.kind === "implement" &&
        event.outcome === "no_code" &&
        event.head === s.head
      ) {
        qualifyResult(s, a.kind);
        if (s.unqualifiedResults.length) {
          block(s, "recovery", "unqualified-earlier-result");
          return { snapshot: s, actions };
        }
        s.wait = null;
        s.stage = "no_code";
        return { snapshot: s, actions };
      }
      if (event.outcome !== "changed" || event.head === s.head) {
        block(s, "needs_engineering", "no-op-repair-or-implementation");
        return { snapshot: s, actions };
      }
      s.head = event.head;
      invalidate(s);
      s.stage = "verifying";
      qualifyResult(s, a.kind);
    } else if (event.outcome !== "complete" || event.head !== s.head) {
      block(s, "recovery", "unexpected-result");
    } else qualifyResult(s, a.kind);
    if (s.wait && !s.blocker) {
      if (s.stage !== "waiting_external") s.wait.resume = s.stage;
      s.stage = "waiting_external";
    } else ready(s);
    return { snapshot: s, actions };
  }
  if (s.cancelled) throw new Error("cancelled");
  if (s.stage === "no_code" && !["tick", "incompatible"].includes(event.type))
    throw new Error("run-not-dispatchable");
  if (event.type === "incompatible") {
    block(s, "compatibility", event.detail);
    return { snapshot: s, actions };
  }
  if (event.type === "tick") {
    if (
      s.blocker?.kind !== "compatibility" &&
      s.budgets.elapsedMs >= s.limits.totalElapsedMs
    )
      block(s, "budget", "total-elapsed-exhausted");
    return { snapshot: s, actions };
  }
  if (s.blocker?.kind === "compatibility")
    throw new Error("incompatible-versions");
  if (event.type === "revise") {
    if (
      event.scope.revision < s.scope.revision ||
      (event.scope.revision === s.scope.revision &&
        canonical(event.scope) !== canonical(s.scope))
    )
      throw new Error("scope-revision-required");
    s.head = event.head;
    s.scope = event.scope;
    s.checkPlan = event.checkPlan;
    invalidate(s);
    s.wait = null;
    if (s.execution) block(s, "recovery", "inputs-changed-during-execution");
    else {
      s.stage = "verifying";
      s.blocker = null;
    }
    return { snapshot: s, actions };
  }
  if (event.type === "block") {
    block(s, event.kind, event.detail);
    return { snapshot: s, actions };
  }
  if (event.type === "wait") {
    if (terminal(s)) throw new Error("invalid-wait-stage");
    if (event.wakeAt < now || event.deadline <= now)
      throw new Error("invalid-wait-deadline");
    s.wait = {
      reason: event.reason,
      wakeAt: event.wakeAt,
      deadline: event.deadline,
      resume: s.wait?.resume ?? s.stage,
    };
    s.stage = "waiting_external";
    return { snapshot: s, actions };
  }
  if (event.type === "wake") {
    if (!s.wait || s.execution) throw new Error("wait-not-quiescent");
    if (now < s.wait.wakeAt) throw new Error("wake-not-due");
    if (now >= s.wait.deadline) {
      block(s, "access", "external-wait-deadline");
      s.wait = null;
    } else {
      s.stage = s.wait.resume;
      s.wait = null;
    }
    return { snapshot: s, actions };
  }
  if (event.type === "observation") {
    const o = event.observation;
    if (
      o.runId !== s.runId ||
      o.inputDigest !== s.inputDigest ||
      o.bundleDigest !== evidenceBundle(s, o.kind)
    )
      throw new Error("stale-observation-inputs");
    if (o.generation !== (s.observations[o.kind]?.generation ?? 0) + 1)
      throw new Error("invalid-observation-generation");
    s.observations[o.kind] = o;
    delete s.receipts[o.kind];
    invalidateDependentReceipts(s, o.kind);
    if (s.stage === "handoff_ready") s.stage = "awaiting_delivery_evidence";
    return { snapshot: s, actions };
  }
  if (event.type === "receipt") {
    const o = event.receipt.observation;
    if (canonical(s.observations[event.kind] ?? null) !== canonical(o))
      throw new Error("superseded-observation");
    if (o.bundleDigest !== evidenceBundle(s, event.kind))
      throw new Error("stale-evidence-bundle");
    const i = event.receipt.inputs;
    if (
      i.head !== s.head ||
      i.base !== s.scope.base ||
      i.scope !== identity(s.scope) ||
      i.build !== s.versions.build ||
      i.checkPlan !== s.checkPlan ||
      i.coordinatorInput !== s.inputDigest
    )
      throw new Error("stale-evidence");
    if (canonical(s.receipts[event.kind] ?? null) === canonical(event.receipt))
      return { snapshot: s, actions };
    s.receipts[event.kind] = event.receipt;
    invalidateDependentReceipts(s, event.kind);
    if (event.kind === "baseline") {
      s.stage = "baseline";
      if (event.receipt.outcome !== "pass")
        block(s, "environment", "baseline-prerequisite-failed");
    }
    if (event.kind === "checks")
      s.stage =
        event.receipt.outcome === "pass"
          ? "awaiting_delivery_evidence"
          : "verifying";
    if (["ci", "review"].includes(event.kind) && s.stage === "handoff_ready")
      s.stage = "awaiting_delivery_evidence";
    if (s.wait) {
      if (s.stage !== "waiting_external") s.wait.resume = s.stage;
      s.stage = "waiting_external";
    } else ready(s);
    return { snapshot: s, actions };
  }
  const action = schedule(s, event.kind, s.budgets.observedAt);
  if (action) actions.push(action);
  return { snapshot: s, actions };
}

function invalidateDependentReceipts(s: RunSnapshot, kind: string) {
  if (["baseline", "checks", "ci"].includes(kind)) {
    delete s.receipts.review;
    delete s.receipts.approval;
  }
  if (kind === "review") delete s.receipts.approval;
}

/** Only independent successful work in the same role supersedes an unqualified success. */
function qualifyResult(s: RunSnapshot, kind: WorkKind) {
  const role = (k: WorkKind) =>
    ["implement", "repair_product", "repair_ci", "repair_review"].includes(k)
      ? "implementation"
      : ["review", "arbitrate"].includes(k)
        ? "review"
        : ["baseline", "retry_environment"].includes(k)
          ? "baseline"
          : k;
  s.unqualifiedResults = s.unqualifiedResults.filter(
    (k) => role(k) !== role(kind),
  );
}

/** subscription-observed-v1: unresolved usage or a reached reported threshold stops agent work. */
function usageStop(s: RunSnapshot): string | null {
  if (!subscription(s)) return null;
  const b = s.budgets;
  if (b.unknownActions > 0 || b.harnessAmbiguousZero! > 0)
    return "subscription-usage-unresolved";
  if (b.harnessReportedTokens! >= s.budget!.reportedTokenThreshold)
    return "subscription-reported-threshold-reached";
  return null;
}
