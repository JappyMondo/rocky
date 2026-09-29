import { digest, type Json } from "../../store/json.js";
import type { HarnessUsage } from "../../coordinator/contracts.js";
import {
  ambiguousZeroHarnessUsage,
  reportedHarnessUsage,
  unknownHarnessUsage,
} from "../seam.js";
import { CLAUDE_CODE_HARNESS } from "./config.js";

/**
 * Usage mapping onto subscription-observed-v1 schema 2 (CC10; acceptance/claude-code manifest
 * budget.adapterMapping, source #94/879 usage note). Usage comes ONLY from result.modelUsage of
 * the single terminal result (it already includes subagents, compaction and internal calls);
 * per-message assistant usage and result.usage (main loop only) are never the action total.
 * total = inputTokens + outputTokens per model; cacheReadInputTokens/cacheCreationInputTokens map
 * to the cachedInput/cacheWriteInput subsets of input and thinkingTokens to the reasoningOutput
 * subset of output (outputTokens already includes thinking) — subsets are never added twice.
 * total_cost_usd and num_turns are informational and never receipts or budget inputs.
 */
export interface ClaudeUsageInput {
  /** The single well-formed terminal result frame, or null when absent/unresolved. */
  resultFrame: Json | null;
  /** The exact raw result line bytes for the retained-telemetry receipt, or null. */
  resultRawLine: string | null;
  requestedModel: string;
  /** True only when the lifecycle is resolved: exactly one well-formed result, complete strict
   * decode, both EOFs, exit-code matrix consistent and physical quiescence. */
  lifecycleResolved: boolean;
  unresolvedReason?: string | undefined;
}
export interface ClaudeUsageDecision {
  usage: HarnessUsage;
  /** Present when numeric telemetry was invalid; the run rejects regardless of other classes. */
  invalidTelemetry: string | null;
}
function count(value: unknown, name: string): number | null {
  if (value === undefined) return null;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    Number(value) < 0
  )
    throw new Error(`claude-usage-invalid-count:${name}`);
  return Number(value);
}
export function mapClaudeUsage(input: ClaudeUsageInput): ClaudeUsageDecision {
  const unknown = (reason: string): ClaudeUsageDecision => ({
    usage: unknownHarnessUsage(CLAUDE_CODE_HARNESS, reason),
    invalidTelemetry: null,
  });
  if (!input.lifecycleResolved || !input.resultFrame)
    return unknown(input.unresolvedReason ?? "claude-lifecycle-unresolved");
  const result = input.resultFrame as Record<string, unknown>;
  if (typeof result.startup_failure_reason === "string")
    return unknown("claude-startup-failure-zeroed-telemetry");
  const receiptSource = input.resultRawLine;
  if (receiptSource === null) return unknown("claude-raw-telemetry-missing");
  const receipt = digest(Buffer.from(receiptSource, "utf8"));
  const modelUsage = result.modelUsage;
  if (modelUsage === undefined || modelUsage === null) {
    // Absent telemetry on an otherwise complete run is ambiguous-zero, never a known zero;
    // on a non-success (crash-shaped) result the zeroed/absent telemetry is unknown.
    return result.subtype === "success"
      ? {
          usage: ambiguousZeroHarnessUsage(CLAUDE_CODE_HARNESS, receipt),
          invalidTelemetry: null,
        }
      : unknown("claude-telemetry-absent-non-success");
  }
  if (
    typeof modelUsage !== "object" ||
    Array.isArray(modelUsage) ||
    !modelUsage
  )
    return {
      usage: unknownHarnessUsage(CLAUDE_CODE_HARNESS, "claude-usage-malformed"),
      invalidTelemetry: "claude-usage-malformed",
    };
  const entries = Object.entries(modelUsage as Record<string, unknown>);
  if (entries.length === 0) {
    return result.subtype === "success"
      ? {
          usage: ambiguousZeroHarnessUsage(CLAUDE_CODE_HARNESS, receipt),
          invalidTelemetry: null,
        }
      : unknown("claude-telemetry-absent-non-success");
  }
  if (entries.length > 1)
    return {
      usage: unknownHarnessUsage(
        CLAUDE_CODE_HARNESS,
        "claude-usage-multi-model",
      ),
      invalidTelemetry: "claude-usage-multi-model",
    };
  const [model, raw] = entries[0]!;
  if (model !== input.requestedModel)
    // A modelUsage key different from the requested model is a silent fallback and is fatal;
    // the stream classifier rejects first, so usage stays unknown here.
    return {
      usage: unknownHarnessUsage(
        CLAUDE_CODE_HARNESS,
        "claude-usage-model-mismatch",
      ),
      invalidTelemetry: "claude-usage-model-mismatch",
    };
  if (typeof raw !== "object" || Array.isArray(raw) || !raw)
    return {
      usage: unknownHarnessUsage(CLAUDE_CODE_HARNESS, "claude-usage-malformed"),
      invalidTelemetry: "claude-usage-malformed",
    };
  const entry = raw as Record<string, unknown>;
  let inputTokens: number | null;
  let outputTokens: number | null;
  let cachedInput: number | null;
  let cacheWriteInput: number | null;
  let reasoningOutput: number | null;
  try {
    inputTokens = count(entry.inputTokens, "inputTokens");
    outputTokens = count(entry.outputTokens, "outputTokens");
    cachedInput = count(entry.cacheReadInputTokens, "cacheReadInputTokens");
    cacheWriteInput = count(
      entry.cacheCreationInputTokens,
      "cacheCreationInputTokens",
    );
    reasoningOutput = count(entry.thinkingTokens, "thinkingTokens");
  } catch (error) {
    const reason = (error as Error).message;
    return {
      usage: unknownHarnessUsage(CLAUDE_CODE_HARNESS, reason),
      invalidTelemetry: reason,
    };
  }
  if (inputTokens === null || outputTokens === null) {
    const reason = "claude-usage-missing-totals";
    return {
      usage: unknownHarnessUsage(CLAUDE_CODE_HARNESS, reason),
      invalidTelemetry: reason,
    };
  }
  if (
    (cachedInput ?? 0) + (cacheWriteInput ?? 0) > inputTokens ||
    (reasoningOutput ?? 0) > outputTokens
  ) {
    const reason = "claude-usage-inconsistent-subsets";
    return {
      usage: unknownHarnessUsage(CLAUDE_CODE_HARNESS, reason),
      invalidTelemetry: reason,
    };
  }
  if (inputTokens + outputTokens === 0) {
    // All-zero telemetry: ambiguous-zero on a complete success run, unknown on crash-shaped ones.
    return result.subtype === "success"
      ? {
          usage: ambiguousZeroHarnessUsage(CLAUDE_CODE_HARNESS, receipt),
          invalidTelemetry: null,
        }
      : unknown("claude-telemetry-zeroed-non-success");
  }
  try {
    return {
      usage: reportedHarnessUsage(CLAUDE_CODE_HARNESS, receipt, {
        input: inputTokens,
        cachedInput,
        cacheWriteInput,
        output: outputTokens,
        reasoningOutput,
      }),
      invalidTelemetry: null,
    };
  } catch {
    const reason = "claude-usage-component-overflow";
    return {
      usage: unknownHarnessUsage(CLAUDE_CODE_HARNESS, reason),
      invalidTelemetry: reason,
    };
  }
}
