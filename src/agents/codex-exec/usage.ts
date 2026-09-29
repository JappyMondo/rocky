import { digest, type Json } from "../../store/json.js";
import type { HarnessUsage } from "../../coordinator/contracts.js";
import {
  ambiguousZeroHarnessUsage,
  reportedHarnessUsage,
  unknownHarnessUsage,
} from "../seam.js";
import { CODEX_EXEC_HARNESS } from "./config.js";

/**
 * Usage mapping onto subscription-observed-v1 schema 2 (S08; acceptance/subscription manifest
 * budget block, source #92/857 F10 and #92/859 §5). Usage comes ONLY from the single terminal
 * `turn.completed` event's usage object; exec always emits it and defaults it to zeros when there is
 * no telemetry, so an all-zero total is ambiguous-zero, never a known zero, and absence cannot be
 * distinguished from zero at this interface. total = input_tokens + output_tokens; cached_input /
 * cache_write_input are subsets of input and reasoning_output a subset of output, never added twice.
 * A missing terminal (interrupted/truncated) or any unresolved lifecycle is unknown. The exact
 * subset/total interpretation itself requires version qualification (L02/N06), recorded as a gap.
 */
export interface CodexUsageInput {
  /** The single well-formed turn.completed frame, or null when absent/unresolved. */
  turnCompletedFrame: Json | null;
  /** The exact raw turn.completed line bytes for the retained-telemetry receipt, or null. */
  turnCompletedRawLine: string | null;
  /** True only when the lifecycle is resolved: exactly one well-formed turn.completed, complete
   * strict decode, both EOFs, exit 0 and physical quiescence. */
  lifecycleResolved: boolean;
  unresolvedReason?: string | undefined;
}
export interface CodexUsageDecision {
  usage: HarnessUsage;
  /** Present when numeric telemetry was invalid; the run rejects regardless of other classes. */
  invalidTelemetry: string | null;
}
const USAGE_KEYS = new Set([
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
]);
function count(value: unknown, name: string): number | null {
  if (value === undefined) return null;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    Number(value) < 0
  )
    throw new Error(`codex-usage-invalid-count:${name}`);
  return Number(value);
}
export function mapCodexUsage(input: CodexUsageInput): CodexUsageDecision {
  const unknown = (reason: string): CodexUsageDecision => ({
    usage: unknownHarnessUsage(CODEX_EXEC_HARNESS, reason),
    invalidTelemetry: null,
  });
  const invalid = (reason: string): CodexUsageDecision => ({
    usage: unknownHarnessUsage(CODEX_EXEC_HARNESS, reason),
    invalidTelemetry: reason,
  });
  // A fatal/unresolved observation rejects BEFORE usage mapping: its telemetry is never reported.
  if (!input.lifecycleResolved || !input.turnCompletedFrame)
    return unknown(input.unresolvedReason ?? "codex-lifecycle-unresolved");
  const frame = input.turnCompletedFrame as Record<string, unknown>;
  const receiptSource = input.turnCompletedRawLine;
  if (receiptSource === null) return unknown("codex-raw-telemetry-missing");
  const receipt = digest(Buffer.from(receiptSource, "utf8"));
  const usage = frame.usage;
  if (usage === undefined || usage === null)
    // Absent usage on an otherwise complete turn.completed is ambiguous-zero, never known zero.
    return {
      usage: ambiguousZeroHarnessUsage(CODEX_EXEC_HARNESS, receipt),
      invalidTelemetry: null,
    };
  if (typeof usage !== "object" || Array.isArray(usage))
    return invalid("codex-usage-malformed");
  const u = usage as Record<string, unknown>;
  for (const key of Object.keys(u))
    if (!USAGE_KEYS.has(key)) return invalid("codex-usage-unknown-field");
  let inputTokens: number;
  let outputTokens: number;
  let cachedInput: number | null;
  let cacheWriteInput: number | null;
  let reasoningOutput: number | null;
  try {
    // input/output default to the source zero when the field is absent; subsets stay null.
    inputTokens = count(u.input_tokens, "input_tokens") ?? 0;
    outputTokens = count(u.output_tokens, "output_tokens") ?? 0;
    cachedInput = count(u.cached_input_tokens, "cached_input_tokens");
    cacheWriteInput = count(
      u.cache_write_input_tokens,
      "cache_write_input_tokens",
    );
    reasoningOutput = count(
      u.reasoning_output_tokens,
      "reasoning_output_tokens",
    );
  } catch (error) {
    return invalid((error as Error).message);
  }
  if (
    (cachedInput ?? 0) + (cacheWriteInput ?? 0) > inputTokens ||
    (reasoningOutput ?? 0) > outputTokens
  )
    return invalid("codex-usage-inconsistent-subsets");
  if (inputTokens + outputTokens === 0)
    // All-zero telemetry (the source default for absent usage): ambiguous-zero, never known zero.
    return {
      usage: ambiguousZeroHarnessUsage(CODEX_EXEC_HARNESS, receipt),
      invalidTelemetry: null,
    };
  try {
    return {
      usage: reportedHarnessUsage(CODEX_EXEC_HARNESS, receipt, {
        input: inputTokens,
        cachedInput,
        cacheWriteInput,
        output: outputTokens,
        reasoningOutput,
      }),
      invalidTelemetry: null,
    };
  } catch {
    return invalid("codex-usage-component-overflow");
  }
}
