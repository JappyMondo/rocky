import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { Store } from "../dist/index.js";
import { setupStock, stockClient, entries, until } from "./stock-support.mjs";
const events = (raw) =>
  raw
    .trim()
    .split("\n\n")
    .map((v) => JSON.parse(v.slice(6)));
const encode = (list) =>
  list.map((v) => `data: ${JSON.stringify(v)}\n\n`).join("");
function assignProviderId(ex, responseIndex, id) {
  const e = events(ex.responses[responseIndex]);
  e[1].item.id = id;
  ex.responses[responseIndex] = encode(e);
  for (let i = responseIndex + 1; i < ex.requests.length; i++)
    ex.requests[i].body.input[3 + responseIndex * 2].id = id;
}
for (const collision of [
  "native-call",
  "native-result",
  "initial-message",
  "provider-call",
  "provider-message",
])
  test(`I84 ${collision} ID collision rejects before completion/forwarding with no refund`, async () => {
    let collisionId;
    const message = {
      id: "provider-message-first",
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Synthetic completed turn" }],
    };
    const next = {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Preauthorized second turn" }],
    };
    const f = await setupStock(`item-id-${collision}`, {
      modify(ex) {
        if (collision === "provider-call")
          assignProviderId(ex, 0, "provider-call-first");
        if (collision === "provider-message") {
          const first = events(ex.responses[0]);
          first[1].item = message;
          ex.responses[0] = encode(first);
          ex.requests[1].body.input = [
            ...ex.requests[0].body.input,
            message,
            { ...next, id: "msg_second_turn" },
          ];
          ex.requests[1].body.client_metadata.turn_id = "second-turn";
          for (const obj of [
            ex.requests[1].body.client_metadata,
            ex.requests[1].headers,
          ]) {
            const meta = JSON.parse(obj["x-codex-turn-metadata"]);
            meta.turn_id = "second-turn";
            obj["x-codex-turn-metadata"] = JSON.stringify(meta);
          }
        }
        collisionId =
          collision === "native-result"
            ? ex.requests[1].body.input[4].id
            : collision === "initial-message"
              ? ex.requests[1].body.input[0].id
              : ex.requests[1].body.input[3].id;
        assignProviderId(ex, 1, collisionId);
      },
      modifyContract(c) {
        if (collision === "provider-message")
          c.turns.push({ id: "second-turn", input: [next] });
      },
    });
    let reopened;
    try {
      assert.equal((await stockClient(f)).status, 200);
      await until(
        () =>
          f.store.providerRecords(f.action.key)[0].stock.forwarding ===
          "finished",
      );
      const first = events(f.ex.responses[0]),
        second = events(f.ex.responses[1]);
      assert.notEqual(first[0].response.id, second[0].response.id);
      assert.notEqual(first[1].item.call_id, second[1].item.call_id);
      const response = await stockClient(f, 1);
      const record = f.store.providerRecords(f.action.key)[1];
      const retry = await stockClient(f, 1);
      const nextResponse = await stockClient(f, 2);
      reopened = new Store(f.store.path);
      const durable = reopened.providerRecords(f.action.key);
      writeFileSync(
        `${f.dir}/identity-observation.json`,
        JSON.stringify(
          {
            collision,
            collisionId,
            response,
            retry,
            nextResponse,
            records: durable,
            upstream: entries(f.dir),
          },
          null,
          2,
        ),
      );
      assert.equal(
        entries(f.dir).filter((v) => v.route === "/generate").length,
        2,
      );
      assert.equal(durable.length, 2);
      assert.equal(record.chargedTokens, 13);
      assert.equal(
        durable.reduce((sum, r) => sum + r.chargedTokens, 0),
        26,
      );
      assert.equal(retry.status, 409);
      assert.equal(nextResponse.status, 409);
      assert.equal(response.status, 409);
      assert.ok(!response.body.includes("native-probe-2"));
      assert.equal(record.state, "unknown");
      assert.equal(record.usage, null);
      assert.equal(record.stock.response, null);
      assert.equal(record.stock.forwarding, "pending");
      assert.deepEqual(durable[1], record);
    } finally {
      reopened?.close();
      await f.close();
    }
  });
for (const control of [
  "retained-native-introductions",
  "distinct-provider-ids",
])
  test(`I84 ${control} preserves exact cumulative history and four charged generations`, async () => {
    const f = await setupStock(`item-id-${control}`, {
      modify(ex) {
        if (control === "distinct-provider-ids")
          for (let i = 0; i < 3; i++)
            assignProviderId(ex, i, `provider-distinct-${i}`);
      },
    });
    try {
      const responses = [];
      for (let i = 0; i < 4; i++) {
        const response = await stockClient(f, i);
        responses.push(response);
        assert.equal(response.status, 200, response.body);
        await until(
          () =>
            f.store.providerRecords(f.action.key)[i].stock.forwarding ===
            "finished",
        );
      }
      const records = f.store.providerRecords(f.action.key);
      assert.equal(records.length, 4);
      assert.equal(
        records.reduce((sum, r) => sum + r.chargedTokens, 0),
        52,
      );
      assert.equal(
        entries(f.dir).filter((v) => v.route === "/generate").length,
        4,
      );
      for (let i = 1; i < 4; i++) {
        const prior = JSON.parse(records[i - 1].request.body).input,
          current = JSON.parse(records[i].request.body).input;
        assert.deepEqual(current.slice(0, prior.length), prior);
      }
      writeFileSync(
        `${f.dir}/identity-observation.json`,
        JSON.stringify(
          { control, responses, records, upstream: entries(f.dir) },
          null,
          2,
        ),
      );
    } finally {
      await f.close();
    }
  });
