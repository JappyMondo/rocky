import type { Json } from "../../store/json.js";
import { parseStrictJson, type SettlementClass } from "../seam.js";
import type { CodexRole } from "./argv.js";
import { validateCodexStructuredFinal } from "./final.js";

/**
 * Strict `codex exec --json` JSONL interpretation and outcome classification (S04/S07/S09;
 * acceptance/subscription manifest protocol block + README "Reading exec output", source #92/857
 * F9/F10 and #92/859 §6). This is a FRESH exec JSONL stream, NOT external JSON-RPC: there is no
 * turn id, no turn.error:null, no JSON-RPC request id and no pending-server-request map, and the
 * adapter never fabricates them. The documented event union is the reviewed allowlist below; any
 * unknown event/item type rejects. Frames arrive from the bounded strict decoder; classification is
 * a pure function of the observed frames plus separated lifecycle facts. Exit code alone is never
 * success evidence.
 *
 * The exact native serde field names below are the owned source-consistent interpretation of the
 * pinned taxonomy; the frozen contract pins the event/item names and rules, and the precise native
 * frame shape is a synthetic-native gate (N06), never assumed proven here. Success-path envelopes
 * and known item payloads carry EXACT key sets, so an extra unknown field rejects (F03); the
 * already-rejecting turn.failed/error frames are classified fatal regardless of extra fields.
 */
