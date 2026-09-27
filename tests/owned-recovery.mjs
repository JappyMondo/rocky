// Supporting live ownership regressions, never qualification/product assertions.
import assert from "node:assert/strict";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  unlinkSync,
  readdirSync,
  statfsSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { load, runtime } from "../scripts/attraccess-runtime.mjs";
const { EnvironmentCommands } = await load("attraccess/commands.js");
const { OwnedProbes } = await load("attraccess/probes.js");
const { AttraccessEnvironment } = await load("attraccess/environment.js");
const { persistOwnership, assertOwned } = await load("attraccess/resources.js");
const { LIMITS, TARGET } = await load("attraccess/policy.js");
const { identify, matches } = await load("runner/process.js");
const image =
  "sha256:9a857e6bcc8330284b70d71097a1acba4468df1ad9857acd7c138669c170e531";
const docker = "/usr/local/bin/docker",
  host = "unix:///Users/jappy/.orbstack/run/docker.sock";
const wait = async (fn, ms = 5000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw Error("test-observation-timeout");
};
const makeWrapper = (root, mode) => {
  const file = join(root, "docker-wrapper.cjs");
  writeFileSync(
    file,
    `#!/usr/bin/env node
const fs=require('fs'),cp=require('child_process'),args=process.argv.slice(2),mode=${JSON.stringify(mode)};
if(mode==='stall'&&args.includes('rm')&&fs.existsSync(${JSON.stringify(join(root, "stall"))})){process.on('SIGTERM',()=>{});setInterval(()=>{},100);}
else {if(args.includes('wait'))fs.writeFileSync(${JSON.stringify(join(root, "client.json"))},JSON.stringify({pid:process.pid}));const r=cp.spawnSync(${JSON.stringify(docker)},args,{encoding:'utf8',timeout:30000});
if(mode==='lost'&&args.includes('start')&&r.status===0){fs.writeFileSync(${JSON.stringify(join(root, "lost-response.json"))},JSON.stringify({actualExit:0,command:args}));process.exit(17);}
process.stdout.write(r.stdout??'');process.stderr.write(r.stderr??'');process.exit(r.status??1);}
`,
    { mode: 0o700 },
  );
  return file;
};
if (process.argv[2] === "worker") {
  const root = process.argv[3],
    c = new EnvironmentCommands(root, "probe-worker-" + randomUUID(), {
      executable: makeWrapper(root, "normal"),
      host,
    }),
    p = new OwnedProbes(c);
  try {
    await p.run(
      image,
      [
        "node",
        "-e",
        "process.on('SIGTERM',()=>{});console.log('PROBE-READY');setInterval(()=>{},1000)",
      ],
      [],
      120000,
    );
  } catch (error) {
    writeFileSync(
      join(root, "worker-error.json"),
      JSON.stringify({ error: error.message }),
      { mode: 0o600 },
    );
  } finally {
    await p.close();
  }
  process.exit(0);
}
const disk = statfsSync(TARGET.root);
assert.ok(disk.bavail * disk.bsize >= LIMITS.diskMinimumBytes);
const id =
    "repair34-live-" + new Date().toISOString().replace(/[^a-zA-Z0-9-]/g, "-"),
  root = join(TARGET.root, id);
mkdirSync(root, { mode: 0o700 });
const outcome = {
  id,
  scope: "supporting-owned-fault-regression",
  runtime,
  startedAt: new Date().toISOString(),
  tests: [],
};
const save = () =>
  writeFileSync(join(root, "result.json"), JSON.stringify(outcome, null, 2), {
    mode: 0o600,
  });
save();
const foreignCommands = new EnvironmentCommands(
    join(root, "foreign-sentinel"),
    "foreign-sentinel-" + randomUUID(),
  ),
  foreign = new OwnedProbes(foreignCommands);
