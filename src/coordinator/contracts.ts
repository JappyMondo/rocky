import { canonical, identity } from "../store/json.js";
import type { Versions } from "../store/index.js";
import type { Artifact, EvidenceInputs } from "../evidence/index.js";

export type Stage =
  | "admitted"
  | "baseline"
  | "implementing"
  | "verifying"
  | "awaiting_delivery_evidence"
  | "handoff_ready"
  | "no_code"
  | "blocked"
  | "waiting_external"
  | "recovery_required"
  | "cancelling"
  | "cancelled";
export type Blocker =
  | "environment"
  | "access"
  | "hardware"
  | "capability"
  | "needs_engineering"
  | "budget"
  | "compatibility"
  | "recovery";
export interface ScopeContract {
  schema: 1;
  revision: number;
  behavior: string[];
  exclusions: string[];
  surfaces: string[];
  fixtureIds: string[];
  acceptanceManifest: string;
  base: string;
  deliveryMode: "pr-only" | "approval-gated";
}
export interface HardLimitsCapability {
  id: string;
  hardTokenLimit: true;
  hardElapsedLimit: true;
}
/** Existing strict mode: agent work requires HardLimitsCapability and provider-receipt usage. */
export const STRICT_BUDGET_MODE = "strict-provider-v1";
/**
 * Harness-neutral direct subscription mode (budget semantics accepted in #88 / #89). Any directly
 * invoked coding harness (for example claude-code or codex-exec) uses the same accounting rules.
 */
export const SUBSCRIPTION_BUDGET_MODE = "subscription-observed-v1";
/**
 * Explicit per-run accounting policy, immutable after admission. The subscription mode has no
 * hard aggregate token limit, mid-turn cutoff or overshoot bound: its threshold is compared with
 * harness-reported totals only before another automatic agent action is reserved.
 */
export type BudgetPolicy =
  | { mode: typeof STRICT_BUDGET_MODE }
  | { mode: typeof SUBSCRIPTION_BUDGET_MODE; reportedTokenThreshold: number };
/**
 * Runtime/containment qualification identity for a subscription-mode run: which harness and which
 * independently approved harness-specific contract/binding. It carries no accounting guarantee and
 * no capability booleans. This package ships no loader or approved binding, so production
 * subscription agent admission remains unavailable.
 */
export interface ExecutionQualification {
  schema: 1;
  id: string;
  harness: string;
  contractId: string;
  budgetMode: typeof SUBSCRIPTION_BUDGET_MODE;
  binding: string;
}
export interface CoordinatorLimits {
  totalTokens: number;
  totalElapsedMs: number;
  actionTokens: number;
  actionElapsedMs: number;
}
export type WorkKind =
  | "baseline"
  | "implement"
  | "verify"
  | "observe_ci"
  | "review"
  | "repair_product"
  | "repair_ci"
  | "repair_review"
  | "retry_environment"
  | "arbitrate";
interface ActionCommon {
  key: string;
  runId: string;
  kind: WorkKind;
  inputDigest: string;
  versions: Versions;
  /** Strict: hard per-action token ceiling. Subscription: planning charge only. */
  tokens: number;
  elapsedMs: number;
  deadline: number;
}
export type Action =
  | (ActionCommon & { schema: 1; capabilityId: string | null })
  | (ActionCommon & {
      schema: 2;
      budgetMode: typeof SUBSCRIPTION_BUDGET_MODE;
      qualificationId: string | null;
    });
/** Trusted transport evidence references, not provider/capability attestation by themselves. */
export type TokenUsage =
  | {
      schema: 1;
      status: "known";
      tokens: number;
      source: {
        kind: "provider-receipt" | "local-no-model";
        reference: string;
      };
    }
  | { schema: 1; status: "unknown"; reason: string };
/**
 * Harness-neutral action-level usage reported by a directly invoked harness in subscription mode.
 * Never provider usage and never actual consumption. `harness` names the reporting harness and
 * `receipt` is the sha256 of the retained raw telemetry it was derived from (for example a codex
 * exec turn.completed event, or Claude Code's final result usage). Adapters normalize native
 * fields into subset semantics: `input` is ALL input including cache reads/writes, `cachedInput`
 * and `cacheWriteInput` are subsets of it, `reasoningOutput` is a subset of `output`; null means
 * the harness did not report that subset. Comparison total is input+output, subsets never added.
 * Intermediate per-message reports are not an action total. Absent/all-zero totals must be
 * ambiguous-zero or unknown, never a known zero.
 */
