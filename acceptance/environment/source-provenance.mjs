import {
  readFileSync,
  lstatSync,
  readlinkSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { ROOT, sha, json, verifyProtected } from "./runtime.mjs";

const git = (root, args) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
const same = (a, b, name) => {
  if (JSON.stringify(a) !== JSON.stringify(b))
    throw Error("source-provenance-drift:" + name);
};
export function sourceInventory(root) {
  const paths = git(root, ["ls-files", "-z"])
    .split("\0")
    .filter(Boolean)
    .sort();
  return Object.fromEntries(
    paths.map((p) => {
      const path = join(root, p),
        s = lstatSync(path);
      const mode = s.isSymbolicLink()
        ? "120000"
        : s.isFile()
          ? s.mode & 0o111
            ? "100755"
            : "100644"
          : "unsupported";
      if (mode === "unsupported")
        throw Error("source-provenance-file-type:" + p);
      return [
        p,
        {
          mode,
          sha256: sha(
            s.isSymbolicLink()
              ? Buffer.from(readlinkSync(path))
              : readFileSync(path),
          ),
        },
      ];
    }),
  );
}
export function verifyComplement(original, fixture, changedFile) {
  same(
    Object.keys(original).sort(),
    Object.keys(fixture).sort(),
    "inventory-paths",
  );
  const changed = Object.keys(original).filter(
    (p) => JSON.stringify(original[p]) !== JSON.stringify(fixture[p]),
  );
  same(changed, [changedFile], "source-complement");
}
export function originalSource(rt) {
  verifyProtected();
  const manifest = json(
    join(ROOT, "acceptance/environment/manifest.json"),
  ).inputs;
  const approved = manifest.fixture_provenance,
    p = rt.inputs.provenance;
  const fixture = rt.api.TARGET.source,
    original = p.originalSource;
  same(realpathSync(fixture), manifest.source_read_root, "fixture-root");
  same(
    realpathSync(original),
    approved.original_source_read_root,
    "original-root",
  );
  for (const [root, commit, tree] of [
    [fixture, manifest.target_commit, manifest.target_tree],
    [original, approved.original_commit, approved.original_tree],
  ]) {
    same(git(root, ["rev-parse", "HEAD"]), commit, "head");
    same(git(root, ["rev-parse", "HEAD^{tree}"]), tree, "tree");
    same(git(root, ["status", "--porcelain"]), "", "clean-source");
  }
  same(
    git(original, ["branch", "--show-current"]),
    approved.original_branch,
    "original-branch",
  );
  same(git(fixture, ["remote"]), "", "fixture-remotes");
  if (existsSync(join(fixture, ".git/objects/info/alternates")))
    throw Error("source-provenance-git-alternates");
  same(
    git(fixture, [
      "rev-list",
      "--reverse",
      approved.original_commit + "..HEAD",
    ]).split("\n"),
    [approved.fixture_parent_commit, manifest.target_commit],
    "exact-two-commits",
  );
  const changedFile = approved.changed_files[0];
  const chain = [
    [
      approved.fixture_parent_commit,
      approved.original_commit,
      approved.parent_tree,
      approved.preimage_sha256,
      approved.parent_file_sha256,
    ],
    [
      manifest.target_commit,
      approved.fixture_parent_commit,
      manifest.target_tree,
      approved.parent_file_sha256,
      approved.postimage_sha256,
    ],
  ];
  for (const [commit, parent, tree, before, after] of chain) {
    same(
      git(fixture, ["show", "-s", "--format=%P", commit]),
      parent,
      "single-parent",
    );
    same(git(fixture, ["rev-parse", commit + "^{tree}"]), tree, "chain-tree");
    same(
      git(fixture, ["diff", "--name-only", parent, commit]),
      changedFile,
      "single-changed-file",
    );
    for (const [revision, expected] of [
      [parent, before],
      [commit, after],
    ])
      same(
        sha(
          execFileSync("git", [
            "-C",
            fixture,
            "show",
            revision + ":" + changedFile,
          ]),
        ),
        expected,
        "chain-file-bytes",
      );
  }
  const originalFiles = sourceInventory(original),
    fixtureFiles = sourceInventory(fixture);
  same(
    Object.keys(fixtureFiles).length,
    approved.tracked_file_count,
    "file-count",
  );
  verifyComplement(originalFiles, fixtureFiles, changedFile);
  same(
    sha(rt.api.canonical(originalFiles)),
    p.originalInventorySha256,
    "original-inventory",
  );
  same(
    sha(rt.api.canonical(fixtureFiles)),
    rt.inputs.sourceInventorySha256,
    "fixture-inventory",
  );
  same(
    rt.api.canonical(fixtureFiles),
    rt.api.canonical(rt.inputs.prepared.sourceInventory),
    "prepared-inventory",
  );
  for (const path of Object.keys(fixtureFiles)) {
    const a = lstatSync(join(original, path)),
      b = lstatSync(join(fixture, path));
    if (
      (a.dev === b.dev && a.ino === b.ino) ||
      (!b.isSymbolicLink() && b.nlink !== 1)
    )
      throw Error("source-provenance-shared-inode:" + path);
  }
  return {
    commit: manifest.target_commit,
    tree: manifest.target_tree,
    files: Object.keys(fixtureFiles).length,
    inventorySha256: rt.inputs.sourceInventorySha256,
    original: {
      root: original,
      commit: approved.original_commit,
      tree: approved.original_tree,
      inventorySha256: p.originalInventorySha256,
    },
    approvedChain: chain,
    changedFiles: [changedFile],
    sourceComplementFiles: Object.keys(fixtureFiles).length - 1,
    fixtureRemotes: 0,
    sharedInodes: 0,
  };
}
