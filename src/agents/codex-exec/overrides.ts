import { canonical, type Json } from "../../store/json.js";
import { CODEX_NEVER_PASS, type CodexRole } from "./argv.js";

/**
 * Audited `-c` TOML override production for the pinned candidate (S01/S07; acceptance/subscription
 * manifest launch.configOverrides + launch.forbiddenLaunchInputs, source #92/857 F1–F3/F7 and
 * #92/858 §B/§2). Each `-c` is exactly one argv element `key=value` where the key is a single
 * dot-free top-level identifier and the value is a canonical TOML inline serialization.
 *
 * The F1 hazard is real: codex splits the key on EVERY '.' with no quoting and a value that fails
 * TOML parsing SILENTLY degrades to a raw string. The producer therefore round-trips every value
 * through a real (owned) TOML value parser and requires structural equality BEFORE admission, so a
 * value that would degrade is rejected pre-spawn. Path-keyed maps (projects, permissions
 * filesystem) are only admissible as inline-table VALUES under dot-free top-level keys.
 *
 * The owned TOML value grammar below is deliberately conservative (basic strings, decimal integers,
 * booleans, inline tables and arrays). Round-trip success implies codex's real TOML parser reads the
 * same structure; round-trip failure implies degradation and is rejected. Exact native parser
 * correspondence beyond this grammar is a synthetic-native gate (N01), never assumed here.
 */

/** Allowed top-level `-c` keys (source #92/858 §B list B). Any other key is rejected. */
export const CODEX_OVERRIDE_ALLOW_KEYS: ReadonlySet<string> = new Set([
  "model_reasoning_effort",
  "model_provider",
  "web_search",
  "project_doc_max_bytes",
  "projects",
  "allow_login_shell",
  "suppress_unstable_features_warning",
  "cli_auth_credentials_store",
  "sqlite_home",
  "log_dir",
  "history",
  "analytics",
  "default_permissions",
  "permissions",
  "shell_environment_policy",
  "features",
  "skills",
  "tools",
]);
/** Prohibited keys (source #92/858 §B "Prohibited keys"). Rejected even if somehow allowlisted. */
export const CODEX_OVERRIDE_FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  "forced_login_method",
  "forced_chatgpt_workspace_id",
  "chatgpt_base_url",
  "openai_base_url",
  "model_providers",
  "mcp_servers",
  "plugins",
  "marketplaces",
  "hooks",
  "profile",
  "profiles",
  "sandbox_mode",
  "sandbox_workspace_write",
  "approvals_reviewer",
  "auto_review",
  "otel",
  "agents",
]);
/** Canonical `features` keys (source #92/858 §B item 16). No legacy aliases, no Removed keys,
 * no web_search_request/_cached. Any other feature key is rejected (F3/F11). */
export const CODEX_FEATURE_KEYS: ReadonlySet<string> = new Set([
  "apps",
  "plugins",
  "hooks",
  "multi_agent",
  "memories",
  "goals",
  "image_generation",
  "view_image",
  "tool_suggest",
  "skill_search",
  "skill_mcp_dependency_install",
  "shell_snapshot",
  "browser_use",
  "computer_use",
  "in_app_browser",
  "unbounded_connection_retries",
  "skip_host_skill_discovery",
  "secret_auth_storage",
]);
export type TomlValue =
  | string
  | number
  | boolean
  | readonly TomlValue[]
  | { readonly [key: string]: TomlValue };

/** Absolute, realpath-canonical, NFC path with no NUL/control, glob metachars, ',', '~' or a
 * leading ':' (the only ':' key permitted is the literal ":minimal" permission alias). */
