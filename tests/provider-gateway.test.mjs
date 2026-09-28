import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { createConnection } from "node:net";
import { freezeProviderRequest, ProviderGateway } from "../dist/index.js";
import {
  setup,
  client,
  entries,
  until,
  pause,
  body,
  apply,
  Store,
  versions,
} from "./provider-support.mjs";

test("G01 real HTTP exact immutable projection, charged boundary and secret-free durable receipts", async () => {
  const f = await setup("exact");
  try {
    assert.equal(f.gateway.capability, null);
    const response = await client(f.url, f.bearer, "one", f.frozen.body);
    assert.equal(response.status, 200);
    const [count, send] = entries(f.dir);
    const { max_output_tokens, ...projection } = send.body;
    assert.equal(max_output_tokens, 60);
    assert.deepEqual(projection, count.body.body);
    const [record] = f.store.providerRecords(f.action.key);
    assert.equal(record.chargedTokens, 100);
    assert.equal(record.usage.total, 45);
    assert.equal(record.usage.reasoning, 3);
    const states = f.store
      .events(f.lease.runId)
      .filter((e) => e.kind === "provider-transition")
      .map((e) => e.data.state);
    assert.deepEqual(states, ["counting", "reserved", "sending", "completed"]);
    const persisted = JSON.stringify({
      record,
      events: f.store.events(f.lease.runId),
    });
    assert.ok(!persisted.includes(f.bearer));
    assert.ok(!persisted.includes("SYNTHETIC-UPSTREAM-ONLY"));
    assert.equal(
      (await client(f.url, f.bearer, "one", f.frozen.body)).status,
      409,
    );
    f.approve("two", 1);
    assert.equal(
      (await client(f.url, f.bearer, "two", f.frozen.body)).status,
      409,
    );
    assert.equal(
      entries(f.dir).filter((e) => e.route === "/generate").length,
      1,
    );
    assert.equal(
      f.store
        .providerRecords(f.action.key)
        .reduce((s, r) => s + r.chargedTokens, 0),
      100,
    );
  } finally {
    await f.close();
  }
});
for (const mode of ["count-fail", "count-malformed", "count-mismatch"])
  test(`G02 ${mode} forbids send and preserves rejection`, async () => {
    const f = await setup(mode, mode);
    try {
      assert.equal(
        (await client(f.url, f.bearer, "one", f.frozen.body)).status,
        409,
      );
      assert.equal(entries(f.dir).length, 1);
      assert.equal(f.store.providerRecords(f.action.key)[0].chargedTokens, 0);
      assert.equal(f.store.providerRecords(f.action.key)[0].state, "rejected");
    } finally {
      await f.close();
    }
  });
test("G03 concurrent duplicate and separately approved generation have one outstanding charge", async () => {
  const f = await setup("concurrent", "delay");
  try {
    f.approve("two", 10);
    const first = client(f.url, f.bearer, "one", f.frozen.body);
    await until(() => entries(f.dir).some((e) => e.route === "/generate"));
    const responses = await Promise.all([
      client(f.url, f.bearer, "one", f.frozen.body),
      client(f.url, f.bearer, "two", f.frozen.body),
    ]);
    assert.deepEqual(
      responses.map((r) => r.status),
      [409, 409],
    );
    assert.equal((await first).status, 200);
    assert.equal(
      entries(f.dir).filter((e) => e.route === "/generate").length,
      1,
    );
  } finally {
    await f.close();
  }
});
for (const mutation of [
  "cancel",
  "image",
  "revoke",
  "fence",
  "deadline",
  "revise",
])
  test(`G04 ${mutation} after count prevents actual generation`, async () => {
    let f;
    f = await setup(mutation, "count-delay", {
      afterCount() {
        if (mutation === "cancel") f.store.cancel(f.lease.runId);
        if (mutation === "image") f.revokeAuthority();
        if (mutation === "revoke") f.gateway.revoke();
        if (mutation === "deadline")
          f.store.clock = () => f.action.deadline + 1;
        if (mutation === "fence") {
          f.store.release(f.lease);
          f.store.claim(f.lease.runId, "other", versions, 1000000);
        }
        if (mutation === "revise") {
          const s = f.store.coordinatorSnapshot(f.lease.runId);
          apply(f.store, f.lease, {
            type: "revise",
            head: "new-head",
            scope: s.scope,
            checkPlan: s.checkPlan,
          });
        }
      },
    });
    try {
      assert.equal(
        (await client(f.url, f.bearer, "one", f.frozen.body)).status,
        409,
      );
      assert.equal(
        entries(f.dir).filter((e) => e.route === "/generate").length,
        0,
      );
      assert.equal(f.store.providerRecords(f.action.key)[0].state, "rejected");
    } finally {
      await f.close();
    }
  });
