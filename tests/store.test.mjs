import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../dist/index.js";
import { fixture, versions, save, pause } from "./helpers.mjs";
function worker(mode, path, dir) {
  return fork("tests/worker.mjs", [mode, path, dir], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
}
test("F01 committed input and ordered events reopen without transcript", () => {
  const { dir, store } = fixture("F01");
  const lease = store.claim("synthetic-001", "A", versions, 1000);
  store.transition(lease, "checking");
  const before = {
    run: store.get(lease.runId),
    events: store.events(lease.runId),
  };
  store.close();
  const reopened = new Store(dir + "/store.sqlite");
  const after = {
    run: reopened.get(lease.runId),
    events: reopened.events(lease.runId),
  };
  assert.deepEqual(after, before);
  save(dir, "snapshots", { before, after });
  reopened.close();
});
test("F02 concurrent process claim and stale owner cannot mutate/dispatch", async () => {
  const { dir, store } = fixture("F02");
  const children = [
    worker("claim", store.path, dir),
    worker("claim", store.path, dir),
  ];
  const results = await Promise.all(
    children.map((c) => once(c, "message").then(([m]) => m)),
  );
  await Promise.all(
    children.map((c) => (c.exitCode === null ? once(c, "exit") : null)),
  );
  assert.equal(results.filter((r) => !r.error).length, 1);
  const old = results.find((r) => !r.error);
  await pause(2050);
  const lease = store.claim(old.runId, "new", versions, 1000);
  assert.ok(lease.fence > old.fence);
  const before = { run: store.get(old.runId), events: store.events(old.runId) };
  assert.throws(
    () =>
      store.transition(old, "bad", { key: "bad", kind: "fake", payload: {} }),
    /stale-lease/,
  );
  assert.deepEqual(
    { run: store.get(old.runId), events: store.events(old.runId) },
    before,
  );
  let calls = 0;
  await assert.rejects(
    () =>
      store.dispatch(old, "bad", {
        begin: async () => {
          calls++;
          return {};
        },
      }),
    /stale-lease/,
  );
  assert.equal(calls, 0);
  save(dir, "claims", {
    results,
    lease,
    before,
    after: store.events(old.runId),
  });
  store.close();
});
test("F03 atomic rollback, killed uncommitted transaction, durable intent before send", async () => {
  const { dir, store } = fixture("F03");
  const before = store.get("synthetic-001");
  const child = worker("uncommitted", store.path, dir);
  await once(child, "message");
  child.kill("SIGKILL");
  await once(child, "exit");
  assert.deepEqual(store.get(before.id), before);
  assert.equal(store.effect("uncommitted"), undefined);
  assert.equal(store.events(before.id).length, 1);
  const lease = store.claim(before.id, "A", versions, 1000);
  const sql = new DatabaseSync(store.path);
  sql.exec(
    "CREATE TRIGGER inject BEFORE INSERT ON effects BEGIN SELECT RAISE(ABORT,'injected-fault'); END;",
  );
  const count = store.events(before.id).length;
  assert.throws(
    () =>
      store.transition(lease, "bad", {
        key: "intent",
        kind: "fake",
        payload: {},
      }),
    /injected-fault/,
  );
  assert.equal(store.get(before.id).stage, "admitted");
  assert.equal(store.events(before.id).length, count);
  sql.exec("DROP TRIGGER inject");
  sql.close();
  store.transition(lease, "delivery", {
    key: "intent",
    kind: "fake",
    payload: {},
  });
  store.close();
  const recovered = new Store(dir + "/store.sqlite");
  assert.equal(recovered.effect("intent").state, "pending");
  assert.equal(recovered.effect("intent").receipt, null);
  let calls = 0;
  await assert.rejects(
    () =>
      recovered.dispatch(lease, "absent", {
        begin: async () => {
          calls++;
          return {};
        },
      }),
    /effect-not-found/,
  );
  assert.equal(calls, 0);
  save(dir, "recovered", {
    run: recovered.get(before.id),
    intent: recovered.effect("intent"),
    events: recovered.events(before.id),
  });
  recovered.close();
});
test("F04 actual worker death after fake write reconciles once; ambiguity never resends", async () => {
  const { dir, store } = fixture("F04");
  const child = worker("effect", store.path, dir);
  await once(child, "message");
  child.kill("SIGKILL");
  await once(child, "exit");
  await pause(350);
  const lease = store.claim("synthetic-001", "B", versions, 1000);
  assert.equal(store.effect("create-draft/1").state, "sending");
  let sends = 0;
  await assert.rejects(
    () =>
      store.dispatch(lease, "create-draft/1", {
        begin: async () => {
          sends++;
          return {};
        },
      }),
    /reconciliation-required/,
  );
  let e = await store.reconcile(lease, "create-draft/1", async () => {
    throw new Error("unreadable");
  });
  assert.equal(e.state, "unresolved");
  e = await store.reconcile(lease, e.key, async () => ({
    status: "confirmed",
    receipt: JSON.parse(readFileSync(dir + "/ledger.json")),
  }));
  assert.equal(e.state, "confirmed");
  assert.equal(e.receipt.creates, 1);
  assert.equal(sends, 0);
  assert.throws(
    () =>
      store.transition(lease, "delivery", {
        key: e.key,
        kind: "draft",
        payload: { head: "changed" },
      }),
    /operation-key-conflict/,
  );
  save(dir, "reconciliation", {
    effect: e,
    events: store.events(lease.runId),
    sends,
  });
  store.close();
});
test("F05 cancellation blocks pending dispatch but allows sent reconciliation", async () => {
  const { dir, store } = fixture("F05-effects");
  const lease = store.claim("synthetic-001", "A", versions, 1000);
  store.transition(lease, "delivery", {
    key: "sent",
    kind: "fake",
    payload: {},
  });
  await store.dispatch(lease, "sent", {
    begin: async () => {
      throw new Error("lost-response");
    },
  });
  store.transition(lease, "delivery", {
    key: "pending",
    kind: "fake",
    payload: {},
  });
  store.cancel(lease.runId);
  let sends = 0;
  await assert.rejects(
    () =>
      store.dispatch(lease, "pending", {
        begin: async () => {
          sends++;
          return {};
        },
      }),
    /cancelled/,
  );
  const e = await store.reconcile(lease, "sent", async () => ({
    status: "confirmed",
    receipt: { remoteId: "prior" },
  }));
  assert.equal(e.state, "confirmed");
  assert.equal(sends, 0);
  save(dir, "cancellation", {
    run: store.get(lease.runId),
    events: store.events(lease.runId),
    effect: e,
  });
  store.close();
  const reopened = new Store(dir + "/store.sqlite");
  assert.equal(reopened.get(lease.runId).cancelled, true);
  reopened.close();
});
test("F09 incompatible claim fails before commands/effects; original stage retained", () => {
  const { dir, store } = fixture("F09");
  let lease = store.claim("synthetic-001", "A", versions, 1000);
  store.transition(lease, "checking");
  store.release(lease);
  assert.throws(
    () =>
      store.claim(lease.runId, "new", { ...versions, workflow: "wf-2" }, 1000),
    /incompatible-versions/,
  );
  lease = store.claim(lease.runId, "B", versions, 1000);
  assert.equal(store.get(lease.runId).stage, "checking");
  assert.deepEqual(store.get(lease.runId).versions, versions);
  save(dir, "compatibility", {
    run: store.get(lease.runId),
    events: store.events(lease.runId),
  });
  store.close();
});

test("dispatch seam rechecks cancellation and fencing after durable sending intent", async () => {
  for (const reason of ["cancel", "expire"]) {
    const { dir, store } = fixture("seam-" + reason);
    let time = Date.now();
    const controlled = new Store(store.path, () => time);
    store.close();
    const lease = controlled.claim("synthetic-001", "A", versions, 1000);
    controlled.transition(lease, "delivery", {
      key: "intent",
      kind: "fake",
      payload: {},
    });
    const guarded = controlled.guardedStart.bind(controlled);
    controlled.guardedStart = (l, start) => {
      if (reason === "cancel") controlled.cancel(l.runId);
      else time += 1001;
      return guarded(l, start);
    };
    let sends = 0;
    await assert.rejects(
      () =>
        controlled.dispatch(lease, "intent", {
          begin: async () => {
            sends++;
            return {};
          },
        }),
      reason === "cancel" ? /cancelled/ : /stale-lease/,
    );
    assert.equal(sends, 0);
    assert.equal(controlled.effect("intent").state, "sending");
    save(dir, "dispatch-seam", {
      reason,
      sends,
      effect: controlled.effect("intent"),
    });
    controlled.close();
  }
});
test("concurrent unknown reconciliation cannot erase confirmed receipt", async () => {
  const { store } = fixture("reconcile-race");
  const lease = store.claim("synthetic-001", "A", versions, 1000);
  store.transition(lease, "delivery", {
    key: "intent",
    kind: "fake",
    payload: {},
  });
  await store.dispatch(lease, "intent", {
    begin: async () => {
      throw new Error("lost");
    },
  });
  let release;
  const unknown = store.reconcile(
    lease,
    "intent",
    () =>
      new Promise((r) => {
        release = r;
      }),
  );
  await store.reconcile(lease, "intent", async () => ({
    status: "confirmed",
    receipt: { remoteId: "one" },
  }));
  release({ status: "unknown" });
  await unknown;
  assert.equal(store.effect("intent").state, "confirmed");
  assert.deepEqual(store.effect("intent").receipt, { remoteId: "one" });
  store.close();
});
