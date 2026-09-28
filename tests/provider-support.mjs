import { request } from "node:http";
import { fork } from "node:child_process";
import { once } from "node:events";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  createWriteStream,
} from "node:fs";
import { join } from "node:path";
import { Store, ProviderGateway, sha256 } from "../dist/index.js";
import {
  fixture,
  apply,
  versions,
  baseline,
  capability,
} from "./coordinator-support.mjs";
export { Store, ProviderGateway, sha256, apply, versions };
export const body = {
  model: "gpt-6-astra",
  reasoning: { effort: "high" },
  instructions: "Only synthetic instructions.",
  tools: [],
  input: [
    {
      role: "user",
      content: [{ type: "input_text", text: "Synthetic bounded input." }],
    },
  ],
  stream: true,
  store: false,
};
export const pause = (ms) => new Promise((r) => setTimeout(r, ms));
export async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await pause(10);
  }
  throw Error("condition-timeout");
}
export function entries(dir) {
  return existsSync(`${dir}/upstream.jsonl`)
    ? readFileSync(`${dir}/upstream.jsonl`, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(JSON.parse)
    : [];
}
export function client(url, bearer, id, requestBody, overrides = {}) {
  return new Promise((resolve, reject) => {
    const bytes =
      typeof requestBody === "string"
        ? requestBody
        : JSON.stringify(requestBody);
    const req = request(
      url,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${bearer}`,
          "x-rocky-request-id": id,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(bytes),
          ...overrides.headers,
        },
        ...overrides,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString(),
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(bytes);
  });
}
export function provider(port, hooks = {}) {
  function call(path, body, signal) {
    return new Promise((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path,
          method: "POST",
          signal,
          headers: {
            authorization: "Bearer SYNTHETIC-UPSTREAM-ONLY",
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
          },
        },
        (res) => resolve(res),
      );
      req.on("error", reject);
      req.end(body);
    });
  }
  return {
    async count(frozen, signal) {
      hooks.beforeCount?.();
      const res = await call(
        "/count",
        JSON.stringify({
          digest: frozen.digest,
          body: JSON.parse(frozen.body),
        }),
        signal,
      );
      let text = "";
      for await (const chunk of res) {
        text += chunk;
        if (text.length > 4096) throw Error("count-limit");
      }
      hooks.afterCount?.();
      return JSON.parse(text);
    },
    send(bytes, signal) {
      hooks.beforeSend?.(bytes);
      // call() initiates request.end synchronously before returning; never follows Location or retries.
      return call("/generate", bytes, signal).then((res) => ({
        status: res.statusCode,
        contentType: res.headers["content-type"] ?? "",
        body: res,
      }));
    },
  };
}
export async function fake(dir, mode = "normal") {
  const child = fork(
    join(process.cwd(), "tests/provider-http-fixture.mjs"),
    [dir, mode],
    { stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  child.stdout.pipe(createWriteStream(`${dir}/fake-stdout.log`));
  child.stderr.pipe(createWriteStream(`${dir}/fake-stderr.log`));
  const [message] = await once(child, "message");
  writeFileSync(
    `${dir}/fake-process.json`,
    JSON.stringify({
      pid: child.pid,
      mode,
      port: message.port,
      state: "listening",
    }),
  );
  return {
    child,
    port: message.port,
    async close() {
      const done = once(child, "exit");
      child.send("close");
      const exit = await done;
      writeFileSync(
        `${dir}/fake-process.json`,
        JSON.stringify({
          pid: child.pid,
          mode,
          port: message.port,
          state: "exited",
          exit,
        }),
      );
    },
  };
}
export function actionFixture(name) {
  const f = fixture(`provider-${name}`, Date.now);
  // The fixture's admission action window is intentionally 1s; fake requests fit inside it.
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
    .catch((e) => {
      f.dispatchError = e;
    });
  return { ...f, action };
}
export async function setup(name, mode = "normal", hooks = {}) {
  const f = actionFixture(name),
    upstream = await fake(f.dir, mode);
  let authority = true;
  const gateway = new ProviderGateway(
    f.store,
    f.lease,
    f.action,
    provider(upstream.port, hooks),
  );
  const approve = (id = "one", outputCap = 60, b = body) =>
    gateway.approve({
      id,
      body: b,
      outputCap,
      assertCurrent() {
        if (!authority) throw Error("revoked-image");
      },
    });
  let frozen;
  try {
    frozen = approve();
  } catch (error) {
    await upstream.close();
    f.store.close();
    throw error;
  }
  const local = await gateway.listen();
  return {
    ...f,
    upstream,
    gateway,
    approve,
    frozen,
    ...local,
    revokeAuthority() {
      authority = false;
    },
    async close() {
      await gateway.close();
      await upstream.close();
      writeFileSync(
        `${f.dir}/ledger.json`,
        JSON.stringify(
          {
            records: f.store.providerRecords(f.action.key),
            events: f.store.events(f.lease.runId),
            snapshot: f.store.coordinatorSnapshot(f.lease.runId),
          },
          null,
          2,
        ),
      );
      f.store.close();
    },
  };
}
