// Supporting S2-R transport race regression. No product qualification assertions.
import assert from "node:assert/strict";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  statfsSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { load, runtime } from "../scripts/attraccess-runtime.mjs";
const { EnvironmentCommands } = await load("attraccess/commands.js");
const { OwnedProbes } = await load("attraccess/probes.js");
const { assertOwned, persistOwnership, settleOwned } = await load(
  "attraccess/resources.js",
);
const { identify, matches } = await load("runner/process.js");
const { TARGET, LIMITS } = await load("attraccess/policy.js");
const image =
  "sha256:9a857e6bcc8330284b70d71097a1acba4468df1ad9857acd7c138669c170e531";
const docker = "/usr/local/bin/docker",
  host = "unix:///Users/jappy/.orbstack/run/docker.sock";
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const save = (path, value) =>
  writeFileSync(path, JSON.stringify(value, null, 2), { mode: 0o600 });
const wait = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw Error("observation-timeout");
};
function wrapper(root) {
  const path = join(root, "delayed-docker.cjs");
  writeFileSync(
    path,
    `#!/usr/bin/env node
const fs=require('fs'),cp=require('child_process'),args=process.argv.slice(2),root=${JSON.stringify(root)};
async function main(){if(args[2]==='create'){fs.writeFileSync(root+'/waiting.json',JSON.stringify({pid:process.pid,at:Date.now(),args}));while(!fs.existsSync(root+'/release'))await new Promise(r=>setTimeout(r,20));}
const r=cp.spawnSync(${JSON.stringify(docker)},args,{encoding:'utf8',timeout:15000});
if(args[2]==='create')fs.writeFileSync(root+'/materialized.json',JSON.stringify({at:Date.now(),status:r.status,stdout:r.stdout,stderr:r.stderr}));
process.stdout.write(r.stdout??'');process.stderr.write(r.stderr??'');process.exit(r.status??1);}main();
`,
    { mode: 0o700 },
  );
  return path;
}
function preparer(root) {
  const c = new EnvironmentCommands(root, "late-" + randomUUID(), {
    executable: wrapper(root),
    host,
  });
  return new OwnedProbes(c);
}
if (process.argv[2] === "worker") {
  const root = process.argv[3],
    p = preparer(root);
  try {
    await p.run(image, ["node", "-e", "setInterval(()=>{},1000)"], [], 60000);
  } catch (e) {
    save(join(root, "worker-error.json"), { error: e.message });
  } finally {
    await p.close();
  }
  process.exit(0);
}
const disk = statfsSync(TARGET.root);
assert.ok(disk.bavail * disk.bsize >= LIMITS.diskMinimumBytes);
const root = join(
  TARGET.root,
  "repair34-late-create-" +
    new Date().toISOString().replace(/[^a-zA-Z0-9-]/g, "-"),
);
mkdirSync(root, { mode: 0o700 });
const outcome = {
  scope: "S2-R supporting owned Docker delayed-create regression",
  runtime,
  startedAt: new Date().toISOString(),
  tests: [],
};
const result = () => save(join(root, "result.json"), outcome);
result();
const foreign = new OwnedProbes(
  new EnvironmentCommands(join(root, "foreign"), "foreign-" + randomUUID()),
);
let pending, child, deathState;
const roots = [];
try {
  const sentinel = foreign.ownership.owner + "-sentinel";
  foreign.ownership.containers.push(sentinel);
  persistOwnership(foreign.ownership);
  await foreign.commands.mutation(
    [
      "create",
      "--name",
      sentinel,
      "--label",
      "rocky-next.owner=" + foreign.ownership.owner,
      "--network",
      "none",
      "--memory",
      "64m",
      "--pids-limit",
      "32",
      "--cap-drop",
      "ALL",
      image,
      "node",
      "-e",
      "setInterval(()=>{},1000)",
    ],
    "sentinel-create",
  );
  await foreign.commands.mutation(["start", sentinel], "sentinel-start");
  const foreignAlive = () =>
    assert.equal(
      assertOwned(foreign.ownership, "container", sentinel).State.Running,
      true,
    );
  const emptyIncomplete = async (dir) =>
    wait(() => {
      const receiptPath = join(dir, "cleanup.json");
      if (!existsSync(receiptPath)) return false;
      const receipt = json(receiptPath);
      if (
        receipt.status === "incomplete" &&
        receipt.pendingMutations?.length &&
        receipt.remaining.containers?.length === 0 &&
        receipt.remaining.networks?.length === 0
      )
        return receipt;
      assert.notEqual(
        receipt.status,
        "complete",
        "empty listing must not complete pending create",
      );
      return false;
    }, LIMITS.leaseMs + 5000);
  const transport = (dir) => {
    const sub = readdirSync(join(dir, "mutations")).find((n) =>
      existsSync(join(dir, "mutations", n, "worker.json")),
    );
    return join(dir, "mutations", sub);
  };
  for (const mode of ["cancel", "preparer-death"]) {
    const dir = join(root, mode);
    mkdirSync(dir, { mode: 0o700 });
    roots.push(dir);
    let operation, closing, parent;
    if (mode === "cancel") {
      pending = preparer(dir);
      operation = pending
        .run(image, ["node", "-e", "setInterval(()=>{},1000)"], [], 60000)
        .then(
          () => ({ ok: true }),
          (e) => ({ error: e.message }),
        );
    } else {
      child = spawn(
        process.execPath,
        [resolve("tests/late-create-recovery.mjs"), "worker", dir],
        { env: process.env, stdio: ["ignore", "pipe", "pipe"] },
      );
      child.stdout.on("data", (b) =>
        writeFileSync(join(dir, "parent.stdout.log"), b, {
          flag: "a",
          mode: 0o600,
        }),
      );
      child.stderr.on("data", (b) =>
        writeFileSync(join(dir, "parent.stderr.log"), b, {
          flag: "a",
          mode: 0o600,
        }),
      );
    }
    await wait(() => existsSync(join(dir, "waiting.json")), 10000);
    const transportDir = transport(dir),
      keeper = json(join(transportDir, "worker.json")),
      launchClient = json(join(transportDir, "client.json")),
      client = identify(json(join(dir, "waiting.json")).pid);
    assert.equal(client?.pid, launchClient?.pid);
    assert.ok(matches(keeper));
    assert.ok(matches(client));
    assert.ok(!existsSync(join(dir, "materialized.json")));
    const state = json(join(dir, "control/ownership.json"));
    if (mode === "cancel") closing = pending.close();
    else {
      parent = identify(child.pid);
      assert.ok(parent);
      deathState = state;
      const exit = new Promise((r) => child.once("exit", r));
      child.kill("SIGKILL");
      await exit;
      child = undefined;
    }
    const first = await emptyIncomplete(dir);
    assert.ok(!existsSync(join(dir, "stopped.json")));
    assert.ok(!existsSync(join(dir, "guardian-complete.json")));
    assert.ok(matches(keeper));
    foreignAlive();
    const releaseAt = Date.now();
    writeFileSync(join(dir, "release"), "release");
    let cleanup, operationOutcome;
    if (mode === "cancel") {
      cleanup = await closing;
      operationOutcome = await operation;
      assert.ok(operationOutcome.error);
      pending = undefined;
    } else {
      await wait(
        () => existsSync(join(dir, "guardian-complete.json")),
        LIMITS.teardownMs + 3000,
      );
      cleanup = json(join(dir, "cleanup.json"));
      deathState = undefined;
    }
    const materialized = json(join(dir, "materialized.json")),
      terminal = json(join(transportDir, "result.json"));
    assert.equal(materialized.status, 0);
    assert.equal(terminal.status, "acknowledged");
    assert.ok(materialized.at >= releaseAt);
    assert.ok(Date.parse(first.at) <= releaseAt);
    assert.equal(cleanup.status, "complete");
    assert.deepEqual(cleanup.remaining.containers, []);
    assert.deepEqual(cleanup.remaining.networks, []);
    await wait(() => !matches(keeper) && !matches(client));
    foreignAlive();
    outcome.tests.push({
      mode,
      parent,
      keeper,
      client,
      launchClient,
      waiting: json(join(dir, "waiting.json")),
      firstEmptyIncomplete: first,
      releaseAt,
      materialized,
      terminal,
      cleanup,
      operationOutcome,
      foreignSentinelAlive: true,
    });
    result();
  }
  outcome.status = "passed";
} catch (e) {
  outcome.status = "failed";
  outcome.error = e.stack;
  process.exitCode = 1;
} finally {
  for (const dir of roots) writeFileSync(join(dir, "release"), "release");
  if (child) child.kill("SIGKILL");
  if (pending)
    try {
      await pending.close();
    } catch (e) {
      outcome.cleanupError = e.message;
    }
  if (deathState) outcome.manualRecovery = await settleOwned(deathState);
  outcome.foreignSentinelCleanup = await foreign.close();
  outcome.finishedAt = new Date().toISOString();
  result();
  console.log(
    JSON.stringify({
      root,
      status: outcome.status,
      tests: outcome.tests.map((t) => t.mode),
      error: outcome.error,
    }),
  );
}
