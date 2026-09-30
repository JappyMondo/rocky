import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { digest, identity, type Json } from "../../store/json.js";
import { parseStrictJson } from "../seam.js";
import {
  OPENCODE_PINNED_MODEL,
  OPENCODE_PINNED_PROVIDER,
  opencodeAgentName,
  type OpencodeRole,
  type ValidatedOpencodeConfig,
} from "./config.js";

/**
 * Launch composition (#104 research F9/F10/F13/F14, PART 4 §1): the exact pinned argv, the sealed
 * OPENCODE_CONFIG_CONTENT rendering, the per-action RUN tree and the isolation inventory/admission.
 *
 * Argv (F9): `run --format=json --model=<pinned> --agent=<role agent> --dir=<SRC>`. The prompt is
 * NEVER a positional argv element (F10: stdin read-to-EOF is the only delivery). There are no flags
 * for tools/system-prompt/MCP/max-turns — all behavior is config/agent-level, so the sealed config
 * content is the ONLY behavior surface and is audited here.
 */

/** Never-pass flags (PART 4 §1): approval bypasses, session continuity, share/attach, remote
 * server, interactive/hidden modes, alternate input routes and stderr-noise/debug channels. */
export const OPENCODE_NEVER_PASS: ReadonlySet<string> = new Set([
  "--auto",
  "--yolo",
  "--dangerously-skip-permissions",
  "--continue",
  "-c",
  "--session",
  "-s",
  "--fork",
  "--share",
  "--attach",
  "--password",
  "-p",
  "--username",
  "-u",
  "--port",
  "--interactive",
  "-i",
  "--mini",
  "--demo",
  "--command",
  "--file",
  "-f",
  "--variant",
  "--thinking",
  "--print-logs",
  "--log-level",
  "--pure",
  "--title",
]);
export interface OpencodeArgvInput {
  role: OpencodeRole;
  model: string;
  dir: string;
  maxArgvBytes: number;
}
/** Compose the exact argv: every option a single `--flag=value` element, no positionals. */
export function buildOpencodeArgv(input: OpencodeArgvInput): string[] {
  const argv = [
    "run",
    "--format=json",
    `--model=${input.model}`,
    `--agent=${opencodeAgentName(input.role)}`,
    `--dir=${input.dir}`,
  ];
  assertOpencodeArgv(argv, input);
  return argv;
}
/** Independent re-audit of a composed argv: exact 5-element shape, pinned model, role agent name,
 * absolute --dir, never-pass rejection and a byte bound. Re-run by the producer so a hand-tampered
 * argv cannot be admitted. */
export function assertOpencodeArgv(
  argv: readonly string[],
  input: OpencodeArgvInput,
) {
  if (!Array.isArray(argv) || argv.length !== 5)
    throw new Error("opencode-argv-shape");
  let bytes = 0;
  for (const element of argv) {
    if (typeof element !== "string" || !element || element.includes("\0"))
      throw new Error("opencode-argv-element");
    if (/[\u0000-\u001f\u007f]/.test(element))
      throw new Error("opencode-argv-control");
    bytes += Buffer.byteLength(element) + 1;
  }
  if (bytes > input.maxArgvBytes) throw new Error("opencode-argv-bytes");
  for (const element of argv) {
    const name = element.split("=", 1)[0]!;
    if (OPENCODE_NEVER_PASS.has(name) || OPENCODE_NEVER_PASS.has(element))
      throw new Error(`opencode-forbidden-flag:${name}`);
  }
  const expected = buildExpected(input);
  for (let i = 0; i < 5; i++)
    if (argv[i] !== expected[i])
      throw new Error(`opencode-argv-element-mismatch:${i}`);
  if (argv[2] !== `--model=${OPENCODE_PINNED_MODEL}`)
    throw new Error("opencode-model-off-table");
  if (!argv[4]!.startsWith("--dir=/")) throw new Error("opencode-argv-dir");
  return argv;
}
function buildExpected(input: OpencodeArgvInput): string[] {
  if (input.model !== OPENCODE_PINNED_MODEL)
    throw new Error("opencode-model-off-table");
  return [
    "run",
    "--format=json",
    `--model=${input.model}`,
    `--agent=${opencodeAgentName(input.role)}`,
    `--dir=${input.dir}`,
  ];
}

