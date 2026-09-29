import { existsSync, lstatSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { digest, identity } from "../../store/json.js";

/**
 * Discovery pinning and inventory (CC04; acceptance/claude-code manifest launch.discovery,
 * source #94/872 F6–F8, #94/879 producer contract). Managed/MDM/server-managed layers cannot be
 * disabled, so ANY presence refuses the profile pre-run (G-MANAGED) and any appearance during a
 * run makes the result stale/unknown. The staged tree and every ancestor must carry no
 * CLAUDE*.md/AGENTS.md/.claude/.mcp.json (and no .git in RUN or ancestors); the dedicated
 * configDir must not gain discovery-relevant children. Names/presence only: this inventory never
 * reads credential material.
 */
export const CLAUDE_FORBIDDEN_CONFIG_DIR_CHILDREN: readonly string[] = [
  "settings.json",
  "settings.local.json",
  "CLAUDE.md",
  "rules",
  "skills",
  "commands",
  "agents",
  "plugins",
];
const INSTRUCTION_PATTERN = /^CLAUDE.*\.md$/;
function isInstructionEntry(name: string): boolean {
  return (
    INSTRUCTION_PATTERN.test(name) ||
    name === "AGENTS.md" ||
    name === ".claude" ||
    name === ".mcp.json"
  );
}
export interface ClaudeDiscoveryInput {
  managed: readonly string[];
  managedDirs: readonly string[];
  mdm: readonly string[];
  configDir: string;
  src: string;
  runRoot: string;
  maxTreeNodes: number;
}
export interface ClaudeDiscoveryInventory {
  schema: 1;
  managed: { path: string; present: boolean }[];
  managedDirs: { path: string; present: boolean; names: string[] }[];
  mdm: { path: string; present: boolean }[];
  serverManaged: { path: string; present: boolean }[];
  configDirChildren: string[];
  forbiddenConfigDirChildren: string[];
  instructionFiles: string[];
  digest: string;
}
function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
function subtreeInstructionFiles(
  root: string,
  maxNodes: number,
  includeGit: boolean,
): string[] {
  const found: string[] = [];
  let nodes = 0;
  const walk = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (++nodes > maxNodes) throw new Error("claude-inventory-node-limit");
      const path = join(dir, name);
      if (isInstructionEntry(name) || (includeGit && name === ".git"))
        found.push(path);
      let stat;
      try {
        stat = lstatSync(path);
      } catch {
        continue;
      }
      if (stat.isDirectory() && name !== ".git") walk(path);
    }
  };
  walk(root);
  return found;
}
function ancestorInstructionFiles(from: string): string[] {
  const found: string[] = [];
  let dir = dirname(from);
  for (;;) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      names = [];
    }
    for (const name of names)
      if (isInstructionEntry(name) || name === ".git")
        found.push(join(dir, name));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return found;
}
/** Collect the inventory without refusing. `configDir` children names and managed presence only;
 * never reads file contents except nothing: presence and names are the whole inventory. */