export function assertCodexOverridePath(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.startsWith("/"))
    throw new Error(`codex-path-not-absolute:${name}`);
  if (
    value.includes("\0") ||
    value.includes(",") ||
    value.includes("~") ||
    /[*?[\]{}]/.test(value) ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    value.startsWith(":") ||
    value.normalize("NFC") !== value ||
    value.endsWith("/")
  )
    throw new Error(`codex-path-invalid:${name}`);
  return value;
}
/** A dot-free top-level identifier key on the allowlist and not prohibited. */
export function assertCodexOverrideKey(key: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
    throw new Error(`codex-override-key-not-dot-free:${key}`);
  if (CODEX_OVERRIDE_FORBIDDEN_KEYS.has(key))
    throw new Error(`codex-override-forbidden-key:${key}`);
  if (!CODEX_OVERRIDE_ALLOW_KEYS.has(key))
    throw new Error(`codex-override-unknown-key:${key}`);
  return key;
}
/** Deterministic TOML inline serialization: basic strings with escapes, decimal integers,
 * booleans, inline tables (keys always quoted, sorted) and arrays. */
export function renderTomlValue(value: TomlValue): string {
  if (typeof value === "string") return renderTomlString(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value))
      throw new Error("codex-toml-number-not-integer");
    return String(value);
  }
  if (Array.isArray(value))
    return `[${value.map((item) => renderTomlValue(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.keys(value)
      .sort()
      .map((key) => {
        const child = (value as Record<string, TomlValue>)[key];
        if (child === undefined) throw new Error("codex-toml-undefined-value");
        return `${renderTomlString(key)}=${renderTomlValue(child)}`;
      });
    return `{${entries.join(",")}}`;
  }
  throw new Error("codex-toml-unsupported-value");
}
function renderTomlString(text: string): string {
  let out = '"';
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (code < 0x20 || code === 0x7f) {
      if (ch === "\b") out += "\\b";
      else if (ch === "\t") out += "\\t";
      else if (ch === "\n") out += "\\n";
      else if (ch === "\f") out += "\\f";
      else if (ch === "\r") out += "\\r";
      else out += `\\u${code.toString(16).padStart(4, "0").toUpperCase()}`;
    } else out += ch;
  }
  return `${out}"`;
}
/** A real (owned) TOML value parser for the conservative grammar the renderer emits. It rejects
 * anything outside that grammar, so a successful round-trip proves the value is a valid TOML value
 * that codex's parser reads as the same structure rather than degrading to a raw string (F1). */
