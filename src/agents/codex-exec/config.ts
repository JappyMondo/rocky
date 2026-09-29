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
import { parseStrictJson } from "../seam.js";
import { isOnTableModelEffort, type CodexRole } from "./argv.js";

export const CODEX_EXEC_HARNESS = "codex-exec";
export const CODEX_EXEC_CONTRACT_ID = "rocky-subscription-88-v1";
/** Frozen candidate identity (acceptance/subscription manifest candidate block). A missing or
 * changed binary makes the profile unavailable, never substituted (S01/S09). */
export const CODEX_EXEC_PINNED_VERSION = "0.157.1";
export const CODEX_EXEC_SOURCE_COMMIT =
  "36650394c5b38c2990ccf2a3457165ca3e9d9726";
export const CODEX_EXEC_MAX_PROMPT_BYTES_CEILING = 10 * 1024 * 1024;
export const CODEX_EXEC_MAX_SCHEMA_BYTES = 2 * 1024 * 1024;
/** The reviewer role is always the complex/independent-review assignment (astra/high). */
const REVIEWER_MODEL = "gpt-6-astra";
const REVIEWER_EFFORT = "high";

export interface CodexExecLimits {
  maxPromptBytes: number;
  maxArgvBytes: number;
  maxOverrideValueBytes: number;
  maxOverrides: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  maxLineBytes: number;
  maxFrames: number;
  maxItems: number;
  maxFinalBytes: number;
  maxAggregatedOutputBytes: number;
  maxDenyEntries: number;
  maxImages: number;
  maxImageBytes: number;
  killGraceMs: number;
  cleanupReserveMs: number;
  quiescenceTimeoutMs: number;
  maxTreeNodes: number;
}
export interface CodexBinaryConfig {
  path: string;
  sha256: string;
  bytes: number;
  version: string;
  buildTime: string | null;
  sourceCommit: string;
}
export interface CodexContractBinding {
  contractId: string;
  manifestSha256: string;
  scenariosSha256: string;
  frozenSha256: string;
  approvalReference: string;
}
export interface CodexAuthBackend {
  /** The host's actual configured credentials store; --ignore-user-config drops the user layer, so
   * this must be declared explicitly and equal the host value. "ephemeral" is prohibited. */
  credentialsStore: "file" | "keyring" | "auto";
  secretAuthStorage: boolean;
}
export interface CodexDiscoveryConfig {
  system: string[];
  systemDirs: string[];
  mdm: string[];
  /** sha256 of the approved effective global AGENTS file, or null when it must be absent. */
  approvedGlobalAgentsSha256: string | null;
  codexHomeSkillsApproved: boolean;
}
export interface CodexExecConfig {
  harness: typeof CODEX_EXEC_HARNESS;
  versions: Versions;
  qualification: ExecutionQualification;
  contract: CodexContractBinding;
  binary: CodexBinaryConfig;
  roles: Record<CodexRole, { model: string; effort: string }>;
  /** The ONE designated shared auth store (canonical absolute); NOT the private runtime HOME. */
  codexHome: string;
  authBackend: CodexAuthBackend;
  hostIdentity: { userHome: string; userName: string };
  denyRoots: string[];
  platformDenyRoots: string[];
  permissionProfiles: Record<CodexRole, string>;
  discovery: CodexDiscoveryConfig;
  requestSchema: string;
  envOptions: { shell: boolean; user: boolean };
  limits: CodexExecLimits;
  runsRoot: string;
  evidenceClass: string;
}
export interface ValidatedCodexExecConfig extends CodexExecConfig {
  requestSchemaCanonical: string;
  requestSchemaSha256: string;
  configDigest: string;
}
const sha256Pattern = /^[a-f0-9]{64}$/;
function absolutePath(value: unknown, name: string): string {
  text(value);
  const path = String(value);
  if (!path.startsWith("/") || path.includes("\0") || path.endsWith("/"))
    throw new Error(`invalid-codex-path:${name}`);
  if (path.normalize() !== path) throw new Error(`invalid-codex-path:${name}`);
  return path;
}
function stringList(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) throw new Error(`invalid-codex-config:${name}`);
  for (const item of value) text(item);
  return value as string[];
}
/**
 * Fail-closed config validation. Model/effort come only from this approved role table and must be
 * on-table assignments (S09; no fallback/reroute, never defaulted); the adapter never chooses
 * defaults. No production qualification binding exists in this package — an explicitly host-approved
 * qualification is a required input, so production admission stays unavailable until one exists.
 */
