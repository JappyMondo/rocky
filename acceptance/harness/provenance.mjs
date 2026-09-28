import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { ROOT, NATIVE_EVIDENCE, sha, fileSha, inventory } from "./common.mjs";
import { definition } from "./fixture.mjs";

// Layout comes from the admitted canonical root, never from producer paths or
// config-after-* summaries. The native-64 runtime is separate from its snapshot.
export function loadedConfigLayout(attempt) {
  definition(attempt);
  const home =
    dirname(attempt) === NATIVE_EVIDENCE
      ? "runtime/codex-home"
      : "private/codex-home";
  return {
    codeHome: join(attempt, home),
    actual: `${home}/config.toml`,
    snapshot: "private/codex-home/config.toml",
  };
}

export function verifyLoadedConfig(directory, inputs, seen, layout) {
  for (const path of [layout.snapshot, layout.actual])
    assert(seen.has(path), `missing-loaded-config:${path}`);
  assert.equal(
    inputs.env?.CODEX_HOME,
    layout.codeHome,
    "loaded-codex-home-mismatch",
  );
  assert.match(
    inputs.configSha256,
    /^[a-f0-9]{64}$/,
    "invalid-config-identity",
  );
  const snapshot = readFileSync(join(directory, layout.snapshot));
  const actual = readFileSync(join(directory, layout.actual));
  assert.equal(sha(snapshot), inputs.configSha256, "loaded-config-changed");
  assert.equal(
    sha(actual),
    inputs.configSha256,
    "actual-runtime-config-changed",
  );
  assert.deepEqual(actual, snapshot, "runtime-config-snapshot-mismatch");
}

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
    observationVariant: manifest.observationVariant,
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
