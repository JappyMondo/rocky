import { canonical, identity } from "../../store/json.js";
import {
  object,
  text,
  integer,
  validateQualification,
  validateVersions,
  SUBSCRIPTION_BUDGET_MODE,
  type ExecutionQualification,
} from "../../coordinator/contracts.js";
import type { Versions } from "../../store/index.js";
import { projectClaudeWireRequestSchema } from "./projection.js";
import { CLAUDE_EFFORTS, type ClaudeRole } from "./argv.js";

export const CLAUDE_CODE_HARNESS = "claude-code";
export const CLAUDE_CODE_CONTRACT_ID = "rocky-claude-code-95-v1";
/** Frozen candidate identity (acceptance/claude-code/manifest.json candidate block). A missing or
 * changed binary makes the profile unavailable, never substituted (CC01, G-VERSION). */
export const CLAUDE_CODE_PINNED_VERSION = "2.1.283";
export const CLAUDE_CODE_MAX_PROMPT_BYTES_CEILING = 10 * 1024 * 1024;
export const CLAUDE_CODE_MAX_SETTINGS_BYTES = 2 * 1024 * 1024;

export interface ClaudeCodeLimits {
  maxTurns: number;
  maxPromptBytes: number;
  maxArgvBytes: number;
  maxSettingsBytes: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  maxLineBytes: number;
  maxFrames: number;
  maxToolUses: number;
  maxResultBytes: number;
  killGraceMs: number;
  cleanupReserveMs: number;
  quiescenceTimeoutMs: number;
  maxTreeNodes: number;
}
export interface ClaudeBinaryConfig {
  path: string;
  sha256: string;
  bytes: number;
  version: string;
  buildTime: string | null;
}
export interface ClaudeContractBinding {
  contractId: string;
  /** sha256 digests of the frozen contract files, host-supplied and receipt-recorded. */
  manifestSha256: string;
  scenariosSha256: string;
  frozenSha256: string;
  /** Independently selected revision and approval reference (receipt requirement). */
  approvalReference: string;
}
export interface ClaudeDiscoveryConfig {
  managed: string[];
  managedDirs: string[];
  mdm: string[];
}
export interface ClaudeCodeConfig {
  harness: typeof CLAUDE_CODE_HARNESS;
  versions: Versions;
  qualification: ExecutionQualification;
  contract: ClaudeContractBinding;
  binary: ClaudeBinaryConfig;
  roles: Record<ClaudeRole, { model: string; effort: string }>;
  configDir: string;
  hostIdentity: { userHome: string; userName: string };
  denyRoots: string[];
  discovery: ClaudeDiscoveryConfig;
  appendInstructions: string;
  requestSchema: string;
  initExpectations: {
    skills: string[];
    slashCommands: string[];
    toolsIncludeStructuredOutput: boolean;
  };
  envOptions: { shell: boolean; user: boolean };
  limits: ClaudeCodeLimits;
  runsRoot: string;
  evidenceClass: string;
}
export interface ValidatedClaudeCodeConfig extends ClaudeCodeConfig {
  /** Canonical-minified draft-07 WIRE PROJECTION of the frozen request schema (the exact
   * --json-schema bytes; #111). The frozen source keeps its 2020-12 dialect and stays the
   * host-side validation authority; projection.ts fail-closes on any source whose "$schema"
   * is not exactly the frozen draft-2020-12 IRI. */
  requestSchemaCanonical: string;
  /** Projection hash: sha256 of the projected canonical wire bytes. */
  requestSchemaSha256: string;
  /** sha256 of the canonical-minified FROZEN source schema bytes (unchanged authority). */
  requestSchemaSourceSha256: string;
  configDigest: string;
}
const sha256Pattern = /^[a-f0-9]{64}$/;
function absolutePath(value: unknown, name: string): string {
  text(value);
  const path = String(value);
  if (!path.startsWith("/") || path.includes("\0") || path.endsWith("/"))
    throw new Error(`invalid-claude-path:${name}`);
  if (path.normalize() !== path) throw new Error(`invalid-claude-path:${name}`);
  return path;
}
function stringList(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) throw new Error(`invalid-claude-config:${name}`);
  for (const item of value) text(item);
  return value as string[];
}
/**
 * Fail-closed config validation. Model/effort come only from this approved role table (G-MODEL,
 * G-EFFORT); the adapter never chooses defaults, and no production qualification binding exists in
 * this package — an explicitly host-approved qualification is a required input.
 */