export function parseTomlValue(text: string): TomlValue {
  let at = 0;
  const skipWs = () => {
    while (at < text.length && /[ \t]/.test(text[at]!)) at++;
  };
  const parseValue = (): TomlValue => {
    skipWs();
    const ch = text[at];
    if (ch === undefined) throw new Error("codex-toml-unexpected-end");
    if (ch === '"') return parseString();
    if (ch === "{") return parseInlineTable();
    if (ch === "[") return parseArray();
    if (text.startsWith("true", at)) {
      at += 4;
      return true;
    }
    if (text.startsWith("false", at)) {
      at += 5;
      return false;
    }
    const m = /^-?(?:0|[1-9][0-9]*)/.exec(text.slice(at));
    if (m) {
      at += m[0].length;
      const n = Number(m[0]);
      if (!Number.isSafeInteger(n)) throw new Error("codex-toml-number-range");
      return n;
    }
    throw new Error("codex-toml-malformed-value");
  };
  const parseString = (): string => {
    if (text[at] !== '"') throw new Error("codex-toml-string-quote");
    at++;
    let out = "";
    for (;;) {
      const ch = text[at];
      if (ch === undefined) throw new Error("codex-toml-string-unterminated");
      if (ch === '"') {
        at++;
        return out;
      }
      if (ch === "\\") {
        at++;
        const esc = text[at];
        at++;
        switch (esc) {
          case '"':
            out += '"';
            break;
          case "\\":
            out += "\\";
            break;
          case "b":
            out += "\b";
            break;
          case "t":
            out += "\t";
            break;
          case "n":
            out += "\n";
            break;
          case "f":
            out += "\f";
            break;
          case "r":
            out += "\r";
            break;
          case "u":
            out += parseHexEscape(4);
            break;
          case "U":
            out += parseHexEscape(8);
            break;
          default:
            throw new Error("codex-toml-bad-escape");
        }
        continue;
      }
      const code = ch.codePointAt(0)!;
      if (code < 0x20 || code === 0x7f)
        throw new Error("codex-toml-control-in-string");
      out += ch;
      at++;
    }
  };
  const parseHexEscape = (digits: number): string => {
    const hex = text.slice(at, at + digits);
    if (!new RegExp(`^[0-9a-fA-F]{${digits}}$`).test(hex))
      throw new Error("codex-toml-bad-escape");
    at += digits;
    const cp = Number.parseInt(hex, 16);
    if (!Number.isFinite(cp)) throw new Error("codex-toml-bad-escape");
    return String.fromCodePoint(cp);
  };
  const parseKey = (): string => {
    skipWs();
    if (text[at] === '"') return parseString();
    const m = /^[A-Za-z0-9_-]+/.exec(text.slice(at));
    if (!m) throw new Error("codex-toml-bad-key");
    at += m[0].length;
    return m[0];
  };
  const parseInlineTable = (): { [key: string]: TomlValue } => {
    if (text[at] !== "{") throw new Error("codex-toml-table-open");
    at++;
    const out: { [key: string]: TomlValue } = {};
    skipWs();
    if (text[at] === "}") {
      at++;
      return out;
    }
    for (;;) {
      const key = parseKey();
      if (Object.hasOwn(out, key)) throw new Error("codex-toml-duplicate-key");
      skipWs();
      if (text[at] !== "=") throw new Error("codex-toml-expected-eq");
      at++;
      out[key] = parseValue();
      skipWs();
      if (text[at] === ",") {
        at++;
        skipWs();
        continue;
      }
      if (text[at] === "}") {
        at++;
        return out;
      }
      throw new Error("codex-toml-table-separator");
    }
  };
  const parseArray = (): TomlValue[] => {
    if (text[at] !== "[") throw new Error("codex-toml-array-open");
    at++;
    const out: TomlValue[] = [];
    skipWs();
    if (text[at] === "]") {
      at++;
      return out;
    }
    for (;;) {
      out.push(parseValue());
      skipWs();
      if (text[at] === ",") {
        at++;
        skipWs();
        if (text[at] === "]") {
          at++;
          return out;
        }
        continue;
      }
      if (text[at] === "]") {
        at++;
        return out;
      }
      throw new Error("codex-toml-array-separator");
    }
  };
  const value = parseValue();
  skipWs();
  if (at !== text.length) throw new Error("codex-toml-trailing");
  return value;
}
/** F1 defense: render then re-parse with the owned TOML parser and require structural equality.
 * A value that would silently degrade to a raw string fails the round-trip and is rejected. */
export function tomlRoundTrip(key: string, value: TomlValue): string {
  const rendered = renderTomlValue(value);
  let parsed: TomlValue;
  try {
    parsed = parseTomlValue(rendered);
  } catch {
    throw new Error(`codex-override-no-toml-roundtrip:${key}`);
  }
  if (canonical(parsed as Json) !== canonical(value as Json))
    throw new Error(`codex-override-toml-inequality:${key}`);
  return rendered;
}
/** Serialize one audited override into its single `key=value` argv element with round-trip proof. */
export function serializeCodexOverride(
  key: string,
  value: TomlValue,
  limits: { maxOverrideValueBytes: number },
): string {
  assertCodexOverrideKey(key);
  const rendered = tomlRoundTrip(key, value);
  if (Buffer.byteLength(rendered) > limits.maxOverrideValueBytes)
    throw new Error(`codex-override-value-bytes:${key}`);
  const assignment = `${key}=${rendered}`;
  if (assignment.includes("\n") || assignment.includes("\0"))
    throw new Error(`codex-override-control:${key}`);
  return assignment;
}
/** Audit a full ordered override set: key allowlist, no never-pass flag smuggled as a key, the
 * sandbox_mode+default_permissions combination ban (F7) and per-value round-trip. */
