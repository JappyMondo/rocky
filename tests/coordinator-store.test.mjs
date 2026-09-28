import test from "node:test";
import assert from "node:assert/strict";
import { fork, execFileSync } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import ts from "typescript";
import { Store, canonical } from "../dist/index.js";
import {
  fixture,
  admission,
  versions,
  apply,
  result,
  retain,
  baseline,
  finish,
  capability,
} from "./coordinator-support.mjs";
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
function worker(mode, path, id) {
  return fork(
    "tests/coordinator-worker.mjs",
    [mode, path, ...(id ? [id] : [])],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
}
async function race(mode, path, ids) {
  const cs = ids.map((id) => worker(mode, path, id));
  const messages = await Promise.all(
    cs.map((c) => once(c, "message").then(([m]) => m)),
  );
  await Promise.all(
    cs.map((c) => (c.exitCode === null ? once(c, "exit") : null)),
  );
  return messages;
}

test("C01 schema8 fresh/copy migration retains v1 events/effects/commands; unknown versions reject", async () => {
  const f = fixture("C01");
  f.store.close();
  const db = new DatabaseSync(f.dir + "/v1.sqlite");
  db.exec(
    `PRAGMA user_version=1; CREATE TABLE runs(id TEXT PRIMARY KEY,data TEXT NOT NULL,owner TEXT,fence INTEGER NOT NULL DEFAULT 0,expires INTEGER NOT NULL DEFAULT 0); CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL REFERENCES runs(id),kind TEXT NOT NULL,data TEXT NOT NULL,at INTEGER NOT NULL); CREATE TABLE effects(key TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),data TEXT NOT NULL); CREATE TABLE commands(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),data TEXT NOT NULL);`,
  );
  db.close();
  const original = new Store(f.dir + "/v1.sqlite");
  original.admit({ id: "legacy", head: "h", base: "b", scope: "s", versions });
  const lease = original.claim("legacy", "old", versions, 10000);
  original.transition(lease, "test", {
    key: "legacy-intent",
    kind: "fake",
    payload: { keep: true },
  });
  original.reserveCommand(lease, "legacy-command", "token", {});
  const before = {
    run: original.get("legacy"),
    events: original.events("legacy"),
    effect: original.effect("legacy-intent"),
    commands: original.commands("legacy"),
  };
  original.close();
  const v1 = new DatabaseSync(f.dir + "/v1.sqlite");
  v1.exec(
    "DROP TABLE coordinator_slot; DROP TABLE coordinator_receipts; DROP TABLE coordinator_inbox; DROP TABLE coordinator_reruns; DROP TABLE coordinator_issues; DROP TABLE coordinator_snapshots; PRAGMA user_version=1;",
  );
  v1.close();
  const originalBytes = readFileSync(f.dir + "/v1.sqlite");
  copyFileSync(f.dir + "/v1.sqlite", f.dir + "/copy.sqlite");
  const migrated = new Store(f.dir + "/copy.sqlite");
  assert.deepEqual(
    {
      run: migrated.get("legacy"),
      events: migrated.events("legacy"),
      effect: migrated.effect("legacy-intent"),
      commands: migrated.commands("legacy"),
    },
    before,
  );
  migrated.admitCoordinator(admission("new"));
  migrated.close();
  assert.deepEqual(readFileSync(f.dir + "/v1.sqlite"), originalBytes);
  const priorSource = execFileSync(
    "git",
    ["show", "def72ec1d8d73aa6f37944f4f5d31b4879d58d44:src/store/index.ts"],
    { encoding: "utf8" },
  );
  const oldDir = f.dir + "/old-reader";
  mkdirSync(oldDir);
  mkdirSync(oldDir + "/store");
  mkdirSync(oldDir + "/config");
  writeFileSync(
    oldDir + "/store/index.mjs",
    ts.transpileModule(priorSource, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ES2022,
      },
    }).outputText,
  );
  copyFileSync("dist/store/json.js", oldDir + "/store/json.js");
  copyFileSync("dist/config/index.js", oldDir + "/config/index.js");
  const OldStore = (await import(oldDir + "/store/index.mjs")).Store;
  assert.throws(
    () => new OldStore(f.dir + "/copy.sqlite"),
    /incompatible-store-schema/,
  );
  const sql = new DatabaseSync(f.dir + "/copy.sqlite");
  assert.equal(sql.prepare("PRAGMA user_version").get().user_version, 8);
  sql.exec("PRAGMA user_version=99");
  sql.close();
  assert.throws(
    () => new Store(f.dir + "/copy.sqlite"),
    /incompatible-store-schema/,
  );
  retain(f, { before, originalUnchanged: true });
});
test("C02 concurrent inbox dedup, payload/run conflicts, issue uniqueness and explicit terminal rerun", async () => {
  const f = fixture("C02");
  const messages = await race("ingest", f.store.path, ["a", "b"]);
  assert.equal(messages.filter((m) => !m.duplicate).length, 1);
  assert.throws(
    () =>
      f.store.ingestCoordinator("run-1", "scheduler", "shared-event", {
        type: "tick",
      }),
    /inbox-payload-conflict/,
  );
  const ownership = await race("admit", f.store.path, ["other-1", "other-2"]);
  assert.equal(ownership.filter((m) => m.ok).length, 1);
  assert.match(ownership.find((m) => m.error).error, /issue-already-owned/);
  assert.throws(
    () =>
      f.store.admitCoordinator(
        admission("rerun", {
          issue: "run-1",
          previousRunId: "run-1",
          rerun: "second",
        }),
      ),
    /previous-run-not-quiescent-terminal/,
  );
  apply(f.store, f.lease, { type: "cancel" });
  f.store.admitCoordinator(
    admission("rerun", {
      issue: "run-1",
      previousRunId: "run-1",
      rerun: "second",
    }),
  );
  assert.throws(
    () => apply(f.store, f.lease, { type: "tick" }),
    /issue-ownership-superseded/,
  );
  assert.throws(
    () =>
      f.store.admitCoordinator(
        admission("bad-rerun", {
          issue: "run-1",
          previousRunId: "run-1",
          rerun: "third",
        }),
      ),
    /issue-already-owned/,
  );
  retain(f, { messages, ownership });
  f.store.close();
});
test("C03 fenced expected revision atomically consumes inbox, reserves budget, snapshot, slot and outbox", () => {
  const f = fixture("C03");
  const event = { type: "schedule", kind: "baseline" };
  f.store.ingestCoordinator("run-1", "scheduler", "start", event);
  const before = f.store.coordinatorSnapshot("run-1"),
    events = f.store.events("run-1");
  const db = new DatabaseSync(f.store.path);
  db.exec(
    "CREATE TRIGGER fault BEFORE INSERT ON effects BEGIN SELECT RAISE(ABORT,'injected-atomic-failure'); END;",
  );
  assert.throws(
    () => f.store.applyCoordinator(f.lease, 0, "scheduler", "start"),
    /injected-atomic-failure/,
  );
  assert.deepEqual(f.store.coordinatorSnapshot("run-1"), before);
  assert.deepEqual(f.store.events("run-1"), events);
  assert.equal(f.store.implementationSlot(), null);
  assert.equal(
    db.prepare("SELECT consumed_revision FROM coordinator_inbox").get()
      .consumed_revision,
    null,
  );
  db.exec("DROP TRIGGER fault");
  assert.throws(
    () => f.store.applyCoordinator(f.lease, 1, "scheduler", "start"),
    /revision-conflict/,
  );
  const after = f.store.applyCoordinator(f.lease, 0, "scheduler", "start");
  assert.equal(after.budgets.reservedElapsedMs, 1000);
  assert.equal(f.store.effect(after.execution.key).state, "pending");
  assert.deepEqual(
    f.store.applyCoordinator(f.lease, 0, "scheduler", "start"),
    after,
  );
  assert.throws(
    () => f.store.transition(f.lease, "bypass"),
    /coordinator-transaction-required/,
  );
  assert.throws(
    () => f.store.revise(f.lease, { head: "x", base: "b", scope: "s" }),
    /coordinator-transaction-required/,
  );
  assert.throws(
    () =>
      f.store.applyCoordinator(
        { ...f.lease, fence: 0 },
        1,
        "scheduler",
        "start",
      ),
    /stale-lease/,
  );
  db.close();
  retain(f, { before, after });
  f.store.close();
});
test("C04 different run IDs contend across real processes; lease expiry cannot reuse occupied execution", async () => {
  const f = fixture("C04");
  f.store.release(f.lease);
  f.store.admitCoordinator(admission("run-2"));
  const messages = await race("start", f.store.path, ["run-1", "run-2"]);
  assert.equal(messages.filter((m) => m.ok).length, 1);
  assert.match(
    messages.find((m) => m.error).error,
    /implementation-capacity-busy/,
  );
  const won = messages.find((m) => m.ok);
  f.store.close();
  let now = 3000;
  const reopened = new Store(f.dir + "/state.sqlite", () => now);
  const newLease = reopened.claim(won.lease.runId, "new", versions, 1000);
  const loser = won.lease.runId === "run-1" ? "run-2" : "run-1";
  const loserLease = reopened.claim(loser, "other", versions, 1000);
  assert.throws(
    () =>
      reopened.applyCoordinator(loserLease, 0, "scheduler", `start-${loser}`),
    /implementation-capacity-busy/,
  );
  await assert.rejects(
    () =>
      reopened.dispatchCoordinator(newLease, won.snapshot.execution.key, {
        versions,
        capability,
        begin: async () => {
          throw Error("must-not-run");
        },
        interrupt() {},
      }),
    /stale-slot-fence/,
  );
  const settled = apply(reopened, newLease, result(won.snapshot));
  assert.equal(settled.stage, "blocked");
  assert.equal(reopened.implementationSlot(), null);
  retain(f, { messages, settled });
  reopened.close();
});
test("C05 kill inside real apply transaction rolls back; kill after commit retains exactly one dispatch reservation", async () => {
  const f = fixture("C05");
  f.store.release(f.lease);
  const sql = new DatabaseSync(f.store.path, { timeout: 1 });
  sql.exec(
    `CREATE TRIGGER slow BEFORE INSERT ON effects BEGIN SELECT (WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<100000000) SELECT sum(x) FROM n); END;`,
  );
  const child = worker("crash", f.store.path);
  await once(child, "message");
  let locked = false;
  for (let i = 0; i < 200; i++) {
    try {
      sql.exec("BEGIN IMMEDIATE; ROLLBACK;");
    } catch (e) {
      if (/locked|busy/.test(e.message)) {
        locked = true;
        break;
      }
      throw e;
    }
    await pause(5);
  }
  assert.equal(locked, true);
  child.kill("SIGKILL");
  await once(child, "exit");
  sql.exec("DROP TRIGGER slow");
  assert.equal(f.store.coordinatorSnapshot("run-1").revision, 0);
  assert.equal(f.store.implementationSlot(), null);
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM effects").get().n, 0);
  assert.equal(
    sql
      .prepare(
        "SELECT consumed_revision FROM coordinator_inbox WHERE event_id='start-run-1'",
      )
      .get().consumed_revision,
    null,
  );
  // Expire only the test worker lease on this owned DB, then use the public method in a second process.
  sql.exec("UPDATE runs SET expires=0");
  const committed = worker("committed", f.store.path);
  const [message] = await once(committed, "message");
  assert.equal(message.ok, true);
  committed.kill("SIGKILL");
  await once(committed, "exit");
  f.store.close();
  sql.close();
  const reopened = new Store(f.dir + "/state.sqlite", () => 1000);
  const snapshot = reopened.coordinatorSnapshot("run-1");
  assert.equal(snapshot.revision, 1);
  assert.equal(snapshot.budgets.reservedElapsedMs, 1000);
  assert.equal(reopened.effect(snapshot.execution.key).state, "pending");
  assert.equal(reopened.implementationSlot().actionKey, snapshot.execution.key);
  retain(f, { locked, snapshot, events: reopened.events("run-1") });
  reopened.close();
});
test("C06 dispatch intent survives lost response, cancellation/stale transport/version gate and drain before slot release", async () => {
  const f = fixture("C06");
  let s = apply(f.store, f.lease, { type: "schedule", kind: "baseline" });
  let calls = 0;
  const transport = {
    versions,
    capability,
    begin: async () => {
      calls++;
      throw Error("lost-start-response");
    },
    interrupt() {},
  };
  await assert.rejects(
    () => f.store.dispatchCoordinator(f.lease, s.execution.key, transport),
    /lost-start-response/,
  );
  await assert.rejects(
    () => f.store.dispatchCoordinator(f.lease, s.execution.key, transport),
    /reconciliation-required/,
  );
  assert.equal(calls, 1);
  assert.equal(f.store.effect(s.execution.key).state, "sending");
  apply(f.store, f.lease, { type: "cancel" });
  assert.ok(f.store.implementationSlot());
  await assert.rejects(
    () => f.store.dispatchCoordinator(f.lease, s.execution.key, transport),
    /cancelled/,
  );
  s = apply(f.store, f.lease, result(s, { quiescent: false }));
  assert.equal(s.stage, "recovery_required");
  assert.ok(f.store.implementationSlot());
  // Owned command records are also checked, even if the transport claims quiescence.
  const sql = new DatabaseSync(f.store.path);
  sql
    .prepare("INSERT INTO commands(id,run_id,data) VALUES(?,?,?)")
    .run(
      "dangling",
      "run-1",
      canonical({ id: "dangling", runId: "run-1", state: "running" }),
    );
  assert.throws(
    () => apply(f.store, f.lease, result(s)),
    /owned-commands-unquiesced/,
  );
  sql.exec("DELETE FROM commands WHERE id='dangling'");
  sql.close();
  s = apply(f.store, f.lease, result(s));
  assert.equal(s.stage, "cancelled");
  assert.equal(f.store.implementationSlot(), null);
  retain(f, { calls, s });
  f.store.close();
});

test("C15 incompatible/corrupted snapshot cannot resume or dispatch", () => {
  const f = fixture("C15");
  const sql = new DatabaseSync(f.store.path);
  const before = f.store.coordinatorSnapshot("run-1");
  for (const corrupt of [
    { ...before, schema: 99 },
    { ...before, inputDigest: "corrupt" },
    { ...before, budgets: { ...before.budgets, ci: 5 } },
    { ...before, stage: "invented" },
  ]) {
    sql
      .prepare("UPDATE coordinator_snapshots SET data=? WHERE run_id=?")
      .run(canonical(corrupt), "run-1");
    assert.throws(
      () => f.store.coordinatorSnapshot("run-1"),
      /incompatible-coordinator-schema|snapshot-identity-mismatch|invalid-snapshot-budget|invalid-snapshot-state/,
    );
  }
  sql
    .prepare("UPDATE coordinator_snapshots SET data=? WHERE run_id=?")
    .run(canonical(before), "run-1");
  assert.deepEqual(f.store.coordinatorSnapshot("run-1"), before);
  sql.close();
  f.store.close();
});