const create = async (c, o, suffix) => {
  const name = o.owner + "-" + suffix;
  o.containers.push(name);
  persistOwnership(o);
  await c.mutation(
    [
      "create",
      "--name",
      name,
      "--label",
      "rocky-next.owner=" + o.owner,
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
      "process.on('SIGTERM',()=>{});console.log('READY');setInterval(()=>{},1000)",
    ],
    suffix + "-create",
  );
  await c.mutation(["start", name], suffix + "-start");
  return name;
};
let environment, lost, child, childIdentity;
try {
  const sentinel = await create(foreignCommands, foreign.ownership, "sentinel");
  const alive = () =>
    assert.equal(
      assertOwned(foreign.ownership, "container", sentinel).State.Running,
      true,
    );
  // Aggregate30s actual Docker cleanup fault. Only wrapper-owned removal calls stall.
  environment = new AttraccessEnvironment(
    {
      devImage: image,
      mailpitImage: TARGET.mailpitImage,
      sourceInventory: {},
      browserExecutable: "/unused",
      shellyZip: "/unused",
    },
    id + "-stop",
  );
  for (let n = 0; n < 3; n++)
    await create(environment.commands, environment.ownership, "stall-" + n);
  const stallRoot = environment.commands.root,
    wrapper = makeWrapper(stallRoot, "stall");
  writeFileSync(join(stallRoot, "stall"), "enabled");
  environment.ownership.docker = wrapper;
  persistOwnership(environment.ownership);
  const start = Date.now();
  let failed;
  try {
    await environment.stop();
    throw Error("expected-cleanup-failure");
  } catch (e) {
    assert.equal(e.message, "owned-cleanup-incomplete");
    failed = e.receipt;
  }
  const elapsed = Date.now() - start;
  assert.equal(failed.status, "incomplete");
  assert.ok(elapsed <= LIMITS.teardownMs + 1500, `elapsed ${elapsed}`);
  assert.throws(() =>
    environment.commands.store.get(environment.commands.lease.runId),
  );
  assert.ok(
    !readdirSync(join(TARGET.root, "active-runtimes")).some(
      (f) =>
        JSON.parse(readFileSync(join(TARGET.root, "active-runtimes", f)))
          .attempt ===
        id + "-stop",
    ),
  );
  alive();
  unlinkSync(join(stallRoot, "stall"));
  let recovered;
  await wait(async () => {
    try {
      recovered = await environment.stop();
      return true;
    } catch (e) {
      if (e.message !== "owned-cleanup-incomplete") throw e;
      return false;
    }
  }, 35000);
  assert.equal(recovered.status, "complete");
  assert.deepEqual(await environment.stop(), recovered);
  alive();
  outcome.tests.push({
    finding: "S1/SPEC-01",
    case: "actual-owned-containers-delayed-cleanup",
    elapsedMs: elapsed,
    failed,
    recovered,
    foreignSentinelAlive: true,
  });
  save();
  environment = undefined;
  // Lost daemon response: actual start succeeds, wrapper withholds the response.
  const lostRoot = join(root, "lost-response");
  mkdirSync(lostRoot, { mode: 0o700 });
  const lc = new EnvironmentCommands(lostRoot, "lost-" + randomUUID(), {
    executable: makeWrapper(lostRoot, "lost"),
    host,
  });
  lost = new OwnedProbes(lc);
  await assert.rejects(
    lost.run(
      image,
      ["node", "-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
      [],
      10000,
    ),
    /reconciliation-required/,
  );
  assert.ok(existsSync(join(lostRoot, "lost-response.json")));
  assert.equal(
    assertOwned(lost.ownership, "container", lost.ownership.containers[0]).State
      .Running,
    true,
  );
  const lostCleanup = await lost.close();
  assert.equal(lostCleanup.status, "complete");
  alive();
  outcome.tests.push({
    finding: "S2/SPEC-02",
    case: "actual-start-lost-response",
    cleanup: lostCleanup,
    foreignSentinelAlive: true,
  });
  save();
  lost = undefined;
  // Preparatory parent killed while daemon-side probe ignores TERM. Its independent guardian reconciles.
  const workerRoot = join(root, "parent-death");
  mkdirSync(workerRoot, { mode: 0o700 });
  child = spawn(
    process.execPath,
    [resolve("tests/owned-recovery.mjs"), "worker", workerRoot],
    { env: process.env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (b) => (stdout += b));
  child.stderr.on("data", (b) => (stderr += b));
  await wait(() => existsSync(join(workerRoot, "client.json")), 10000);
  childIdentity = identify(child.pid);
  assert.ok(childIdentity);
  const state = JSON.parse(
    readFileSync(join(workerRoot, "control/ownership.json")),
  );
  assert.equal(
    assertOwned(state, "container", state.containers[0]).State.Running,
    true,
  );
  const client = JSON.parse(readFileSync(join(workerRoot, "client.json"))),
    clientIdentity = identify(client.pid);
  assert.ok(clientIdentity);
  const deathAt = Date.now();
  child.kill("SIGKILL");
  await new Promise((r) => child.once("exit", r));
  writeFileSync(join(workerRoot, "worker.stdout.log"), stdout, { mode: 0o600 });
  writeFileSync(join(workerRoot, "worker.stderr.log"), stderr, { mode: 0o600 });
  await wait(
    () => existsSync(join(workerRoot, "guardian-complete.json")),
    LIMITS.leaseMs + LIMITS.teardownMs + 3000,
  );
  const cleanup = JSON.parse(readFileSync(join(workerRoot, "cleanup.json")));
  assert.equal(cleanup.status, "complete");
  await wait(() => !matches(clientIdentity), 5000);
  alive();
  outcome.tests.push({
    finding: "S2/SPEC-02",
    case: "actual-preparer-SIGKILL-and-Docker-client-death",
    elapsedMs: Date.now() - deathAt,
    parent: childIdentity,
    client: clientIdentity,
    cleanup,
    foreignSentinelAlive: true,
  });
  child = undefined;
  save();
  outcome.status = "passed";
} catch (error) {
  outcome.status = "failed";
  outcome.error = error.stack;
  process.exitCode = 1;
} finally {
  if (child && childIdentity && matches(childIdentity)) child.kill("SIGKILL");
  for (const scope of [environment, lost])
    if (scope)
      try {
        if (scope.stop) await scope.stop();
        else await scope.close();
      } catch (e) {
        outcome.cleanupError = e.message;
      }
  outcome.foreignSentinelCleanup = await foreign.close();
  outcome.finishedAt = new Date().toISOString();
  save();
  console.log(
    JSON.stringify({
      root,
      status: outcome.status,
      tests: outcome.tests.map((t) => ({
        case: t.case,
        elapsedMs: t.elapsedMs,
      })),
      error: outcome.error,
    }),
  );
}