export function buildCodexOverrideAssignments(
  overrides: readonly { key: string; value: TomlValue }[],
  limits: { maxOverrideValueBytes: number; maxOverrides: number },
): string[] {
  if (overrides.length > limits.maxOverrides)
    throw new Error("codex-override-count");
  const assignments: string[] = [];
  let sawDefaultPermissions = false;
  const seen = new Set<string>();
  for (const override of overrides) {
    if (seen.has(override.key))
      throw new Error(`codex-override-duplicate:${override.key}`);
    seen.add(override.key);
    if (CODEX_NEVER_PASS.has(override.key))
      throw new Error(`codex-override-forbidden-key:${override.key}`);
    if (override.key === "default_permissions") sawDefaultPermissions = true;
    if (override.key === "permissions") assertPermissionShape(override.value);
    if (override.key === "features") assertFeatureShape(override.value);
    assignments.push(
      serializeCodexOverride(override.key, override.value, limits),
    );
  }
  // F7 is enforced at the argv layer too; the producer never emits sandbox_mode (prohibited key),
  // so a named-permission profile is always selected without a legacy sandbox switch.
  void sawDefaultPermissions;
  return assignments;
}
function assertPermissionShape(value: TomlValue) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("codex-permissions-shape");
  const profiles = value as Record<string, TomlValue>;
  const names = Object.keys(profiles);
  if (names.length !== 1) throw new Error("codex-permissions-single-profile");
  const profile = profiles[names[0]!];
  if (!profile || typeof profile !== "object" || Array.isArray(profile))
    throw new Error("codex-permissions-shape");
  const p = profile as Record<string, TomlValue>;
  const network = p.network as Record<string, TomlValue> | undefined;
  if (!network || network.enabled !== false)
    throw new Error("codex-permissions-network-enabled");
  if (!p.filesystem || typeof p.filesystem !== "object")
    throw new Error("codex-permissions-filesystem");
}
function assertFeatureShape(value: TomlValue) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("codex-features-shape");
  for (const key of Object.keys(value as Record<string, TomlValue>))
    if (!CODEX_FEATURE_KEYS.has(key))
      throw new Error(`codex-features-unknown-key:${key}`);
}

/** Fixed `features` map (source #92/858 §B item 16): canonical keys only, every unapproved route
 * disabled, host skill discovery skipped. `secret_auth_storage` mirrors the host's real setting. */
export function renderCodexFeatures(secretAuthStorage: boolean): TomlValue {
  return {
    apps: false,
    plugins: false,
    hooks: false,
    multi_agent: false,
    memories: false,
    goals: false,
    image_generation: false,
    view_image: false,
    tool_suggest: false,
    skill_search: false,
    skill_mcp_dependency_install: false,
    shell_snapshot: false,
    browser_use: false,
    computer_use: false,
    in_app_browser: false,
    unbounded_connection_retries: false,
    skip_host_skill_discovery: true,
    secret_auth_storage: secretAuthStorage,
  };
}
export interface CodexOverrideSetInput {
  effort: string;
  credentialsStore: "file" | "keyring" | "auto";
  secretAuthStorage: boolean;
  permissionProfileName: string;
  /** The complete `{<profile>: {filesystem, network}}` map from renderCodexPermissionProfile. */
  permissionsValue: TomlValue;
  /** The `{<src>: {trust_level:"untrusted"}}` map from trust.codexUntrustedProjectsOverride. */
  projectsValue: TomlValue;
  sqliteHome: string;
  logDir: string;
  shellHome: string;
  shellTmp: string;
}
/** The ordered, deterministic minimal source-valid override set (source #92/858 §B). Deliberately
 * excludes every key whose effect was not traced (guardian_approval, code_mode_host, model_providers,
 * approval_policy, notify, mcp_servers, project_root_markers, ...); those are gates, not guesses. */
