import test from "node:test";
import assert from "node:assert/strict";
import {
  setupStock,
  stockClient,
  entries,
  until,
  pause,
  canonical,
  sha256,
} from "./stock-support.mjs";
import {
  readStockResponse,
  freezeStockContract,
  strictJson,
} from "../dist/index.js";

test("S01 retained four-request/history/header and data-only SSE exchange uses atomic host IDs and complete charged projections", async () => {
  const f = await setupStock("retained");
  try {
    assert.equal(f.gateway.capability, null);
    assert.equal(f.baseUrl + "/responses", f.url);
    for (let i = 0; i < 4; i++) {
      const response = await stockClient(f, i);
      assert.equal(response.status, 200, response.body);
      await until(
        () =>
          f.store.providerRecords(f.action.key).at(-1).stock.forwarding ===
          "finished",
      );
    }
    const records = f.store.providerRecords(f.action.key),
      log = entries(f.dir);
    assert.equal(records.length, 4);
    assert.equal(log.length, 8);
    assert.deepEqual(
      records.map((r) => r.id),
      ["stock-1", "stock-2", "stock-3", "stock-4"],
    );
    assert.deepEqual(
      records.map((r) => r.chargedTokens),
      [13, 13, 13, 13],
    );
    for (let i = 0; i < 4; i++) {
      const { max_output_tokens, ...projection } = log[i * 2 + 1].body;
      assert.equal(max_output_tokens, 8);
      assert.deepEqual(projection, log[i * 2].body.body);
      assert.equal(records[i].usage.total, 7);
      assert.equal(records[i].usage.reasoning, 1);
      assert.equal(records[i].stock.response.cachedInput, 2);
      assert.equal(records[i].request.protocol, "stock-responses-v1");
    }
    assert.equal(
      new Set(f.ex.requests.map((r) => r.headers["x-client-request-id"])).size,
      1,
    );
  } finally {
    await f.close();
  }
});
test("S02 duplicate semantic history with fresh UUID/initial IDs and concurrent ingress never creates another charge", async () => {
  const f = await setupStock("replay", "normal");
  try {
    const responses = await Promise.all([
      stockClient(f),
      stockClient(f, 0, (r) => {
        r.headers["x-client-request-id"] = "new-uuid";
        r.body.input[0].id = "msg_another";
      }),
    ]);
    assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
    assert.equal(
      (
        await stockClient(f, 0, (r) => {
          r.headers["x-client-request-id"] = "third-uuid";
        })
      ).status,
      409,
    );
    assert.equal(
      entries(f.dir).filter((v) => v.route === "/generate").length,
      1,
    );
    assert.equal(f.store.providerRecords(f.action.key).length, 1);
  } finally {
    await f.close();
  }
});
for (const [name, edit] of [
  [
    "initial-text",
    (r) => {
      r.body.input[0].content[0].text += "unapproved";
    },
  ],
  [
    "initial-extra",
    (r) => {
      r.body.input.push({
        type: "message",
        id: "msg_new",
        role: "user",
        content: [{ type: "input_text", text: "injected" }],
      });
    },
  ],
  [
    "role-array",
    (r) => {
      r.body.input[0].role = ["developer"];
    },
  ],
  [
    "model",
    (r) => {
      r.body.model = "gpt-6-sol";
    },
  ],
  [
    "effort",
    (r) => {
      r.body.reasoning.effort = "medium";
    },
  ],
  [
    "grammar",
    (r) => {
      r.body.tools.find((t) => t.type === "custom").format.definition +=
        "changed";
    },
  ],
  [
    "schema",
    (r) => {
      r.body.text.format.schema.required = [];
    },
  ],
  [
    "server-tool",
    (r) => {
      r.body.tools.push({ type: "web_search" });
    },
  ],
  [
    "reasoning",
    (r) => {
      r.body.input.push({ type: "reasoning", encrypted_content: "opaque" });
    },
  ],
  [
    "correlation",
    (r) => {
      r.headers["thread-id"] = "changed";
    },
  ],
  [
    "duplicate-json",
    (r) => {
      const raw = JSON.stringify(r.body);
      r.body = Buffer.from('{"model":"gpt-6-astra",' + raw.slice(1));
    },
  ],
])
  test(`S03 ${name} rejects initial admission before count and record`, async () => {
    const f = await setupStock(name);
    try {
      assert.equal((await stockClient(f, 0, edit)).status, 409);
      assert.equal(entries(f.dir).length, 0);
      assert.equal(f.store.providerRecords(f.action.key).length, 0);
    } finally {
      await f.close();
    }
  });
