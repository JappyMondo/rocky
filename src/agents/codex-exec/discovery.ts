import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { digest, identity } from "../../store/json.js";
import { deriveTreeHead } from "../seam.js";
import {
  captureSharedConfigToml,
  sharedConfigTomlDrift,
  type SharedConfigTomlMeasurement,
} from "./trust.js";

/**
 * Discovery pinning and inventory (S01/S10; acceptance/subscription manifest receiptRequirements
 * post-run rehash, source #92/857 F2/F4/F5/F6 and #92/858 §1 discoveryInventory). Tables deep-merge
 * and NO override can erase inherited map entries, so any present system/managed/MDM layer makes the
 * profile unavailable (F2). `--ignore-user-config` replaces only the user config.toml layer; the
 * CODEX_HOME skill roots and packaged defaults still apply beneath, so ignore flags alone never
 * establish absence (F4). The global CODEX_HOME AGENTS.override.md/AGENTS.md is ALWAYS provided and
 * may be re-read per turn, so the effective one must be explicitly approved by hash and drift-checked
 * (F6). The staged tree is untrusted and projectless: no .codex/.agents/AGENTS*.md and no .git in RUN
 * or any ancestor. Names/presence and nonsecret hashes only: this inventory never reads credential
 * material. The shared config.toml is measured (hash+size) for the F5 trust-persistence byte check.
 */
