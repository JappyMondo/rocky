import { canonical, identity } from "../../store/json.js";
import {
  integer,
  object,
  text,
  validateQualification,
  validateVersions,
  SUBSCRIPTION_BUDGET_MODE,
  type ExecutionQualification,
} from "../../coordinator/contracts.js";
import type { Versions } from "../../store/index.js";

export const OPENCODE_HARNESS = "opencode";
/** PoC contract identity (Taskbot #98; user decision 2026-09-29: no protected-contract ceremony,
 * #106/#107 cancelled). This names the #104 research bundle as the behavioral source; it is NOT an
 * independently approved contract and grants nothing in production. */
export const OPENCODE_CONTRACT_ID = "rocky-opencode-poc-98-v1";
/** Pinned identity, host-measured WITHOUT execution in #104 research (F1). The installed binary is
 * never executed by this package; missing/drift makes the profile unavailable, never substituted. */
export const OPENCODE_PINNED_VERSION = "1.18.32";
export const OPENCODE_PINNED_BINARY_PATH =
  "/opt/homebrew/Cellar/opencode/1.18.32/bin/opencode";
export const OPENCODE_PINNED_SHA256 =
  "a3c45d4e1d6620b436851f1ef6b25c71befcf06a382e279a1eb1c2196424395e";
export const OPENCODE_PINNED_BYTES = 144602594;
/** The single on-table model (F4): provider 'alibaba-token-plan', split on the FIRST '/'. */
export const OPENCODE_PINNED_MODEL = "alibaba-token-plan/qwen3.8-max";
export const OPENCODE_PINNED_PROVIDER = "alibaba-token-plan";
export const OPENCODE_MAX_PROMPT_BYTES_CEILING = 10 * 1024 * 1024;

export type OpencodeRole = "implementer" | "reviewer";
/** Agent-work role mapping; non-agent kinds never launch this harness (mirrors the other adapters). */
export function opencodeRoleForKind(kind: string): OpencodeRole {
  if (
    ["implement", "repair_product", "repair_ci", "repair_review"].includes(kind)
  )
    return "implementer";
  if (["review", "arbitrate"].includes(kind)) return "reviewer";
  throw new Error("opencode-agent-work-only");
}
/** Agent names inside the sealed config content. The agent `prompt` REPLACES the default system
 * prompt (G-DEFAULT-PROMPT): the sealed prompt bytes are the WHOLE system prompt. */
export function opencodeAgentName(role: OpencodeRole): string {
  return role === "implementer" ? "rocky-implementer" : "rocky-reviewer";
}

export interface OpencodeLimits {
  maxPromptBytes: number;
  maxArgvBytes: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  maxLineBytes: number;
  maxFrames: number;
  maxParts: number;
  maxFinalBytes: number;
  maxExportBytes: number;
  exportTimeoutMs: number;
  killGraceMs: number;
  cleanupReserveMs: number;
  maxTreeNodes: number;
}
export interface OpencodeRoleConfig {
  /** On-table only: must equal OPENCODE_PINNED_MODEL; off-table refuses and is never defaulted. */
  model: string;
  /** agent.steps — the max-turns analogue (F18): max agentic iterations before forced text. */
  steps: number;
  /** Host-supplied role system prompt; REPLACES the opencode default system prompt. */
  prompt: string;
}
export interface OpencodeConfig {
  harness: typeof OPENCODE_HARNESS;
  versions: Versions;
  qualification: ExecutionQualification;
  binary: { path: string; sha256: string; bytes: number; version: string };
  roles: Record<OpencodeRole, OpencodeRoleConfig>;
  /** Rocky-owned dedicated XDG_DATA_HOME (root decision from #104 acceptance, provisional; user may
   * veto). Auth is provisioned into it ONE TIME by the user; Rocky never reads/copies/proxies
   * auth.json. The user's real data dir (~/.local/share/opencode) is unrepresentable: a dataHome
   * equal to, inside, or containing it refuses (shared-user-data-dir mode fail-closed). */
  dataHome: string;
  /** Pinned models.dev catalog file (F4/F6): OPENCODE_MODELS_PATH + OPENCODE_DISABLE_MODELS_FETCH. */
  modelsCatalog: { path: string; sha256: string };
  /** Managed layers that cannot be overridden by any config (F13 layer 7/8); names-only inventory,
   * any presence makes the profile unavailable (G-MANAGED). */
  managedPaths: string[];
  hostIdentity: { userHome: string };
  limits: OpencodeLimits;
  runsRoot: string;
  evidenceClass: string;
}
export interface ValidatedOpencodeConfig extends OpencodeConfig {
  configDigest: string;
}
const sha256Pattern = /^[a-f0-9]{64}$/;
function absolutePath(value: unknown, name: string): string {
  text(value);
  const path = String(value);
  if (!path.startsWith("/") || path.includes("\0") || path.endsWith("/"))
    throw new Error(`invalid-opencode-path:${name}`);
  if (path.normalize() !== path)
    throw new Error(`invalid-opencode-path:${name}`);
  return path;
}
function stringList(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) throw new Error(`invalid-opencode-config:${name}`);
  for (const item of value) text(item);
  return value as string[];
}
/**
 * Fail-closed config validation. Model comes only from the pinned on-table value; the binary must
 * claim the pinned version and hash/size shape; the data dir must be Rocky-owned (never the user's
 * real opencode data dir); managed paths and the pinned catalog are required inputs. No production
 * qualification binding exists in this package — an explicitly host-approved qualification is a
 * required input, so production admission stays unavailable until independent qualification
 * (a root-granted live step, #14) exists.
 */
