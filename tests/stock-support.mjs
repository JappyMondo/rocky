import { readFileSync, writeFileSync, createWriteStream } from "node:fs";
import { fork } from "node:child_process";
import { once } from "node:events";
import { request } from "node:http";
import { join } from "node:path";
import { ProviderGateway, sha256, canonical } from "../dist/index.js";
import {
  actionFixture,
  provider,
  entries,
  pause,
  until,
} from "./provider-support.mjs";
export {
  ProviderGateway,
  sha256,
  canonical,
  actionFixture,
  provider,
  entries,
  pause,
  until,
};
export const retained = JSON.parse(
  readFileSync(new URL("./fixtures/stock-native-v1.json", import.meta.url)),
);
export function exchange() {
  const source = structuredClone(retained);
  let input = [];
  const rebind = (value) => {
    const v = JSON.parse(value);
    v.model = "gpt-6-astra";
    v.reasoning_effort = "high";
    return JSON.stringify(v);
  };
  const requests = source.requests.map((r) => {
    input = [...input, ...r.append];
    const body = {
      ...source.base,
      model: "gpt-6-astra",
      reasoning: { effort: "high" },
      input: structuredClone(input),
      client_metadata: {
        ...r.client_metadata,
        "x-codex-turn-metadata": rebind(
          r.client_metadata["x-codex-turn-metadata"],
        ),
      },
    };
    return {
      body,
      headers: {
        ...source.headers,
        "x-codex-turn-metadata": rebind(r.turnMetadataHeader),
      },
    };
  });
  const responses = source.responses.map((frames) =>
    frames
      .map((raw) => {
        const event = JSON.parse(raw.slice(6));
        if (event.type === "response.completed")
          event.response.usage = {
            input_tokens: 5,
            output_tokens: 2,
            total_tokens: 7,
            input_tokens_details: { cached_tokens: 2 },
            output_tokens_details: { reasoning_tokens: 1 },
          };
        return `data: ${JSON.stringify(event)}\n\n`;
      })
      .join(""),
  );
  return { requests, responses };
}
export function contract(f, ex) {
  const first = ex.requests[0],
    { input, prompt_cache_key, client_metadata, ...profile } = first.body,
    metadata = JSON.parse(first.headers["x-codex-turn-metadata"]),
    later = JSON.parse(ex.requests[1].headers["x-codex-turn-metadata"]);
  return {
    version: "stock-responses-v1",
    invocation: "synthetic-stock-invocation",
    actionKey: f.action.key,
    inputDigest: f.action.inputDigest,
    head: f.store.coordinatorSnapshot(f.lease.runId).head,
    role: "implementer",
    purpose: "retained-compatibility",
    identities: {
      binary: "retained-native-binary-unqualified",
      source: "36650394c5b38c2990ccf2a3457165ca3e9d9726",
      schema: "retained-440-schema",
      config: "retained-synthetic-only",
    },
    profile,
    turns: [
      { id: metadata.turn_id, input: input.map(({ id, ...item }) => item) },
    ],
    correlation: {
      thread: metadata.thread_id,
      session: metadata.session_id,
      window: metadata.window_id,
      installation: metadata.installation_id,
      workspace: Object.keys(later.workspaces)[0],
    },
    headers: {
      originator: first.headers.originator,
      userAgent: first.headers["user-agent"],
      beta: first.headers["x-codex-beta-features"],
    },
    outputCap: 8,
  };
}
export async function stockFake(dir, ex, mode = "normal") {
  writeFileSync(`${dir}/response-plan.json`, JSON.stringify(ex.responses));
  const child = fork(
    join(process.cwd(), "tests/stock-http-fixture.mjs"),
    [dir, mode],
    { stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  child.stdout.pipe(createWriteStream(`${dir}/fake-stdout.log`));
  child.stderr.pipe(createWriteStream(`${dir}/fake-stderr.log`));
  const [ready] = await once(child, "message");
  writeFileSync(
    `${dir}/fake-process.json`,
    JSON.stringify({ pid: child.pid, state: "listening", port: ready.port }),
  );
  return {
    port: ready.port,
    child,
    async close() {
      const p = once(child, "exit");
      child.send("close");
      const exit = await p;
      writeFileSync(
        `${dir}/fake-process.json`,
        JSON.stringify({
          pid: child.pid,
          state: "exited",
          exit,
          port: ready.port,
        }),
      );
    },
  };
}
export async function setupStock(
  name,
  {
    mode = "normal",
    modify = () => {},
    hooks = {},
    modifyContract = () => {},
  } = {},
) {
  const f = actionFixture(`stock-${name}`),
    ex = exchange();
  modify(ex);
  const c = contract(f, ex),
    fake = await stockFake(f.dir, ex, mode);
  modifyContract(c);
  let current = true;
  writeFileSync(
    `${f.dir}/transformation.json`,
    JSON.stringify(
      {
        fixtureSha256: sha256(
          readFileSync(
            new URL("./fixtures/stock-native-v1.json", import.meta.url),
          ),
        ),
        provenance: retained.provenance,
        requests: ex.requests.map((r) => ({
          bodySha256: sha256(canonical(r.body)),
          headersSha256: sha256(canonical(r.headers)),
        })),
        responses: ex.responses.map(sha256),
        contract: c,
      },
      null,
      2,
    ),
  );
  const gateway = new ProviderGateway(
    f.store,
    f.lease,
    f.action,
    provider(fake.port, hooks),
    {
      contract: c,
      assertCurrent() {
        if (!current) throw Error("synthetic-revoked");
      },
    },
  );
  const local = await gateway.listen();
  return {
    ...f,
    ex,
    contract: c,
    fake,
    gateway,
    ...local,
    revokeAuthority() {
      current = false;
    },
    async close() {
      await gateway.close();
      await fake.close();
      writeFileSync(
        `${f.dir}/ledger.json`,
        JSON.stringify(
          {
            records: f.store.providerRecords(f.action.key),
            events: f.store.events(f.lease.runId),
          },
          null,
          2,
        ),
      );
      f.store.close();
    },
  };
}
export function stockClient(f, index = 0, edit = () => {}, onData = () => {}) {
  const input = structuredClone(f.ex.requests[index]);
  edit(input);
  const body = Buffer.isBuffer(input.body)
    ? input.body
    : Buffer.from(JSON.stringify(input.body));
  return new Promise((resolve, reject) => {
    const req = request(
      f.url,
      {
        method: "POST",
        headers: {
          ...input.headers,
          authorization: `Bearer ${f.bearer}`,
          "content-length": body.length,
          connection: "close",
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (x) => {
          chunks.push(x);
          onData(x);
        });
        res.on("error", reject);
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}
