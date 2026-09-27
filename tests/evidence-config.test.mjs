import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, unlinkSync, readFileSync } from "node:fs";
import {
  Evidence,
  configure,
  resolveCredential,
  withFreshReadiness,
} from "../dist/index.js";
import { fixture, save } from "./helpers.mjs";
const inputs = {
  head: "H",
  base: "B",
  scope: "scope-v1",
  scenario: "scenario-1",
  fixture: "fixture-1",
  command: "check",
  toolchain: "node-24",
};
test("F06 immutable receipts reject each changed input, tampering and missing artifacts", () => {
  const { dir, store } = fixture("F06");
  store.close();
  const evidence = new Evidence(dir + "/evidence");
  const artifact = evidence.put("foundation evidence\n");
  const reference = evidence.record({
    schema: 1,
    kind: "browser",
    inputs,
    outcome: "pass",
    artifacts: [artifact],
  });
  const results = {};
  assert.equal(evidence.validate(reference, inputs).valid, true);
  for (const key of Object.keys(inputs)) {
    results[key] = evidence.validate(reference, {
      ...inputs,
      [key]: "changed",
    });
    assert.equal(results[key].reason, "stale-inputs");
  }
  assert.deepEqual(evidence.put("foundation evidence\n"), artifact);
  writeFileSync(evidence.root + "/" + artifact.sha256, "tampered");
  results.tampered = evidence.validate(reference, inputs);
  assert.equal(results.tampered.reason, "evidence-integrity-failure");
  assert.throws(
    () => evidence.put("foundation evidence\n"),
    /evidence-integrity/,
  );
  unlinkSync(evidence.root + "/" + artifact.sha256);
  results.missing = evidence.validate(reference, inputs);
  assert.equal(results.missing.reason, "missing-evidence");
  save(dir, "validity", { artifact, reference, results });
});
test("F10 config provenance rejects invalid admission; credentials are references only", () => {
  const { dir, store } = fixture("F10");
  for (const bad of [
    { capacity: 2 },
    { leaseMs: 0 },
    { logBytes: NaN },
    { credentialRefs: { github: "SYNTHETIC-SECRET-DO-NOT-LOG" } },
    { secret: "SYNTHETIC-SECRET-DO-NOT-LOG" },
  ])
    assert.throws(() => configure(bad));
  assert.throws(() =>
    store.admit({
      id: "bad",
      head: "H",
      base: "B",
      scope: "S",
      versions: {},
      config: { capacity: 0 },
    }),
  );
  assert.throws(() => store.get("bad"), /run-not-found/);
  const config = configure({
    capacity: 1,
    credentialRefs: { github: "env:SYNTHETIC_TOKEN" },
  });
  const secret = resolveCredential(config.values.credentialRefs.github, {
    SYNTHETIC_TOKEN: "SYNTHETIC-SECRET-DO-NOT-LOG",
  });
  assert.equal(secret, "SYNTHETIC-SECRET-DO-NOT-LOG");
  assert.equal(JSON.stringify(config).includes(secret), false);
  assert.equal(config.provenance.capacity, "operator");
  save(dir, "config", { config, secretAbsent: true });
  store.close();
});
test("F11 historical browser pass remains valid after stop; new execution probes readiness", async () => {
  const { dir, store } = fixture("F11");
  store.close();
  const evidence = new Evidence(dir + "/evidence");
  const reference = evidence.record({
    schema: 1,
    kind: "browser",
    inputs,
    outcome: "pass",
    artifacts: [evidence.put("trace")],
  });
  let ready = true,
    executions = 0,
    polls = 0;
  await withFreshReadiness(
    async () => ready,
    async () => {
      executions++;
    },
  );
  ready = false;
  polls++;
  assert.equal(evidence.validate(reference, inputs).valid, true);
  await assert.rejects(
    () =>
      withFreshReadiness(
        async () => ready,
        async () => {
          executions++;
        },
      ),
    /service-not-ready/,
  );
  assert.equal(executions, 1);
  save(dir, "readiness", {
    polls,
    executions,
    ready,
    historical: evidence.validate(reference, inputs),
  });
});