export interface CodexExpectations {
  model: string;
  role: CodexRole;
  maxItems: number;
  maxFinalBytes: number;
  maxAggregatedOutputBytes: number;
}
export interface CodexLifecycleFacts {
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
export interface CodexStreamVerdict {
  /** `interrupted` is decided by the adapter from cancellation/deadline/recovery facts. */
  settlement: Exclude<SettlementClass, "interrupted">;
  reasons: string[];
  /** True only when exactly one well-formed turn.completed arrived over a clean, complete lifecycle
   * with exit 0, so its telemetry can be trusted for usage mapping. */
  resolvedLifecycle: boolean;
  threadStartedObserved: boolean;
  threadId: string | null;
  turnCompletedObserved: boolean;
  turnCompletedFrame: Record<string, unknown> | null;
  turnCompletedRawLine: string | null;
  final: Json | null;
  finalRawText: string | null;
  errorItems: Json[];
  errorEvents: Json[];
  ordinaryFailures: { id: string; itemType: string; exitCode: number | null }[];
  itemCount: number;
  framesObserved: number;
}
/** Allowed item types (manifest protocol.allowedItems). */
const ALLOWED_ITEM_TYPES = new Set([
  "agent_message",
  "reasoning",
  "command_execution",
  "file_change",
  "todo_list",
]);
/** Forbidden item types (manifest protocol.forbiddenItems). */
const FORBIDDEN_ITEM_TYPES = new Set([
  "mcp_tool_call",
  "collab_tool_call",
  "web_search",
  "error",
]);
const TOOL_ITEM_TYPES = new Set([
  "command_execution",
  "file_change",
  "todo_list",
]);
const ENVELOPE_KEYS: Record<string, string[]> = {
  "thread.started": ["type", "thread_id"],
  "turn.started": ["type"],
  "item.started": ["type", "id", "item"],
  "item.updated": ["type", "id", "item"],
  "item.completed": ["type", "id", "item"],
  "turn.completed": ["type", "usage"],
};
const ITEM_KEYS: Record<string, string[]> = {
  agent_message: ["type", "text"],
  reasoning: ["type", "text"],
  command_execution: [
    "type",
    "command",
    "status",
    "exit_code",
    "aggregated_output",
  ],
  file_change: ["type", "changes", "status"],
  todo_list: ["type", "items", "status"],
  error: ["type", "text"],
};
function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
function stringField(v: Record<string, unknown>, key: string): string | null {
  const value = v[key];
  return typeof value === "string" ? value : null;
}
/** Reject EXTRA unknown fields (F03) without requiring every optional field to be present. The
 * native correspondence of the allowed field names is gated N06; unknown fields fail closed. */
function subsetKeys(v: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(v).every((k) => allowed.includes(k));
}
interface ItemState {
  type: string;
  started: boolean;
  completed: boolean;
}
export function classifyCodexStream(input: {
  frames: readonly Json[];
  lines: readonly string[];
  decodeError: string | null;
  lifecycle: CodexLifecycleFacts;
  expectations: CodexExpectations;
  binding: { actionKey: string; inputDigest: string };
}): CodexStreamVerdict {
  const fatal: string[] = [];
  const policy: string[] = [];
  const unresolved: string[] = [];
  const { expectations, lifecycle, binding } = input;
  let threadStartedCount = 0;
  let threadId: string | null = null;
  let turnStartedCount = 0;
  const items = new Map<string, ItemState>();
  const completedAgentMessages: { index: number; text: string }[] = [];
  let lastToolCompletionIndex = -1;
  let turnCompletedFrame: Record<string, unknown> | null = null;
  let turnCompletedRawLine: string | null = null;
  let turnCompletedIndex = -1;
  let turnFailedObserved = false;
  let terminalIndex = -1;
  let framesAfterTerminal = 0;
  const errorItems: Json[] = [];
  const errorEvents: Json[] = [];
  const ordinaryFailures: {
    id: string;
    itemType: string;
    exitCode: number | null;
  }[] = [];
  let itemCount = 0;
  let unknownFrame = false;

  input.frames.forEach((frameValue, index) => {
    const frame = record(frameValue);
    if (!frame) {
      unresolved.push(`frame-not-object:${index}`);
      unknownFrame = true;
      return;
    }
    if (terminalIndex >= 0) framesAfterTerminal++;
    const type = stringField(frame, "type");
    switch (type) {
      case "thread.started": {
        if (!subsetKeys(frame, ENVELOPE_KEYS["thread.started"]!)) {
          unresolved.push("thread-started-shape");
          return;
        }
        threadStartedCount++;
        const id = stringField(frame, "thread_id");
        if (id === null || !id.trim()) unresolved.push("thread-id-blank");
        else if (threadId !== null) unresolved.push("multiple-thread-started");
        else threadId = id;
        return;
      }
      case "turn.started": {
        if (!subsetKeys(frame, ENVELOPE_KEYS["turn.started"]!)) {
          unresolved.push("turn-started-shape");
          return;
        }
        turnStartedCount++;
        if (turnStartedCount > 1) unresolved.push("multiple-turn-started");
        return;
      }
      case "item.started":
      case "item.updated":
      case "item.completed": {
        if (!subsetKeys(frame, ENVELOPE_KEYS[type]!)) {
          unresolved.push(`${type}-shape`);
          return;
        }
        const id = stringField(frame, "id");
        const item = record(frame.item);
        if (id === null || !id) {
          unresolved.push("item-id-shape");
          return;
        }
        if (!item) {
          unresolved.push("item-payload-shape");
          return;
        }
        const itemType = stringField(item, "type");
        if (itemType === null) {
          unresolved.push("item-type-missing");
          return;
        }
        if (type === "item.started") {
          if (!items.has(id)) {
            itemCount++;
            if (itemCount > expectations.maxItems) {
              unresolved.push("item-limit");
              return;
            }
          }
          const existing = items.get(id);
          if (existing?.started) {
            unresolved.push(`item-duplicate-start:${id}`);
            return;
          }
          if (
            !ALLOWED_ITEM_TYPES.has(itemType) &&
            !FORBIDDEN_ITEM_TYPES.has(itemType)
          ) {
            unresolved.push(`unknown-item-type:${itemType}`);
            unknownFrame = true;
          }
          if (FORBIDDEN_ITEM_TYPES.has(itemType) && itemType !== "error")
            policy.push(`forbidden-item:${itemType}`);
          items.set(id, {
            type: itemType,
            started: true,
            completed: existing?.completed ?? false,
          });
          return;
        }
        if (type === "item.updated") {
          const existing = items.get(id);
          if (!existing?.started) {
            unresolved.push(`item-update-before-start:${id}`);
            return;
          }
          if (existing.type !== itemType)
            unresolved.push(`item-type-change:${id}`);
          return;
        }
        // item.completed
        handleItemCompleted(id, itemType, item, index);
        return;
      }
      case "turn.completed": {
        if (!subsetKeys(frame, ENVELOPE_KEYS["turn.completed"]!)) {
          unresolved.push("turn-completed-shape");
          return;
        }
        if (terminalIndex >= 0) {
          unresolved.push("duplicate-terminal");
          return;
        }
        terminalIndex = index;
        turnCompletedIndex = index;
        turnCompletedFrame = frame;
        turnCompletedRawLine = input.lines[index] ?? null;
        // usage is optional at the envelope level: absent telemetry maps to ambiguous-zero (the
        // source zero-default), never a known zero; a present-but-malformed usage rejects.
        if (frame.usage !== undefined && !record(frame.usage))
          unresolved.push("turn-completed-usage-shape");
        return;
      }
      case "turn.failed": {
        if (terminalIndex >= 0) {
          unresolved.push("duplicate-terminal");
          return;
        }
        terminalIndex = index;
        turnFailedObserved = true;
        fatal.push("turn-failed");
        return;
      }
      case "error": {
        // Every top-level error event (including will_retry reconnects) fails closed (F10).
        errorEvents.push(frameValue);
        fatal.push("error-event");
        return;
      }
      default: {
        unresolved.push(`unknown-frame-type:${type ?? "absent"}`);
        unknownFrame = true;
        return;
      }
    }
  });

  function handleItemCompleted(
    id: string,
    itemType: string,
    item: Record<string, unknown>,
    index: number,
  ) {
    const existing = items.get(id);
    if (existing?.completed) {
      unresolved.push(`item-duplicate-completion:${id}`);
      return;
    }
    if (!existing) {
      itemCount++;
      if (itemCount > expectations.maxItems) {
        unresolved.push("item-limit");
        return;
      }
    }
    // Error items (config warning, deprecation, lag drop, reroute) fail closed (F10).
    if (itemType === "error") {
      errorItems.push(item as Json);
      const text = stringField(item, "text") ?? "error-item";
      fatal.push(`error-item:${text.slice(0, 80)}`);
      items.set(id, {
        type: itemType,
        started: existing?.started ?? false,
        completed: true,
      });
      return;
    }
    if (FORBIDDEN_ITEM_TYPES.has(itemType)) {
      policy.push(`forbidden-item:${itemType}`);
      return;
    }
    if (!ALLOWED_ITEM_TYPES.has(itemType)) {
      unresolved.push(`unknown-item-type:${itemType}`);
      unknownFrame = true;
      return;
    }
    const allowed = ITEM_KEYS[itemType];
    if (allowed && !subsetKeys(item, allowed)) {
      unresolved.push(`item-payload-keys:${itemType}`);
      return;
    }
    if (existing?.started && existing.type !== itemType) {
      unresolved.push(`item-type-change:${id}`);
      return;
    }
    // command_execution requires started → completed; a completed-only command is a contradiction
    // (F04). file_change/agent_message/reasoning/todo_list may be completed-only.
    if (itemType === "command_execution" && !existing?.started) {
      unresolved.push(`command-completed-only:${id}`);
      return;
    }
    const status = stringField(item, "status");
    if (status === "pending") {
      unresolved.push(`item-pending:${itemType}:${id}`);
      return;
    }
    if (status === "declined") {
      // A source-defined declined status is a policy/authority denial (README; the exact native
      // file_change denial form is gated N03 per #89/853 and is never invented here).
      policy.push(`item-declined:${itemType}:${id}`);
      return;
    }
    if (itemType === "command_execution") {
      const exitRaw = item.exit_code;
      let exitCode: number | null = null;
      if (exitRaw !== undefined && exitRaw !== null) {
        if (typeof exitRaw !== "number" || !Number.isSafeInteger(exitRaw)) {
          unresolved.push(`command-exit-code-shape:${id}`);
          return;
        }
        exitCode = exitRaw;
      }
      const aggregated = item.aggregated_output;
      if (
        typeof aggregated === "string" &&
        Buffer.byteLength(aggregated) > expectations.maxAggregatedOutputBytes
      ) {
        unresolved.push("aggregated-output-limit");
        return;
      }
      // A fully observed nonzero command is an ordinary settled failure: recorded, never alone a
      // protocol/action-failure verdict (settledOrdinaryFailure; F12).
      if (exitCode !== null && exitCode !== 0)
        ordinaryFailures.push({ id, itemType, exitCode });
    } else if (itemType === "file_change") {
      if (status !== null && status !== "completed" && status !== "success")
        ordinaryFailures.push({ id, itemType, exitCode: null });
    } else if (itemType === "agent_message") {
      const text = stringField(item, "text");
      if (text === null) {
        unresolved.push(`agent-message-text-shape:${id}`);
        return;
      }
      completedAgentMessages.push({ index, text });
    }
    if (TOOL_ITEM_TYPES.has(itemType)) lastToolCompletionIndex = index;
    items.set(id, {
      type: itemType,
      started: existing?.started ?? false,
      completed: true,
    });
  }

  // Lifecycle-level conjunctions.
  if (threadStartedCount === 0) unresolved.push("thread-started-missing");
  else if (threadStartedCount > 1) unresolved.push("multiple-thread-started");
  if (turnStartedCount === 0) unresolved.push("turn-started-missing");
  else if (turnStartedCount > 1) unresolved.push("multiple-turn-started");
  for (const [id, state] of items)
    if (state.started && !state.completed)
      unresolved.push(`item-unresolved:${state.type}:${id}`);
  if (framesAfterTerminal > 0) unresolved.push("frame-after-terminal");

  // Final detection: the LAST completed agent_message must parse as exactly final.schema.json and
  // match the binding; earlier progress messages cannot supply a final and multiple schema-shaped
  // finals fail (README; F05).
  let final: Json | null = null;
  let finalRawText: string | null = null;
  let finalIndex = -1;
  let schemaShapedCount = 0;
  for (const message of completedAgentMessages) {
    if (isSchemaShaped(message.text)) schemaShapedCount++;
  }
  if (schemaShapedCount > 1) unresolved.push("multiple-schema-shaped-finals");
  const last = completedAgentMessages[completedAgentMessages.length - 1];
  if (!last) unresolved.push("no-final");
  else {
    finalIndex = last.index;
    finalRawText = last.text;
    if (Buffer.byteLength(last.text) > expectations.maxFinalBytes)
      unresolved.push("final-bytes-limit");
    else {
      try {
        const parsed = parseStrictJson(last.text);
        final = validateCodexStructuredFinal(parsed, {
          actionKey: binding.actionKey,
          inputDigest: binding.inputDigest,
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
  // The final must follow every settled tool, and turn.completed must follow the final.
  if (finalIndex >= 0 && lastToolCompletionIndex > finalIndex)
    unresolved.push("final-before-tool");
  if (
    turnCompletedIndex >= 0 &&
    finalIndex >= 0 &&
    turnCompletedIndex < finalIndex
  )
    unresolved.push("terminal-before-final");
  if (!turnFailedObserved && turnCompletedIndex < 0)
    unresolved.push("no-terminal");

  // Separated lifecycle facts: EOFs, exit-code matrix, transport failure and quiescence.
  if (input.decodeError) unresolved.push(`stream-decode:${input.decodeError}`);
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
      turnCompletedIndex >= 0 &&
      fatal.length === 0 &&
      policy.length === 0 &&
      unresolved.length === 0 &&
      !unknownFrame;
    if (cleanTerminal) {
      if (lifecycle.exitCode !== 0) unresolved.push("exit-matrix-violation");
    } else if (turnFailedObserved) {
      // Failed ⇒ turn.failed + exit 1 (F10); already fatal, exit recorded in the receipt.
      void lifecycle.exitCode;
    } else if (lifecycle.exitCode === 0 && turnCompletedIndex < 0)
      unresolved.push("no-terminal-exit-zero");
    else if (
      lifecycle.exitCode !== 0 &&
      turnCompletedIndex < 0 &&
      input.frames.length === 0 &&
      lifecycle.stderrBytes > 0
    )
      fatal.push("startup-refusal");
    // No terminal + nonzero exit is the interrupted-turn shape (F10): it stays unresolved here and
    // the adapter maps it to an interrupted outcome with unknown usage.
  }

  const settlement: CodexStreamVerdict["settlement"] = fatal.length
    ? "fatal"
    : policy.length
      ? "policy-denied"
      : unresolved.length || unknownFrame
        ? "unresolved"
        : "complete";
  const reasons = [...fatal, ...policy, ...unresolved];
  const resolvedLifecycle =
    turnCompletedIndex >= 0 &&
    turnCompletedFrame !== null &&
    !turnFailedObserved &&
    framesAfterTerminal === 0 &&
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
    lifecycle.exitCode === 0;
  return {
    settlement,
    reasons,
    resolvedLifecycle,
    threadStartedObserved: threadStartedCount > 0,
    threadId,
    turnCompletedObserved: turnCompletedIndex >= 0,
    turnCompletedFrame,
    turnCompletedRawLine,
    final,
    finalRawText,
    errorItems,
    errorEvents,
    ordinaryFailures,
    itemCount,
    framesObserved: input.frames.length,
  };
}
/** A completed agent_message is "schema-shaped" when its text parses as a JSON object carrying the
 * final schema's discriminator fields; used only to detect multiple competing finals. */
function isSchemaShaped(text: string): boolean {
  try {
    const parsed = parseStrictJson(text);
    const v = record(parsed);
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
