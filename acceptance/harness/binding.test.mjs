import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { ROOT, EVIDENCE, guard, inventory, save, sha } from "./common.mjs";
import { trustedIdentity, verifyProvenance } from "./provenance.mjs";
import { verifyInventory } from "./check.mjs";

// Run after the repair commit: exercises the same provenance boundary with real
// Git source objects and all 440 retained exact-binary schemas, without Codex.
test("real committed source/schema binding verifies and rejects missing/altered bytes", () => {
  const commit = guard(),
    reference = trustedIdentity(commit);
  assert.deepEqual(
    inventory(join(ROOT, "acceptance/harness")),
    reference.source,
    "binding-selftest-requires-clean-source",
  );
  const directory = join(
    ROOT,
    ".qualification/harness-native-64-repair",
    `binding-unit-${Date.now()}`,
  );
  for (const entry of reference.source) {
    const path = join(directory, "loaded-source", entry.path);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(
      path,
      execFileSync("git", [
        "show",
        `${commit}:acceptance/harness/${entry.path}`,
      ]),
      { flag: "wx", mode: 0o600 },
    );
  }
  const schemaRoot = join(EVIDENCE, "schema-discovery/schema-experimental"),
    schema = inventory(schemaRoot);
  for (const entry of schema) {
    const path = join(directory, "loaded-schema", entry.path);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, readFileSync(join(schemaRoot, entry.path)), {
      flag: "wx",
      mode: 0o600,
    });
  }
  const inputs = {
      sourceHead: commit,
      sourceFiles: reference.source,
      schema,
      contract: reference.contract,
    },
    admission = { head: commit, contract: reference.contract };
  save(join(directory, "inputs.json"), inputs);
  save(join(directory, "reference.json"), reference);
  const before = inventory(directory),
    seen = verifyInventory(directory, before);
  verifyProvenance(directory, inputs, admission, seen, reference);
  const results = [{ probe: "actual-source-and-440-schemas", status: "pass" }];
  const missing = new Set(seen);
  missing.delete("loaded-schema/" + schema[0].path);
  assert.throws(
    () => verifyProvenance(directory, inputs, admission, missing, reference),
    /missing-retained-provenance/,
  );
  results.push({
    probe: "missing-schema-artifact-binding",
    status: "rejected",
  });
  assert.throws(
    () =>
      verifyProvenance(
        directory,
        { ...inputs, sourceFiles: undefined },
        admission,
        seen,
        reference,
      ),
    /source-inventory-mismatch/,
  );
  results.push({ probe: "missing-source-identity", status: "rejected" });
  const changedPath = join(directory, "loaded-source/probe.mjs");
  writeFileSync(
    changedPath,
    readFileSync(changedPath, "utf8") + "\n// altered test byte\n",
  );
  const refreshedInventory = inventory(directory);
  assert.throws(
    () =>
      verifyProvenance(
        directory,
        inputs,
        admission,
        verifyInventory(directory, refreshedInventory),
        reference,
      ),
    /retained-provenance-tree-mismatch/,
  );
  results.push({
    probe: "changed-source-with-rehashed-artifact-inventory",
    status: "rejected",
  });
  save(join(directory, "results.json"), {
    evidenceClass: "static_provenance_selftest",
    qualification: false,
    capability: null,
    commit,
    schemaCount: schema.length,
    beforeInventorySha256: sha(JSON.stringify(before)),
    results,
  });
});
