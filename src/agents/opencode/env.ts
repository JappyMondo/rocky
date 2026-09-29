import type { SealedEnv } from "../seam.js";

/**
 * Sealed positive-allowlist child environment (#104 research F6/F8/F14, PART 4 §1). Nothing is
 * inherited: the child env is EXACTLY the ordered allowlist built here. Any auth-bearing,
 * billing-switching, catalog-swapping, config-injecting or proxy key present in the SOURCE
 * environment refuses the launch pre-spawn (names only; values are never logged, retained or
 * compared), because opencode silently autoloads providers from env keys and OPENCODE_AUTH_CONTENT
 * would replace the whole auth store with Rocky-held bytes (rejected class, mirrors #94 F3).
 *
 * The OPENCODE_* keys the adapter itself pins (config content, DB, catalog path, disable flags)
 * are set by the adapter into the sealed list and are never inherited from the source env; the
 * sealed-list audit below rejects any OPENCODE_* key outside that pinned set.
 */
export const OPENCODE_FORBIDDEN_ENV_EXPLICIT: ReadonlySet<string> = new Set([
  // Direct credential / auth-store vectors (F5/F6).
  "ALIBABA_TOKEN_PLAN_API_KEY",
  "OPENCODE_AUTH_CONTENT",
  "OPENCODE_SERVER_PASSWORD",
  "OPENCODE_SERVER_USERNAME",
  // Catalog swap ⇒ different api base + npm loader (F6).
  "OPENCODE_MODELS_URL",
  // Config injection vectors that bypass the sealed content (F6/F13).
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_DIR",
  // TLS / proxy redirection (F6).
  "NODE_EXTRA_CA_CERTS",
  "SSH_AUTH_SOCK",
]);
export const OPENCODE_FORBIDDEN_ENV_FAMILIES: readonly RegExp[] = [
  /^OPENAI_/,
  /^ANTHROPIC_/,
  /^AWS_/,
  /^GOOGLE_/,
  /^AZURE_/,
  /^DEEPSEEK_/,
  /^GEMINI_/,
  /^MISTRAL_/,
  /^COHERE_/,
  /^GROQ_/,
  /^XAI_/,
  /^OTEL_/,
  /^OPENCODE_/,
  /^XDG_/,
  /_API_KEY$/,
  /_PROXY$/,
  /^NO_PROXY$/,
  /^ALL_PROXY$/,
];
/** The OPENCODE_* keys the adapter itself pins into the sealed env (F14 isolation recipe), plus
 * the four XDG dirs it binds explicitly. These are forbidden in the SOURCE env like everything
 * else, but required (and exact-value audited) in the sealed list. */
export const OPENCODE_ADAPTER_SET_KEYS: ReadonlySet<string> = new Set([
  "OPENCODE_CONFIG_CONTENT",
  "OPENCODE_DB",
  "OPENCODE_MODELS_PATH",
  "OPENCODE_DISABLE_PROJECT_CONFIG",
  "OPENCODE_DISABLE_MODELS_FETCH",
  "OPENCODE_DISABLE_AUTOUPDATE",
  "OPENCODE_DISABLE_DEFAULT_PLUGINS",
  "OPENCODE_DISABLE_CLAUDE_CODE",
  "OPENCODE_DISABLE_EXTERNAL_SKILLS",
  "OPENCODE_DISABLE_PRUNE",
  "OPENCODE_PURE",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
]);
function forbiddenFamily(key: string): boolean {
  return OPENCODE_FORBIDDEN_ENV_FAMILIES.some((pattern) => pattern.test(key));
}
/** Key names only; values are never logged, retained or compared. Source-env admissibility: ANY
 * OPENCODE/XDG override, provider key family, proxy or TLS vector present refuses pre-spawn. */