export type HarnessUsage =
  | {
      schema: 2;
      status: "reported";
      source: "native-harness-telemetry";
      harness: string;
      receipt: string;
      components: {
        input: number;
        cachedInput: number | null;
        cacheWriteInput: number | null;
        output: number;
        reasoningOutput: number | null;
      };
    }
  | {
      schema: 2;
      status: "ambiguous-zero";
      source: "native-harness-telemetry";
      harness: string;
      receipt: string;
    }
  | {
      schema: 2;
      status: "unknown";
      source: "native-harness-telemetry";
      harness: string;
      reason: string;
    };
export type ActionUsage = TokenUsage | HarnessUsage;
export interface Budgets {
  environment: number;
  product: number;
  ci: number;
  review: number;
  disagreement: number;
  reservedTokens: number;
  knownTokens: number;
  unknownActions: number;
  legacyReportedTokens: number | null;
  /** Snapshot4 only: unclipped sum of reported input+output; never provider/actual usage. */
  harnessReportedTokens?: number;
  /** Snapshot4 only: settled actions whose telemetry was absent or all-zero. */
  harnessAmbiguousZero?: number;
  reservedElapsedMs: number;
  elapsedMs: number;
  observedAt: number;
}
export interface Observation {
  schema: 1;
  runId: string;
  kind: ReceiptKind;
  collectorKey: string;
  generation: number;
  inputDigest: string;
  bundleDigest: string;
}
export interface ReceiptState {
  observation: Observation;
  reference: Artifact;
  inputs: EvidenceInputs;
  outcome: "pass" | "fail" | "blocked";
  signature: string;
  diagnostics: "available" | "unavailable";
}
export type ReceiptKind = "baseline" | "checks" | "ci" | "review" | "approval";
export interface RunSnapshot {
  schema: 3 | 4;
  runId: string;
  repository: string;
  issue: string;
  rerun: string;
  workspace: string;
  revision: number;
  versions: Versions;
  scope: ScopeContract;
  head: string;
  checkPlan: string;
  inputDigest: string;
  stage: Stage;
  blocker: { kind: Blocker; detail: string } | null;
  cancelled: boolean;
  startedAt: number;
  limits: CoordinatorLimits;
  capability: HardLimitsCapability | null;
  /** Snapshot4 only. The snapshot schema itself is the immutable per-run mode. */
  budget?: Extract<BudgetPolicy, { mode: typeof SUBSCRIPTION_BUDGET_MODE }>;
  qualification?: ExecutionQualification | null;
  budgets: Budgets;
  execution: Action | null;
  executionUsage: ActionUsage | null;
  unqualifiedResults: WorkKind[];
  receipts: Partial<Record<ReceiptKind, ReceiptState>>;
  observations: Partial<Record<ReceiptKind, Observation>>;
  signatures: string[];
  wait: {
    reason: string;
    wakeAt: number;
    deadline: number;
    resume: Stage;
  } | null;
}
export type Event =
  | { type: "observation"; observation: Observation }
  | { type: "schedule"; kind: WorkKind }
  | { type: "cancel" }
  | { type: "block"; kind: Blocker; detail: string }
  | { type: "wait"; reason: string; wakeAt: number; deadline: number }
  | { type: "wake" }
  | { type: "tick" }
  | { type: "revise"; head: string; scope: ScopeContract; checkPlan: string }
  | { type: "incompatible"; detail: string }
  | {
      type: "result";
      actionKey: string;
      inputDigest: string;
      quiescent: boolean;
      usage: ActionUsage;
      outcome: "changed" | "no_code" | "complete" | "failed" | "interrupted";
      head: string;
      detail: string;
    }
  | { type: "receipt"; kind: ReceiptKind; receipt: ReceiptState };
