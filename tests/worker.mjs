import { Store, CommandRunner } from "../dist/index.js";
import { DatabaseSync } from "node:sqlite";
import { writeFileSync, readFileSync } from "node:fs";
import { versions } from "./helpers.mjs";
const [mode, path, dir] = process.argv.slice(2);
const store = new Store(path);
if (mode === "claim") {
  try {
    process.send(
      store.claim("synthetic-001", "child-" + process.pid, versions, 2000),
    );
  } catch (error) {
    process.send({ error: error.message });
  }
  store.close();
}
if (mode === "uncommitted") {
  const db = new DatabaseSync(path);
  db.exec("BEGIN IMMEDIATE");
  db.prepare("UPDATE runs SET data=? WHERE id=?").run(
    JSON.stringify({ ...store.get("synthetic-001"), stage: "uncommitted" }),
    "synthetic-001",
  );
  db.prepare("INSERT INTO events(run_id,kind,data,at) VALUES(?,?,?,?)").run(
    "synthetic-001",
    "uncommitted",
    "{}",
    Date.now(),
  );
  db.prepare("INSERT INTO effects(key,run_id,data) VALUES(?,?,?)").run(
    "uncommitted",
    "synthetic-001",
    "{}",
  );
  process.send({ ready: true });
  setInterval(() => {}, 1000);
}
if (mode === "effect") {
  const lease = store.claim("synthetic-001", "effect-worker", versions, 300);
  store.transition(lease, "delivery", {
    key: "create-draft/1",
    kind: "draft",
    payload: { head: "1".repeat(40) },
  });
  await store.dispatch(lease, "create-draft/1", {
    begin(effect) {
      writeFileSync(
        dir + "/ledger.json",
        JSON.stringify({ key: effect.key, remoteId: "fake-pr-1", creates: 1 }),
      );
      process.send({ ready: true });
      return new Promise(() => {});
    },
  });
}
if (mode === "command") {
  const lease = store.claim("synthetic-001", "command-worker", versions, 500);
  const runner = new CommandRunner(store);
  const id = runner.start(lease, {
    file: process.execPath,
    args: ["tests/command-fixture.mjs", dir + "/descendant.pid"],
    cwd: process.cwd(),
    outputDir: dir,
    timeoutMs: 10000,
    cleanupMs: 100,
    logBytes: 4096,
  });
  process.send({ id });
  await runner.wait(lease, id);
}