export interface CodexDiscoveryInput {
  codexHome: string;
  system: readonly string[];
  systemDirs: readonly string[];
  mdm: readonly string[];
  src: string;
  runRoot: string;
  maxTreeNodes: number;
  approvedGlobalAgentsSha256: string | null;
  codexHomeSkillsApproved: boolean;
}
export interface CodexFileEntry {
  path: string;
  present: boolean;
  sha256: string | null;
  bytes: number;
}
export interface CodexDirEntry {
  path: string;
  present: boolean;
  treeDigest: string | null;
}
export interface CodexDiscoveryInventory {
  schema: 1;
  globalAgentsOverride: CodexFileEntry;
  globalAgents: CodexFileEntry;
  effectiveGlobalAgentsSha256: string | null;
  system: CodexFileEntry[];
  systemDirs: CodexDirEntry[];
  mdm: CodexFileEntry[];
  codexHomeSkills: CodexDirEntry;
  codexHomeChildren: { name: string; type: string }[];
  sharedConfigToml: SharedConfigTomlMeasurement;
  stagedCodexDir: boolean;
  stagedAgentsDir: boolean;
  stagedAgentsFiles: string[];
  stagedGitPresent: boolean;
  ancestorGitPresent: boolean;
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
function fileEntry(path: string): CodexFileEntry {
  if (!present(path)) return { path, present: false, sha256: null, bytes: 0 };
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) return { path, present: true, sha256: null, bytes: 0 };
    const bytes = readFileSync(path);
    return { path, present: true, sha256: digest(bytes), bytes: bytes.length };
  } catch {
    return { path, present: true, sha256: null, bytes: 0 };
  }
}
function dirEntry(path: string, maxTreeNodes: number): CodexDirEntry {
  if (!present(path)) return { path, present: false, treeDigest: null };
  try {
    return {
      path,
      present: true,
      treeDigest: deriveTreeHead(path, maxTreeNodes),
    };
  } catch {
    return { path, present: true, treeDigest: null };
  }
}
function subtreeMatches(
  root: string,
  predicate: (name: string) => boolean,
  maxNodes: number,
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
      if (++nodes > maxNodes) throw new Error("codex-inventory-node-limit");
      const path = join(dir, name);
      if (predicate(name)) found.push(path);
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
function ancestorGitPresent(from: string): boolean {
  let dir = dirname(from);
  for (;;) {
    if (present(join(dir, ".git"))) return true;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}
const AGENTS_FILE = /^AGENTS(\..+)?\.md$/;
/** Collect the inventory without refusing. Effective global AGENTS is AGENTS.override.md when
 * non-empty, else AGENTS.md (F6). Never reads credential material; names/presence/hashes only. */
export function inventoryCodexDiscovery(
  input: CodexDiscoveryInput,
): CodexDiscoveryInventory {
  const globalAgentsOverride = fileEntry(
    join(input.codexHome, "AGENTS.override.md"),
  );
  const globalAgents = fileEntry(join(input.codexHome, "AGENTS.md"));
  const effectiveGlobalAgentsSha256 =
    globalAgentsOverride.present && globalAgentsOverride.bytes > 0
      ? globalAgentsOverride.sha256
      : globalAgents.present && globalAgents.bytes > 0
        ? globalAgents.sha256
        : null;
  const system = input.system.map((path) => fileEntry(path));
  const systemDirs = input.systemDirs.map((path) =>
    dirEntry(path, input.maxTreeNodes),
  );
  const mdm = input.mdm.map((path) => fileEntry(path));
  const codexHomeSkills = dirEntry(
    join(input.codexHome, "skills"),
    input.maxTreeNodes,
  );
  let codexHomeChildren: { name: string; type: string }[] = [];
  if (present(input.codexHome)) {
    let names: string[];
    try {
      names = readdirSync(input.codexHome).sort();
    } catch {
      throw new Error("codex-home-unreadable");
    }
    codexHomeChildren = names.map((name) => {
      let type = "other";
      try {
        const stat = lstatSync(join(input.codexHome, name));
        type = stat.isDirectory()
          ? "dir"
          : stat.isSymbolicLink()
            ? "link"
            : stat.isFile()
              ? "file"
              : "other";
      } catch {
        type = "other";
      }
      return { name, type };
    });
  }
  const sharedConfigToml = captureSharedConfigToml(input.codexHome);
  const stagedAgentsFiles = subtreeMatches(
    input.src,
    (name) => AGENTS_FILE.test(name),
    input.maxTreeNodes,
  );
  const inventory: CodexDiscoveryInventory = {
    schema: 1,
    globalAgentsOverride,
    globalAgents,
    effectiveGlobalAgentsSha256,
    system,
    systemDirs,
    mdm,
    codexHomeSkills,
    codexHomeChildren,
    sharedConfigToml,
    stagedCodexDir: present(join(input.src, ".codex")),
    stagedAgentsDir: present(join(input.src, ".agents")),
    stagedAgentsFiles,
    stagedGitPresent: present(join(input.src, ".git")),
    ancestorGitPresent:
      ancestorGitPresent(input.runRoot) || present(join(input.runRoot, ".git")),
    digest: "",
  };
  return { ...inventory, digest: identity({ ...inventory, digest: "" }) };
}
/** Pre-run admission (C0/C1): every refusal makes the profile unavailable, never substituted. */
export function assertCodexDiscoveryAdmissible(
  inventory: CodexDiscoveryInventory,
  bindings: {
    approvedGlobalAgentsSha256: string | null;
    codexHomeSkillsApproved: boolean;
  },
) {
  for (const entry of inventory.system)
    if (entry.present)
      throw new Error(`codex-system-layer-present:${entry.path}`);
  for (const entry of inventory.systemDirs)
    if (entry.present)
      throw new Error(`codex-system-layer-present:${entry.path}`);
  for (const entry of inventory.mdm)
    if (entry.present) throw new Error(`codex-mdm-layer-present:${entry.path}`);
  // The effective global AGENTS must equal the explicitly approved digest (or be absent when the
  // approval is null). An unapproved or mismatched global instruction file refuses the profile.
  if (
    inventory.effectiveGlobalAgentsSha256 !==
    bindings.approvedGlobalAgentsSha256
  )
    throw new Error("codex-global-agents-unapproved");
  if (inventory.codexHomeSkills.present && !bindings.codexHomeSkillsApproved)
    throw new Error("codex-home-skills-unapproved");
  // Untrusted project ⇒ no project instruction/config layer, and a projectless staged tree.
  if (inventory.stagedCodexDir) throw new Error("codex-staged-codex-dir");
  if (inventory.stagedAgentsDir) throw new Error("codex-staged-agents-dir");
  if (inventory.stagedAgentsFiles.length)
    throw new Error(
      `codex-staged-agents-files:${inventory.stagedAgentsFiles.join(",")}`,
    );
  if (inventory.stagedGitPresent) throw new Error("codex-staged-git-present");
  if (inventory.ancestorGitPresent)
    throw new Error("codex-ancestor-git-present");
}
/** Post-run (C5) drift comparison: a changed global AGENTS digest, an appeared system/managed/MDM
 * layer, a mutated shared config.toml (F5 trust persistence) or appeared staged instructions/.git
 * make the result stale/unknown. */
export function codexDiscoveryDrift(
  pre: CodexDiscoveryInventory,
  post: CodexDiscoveryInventory,
): string[] {
  const drift: string[] = [];
  if (pre.effectiveGlobalAgentsSha256 !== post.effectiveGlobalAgentsSha256)
    drift.push("global-agents-digest-changed");
  const presenceChanged = (
    a: { path: string; present: boolean }[],
    b: { path: string; present: boolean }[],
    label: string,
  ) => {
    for (const [i, entry] of a.entries()) {
      const other = b[i];
      if (!other || other.path !== entry.path)
        throw new Error("codex-inventory-shape-changed");
      if (other.present !== entry.present) drift.push(`${label}:${entry.path}`);
    }
  };
  presenceChanged(pre.system, post.system, "system-presence");
  presenceChanged(pre.mdm, post.mdm, "mdm-presence");
  for (const [i, entry] of pre.systemDirs.entries()) {
    const other = post.systemDirs[i];
    if (!other || other.present !== entry.present)
      drift.push(`system-dir-presence:${entry.path}`);
    else if (other.treeDigest !== entry.treeDigest)
      drift.push(`system-dir-digest:${entry.path}`);
  }
  if (post.codexHomeSkills.treeDigest !== pre.codexHomeSkills.treeDigest)
    drift.push("codex-home-skills-changed");
  const configDrift = sharedConfigTomlDrift(
    pre.sharedConfigToml,
    post.sharedConfigToml,
  );
  if (configDrift) drift.push(configDrift);
  if (post.stagedCodexDir && !pre.stagedCodexDir)
    drift.push("staged-codex-dir-appeared");
  if (post.stagedAgentsDir && !pre.stagedAgentsDir)
    drift.push("staged-agents-dir-appeared");
  if (post.stagedAgentsFiles.length)
    drift.push(
      `staged-agents-files-appeared:${post.stagedAgentsFiles.join(",")}`,
    );
  if (post.stagedGitPresent && !pre.stagedGitPresent)
    drift.push("staged-git-appeared");
  return drift;
}
