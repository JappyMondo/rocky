import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import {
  ROOT,
  NATIVE_EVIDENCE,
  REPAIR_EVIDENCE,
  guard,
  sha,
  fileSha,
  inventory,
  save,
} from "./common.mjs";
import { loadedConfigLayout, verifyLoadedConfig } from "./provenance.mjs";
import { verifyInventory } from "./check.mjs";

guard();
const unit = join(
  ROOT,
  ".qualification/harness-settlement-68-repair",
  `config-selftest-${Date.now()}`,
);
mkdirSync(unit, { recursive: true, mode: 0o700 });
const legacyCommit = "8930b4849eb9ae5bb2176fda9e8712826c69244c";
const legacySource = execFileSync(
  "git",
  ["show", `${legacyCommit}:acceptance/harness/check.mjs`],
  { encoding: "utf8" },
);
writeFileSync(join(unit, "legacy-check.mjs.txt"), legacySource, {
  mode: 0o400,
  flag: "wx",
});
const start = legacySource.indexOf(
  '  assert.equal(\n    fileSha(join(directory, "private/codex-home/config.toml")),',
);
const end = legacySource.indexOf(
  '  assert.deepEqual(read("cleanup.json"), observations.cleanup);',
  start,
);
assert(start > 0 && end > start);
const legacyBlock = legacySource.slice(start, end);
writeFileSync(join(unit, "legacy-config-block.js.txt"), legacyBlock, {
  mode: 0o400,
  flag: "wx",
});
// Execute the exact old config assertion, not a handwritten substitute. Scope is
// explicitly this boundary; these records never claim a full native/checker pass.
const legacyVerify = new Function(
  "assert",
  "fileSha",
  "join",
  "directory",
  "inputs",
  legacyBlock,
);
const results = [];
let fixtureId = 0;
function fixture(root = NATIVE_EVIDENCE) {
  const directory = join(unit, `case-${++fixtureId}`);
  const logicalAttempt = join(root, "attempt-config-unit");
  const layout = loadedConfigLayout(logicalAttempt);
  const config = 'default_permissions = "probe"\n';
  for (const path of new Set([layout.snapshot, layout.actual])) {
    mkdirSync(dirname(join(directory, path)), { recursive: true, mode: 0o700 });
    writeFileSync(join(directory, path), config, { mode: 0o600, flag: "wx" });
  }
  const inputs = {
    env: { CODEX_HOME: layout.codeHome },
    configSha256: sha(config),
  };
  return { directory, layout, inputs };
}
function outcome(fn) {
  try {
    fn();
    return { status: "pass" };
  } catch (e) {
    return { status: "fail", reason: e.message.split("\n")[0] };
  }
}
function retain(name, f, entries, oldResult, newResult) {
  save(join(f.directory, "case.json"), {
    name,
    inputs: f.inputs,
    independentlyDerivedLayout: f.layout,
    refreshedInventory: entries,
    oldResult,
    newResult,
  });
  results.push({
    name,
    evidenceClass: "static_config_boundary_selftest",
    scope:
      "exact old loaded-config block versus current independent verifier, not full checkAttempt",
    legacyCommit,
    legacySourceSha256: sha(legacySource),
    legacyBlockSha256: sha(legacyBlock),
    oldResult,
    newResult,
  });
  writeFileSync(
    join(unit, "results.json"),
    JSON.stringify(results, null, 2) + "\n",
    { mode: 0o600 },
  );
}
for (const [name, mutate] of [
  [
    "missing actual runtime file and inventory entry",
    (f) => unlinkSync(join(f.directory, f.layout.actual)),
  ],
  [
    "altered actual runtime with refreshed inventory",
    (f) =>
      writeFileSync(
        join(f.directory, f.layout.actual),
        'default_permissions = "other"\n',
      ),
  ],
  ["missing CODEX_HOME identity", (f) => delete f.inputs.env.CODEX_HOME],
  [
    "CODEX_HOME points to snapshot instead of runtime",
    (f) => {
      f.inputs.env.CODEX_HOME = join(
        NATIVE_EVIDENCE,
        "attempt-config-unit/private/codex-home",
      );
    },
  ],
  [
    "CODEX_HOME points to unrelated runtime",
    (f) => {
      f.inputs.env.CODEX_HOME = join(
        NATIVE_EVIDENCE,
        "attempt-other/runtime/codex-home",
      );
    },
  ],
])
  test(`SPEC65-01 old false-pass/new reject: ${name}`, () => {
    const f = fixture();
    mutate(f);
    // Rehash actual changed bytes; rejecting a stale artifact hash is insufficient.
    const entries = inventory(f.directory),
      seen = verifyInventory(f.directory, entries);
    const oldResult = outcome(() =>
      legacyVerify(assert, fileSha, join, f.directory, f.inputs),
    );
    const newResult = outcome(() =>
      verifyLoadedConfig(f.directory, f.inputs, seen, f.layout),
    );
    retain(name, f, entries, oldResult, newResult);
    assert.equal(oldResult.status, "pass");
    assert.equal(newResult.status, "fail");
  });
test("actual runtime must be inventoried even when its bytes exist", () => {
  const f = fixture(),
    entries = inventory(f.directory).filter((e) => e.path !== f.layout.actual);
  const seen = verifyInventory(f.directory, entries);
  assert.throws(
    () => verifyLoadedConfig(f.directory, f.inputs, seen, f.layout),
    /missing-loaded-config:runtime/,
  );
});
test("new and historical layouts independently derive exact runtime paths", () => {
  for (const root of [NATIVE_EVIDENCE, REPAIR_EVIDENCE]) {
    const f = fixture(root),
      seen = verifyInventory(f.directory, inventory(f.directory));
    verifyLoadedConfig(f.directory, f.inputs, seen, f.layout);
    assert.equal(
      f.layout.actual,
      root === NATIVE_EVIDENCE
        ? "runtime/codex-home/config.toml"
        : "private/codex-home/config.toml",
    );
  }
  assert.throws(
    () => loadedConfigLayout(join(ROOT, "attempt-config-unit")),
    /wrong-attempt-parent/,
  );
});
test("snapshot and actual runtime must both equal the declared config bytes", () => {
  const f = fixture();
  writeFileSync(join(f.directory, f.layout.snapshot), "changed-snapshot\n");
  let seen = verifyInventory(f.directory, inventory(f.directory));
  assert.throws(
    () => verifyLoadedConfig(f.directory, f.inputs, seen, f.layout),
    /loaded-config-changed/,
  );
  f.inputs.configSha256 = fileSha(join(f.directory, f.layout.snapshot));
  seen = verifyInventory(f.directory, inventory(f.directory));
  assert.throws(
    () => verifyLoadedConfig(f.directory, f.inputs, seen, f.layout),
    /actual-runtime-config-changed/,
  );
});