/**
 * Permission profiles (F17/F18). Evaluation is findLast over the flat merged list; a tool whose
 * permission matches a pattern:'*' deny is REMOVED from the model's roster entirely, so the
 * read-only reviewer is enforceable BY TOOL ABSENCE. Implementer: edit/bash/read allowed inside
 * the containment enforced by external_directory DENY (observable as tool errors, not silent);
 * task/webfetch/websearch/skill/question denied; subagent_depth 0 prevents all subagent launches.
 */
export const OPENCODE_IMPLEMENTER_PERMISSIONS = {
  // Native debug-agent exposed this registry tool by default. It is outside the
  // reviewed coding roster, so remove its availability explicitly.
  invalid: "deny",
  edit: { "*": "allow" },
  bash: { "*": "allow" },
  read: { "*": "allow" },
  task: "deny",
  webfetch: "deny",
  websearch: "deny",
  skill: "deny",
  question: "deny",
  external_directory: { "*": "deny" },
} as const;
export const OPENCODE_REVIEWER_PERMISSIONS = {
  "*": "deny",
  read: "allow",
  glob: "allow",
  grep: "allow",
  list: "allow",
} as const;
/** Prohibited keys in the sealed config content (PART 4 §1): MCP servers, plugins, instruction
 * fetches, provider credential/baseURL overrides, share/autoupdate/snapshot/subagent escapes and
 * default-agent redirection. The sealed content is Rocky-rendered, so presence of any of these is
 * a rendering/audit bug or tampering and refuses. */
export const OPENCODE_CONFIG_FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  "mcp",
  "plugin",
  "instructions",
  "provider",
  "default_agent",
  "tools",
  "formatter",
  "lsp",
  "skills",
  "experimental",
  "hooks",
]);
export interface OpencodeConfigContentInput {
  role: OpencodeRole;
  model: string;
  steps: number;
  prompt: string;
}
/** Render BOTH role agents into the sealed config content (the run selects one via --agent, but
 * the roster/permission table is audited as a whole). Canonical JSON: exact bytes, no duplicate
 * keys, no {env:...}/{file:...} substitution substrings anywhere. */
export function renderOpencodeConfigContent(
  roles: Record<OpencodeRole, OpencodeConfigContentInput>,
): string {
  const agentEntry = (role: OpencodeRole) => ({
    model: roles[role].model,
    prompt: roles[role].prompt,
    steps: roles[role].steps,
    permission:
      role === "implementer"
        ? OPENCODE_IMPLEMENTER_PERMISSIONS
        : OPENCODE_REVIEWER_PERMISSIONS,
  });
  const content: Json = {
    $schema: "https://opencode.ai/config.json",
    enabled_providers: [OPENCODE_PINNED_PROVIDER],
    share: "disabled",
    autoupdate: false,
    snapshot: false,
    subagent_depth: 0,
    // small_model pinned to the same on-table model so title/summary side-calls cannot route to
    // another provider (F6/F26).
    small_model: OPENCODE_PINNED_MODEL,
    agent: {
      [opencodeAgentName("implementer")]: agentEntry("implementer"),
      [opencodeAgentName("reviewer")]: agentEntry("reviewer"),
    },
  };
  const rendered = JSON.stringify(content);
  assertOpencodeConfigContent(rendered, roles);
  return rendered;
}
/** Independent strict re-audit of sealed config content bytes: strict parse (duplicate-key
 * reject), required keys with exact pinned values, prohibited keys absent, role agents present
 * with on-table model/prompt/steps/permission, and no variable-substitution substrings. */
