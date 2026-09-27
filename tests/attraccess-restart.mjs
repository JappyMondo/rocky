// Producer supporting regression. No independent evaluator code or admission.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { load, runtime } from "../scripts/attraccess-runtime.mjs";
const { AttraccessEnvironment } = await load("attraccess/environment.js");
const { EnvironmentCommands } = await load("attraccess/commands.js");
const { OwnedProbes } = await load("attraccess/probes.js");
const { assertOwned, dockerRead, persistOwnership } = await load(
  "attraccess/resources.js",
);
const { runtimeIntegrity } = await load("attraccess/integrity.js");
const { digest, canonical } = await load("store/json.js");
const { TARGET, COMMANDS } = await load("attraccess/policy.js");
assert.ok(
  process.env.ROCKY_ADAPTER_ROOT,
  "explicit installed package required",
);
const build = JSON.parse(readFileSync(join(runtime, "build-identity.json")));
assert.equal(build.sourceDirty, false);
assert.equal(
  build.sourceCommit,
  execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
);
assert.equal(
  execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(),
  "",
);
const inputs = JSON.parse(
  readFileSync(join(TARGET.root, "handoff-e919a12/proposed-inputs.json")),
);
const integrity = runtimeIntegrity();
const id =
  "repair36-restart-" + new Date().toISOString().replace(/[^a-zA-Z0-9-]/g, "-");
const root = join(TARGET.root, id);
mkdirSync(root, { mode: 0o700 });
const result = {
  id,
  scope: "producer-supporting-preparation-only",
  runtime,
  sourceCommit: build.sourceCommit,
  integrity,
  startedAt: new Date().toISOString(),
  status: "running",
  stages: [],
};
const save = () =>
  writeFileSync(join(root, "result.json"), JSON.stringify(result, null, 2), {
    mode: 0o600,
  });