export function validateCodexExecConfig(
  value: unknown,
): ValidatedCodexExecConfig {
  const v = object(value);
  if (v.harness !== CODEX_EXEC_HARNESS)
    throw new Error("invalid-codex-config:harness");
  validateVersions(v.versions);
  validateQualification(v.qualification);
  const q = v.qualification as ExecutionQualification;
  if (
    q.harness !== CODEX_EXEC_HARNESS ||
    q.budgetMode !== SUBSCRIPTION_BUDGET_MODE ||
    q.contractId !== CODEX_EXEC_CONTRACT_ID
  )
    throw new Error("invalid-codex-qualification");
  const contract = object(v.contract);
  if (contract.contractId !== CODEX_EXEC_CONTRACT_ID)
    throw new Error("invalid-codex-contract-id");
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
      throw new Error(`invalid-codex-config:contract.${key}`);
  text(contract.approvalReference);
  const binary = object(v.binary);
  absolutePath(binary.path, "binary");
  if (
    typeof binary.sha256 !== "string" ||
    !sha256Pattern.test(binary.sha256) ||
    !Number.isSafeInteger(binary.bytes) ||
    Number(binary.bytes) < 1
  )
    throw new Error("invalid-codex-config:binary");
  if (binary.version !== CODEX_EXEC_PINNED_VERSION)
    throw new Error("codex-version-unavailable");
  if (binary.sourceCommit !== CODEX_EXEC_SOURCE_COMMIT)
    throw new Error("codex-source-commit-unavailable");
  if (binary.buildTime !== null) text(binary.buildTime);
  const roles = object(v.roles);
  const implementer = object(roles.implementer);
  const reviewer = object(roles.reviewer);
  for (const r of [implementer, reviewer]) (text(r.model), text(r.effort));
  if (
    !isOnTableModelEffort(
      implementer.model as string,
      implementer.effort as string,
    )
  )
    throw new Error("codex-implementer-model-effort-off-table");
  if (
    reviewer.model !== REVIEWER_MODEL ||
    reviewer.effort !== REVIEWER_EFFORT ||
    !isOnTableModelEffort(reviewer.model as string, reviewer.effort as string)
  )
    throw new Error("codex-reviewer-model-effort-off-table");
  absolutePath(v.codexHome, "codexHome");
  const authBackend = object(v.authBackend);
  if (
    !["file", "keyring", "auto"].includes(String(authBackend.credentialsStore))
  )
    throw new Error("invalid-codex-auth-backend");
  if (typeof authBackend.secretAuthStorage !== "boolean")
    throw new Error("invalid-codex-auth-backend");
  const hostIdentity = object(v.hostIdentity);
  absolutePath(hostIdentity.userHome, "userHome");
  if (
    typeof hostIdentity.userName !== "string" ||
    !/^[a-zA-Z0-9._-]+$/.test(hostIdentity.userName)
  )
    throw new Error("invalid-codex-config:userName");
  const denyRoots = stringList(v.denyRoots, "denyRoots").map((root) =>
    absolutePath(root, "denyRoot"),
  );
  const platformDenyRoots = stringList(
    v.platformDenyRoots,
    "platformDenyRoots",
  ).map((root) => absolutePath(root, "platformDenyRoot"));
  const permissionProfiles = object(v.permissionProfiles);
  const profiles: Record<CodexRole, string> = {
    implementer: String(permissionProfiles.implementer),
    reviewer: String(permissionProfiles.reviewer),
  };
  for (const role of ["implementer", "reviewer"] as const)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(profiles[role]))
      throw new Error(`invalid-codex-permission-profile:${role}`);
  const discovery = object(v.discovery);
  const approved = discovery.approvedGlobalAgentsSha256;
  const discoveryConfig: CodexDiscoveryConfig = {
    system: stringList(discovery.system, "discovery.system").map((p) =>
      absolutePath(p, "discovery.system"),
    ),
    systemDirs: stringList(discovery.systemDirs, "discovery.systemDirs").map(
      (p) => absolutePath(p, "discovery.systemDirs"),
    ),
    mdm: stringList(discovery.mdm, "discovery.mdm").map((p) =>
      absolutePath(p, "discovery.mdm"),
    ),
    approvedGlobalAgentsSha256:
      approved === null
        ? null
        : sha256Pattern.test(String(approved))
          ? String(approved)
          : (() => {
              throw new Error("invalid-codex-config:approvedGlobalAgents");
            })(),
    codexHomeSkillsApproved: discovery.codexHomeSkillsApproved === true,
  };
  if (
    typeof v.requestSchema !== "string" ||
    !v.requestSchema.trim() ||
    Buffer.byteLength(v.requestSchema) > CODEX_EXEC_MAX_SCHEMA_BYTES
  )
    throw new Error("invalid-codex-config:requestSchema");
  const requestSchemaCanonical = canonical(parseStrictJson(v.requestSchema));
  const envOptions = object(v.envOptions);
  if (
    typeof envOptions.shell !== "boolean" ||
    typeof envOptions.user !== "boolean"
  )
    throw new Error("invalid-codex-config:envOptions");
  const limits = object(v.limits) as unknown as CodexExecLimits;
  for (const key of [
    "maxPromptBytes",
    "maxArgvBytes",
    "maxOverrideValueBytes",
    "maxOverrides",
    "maxStdoutBytes",
    "maxStderrBytes",
    "maxLineBytes",
    "maxFrames",
    "maxItems",
    "maxFinalBytes",
    "maxAggregatedOutputBytes",
    "maxDenyEntries",
    "maxImages",
    "maxImageBytes",
    "killGraceMs",
    "cleanupReserveMs",
    "quiescenceTimeoutMs",
    "maxTreeNodes",
  ] as const)
    integer(limits[key], 1);
  if (limits.maxPromptBytes > CODEX_EXEC_MAX_PROMPT_BYTES_CEILING)
    throw new Error("invalid-codex-config:limits.maxPromptBytes");
  if (limits.maxFinalBytes > limits.maxLineBytes)
    throw new Error("invalid-codex-config:limits.maxFinalBytes");
  if (limits.maxLineBytes > 10 * 1024 * 1024)
    throw new Error("invalid-codex-config:limits.maxLineBytes");
  for (const key of ["maxStdoutBytes", "maxStderrBytes"] as const)
    if (limits[key] > 16 * 1024 * 1024)
      throw new Error(`invalid-codex-config:limits.${key}`);
  if (limits.maxFrames > 4096)
    throw new Error("invalid-codex-config:limits.maxFrames");
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
    throw new Error("invalid-codex-config:evidenceClass");
  const config: CodexExecConfig = JSON.parse(
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
        sourceCommit: binary.sourceCommit,
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
      codexHome: v.codexHome,
      authBackend: {
        credentialsStore: authBackend.credentialsStore,
        secretAuthStorage: authBackend.secretAuthStorage,
      },
      hostIdentity: {
        userHome: hostIdentity.userHome,
        userName: hostIdentity.userName,
      },
      denyRoots,
      platformDenyRoots,
      permissionProfiles: profiles,
      discovery: discoveryConfig,
      requestSchema: v.requestSchema,
      envOptions: { shell: envOptions.shell, user: envOptions.user },
      limits,
      runsRoot: v.runsRoot,
      evidenceClass: v.evidenceClass,
    }),
  ) as CodexExecConfig;
  return {
    ...config,
    requestSchemaCanonical,
    requestSchemaSha256: identity(requestSchemaCanonical),
    configDigest: identity(config),
  };
}
/** Default system/managed/MDM discovery paths (source #92/857 F2 loader layers, names-only
 * inventory). Production configs use these; owned synthetic environments substitute explicit paths. */
export function defaultCodexDiscoveryConfig(
  userHome: string,
): Pick<CodexDiscoveryConfig, "system" | "systemDirs" | "mdm"> {
  return {
    system: [
      "/etc/codex/config.toml",
      "/etc/codex/requirements.toml",
      "/etc/codex/managed_config.toml",
    ],
    systemDirs: ["/etc/codex/skills"],
    mdm: [
      "/Library/Managed Preferences/com.openai.codex.plist",
      `${userHome}/Library/Managed Preferences/com.openai.codex.plist`,
    ],
  };
}
/** Default reused platform deny roots (source #92/858 §D, the #63 static candidate set). */
export function defaultCodexPlatformDenyRoots(): string[] {
  return [
    "/tmp",
    "/private/tmp",
    "/var/tmp",
    "/private/var/tmp",
    "/Applications",
    "/etc",
    "/private/etc",
    "/var/db",
    "/private/var/db",
    "/Library/Preferences",
    "/Library/Preferences/Logging",
    "/Library/Filesystems/NetFSPlugins",
    "/opt/homebrew/lib",
    "/usr/local/lib",
  ];
}