for (const mode of [
  "lost",
  "unknown",
  "partial",
  "redirect",
  "usage-over",
  "bad-model",
  "late",
  "oversize",
  "event-oversize",
  "too-many-events",
])
  test(`G05 ${mode} retains full charge and blocks all replay/new attempts`, async () => {
    const f = await setup(mode, mode);
    try {
      assert.equal(
        (await client(f.url, f.bearer, "one", f.frozen.body)).status,
        409,
      );
      const [r] = f.store.providerRecords(f.action.key);
      assert.equal(r.state, "unknown");
      assert.equal(r.usage, null);
      assert.equal(r.chargedTokens, 100);
      f.approve("two", 1);
      assert.equal(
        (await client(f.url, f.bearer, "two", f.frozen.body)).status,
        409,
      );
      assert.equal(
        entries(f.dir).filter((e) => e.route === "/generate").length,
        1,
      );
    } finally {
      await f.close();
    }
  });
test("G06 incomplete terminal usage remains incomplete with full charge", async () => {
  const f = await setup("incomplete", "incomplete");
  try {
    assert.equal(
      (await client(f.url, f.bearer, "one", f.frozen.body)).status,
      200,
    );
    const [r] = f.store.providerRecords(f.action.key);
    assert.equal(r.state, "incomplete");
    assert.equal(r.chargedTokens, 100);
    assert.equal(r.usage.total, 45);
  } finally {
    await f.close();
  }
});
test("G07 forbidden paths/method/auth/opaque body drift never count or generate", async () => {
  const f = await setup("denials");
  try {
    for (const path of [
      "/v1/responses?x=1",
      "/v1/responses/",
      "/v1/compact",
      "/v1/files",
      "/v1/responses/input_tokens",
    ])
      assert.equal(
        (
          await client(
            f.url.replace("/v1/responses", path),
            f.bearer,
            "one",
            f.frozen.body,
          )
        ).status,
        409,
      );
    assert.equal(
      (await client(f.url, "wrong", "one", f.frozen.body)).status,
      409,
    );
    assert.equal(
      (await client(f.url, f.bearer, "one", f.frozen.body, { method: "GET" }))
        .status,
      409,
    );
    assert.equal(
      (await client(f.url, f.bearer, "one", f.frozen.body + " ")).status,
      409,
    );
    assert.equal(
      (
        await client(
          f.url,
          f.bearer,
          "one",
          JSON.stringify({ ...body, model: "gpt-6-sol" }),
        )
      ).status,
      409,
    );
    assert.equal(entries(f.dir).length, 0);
    assert.equal(f.store.providerRecords(f.action.key).length, 0);
  } finally {
    await f.close();
  }
});
test("G08 strict body projection rejects remote state, auxiliary tools and model/effort drift", () => {
  const invalid = [
    { ...body, previous_response_id: "opaque" },
    { ...body, attachments: [] },
    { ...body, max_output_tokens: 50 },
    { ...body, model: "gpt-6-sol" },
    { ...body, reasoning: { effort: "low" } },
    { ...body, tools: [{ type: "web_search" }] },
    {
      ...body,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_image",
              image_url: "https://example.invalid/image.png",
              detail: "high",
            },
          ],
        },
      ],
    },
  ];
  for (const value of invalid)
    assert.throws(() => freezeProviderRequest(value));
});
test("G09 image-bearing count/send bytes are identical and caller mutation cannot alter frozen approval", async () => {
  const f = await setup("image");
  try {
    const image = structuredClone(body);
    image.input[0].content.push({
      type: "input_image",
      image_url:
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=",
      detail: "high",
    });
    const frozen = f.approve("image", 20, image);
    image.input[0].content[1].image_url = "https://forbidden.invalid/image";
    assert.equal(
      (await client(f.url, f.bearer, "image", frozen.body)).status,
      200,
    );
    const rows = entries(f.dir),
      { max_output_tokens, ...sent } = rows[1].body;
    assert.deepEqual(sent, rows[0].body.body);
    assert.equal(
      f.store.providerRecords(f.action.key)[0].request.images.length,
      1,
    );
  } finally {
    await f.close();
  }
});
test("G10 cancellation while provider continues preserves charge and unknown usage", async () => {
  const f = await setup("continued", "continued");
  try {
    const pending = client(f.url, f.bearer, "one", f.frozen.body);
    await until(() => entries(f.dir).some((e) => e.route === "/generate"));
    f.store.cancel(f.lease.runId);
    f.gateway.revoke();
    assert.equal((await pending).status, 409);
    await pause(300);
    const [r] = f.store.providerRecords(f.action.key);
    assert.equal(r.state, "unknown");
    assert.equal(r.chargedTokens, 100);
    assert.equal(r.usage, null);
    assert.ok(
      readFileSync(`${f.dir}/upstream-completion.jsonl`, "utf8").includes(
        "continued",
      ),
    );
  } finally {
    await f.close();
  }
});
test("G11 send side effect observes committed reservation in an independent SQLite reader", async () => {
  let f;
  f = await setup("commit", "normal", {
    beforeSend(bytes) {
      const other = new DatabaseSync(f.store.path, { readOnly: true });
      try {
        const r = JSON.parse(
          other
            .prepare("SELECT data FROM provider_requests WHERE action_key=?")
            .get(f.action.key).data,
        );
        assert.equal(r.state, "sending");
        assert.equal(r.chargedTokens, 100);
        assert.equal(JSON.parse(bytes).max_output_tokens, 60);
      } finally {
        other.close();
      }
    },
  });
  try {
    assert.equal(
      (await client(f.url, f.bearer, "one", f.frozen.body)).status,
      200,
    );
  } finally {
    await f.close();
  }
});