export function assertOpencodeConfigContent(
  rendered: string,
  roles: Record<OpencodeRole, OpencodeConfigContentInput>,
): Json {
  if (rendered.includes("{env:") || rendered.includes("{file:"))
    throw new Error("opencode-config-substitution");
  let parsed: unknown;
  try {
    parsed = parseStrictJson(rendered);
  } catch {
    throw new Error("opencode-config-malformed");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("opencode-config-malformed");
  const v = parsed as Record<string, unknown>;
  for (const key of Object.keys(v))
    if (OPENCODE_CONFIG_FORBIDDEN_KEYS.has(key))
      throw new Error(`opencode-config-forbidden-key:${key}`);
  const providers = v.enabled_providers;
  if (
    !Array.isArray(providers) ||
    providers.length !== 1 ||
    providers[0] !== OPENCODE_PINNED_PROVIDER
  )
    throw new Error("opencode-config-enabled-providers");
  if (v.share !== "disabled") throw new Error("opencode-config-share");
  if (v.autoupdate !== false) throw new Error("opencode-config-autoupdate");
  if (v.snapshot !== false) throw new Error("opencode-config-snapshot");
  if (v.subagent_depth !== 0) throw new Error("opencode-config-subagent-depth");
  if (v.small_model !== undefined && v.small_model !== OPENCODE_PINNED_MODEL)
    throw new Error("opencode-config-small-model");
  const agent = v.agent;
  if (!agent || typeof agent !== "object" || Array.isArray(agent))
    throw new Error("opencode-config-agent");
  const agents = agent as Record<string, unknown>;
  for (const role of ["implementer", "reviewer"] as const) {
    const name = opencodeAgentName(role);
    const entry = agents[name];
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new Error(`opencode-config-agent-missing:${name}`);
    const a = entry as Record<string, unknown>;
    for (const key of Object.keys(a))
      if (!["model", "prompt", "steps", "permission"].includes(key))
        throw new Error(`opencode-config-agent-forbidden-key:${name}.${key}`);
    if (a.model !== roles[role].model || a.model !== OPENCODE_PINNED_MODEL)
      throw new Error(`opencode-config-agent-model:${name}`);
    if (a.prompt !== roles[role].prompt)
      throw new Error(`opencode-config-agent-prompt:${name}`);
    if (a.steps !== roles[role].steps)
      throw new Error(`opencode-config-agent-steps:${name}`);
    const expectedPermission: Json =
      role === "implementer"
        ? (OPENCODE_IMPLEMENTER_PERMISSIONS as unknown as Json)
        : (OPENCODE_REVIEWER_PERMISSIONS as unknown as Json);
    if (identity(a.permission ?? null) !== identity(expectedPermission))
      throw new Error(`opencode-config-agent-permission:${name}`);
  }
  return parsed as Json;
}

/** Per-action RUN tree (mirrors the codex-exec layout, leaner). DATA is NOT inside RUN: the
 * Rocky-owned dedicated data dir comes from config (one-time user-assisted auth provisioning;
 * Rocky never reads/copies/proxies auth.json). CFG/CACHE/STATE are fresh per action; the session
 * DB is isolated per action even though the data dir is shared across the run (F8: OPENCODE_DB). */
export interface OpencodeRunPaths {
  runRoot: string;
  src: string;
  parentHome: string;
  parentTmp: string;
  logs: string;
  configHome: string;
  cacheHome: string;
  stateHome: string;
  db: string;
}
export function createOpencodeRunTree(runRoot: string): OpencodeRunPaths {
  const root = resolve(runRoot);
  if (!root.startsWith("/") || /[\u0000-\u001f\u007f]/.test(root))
    throw new Error("opencode-path-invalid:runRoot");
  const paths: OpencodeRunPaths = {
    runRoot: root,
    src: join(root, "stage/source"),
    parentHome: join(root, "parent/home"),
    parentTmp: join(root, "parent/tmp"),
    logs: join(root, "parent/logs"),
    configHome: join(root, "xdg/config"),
    cacheHome: join(root, "xdg/cache"),
    stateHome: join(root, "xdg/state"),
    db: join(root, "native/run.db"),
  };
  if (!existsSync(paths.runRoot)) {
    mkdirSync(paths.runRoot, { recursive: false, mode: 0o700 });
    chmodSync(paths.runRoot, 0o700);
    for (const dir of [
      "stage",
      "stage/source",
      "parent",
      "parent/home",
      "parent/tmp",
      "parent/logs",
      "xdg",
      "xdg/config",
      "xdg/cache",
      "xdg/state",
      "native",
    ])
      mkdirSync(join(paths.runRoot, dir), { recursive: false, mode: 0o700 });
  } else {
    for (const value of Object.values(paths))
      if (value !== paths.db && !existsSync(value))
        throw new Error("opencode-run-root-corrupt");
  }
  for (const [name, value] of Object.entries(paths))
    if (existsSync(value) && realpathSync(value) !== value)
      throw new Error(`opencode-path-not-canonical:${name}`);
  return paths;
}
function isBelow(child: string, parent: string): boolean {
  return (
    child === parent ||
    child.startsWith(parent.endsWith("/") ? parent : `${parent}/`)
  );
}
/**
 * Isolation admission (root decision from #104 acceptance, provisional): the configured data dir
 * must be Rocky-owned — equal to, inside, or containing the user's real opencode data dir
 * (~/.local/share/opencode) is the unrepresentable shared-user-data-dir mode and refuses. The data
 * dir must exist (one-time user-assisted auth provisioning is a documented procedure, NOT
 * implemented here; Rocky never reads, copies, symlinks or proxies auth.json bytes — the
 * existence flag below is path metadata only). G-AUTHFILE (bash-obfuscation reachability of the
 * plain 0600 file) is an OPEN GATE requiring explicit user decision before any live run.
 */
export function assertOpencodeDataHomeIsolation(
  dataHome: string,
  userHome: string,
): { authProvisioned: boolean; authMetadata: AuthMetadata } {
  const realUserData = join(userHome, ".local/share/opencode");
  // Resolve the real user's directory when present: an alias for ~/.local/share may point
  // elsewhere even when the configured Rocky dataHome itself is canonical.
  const canonicalUserData = existsSync(realUserData)
    ? realpathSync(realUserData)
    : realUserData;
  if (
    dataHome === realUserData ||
    isBelow(dataHome, realUserData) ||
    isBelow(realUserData, dataHome) ||
    isBelow(dataHome, canonicalUserData) ||
    isBelow(canonicalUserData, dataHome)
  )
    throw new Error("opencode-shared-user-data-dir");
  if (!existsSync(dataHome)) throw new Error("opencode-data-home-missing");
  if (realpathSync(dataHome) !== dataHome)
    throw new Error("opencode-path-not-canonical:dataHome");
  // Path-existence metadata only; the file is never opened, read, copied or proxied.
  const authProvisioned = existsSync(join(dataHome, "opencode/auth.json"));
  if (!authProvisioned) throw new Error("opencode-auth-unprovisioned");
  const authMetadata = inspectOpencodeAuthMetadata(dataHome);
  return { authProvisioned, authMetadata };
}
/** Metadata only. The private subtree starts at the owned home, not filesystem root. */
export interface AuthMetadata {
  path: string;
  uid: number;
  mode: number;
  parents: { path: string; uid: number; mode: number }[];
}
export function inspectOpencodeAuthMetadata(dataHome: string): AuthMetadata {
  const ownedHome = dirname(dataHome);
  const parents = [ownedHome, dataHome, join(dataHome, "opencode")].map(
    (path) => {
      const stat = lstatSync(path);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        realpathSync(path) !== path
      )
        throw new Error("opencode-auth-parent-not-canonical");
      if (stat.uid !== process.getuid?.())
        throw new Error("opencode-auth-parent-owner");
      if ((stat.mode & 0o7777) !== 0o700)
        throw new Error("opencode-auth-parent-mode");
      return { path, uid: stat.uid, mode: stat.mode & 0o7777 };
    },
  );
  const path = join(dataHome, "opencode/auth.json");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(path) !== path)
    throw new Error("opencode-auth-not-regular");
  if (stat.uid !== process.getuid?.()) throw new Error("opencode-auth-owner");
  if ((stat.mode & 0o7777) !== 0o600) throw new Error("opencode-auth-mode");
  return { path, uid: stat.uid, mode: stat.mode & 0o7777, parents };
}
function safeAuthMetadata(dataHome: string): AuthMetadata | null {
  try {
    return inspectOpencodeAuthMetadata(dataHome);
  } catch {
    return null;
  }
}
export interface OpencodeIsolationInventory {
  schema: 1;
  managed: { path: string; present: boolean }[];
  catalog: { path: string; sha256: string | null; bytes: number };
  configHomeTree: string | null;
  authProvisioned: boolean;
  authMetadata: AuthMetadata | null;
  dataHome: string;
  stagedInstructionFiles: string[];
  stagedOpencodeDir: boolean;
  stagedGitPresent: boolean;
  ancestorGitPresent: boolean;
  digest: string;
}
const STAGED_INSTRUCTION_FILE =
  /^(AGENTS\.md|CLAUDE\.md|CONTEXT\.md|opencode\.jsonc?|\.opencode)$/;
