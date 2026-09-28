import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, symlinkSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  validateNativeInvocation,
  consumeOnce,
  inspectNativeHelpers,
  requirePositiveControl,
} from "./native-integration.mjs";
import { ROOT, NATIVE_EVIDENCE, BINARY, guard, sha } from "./common.mjs";
import { definition } from "./fixture.mjs";

guard();
const unit = join(NATIVE_EVIDENCE, `integration-selftest-${Date.now()}`);
mkdirSync(unit, { recursive: true, mode: 0o700 });
const head = "1".repeat(40);
const context = {
  root: ROOT,
  branch: "rocky-next",
  head,
  expectedHead: head,
  argv: ["--execute-ticket-64-lease-551", "--source-commit", head],
  dirty: "",
};
test("one-shot authority requires exact root/branch/commit/lease and clean source", () => {
  assert.equal(validateNativeInvocation(context).lease, 551);
  for (const patch of [
    { root: "/wrong" },
    { branch: "main" },
    { head: "2".repeat(40) },
    { expectedHead: "" },
    { dirty: " M probe.mjs" },
    { argv: ["--execute-minimal-native-probe"] },
    { argv: [...context.argv, "--permission-override"] },
  ])
    assert.throws(() => validateNativeInvocation({ ...context, ...patch }));
});
test("durable exclusive gate rejects reuse and unsafe paths before another resource dispatch", () => {
  const file = join(unit, "consumed.json"),
    receipt = validateNativeInvocation(context);
  consumeOnce(file, receipt);
  assert.deepEqual(JSON.parse(readFileSync(file)), receipt);
  assert.throws(() => consumeOnce(file, receipt), /EEXIST/);
  assert.throws(
    () => consumeOnce(join(ROOT, "wrong-gate.json"), receipt),
    /wrong-gate-root/,
  );
  assert.throws(
    () => consumeOnce(unit + "/../unsafe.json", receipt),
    /noncanonical/,
  );
  const alias = join(unit, "alias");
  symlinkSync(unit, alias);
  assert.throws(
    () => consumeOnce(join(alias, "gate.json"), receipt),
    /gate-parent-symlink/,
  );
});
test("new evidence root admits only a direct canonical attempt and unchanged recipe", () => {
  const attempt = join(NATIVE_EVIDENCE, "attempt-root-control");
  assert.equal(definition(attempt).args[0].shell, "/bin/sh");
  assert.equal(
    definition(attempt).protectedFile,
    join(attempt, "private/protected-canary.txt"),
  );
  for (const path of [
    join(NATIVE_EVIDENCE, "elsewhere/attempt-x"),
    join(ROOT, "attempt-x"),
    attempt + "/../attempt-x",
  ])
    assert.throws(() => definition(path));
});
test("positive gate stops signal, unknown, missing/wrong source or scratch effects", () => {
  const source = sha("allowed-native-control"),
    scratch = sha("allowed-scratch-control");
  requirePositiveControl(0, source, scratch);
  for (const args of [
    [134, null, null],
    [null, source, scratch],
    [0, null, scratch],
    [0, source, null],
    [0, sha("wrong"), scratch],
    [0, source, sha("wrong")],
  ])
    assert.throws(() => requirePositiveControl(...args));
});
test("helper observation binds unique generated aliases and rejects another target", () => {
  const home = join(
    NATIVE_EVIDENCE,
    `attempt-helper-unit-${Date.now()}/runtime/codex-home`,
  );
  const dir = join(home, "tmp/arg0/codex-arg0Unit");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, ".lock"), "", { mode: 0o600 });
  for (const name of ["apply_patch", "applypatch", "codex-execve-wrapper"])
    symlinkSync(BINARY, join(dir, name));
  const observation = inspectNativeHelpers(home);
  assert.equal(observation.wrapper, join(dir, "codex-execve-wrapper"));
  assert.equal(observation.entries.length, 4);
  // A second generated session is ambiguous: never guess the selected helper.
  mkdirSync(join(home, "tmp/arg0/codex-arg0Other"));
  assert.throws(() => inspectNativeHelpers(home), /missing-or-ambiguous/);
  const badHome = join(
      NATIVE_EVIDENCE,
      `attempt-helper-bad-unit-${Date.now()}/runtime/codex-home`,
    ),
    bad = join(badHome, "tmp/arg0/codex-arg0Unit");
  mkdirSync(bad, { recursive: true, mode: 0o700 });
  writeFileSync(join(bad, ".lock"), "");
  for (const name of ["apply_patch", "applypatch", "codex-execve-wrapper"])
    symlinkSync(join(unit, "not-authorized-to-read"), join(bad, name));
  assert.throws(
    () => inspectNativeHelpers(badHome),
    /unaccounted-helper-target/,
  );
});