export function inventoryClaudeDiscovery(
  input: ClaudeDiscoveryInput,
): ClaudeDiscoveryInventory {
  const managed = input.managed.map((path) => ({
    path,
    present: present(path),
  }));
  const managedDirs = input.managedDirs.map((path) => {
    const exists = present(path);
    let names: string[] = [];
    if (exists) {
      try {
        names = readdirSync(path).sort();
      } catch {
        names = [];
      }
    }
    return { path, present: exists, names };
  });
  const mdm = input.mdm.map((path) => ({ path, present: present(path) }));
  const serverManaged = [
    join(input.configDir, "remote-settings.json"),
    join(input.configDir, "policy-limits.json"),
  ].map((path) => ({ path, present: present(path) }));
  let configDirChildren: string[] = [];
  if (present(input.configDir)) {
    try {
      configDirChildren = readdirSync(input.configDir).sort();
    } catch {
      throw new Error("claude-config-dir-unreadable");
    }
  }
  const forbiddenConfigDirChildren = configDirChildren.filter((name) =>
    CLAUDE_FORBIDDEN_CONFIG_DIR_CHILDREN.includes(name),
  );
  const instructionFiles = [
    ...subtreeInstructionFiles(input.src, input.maxTreeNodes, true),
    ...ancestorInstructionFiles(input.runRoot),
  ];
  const inventory: ClaudeDiscoveryInventory = {
    schema: 1,
    managed,
    managedDirs,
    mdm,
    serverManaged,
    configDirChildren,
    forbiddenConfigDirChildren,
    instructionFiles,
    digest: "",
  };
  return { ...inventory, digest: identity({ ...inventory, digest: "" }) };
}
/** Pre-run admission (C0/C1): every refusal makes the profile unavailable, never substituted. */
export function assertClaudeDiscoveryAdmissible(
  inventory: ClaudeDiscoveryInventory,
  bindings: { configDir: string },
) {
  if (!present(bindings.configDir))
    throw new Error("claude-config-dir-missing");
  for (const entry of inventory.managed)
    if (entry.present)
      throw new Error(`claude-managed-layer-present:${entry.path}`);
  for (const entry of inventory.managedDirs)
    if (entry.present)
      throw new Error(`claude-managed-layer-present:${entry.path}`);
  for (const entry of inventory.mdm)
    if (entry.present)
      throw new Error(`claude-mdm-layer-present:${entry.path}`);
  for (const entry of inventory.serverManaged)
    if (entry.present)
      throw new Error(`claude-server-managed-present:${entry.path}`);
  if (inventory.forbiddenConfigDirChildren.length)
    throw new Error(
      `claude-config-dir-forbidden:${inventory.forbiddenConfigDirChildren.join(",")}`,
    );
  if (inventory.instructionFiles.length)
    throw new Error(
      `claude-instruction-files-present:${inventory.instructionFiles.join(",")}`,
    );
}
/** Post-run (C5) drift comparison: managed/MDM/server-managed presence changes, forbidden
 * configDir children appearing and instruction files appearing make the result stale/unknown.
 * Other configDir children gains are recorded (receipt, G-WRITES) but are not drift. */
export function claudeDiscoveryDrift(
  pre: ClaudeDiscoveryInventory,
  post: ClaudeDiscoveryInventory,
): string[] {
  const drift: string[] = [];
  const presenceChanged = (
    a: { path: string; present: boolean }[],
    b: { path: string; present: boolean }[],
    label: string,
  ) => {
    for (const [i, entry] of a.entries()) {
      const other = b[i];
      if (!other || other.path !== entry.path)
        throw new Error("claude-inventory-shape-changed");
      if (other.present !== entry.present) drift.push(`${label}:${entry.path}`);
    }
  };
  presenceChanged(pre.managed, post.managed, "managed-presence");
  presenceChanged(pre.mdm, post.mdm, "mdm-presence");
  presenceChanged(
    pre.serverManaged,
    post.serverManaged,
    "server-managed-presence",
  );
  for (const [i, entry] of pre.managedDirs.entries()) {
    const other = post.managedDirs[i];
    if (!other || other.present !== entry.present)
      drift.push(`managed-dir-presence:${entry.path}`);
  }
  if (post.forbiddenConfigDirChildren.length)
    drift.push(
      `config-dir-gained:${post.forbiddenConfigDirChildren.join(",")}`,
    );
  if (post.instructionFiles.length)
    drift.push(`instruction-files-appeared:${post.instructionFiles.join(",")}`);
  if (!existsSync(dirname(post.serverManaged[0]!.path)))
    drift.push("config-dir-removed");
  return drift;
}
/** Nonsecret keychain service-name derivation for receipt binding only. Rocky never makes a
 * keychain call and never reads, copies, symlinks or proxies credentials (CC02). */
export function claudeKeychainServiceName(configDir: string): string {
  const suffix = digest(configDir.normalize("NFC")).slice(0, 8);
  return `Claude Code-credentials-${suffix}`;
}
