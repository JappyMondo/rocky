import { object } from "../../coordinator/contracts.js";
import type { Json } from "../../store/json.js";
import type { CodexRole } from "./argv.js";

/**
 * Host re-validation of the last completed agent_message against the full protected final schema
 * (acceptance/subscription/final.schema.json, reused by reference) plus the action/input/role
 * binding (S04/S10; acceptance/subscription README "Reading exec output", source #92/858 §F).
 * `--output-schema` is a REQUEST, never evidence: the host always re-validates, a final without a
 * schema-valid agent_message is failure, and a schema-valid but mis-bound final rejects. The final
 * is a proposal only; it never establishes checks, CI, review or head authority.
 */
export const CODEX_FINAL_SCHEMA_ID = "urn:rocky:subscription:final:1";
const OUTCOMES = ["changed", "no_code", "complete", "failed"] as const;
export function validateCodexStructuredFinal(
  value: unknown,
  binding: { actionKey: string; inputDigest: string; role: CodexRole },
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