export function renderCodexOverrideSet(
  input: CodexOverrideSetInput,
): { key: string; value: TomlValue }[] {
  return [
    { key: "model_reasoning_effort", value: input.effort },
    { key: "model_provider", value: "openai" },
    { key: "web_search", value: "disabled" },
    { key: "project_doc_max_bytes", value: 0 },
    { key: "projects", value: input.projectsValue },
    { key: "allow_login_shell", value: false },
    { key: "suppress_unstable_features_warning", value: true },
    { key: "cli_auth_credentials_store", value: input.credentialsStore },
    { key: "sqlite_home", value: input.sqliteHome },
    { key: "log_dir", value: input.logDir },
    { key: "history", value: { persistence: "none" } },
    { key: "analytics", value: { enabled: false } },
    { key: "default_permissions", value: input.permissionProfileName },
    { key: "permissions", value: input.permissionsValue },
    {
      key: "shell_environment_policy",
      value: {
        inherit: "none",
        set: {
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          HOME: input.shellHome,
          TMPDIR: input.shellTmp,
          LANG: "en_US.UTF-8",
        },
      },
    },
    { key: "features", value: renderCodexFeatures(input.secretAuthStorage) },
    {
      key: "skills",
      value: { bundled: { enabled: false }, include_instructions: false },
    },
    {
      key: "tools",
      value: { experimental_request_user_input: { enabled: false } },
    },
  ];
}
export interface CodexPermissionInput {
  role: CodexRole;
  profileName: string;
  src: string;
  scratch: string;
  parentRoot: string;
  native: string;
  inputs: string;
  /** Names-only listing of the shared CODEX_HOME children (never contents); from discovery. */
  codexHomeChildren: readonly string[];
  codexHome: string;
  denyRoots: readonly string[];
  platformDenyRoots: readonly string[];
  maxDenyEntries: number;
}
/** Render the named-permission profile filesystem/network map (§D). Grants are exact paths (no
 * globs, which compile into platform warnings that surface as error items). ":minimal" is read;
 * scratch is write; SRC is write for implementer / read for reviewer; everything protected is
 * denied by exact path. The shared CODEX_HOME/tmp helper root is NEVER denied (F12). */
export function renderCodexPermissionProfile(
  input: CodexPermissionInput,
): TomlValue {
  for (const [name, path] of [
    ["src", input.src],
    ["scratch", input.scratch],
    ["parentRoot", input.parentRoot],
    ["native", input.native],
    ["inputs", input.inputs],
    ["codexHome", input.codexHome],
  ] as const)
    assertCodexOverridePath(path, name);
  const filesystem: Record<string, TomlValue> = {
    ":minimal": "read",
    [input.scratch]: "write",
    [input.src]: input.role === "implementer" ? "write" : "read",
  };
  const deny = new Set<string>();
  for (const path of [input.parentRoot, input.native, input.inputs])
    deny.add(path);
  // Deny every existing shared-home child EXCEPT tmp (the arg0 helper root must stay reachable).
  for (const name of input.codexHomeChildren) {
    if (name === "tmp") continue;
    deny.add(`${input.codexHome}/${name}`);
  }
  // Fixed future shared-home names that must never become tool-readable/writable.
  for (const name of [
    "auth.json",
    ".credentials.json",
    "config.toml",
    "sessions",
    "log",
    "memories",
    "skills",
    "AGENTS.md",
    "AGENTS.override.md",
  ])
    deny.add(`${input.codexHome}/${name}`);
  for (const root of input.denyRoots)
    deny.add(assertCodexOverridePath(root, "denyRoot"));
  for (const root of input.platformDenyRoots)
    deny.add(assertCodexOverridePath(root, "platformDenyRoot"));
  // Never deny the shared-home tmp helper parent chain (F12 historical lesson).
  deny.delete(`${input.codexHome}/tmp`);
  if (deny.size > input.maxDenyEntries)
    throw new Error("codex-deny-entries-limit");
  for (const path of deny) {
    if (path === input.src || path === input.scratch)
      throw new Error("codex-deny-overlaps-grant");
    filesystem[path] = "deny";
  }
  return {
    [input.profileName]: {
      filesystem,
      network: { enabled: false },
    },
  };
}
