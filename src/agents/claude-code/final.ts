import { object } from "../../coordinator/contracts.js";
import type { Json } from "../../store/json.js";
import type { ClaudeRole } from "./argv.js";

/**
 * Host re-validation of result.structured_output against the full protected final schema
 * (acceptance/subscription/final.schema.json, reused by reference; sha256 954dd71e…6792) plus the
 * action/input/role binding (CC07). The --json-schema flag is a request, never evidence: success
 * without structured_output is failure and a schema-valid but mis-bound final rejects.
 */
export const CLAUDE_FINAL_SCHEMA_ID = "urn:rocky:subscription:final:1";
const OUTCOMES = ["changed", "no_code", "complete", "failed"] as const;
export function validateClaudeStructuredFinal(
  value: unknown,
  binding: { actionKey: string; inputDigest: string; role: ClaudeRole },
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