export type InboxSource = "control" | "scheduler" | "transport" | "evidence";
export interface Admission {
  runId: string;
  repository: string;
  issue: string;
  rerun: string;
  previousRunId: string | null;
  workspace: string;
  versions: Versions;
  scope: ScopeContract;
  head: string;
  checkPlan: string;
  limits: CoordinatorLimits;
  capability: HardLimitsCapability | null;
  /** Absent means the existing strict mode; subscription mode must be requested explicitly. */
  budget?: BudgetPolicy;
  qualification?: ExecutionQualification | null;
}
export function object(value: unknown): Record<string, unknown> {
  canonical(value);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("object-required");
  return value as Record<string, unknown>;
}
function enumString(value: unknown): string {
  if (typeof value !== "string") throw new Error("string-enum-required");
  return value;
}
function keys(v: Record<string, unknown>, expected: string[]) {
  if (Object.keys(v).sort().join() !== expected.sort().join())
    throw new Error("invalid-contract-fields");
}
export function text(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value || value.includes("\0"))
    throw new Error("identity-required");
}
export function integer(value: unknown, min = 0): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < min)
    throw new Error("invalid-counter");
}
export function validateScope(value: unknown): asserts value is ScopeContract {
  const s = object(value);
  keys(s, [
    "schema",
    "revision",
    "behavior",
    "exclusions",
    "surfaces",
    "fixtureIds",
    "acceptanceManifest",
    "base",
    "deliveryMode",
  ]);
  if (
    s.schema !== 1 ||
    !["pr-only", "approval-gated"].includes(enumString(s.deliveryMode))
  )
    throw new Error("incompatible-scope");
  integer(s.revision, 1);
  for (const k of ["behavior", "exclusions", "surfaces", "fixtureIds"]) {
    if (!Array.isArray(s[k])) throw new Error("invalid-scope");
    for (const item of s[k]) text(item);
  }
  if (!(s.behavior as unknown[]).length) throw new Error("empty-behavior");
  text(s.acceptanceManifest);
  text(s.base);
}
export function validateVersions(value: unknown): asserts value is Versions {
  const v = object(value);
  keys(v, ["workflow", "adapter", "prompt", "runner", "build"]);
  Object.values(v).forEach(text);
}
export function validateCapability(
  value: unknown,
): asserts value is HardLimitsCapability | null {
  if (value === null) return;
  const v = object(value);
  keys(v, ["id", "hardTokenLimit", "hardElapsedLimit"]);
  text(v.id);
  if (v.hardTokenLimit !== true || v.hardElapsedLimit !== true)
    throw new Error("unsupported-hard-limits");
}
const sha256 = /^[a-f0-9]{64}$/;
export function validateBudgetPolicy(
  value: unknown,
): asserts value is BudgetPolicy {
  const p = object(value);
  if (p.mode === STRICT_BUDGET_MODE) keys(p, ["mode"]);
  else if (p.mode === SUBSCRIPTION_BUDGET_MODE) {
    keys(p, ["mode", "reportedTokenThreshold"]);
    integer(p.reportedTokenThreshold, 1);
  } else throw new Error("unsupported-budget-mode");
}
export function validateQualification(
  value: unknown,
): asserts value is ExecutionQualification | null {
  if (value === null) return;
  const q = object(value);
  keys(q, ["schema", "id", "harness", "contractId", "budgetMode", "binding"]);
  for (const k of ["id", "harness", "contractId"]) text(q[k]);
  if (
    q.schema !== 1 ||
    q.budgetMode !== SUBSCRIPTION_BUDGET_MODE ||
    typeof q.binding !== "string" ||
    !sha256.test(q.binding)
  )
    throw new Error("invalid-execution-qualification");
}
/** Mode-specific authority: hard-limit capabilities never apply to subscription runs, and vice versa. */
function validateBudgetBinding(
  budget: unknown,
  qualification: unknown,
  capability: unknown,
) {
  validateBudgetPolicy(budget);
  validateQualification(qualification);
  if (budget.mode === STRICT_BUDGET_MODE && qualification !== null)
    throw new Error("strict-mode-rejects-subscription-qualification");
  if (budget.mode === SUBSCRIPTION_BUDGET_MODE && capability !== null)
    throw new Error("subscription-mode-rejects-hard-limits-capability");
}
export function subscription(s: Pick<RunSnapshot, "schema">) {
  return s.schema === 4;
}
export function validateCoordinatorAdmission(
  value: unknown,
): asserts value is Admission {
  const a = object(value);
  keys(a, [
    "runId",
    "repository",
    "issue",
    "rerun",
    "previousRunId",
    "workspace",
    "versions",
    "scope",
    "head",
    "checkPlan",
    "limits",
    "capability",
    ...["budget", "qualification"].filter((k) => Object.hasOwn(a, k)),
  ]);
  for (const k of [
    "runId",
    "repository",
    "issue",
    "rerun",
    "workspace",
    "head",
    "checkPlan",
  ])
    text(a[k]);
  if (a.previousRunId !== null) text(a.previousRunId);
  validateScope(a.scope);
  validateVersions(a.versions);
  validateCapability(a.capability);
  validateBudgetBinding(
    a.budget ?? { mode: STRICT_BUDGET_MODE },
    a.qualification ?? null,
    a.capability,
  );
  const limits = object(a.limits);
  keys(limits, [
    "totalTokens",
    "totalElapsedMs",
    "actionTokens",
    "actionElapsedMs",
  ]);
  Object.values(limits).forEach((v) => integer(v, 1));
  if (
    Number(limits.actionTokens) > Number(limits.totalTokens) ||
    Number(limits.actionElapsedMs) > Number(limits.totalElapsedMs)
  )
    throw new Error("invalid-limits");
}
const workKinds = [
  "baseline",
  "implement",
  "verify",
  "observe_ci",
  "review",
  "repair_product",
  "repair_ci",
  "repair_review",
  "retry_environment",
  "arbitrate",
];
const blockers = [
  "environment",
  "access",
  "hardware",
  "capability",
  "needs_engineering",
  "budget",
  "compatibility",
  "recovery",
];
export function validateAction(value: unknown): asserts value is Action {
  const a = object(value);
  const common = [
    "schema",
    "key",
    "runId",
    "kind",
    "inputDigest",
    "versions",
    "tokens",
    "elapsedMs",
    "deadline",
  ];
  if (
    !(a.schema === 1 || a.schema === 2) ||
    (a.schema === 2 && a.budgetMode !== SUBSCRIPTION_BUDGET_MODE)
  )
    throw new Error("invalid-action");
  keys(
    a,
    a.schema === 1
      ? [...common, "capabilityId"]
      : [...common, "budgetMode", "qualificationId"],
  );
  if (!workKinds.includes(enumString(a.kind)))
    throw new Error("invalid-action");
  for (const key of ["key", "runId", "inputDigest"]) text(a[key]);
  validateVersions(a.versions);
  integer(a.tokens);
  integer(a.elapsedMs, 1);
  integer(a.deadline, 1);
  const authority = a.schema === 1 ? a.capabilityId : a.qualificationId;
  if (authority !== null) text(authority);
}
export function validateEvent(
  value: unknown,
  source: InboxSource,
): asserts value is Event {
  const e = object(value);
  enumString(source);
  const fields: Record<string, string[]> = {
    observation: ["observation"],
    schedule: ["kind"],
    cancel: [],
    block: ["kind", "detail"],
    wait: ["reason", "wakeAt", "deadline"],
    wake: [],
    tick: [],
    revise: ["head", "scope", "checkPlan"],
    incompatible: ["detail"],
    result: [
      "actionKey",
      "inputDigest",
      "quiescent",
      "usage",
      "outcome",
      "head",
      "detail",
    ],
    receipt: ["kind", "receipt"],
  };
  const type = enumString(e.type);
  if (!Object.hasOwn(fields, type)) throw new Error("unsupported-event");
  keys(e, ["type", ...fields[type]!]);
  const allowed: Record<InboxSource, string[]> = {
    control: ["cancel", "block", "wait", "revise", "incompatible"],
    scheduler: ["schedule", "wake", "tick"],
    transport: ["result"],
    evidence: ["receipt", "observation"],
  };
  if (!allowed[source]?.includes(type))
    throw new Error("event-authority-rejected");
  switch (type) {
    case "observation":
      validateObservation(e.observation);
      break;
    case "schedule":
      if (!workKinds.includes(enumString(e.kind)))
        throw new Error("invalid-action-kind");
      break;
    case "block":
      if (!blockers.includes(enumString(e.kind)))
        throw new Error("invalid-blocker");
      text(e.detail);
      break;
    case "wait":
      text(e.reason);
      integer(e.wakeAt);
      integer(e.deadline);
      if (Number(e.wakeAt) > Number(e.deadline))
        throw new Error("invalid-wait");
      break;
    case "revise":
      text(e.head);
      text(e.checkPlan);
      validateScope(e.scope);
      break;
    case "incompatible":
      text(e.detail);
      break;
    case "result":
      for (const k of ["actionKey", "inputDigest", "head", "detail"])
        text(e[k]);
      validateUsage(e.usage);
      if (
        typeof e.quiescent !== "boolean" ||
        !["changed", "no_code", "complete", "failed", "interrupted"].includes(
          enumString(e.outcome),
        )
      )
        throw new Error("invalid-result");
      break;
    case "receipt": {
      if (
        !["baseline", "checks", "ci", "review", "approval"].includes(
          enumString(e.kind),
        )
      )
        throw new Error("invalid-receipt-kind");
      const r = object(e.receipt);
      keys(r, [
        "observation",
        "reference",
        "inputs",
        "outcome",
        "signature",
        "diagnostics",
      ]);
      validateObservation(r.observation);
      if (r.observation.kind !== e.kind)
        throw new Error("observation-kind-mismatch");
      const ref = object(r.reference);
      keys(ref, ["sha256", "bytes"]);
      text(ref.sha256);
      integer(ref.bytes);
      if (!/^[a-f0-9]{64}$/.test(enumString(ref.sha256)))
        throw new Error("invalid-artifact-id");
      const inputs = object(r.inputs);
      Object.values(inputs).forEach(text);
      if (
        !["pass", "fail", "blocked"].includes(enumString(r.outcome)) ||
        !["available", "unavailable"].includes(enumString(r.diagnostics))
      )
        throw new Error("invalid-receipt");
      text(r.signature);
      break;
    }
  }
}
export function inputDigest(
  s: Pick<RunSnapshot, "scope" | "head" | "checkPlan" | "versions">,
): string {
  return identity({
    scope: s.scope,
    head: s.head,
    checkPlan: s.checkPlan,
    versions: s.versions,
  });
}
export function isAgentWork(kind: WorkKind) {
  return [
    "implement",
    "review",
    "repair_product",
    "repair_ci",
    "repair_review",
    "arbitrate",
  ].includes(kind);
}
export function terminal(s: RunSnapshot) {
  return ["cancelled", "no_code", "handoff_ready"].includes(s.stage);
}

