import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  readFileSync,
  mkdirSync,
  lstatSync,
  readlinkSync,
  writeFileSync,
  realpathSync,
  existsSync,
} from "node:fs";
import { join, resolve, relative, dirname } from "node:path";
import { digest, canonical } from "../store/json.js";
import { TARGET, GENERATED } from "./policy.js";
export function gitMode(stat: import("node:fs").Stats): string {
  return stat.isSymbolicLink()
    ? "120000"
    : stat.isFile()
      ? stat.mode & 0o111
        ? "100755"
        : "100644"
      : "unsupported";
}
// Self-contained code shared by both inside-container verifiers.
export function inventoryProbe(inventoryPath: string, sourceRoot = "/app") {
  return `const fs=require('fs'),p=require('path'),c=require('crypto');const files=JSON.parse(fs.readFileSync(${JSON.stringify(inventoryPath)}));const changed=[];for(const [name,e] of Object.entries(files)){try{const f=p.join(${JSON.stringify(sourceRoot)},name),s=fs.lstatSync(f),mode=s.isSymbolicLink()?'120000':s.isFile()?(s.mode&73?'100755':'100644'):'unsupported',b=s.isSymbolicLink()?Buffer.from(fs.readlinkSync(f)):fs.readFileSync(f);if(mode!==e.mode||c.createHash('sha256').update(b).digest('hex')!==e.sha256)changed.push(name);}catch{changed.push(name);}}console.log(JSON.stringify({files:Object.keys(files).length,changed}));if(changed.length)process.exit(2);`;
}
export type SourceInventory = Record<string, { mode: string; sha256: string }>;
export function ownedPath(path: string, authorizedRoot = TARGET.root) {
  const root = realpathSync(authorizedRoot);
  const full = resolve(path);
  if (full !== root && !full.startsWith(root + "/"))
    throw new Error("outside-authorized-environment-root");
  let existing = full;
  while (!existsSync(existing)) existing = dirname(existing);
  if (
    realpathSync(existing) !== root &&
    !realpathSync(existing).startsWith(root + "/")
  )
    throw new Error("environment-symlink-escape");
  return full;
}
function inventoryAt(source: string, commit: string): SourceInventory {
  const rows = execFileSync("git", ["-C", source, "ls-tree", "-rz", commit], {
    maxBuffer: 16 * 1024 * 1024,
  })
    .toString()
    .split("\0")
    .filter(Boolean);
  const result: SourceInventory = {};
  for (const row of rows) {
    const [header, path] = row.split("\t");
    if (!header || !path) throw new Error("invalid-source-tree");
    const [mode, type, oid] = header.split(" ");
    if (type !== "blob" || !oid || !mode)
      throw new Error("unsupported-source-entry");
    const file = join(source, path);
    if (gitMode(lstatSync(file)) !== mode)
      throw new Error("source-mode-drift:" + path);
    const bytes =
      mode === "120000" ? Buffer.from(readlinkSync(file)) : readFileSync(file);
    if (
      createHash("sha1")
        .update(Buffer.from("blob " + bytes.length + "\0"))
        .update(bytes)
        .digest("hex") !== oid
    )
      throw new Error("source-blob-drift:" + path);
    result[path] = { mode, sha256: digest(bytes) };
  }
  return result;
}
export function verifyFixtureInventories(
  original: SourceInventory,
  fixture: SourceInventory,
) {
  const p = TARGET.provenance;
  if (
    digest(canonical(original)) !== p.originalInventorySha256 ||
    digest(canonical(fixture)) !== p.fixtureInventorySha256
  )
    throw new Error("fixture-provenance-inventory-drift");
  const changed = Object.keys(fixture).filter(
    (path) => canonical(fixture[path]) !== canonical(original[path]),
  );
  if (
    changed.length !== 1 ||
    changed[0] !== p.changedFile ||
    original[p.changedFile]?.sha256 !== p.preimageSha256 ||
    fixture[p.changedFile]?.sha256 !== p.postimageSha256
  )
    throw new Error("fixture-provenance-diff-drift");
}
export function sourceInventory(source = TARGET.source): SourceInventory {
  if (
    resolve(source) !== TARGET.source ||
    realpathSync(source) !== TARGET.source
  )
    throw new Error("unexpected-fixture-source");
  const p = TARGET.provenance;
  const git = (root: string, ...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  for (const [root, commit, tree] of [
    [source, TARGET.commit, TARGET.tree],
    [p.originalSource, p.originalCommit, p.originalTree],
  ] as const) {
    if (
      git(root, "rev-parse", "HEAD", "HEAD^{tree}") !== commit + "\n" + tree ||
      git(root, "status", "--porcelain")
    )
      throw new Error("fixture-provenance-checkout-drift");
  }
  if (
    git(source, "remote") ||
    existsSync(join(source, ".git/objects/info/alternates"))
  )
    throw new Error("fixture-provenance-git-drift");
  let parent = p.originalCommit;
  for (const approved of p.approvedCommits) {
    if (
      approved.parent !== parent ||
      git(source, "rev-list", "--parents", "-n", "1", approved.commit) !==
        approved.commit + " " + parent ||
      git(source, "rev-parse", approved.commit + "^{tree}") !== approved.tree ||
      git(
        source,
        "diff",
        "--name-only",
        "--no-renames",
        parent,
        approved.commit,
      ) !== p.changedFile
    )
      throw new Error("fixture-provenance-history-drift");
    for (const [revision, expected] of [
      [parent, approved.preimageSha256],
      [approved.commit, approved.postimageSha256],
    ]) {
      const bytes = execFileSync("git", [
        "-C",
        source,
        "show",
        revision + ":" + p.changedFile,
      ]);
      if (digest(bytes) !== expected)
        throw new Error("fixture-provenance-approved-source-drift");
    }
    parent = approved.commit;
  }
  if (parent !== TARGET.commit)
    throw new Error("fixture-provenance-history-drift");
  const original = inventoryAt(p.originalSource, p.originalCommit);
  const fixture = inventoryAt(source, TARGET.commit);
  verifyFixtureInventories(original, fixture);
  return fixture;
}
export function verifySnapshot(snapshot: string, inventory: SourceInventory) {
  const differences: string[] = [];
  for (const [path, entry] of Object.entries(inventory)) {
    const file = join(snapshot, path);
    try {
      const stat = lstatSync(file);
      const bytes = stat.isSymbolicLink()
        ? Buffer.from(readlinkSync(file))
        : readFileSync(file);
      if (digest(bytes) !== entry.sha256 || gitMode(stat) !== entry.mode)
        differences.push(path);
      if (!stat.isSymbolicLink() && stat.nlink !== 1)
        throw new Error("shared-source-hardlink");
      if (
        stat.isSymbolicLink() &&
        !resolve(dirname(file), readlinkSync(file)).startsWith(snapshot + "/")
      )
        throw new Error("escaping-source-link");
    } catch {
      differences.push(path);
    }
  }
  if (differences.length)
    throw new Error("source-integrity-failure:" + differences.join(","));
  return {
    files: Object.keys(inventory).length,
    sha256: digest(canonical(inventory)),
  };
}
export function materialize(destination: string) {
  ownedPath(destination);
  if (existsSync(destination)) throw new Error("snapshot-already-exists");
  const head = execFileSync("git", ["-C", TARGET.source, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  if (head !== TARGET.commit) throw new Error("source-revision-drift");
  if (
    execFileSync("git", ["-C", TARGET.source, "status", "--porcelain"], {
      encoding: "utf8",
    }).trim()
  )
    throw new Error("source-checkout-dirty");
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  // A local independent clone creates no new target commit/branch and prevents Nx finding the parent Rocky repository.
  execFileSync(
    "git",
    [
      "clone",
      "--no-hardlinks",
      "--no-checkout",
      "--local",
      TARGET.source,
      destination,
    ],
    { stdio: "pipe" },
  );
  execFileSync(
    "git",
    ["-C", destination, "checkout", "--detach", TARGET.commit],
    { stdio: "pipe" },
  );
  execFileSync("git", ["-C", destination, "remote", "remove", "origin"]);
  if (existsSync(join(destination, ".git/objects/info/alternates")))
    throw new Error("shared-git-object-store");
  const inventory = sourceInventory();
  verifySnapshot(destination, inventory);
  return {
    snapshot: destination,
    commit: head,
    tree: TARGET.tree,
    inventory,
    inventorySha256: digest(canonical(inventory)),
    generated: GENERATED,
    provenance: TARGET.provenance,
    gitRoot: execFileSync(
      "git",
      ["-C", destination, "rev-parse", "--show-toplevel"],
      { encoding: "utf8" },
    ).trim(),
  };
}

/** Current scoped runs bind a clean tracked tree; archived fixture provenance remains separate. */
export interface CurrentSource {
  source: string;
  root: string;
  commit: string;
  tree: string;
  node: string;
  pnpm: string;
  packageManager: string;
  recipeFiles: Record<string, string>;
}
export function trackedSourceInventory(
  source: string,
  commit: string,
): SourceInventory {
  const head = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  if (
    head !== commit ||
    execFileSync(
      "git",
      ["-C", source, "status", "--porcelain", "--untracked-files=no"],
      { encoding: "utf8" },
    ).trim()
  )
    throw new Error("current-source-drift");
  return inventoryAt(source, commit);
}
