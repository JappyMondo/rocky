import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import ts from "typescript";
import { versions, apply, body } from "./provider-support.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { existsSync, writeFileSync, createWriteStream } from "node:fs";
import { Store } from "../dist/index.js";
import {
  actionFixture,
  exchange,
  contract,
  stockFake,
  stockClient,
  entries,
  until,
  canonical,
  sha256,
  setupStock,
} from "./stock-support.mjs";
for (const [stage, state, forwarding, charge, sends] of [
  ["before-admission", undefined, undefined, 0, 0],
  ["after-count", "counting", "pending", 0, 0],
  ["before-accounting", "sending", "pending", 13, 1],
  ["after-admission", "counting", "pending", 0, 0],
  ["after-reserve", "reserved", "pending", 13, 0],
  ["before-send", "sending", "pending", 13, 0],
  ["after-send", "sending", "pending", 13, 1],
  ["after-accounting", "completed", "pending", 13, 1],
  ["before-forward", "completed", "sending", 13, 1],
  ["before-forward-receipt", "completed", "sending", 13, 1],
])
  test(`S20 SIGKILL/reopen ${stage} blocks replay and premature progression`, async () => {
    const f = actionFixture(`stock-crash-${stage}`),
      ex = exchange(),
      c = contract(f, ex);
    writeFileSync(
      `${f.dir}/crash-input.json`,
      JSON.stringify({ lease: f.lease, action: f.action, contract: c }),
    );
    f.store.close();
    const fake = await stockFake(
      f.dir,
      ex,
      stage === "after-send" ? "hold" : "normal",
    );
    const child = fork(
      new URL("./stock-crash-worker.mjs", import.meta.url),
      [f.dir, stage, String(fake.port)],
      { stdio: ["ignore", "pipe", "pipe", "ipc"] },
    );
    child.stdout.pipe(createWriteStream(`${f.dir}/worker-stdout.log`));
    child.stderr.pipe(createWriteStream(`${f.dir}/worker-stderr.log`));
    let store;
    try {
      const [local] = await once(child, "message");
      const pending = stockClient({ ...local, ex }).catch((e) => ({
        disconnected: e.code,
      }));
      if (stage === "after-send")
        await until(() => entries(f.dir).some((v) => v.route === "/generate"));
      else await until(() => existsSync(`${f.dir}/window.json`));
      const death = once(child, "exit");
      child.kill("SIGKILL");
      const exit = await death;
      await pending;
      assert.equal(exit[1], "SIGKILL");
      store = new Store(`${f.dir}/state.sqlite`);
      const [r] = store.providerRecords(f.action.key);
      assert.equal(r?.state, state);
      assert.equal(r?.stock.forwarding, forwarding);
      assert.equal(r?.chargedTokens ?? 0, charge);
      assert.equal(r?.usage?.total, state === "completed" ? 7 : undefined);
      if (state)
        for (const index of [0, 1])
          assert.throws(() =>
            store.prepareStockProvider(
              f.lease,
              f.action,
              ex.requests[index].body,
              sha256(canonical(ex.requests[index].body)),
              ex.requests[index].headers,
              () => {},
            ),
          );
      assert.equal(store.providerRecords(f.action.key).length, state ? 1 : 0);
      assert.equal(
        entries(f.dir).filter((v) => v.route === "/generate").length,
        sends,
      );
      writeFileSync(
        `${f.dir}/reopened.json`,
        JSON.stringify(
          {
            stage,
            exit,
            records: store.providerRecords(f.action.key),
            events: store.events(f.lease.runId),
            upstream: entries(f.dir),
          },
          null,
          2,
        ),
      );
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const death = once(child, "exit");
        child.kill("SIGKILL");
        await death;
      }
      await fake.close();
      store?.close();
    }
  });
for (const phase of ["pending", "sending"])
  test(`S21 accounting complete but forwarding ${phase} denies a causally shaped live next request`, async () => {
    const f = await setupStock(`forward-race-${phase}`);
    const observe = f.store.observeStockForward.bind(f.store),
      forward = f.store.forwardStockProvider.bind(f.store);
    if (phase === "pending") f.store.forwardStockProvider = () => {};
    else f.store.observeStockForward = () => {};
    try {
      const first = stockClient(f).catch((e) => ({ disconnected: e.code }));
      await until(
        () => f.store.providerRecords(f.action.key)[0]?.state === "completed",
      );
      assert.equal(
        f.store.providerRecords(f.action.key)[0].stock.forwarding,
        phase,
      );
      assert.equal((await stockClient(f, 1)).status, 409);
      assert.equal(entries(f.dir).length, 2);
      assert.equal(f.store.providerRecords(f.action.key).length, 1);
      await f.gateway.close();
      await first;
    } finally {
      f.store.observeStockForward = observe;
      f.store.forwardStockProvider = forward;
      await f.close();
    }
  });
