import test from "node:test";
import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { writeFileSync } from "node:fs";
import {
  coordinatorModule,
  fixture,
  baseline,
  apply,
  versions,
  capability,
} from "./coordinator-support.mjs";
import { fake, provider, entries, body, client } from "./provider-support.mjs";
const { ProviderGateway, sha256 } = coordinatorModule;

async function setup(name) {
  const f = fixture(`strict-input-${name}`, Date.now);
  baseline(f);
  apply(f.store, f.lease, { type: "schedule", kind: "implement" });
  const action = f.store.coordinatorSnapshot(f.lease.runId).execution;
  f.store
    .dispatchCoordinator(f.lease, action.key, {
      versions,
      capability,
      begin() {
        return new Promise(() => {});
      },
      interrupt() {},
    })
    .catch((error) => {
      f.dispatchError = error;
    });
  const upstream = await fake(f.dir);
  const gateway = new ProviderGateway(
    f.store,
    f.lease,
    action,
    provider(upstream.port),
  );
  const local = await gateway.listen();
  return {
    ...f,
    action,
    gateway,
    upstream,
    ...local,
    retain(extra) {
      const observation = {
        module: process.env.COORDINATOR_TEST_MODULE ?? "../dist/index.js",
        ...extra,
        records: f.store.providerRecords(action.key),
        events: f.store.events(f.lease.runId),
        upstream: entries(f.dir),
      };
      writeFileSync(
        `${f.dir}/observation.json`,
        JSON.stringify(observation, null, 2),
      );
      return observation;
    },
    async close() {
      await gateway.close();
      await upstream.close();
      f.store.close();
    },
  };
}
for (const [name, role] of [
  ["array", ["user"]],
  ["nested-array", [["user"]]],
  ["null", null],
  ["object", { role: "user" }],
])
  test(`INPUT-01 invalid ${name} role rejects before count/send/reservation`, async () => {
    const f = await setup(name);
    try {
      const input = structuredClone(body);
      input.input[0].role = role;
      let frozen,
        rejection = null,
        response = null;
      try {
        frozen = f.gateway.approve({
          id: "one",
          body: input,
          outputCap: 60,
          assertCurrent() {},
        });
      } catch (error) {
        rejection = error.message;
      }
      // Exercise the actual effect on rejected source rather than only recording parser acceptance.
      if (frozen) response = await client(f.url, f.bearer, "one", frozen.body);
      const evidence = f.retain({
        name,
        role,
        approvalAccepted: Boolean(frozen),
        rejection,
        response,
      });
      assert.equal(evidence.approvalAccepted, false);
      assert.equal(evidence.upstream.length, 0);
      assert.equal(evidence.records.length, 0);
    } finally {
      await f.close();
    }
  });
for (const role of ["user", "developer", "assistant"])
  test(`INPUT-02 valid ${role} string keeps exact count/send projection`, async () => {
    const f = await setup(role);
    try {
      const input = structuredClone(body);
      input.input[0].role = role;
      const frozen = f.gateway.approve({
        id: "one",
        body: input,
        outputCap: 60,
        assertCurrent() {},
      });
      const response = await client(f.url, f.bearer, "one", frozen.body);
      const evidence = f.retain({ role, response });
      assert.equal(response.status, 200);
      assert.equal(evidence.upstream.length, 2);
      assert.equal(evidence.records[0].chargedTokens, 100);
      const [count, generation] = evidence.upstream;
      const { max_output_tokens, ...projection } = generation.body;
      assert.equal(max_output_tokens, 60);
      assert.equal(projection.input[0].role, role);
      assert.deepEqual(projection, count.body.body);
    } finally {
      await f.close();
    }
  });
function rawRequest(url, bearer, wire) {
  return new Promise((resolve, reject) => {
    const address = new URL(url);
    const header = Buffer.from(
      `POST /v1/responses HTTP/1.1\r\nHost: ${address.host}\r\nAuthorization: Bearer ${bearer}\r\nX-Rocky-Request-Id: one\r\nContent-Type: application/json\r\nContent-Length: ${wire.length}\r\nConnection: close\r\n\r\n`,
    );
    const socket = createConnection(
      { host: "127.0.0.1", port: Number(address.port) },
      () => socket.write(Buffer.concat([header, wire])),
    );
    const chunks = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}
for (const corrupt of [false, true])
  test(`INPUT-03 raw HTTP ${corrupt ? "invalid FF" : "canonical U+FFFD"} ${corrupt ? "rejects" : "succeeds"}`, async () => {
    const f = await setup(corrupt ? "invalid-utf8" : "canonical-utf8");
    try {
      const input = structuredClone(body);
      input.input[0].content[0].text = "Synthetic \uFFFD input.";
      const frozen = f.gateway.approve({
        id: "one",
        body: input,
        outputCap: 60,
        assertCurrent() {},
      });
      const approved = Buffer.from(frozen.body, "utf8");
      const offset = approved.indexOf(Buffer.from([0xef, 0xbf, 0xbd]));
      assert.ok(offset >= 0);
      const wire = corrupt
        ? Buffer.concat([
            approved.subarray(0, offset),
            Buffer.from([0xff]),
            approved.subarray(offset + 3),
          ])
        : approved;
      assert.equal(wire.toString("utf8"), frozen.body);
      assert.equal(wire.equals(approved), !corrupt);
      writeFileSync(`${f.dir}/approved-body.bin`, approved);
      writeFileSync(`${f.dir}/wire-body.bin`, wire);
      const response = await rawRequest(f.url, f.bearer, wire);
      const evidence = f.retain({
        corrupt,
        approvedSha256: sha256(approved),
        wireSha256: sha256(wire),
        approvedBytes: approved.length,
        wireBytes: wire.length,
        response,
      });
      assert.match(response, corrupt ? /^HTTP\/1\.1 409 / : /^HTTP\/1\.1 200 /);
      if (corrupt) {
        assert.equal(evidence.upstream.length, 0);
        assert.equal(evidence.records.length, 0);
      } else {
        assert.equal(evidence.upstream.length, 2);
        assert.equal(evidence.records[0].chargedTokens, 100);
        const { max_output_tokens, ...projection } = evidence.upstream[1].body;
        assert.equal(max_output_tokens, 60);
        assert.deepEqual(projection, evidence.upstream[0].body.body);
        assert.equal(
          projection.input[0].content[0].text,
          "Synthetic \uFFFD input.",
        );
      }
    } finally {
      await f.close();
    }
  });