/** Corrupt or unknown durable snapshots are recovery inputs, never dispatch permission. */
export function validateSnapshot(value: unknown): asserts value is RunSnapshot {
  validateSnapshotShape(value, object(value).schema === 4 ? 4 : 3);
}
/** Only the explicit migration path may accept schema 2. */
export function validateLegacySnapshot(value: unknown) {
  validateSnapshotShape(value, 2);
}
function validateSnapshotShape(value: unknown, schema: 2 | 3 | 4) {
  const legacy = schema === 2;
  const s = object(value);
  if (s.schema !== schema) throw new Error("incompatible-coordinator-schema");
  keys(s, [
    "schema",
    "runId",
    "repository",
    "issue",
    "rerun",
    "workspace",
    "revision",
    "versions",
    "scope",
    "head",
    "checkPlan",
    "inputDigest",
    "stage",
    "blocker",
    "cancelled",
    "startedAt",
    "limits",
    "capability",
    ...(schema === 4 ? ["budget", "qualification"] : []),
    "budgets",
    "execution",
    ...(legacy ? [] : ["executionUsage", "unqualifiedResults"]),
    "receipts",
    "observations",
    "signatures",
    "wait",
  ]);
  validateCoordinatorAdmission({
    runId: s.runId,
    repository: s.repository,
    issue: s.issue,
    rerun: s.rerun,
    workspace: s.workspace,
    previousRunId: null,
    versions: s.versions,
    scope: s.scope,
    head: s.head,
    checkPlan: s.checkPlan,
    limits: s.limits,
    capability: s.capability,
    ...(schema === 4
      ? { budget: s.budget, qualification: s.qualification }
      : {}),
  });
  integer(s.revision);
  integer(s.startedAt);
  if (
    typeof s.cancelled !== "boolean" ||
    ![
      "admitted",
      "baseline",
      "implementing",
      "verifying",
      "awaiting_delivery_evidence",
      "handoff_ready",
      "no_code",
      "blocked",
      "waiting_external",
      "recovery_required",
      "cancelling",
      "cancelled",
    ].includes(enumString(s.stage))
  )
    throw new Error("invalid-snapshot-state");
  if (s.inputDigest !== inputDigest(value as RunSnapshot))
    throw new Error("snapshot-identity-mismatch");
  const b = object(s.budgets);
  keys(b, [
    "environment",
    "product",
    "ci",
    "review",
    "disagreement",
    "reservedTokens",
    ...(legacy
      ? ["reportedTokens"]
      : ["knownTokens", "unknownActions", "legacyReportedTokens"]),
    ...(schema === 4 ? ["harnessReportedTokens", "harnessAmbiguousZero"] : []),
    "reservedElapsedMs",
    "elapsedMs",
    "observedAt",
  ]);
  Object.entries(b).forEach(([key, v]) => {
    if (key !== "legacyReportedTokens" || v !== null) integer(v);
  });
  const mode = schema === 4 ? SUBSCRIPTION_BUDGET_MODE : STRICT_BUDGET_MODE;
  if (schema === 4 && object(s.budget).mode !== SUBSCRIPTION_BUDGET_MODE)
    throw new Error("invalid-snapshot-budget-mode");
  if (!legacy) {
    if (s.executionUsage !== null) {
      validateUsage(s.executionUsage);
      if (s.execution === null) throw new Error("usage-without-execution");
      if (mode !== SUBSCRIPTION_BUDGET_MODE && s.executionUsage.schema !== 1)
        throw new Error("incompatible-usage-schema");
    }
    if (
      !Array.isArray(s.unqualifiedResults) ||
      new Set(s.unqualifiedResults).size !== s.unqualifiedResults.length
    )
      throw new Error("invalid-unqualified-results");
    for (const kind of s.unqualifiedResults)
      if (!workKinds.includes(enumString(kind)))
        throw new Error("invalid-unqualified-results");
  }
  if (
    Number(b.environment) > 1 ||
    Number(b.product) > 1 ||
    Number(b.product) + Number(b.ci) > 2 ||
    Number(b.review) > 1 ||
    Number(b.disagreement) > 1
  )
    throw new Error("invalid-snapshot-budget");
  if (s.execution !== null) {
    validateAction(s.execution);
    if (
      s.execution.runId !== s.runId ||
      s.execution.schema !== (mode === SUBSCRIPTION_BUDGET_MODE ? 2 : 1)
    )
      throw new Error("invalid-snapshot-execution");
  }
  if (!Array.isArray(s.signatures)) throw new Error("invalid-signatures");
  s.signatures.forEach(text);
  if (s.blocker !== null) {
    const blocker = object(s.blocker);
    keys(blocker, ["kind", "detail"]);
    if (!blockers.includes(enumString(blocker.kind)))
      throw new Error("invalid-blocker");
    text(blocker.detail);
  }
  if (s.wait !== null) {
    const wait = object(s.wait);
    keys(wait, ["reason", "wakeAt", "deadline", "resume"]);
    text(wait.reason);
    if (
      ![
        "admitted",
        "baseline",
        "implementing",
        "verifying",
        "awaiting_delivery_evidence",
        "handoff_ready",
        "blocked",
        "recovery_required",
        "cancelling",
      ].includes(enumString(wait.resume))
    )
      throw new Error("invalid-wait-resume-stage");
    integer(wait.wakeAt);
    integer(wait.deadline);
  }
  for (const [kind, observation] of Object.entries(object(s.observations))) {
    validateObservation(observation);
    if (observation.kind !== kind || observation.runId !== s.runId)
      throw new Error("invalid-snapshot-observation");
  }
  for (const [kind, receipt] of Object.entries(object(s.receipts)))
    validateEvent({ type: "receipt", kind, receipt }, "evidence");
}

