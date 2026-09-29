import type { Json } from "../../store/json.js";
import { object } from "../../coordinator/contracts.js";
import { parseStrictJson, type SettlementClass } from "../seam.js";
import type { OpencodeRole } from "./config.js";

/**
 * Strict `opencode run --format=json` NDJSON interpretation and outcome classification (#104
 * research F19–F23, PART 4 §2/§3). Frame envelope (pinned source cli/cmd/run.ts emit()):
 * {type, timestamp, sessionID, ...data} with data = {part} for tool_use/step_start/step_finish/
 * text/reasoning and {error} for error. The event type set is CLOSED (every emit() call site);
 * an unknown type is a version-drift tripwire and rejects. THERE IS NO RESULT/DONE EVENT (F21):
 * completion = clean stream EOF + exit code + the post-run export audit conjunct (adapter-level);
 * the exit code alone is never success evidence.
 *
 * Part payload field consumption follows the pinned schema (packages/schema/src/v1/session.ts);
 * fields this classifier does not consume are not re-validated, and unknown TOP-LEVEL frame keys
 * reject. The proposal carrier is the LAST text part of the root session (F27 route (a)): it must
 * parse strictly and re-validate against the protected final schema with the action/input/role
 * binding — success without a parseable final is failure, and the final is a proposal only.
 */
export interface OpencodeExpectations {
  role: OpencodeRole;
  maxParts: number;
  maxFinalBytes: number;
}
export interface OpencodeLifecycleFacts {
  exitCode: number | null;
  signal: string | null;
  stdoutEof: boolean;
  stderrEof: boolean;
  childStdoutEof: boolean;
  childStderrEof: boolean;
  decoderComplete: boolean;
  transportFailure: string | null;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  stderrBytes: number;
  quiescent: boolean;
}
export interface OpencodeStreamVerdict {
  /** `interrupted` is decided by the adapter from cancellation/deadline/recovery facts. */
  settlement: Exclude<SettlementClass, "interrupted">;
  reasons: string[];
  /** True only when the lifecycle is fully resolved (clean decode, all EOFs, quiescence, exit 0,
   * at least one frame), so the export audit and usage mapping can be trusted. */
  resolvedLifecycle: boolean;
  sessionId: string | null;
  final: Json | null;
  finalRawText: string | null;
  errorEvents: Json[];
  toolUseCount: number;
  policyDenials: { tool: string; text: string }[];
  offRosterTools: string[];
  ordinaryFailures: { tool: string }[];
  stepFinishCount: number;
  /** SUM of step_finish tokens.input/output over the root session (PART 4 §5), or null when no
   * well-formed step_finish arrived. Cross-checked against the export audit aggregate. */
  summedTokens: { input: number; output: number } | null;
  textPartCount: number;
  framesObserved: number;
}
/** Native tool IDs (pinned registry): the sealed roster per role. The reviewer's read-only
 * guarantee is enforced BY TOOL ABSENCE ('*':deny removes bash/edit/write/apply_patch/task/
 * webfetch from the roster entirely, F17/F18), so ANY off-roster tool_use is a contract
 * violation (POLICY), never an ordinary failure. */
export const OPENCODE_TOOL_ROSTER: Record<OpencodeRole, ReadonlySet<string>> = {
  implementer: new Set([
    "bash",
    "read",
    "glob",
    "grep",
    "edit",
    "write",
    "todowrite",
    "apply_patch",
  ]),
  reviewer: new Set(["read", "glob", "grep"]),
};
/** Permission-refusal error-text shapes (PART 4 §3 POLICY class; pinned tagged error
 * PermissionRejectedError plus the documented refusal wording). The exact native surface string
 * is a native-probe item (NP2); unmatched tool errors stay settled-ordinary. */
const PERMISSION_REFUSAL =
  /PermissionRejectedError|QuestionRejectedError|rejected permission|permission[^.\n]{0,60}(denied|rejected)|(denied|rejected)[^.\n]{0,60}permission/i;
