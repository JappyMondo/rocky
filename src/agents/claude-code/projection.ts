import { canonical, digest } from "../../store/json.js";
import { object } from "../../coordinator/contracts.js";
import { parseStrictJson } from "../seam.js";

/**
 * Wire projection of the frozen request schema for the pinned candidate (Taskbot #111,
 * acceptance/claude-code amendment; evidence: R1 #108 CC-P5 + zero-turn draft-isolation
 * diagnostic). Pinned claude 2.1.283's --json-schema validator does not carry the
 * draft-2020-12 meta-schema in its bundled registry, so the frozen contract schema
 * (acceptance/subscription/final.schema.json, "$schema":
 * "https://json-schema.org/draft/2020-12/schema") is rejected at startup ("no schema with
 * key or ref", exit 1, zero frames) while the SAME body with "$schema":
 * "http://json-schema.org/draft-07/schema#" is accepted. The projection is therefore the
 * canonical-minified frozen schema with ONLY the $schema value replaced by the explicit
 * draft-07 IRI (never omission); the frozen schema body uses no draft-2020-12-exclusive
 * vocabulary, so the two readings are semantically identical. Host-side final validation
 * authority remains the frozen 2020-12 schema, unchanged: the projection is a request-wire
 * detail, never evidence and never a second shipped schema file.
 */
export const CLAUDE_FROZEN_SCHEMA_DIALECT =
  "https://json-schema.org/draft/2020-12/schema";
export const CLAUDE_WIRE_SCHEMA_DIALECT =
  "http://json-schema.org/draft-07/schema#";

export interface ClaudeWireSchemaProjection {
  /** Canonical-minified projected bytes; the exact --json-schema value. */
  canonical: string;
  /** Projection hash: sha256 of the projected canonical bytes. */
  sha256: string;
  /** Canonical-minified frozen source bytes (validation authority, unchanged). */
  sourceCanonical: string;
  /** sha256 of the frozen source canonical bytes. */
  sourceSha256: string;
}

/**
 * Deterministic pure projection. Fail-closed on: malformed/duplicate-key source JSON, a
 * non-object source, a source "$schema" that is not EXACTLY the frozen draft-2020-12 IRI,
 * a non-deterministic derivation, or any projected body that does not round-trip back to
 * the source canonical bytes when the frozen dialect is restored.
 */
export function projectClaudeWireRequestSchema(
  sourceText: string,
): ClaudeWireSchemaProjection {
  const parsed = object(parseStrictJson(sourceText));
  if (parsed.$schema !== CLAUDE_FROZEN_SCHEMA_DIALECT)
    throw new Error("claude-request-schema-dialect");
  const sourceCanonical = canonical(parsed);
  const derive = (): string =>
    canonical({ ...parsed, $schema: CLAUDE_WIRE_SCHEMA_DIALECT });
  const projected = derive();
  // Fail closed on a non-deterministic derivation instead of pinning an unstable wire value.
  if (derive() !== projected)
    throw new Error("claude-request-schema-projection-nondeterministic");
  // Body identity: restoring the frozen dialect on the projection must reproduce the source
  // canonical bytes exactly, proving only "$schema" changed.
  const roundTrip = canonical({
    ...object(parseStrictJson(projected)),
    $schema: CLAUDE_FROZEN_SCHEMA_DIALECT,
  });
  if (roundTrip !== sourceCanonical)
    throw new Error("claude-request-schema-projection-body-drift");
  return {
    canonical: projected,
    sha256: digest(projected),
    sourceCanonical,
    sourceSha256: digest(sourceCanonical),
  };
}
