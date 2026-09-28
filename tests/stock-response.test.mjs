import test from "node:test";
import assert from "node:assert/strict";
import { setupStock, stockClient, entries } from "./stock-support.mjs";
const decode = (raw) =>
  raw
    .trim()
    .split("\n\n")
    .map((x) => JSON.parse(x.slice(6)));
const encode = (events) =>
  events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
for (const [name, edit] of [
  ["missing-usage", (e) => delete e[2].response.usage],
  ["missing-total", (e) => delete e[2].response.usage.total_tokens],
  ["input-mismatch", (e) => (e[2].response.usage.input_tokens = 6)],
  [
    "output-cap",
    (e) => {
      e[2].response.usage.output_tokens = 9;
      e[2].response.usage.total_tokens = 14;
    },
  ],
  [
    "cache-bound",
    (e) => (e[2].response.usage.input_tokens_details.cached_tokens = 6),
  ],
  [
    "reasoning-bound",
    (e) => (e[2].response.usage.output_tokens_details.reasoning_tokens = 3),
  ],
  ["created-duplicate", (e) => e.splice(1, 0, e[0])],
  ["terminal-duplicate", (e) => e.push(e[2])],
  ["terminal-id", (e) => (e[2].response.id = "wrong")],
  ["terminal-error", (e) => (e[2].response.error = { code: "error" })],
  ["created-error", (e) => (e[0].response.error = { code: "error" })],
  ["terminal-output", (e) => (e[2].response.output = [])],
  ["duplicate-call", (e) => e.splice(2, 0, e[1])],
  [
    "unknown-event",
    (e) =>
      e.splice(2, 0, { type: "response.reasoning.delta", delta: "opaque" }),
  ],
  [
    "opaque-item",
    (e) => (e[1].item = { type: "reasoning", encrypted_content: "opaque" }),
  ],
  ["truncated", (e) => e.pop()],
  ["post-terminal", (e) => e.push(e[1])],
  ["before-created", (e) => e.reverse()],
  [
    "bad-sequence",
    (e) => {
      e[0].sequence_number = 1;
      e[1].sequence_number = 1;
    },
  ],
  ["failed", (e) => (e[2].type = "response.failed")],
])
  test(`S30 ${name} gives unknown full charge and withholds tool bytes`, async () => {
    const f = await setupStock(`parser-${name}`, {
      modify(ex) {
        const e = decode(ex.responses[0]);
        edit(e);
        ex.responses[0] = encode(e);
      },
    });
    try {
      const r = await stockClient(f);
      assert.equal(r.status, 409);
      assert.ok(!r.body.includes("native-probe-1"));
      const [record] = f.store.providerRecords(f.action.key);
      assert.equal(record.state, "unknown");
      assert.equal(record.usage, null);
      assert.equal(record.chargedTokens, 13);
      assert.equal(entries(f.dir).length, 2);
    } finally {
      await f.close();
    }
  });
for (const kind of [
  "matching-event-crlf",
  "null-errors-no-breakdowns",
  "incomplete",
  "source-added-delta",
])
  test(`S31 ${kind} explicit positive response subset`, async () => {
    const f = await setupStock(kind, {
      mode: "fragment",
      modify(ex) {
        const e = decode(ex.responses[0]);
        if (kind === "null-errors-no-breakdowns") {
          e[0].response.error = null;
          e[2].response.error = null;
          delete e[2].response.usage.input_tokens_details;
          delete e[2].response.usage.output_tokens_details;
        }
        if (kind === "incomplete") {
          e[2].type = "response.incomplete";
          e[2].response.status = "incomplete";
          e[2].response.incomplete_details = { reason: "max_output_tokens" };
        }
        if (kind === "source-added-delta") {
          const item = {
            id: "source-message",
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "héllo €" }],
          };
          e.splice(
            1,
            1,
            {
              type: "response.output_item.added",
              output_index: 0,
              item: { ...item, content: [] },
            },
            {
              type: "response.output_text.delta",
              item_id: item.id,
              output_index: 0,
              content_index: 0,
              delta: "héllo €",
            },
            { type: "response.output_item.done", output_index: 0, item },
          );
        }
        ex.responses[0] =
          kind === "matching-event-crlf"
            ? e
                .map(
                  (v) =>
                    `: comment\r\nevent: ${v.type}\r\ndata: ${JSON.stringify(v)}\r\n\r\n`,
                )
                .join("")
            : encode(e);
      },
    });
    try {
      const response = await stockClient(f);
      assert.equal(response.status, 200, response.body);
      assert.equal(response.body, f.ex.responses[0]);
      const [r] = f.store.providerRecords(f.action.key);
      assert.equal(r.usage.total, 7);
      if (kind === "null-errors-no-breakdowns") {
        assert.equal(r.usage.reasoning, null);
        assert.equal(r.stock.response.cachedInput, null);
      }
      if (kind === "incomplete") {
        assert.equal(r.state, "incomplete");
        assert.equal((await stockClient(f, 1)).status, 409);
      }
    } finally {
      await f.close();
    }
  });
