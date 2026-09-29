import { canonical, type Json } from "../../store/json.js";
import { parseStrictJson } from "../seam.js";
import { CLAUDE_CODE_MAX_SETTINGS_BYTES } from "./config.js";

/**
 * Rocky-owned canonical --settings rendering and validation (CC04; acceptance/claude-code
 * manifest launch.settings, source #94/878 §B). In `-p`, settings that fail validation are
 * SILENTLY IGNORED, so the bytes are canonical, duplicate-key-rejected, hash-bound before
 * spawn and producer-audited against the prohibited-key list. G-SET (silent-ignore native
 * proof plus a per-run positive control) remains an open gate for admission.
 */
export interface ClaudeSettingsPaths {
  configDir: string;
  parentHome: string;
  parentTmp: string;
  inputs: string;
  scratch: string;
  userHome: string;
  denyRoots: readonly string[];
}
const PROHIBITED_TOP_LEVEL = new Set([
  "env",
  "apiKeyHelper",
  "awsAuthRefresh",
  "hooks",
  "enabledPlugins",
  "extraKnownMarketplaces",
  "mcpServers",
  "allowedMcpServers",
  "fallbackModel",
  "availableModels",
  "modelOverrides",
  "pluginConfigs",
  "statusLine",
  "outputStyle",
  "allowAppleEvents",
  "allowUnixSockets",
  "enableWeakerNestedSandbox",
]);
function assertSettingsPath(value: string, name: string) {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.includes("~") ||
    value.includes(",") ||
    /[*?[\]{}]/.test(value) ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    value.normalize("NFC") !== value
  )
    throw new Error(`claude-settings-path:${name}`);
}
export function renderClaudeSettings(paths: ClaudeSettingsPaths): string {
  for (const key of [
    "configDir",
    "parentHome",
    "parentTmp",
    "inputs",
    "scratch",
    "userHome",
  ] as const)
    assertSettingsPath(paths[key], key);
  for (const root of paths.denyRoots) assertSettingsPath(root, "denyRoot");
  const deny = [
    `Read(//${paths.configDir}/**)`,
    `Edit(//${paths.configDir}/**)`,
    `Read(//${paths.parentHome}/**)`,
    `Read(//${paths.parentTmp}/**)`,
    `Read(//${paths.inputs}/**)`,
    `Read(//${paths.userHome}/.claude/**)`,
    `Read(//${paths.userHome}/.claude.json)`,
    `Read(//${paths.userHome}/.config/anthropic/**)`,
    `Read(//${paths.userHome}/Library/Keychains/**)`,
    ...paths.denyRoots.map((root) => `Read(//${root}/**)`),
  ];
  const settings = {
    disableAllHooks: true,
    autoMemoryEnabled: false,
    disableClaudeAiConnectors: true,
    enableAllProjectMcpServers: false,
    permissions: {
      defaultMode: "dontAsk",
      disableBypassPermissionsMode: "disable",
      blockReadsOutsideWorkingDirectories: true,
      additionalDirectories: [],
      allow: [],
      deny,
    },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: true,
      excludedCommands: [],
      filesystem: {
        allowWrite: [paths.scratch],
        denyRead: [
          paths.configDir,
          paths.parentHome,
          paths.parentTmp,
          paths.inputs,
          `${paths.userHome}/.claude`,
          `${paths.userHome}/.claude.json`,
          `${paths.userHome}/.config/anthropic`,
          `${paths.userHome}/Library/Keychains`,
          "/Library/Keychains",
          ...paths.denyRoots,
        ],
        denyWrite: [...paths.denyRoots],
      },
      credentials: { files: [{ path: paths.configDir, mode: "deny" }] },
      network: { allowedDomains: [], strictAllowlist: true },
    },
  };
  const bytes = canonical(settings);
  validateClaudeSettingsBytes(Buffer.from(bytes, "utf8"), {
    maxSettingsBytes: CLAUDE_CODE_MAX_SETTINGS_BYTES,
  });
  return bytes;
}
/** Producer audit of settings bytes: canonical round-trip with duplicate-key rejection,
 * allowlisted keys only, and rejection of every prohibited key/shape. */
export function validateClaudeSettingsBytes(
  bytes: Uint8Array,
  limits: { maxSettingsBytes: number },
): Json {
  if (bytes.byteLength === 0 || bytes.byteLength > limits.maxSettingsBytes)
    throw new Error("claude-settings-size");
  let parsed: unknown;
  try {
    parsed = parseStrictJson(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new Error("claude-settings-malformed");
  }
  auditSettingsValue(parsed, []);
  const text = Buffer.from(bytes).toString("utf8");
  if (canonical(parsed) !== text)
    throw new Error("claude-settings-not-canonical");
  return parsed as Json;
}
function auditSettingsValue(value: unknown, path: string[]) {
  if (Array.isArray(value)) {
    for (const item of value) auditSettingsValue(item, path);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(record)) {
    const at = [...path, key];
    const dotted = at.join(".");
    if (path.length === 0 && PROHIBITED_TOP_LEVEL.has(key))
      throw new Error(`claude-settings-prohibited:${key}`);
    if (/Helper$/.test(key) || key.startsWith("forceLogin"))
      throw new Error(`claude-settings-prohibited:${dotted}`);
    if (path.length === 0 && key.startsWith("model"))
      throw new Error(`claude-settings-prohibited:${key}`);
    if (dotted === "sandbox.filesystem.disabled")
      throw new Error("claude-settings-prohibited:sandbox.filesystem.disabled");
    if (dotted === "sandbox.network.tlsTerminate")
      throw new Error(
        "claude-settings-prohibited:sandbox.network.tlsTerminate",
      );
    auditSettingsValue(child, at);
  }
  if (path.length === 0) {
    const permissions = record.permissions as Record<string, unknown>;
    if (
      !permissions ||
      permissions.defaultMode !== "dontAsk" ||
      permissions.disableBypassPermissionsMode !== "disable" ||
      permissions.blockReadsOutsideWorkingDirectories !== true ||
      !Array.isArray(permissions.additionalDirectories) ||
      permissions.additionalDirectories.length !== 0 ||
      !Array.isArray(permissions.allow) ||
      permissions.allow.length !== 0
    )
      throw new Error("claude-settings-permissions");
    const sandbox = record.sandbox as Record<string, unknown>;
    if (
      !sandbox ||
      sandbox.enabled !== true ||
      sandbox.failIfUnavailable !== true ||
      sandbox.allowUnsandboxedCommands !== false
    )
      throw new Error("claude-settings-sandbox");
    const network = sandbox.network as Record<string, unknown>;
    if (
      !network ||
      network.strictAllowlist !== true ||
      !Array.isArray(network.allowedDomains) ||
      network.allowedDomains.length !== 0
    )
      throw new Error("claude-settings-network");
    if (
      record.disableAllHooks !== true ||
      record.autoMemoryEnabled !== false ||
      record.disableClaudeAiConnectors !== true ||
      record.enableAllProjectMcpServers !== false
    )
      throw new Error("claude-settings-switches");
  }
}
