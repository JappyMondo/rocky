import { resolve } from "node:path";
export interface EffectiveConfig {
  capacity: 1;
  workspaceRoot: string;
  logBytes: number;
  cleanupMs: number;
  leaseMs: number;
  delivery: "pr-only" | "approval-gated";
  credentialRefs: Record<string, string>;
}
const defaults = {
  capacity: 1,
  workspaceRoot: ".artifacts/runs",
  logBytes: 1048576,
  cleanupMs: 500,
  leaseMs: 5000,
  delivery: "pr-only",
  credentialRefs: {},
};
export function configure(overrides: unknown = {}, release = "foundation-1") {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides))
    throw new Error("invalid-configuration");
  const input = overrides as Record<string, unknown>;
  for (const key of Object.keys(input))
    if (!Object.hasOwn(defaults, key))
      throw new Error("unknown-configuration-key");
  const merged = { ...defaults, ...input };
  if (
    merged.capacity !== 1 ||
    !["pr-only", "approval-gated"].includes(String(merged.delivery))
  )
    throw new Error("unsupported-configuration");
  for (const key of ["logBytes", "cleanupMs", "leaseMs"] as const) {
    const value = merged[key];
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > 2_147_483_647
    )
      throw new Error("invalid-" + key);
  }
  if (
    typeof merged.workspaceRoot !== "string" ||
    !merged.workspaceRoot ||
    merged.workspaceRoot.includes("\0")
  )
    throw new Error("invalid-workspace-root");
  if (
    !merged.credentialRefs ||
    typeof merged.credentialRefs !== "object" ||
    Array.isArray(merged.credentialRefs)
  )
    throw new Error("invalid-credential-references");
  for (const [key, value] of Object.entries(merged.credentialRefs)) {
    if (
      !/^[a-z][a-z0-9-]*$/.test(key) ||
      typeof value !== "string" ||
      !/^env:[A-Z][A-Z0-9_]*$/.test(value)
    )
      throw new Error("credential-reference-required");
  }
  const values = {
    ...merged,
    workspaceRoot: resolve(merged.workspaceRoot),
  } as EffectiveConfig;
  const provenance = Object.fromEntries(
    Object.keys(defaults).map((k) => [
      k,
      Object.hasOwn(input, k) ? "operator" : "release:" + release,
    ]),
  );
  return { values, provenance };
}
export function resolveCredential(
  reference: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (!/^env:[A-Z][A-Z0-9_]*$/.test(reference))
    throw new Error("credential-reference-required");
  const value = environment[reference.slice(4)];
  if (!value) throw new Error("credential-unavailable");
  return value;
}