export function validateOpencodeConfig(
  value: unknown,
): ValidatedOpencodeConfig {
  const v = object(value);
  if (v.harness !== OPENCODE_HARNESS)
    throw new Error("invalid-opencode-config:harness");
  validateVersions(v.versions);
  validateQualification(v.qualification);
  const q = v.qualification as ExecutionQualification;
  if (
    q.harness !== OPENCODE_HARNESS ||
    q.budgetMode !== SUBSCRIPTION_BUDGET_MODE ||
    q.contractId !== OPENCODE_CONTRACT_ID
  )
    throw new Error("invalid-opencode-qualification");
  const binary = object(v.binary);
  absolutePath(binary.path, "binary");
  if (
    typeof binary.sha256 !== "string" ||
    !sha256Pattern.test(binary.sha256) ||
    !Number.isSafeInteger(binary.bytes) ||
    Number(binary.bytes) < 1
  )
    throw new Error("invalid-opencode-config:binary");
  if (binary.version !== OPENCODE_PINNED_VERSION)
    throw new Error("opencode-version-unavailable");
  const roles = object(v.roles);
  const validatedRoles = {} as Record<OpencodeRole, OpencodeRoleConfig>;
  for (const role of ["implementer", "reviewer"] as const) {
    const r = object(roles[role]);
    text(r.model);
    integer(r.steps, 1);
    text(r.prompt);
    // Off-table model refuses and is never defaulted (no fallback/reroute; F26: --model is strict).
    if (r.model !== OPENCODE_PINNED_MODEL)
      throw new Error(`opencode-${role}-model-off-table`);
    if (Number(r.steps) > 256)
      throw new Error(`invalid-opencode-config:roles.${role}.steps`);
    const prompt = String(r.prompt);
    if (!prompt.trim() || Buffer.byteLength(prompt) > 256 * 1024)
      throw new Error(`invalid-opencode-config:roles.${role}.prompt`);
    validatedRoles[role] = {
      model: String(r.model),
      steps: Number(r.steps),
      prompt,
    };
  }
  absolutePath(v.dataHome, "dataHome");
  const catalog = object(v.modelsCatalog);
  absolutePath(catalog.path, "modelsCatalog");
  if (typeof catalog.sha256 !== "string" || !sha256Pattern.test(catalog.sha256))
    throw new Error("invalid-opencode-config:modelsCatalog");
  const managedPaths = stringList(v.managedPaths, "managedPaths").map((p) =>
    absolutePath(p, "managedPath"),
  );
  const hostIdentity = object(v.hostIdentity);
  absolutePath(hostIdentity.userHome, "userHome");
  const limits = object(v.limits) as unknown as OpencodeLimits;
  for (const key of [
    "maxPromptBytes",
    "maxArgvBytes",
    "maxStdoutBytes",
    "maxStderrBytes",
    "maxLineBytes",
    "maxFrames",
    "maxParts",
    "maxFinalBytes",
    "maxExportBytes",
    "exportTimeoutMs",
    "killGraceMs",
    "cleanupReserveMs",
    "maxTreeNodes",
  ] as const)
    integer(limits[key], 1);
  if (limits.maxPromptBytes > OPENCODE_MAX_PROMPT_BYTES_CEILING)
    throw new Error("invalid-opencode-config:limits.maxPromptBytes");
  if (limits.maxFinalBytes > limits.maxLineBytes)
    throw new Error("invalid-opencode-config:limits.maxFinalBytes");
  if (limits.maxLineBytes > 10 * 1024 * 1024)
    throw new Error("invalid-opencode-config:limits.maxLineBytes");
  for (const key of ["maxStdoutBytes", "maxStderrBytes"] as const)
    if (limits[key] > 16 * 1024 * 1024)
      throw new Error(`invalid-opencode-config:limits.${key}`);
  if (limits.maxFrames > 4096)
    throw new Error("invalid-opencode-config:limits.maxFrames");
  absolutePath(v.runsRoot, "runsRoot");
  if (
    typeof v.evidenceClass !== "string" ||
    !["static", "owned-fake-cli", "live-subscription"].includes(v.evidenceClass)
  )
    throw new Error("invalid-opencode-config:evidenceClass");
  const config: OpencodeConfig = JSON.parse(
    canonical({
      harness: v.harness,
      versions: v.versions,
      qualification: v.qualification,
      binary: {
        path: binary.path,
        sha256: binary.sha256,
        bytes: Number(binary.bytes),
        version: binary.version,
      },
      roles: validatedRoles,
      dataHome: v.dataHome,
      modelsCatalog: { path: catalog.path, sha256: catalog.sha256 },
      managedPaths,
      hostIdentity: { userHome: hostIdentity.userHome },
      limits,
      runsRoot: v.runsRoot,
      evidenceClass: v.evidenceClass,
    }),
  ) as OpencodeConfig;
  return { ...config, configDigest: identity(config) };
}
/** Default managed/MDM discovery paths (F13 layers 7/8, names-only inventory; absent on the
 * research host, re-inventoried each run). Production configs use these; synthetic environments
 * substitute explicit owned paths. */
export function defaultOpencodeManagedPaths(): string[] {
  return [
    "/Library/Application Support/opencode/opencode.json",
    "/Library/Application Support/opencode/opencode.jsonc",
    "/Library/Managed Preferences/ai.opencode.managed.plist",
  ];
}
