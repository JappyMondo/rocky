import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { canonical, digest } from "../dist/store/json.js";
import { TARGET } from "../dist/attraccess/policy.js";
import {
  sourceInventory,
  verifyFixtureInventories,
} from "../dist/attraccess/source.js";
test("two-commit approved fixture has one pinned file difference and rejects in-memory source or mode drift", () => {
  // Full original inventory recovered from the exact upstream commit's actual Git blobs.
  // The approved one-file amendment must reproduce the independently frozen fixture digest.
  const original = JSON.parse(
    readFileSync(
      new URL(
        "./fixtures/attraccess-original-source-inventory.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.equal(
    digest(canonical(original)),
    TARGET.provenance.originalInventorySha256,
  );
  const fixture = structuredClone(original);
  fixture[TARGET.provenance.changedFile].sha256 =
    TARGET.provenance.postimageSha256;
  assert.equal(
    digest(canonical(fixture)),
    TARGET.provenance.fixtureInventorySha256,
  );
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
  const staleFirstFixture = structuredClone(fixture);
  staleFirstFixture[TARGET.provenance.changedFile].sha256 =
    TARGET.provenance.approvedCommits[0].postimageSha256;
  assert.throws(
    () => verifyFixtureInventories(original, staleFirstFixture),
    /provenance-inventory-drift/,
  );
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