const EVENT_TYPES = new Set([
  "tool_use",
  "step_start",
  "step_finish",
  "text",
  "reasoning",
  "error",
]);
const FRAME_KEYS: Record<string, string[]> = {
  tool_use: ["type", "timestamp", "sessionID", "part"],
  step_start: ["type", "timestamp", "sessionID", "part"],
  step_finish: ["type", "timestamp", "sessionID", "part"],
  text: ["type", "timestamp", "sessionID", "part"],
  reasoning: ["type", "timestamp", "sessionID", "part"],
  error: ["type", "timestamp", "sessionID", "error"],
};
const PART_TYPE: Record<string, string> = {
  tool_use: "tool",
  step_start: "step-start",
  step_finish: "step-finish",
  text: "text",
  reasoning: "reasoning",
};
function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
function stringField(v: Record<string, unknown>, key: string): string | null {
  const value = v[key];
  return typeof value === "string" ? value : null;
}
function subsetKeys(v: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(v).every((k) => allowed.includes(k));
}
function tokenCount(value: unknown): number | null {
  if (value === undefined) return null;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    Number(value) < 0
  )
    return null;
  return Number(value);
}
export function classifyOpencodeStream(input: {
  frames: readonly Json[];
  decodeError: string | null;
  lifecycle: OpencodeLifecycleFacts;
  expectations: OpencodeExpectations;
  binding: { actionKey: string; inputDigest: string };
}): OpencodeStreamVerdict {
  const fatal: string[] = [];
  const policy: string[] = [];
  const unresolved: string[] = [];
  const { expectations, lifecycle } = input;
  const roster = OPENCODE_TOOL_ROSTER[expectations.role];
  let sessionId: string | null = null;
  const errorEvents: Json[] = [];
  const policyDenials: { tool: string; text: string }[] = [];
  const offRosterTools: string[] = [];
  const ordinaryFailures: { tool: string }[] = [];
  const completedTexts: { index: number; text: string }[] = [];
  let toolUseCount = 0;
  let partCount = 0;
  let stepFinishCount = 0;
  let summedInput = 0;
  let summedOutput = 0;
  let lastToolIndex = -1;

  input.frames.forEach((frameValue, index) => {
    const frame = record(frameValue);
    if (!frame) {
      unresolved.push(`frame-not-object:${index}`);
      return;
    }
    const type = stringField(frame, "type");
    if (type === null || !EVENT_TYPES.has(type)) {
      // Closed-set tripwire (F22): the pinned binary cannot emit unknown types; drift rejects.
      unresolved.push(`unknown-frame-type:${type ?? "absent"}`);
      return;
    }
    if (!subsetKeys(frame, FRAME_KEYS[type]!)) {
      unresolved.push(`frame-keys:${type}`);
      return;
    }
    if (
      typeof frame.timestamp !== "number" ||
      !Number.isFinite(frame.timestamp)
    )
      unresolved.push(`frame-timestamp:${type}`);
    const sid = stringField(frame, "sessionID");
    if (sid === null || !sid.trim()) {
      unresolved.push(`frame-session-id:${type}`);
      return;
    }
    if (sessionId === null) sessionId = sid;
    else if (sessionId !== sid) {
      // Subagent parts are skipped by the producer (F19); a second session ID is an anomaly.
      unresolved.push("session-id-mismatch");
      return;
    }
    if (type === "error") {
      // Every session error fails closed (F21: any accumulated session.error forces exit 1).
      errorEvents.push(frameValue);
      const err = record(frame.error);
      const name = err ? (stringField(err, "name") ?? "error") : "error";
      fatal.push(`error-event:${name.slice(0, 80)}`);
      return;
    }
    const part = record(frame.part);
    if (!part) {
      unresolved.push(`part-payload-shape:${type}`);
      return;
    }
    if (part.type !== PART_TYPE[type]) {
      unresolved.push(`part-type-mismatch:${type}`);
      return;
    }
    if (stringField(part, "sessionID") !== sid) {
      unresolved.push(`part-session-mismatch:${type}`);
      return;
    }
    if (++partCount > expectations.maxParts) {
      unresolved.push("part-limit");
      return;
    }
    switch (type) {
      case "tool_use": {
        toolUseCount++;
        lastToolIndex = index;
        const tool = stringField(part, "tool");
        const state = record(part.state);
        const status = state ? stringField(state, "status") : null;
        if (tool === null || !tool) {
          unresolved.push("tool-name-shape");
          return;
        }
        if (status !== "completed" && status !== "error") {
          // The emit site only fires on completed/error (F20); anything else is drift.
          unresolved.push(`tool-state-unexpected:${status ?? "absent"}`);
          return;
        }
        if (!roster.has(tool)) {
          // Tool absence makes off-roster use a contract violation (PART 4 §3), never ordinary.
          offRosterTools.push(tool);
          policy.push(`off-roster-tool:${tool}`);
          return;
        }
        if (status === "error") {
          const text = (state ? stringField(state, "error") : null) ?? "";
          if (PERMISSION_REFUSAL.test(text)) {
            policyDenials.push({ tool, text: text.slice(0, 160) });
            policy.push(`permission-denied:${tool}`);
          } else ordinaryFailures.push({ tool });
        }
        return;
      }
      case "step_finish": {
        stepFinishCount++;
        const tokens = record(part.tokens);
        if (!tokens) {
          unresolved.push("step-finish-tokens-shape");
          return;
        }
        const tIn = tokenCount(tokens.input);
        const tOut = tokenCount(tokens.output);
        if (tIn === null || tOut === null) {
          unresolved.push("step-finish-tokens-invalid");
          return;
        }
        summedInput += tIn;
        summedOutput += tOut;
        return;
      }
      case "text": {
        const text = stringField(part, "text");
        if (text === null) {
          unresolved.push("text-part-shape");
          return;
        }
        completedTexts.push({ index, text });
        return;
      }
      case "reasoning": {
        // --thinking is never passed (pinned argv); a reasoning event means the observed binary
        // does not match the audited bundle.
        unresolved.push("unexpected-reasoning-event");
        return;
      }
      case "step_start":
        return;
    }
  });

  // Final detection: the LAST text part of the root session is the proposal carrier (F27a).
  let final: Json | null = null;
  let finalRawText: string | null = null;
  let finalIndex = -1;
  let schemaShapedCount = 0;
  for (const message of completedTexts)
    if (isSchemaShaped(message.text)) schemaShapedCount++;
  if (schemaShapedCount > 1) unresolved.push("multiple-schema-shaped-finals");
  const last = completedTexts[completedTexts.length - 1];
  if (!last) unresolved.push("no-text-part");
  else {
    finalIndex = last.index;
    finalRawText = last.text;
    if (Buffer.byteLength(last.text) > expectations.maxFinalBytes)
      unresolved.push("final-bytes-limit");
    else {
      try {
        final = validateOpencodeStructuredFinal(parseStrictJson(last.text), {
          actionKey: input.binding.actionKey,
          inputDigest: input.binding.inputDigest,
          role: expectations.role,
        });
      } catch (error) {
        unresolved.push(
          (error as Error).message === "structured-final-binding"
            ? "final-binding"
            : "final-invalid",
        );
        final = null;
      }
    }
  }
  // Tool activity after the proposal carrier means the run kept acting after the "final".
  if (finalIndex >= 0 && lastToolIndex > finalIndex)
    unresolved.push("tool-after-final");

  // Separated lifecycle facts: decode, EOFs, exit-code matrix, truncation and quiescence.
  if (input.decodeError) {
    if (input.decodeError === "strict-partial-line")
      unresolved.push("stream-truncated:strict-partial-line");
    else fatal.push(`malformed-ndjson:${input.decodeError}`);
  }
  if (lifecycle.signal !== null) unresolved.push("signal-observed");
  if (lifecycle.stdoutTruncated || lifecycle.stderrTruncated)
    unresolved.push("raw-capture-truncated");
  if (
    lifecycle.transportFailure &&
    lifecycle.transportFailure !== "binary-identity-drift" &&
    lifecycle.transportFailure !== "binary-identity-missing"
  )
    unresolved.push(`transport-failure:${lifecycle.transportFailure}`);
  if (!lifecycle.stdoutEof || !lifecycle.stderrEof)
    unresolved.push("carrier-eof-missing");
  if (
    !lifecycle.decoderComplete ||
    !lifecycle.childStdoutEof ||
    !lifecycle.childStderrEof
  )
    unresolved.push("stream-incomplete");
  if (!lifecycle.quiescent) unresolved.push("not-quiescent");
  if (
    lifecycle.exitCode !== null &&
    lifecycle.signal === null &&
    !lifecycle.transportFailure
  ) {
    const cleanTerminal =
      final !== null &&
      fatal.length === 0 &&
      policy.length === 0 &&
      unresolved.length === 0;
    if (cleanTerminal) {
      if (lifecycle.exitCode !== 0) unresolved.push("exit-matrix-violation");
    } else if (
      lifecycle.exitCode !== 0 &&
      input.frames.length === 0 &&
      lifecycle.stderrBytes > 0
    )
      // Startup/arg failure via die()/UI.error+exit 1 with zero stdout (F21/F23).
      fatal.push("startup-refusal");
    else if (lifecycle.exitCode !== 0 && fatal.length === 0)
      // Nonzero exit without an error event is anomalous (F21 maps every error path to an
      // emitted 'error' event first); never success, conservatively unresolved.
      unresolved.push(`nonzero-exit:${lifecycle.exitCode}`);
  }

  const settlement: OpencodeStreamVerdict["settlement"] = fatal.length
    ? "fatal"
    : policy.length
      ? "policy-denied"
      : unresolved.length
        ? "unresolved"
        : "complete";
  const resolvedLifecycle =
    !input.decodeError &&
    lifecycle.signal === null &&
    !lifecycle.stdoutTruncated &&
    !lifecycle.stderrTruncated &&
    !lifecycle.transportFailure &&
    lifecycle.stdoutEof &&
    lifecycle.stderrEof &&
    lifecycle.decoderComplete &&
    lifecycle.childStdoutEof &&
    lifecycle.childStderrEof &&
    lifecycle.quiescent &&
    lifecycle.exitCode === 0 &&
    input.frames.length > 0 &&
    sessionId !== null;
  return {
    settlement,
    reasons: [...fatal, ...policy, ...unresolved],
    resolvedLifecycle,
    sessionId,
    final,
    finalRawText,
    errorEvents,
    toolUseCount,
    policyDenials,
    offRosterTools,
    ordinaryFailures,
    stepFinishCount,
    summedTokens:
      stepFinishCount > 0 ? { input: summedInput, output: summedOutput } : null,
    textPartCount: completedTexts.length,
    framesObserved: input.frames.length,
  };
}
/** A completed text part is "schema-shaped" when it parses as a JSON object carrying the final
 * schema's discriminator fields; used only to detect multiple competing finals. */
