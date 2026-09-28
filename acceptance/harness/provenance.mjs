import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, sha, fileSha, inventory } from "./common.mjs";

// The reference comes from the reviewer-selected Git revision, never the bundle.
export function trustedIdentity(commit) {
  const git = (...args) => execFileSync("git", args, { cwd: ROOT });
  commit ??= git("rev-parse", "HEAD").toString().trim();
  assert.match(commit, /^[a-f0-9]{40}$/, "invalid-trusted-commit");
  const paths = git(
    "ls-tree",
    "-r",
    "--name-only",
    commit,
    "acceptance/harness",
  )
    .toString()
    .trim()
    .split("\n");
  const source = paths
    .map((path) => {
      const bytes = git("show", `${commit}:${path}`);
      return {
        path: path.slice("acceptance/harness/".length),
        bytes: bytes.length,
        sha256: sha(bytes),
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path, "en"));
  // Match inventory()'s bytewise JS sort, not locale-dependent ordering.
  source.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const manifestBytes = git(
    "show",
    `${commit}:acceptance/harness/manifest.json`,
  );
  const manifest = JSON.parse(manifestBytes);
  assert(manifest.protocolSchema, "trusted-contract-has-no-schema-binding");
  return {
    commit,
    source,
    contract: {
      id: manifest.contractId,
      sha256: sha(manifestBytes),
      sourceInventorySha256: sha(JSON.stringify(source)),
      schemaInventorySha256: manifest.protocolSchema.inventorySha256,
    },
    schemaCount: manifest.protocolSchema.artifactCount,
  };
}

export function verifyProvenance(
  directory,
  inputs,
  admission,
  seen,
  reference,
) {
  assert.equal(
    inputs.sourceHead,
    reference.commit,
    "untrusted-source-revision",
  );
  assert.equal(
    admission.head,
    reference.commit,
    "admission-source-revision-mismatch",
  );
  assert.deepEqual(
    inputs.contract,
    reference.contract,
    "contract-identity-mismatch",
  );
  assert.deepEqual(
    admission.contract,
    reference.contract,
    "admission-contract-mismatch",
  );
  assert.deepEqual(
    inputs.sourceFiles,
    reference.source,
    "source-inventory-mismatch",
  );
  assert(
    Array.isArray(inputs.schema) &&
      inputs.schema.length === reference.schemaCount,
    "missing-schema-inventory",
  );
  assert.equal(
    sha(JSON.stringify(inputs.schema)),
    reference.contract.schemaInventorySha256,
    "schema-identity-mismatch",
  );
  for (const [prefix, entries] of [
    ["loaded-source", inputs.sourceFiles],
    ["loaded-schema", inputs.schema],
  ]) {
    assert.deepEqual(
      inventory(join(directory, prefix)),
      entries,
      "retained-provenance-tree-mismatch",
    );
    const unique = new Set();
    for (const entry of entries) {
      assert.deepEqual(
        Object.keys(entry).sort(),
        ["bytes", "path", "sha256"],
        "malformed-provenance-entry",
      );
      assert(
        !entry.path.split("/").some((p) => !p || p === "." || p === "..") &&
          !unique.has(entry.path),
        "ambiguous-provenance-path",
      );
      unique.add(entry.path);
      const path = `${prefix}/${entry.path}`;
      assert(seen.has(path), `missing-retained-provenance:${path}`);
      const bytes = readFileSync(join(directory, path));
      assert.equal(bytes.length, entry.bytes, "provenance-size-mismatch");
      assert.equal(
        fileSha(join(directory, path)),
        entry.sha256,
        "provenance-byte-mismatch",
      );
    }
  }
  const retainedManifest = JSON.parse(
    readFileSync(join(directory, "loaded-source/manifest.json")),
  );
  assert.equal(
    retainedManifest.contractId,
    reference.contract.id,
    "retained-contract-mismatch",
  );
  return { sourceCommit: reference.commit, contract: reference.contract };
}