const stage = (name, evidence) => {
  result.stages.push({ name, at: new Date().toISOString(), ...evidence });
  save();
  console.log(JSON.stringify({ id, stage: name }));
};
save();
let environment, foreign;
async function topology(env, s, bootstrap) {
  const app = assertOwned(env.ownership, "container", s.container);
  const mail = assertOwned(env.ownership, "container", s.mailpit);
  const gateway = assertOwned(env.ownership, "container", s.ingress);
  assert.equal(
    app.HostConfig.NetworkMode,
    s.network,
    "restart must not retain a removed primary network",
  );
  assert.equal(assertOwned(env.ownership, "network", s.network).Internal, true);
  assert.deepEqual(
    Object.keys(app.NetworkSettings.Networks).sort(),
    [s.network, ...(bootstrap ? [s.prepareNetwork] : [])].sort(),
  );
  assert.ok(app.NetworkSettings.Networks[s.network].Aliases.includes("app"));
  assert.deepEqual(Object.keys(mail.NetworkSettings.Networks), [s.network]);
  assert.equal(mail.NetworkSettings.Networks[s.network].Gateway, "");
  for (const item of [app, mail]) {
    assert.deepEqual(item.HostConfig.PortBindings, {});
    assert.ok(!item.Mounts.some((m) => m.Destination.includes("docker.sock")));
  }
  for (const bindings of Object.values(gateway.NetworkSettings.Ports))
    for (const p of bindings ?? []) assert.equal(p.HostIp, "127.0.0.1");
  assert.deepEqual(Object.keys(gateway.NetworkSettings.Ports).sort(), [
    "3000/tcp",
    "4200/tcp",
    "8025/tcp",
  ]);
  const routes = (await env.exec(s, ["cat", "/proc/net/route"])).stdout;
  const defaults = routes
    .trim()
    .split("\n")
    .slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter((r) => r[1] === "00000000");
  assert.equal(defaults.length, bootstrap ? 1 : 0);
  if (bootstrap) {
    const ip = defaults[0][2]
      .match(/../g)
      .reverse()
      .map((v) => parseInt(v, 16))
      .join(".");
    assert.equal(ip, app.NetworkSettings.Networks[s.prepareNetwork].Gateway);
  } else {
    assert.equal(app.NetworkSettings.Networks[s.network].Gateway, "");
    assert.ok(
      !dockerRead(env.ownership, ["network", "ls", "--format", "{{.Name}}"])
        .split("\n")
        .includes(s.prepareNetwork),
    );
  }
  return {
    bootstrap,
    primary: app.HostConfig.NetworkMode,
    appNetworks: app.NetworkSettings.Networks,
    mailNetworks: mail.NetworkSettings.Networks,
    routes,
    portBindings: gateway.HostConfig.PortBindings,
    containerId: app.Id,
    startedAt: app.State.StartedAt,
  };
}
// Observe the production bootstrap boundary without changing commands or results.
class ObservedEnvironment extends AttraccessEnvironment {
  async exec(s, args, timeout) {
    if (canonical(args) === canonical(COMMANDS.bootstrap))
      stage("bootstrap-topology", await topology(this, s, true));
    return super.exec(s, args, timeout);
  }
}
try {
  const c = new EnvironmentCommands(
    join(root, "foreign-sentinel"),
    id + "-sentinel",
  );
  foreign = new OwnedProbes(c);
  const name = foreign.ownership.owner + "-sentinel";
  foreign.ownership.containers.push(name);
  persistOwnership(foreign.ownership);
  await c.mutation(
    [
      "create",
      "--name",
      name,
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
      inputs.prepared.devImage,
      "node",
      "-e",
      "setInterval(()=>{},1000)",
    ],
    "sentinel-create",
  );
  await c.mutation(["start", name], "sentinel-start");
  const sentinel = assertOwned(foreign.ownership, "container", name);
  const sentinelAlive = () => {
    const now = assertOwned(foreign.ownership, "container", name);
    assert.equal(now.Id, sentinel.Id);
    assert.equal(now.State.StartedAt, sentinel.State.StartedAt);
    assert.equal(now.State.Running, true);
  };
  environment = new ObservedEnvironment(inputs.prepared, id);
  const s = await environment.provision("shelly");
  stage("provisioned", { source: await environment.verifySource(s) });
  await environment.exec(s, COMMANDS.plugin);
  const packaged = join(root, "rebuilt-plugin-shelly.zip");
  await environment.commands.dockerCommand([
    "cp",
    s.container + ":/app/apps/plugins/shelly/dist/plugin-shelly.zip",
    packaged,
  ]);
  const members = JSON.parse(
    execFileSync(
      "/usr/bin/python3",
      [
        "-B",
        "-c",
        "import zipfile,hashlib,json,sys; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps({n:hashlib.sha256(z.read(n)).hexdigest() for n in sorted(z.namelist()) if not n.endswith('/')}))",
        packaged,
      ],
      { encoding: "utf8" },
    ),
  );
  assert.deepEqual(members, inputs.shelly.members);
  stage("plugin-built", { sha256: digest(readFileSync(packaged)), members });
  const initialReadiness = await environment.start(s);
  stage("initial-ready", {
    readiness: initialReadiness,
    topology: await topology(environment, s, false),
  });
  const api = environment.api(s);
  assert.ok([200, 201].includes((await api.login(s.admin)).status));
  const before = await environment.captureInstance(s, api);
  const zip = readFileSync(inputs.prepared.shellyZip);
  assert.equal(digest(zip), inputs.shelly.sha256);
  const form = new FormData();
  form.set(
    "pluginZip",
    new Blob([zip], { type: "application/zip" }),
    "plugin-shelly.zip",
  );
  assert.equal(
    (await api.request("/api/plugins", { method: "POST", body: form })).status,
    201,
  );
  const deadline = Date.now() + 10000;
  let exitObserved = false;
  while (Date.now() < deadline) {
    try {
      if (
        !(
          await fetch(s.apiUrl + "/api/info", {
            signal: AbortSignal.timeout(500),
            redirect: "error",
          })
        ).ok
      ) {
        exitObserved = true;
        break;
      }
    } catch {
      exitObserved = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(
    exitObserved,
    true,
    "real upload must schedule API exit before explicit restart",
  );
  stage("plugin-upload-auto-exit", {
    frozenZip: inputs.prepared.shellyZip,
    sha256: digest(zip),
    uploadStatus: 201,
    exitObserved,
    previousInstanceId: before.instanceId,
  });
  let previous = before.instanceId;
  for (const [i, mode] of ["enabled", "disabled", "enabled"].entries()) {
    const prior = assertOwned(environment.ownership, "container", s.container);
    const restart = await environment.restart(s, {
      pluginMode: mode,
      observer: api,
    });
    assert.notEqual(restart.instance.instanceId, previous);
    assert.equal(restart.instance.disabled, mode === "disabled");
    previous = restart.instance.instanceId;
    const config = await topology(environment, s, false);
    assert.equal(config.containerId, prior.Id);
    assert.notEqual(config.startedAt, prior.State.StartedAt);
    const devices = await api.request("/api/shelly/devices");
    const firmware = await api.request("/api/shelly/devices/firmware");
    let plugin;
    if (mode === "enabled") {
      const list = await api.request("/api/plugins");
      assert.equal(list.status, 200);
      plugin = list.body.find((p) => p.name === "shelly");
      assert.equal(plugin?.status, "loaded");
      assert.equal(plugin.version, "0.1.0");
      assert.ok(!plugin.error);
      assert.equal(devices.status, 200);
      assert.deepEqual(devices.body, []);
      assert.equal(firmware.status, 200);
      assert.deepEqual(firmware.body, []);
    } else {
      assert.equal(devices.status, 404);
      assert.equal(firmware.status, 404);
    }
    // Fresh names prevent a prior stopped probe from being reused as evidence.
    if (i > 0)
      await environment.commands.mutation(
        ["rm", environment.ownership.owner + "-mail-net-probe"],
        "supporting-remove-previous-mail-probe-" + i,
      );
    const isolation = await environment.isolationProbe(s);
    assert.equal(isolation.positive.connected, true);
    assert.equal(isolation.appNegative.connected, false);
    assert.equal(isolation.mailNegative.connected, false);
    sentinelAlive();
    stage("restart-" + i + "-" + mode, {
      restart,
      topology: config,
      plugin,
      devices,
      firmware,
      isolation,
    });
  }
  result.sourceAfter = await environment.verifySource(s);
  assert.equal(
    digest(readFileSync(inputs.prepared.shellyZip)),
    inputs.shelly.sha256,
  );
  assert.deepEqual(runtimeIntegrity(), integrity);
  result.cleanup = await environment.stop();
  assert.equal(result.cleanup.status, "complete");
  assert.deepEqual(result.cleanup.pendingMutations, []);
  assert.deepEqual(await environment.stop(), result.cleanup);
  environment = undefined;
  sentinelAlive();
  result.foreignSentinelSurvived = true;
  stage("normal-cleanup", {
    cleanup: result.cleanup,
    foreignSentinelId: sentinel.Id,
    foreignSentinelSurvived: true,
  });
  result.status = "passed";
} catch (error) {
  result.status = "failed";
  result.error = error.message;
  writeFileSync(join(root, "private-error.txt"), error.stack ?? String(error), {
    mode: 0o600,
  });
  process.exitCode = 1;
} finally {
  if (environment)
    try {
      result.cleanup = await environment.stop();
    } catch (e) {
      result.cleanupError = e.message;
    }
  if (foreign)
    try {
      result.sentinelCleanup = await foreign.close();
    } catch (e) {
      result.sentinelCleanupError = e.message;
      process.exitCode = 1;
    }
  result.finishedAt = new Date().toISOString();
  save();
  console.log(
    JSON.stringify({
      root,
      status: result.status,
      error: result.error,
      cleanup: result.cleanup?.status,
      sentinelCleanup: result.sentinelCleanup?.status,
    }),
  );
}