function isSchemaShaped(text: string): boolean {
  try {
    const v = record(parseStrictJson(text));
    if (!v) return false;
    return (
      v.schema === 1 &&
      typeof v.actionKey === "string" &&
      typeof v.inputDigest === "string" &&
      typeof v.outcome === "string" &&
      typeof v.role === "string" &&
      typeof v.summary === "string"
    );
  } catch {
    return false;
  }
}
/**
 * Host re-validation of the final text against the full protected final schema
 * (acceptance/subscription/final.schema.json, reused by reference) plus the action/input/role
 * binding. opencode has NO structured-output flag (F9/F27): the final-text protocol with this
 * host re-validation is the whole guarantee, a final without a schema-valid text part is failure,
 * and a schema-valid but mis-bound final rejects. The final is a proposal only; it never
 * establishes checks, CI, review or head authority (host deriveTreeHead only).
 */
const OUTCOMES = ["changed", "no_code", "complete", "failed"] as const;
export function validateOpencodeStructuredFinal(
  value: unknown,
  binding: { actionKey: string; inputDigest: string; role: OpencodeRole },
): Json {
  const v = object(value);
  const keys = Object.keys(v).sort();
  const expected = [
    "actionKey",
    "inputDigest",
    "outcome",
    "role",
    "schema",
    "summary",
  ];
  if (keys.join() !== expected.join())
    throw new Error("structured-final-shape");
  if (v.schema !== 1) throw new Error("structured-final-schema");
  if (
    typeof v.actionKey !== "string" ||
    !v.actionKey ||
    v.actionKey.length > 256
  )
    throw new Error("structured-final-action-key");
  if (
    typeof v.inputDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(v.inputDigest)
  )
    throw new Error("structured-final-input-digest");
  if (
    typeof v.role !== "string" ||
    !["implementer", "reviewer"].includes(v.role)
  )
    throw new Error("structured-final-role");
  if (
    typeof v.outcome !== "string" ||
    !(OUTCOMES as readonly string[]).includes(v.outcome)
  )
    throw new Error("structured-final-outcome");
  if (typeof v.summary !== "string" || !v.summary || v.summary.length > 8192)
    throw new Error("structured-final-summary");
  if (
    v.actionKey !== binding.actionKey ||
    v.inputDigest !== binding.inputDigest ||
    v.role !== binding.role
  )
    throw new Error("structured-final-binding");
  return v as Json;
}
