import type { SealedEnv } from "../seam.js";

/**
 * Sealed positive-allowlist child environment (S01/S07; acceptance/subscription manifest
 * launch.environment + launch.forbiddenLaunchInputs auth env keys, source #92/857 F8 and
 * #92/858 §C). Nothing is inherited: the child env is EXACTLY the ordered allowlist below.
 *
 * load_auth honours CODEX_API_KEY / OPENAI_API_KEY / CODEX_ACCESS_TOKEN and URL/client-id override
 * env, and in-process exec enables CODEX_API_KEY, so any auth-bearing key present in the source
 * environment fails the launch pre-spawn (names only; values are never logged, retained or
 * compared) and is regression-asserted always-absent. CODEX_HOME is the ONE permitted CODEX_* key:
 * it names the designated shared auth store (a path, never a credential) and is set by the adapter,
 * never inherited from the source environment.
 */
export const CODEX_FORBIDDEN_ENV_EXPLICIT: ReadonlySet<string> = new Set([
  "CODEX_API_KEY",
  "OPENAI_API_KEY",
  "CODEX_ACCESS_TOKEN",
  "CODEX_REFRESH_TOKEN_URL_OVERRIDE",
  "CODEX_REVOKE_TOKEN_URL_OVERRIDE",
  "CODEX_APP_SERVER_LOGIN_CLIENT_ID",
  "CODEX_APP_SERVER_CHATGPT_BASE_URL",
  "OPENAI_FEDERATION_RULE_ID",
  "OPENAI_IDENTITY_TOKEN_FILE",
  "OPENAI_WORKLOAD_IDENTITY_CONTEXT",
  "CODEX_SQLITE_HOME",
  "CODEX_SANDBOX",
  "CODEX_CA_CERTIFICATE",
  "RUST_LOG",
  "TRACEPARENT",
  "SSH_AUTH_SOCK",
]);
export const CODEX_FORBIDDEN_ENV_FAMILIES: readonly RegExp[] = [
  /^OPENAI_/,
  /^CODEX_(?!HOME$)/,
  /_PROXY$/,
  /^NO_PROXY$/,
  /^SSL_/,
  /^GIT_/,
  /^GH_/,
  /^GITHUB_/,
  /^AWS_/,
  /^GOOGLE_/,
  /^AZURE_/,
  /^OTEL_/,
  /^MCP_/,
];
/** Key names only; values are never logged, retained or compared. CODEX_HOME is permitted. */
export function isForbiddenCodexEnvKey(key: string): boolean {
  if (key === "CODEX_HOME") return false;
  return (
    CODEX_FORBIDDEN_ENV_EXPLICIT.has(key) ||
    CODEX_FORBIDDEN_ENV_FAMILIES.some((pattern) => pattern.test(key))
  );
}
export function findForbiddenCodexEnvKeys(
  env: Record<string, string | undefined>,
): string[] {
  return Object.keys(env)
    .filter((key) => env[key] !== undefined && isForbiddenCodexEnvKey(key))
    .sort();
}
/** Fail pre-spawn when the source environment carries any forbidden key (poisoned-env rule). */
export function assertCodexSourceEnvAdmissible(
  env: Record<string, string | undefined>,
) {
  const forbidden = findForbiddenCodexEnvKeys(env);
  if (forbidden.length)
    throw new Error(`codex-forbidden-env-present:${forbidden.join(",")}`);
}
export interface CodexSealedEnvPaths {
  parentHome: string;
  codexHome: string;
  parentTmp: string;
}
/** The complete child environment: a fresh private parent HOME, the designated shared CODEX_HOME,
 * a private parent TMPDIR, minimal PATH/LANG, plus probe-gated conditionals. */
export function buildCodexSealedEnv(
  paths: CodexSealedEnvPaths,
  options: { shell: boolean; user: boolean; userName: string },
): SealedEnv {
  const entries: (readonly [string, string])[] = [
    ["HOME", paths.parentHome],
    ["CODEX_HOME", paths.codexHome],
    ["TMPDIR", paths.parentTmp],
    ["PATH", "/usr/bin:/bin:/usr/sbin:/sbin"],
    ["LANG", "en_US.UTF-8"],
  ];
  if (options.shell) entries.push(["SHELL", "/bin/zsh"]);
  if (options.user) {
    entries.push(["USER", options.userName]);
    entries.push(["LOGNAME", options.userName]);
  }
  assertCodexSealedEnv(entries, paths);
  return entries;
}
/** Defense-in-depth audit of the sealed list itself: the shared CODEX_HOME and private HOME/TMPDIR
 * are bound exactly, no forbidden key may appear, and the list is the complete child environment. */
export function assertCodexSealedEnv(
  env: SealedEnv,
  paths: CodexSealedEnvPaths,
) {
  const seen = new Map<string, string>();
  for (const [key, value] of env) {
    if (seen.has(key)) throw new Error("codex-sealed-env-duplicate");
    if (isForbiddenCodexEnvKey(key))
      throw new Error(`codex-sealed-env-forbidden:${key}`);
    seen.set(key, value);
  }
  if (seen.get("HOME") !== paths.parentHome)
    throw new Error("codex-sealed-env-home");
  if (seen.get("CODEX_HOME") !== paths.codexHome)
    throw new Error("codex-sealed-env-codex-home");
  if (seen.get("TMPDIR") !== paths.parentTmp)
    throw new Error("codex-sealed-env-tmpdir");
  if (seen.get("PATH") !== "/usr/bin:/bin:/usr/sbin:/sbin")
    throw new Error("codex-sealed-env-path");
  if (seen.get("LANG") !== "en_US.UTF-8")
    throw new Error("codex-sealed-env-lang");
  return env;
}
