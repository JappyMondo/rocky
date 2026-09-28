import test from "node:test";
import assert from "node:assert/strict";
import { fork, execFileSync } from "node:child_process";
import { once } from "node:events";
import {
  createWriteStream,
  existsSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  copyFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import ts from "typescript";
import {
  actionFixture,
  fake,
  client,
  entries,
  until,
  Store,
  ProviderGateway,
  body,
  provider,
  versions,
  apply,
} from "./provider-support.mjs";
for (const [stage, state, charge, sends] of [
  ["before-prepare", undefined, 0, 0],
  ["before-count", "counting", 0, 0],
  ["before-reserve", "counting", 0, 0],
  ["after-reserve", "reserved", 100, 0],
  ["before-send", "sending", 100, 0],
  ["after-send", "sending", 100, 1],
  ["before-receipt", "sending", 100, 1],
  ["after-receipt", "completed", 100, 1],
])
  test(`L01 actual SIGKILL/reopen ${stage}: durable identity never blindly replayed`, async () => {
    const f = actionFixture(`crash-${stage}`);
    writeFileSync(
      `${f.dir}/crash-input.json`,
      JSON.stringify({ lease: f.lease, action: f.action }),
    );
    f.store.close();
    const upstream = await fake(
      f.dir,
      stage === "after-send" ? "forever" : "normal",
    );
    const child = fork(
      join(process.cwd(), "tests/provider-crash-worker.mjs"),
      [f.dir, stage, String(upstream.port)],
      { stdio: ["ignore", "pipe", "pipe", "ipc"] },
    );
    child.stdout.pipe(createWriteStream(`${f.dir}/worker-stdout.log`));
    child.stderr.pipe(createWriteStream(`${f.dir}/worker-stderr.log`));
    let store;
    try {
      const [local] = await once(child, "message");
      const pending = client(
        local.url,
        local.bearer,
        "crash",
        local.body,
      ).catch((e) => ({ disconnected: e.code }));
      if (stage === "after-send")
        await until(() => entries(f.dir).some((e) => e.route === "/generate"));
      else await until(() => existsSync(`${f.dir}/window.json`));
      const death = once(child, "exit");
      child.kill("SIGKILL");
      const exit = await death;
      await pending;
      assert.equal(exit[1], "SIGKILL");
      store = new Store(`${f.dir}/state.sqlite`);
      const rows = store.providerRecords(f.action.key);
      assert.equal(rows[0]?.state, state);
      assert.equal(
        rows.reduce((sum, r) => sum + r.chargedTokens, 0),
        charge,
      );
      assert.equal(
        rows[0]?.usage?.total,
        state === "completed" ? 45 : undefined,
      );
      assert.equal(
        entries(f.dir).filter((e) => e.route === "/generate").length,
        sends,
      );
      if (state) {
        assert.throws(
          () => store.prepareProvider(f.lease, f.action, "crash", body, 60),
          /reconciliation/,
        );
        if (state !== "completed")
          assert.throws(
            () =>
              store.prepareProvider(f.lease, f.action, "new-attempt", body, 1),
            /outstanding/,
          );
        else {
          store.prepareProvider(f.lease, f.action, "new-attempt", body, 1);
          assert.throws(
            () => store.reserveProvider(f.lease, f.action, "new-attempt", 40),
            /budget/,
          );
        }
      }
      assert.equal(
        entries(f.dir).filter((e) => e.route === "/generate").length,
        sends,
      );
      assert.ok(store.implementationSlot());
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
      await upstream.close();
      store?.close();
    }
  });
test("L02 final actual-dispatch guard rejects authority invalidation after reservation without refund", async () => {
  const f = actionFixture("guard-reserve");
  try {
    f.store.prepareProvider(f.lease, f.action, "one", body, 60);
    f.store.reserveProvider(f.lease, f.action, "one", 40);
    let sends = 0;
    assert.throws(
      () =>
        f.store.dispatchProvider(
          f.lease,
          f.action,
          "one",
          () => {
            f.store.cancel(f.lease.runId);
          },
          () => {
            sends++;
          },
        ),
      /cancelled/,
    );
    assert.equal(sends, 0);
    assert.equal(f.store.providerRecords(f.action.key)[0].state, "sending");
    assert.equal(f.store.providerRecords(f.action.key)[0].chargedTokens, 100);
    assert.throws(
      () =>
        f.store.dispatchProvider(
          f.lease,
          f.action,
          "one",
          () => {},
          () => {
            sends++;
          },
        ),
      /send-state/,
    );
  } finally {
    writeFileSync(
      `${f.dir}/ledger.json`,
      JSON.stringify(f.store.providerRecords(f.action.key), null, 2),
    );
    f.store.close();
  }
});
test("L03 monotonic revoke persists across close/reopen and blocks new gateway identity", async () => {
  const f = actionFixture("revoke");
  f.store.revokeProviderAction(f.action);
  f.store.close();
  const store = new Store(`${f.dir}/state.sqlite`);
  try {
    assert.throws(
      () =>
        new ProviderGateway(store, f.lease, f.action, {
          count() {
            throw Error("must not count");
          },
          send() {
            throw Error("must not send");
          },
        }),
      /revoked/,
    );
    assert.equal(
      store.events(f.lease.runId).filter((e) => e.kind === "provider-revoked")
        .length,
      1,
    );
  } finally {
    store.close();
  }
});
test("L04 nested dispatch/reservation cannot roll back a charge around an external side effect", () => {
  const f = actionFixture("nested");
  try {
    assert.throws(
      () =>
        f.store.guardedStart(f.lease, () =>
          f.store.prepareProvider(f.lease, f.action, "one", body, 60),
        ),
      /inside-transaction/,
    );
    f.store.prepareProvider(f.lease, f.action, "one", body, 60);
    assert.throws(
      () =>
        f.store.guardedStart(f.lease, () =>
          f.store.reserveProvider(f.lease, f.action, "one", 40),
        ),
      /inside-transaction/,
    );
    f.store.reserveProvider(f.lease, f.action, "one", 40);
    assert.throws(
      () =>
        f.store.guardedStart(f.lease, () =>
          f.store.dispatchProvider(
            f.lease,
            f.action,
            "one",
            () => {},
            () => {},
          ),
        ),
      /inside-transaction/,
    );
    assert.equal(f.store.providerRecords(f.action.key)[0].chargedTokens, 100);
  } finally {
    f.store.close();
  }
});
test("L05 exact schema5 source migration preserves cancellation, slot, action and reservations; old reader refuses schema7", async () => {
  const f = actionFixture("schema5");
  f.store.close();
  const source = "10bda64f6d91a13826e9ec047b7f787eda0476a7";
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
  previous.cancel("run-1");
  const snapshot = (store) => ({
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

test("L06 synchronous send throw remains sending and never refunds or replays", () => {
  const f = actionFixture("send-throw");
  try {
    f.store.prepareProvider(f.lease, f.action, "one", body, 60);
    f.store.reserveProvider(f.lease, f.action, "one", 40);
    let calls = 0;
    assert.throws(
      () =>
        f.store.dispatchProvider(
          f.lease,
          f.action,
          "one",
          () => {},
          () => {
            calls++;
            throw Error("synthetic send uncertainty");
          },
        ),
      /uncertainty/,
    );
    assert.throws(
      () =>
        f.store.dispatchProvider(
          f.lease,
          f.action,
          "one",
          () => {},
          () => {
            calls++;
          },
        ),
      /send-state/,
    );
    assert.equal(calls, 1);
    assert.equal(f.store.providerRecords(f.action.key)[0].chargedTokens, 100);
    assert.equal(f.store.providerRecords(f.action.key)[0].state, "sending");
  } finally {
    f.store.close();
  }
});
test("L07 independent connections cannot reserve simultaneous requests on the same action", () => {
  const f = actionFixture("two-connections"),
    other = new Store(f.store.path);
  try {
    f.store.prepareProvider(f.lease, f.action, "first", body, 60);
    assert.throws(
      () => other.prepareProvider(f.lease, f.action, "second", body, 60),
      /outstanding/,
    );
    f.store.reserveProvider(f.lease, f.action, "first", 40);
    assert.throws(
      () => other.reserveProvider(f.lease, f.action, "first", 40),
      /reservation-state/,
    );
    assert.equal(
      other
        .providerRecords(f.action.key)
        .reduce((n, r) => n + r.chargedTokens, 0),
      100,
    );
  } finally {
    other.close();
    f.store.close();
  }
});
