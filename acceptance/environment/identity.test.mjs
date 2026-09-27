import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { concrete, verifyFiles } from "./identity.mjs";
import { ROOT, sha } from "./runtime.mjs";
test("nested missing identities are rejected; retained unknown failure classification is data", () => {
  for (const value of [null, "", undefined, "unknown", "placeholder"])
    assert.throws(
      () => concrete({ runtime: { identity: value } }),
      /missing-concrete-identity/,
    );
  assert.doesNotThrow(() =>
    concrete({ ledger: { rawStatus: "unknown", assessment: "unknown" } }),
  );
});
test("hash binding rejects changed and missing executable inputs", () => {
  const root = mkdtempSync(
      join(ROOT, ".qualification/attraccess/evaluator-unit-"),
    ),
    path = join(root, "synthetic-fixture.txt");
  writeFileSync(path, "original", { mode: 0o600 });
  const files = { [path]: sha("original") };
  verifyFiles(files);
  writeFileSync(path, "changed", { mode: 0o600 });
  assert.throws(() => verifyFiles(files), /bound-file-drift/);
  assert.throws(() => verifyFiles({ [join(root, "absent")]: sha("original") }));
});
