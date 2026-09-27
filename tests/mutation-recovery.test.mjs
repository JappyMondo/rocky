import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Store } from "../dist/store/index.js";
import { TARGET } from "../dist/attraccess/policy.js";
import {
  prepareMutation,
  durableJson,
  mutationHazards,
  sealAndReadEffects,
} from "../dist/attraccess/mutations.js";
import { cleanOwned } from "../dist/attraccess/resources.js";
const base = join(TARGET.root, "unit-tests");
mkdirSync(base, { recursive: true });
const versions = {
  workflow: "1",
  adapter: "1",
  prompt: "1",
  runner: "1",
  build: "1",
};
const fixture = () => {
  const root = mkdtempSync(join(base, "pending-mutation-")),
    store = new Store(join(root, "run.sqlite"));
  store.admit({ id: "run", head: "h", base: "b", scope: "test", versions });
  return { root, store, lease: store.claim("run", "test", versions, 30000) };
};
test("receipt keeper waits for terminal client outcome after client-identity persistence fails", async () => {
  const { root, store, lease } = fixture(),
    key = "metadata-error",
    args = ["create", "--name", "owned"];
  const ready = join(root, "waiting"),
    release = join(root, "release"),
    docker = join(root, "delayed-client");
  writeFileSync(
    docker,
    `#!/bin/sh\ntouch '${ready}'\nwhile [ ! -f '${release}' ]; do sleep 0.02; done\nprintf 'acknowledged-id\\n'\n`,
    { mode: 0o700 },
  );
  const dir = prepareMutation({
    key,
    root,
    docker,
    dockerHost: "unix:///unused",
    args,
    lease,
    timeoutMs: 5000,
    creation: { kind: "container", name: "owned" },
  });
  mkdirSync(join(dir, "client.json")); // Force rename failure after the child was spawned.
  store.transition(lease, "intent", {
    key,
    kind: "owned-docker",
    payload: { args },
  });
  let child;
  const dispatched = store.dispatch(lease, key, {
    begin: async () => {
      child = spawn(
        process.execPath,
        [
          fileURLToPath(
            new URL("../dist/attraccess/mutation-worker.js", import.meta.url),
          ),
          dir,
        ],
        { stdio: "ignore" },
      );
      await new Promise((r) => child.once("exit", r));
      return { terminal: true };
    },
  });
  try {
    const end = Date.now() + 3000;
    while (!existsSync(ready) && Date.now() < end)
      await new Promise((r) => setTimeout(r, 10));
    assert.ok(existsSync(ready));
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(
      !existsSync(join(dir, "result.json")),
      "metadata failure cannot publish early terminal outcome",
    );
    const effects = sealAndReadEffects(root, "run");
    assert.equal(
      (
        await mutationHazards(root, "owner", effects, async () => {
          throw Error("No such container");
        })
      ).length,
      1,
    );
  } finally {
    writeFileSync(release, "release");
    await dispatched;
    store.close();
  }
  assert.equal(
    JSON.parse(readFileSync(join(dir, "result.json"))).status,
    "acknowledged",
  );
});
test("empty labels and dead/missing transport never resolve an unknown create; positive ownership does", async () => {
  const { root, store, lease } = fixture(),
    key = "create",
    args = ["create", "--name", "owned"];
  const dir = prepareMutation({
    key,
    root,
    docker: "/unused",
    dockerHost: "unix:///unused",
    args,
    lease,
    timeoutMs: 1000,
    creation: { kind: "container", name: "owned" },
  });
  store.transition(lease, "intent", {
    key,
    kind: "owned-docker",
    payload: { args },
  });
  await store.dispatch(lease, key, {
    begin: async () => {
      throw Error("lost");
    },
  });
  const effects = sealAndReadEffects(root, "run");
  assert.equal(
    (
      await mutationHazards(root, "owner", effects, async () => {
        throw Error("No such container");
      })
    ).length,
    1,
  );
  durableJson(join(dir, "result.json"), {
    status: "unknown",
    at: new Date().toISOString(),
    stdout: "",
    stderr: "host client died",
  });
  assert.equal(
    (
      await mutationHazards(root, "owner", effects, async () => {
        throw Error("No such container");
      })
    ).length,
    1,
  );
  assert.equal(
    (
      await mutationHazards(root, "owner", effects, async () => ({
        Id: "foreign",
        Config: { Labels: { "rocky-next.owner": "other" } },
      }))
    ).length,
    1,
  );
  assert.deepEqual(
    await mutationHazards(root, "owner", effects, async () => ({
      Id: "owned-id",
      Config: { Labels: { "rocky-next.owner": "owner" } },
    })),
    [],
  );
  assert.deepEqual(
    await mutationHazards(root, "owner", effects, async () => {
      throw Error("removed after positive proof");
    }),
    [],
  );
  assert.equal(store.effect(key).state, "unresolved");
  assert.throws(
    () =>
      store.guardedStart(lease, () =>
        assert.fail("dispatch after cleanup seal"),
      ),
    /cancel/,
  );
  store.close();
});
test("actual SQLite writer contention cannot consume the aggregate cleanup deadline", async () => {
  const { root, store } = fixture();
  store.close();
  const ready = join(root, "locked"),
    release = join(root, "release");
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {DatabaseSync} from 'node:sqlite';import fs from 'node:fs';const db=new DatabaseSync(${JSON.stringify(join(root, "run.sqlite"))});db.exec('BEGIN IMMEDIATE');fs.writeFileSync(${JSON.stringify(ready)},'locked');const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){db.exec('ROLLBACK');db.close();clearInterval(t);}},10);`,
    ],
    { stdio: "ignore" },
  );
  const exited = new Promise((r) => child.once("exit", r));
  const docker = join(root, "empty-docker");
  writeFileSync(docker, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const ownership = {
    root,
    runId: "run",
    owner: "unit",
    docker,
    dockerHost: "unix:///unused",
    expiresAt: 0,
    containers: [],
    networks: [],
  };
  try {
    const waitUntil = Date.now() + 5000;
    while (!existsSync(ready) && Date.now() < waitUntil)
      await new Promise((r) => setTimeout(r, 10));
    assert.ok(existsSync(ready));
    const started = Date.now(),
      receipt = await cleanOwned(ownership, started + 200);
    assert.equal(receipt.status, "incomplete");
    assert.ok(Date.now() - started < 500);
    assert.match(JSON.stringify(receipt.errors), /locked/);
    assert.equal(receipt.remaining.containers, null);
    writeFileSync(release, "release");
    await exited;
    assert.equal((await cleanOwned(ownership)).status, "complete");
  } finally {
    writeFileSync(release, "release");
    await exited;
  }
});