test("S22 independent Store connections and nested admission preserve one atomic progression", async () => {
  const f = await setupStock("connections"),
    other = new Store(f.store.path),
    r = f.ex.requests[0];
  try {
    const admit = (s) =>
      s.prepareStockProvider(
        f.lease,
        f.action,
        r.body,
        sha256(canonical(r.body)),
        r.headers,
        () => {},
      );
    assert.throws(
      () => f.store.guardedStart(f.lease, () => admit(f.store)),
      /inside-transaction/,
    );
    assert.equal(other.providerRecords(f.action.key).length, 0);
    admit(f.store);
    assert.throws(() => admit(other));
    assert.equal(other.providerRecords(f.action.key).length, 1);
  } finally {
    other.close();
    await f.close();
  }
});
test("S23 exact accepted schema6 source preserves provider charges and guards; old reader refuses schema7", async () => {
  const f = actionFixture("stock-schema6");
  f.store.close();
  const source = "b29416204f664d985fab2f3c830ddd0c784c9722";
  const paths = [
    "store/index",
    "store/json",
    "config/index",
    "evidence/index",
    "coordinator/contracts",
    "coordinator/reducer",
    "coordinator/migration",
    "runner/duplex",
    "runner/index",
    "runner/process",
    "agents/provider-ledger",
  ];
  for (const path of paths) {
    const code = execFileSync("git", ["show", `${source}:src/${path}.ts`], {
      encoding: "utf8",
    });
    const output = `${f.dir}/previous/${path}.js`;
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(
      output,
      ts.transpileModule(code, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2023,
          module: ts.ModuleKind.ES2022,
        },
      }).outputText,
    );
  }
  const PreviousStore = (await import(`${f.dir}/previous/store/index.js`))
    .Store;
  const previous = new PreviousStore(`${f.dir}/previous.sqlite`);
  const { admission, baseline, capability } = await import(
    "./coordinator-support.mjs"
  );
  previous.admitCoordinator(admission());
  const lease = previous.claim("run-1", "old", versions, 100000);
  const context = { ...f, store: previous, lease };
  baseline(context);
  apply(previous, lease, { type: "schedule", kind: "implement" });
  const action = previous.coordinatorSnapshot("run-1").execution;
  previous
    .dispatchCoordinator(lease, action.key, {
      versions,
      capability,
      begin() {
        return new Promise(() => {});
      },
      interrupt() {},
    })
    .catch(() => {});
  previous.prepareProvider(lease, action, "preserved", body, 60);
  previous.reserveProvider(lease, action, "preserved", 40);
  previous.cancel("run-1");
  const snapshot = (store) => ({
    provider: store.providerRecords(action.key),
    run: store.get("run-1"),
    snapshot: store.coordinatorSnapshot("run-1"),
    slot: store.implementationSlot(),
    events: store.events("run-1"),
  });
  const before = snapshot(previous);
  previous.close();
  copyFileSync(`${f.dir}/previous.sqlite`, `${f.dir}/upgraded.sqlite`);
  const next = new Store(`${f.dir}/upgraded.sqlite`);
  assert.deepEqual(snapshot(next), before);
  assert.equal(before.snapshot.budgets.reservedTokens, 100);
  assert.equal(before.run.cancelled, true);
  assert.equal(before.provider[0].chargedTokens, 100);
  assert.equal(next.stockContract(action.key), undefined);
  next.close();
  assert.throws(
    () => new PreviousStore(`${f.dir}/upgraded.sqlite`),
    /incompatible-store-schema/,
  );
  const db = new DatabaseSync(`${f.dir}/upgraded.sqlite`);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 8);
  db.close();
  writeFileSync(
    `${f.dir}/migration.json`,
    JSON.stringify(
      { source, before, preserved: true, oldReaderRefused: true },
      null,
      2,
    ),
  );
});
test("S24 rejection reply after accounting cannot mark provider bytes forwarded", async () => {
  const f = await setupStock("forward-guard");
  const finish = f.store.finishStockProvider.bind(f.store);
  f.store.finishStockProvider = (...args) => {
    const record = finish(...args);
    f.revokeAuthority();
    return record;
  };
  try {
    const response = await stockClient(f);
    writeFileSync(`${f.dir}/client-response.json`, JSON.stringify(response));
    assert.equal(response.status, 409);
    assert.ok(!response.body.includes("native-probe"));
    const [r] = f.store.providerRecords(f.action.key);
    assert.equal(r.state, "completed");
    assert.equal(r.usage.total, 7);
    assert.equal(r.stock.forwarding, "sending");
    assert.equal((await stockClient(f, 1)).status, 409);
    assert.equal(entries(f.dir).length, 2);
  } finally {
    await f.close();
  }
});