export function isForbiddenOpencodeSourceEnvKey(key: string): boolean {
  return OPENCODE_FORBIDDEN_ENV_EXPLICIT.has(key) || forbiddenFamily(key);
}
export function findForbiddenOpencodeEnvKeys(
  env: Record<string, string | undefined>,
): string[] {
  return Object.keys(env)
    .filter(
      (key) => env[key] !== undefined && isForbiddenOpencodeSourceEnvKey(key),
    )
    .sort();
}
/** Fail pre-spawn when the source environment carries any forbidden key (poisoned-env rule). */
export function assertOpencodeSourceEnvAdmissible(
  env: Record<string, string | undefined>,
) {
  const forbidden = findForbiddenOpencodeEnvKeys(env);
  if (forbidden.length)
    throw new Error(`opencode-forbidden-env-present:${forbidden.join(",")}`);
}
export interface OpencodeSealedEnvValues {
  home: string;
  tmpdir: string;
  pwd: string;
  configHome: string;
  dataHome: string;
  cacheHome: string;
  stateHome: string;
  db: string;
  modelsPath: string;
  configContent: string;
}
/** The complete child environment: a fresh private parent HOME/TMPDIR, the Rocky-owned XDG dirs,
 * the isolated per-action DB, the pinned catalog, the sealed config content and the F14 disable
 * set, plus minimal PATH/LANG/PWD. Exact immutable bytes; nothing inherited. */
export function buildOpencodeSealedEnv(v: OpencodeSealedEnvValues): SealedEnv {
  const entries: (readonly [string, string])[] = [
    ["HOME", v.home],
    ["TMPDIR", v.tmpdir],
    ["PWD", v.pwd],
    ["PATH", "/usr/bin:/bin:/usr/sbin:/sbin"],
    ["LANG", "en_US.UTF-8"],
    ["XDG_CONFIG_HOME", v.configHome],
    ["XDG_DATA_HOME", v.dataHome],
    ["XDG_CACHE_HOME", v.cacheHome],
    ["XDG_STATE_HOME", v.stateHome],
    ["OPENCODE_DB", v.db],
    ["OPENCODE_MODELS_PATH", v.modelsPath],
    ["OPENCODE_CONFIG_CONTENT", v.configContent],
    ["OPENCODE_DISABLE_PROJECT_CONFIG", "1"],
    ["OPENCODE_DISABLE_MODELS_FETCH", "1"],
    ["OPENCODE_DISABLE_AUTOUPDATE", "1"],
    ["OPENCODE_DISABLE_DEFAULT_PLUGINS", "1"],
    ["OPENCODE_DISABLE_CLAUDE_CODE", "1"],
    ["OPENCODE_DISABLE_EXTERNAL_SKILLS", "1"],
    ["OPENCODE_DISABLE_PRUNE", "1"],
    ["OPENCODE_PURE", "1"],
  ];
  return assertOpencodeSealedEnv(entries, v);
}
/** Defense-in-depth audit of the sealed list itself: pinned bindings exact, no duplicate keys, no
 * forbidden key, and no OPENCODE_* key outside the adapter-pinned set. The list IS the complete
 * child environment. */
export function assertOpencodeSealedEnv(
  env: SealedEnv,
  v: OpencodeSealedEnvValues,
): SealedEnv {
  const seen = new Map<string, string>();
  for (const [key, value] of env) {
    if (seen.has(key)) throw new Error("opencode-sealed-env-duplicate");
    if (
      (key.startsWith("OPENCODE_") || key.startsWith("XDG_")) &&
      !OPENCODE_ADAPTER_SET_KEYS.has(key)
    )
      throw new Error(`opencode-sealed-env-forbidden:${key}`);
    if (
      !key.startsWith("OPENCODE_") &&
      !key.startsWith("XDG_") &&
      isForbiddenOpencodeSourceEnvKey(key)
    )
      throw new Error(`opencode-sealed-env-forbidden:${key}`);
    seen.set(key, value);
  }
  const exact: [string, string][] = [
    ["HOME", v.home],
    ["TMPDIR", v.tmpdir],
    ["PWD", v.pwd],
    ["XDG_CONFIG_HOME", v.configHome],
    ["XDG_DATA_HOME", v.dataHome],
    ["XDG_CACHE_HOME", v.cacheHome],
    ["XDG_STATE_HOME", v.stateHome],
    ["OPENCODE_DB", v.db],
    ["OPENCODE_MODELS_PATH", v.modelsPath],
    ["OPENCODE_CONFIG_CONTENT", v.configContent],
    ["PATH", "/usr/bin:/bin:/usr/sbin:/sbin"],
    ["LANG", "en_US.UTF-8"],
  ];
  for (const [key, value] of exact)
    if (seen.get(key) !== value) throw new Error(`opencode-sealed-env:${key}`);
  for (const key of OPENCODE_ADAPTER_SET_KEYS)
    if (key.startsWith("OPENCODE_DISABLE") || key === "OPENCODE_PURE")
      if (seen.get(key) !== "1") throw new Error(`opencode-sealed-env:${key}`);
  return env;
}