for (const mode of ["count-lost", "forever"])
  test(`G12 ${mode} is bounded by action deadline and cannot refund or retry`, async () => {
    const f = await setup(mode, mode);
    try {
      const response = await client(
        f.url,
        f.bearer,
        "one",
        f.frozen.body,
      ).catch((e) => ({ disconnected: e.code }));
      await until(
        () =>
          !["counting", "reserved", "sending"].includes(
            f.store.providerRecords(f.action.key)[0]?.state,
          ),
      );
      const [r] = f.store.providerRecords(f.action.key);
      assert.equal(r.state, mode === "count-lost" ? "rejected" : "unknown");
      assert.equal(r.chargedTokens, mode === "count-lost" ? 0 : 100);
      assert.equal(r.usage, null);
      assert.ok(response.disconnected || response.status === 409);
    } finally {
      await f.close();
    }
  });
test("G13 request body bound and forbidden framing/headers fail before count", async () => {
  const f = await setup("body-limit");
  try {
    const bytes = "x".repeat(2097153);
    const refused = await client(f.url, f.bearer, "one", bytes).catch(
      (error) => ({ code: error.code }),
    );
    assert.ok(
      refused.status === 409 || ["EPIPE", "ECONNRESET"].includes(refused.code),
    );
    const headers = {
      authorization: `Bearer ${f.bearer}`,
      "x-rocky-request-id": "one",
      "content-type": "application/json",
      "content-length": Buffer.byteLength(f.frozen.body),
      "x-forwarded-host": "elsewhere",
    };
    assert.equal(
      (await client(f.url, f.bearer, "one", f.frozen.body, { headers })).status,
      409,
    );
    assert.equal(entries(f.dir).length, 0);
  } finally {
    await f.close();
  }
});
test("G14 complete image/tool/instruction/model input is frozen; unsupported schema references fail", () => {
  const tools = [
    {
      type: "function",
      name: "local_read",
      description: "A local tool only.",
      strict: true,
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
    },
  ];
  const value = { ...structuredClone(body), tools };
  const frozen = freezeProviderRequest(value);
  tools[0].description = "changed";
  assert.ok(frozen.body.includes("A local tool only."));
  assert.throws(() =>
    freezeProviderRequest({
      ...body,
      tools: [
        {
          ...tools[0],
          parameters: { type: "object", $ref: "https://opaque.invalid/schema" },
        },
      ],
    }),
  );
});

