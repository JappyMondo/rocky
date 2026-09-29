import type { SealedEnv } from "../seam.js";

/**
 * Sealed positive-allowlist child environment (CC02; acceptance/claude-code manifest
 * launch.environment, source #94/878 §C). Nothing is inherited: the child env is exactly the
 * ordered allowlist. In `-p`, ANTHROPIC_API_KEY is ALWAYS used when present and it plus every
 * provider/token/profile switch outranks subscription OAuth, so any forbidden key present in the
 * source environment fails the launch pre-spawn and is regression-asserted always-absent.
 */
export const CLAUDE_FIXED_ENV_SWITCHES: SealedEnv = [
  ["DISABLE_AUTOUPDATER", "1"],
  ["DISABLE_UPDATES", "1"],
  ["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1"],
  ["DISABLE_TELEMETRY", "1"],
  ["DISABLE_ERROR_REPORTING", "1"],
  ["CLAUDE_CODE_DISABLE_AUTO_MEMORY", "1"],
  ["CLAUDE_CODE_DISABLE_CLAUDE_MDS", "1"],
  ["CLAUDE_CODE_DISABLE_BUNDLED_SKILLS", "1"],
  ["CLAUDE_CODE_DISABLE_POLICY_SKILLS", "1"],
  ["CLAUDE_CODE_DISABLE_BACKGROUND_TASKS", "1"],
  ["CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING", "1"],
  ["CLAUDE_CODE_SKIP_PROMPT_HISTORY", "1"],
  ["CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS", "1"],
  ["CLAUDE_CODE_STARTUP_FAILURE_RESULTS", "1"],
];
export const CLAUDE_FORBIDDEN_ENV_EXPLICIT: ReadonlySet<string> = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_PROFILE",
  "ANTHROPIC_FEDERATION_RULE_ID",
  "ANTHROPIC_ORGANIZATION_ID",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_GATEWAY",
  "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_GATEWAY_TOKEN",
  "CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_SESSION_ACCESS_TOKEN",
  "CLAUDE_CODE_HOST_AUTH_ENV_VAR",
  "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
  "CLAUDE_CODE_CUSTOM_OAUTH_URL",
  "CLAUDE_CODE_CLIENT_DATA_URL",
  "CLAUDE_CODE_MANAGED_SETTINGS_PATH",
  "CLAUDE_SECURESTORAGE_CONFIG_DIR",
  "CLAUDE_CODE_SIMPLE",
  "CLAUDE_CODE_SAFE_MODE",
  "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB",
  "CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD",
  "CLAUDE_CODE_RESUME_INTERRUPTED_TURN",
  "CLAUDE_CODE_PROJECT_DIR_NAME",
  "ANTHROPIC_IDENTITY_TOKEN",
  "ANTHROPIC_IDENTITY_TOKEN_FILE",
]);
export const CLAUDE_FORBIDDEN_ENV_FAMILIES: readonly RegExp[] = [
  /^ANTHROPIC_/,
  /^CLAUDE_CODE_USE_/,
  /^CLAUDE_CODE_OAUTH_/,
  /^CLAUDE_CODE_API_/,
  /^CLAUDE_CODE_.*TOKEN/,
  /^CLAUDE_CODE_.*_FILE_DESCRIPTOR$/,
  /^CLAUDE_CODE_HOST_AUTH_/,
  /^CLAUDE_CODE_(MAX_RETRIES|RETRY_WATCHDOG)$/,
  /_PROXY$/,
  /^NO_PROXY$/,
  /^NODE_EXTRA_CA_CERTS$/,
  /^SSL_/,
  /^AWS_/,
  /^GOOGLE_/,
  /^VERTEX_/,
  /^AZURE_/,
  /^GH_/,
  /^GITHUB_/,
  /^GIT_/,
  /^SSH_AUTH_SOCK$/,
  /^OPENAI_/,
  /^CODEX_/,
  /^MCP_/,
  /^OTEL_/,
];
/** Key names only; values are never logged, retained or compared. */
export function isForbiddenClaudeEnvKey(key: string): boolean {
  return (
    CLAUDE_FORBIDDEN_ENV_EXPLICIT.has(key) ||
    CLAUDE_FORBIDDEN_ENV_FAMILIES.some((pattern) => pattern.test(key))
  );
}
export function findForbiddenClaudeEnvKeys(
  env: Record<string, string | undefined>,
): string[] {
  return Object.keys(env)
    .filter((key) => env[key] !== undefined && isForbiddenClaudeEnvKey(key))
    .sort();
}
/** Fail pre-spawn when the source environment carries any forbidden key (poisoned-env rule). */
export function assertClaudeSourceEnvAdmissible(
  env: Record<string, string | undefined>,
) {
  const forbidden = findForbiddenClaudeEnvKeys(env);
  if (forbidden.length)
    throw new Error(`claude-forbidden-env-present:${forbidden.join(",")}`);
}
export interface ClaudeSealedEnvPaths {
  parentHome: string;
  configDir: string;
  parentTmp: string;
}
/** The complete child environment: a fresh parent HOME, the dedicated CLAUDE_CONFIG_DIR,
 * minimal PATH/LANG/TMPDIR and the fixed disable switches, plus probe-gated conditionals. */
export function buildClaudeSealedEnv(
  paths: ClaudeSealedEnvPaths,
  options: { shell: boolean; user: boolean; userName: string },
): SealedEnv {
  const entries: (readonly [string, string])[] = [
    ["HOME", paths.parentHome],
    ["CLAUDE_CONFIG_DIR", paths.configDir],
    ["PATH", "/usr/bin:/bin:/usr/sbin:/sbin"],
    ["LANG", "en_US.UTF-8"],
    ["TMPDIR", paths.parentTmp],
    ["CLAUDE_CODE_TMPDIR", paths.parentTmp],
    ...CLAUDE_FIXED_ENV_SWITCHES,
  ];
  if (options.shell) entries.push(["SHELL", "/bin/zsh"]);
  if (options.user) {
    entries.push(["USER", options.userName]);
    entries.push(["LOGNAME", options.userName]);
  }
  assertClaudeSealedEnv(entries, paths);
  return entries;
}
/** Defense-in-depth audit of the sealed list itself: dedicated mode requires CLAUDE_CONFIG_DIR,
 * no forbidden key may appear, and the list is the complete child environment. */
export function assertClaudeSealedEnv(
  env: SealedEnv,
  paths: ClaudeSealedEnvPaths,
) {
  const seen = new Map<string, string>();
  for (const [key, value] of env) {
    if (seen.has(key)) throw new Error("claude-sealed-env-duplicate");
    if (isForbiddenClaudeEnvKey(key))
      throw new Error(`claude-sealed-env-forbidden:${key}`);
    seen.set(key, value);
  }
  if (seen.get("HOME") !== paths.parentHome)
    throw new Error("claude-sealed-env-home");
  if (seen.get("CLAUDE_CONFIG_DIR") !== paths.configDir)
    throw new Error("claude-sealed-env-config-dir");
  if (seen.get("TMPDIR") !== paths.parentTmp)
    throw new Error("claude-sealed-env-tmpdir");
  for (const [key, value] of CLAUDE_FIXED_ENV_SWITCHES)
    if (seen.get(key) !== value)
      throw new Error(`claude-sealed-env-switch:${key}`);
  return env;
}