for (const [name, edit] of [
  [
    "prefix",
    (r) => {
      r.body.input[0].content[0].text = "changed";
    },
  ],
  [
    "prefix-id",
    (r) => {
      r.body.input[0].id = "msg_changed";
    },
  ],
  [
    "call-id",
    (r) => {
      r.body.input[3].call_id = "orphan";
    },
  ],
  [
    "call-name",
    (r) => {
      r.body.input[3].name = "write_stdin";
    },
  ],
  [
    "raw-arguments",
    (r) => {
      r.body.input[3].arguments += " ";
    },
  ],
  [
    "orphan-output",
    (r) => {
      r.body.input[4].call_id = "orphan";
    },
  ],
  [
    "repeat-output",
    (r) => {
      r.body.input.push({ ...r.body.input[4], id: "fco_repeat" });
    },
  ],
  [
    "structured-output",
    (r) => {
      r.body.input[4].output = [
        { type: "input_image", image_url: "data:image/png;base64,aA==" },
      ];
    },
  ],
])
  test(`S04 ${name} history extension rejects without additional count/send`, async () => {
    const f = await setupStock(name);
    try {
      assert.equal((await stockClient(f)).status, 200);
      assert.equal((await stockClient(f, 1, edit)).status, 409);
      assert.equal(entries(f.dir).length, 2);
      assert.equal(f.store.providerRecords(f.action.key).length, 1);
    } finally {
      await f.close();
    }
  });
test("S05 terminal validation completes before any tool bytes are forwarded", async () => {
  const f = await setupStock("bad-terminal", { mode: "bad-terminal" });
  try {
    let seen = "";
    const response = await stockClient(
      f,
      0,
      () => {},
      (chunk) => (seen += chunk.toString()),
    );
    assert.equal(response.status, 409);
    assert.ok(!seen.includes("native-probe-1"));
    const [r] = f.store.providerRecords(f.action.key);
    assert.equal(r.state, "unknown");
    assert.equal(r.usage, null);
    assert.equal(r.chargedTokens, 13);
    assert.equal(r.stock.forwarding, "pending");
  } finally {
    await f.close();
  }
});
test("S06 arbitrarily fragmented data-only SSE preserves exact bytes", async () => {
  const f = await setupStock("fragment", { mode: "fragment" });
  try {
    const response = await stockClient(f);
    assert.equal(response.status, 200);
    assert.equal(response.body, f.ex.responses[0]);
  } finally {
    await f.close();
  }
});
test("S07 source-derived custom string call/output roundtrip stays causally bound to pinned grammar", async () => {
  const custom = {
    type: "custom_tool_call",
    call_id: "source-custom-1",
    name: "apply_patch",
    input:
      "*** Begin Patch\n*** Add File: synthetic.txt\n+héllo €\n*** End Patch",
  };
  const f = await setupStock("custom", {
    mode: "fragment",
    modify(ex) {
      ex.responses[0] = ex.responses[0]
        .split("\n\n")
        .map((frame) => {
          if (frame.includes("response.output_item.done"))
            return (
              "data: " +
              JSON.stringify({
                type: "response.output_item.done",
                item: custom,
              })
            );
          return frame;
        })
        .join("\n\n");
      ex.requests[1].body.input = [
        ...ex.requests[0].body.input,
        custom,
        {
          type: "custom_tool_call_output",
          call_id: custom.call_id,
          output: "Synthetic source-only result: héllo €",
        },
      ];
    },
  });
  try {
    assert.equal((await stockClient(f)).status, 200);
    assert.equal((await stockClient(f, 1)).status, 200);
    assert.equal(f.store.providerRecords(f.action.key).length, 2);
  } finally {
    await f.close();
  }
});
for (const mode of ["count-mismatch", "lost"])
  test(`S08 ${mode} preserves no-send/unknown accounting boundary`, async () => {
    const f = await setupStock(mode, { mode });
    try {
      assert.equal((await stockClient(f)).status, 409);
      const [r] = f.store.providerRecords(f.action.key);
      assert.equal(r.chargedTokens, mode === "count-mismatch" ? 0 : 13);
      assert.equal(r.state, mode === "count-mismatch" ? "rejected" : "unknown");
      assert.equal((await stockClient(f)).status, 409);
      assert.equal(
        entries(f.dir).filter((v) => v.route === "/generate").length,
        mode === "count-mismatch" ? 0 : 1,
      );
    } finally {
      await f.close();
    }
  });

for (const mutation of ["cancel", "authority", "fence", "deadline"])
  test(`S09 ${mutation} after authoritative count prevents generation`, async () => {
    let f;
    f = await setupStock(`guard-${mutation}`, {
      mode: "count-delay",
      hooks: {
        afterCount() {
          if (mutation === "cancel") f.store.cancel(f.lease.runId);
          if (mutation === "authority") f.revokeAuthority();
          if (mutation === "deadline")
            f.store.clock = () => f.action.deadline + 1;
          if (mutation === "fence") f.store.release(f.lease);
        },
      },
    });
    try {
      assert.equal((await stockClient(f)).status, 409);
      assert.equal(
        entries(f.dir).filter((v) => v.route === "/generate").length,
        0,
      );
      assert.equal(f.store.providerRecords(f.action.key)[0].chargedTokens, 0);
    } finally {
      await f.close();
    }
  });