test("G15 separate approved attempts each retain full count plus cap after successful receipt", async () => {
  const f = await setup("sum");
  try {
    for (const id of ["first", "second"]) {
      const request = f.approve(id, 10);
      assert.equal(
        (await client(f.url, f.bearer, id, request.body)).status,
        200,
      );
    }
    const records = f.store.providerRecords(f.action.key);
    assert.deepEqual(
      records.map((r) => r.chargedTokens),
      [50, 50],
    );
    assert.deepEqual(
      records.map((r) => r.usage.total),
      [45, 45],
    );
    assert.equal(
      (await client(f.url, f.bearer, "one", f.frozen.body)).status,
      409,
    );
    assert.equal(
      entries(f.dir).filter((r) => r.route === "/generate").length,
      2,
    );
  } finally {
    await f.close();
  }
});
async function raw(url, data) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url),
      socket = createConnection(
        { host: "127.0.0.1", port: Number(parsed.port) },
        () => socket.end(data),
      );
    let response = "";
    socket.on("data", (bytes) => (response += bytes));
    socket.on("error", (e) => {
      if (e.code === "ECONNRESET") resolve(response);
      else reject(e);
    });
    socket.on("close", () => resolve(response));
  });
}
test("G16 actual malformed/duplicate/framing/upgrade/CONNECT and partial request attempts are retained without upstream sends", async () => {
  const f = await setup("raw");
  try {
    const host = new URL(f.url).host;
    const headers = `Host: ${host}\r\nAuthorization: Bearer ${f.bearer}\r\nX-Rocky-Request-Id: one\r\nContent-Type: application/json\r\n`;
    for (const wire of [
      `CONNECT ${host} HTTP/1.1\r\nHost: ${host}\r\n\r\n`,
      `GET /v1/responses HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
      `POST /v1/responses HTTP/1.1\r\n${headers}Content-Length: 2\r\nContent-Length: 2\r\n\r\n{}`,
      `POST /v1/responses HTTP/1.1\r\n${headers}Transfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n`,
      `POST /v1/responses HTTP/1.1\r\n${headers}Content-Length: 50\r\n\r\n{"partial":`,
    ])
      await raw(f.url, wire);
    await pause(20);
    assert.equal(entries(f.dir).length, 0);
    const events = f.store
      .events(f.lease.runId)
      .filter((e) => e.kind === "provider-ingress")
      .map((e) => e.data);
    assert.ok(events.some((e) => e.outcome === "unsupported-connect"));
    assert.ok(events.some((e) => e.outcome === "unsupported-upgrade"));
    assert.ok(events.some((e) => e.outcome === "malformed-http"));
    assert.ok(events.some((e) => e.bytes === 11 && e.outcome === "rejected"));
  } finally {
    await f.close();
  }
});

test("G17 finite ingress admission exhausts and durably revokes without count or unbounded audit", async () => {
  const f = await setup("ingress-limit");
  try {
    for (let i = 0; i < 64; i++)
      assert.equal(
        (await client(f.url, "invalid", "one", f.frozen.body)).status,
        409,
      );
    await assert.rejects(
      client(f.url, "invalid", "one", f.frozen.body),
      (error) => ["ECONNRESET", "ECONNREFUSED", "EPIPE"].includes(error.code),
    );
    assert.equal(entries(f.dir).length, 0);
    assert.throws(
      () => f.store.assertProviderAction(f.lease, f.action),
      /revoked/,
    );
    const audit = f.store
      .events(f.lease.runId)
      .filter((e) => e.kind === "provider-ingress");
    assert.ok(audit.length <= 65);
  } finally {
    await f.close();
  }
});
