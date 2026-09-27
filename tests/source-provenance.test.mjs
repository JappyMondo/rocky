import test from "node:test";
import assert from "node:assert/strict";
import { TARGET } from "../dist/attraccess/policy.js";
import {
  sourceInventory,
  verifyFixtureInventories,
} from "../dist/attraccess/source.js";
test("approved fixture has one pinned difference and rejects in-memory source or mode drift", () => {
  const fixture = sourceInventory();
  const original = structuredClone(fixture);
  original[TARGET.provenance.changedFile].sha256 =
    TARGET.provenance.preimageSha256;
  verifyFixtureInventories(original, fixture);
  for (const mutate of [
    (value) => {
      value["package.json"].sha256 = "0".repeat(64);
    },
    (value) => {
      value["package.json"].mode = "100755";
    },
    (value) => {
      delete value["package.json"];
    },
    (value) => {
      value[TARGET.provenance.changedFile].sha256 =
        TARGET.provenance.preimageSha256;
    },
  ]) {
    const changed = structuredClone(fixture);
    mutate(changed);
    assert.throws(
      () => verifyFixtureInventories(original, changed),
      /provenance-inventory-drift/,
    );
  }
  const changedOriginal = structuredClone(original);
  changedOriginal["package.json"].mode = "100755";
  assert.throws(
    () => verifyFixtureInventories(changedOriginal, fixture),
    /provenance-inventory-drift/,
  );
  assert.throws(
    () => sourceInventory(TARGET.provenance.originalSource),
    /unexpected-fixture-source/,
  );
});
