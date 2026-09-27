import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, symlinkSync } from "node:fs";
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

test("retained inventory rejects duplicate/ambiguous/malformed identities", async () => {
  const { inventoryEntries, artifactReferences } = await import(
    "./admission-evidence.mjs"
  );
  const a = { path: "file", sha256: sha("a"), bytes: 1, kind: "file" };
  for (const bad of [
    [a, a],
    [{ ...a, bytes: -1 }],
    [{ ...a, kind: "directory" }],
    { file: { ...a, path: "other" } },
    { file: "missing" },
  ])
    assert.throws(
      () => inventoryEntries(bad),
      /invalid-retained-inventory-record/,
    );
  assert.deepEqual(
    artifactReferences({
      receipt: "image.json",
      receiptSha256: sha("receipt"),
      file: "image.png",
      sha256: sha("image"),
    }),
    [
      ["image.png", sha("image")],
      ["image.json", sha("receipt")],
    ],
  );
  assert.throws(
    () =>
      artifactReferences({
        receipt: "image.json",
        file: "image.png",
        sha256: sha("image"),
      }),
    /ambiguous-artifact-receipt-digest/,
  );
});

test("materialized source copy checks exact canonical mode/bytes and hashes symlink text without traversing it", async () => {
  const { verifySourceCopyEntry } = await import("./admission-evidence.mjs");
  const root = mkdtempSync(
      join(ROOT, ".qualification/attraccess/evaluator-source-copy-test-"),
    ),
    path = join(root, "file");
  writeFileSync(path, "source", { mode: 0o600 });
  const expected = { sha256: sha("source"), bytes: 6, kind: "file" },
    canonical = { sha256: sha("source"), mode: "100644" };
  assert.equal(verifySourceCopyEntry(path, expected, canonical).mode, "100644");
  chmodSync(path, 0o700);
  assert.throws(
    () => verifySourceCopyEntry(path, expected, canonical),
    /source-copy-canonical-drift/,
  );
  chmodSync(path, 0o600);
  writeFileSync(path, "altered");
  assert.throws(
    () => verifySourceCopyEntry(path, expected, canonical),
    /retained-evidence-drift/,
  );
  const link = join(root, "link"),
    target = "/nonexistent-private-target-never-followed";
  symlinkSync(target, link);
  assert.equal(
    verifySourceCopyEntry(
      link,
      { kind: "symlink", sha256: sha(target), bytes: target.length },
      { mode: "120000", sha256: sha(target) },
    ).kind,
    "symlink",
  );
  assert.throws(
    () =>
      verifySourceCopyEntry(
        link,
        { kind: "symlink", sha256: sha(target), bytes: target.length },
        { mode: "120000", sha256: sha("wrong") },
      ),
    /source-copy-canonical-drift/,
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

test("legacy retained inventories accept string and hash/size records, reject altered digest or size", async () => {
  const { verifyExpected, inventoryEntries } = await import(
    "./admission-evidence.mjs"
  );
  const bytes = Buffer.from("retained evidence");
  for (const inventory of [
    { file: sha(bytes) },
    { file: { sha256: sha(bytes), bytes: bytes.length } },
    [{ path: "file", sha256: sha(bytes), bytes: bytes.length, kind: "file" }],
  ]) {
    const entries = inventoryEntries(inventory);
    assert.equal(entries.length, 1);
    verifyExpected(bytes, entries[0][1], entries[0][0]);
  }
  assert.throws(
    () => inventoryEntries([{ path: "bad" }]),
    /invalid-retained-inventory-record/,
  );
  assert.doesNotThrow(() => verifyExpected(bytes, sha(bytes), "legacy-string"));
  assert.doesNotThrow(() =>
    verifyExpected(
      bytes,
      { sha256: sha(bytes), bytes: bytes.length },
      "legacy-record",
    ),
  );
  for (const expected of [
    "0".repeat(64),
    { sha256: "0".repeat(64), bytes: bytes.length },
    { sha256: sha(bytes), bytes: bytes.length + 1 },
    {},
  ])
    assert.throws(
      () => verifyExpected(bytes, expected, "bad"),
      /retained-evidence-drift/,
    );
});