/** Names/presence and nonsecret hashes only; never reads credential material. Managed layers
 * (F13 7/8) cannot be overridden by any config: presence refuses (G-MANAGED). The pinned catalog
 * is hashed; SRC must carry no instruction/config layer and the tree must be projectless. */
export function inventoryOpencodeIsolation(input: {
  config: ValidatedOpencodeConfig;
  paths: OpencodeRunPaths;
  authProvisioned: boolean;
}): OpencodeIsolationInventory {
  const { config, paths } = input;
  const managed = config.managedPaths.map((path) => ({
    path,
    present: existsSync(path),
  }));
  let catalogSha: string | null = null;
  let catalogBytes = 0;
  try {
    const bytes = readFileSync(config.modelsCatalog.path);
    catalogSha = digest(bytes);
    catalogBytes = bytes.length;
  } catch {
    catalogSha = null;
  }
  let configHomeTree: string | null = null;
  try {
    configHomeTree = identity(
      readdirSync(paths.configHome)
        .sort()
        .map((name) => {
          const stat = lstatSync(join(paths.configHome, name));
          return {
            name,
            kind: stat.isDirectory() ? "dir" : stat.isFile() ? "file" : "other",
          };
        }),
    );
  } catch {
    configHomeTree = null;
  }
  const stagedInstructionFiles: string[] = [];
  const walk = (dir: string, nodes: { n: number }) => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (++nodes.n > config.limits.maxTreeNodes)
        throw new Error("opencode-inventory-node-limit");
      if (STAGED_INSTRUCTION_FILE.test(name))
        stagedInstructionFiles.push(join(dir, name));
      let stat;
      try {
        stat = lstatSync(join(dir, name));
      } catch {
        continue;
      }
      if (stat.isDirectory() && name !== ".git") walk(join(dir, name), nodes);
    }
  };
  walk(paths.src, { n: 0 });
  let ancestorGitPresent = existsSync(join(paths.runRoot, ".git"));
  let dir = dirname(paths.runRoot);
  for (;;) {
    if (existsSync(join(dir, ".git"))) {
      ancestorGitPresent = true;
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const inventory: OpencodeIsolationInventory = {
    schema: 1,
    managed,
    catalog: {
      path: config.modelsCatalog.path,
      sha256: catalogSha,
      bytes: catalogBytes,
    },
    configHomeTree,
    authProvisioned: input.authProvisioned,
    authMetadata: safeAuthMetadata(config.dataHome),
    dataHome: config.dataHome,
    stagedInstructionFiles,
    stagedOpencodeDir: existsSync(join(paths.src, ".opencode")),
    stagedGitPresent: existsSync(join(paths.src, ".git")),
    ancestorGitPresent,
    digest: "",
  };
  return { ...inventory, digest: identity({ ...inventory, digest: "" }) };
}
/** Pre-run admission: every refusal makes the profile unavailable, never substituted. */
export function assertOpencodeIsolationAdmissible(
  inventory: OpencodeIsolationInventory,
  config: ValidatedOpencodeConfig,
) {
  for (const entry of inventory.managed)
    if (entry.present)
      throw new Error(`opencode-managed-layer-present:${entry.path}`);
  if (inventory.catalog.sha256 === null)
    throw new Error("opencode-catalog-missing");
  if (inventory.catalog.sha256 !== config.modelsCatalog.sha256)
    throw new Error("opencode-catalog-drift");
  if (inventory.stagedOpencodeDir)
    throw new Error("opencode-staged-opencode-dir");
  if (inventory.stagedInstructionFiles.length)
    throw new Error(
      `opencode-staged-instruction-files:${inventory.stagedInstructionFiles.join(",")}`,
    );
  if (inventory.stagedGitPresent) throw new Error("opencode-staged-git");
  if (inventory.ancestorGitPresent) throw new Error("opencode-ancestor-git");
}
/** Post-run (C5) drift: a managed layer appearing, catalog hash change, or staged instruction
 * files/.git appearing make the result stale/unknown. Data/config-dir WRITE growth is recorded in
 * the receipt, not refused here (G-WRITES/G-NPM: opencode auto-seeds config and may write logs;
 * the sealed env already disables plugins/prune/autoupdate and isolates the DB). */
export function opencodeIsolationDrift(
  pre: OpencodeIsolationInventory,
  post: OpencodeIsolationInventory,
): string[] {
  const drift: string[] = [];
  if (identity(pre.authMetadata) !== identity(post.authMetadata))
    drift.push("auth-metadata-drift");
  for (const [i, entry] of pre.managed.entries()) {
    const other = post.managed[i];
    if (!other || other.path !== entry.path)
      throw new Error("opencode-inventory-shape-changed");
    if (other.present !== entry.present)
      drift.push(`managed-presence:${entry.path}`);
  }
  if (post.catalog.sha256 !== pre.catalog.sha256)
    drift.push("catalog-hash-changed");
  if (post.stagedInstructionFiles.length)
    drift.push(
      `staged-instruction-files-appeared:${post.stagedInstructionFiles.join(",")}`,
    );
  if (post.stagedOpencodeDir && !pre.stagedOpencodeDir)
    drift.push("staged-opencode-dir-appeared");
  if (post.stagedGitPresent && !pre.stagedGitPresent)
    drift.push("staged-git-appeared");
  return drift;
}
