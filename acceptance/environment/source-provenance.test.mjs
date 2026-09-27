import test from "node:test";
import assert from "node:assert/strict";
import { json, INPUTS, ROOT } from "./runtime.mjs";
import { verifyComplement } from "./source-provenance.mjs";
import { toolchainIdentity, verifyToolchain } from "./toolchain-identity.mjs";
import { join } from "node:path";
import { verifyRuntimeComplement } from "./preparation-reuse.mjs";

test("source complement rejects missing, extra, mode and unrelated byte changes", () => {
  const original = {
    approved: { mode: "100644", sha256: "a" },
    untouched: { mode: "100644", sha256: "b" },
  };
  const fixture = { ...original, approved: { mode: "100644", sha256: "c" } };
  assert.doesNotThrow(() => verifyComplement(original, fixture, "approved"));
  for (const other of [
    { approved: fixture.approved },
    { ...fixture, extra: original.untouched },
    { ...fixture, untouched: { mode: "100755", sha256: "b" } },
    { ...fixture, untouched: { mode: "100644", sha256: "z" } },
    original,
  ])
    assert.throws(
      () => verifyComplement(original, other, "approved"),
      /source-provenance-drift/,
    );
});
test("actual historical runtime and refreshed image toolchain formats bind identical identities", () => {
  const current = json(INPUTS),
    old = json(
      join(
        ROOT,
        ".qualification/attraccess/handoff-2ff6cab/proposed-inputs.json",
      ),
    );
  assert.deepEqual(
    verifyToolchain(old.toolchain.stdout, current),
    toolchainIdentity(old.toolchain.stdout),
  );
  const src = {
    files: 3468,
    commit: current.targetCommit,
    tree: current.targetTree,
  };
  assert.deepEqual(
    toolchainIdentity(current.toolchain.stdout, src),
    toolchainIdentity(old.toolchain.stdout),
  );
  for (const bad of [
    old.toolchain.stdout.replace("v24.19.0", "v24.19.1"),
    old.toolchain.stdout.replace("10.34.5", "10.34.6"),
    old.toolchain.stdout.replace("3e53e5", "000000"),
    old.toolchain.stdout.replace("/usr/bin/zip", "/wrong/zip"),
    old.toolchain.stdout + "duplicate\n",
    old.toolchain.stdout.split("\n").slice(1).join("\n"),
    old.toolchain.stdout.replace(/\n[^\n]+  \/usr\/bin\/zip\n$/, "\n"),
  ])
    assert.throws(() => verifyToolchain(bad, current), /toolchain/);
  for (const bad of [
    current.toolchain.stdout.replace(current.targetCommit, "0".repeat(40)),
    current.toolchain.stdout.replace('"changed":[]', '"changed":["bad"]'),
    current.toolchain.stdout + current.toolchain.stdout,
  ])
    assert.throws(() => toolchainIdentity(bad, src), /toolchain/);
});

test("historical preparation reuse rejects unrelated implementation or inventory changes", () => {
  const old = json(
      join(
        ROOT,
        ".qualification/attraccess/handoff-2ff6cab/proposed-inputs.json",
      ),
    ),
    current = json(INPUTS);
  const before = json(join(old.packageRoot, "dist/build-identity.json")).files,
    after = json(join(current.packageRoot, "dist/build-identity.json")).files;
  assert.equal(verifyRuntimeComplement(before, after).length, 6);
  assert.throws(
    () =>
      verifyRuntimeComplement(before, {
        ...after,
        "dist/runner/browser.js": "0".repeat(64),
      }),
    /unrelated-runtime-change/,
  );
  assert.throws(
    () =>
      verifyRuntimeComplement(before, {
        ...after,
        "dist/extra.js": "0".repeat(64),
      }),
    /runtime-path-drift/,
  );
  assert.throws(
    () => verifyRuntimeComplement(before, before),
    /unrelated-runtime-change/,
  );
});