test("S10 strict malformed UTF8 request rejects before admission/count and response rejects before forwarding", async () => {
  const f = await setupStock("utf8-request");
  try {
    assert.equal(
      (
        await stockClient(f, 0, (r) => {
          r.body = Buffer.from(JSON.stringify(r.body));
          r.body[r.body.indexOf("input_text")] = 255;
        })
      ).status,
      409,
    );
    assert.equal(entries(f.dir).length, 0);
    assert.equal(f.store.providerRecords(f.action.key).length, 0);
  } finally {
    await f.close();
  }
  const g = await setupStock("utf8-response", { mode: "invalid-utf8" });
  try {
    const r = await stockClient(g);
    assert.equal(r.status, 409);
    assert.ok(!r.body.includes("native-probe"));
    assert.equal(g.store.providerRecords(g.action.key)[0].state, "unknown");
  } finally {
    await g.close();
  }
});
test("S11 only a preauthorized next turn with exact assistant history can advance", async () => {
  const final = {
      id: "host-final",
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Synthetic done" }],
    },
    next = {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Host-authorized next turn" }],
    };
  const f = await setupStock("host-turn", {
    modify(ex) {
      const events = ex.responses[0]
        .trim()
        .split("\n\n")
        .map((v) => JSON.parse(v.slice(6)));
      events[1].item = final;
      ex.responses[0] = events
        .map((v) => `data: ${JSON.stringify(v)}\n\n`)
        .join("");
    },
    modifyContract(c) {
      c.turns.push({ id: "host-turn-2", input: [next] });
    },
  });
  const update = (r) => {
    r.body.input = [
      ...f.ex.requests[0].body.input,
      final,
      { ...next, id: "msg_next" },
    ];
    r.body.client_metadata.turn_id = "host-turn-2";
    for (const obj of [r.body.client_metadata, r.headers]) {
      const m = JSON.parse(obj["x-codex-turn-metadata"]);
      m.turn_id = "host-turn-2";
      obj["x-codex-turn-metadata"] = JSON.stringify(m);
    }
  };
  try {
    assert.equal((await stockClient(f)).status, 200);
    assert.equal(
      (
        await stockClient(f, 1, (r) => {
          update(r);
          r.body.input.at(-1).content = [
            { type: "input_text", text: "Changed content" },
          ];
        })
      ).status,
      409,
    );
    assert.equal((await stockClient(f, 1, update)).status, 200);
    assert.equal(f.store.providerRecords(f.action.key).length, 2);
  } finally {
    await f.close();
  }
});
test("S12 caller mutations cannot reauthorize initial content; restricted profile refuses retained view_image", async () => {
  const f = await setupStock("immutable");
  try {
    f.ex = structuredClone(f.ex);
    const saved = structuredClone(f.contract);
    saved.purpose = "restricted";
    assert.throws(() => freezeStockContract(saved), /tool-unavailable/);
    f.contract.turns[0].input[0].content[0].text = "unaudited";
    f.contract.profile.instructions = "changed";
    assert.equal(
      (
        await stockClient(f, 0, (r) => {
          r.body.input[0].content[0].text = "unaudited";
          r.body.input[0].id = "msg_new_authority";
        })
      ).status,
      409,
    );
    assert.equal(entries(f.dir).length, 0);
    assert.equal((await stockClient(f)).status, 200);
  } finally {
    await f.close();
  }
});
test("S13 contract rejects schema references before registration", async () => {
  const f = await setupStock("schema-reference");
  try {
    for (const key of ["$ref", "$dynamicRef", "$id"]) {
      const c = structuredClone(f.contract);
      c.profile.text.format.schema.properties.status[key] =
        "https://example.invalid/opaque";
      assert.throws(() => freezeStockContract(c), /schema-reference/);
    }
    assert.equal(entries(f.dir).length, 0);
  } finally {
    await f.close();
  }
});
test("S14 unproved native-added custom item IDs cannot extend history", async () => {
  const custom = {
    type: "custom_tool_call",
    call_id: "source-custom",
    name: "apply_patch",
    input: "*** Begin Patch\n*** End Patch",
  };
  const f = await setupStock("custom-native-id", {
    modify(ex) {
      const e = ex.responses[0]
        .trim()
        .split("\n\n")
        .map((v) => JSON.parse(v.slice(6)));
      e[1].item = custom;
      ex.responses[0] = e.map((v) => `data: ${JSON.stringify(v)}\n\n`).join("");
      ex.requests[1].body.input = [
        ...ex.requests[0].body.input,
        { ...custom, id: "ctc_unproved" },
        {
          type: "custom_tool_call_output",
          call_id: custom.call_id,
          output: "source-only",
        },
      ];
    },
  });
  try {
    assert.equal((await stockClient(f)).status, 200);
    assert.equal((await stockClient(f, 1)).status, 409);
    assert.equal(entries(f.dir).length, 2);
  } finally {
    await f.close();
  }
});
