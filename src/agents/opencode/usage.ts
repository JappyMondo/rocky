import type { HarnessUsage } from "../../coordinator/contracts.js";
import {
  ambiguousZeroHarnessUsage,
  reportedHarnessUsage,
  unknownHarnessUsage,
} from "../seam.js";
import { OPENCODE_HARNESS } from "./config.js";
import type { OpencodeExportAudit } from "./export.js";

/**
 * Usage mapping onto subscription-observed-v1 schema 2 (#90 budget section; #104 research F25,
 * PART 4 §5). The live stream has NO aggregate usage frame, so reported totals come ONLY from the
 * post-run export audit aggregate (sum of assistant-message tokens over the root session):
 *   - interrupted / unresolved lifecycle / export unavailable        → unknown
 *   - export-vs-step_finish (or SessionInfo.tokens) divergence       → unknown
 *   - no step_finish telemetry in the stream                         → unknown (§5)
 *   - aggregate present but all-zero (or absent assistant totals)    → ambiguous-zero, never a
 *     known zero (the token-plan catalog is zero-priced; a real zero is indistinguishable)
 *   - otherwise reported with subset semantics: cachedInput/cacheWriteInput are subsets of
 *     input, reasoningOutput a subset of output — NEVER added twice (G-USAGE-COMPONENTS: whether
 *     output already includes reasoning/cache components is unproven; subsets are passed through
 *     as observed and never summed into the total).
 * The step_finish `cost` field is a client-side catalog estimate that reads 0 on this plan (F25):
 * it is NEVER consumed here and never a receipt. `receipt` is the sha256 of the retained raw
 * export bytes the aggregate was derived from.
 */
export interface OpencodeUsageInput {
  /** True only when the stream lifecycle fully resolved (clean EOFs, exit 0, quiescence). */
  lifecycleResolved: boolean;
  /** The classified post-run export audit, or null when it was never run (interrupted etc.). */
  audit: OpencodeExportAudit | null;
  /** SUM of step_finish tokens from the stream; null when no well-formed step_finish arrived. */
  summedTokens: { input: number; output: number } | null;
  unresolvedReason?: string | undefined;
}
export function mapOpencodeUsage(input: OpencodeUsageInput): HarnessUsage {
  const unknown = (reason: string) =>
    unknownHarnessUsage(OPENCODE_HARNESS, reason);
  if (!input.lifecycleResolved)
    return unknown(input.unresolvedReason ?? "opencode-lifecycle-unresolved");
  if (!input.audit) return unknown("opencode-export-not-run");
  if (!input.audit.ok)
    return unknown(
      input.audit.fatal
        ? `opencode-export-fatal:${input.audit.reason}`
        : `opencode-export-unavailable:${input.audit.reason}`,
    );
  if (input.audit.divergence)
    return unknown(`opencode-usage-divergent:${input.audit.divergence}`);
  // §5: no step_finish telemetry in the stream ⇒ unknown, even with an export aggregate.
  if (!input.summedTokens) return unknown("opencode-no-step-finish");
  const { input: inTokens, output: outTokens } = input.audit.aggregate;
  const cachedInput = input.audit.aggregate.cacheRead;
  const cacheWriteInput = input.audit.aggregate.cacheWrite;
  const reasoningOutput = input.audit.aggregate.reasoning;
  if (
    (cachedInput ?? 0) + (cacheWriteInput ?? 0) > inTokens ||
    (reasoningOutput ?? 0) > outTokens
  )
    // Inconsistent subsets are invalid telemetry, never reported.
    return unknown("opencode-usage-inconsistent-subsets");
  if (inTokens + outTokens === 0)
    // All-zero aggregate on a complete, audited stream: ambiguous-zero, never a known zero.
    return ambiguousZeroHarnessUsage(OPENCODE_HARNESS, input.audit.rawSha256);
  return reportedHarnessUsage(OPENCODE_HARNESS, input.audit.rawSha256, {
    input: inTokens,
    cachedInput,
    cacheWriteInput,
    output: outTokens,
    reasoningOutput,
  });
}