export function validateClaudeCodeConfig(
  value: unknown,
): ValidatedClaudeCodeConfig {
  const v = object(value);
  if (v.harness !== CLAUDE_CODE_HARNESS)
    throw new Error("invalid-claude-config:harness");
  validateVersions(v.versions);
  validateQualification(v.qualification);
  const q = v.qualification as ExecutionQualification;
  if (
    q.harness !== CLAUDE_CODE_HARNESS ||
    q.budgetMode !== SUBSCRIPTION_BUDGET_MODE
  )
    throw new Error("invalid-claude-qualification");
  const contract = object(v.contract);
  if (contract.contractId !== CLAUDE_CODE_CONTRACT_ID)
    throw new Error("invalid-claude-contract-id");
  for (const key of [
    "manifestSha256",
    "scenariosSha256",
    "frozenSha256",
    "approvalReference",
  ])
    if (
      typeof contract[key] !== "string" ||
      (key !== "approvalReference" &&
        !sha256Pattern.test(String(contract[key])))
    )
      throw new Error(`invalid-claude-config:contract.${key}`);
  text(contract.approvalReference);
  if (q.contractId !== CLAUDE_CODE_CONTRACT_ID)
    throw new Error("invalid-claude-qualification");
  const binary = object(v.binary);
  absolutePath(binary.path, "binary");
  if (
    typeof binary.sha256 !== "string" ||
    !sha256Pattern.test(binary.sha256) ||
    !Number.isSafeInteger(binary.bytes) ||
    Number(binary.bytes) < 1
  )
    throw new Error("invalid-claude-config:binary");
  if (binary.version !== CLAUDE_CODE_PINNED_VERSION)
    throw new Error("claude-version-unavailable");
  if (binary.buildTime !== null) text(binary.buildTime);
  const roles = object(v.roles);
  const implementer = object(roles.implementer);
  const reviewer = object(roles.reviewer);
  for (const r of [implementer, reviewer]) {
    text(r.model);
    if (!CLAUDE_EFFORTS.includes(r.effort as (typeof CLAUDE_EFFORTS)[number]))
      throw new Error("invalid-claude-effort");
  }
  absolutePath(v.configDir, "configDir");
  const hostIdentity = object(v.hostIdentity);
  absolutePath(hostIdentity.userHome, "userHome");
  if (
    typeof hostIdentity.userName !== "string" ||
    !/^[a-zA-Z0-9._-]+$/.test(hostIdentity.userName)
  )
    throw new Error("invalid-claude-config:userName");
  const denyRoots = stringList(v.denyRoots, "denyRoots").map((root) =>
    absolutePath(root, "denyRoot"),
  );
  const discovery = object(v.discovery);
  const discoveryConfig: ClaudeDiscoveryConfig = {
    managed: stringList(discovery.managed, "discovery.managed").map((p) =>
      absolutePath(p, "discovery.managed"),
    ),
    managedDirs: stringList(discovery.managedDirs, "discovery.managedDirs").map(
      (p) => absolutePath(p, "discovery.managedDirs"),
    ),
    mdm: stringList(discovery.mdm, "discovery.mdm").map((p) =>
      absolutePath(p, "discovery.mdm"),
    ),
  };
  if (typeof v.appendInstructions !== "string" || !v.appendInstructions.trim())
    throw new Error("invalid-claude-config:appendInstructions");
  if (
    typeof v.requestSchema !== "string" ||
    !v.requestSchema.trim() ||
    Buffer.byteLength(v.requestSchema) > CLAUDE_CODE_MAX_SETTINGS_BYTES
  )
    throw new Error("invalid-claude-config:requestSchema");
  const projection = projectClaudeWireRequestSchema(String(v.requestSchema));
  const initExpectations = object(v.initExpectations);
  const skills = stringList(initExpectations.skills, "initExpectations.skills");
  const slashCommands = stringList(
    initExpectations.slashCommands,
    "initExpectations.slashCommands",
  );
  if (typeof initExpectations.toolsIncludeStructuredOutput !== "boolean")
    throw new Error("invalid-claude-config:initExpectations");
  const envOptions = object(v.envOptions);
  if (
    typeof envOptions.shell !== "boolean" ||
    typeof envOptions.user !== "boolean"
  )
    throw new Error("invalid-claude-config:envOptions");
  const limits = object(v.limits) as unknown as ClaudeCodeLimits;
  for (const key of [
    "maxTurns",
    "maxPromptBytes",
    "maxArgvBytes",
    "maxSettingsBytes",
    "maxStdoutBytes",
    "maxStderrBytes",
    "maxLineBytes",
    "maxFrames",
    "maxToolUses",
    "maxResultBytes",
    "killGraceMs",
    "cleanupReserveMs",
    "quiescenceTimeoutMs",
    "maxTreeNodes",
  ] as const)
    integer(limits[key], 1);
  if (limits.maxPromptBytes > CLAUDE_CODE_MAX_PROMPT_BYTES_CEILING)
    throw new Error("invalid-claude-config:limits.maxPromptBytes");
  if (limits.maxSettingsBytes > CLAUDE_CODE_MAX_SETTINGS_BYTES)
    throw new Error("invalid-claude-config:limits.maxSettingsBytes");
  if (limits.maxResultBytes > limits.maxLineBytes)
    throw new Error("invalid-claude-config:limits.maxResultBytes");
  // Transport bounds must admit the one-shot prompt frame and the raw capture limits.
  if (limits.maxLineBytes > 10 * 1024 * 1024)
    throw new Error("invalid-claude-config:limits.maxLineBytes");
  for (const key of ["maxStdoutBytes", "maxStderrBytes"] as const)
    if (limits[key] > 16 * 1024 * 1024)
      throw new Error(`invalid-claude-config:limits.${key}`);
  if (limits.maxFrames > 4096)
    throw new Error("invalid-claude-config:limits.maxFrames");
  absolutePath(v.runsRoot, "runsRoot");
  if (
    typeof v.evidenceClass !== "string" ||
    ![
      "static",
      "owned-fake-cli",
      "synthetic-native",
      "live-subscription",
    ].includes(v.evidenceClass)
  )
    throw new Error("invalid-claude-config:evidenceClass");
  const config: ClaudeCodeConfig = JSON.parse(
    canonical({
      harness: v.harness,
      versions: v.versions,
      qualification: v.qualification,
      contract: {
        contractId: contract.contractId,
        manifestSha256: contract.manifestSha256,
        scenariosSha256: contract.scenariosSha256,
        frozenSha256: contract.frozenSha256,
        approvalReference: contract.approvalReference,
      },
      binary: {
        path: binary.path,
        sha256: binary.sha256,
        bytes: Number(binary.bytes),
        version: binary.version,
        buildTime: binary.buildTime ?? null,
      },
      roles: {
        implementer: {
          model: implementer.model as string,
          effort: implementer.effort as string,
        },
        reviewer: {
          model: reviewer.model as string,
          effort: reviewer.effort as string,
        },
      },
      configDir: v.configDir,
      hostIdentity: {
        userHome: hostIdentity.userHome,
        userName: hostIdentity.userName,
      },
      denyRoots,
      discovery: discoveryConfig,
      appendInstructions: v.appendInstructions,
      requestSchema: v.requestSchema,
      initExpectations: {
        skills,
        slashCommands,
        toolsIncludeStructuredOutput:
          initExpectations.toolsIncludeStructuredOutput,
      },
      envOptions: { shell: envOptions.shell, user: envOptions.user },
      limits,
      runsRoot: v.runsRoot,
      evidenceClass: v.evidenceClass,
    }),
  ) as ClaudeCodeConfig;
  return {
    ...config,
    requestSchemaCanonical: projection.canonical,
    requestSchemaSha256: projection.sha256,
    requestSchemaSourceSha256: projection.sourceSha256,
    configDigest: identity(config),
  };
}
/** Default endpoint-managed/MDM discovery paths (research #94/872 F6, names-only inventory).
 * Production configs use these; owned synthetic environments may substitute explicit paths. */
export function defaultClaudeDiscoveryConfig(
  userHome: string,
): ClaudeDiscoveryConfig {
  const base = "/Library/Application Support/ClaudeCode";
  return {
    managed: [
      `${base}/managed-settings.json`,
      `${base}/managed-mcp.json`,
      `${base}/CLAUDE.md`,
    ],
    managedDirs: [`${base}/managed-settings.d`],
    mdm: [
      "/Library/Managed Preferences/com.anthropic.claudecode.plist",
      `${userHome}/Library/Managed Preferences/com.anthropic.claudecode.plist`,
    ],
  };
}