export function validateObservation(
  value: unknown,
): asserts value is Observation {
  const o = object(value);
  keys(o, [
    "schema",
    "runId",
    "kind",
    "collectorKey",
    "generation",
    "inputDigest",
    "bundleDigest",
  ]);
  if (
    o.schema !== 1 ||
    !["baseline", "checks", "ci", "review", "approval"].includes(
      enumString(o.kind),
    )
  )
    throw new Error("invalid-observation");
  for (const k of ["runId", "collectorKey", "inputDigest", "bundleDigest"])
    text(o[k]);
  integer(o.generation, 1);
}
/** Exact evidence consumed by subjective review or approval, including in-progress generations. */
export function evidenceBundle(s: RunSnapshot, kind: ReceiptKind): string {
  const dependencies: ReceiptKind[] =
    kind === "review"
      ? ["baseline", "checks", "ci"]
      : kind === "approval"
        ? ["baseline", "checks", "ci", "review"]
        : [];
  return identity({
    inputDigest: s.inputDigest,
    dependencies: dependencies.map((k) => ({
      kind: k,
      observation: s.observations[k] ?? null,
      reference: s.receipts[k]?.reference ?? null,
    })),
  });
}

export function validateUsage(value: unknown): asserts value is ActionUsage {
  const u = object(value);
  if (u.schema === 2) return validateHarnessUsage(u);
  if (u.schema !== 1) throw new Error("incompatible-usage-schema");
  if (u.status === "unknown") {
    keys(u, ["schema", "status", "reason"]);
    text(u.reason);
  } else if (u.status === "known") {
    keys(u, ["schema", "status", "tokens", "source"]);
    integer(u.tokens);
    const source = object(u.source);
    keys(source, ["kind", "reference"]);
    if (
      !["provider-receipt", "local-no-model"].includes(enumString(source.kind))
    )
      throw new Error("invalid-usage-source");
    text(source.reference);
    if (source.kind === "local-no-model" && u.tokens !== 0)
      throw new Error("invalid-local-usage");
  } else throw new Error("invalid-usage-status");
}
function validateHarnessUsage(u: Record<string, unknown>) {
  const base = ["schema", "status", "source", "harness"];
  if (u.status === "unknown") keys(u, [...base, "reason"]);
  else if (u.status === "ambiguous-zero") keys(u, [...base, "receipt"]);
  else if (u.status === "reported") keys(u, [...base, "receipt", "components"]);
  else throw new Error("invalid-usage-status");
  if (u.source !== "native-harness-telemetry")
    throw new Error("invalid-usage-source");
  text(u.harness);
  if (u.status === "unknown") return text(u.reason);
  if (typeof u.receipt !== "string" || !sha256.test(u.receipt))
    throw new Error("invalid-usage-receipt");
  if (u.status === "ambiguous-zero") return;
  const c = object(u.components);
  keys(c, [
    "input",
    "cachedInput",
    "cacheWriteInput",
    "output",
    "reasoningOutput",
  ]);
  integer(c.input);
  integer(c.output);
  for (const k of ["cachedInput", "cacheWriteInput", "reasoningOutput"])
    if (c[k] !== null) integer(c[k]);
  const n = c as HarnessComponents;
  if (
    (n.cachedInput ?? 0) + (n.cacheWriteInput ?? 0) > n.input ||
    (n.reasoningOutput ?? 0) > n.output
  )
    throw new Error("inconsistent-usage-components");
  // All-zero terminal telemetry is the source default for absent usage, never a known zero.
  if (n.input + n.output === 0) throw new Error("zero-usage-must-be-ambiguous");
  integer(n.input + n.output);
}
type HarnessComponents = Extract<
  HarnessUsage,
  { status: "reported" }
>["components"];
/** Comparison total from the frozen contract: subsets are never added twice. */
export function reportedTotal(
  u: Extract<HarnessUsage, { status: "reported" }>,
) {
  return u.components.input + u.components.output;
}