for (const [kind, modify] of [
  ["event-mismatch", (raw) => "event: wrong\n" + raw],
  ["unterminated", (raw) => raw.slice(0, -1)],
  [
    "non-data-prefix",
    (raw) => Buffer.from(raw).fill(255, 0, 1).toString("latin1"),
  ],
  ["SSE-id-field", (raw) => "id: opaque\n" + raw],
])
  test(`S32 ${kind} bounded syntax rejection`, async () => {
    const f = await setupStock(kind, {
      modify(ex) {
        ex.responses[0] = modify(ex.responses[0]);
      },
    });
    try {
      assert.equal((await stockClient(f)).status, 409);
      assert.equal(f.store.providerRecords(f.action.key)[0].usage, null);
    } finally {
      await f.close();
    }
  });
for (const kind of ["response-id", "call-id"])
  test(`S33 cross-request ${kind} reuse is unknown and cannot forward`, async () => {
    const f = await setupStock(kind, {
      modify(ex) {
        const a = decode(ex.responses[0]),
          b = decode(ex.responses[1]);
        if (kind === "response-id")
          b[0].response.id = b[2].response.id = a[0].response.id;
        else b[1].item.call_id = a[1].item.call_id;
        ex.responses[1] = encode(b);
      },
    });
    try {
      assert.equal((await stockClient(f)).status, 200);
      const second = await stockClient(f, 1);
      assert.equal(second.status, 409);
      const rows = f.store.providerRecords(f.action.key);
      assert.equal(rows[1].state, "unknown");
      assert.equal(rows[1].chargedTokens, 13);
    } finally {
      await f.close();
    }
  });
test("S34 array type cannot impersonate a function call", async () => {
  const f = await setupStock("array-call", {
    modify(ex) {
      const e = decode(ex.responses[0]);
      e[1].item.type = ["function_call"];
      ex.responses[0] = encode(e);
    },
  });
  try {
    assert.equal((await stockClient(f)).status, 409);
    assert.equal(f.store.providerRecords(f.action.key)[0].usage, null);
  } finally {
    await f.close();
  }
});
for (const kind of [
  "added-without-done",
  "delta-mismatch",
  "event-limit",
  "response-limit",
])
  test(`S35 ${kind} cannot forward tool bytes`, async () => {
    const f = await setupStock(kind, {
      modify(ex) {
        const e = decode(ex.responses[0]);
        if (kind === "added-without-done")
          e.splice(1, 1, {
            type: "response.output_item.added",
            output_index: 0,
            item: {
              id: "source-msg",
              type: "message",
              role: "assistant",
              content: [],
            },
          });
        if (kind === "delta-mismatch") {
          e[1].item = {
            id: "source-msg",
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "mismatch" }],
          };
          e.splice(1, 0, {
            type: "response.output_item.added",
            output_index: 0,
            item: {
              id: "source-msg",
              type: "message",
              role: "assistant",
              content: [],
            },
          });
        }
        ex.responses[0] =
          kind === "event-limit"
            ? ":" + "x".repeat(65537) + "\n\n" + encode(e)
            : kind === "response-limit"
              ? (":" + "x".repeat(60000) + "\n\n").repeat(18) + encode(e)
              : encode(e);
      },
    });
    try {
      assert.equal((await stockClient(f)).status, 409);
      assert.equal(f.store.providerRecords(f.action.key)[0].usage, null);
    } finally {
      await f.close();
    }
  });
