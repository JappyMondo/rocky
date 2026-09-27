import {
  readFileSync,
  lstatSync,
  readlinkSync,
  realpathSync,
  statSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  requireObservation as need,
  permissions,
  roleAssignments,
  clean,
} from "./assertions.mjs";
import { sha, json, ROOT } from "./runtime.mjs";

import { verifyToolchain } from "./toolchain-identity.mjs";
import { readyService } from "./service-observation.mjs";

export { originalSource } from "./source-provenance.mjs";
import { originalSource } from "./source-provenance.mjs";
export async function sourceSnapshot(rt, env, s) {
  const inventory = rt.inputs.prepared.sourceInventory;
  // Independent read-only verifier. The target inventory input is data, never executable target code.
  const program = `const fs=require('fs'),crypto=require('crypto');const inventory=JSON.parse(fs.readFileSync('/owned/private/source-inventory.json'));const changed=[];for(const [p,e]of Object.entries(inventory)){try{const s=fs.lstatSync(p),m=s.isSymbolicLink()?'120000':s.isFile()?(s.mode&73?'100755':'100644'):'unsupported';const b=s.isSymbolicLink()?Buffer.from(fs.readlinkSync(p)):fs.readFileSync(p);if(m!==e.mode||crypto.createHash('sha256').update(b).digest('hex')!==e.sha256||(!s.isSymbolicLink()&&s.nlink!==1))changed.push(p);}catch{changed.push(p);}}console.log(JSON.stringify({files:Object.keys(inventory).length,changed}));`;
  const result = await env.exec(s, ["node", "-e", program]);
  const observed = JSON.parse(result.stdout);
  need(
    observed.files === Object.keys(inventory).length &&
      observed.changed.length === 0,
    "isolation_failed",
    "ENV01",
    "snapshot-source-drift-or-linked-files",
  );
  const git = await env.exec(s, [
    "git",
    "rev-parse",
    "HEAD",
    "HEAD^{tree}",
    "--show-toplevel",
  ]);
  need(
    git.stdout.trim() ===
      [rt.inputs.targetCommit, rt.inputs.targetTree, "/app"].join("\n"),
    "evidence_missing",
    "ENV01",
    "snapshot-git-identity",
  );
  const generated = await env.exec(s, [
    "git",
    "ls-files",
    "--others",
    "--directory",
    "--no-empty-directory",
    "-z",
  ]);
  const paths = generated.stdout.split("\0").filter(Boolean);
  need(
    paths.every(
      (p) =>
        rt.api.GENERATED.some(
          (a) => p === a || (a.endsWith("/") && p.startsWith(a)),
        ) || /(^|\/)node_modules\/$/.test(p),
    ),
    "isolation_failed",
    "ENV01",
    "unexpected-generated-files",
  );
  return { ...observed, generated: paths, original: originalSource(rt) };
}
export async function runtimeState(rt, env, s) {
  env.commands.store.assertLease(env.commands.lease);
  const inspect = (kind, id) =>
    JSON.parse(rt.internal.dockerRead(env.ownership, [kind, "inspect", id]))[0];
  const app = inspect("container", s.container),
    mail = inspect("container", s.mailpit),
    ingress = inspect("container", s.ingress),
    network = inspect("network", s.network);
  for (const c of [app, mail, ingress])
    need(
      c.Config.Labels["rocky-next.owner"] === env.ownership.owner &&
        c.State.Running === true &&
        !c.HostConfig.Privileged &&
        c.HostConfig.NetworkMode !== "host" &&
        !c.Mounts.some(
          (m) =>
            m.Source.includes("docker.sock") ||
            m.Source.startsWith(rt.api.TARGET.source) ||
            (m.Type === "bind" &&
              !m.Source.startsWith(env.commands.root + "/")),
        ),
      "isolation_failed",
      "ENV05",
      "container-ownership-or-isolation",
    );
  need(
    app.Image === rt.inputs.prepared.devImage &&
      mail.Image === rt.inputs.prepared.mailpitImage,
    "evidence_missing",
    "ENV02",
    "container-image-drift",
  );
  need(
    app.HostConfig.CapDrop?.includes("ALL") &&
      app.HostConfig.SecurityOpt?.includes("no-new-privileges") &&
      app.HostConfig.Tmpfs?.["/fault"]?.includes("size=64k"),
    "isolation_failed",
    "ENV05",
    "capability-or-fault-quota-drift",
  );
  need(
    app.HostConfig.Memory === rt.api.LIMITS.memoryBytes &&
      app.HostConfig.NanoCpus === rt.api.LIMITS.cpus * 1e9 &&
      app.HostConfig.PidsLimit === rt.api.LIMITS.pids,
    "isolation_failed",
    "ENV05",
    "container-limits-drift",
  );
  need(
    network.Internal === true &&
      network.Labels["rocky-next.owner"] === env.ownership.owner &&
      Object.keys(app.NetworkSettings.Networks).length === 1 &&
      Object.keys(mail.NetworkSettings.Networks).length === 1 &&
      app.HostConfig.NetworkMode === s.network &&
      app.NetworkSettings.Networks[s.network]?.Aliases.includes("app") &&
      [app, mail].every((c) =>
        Object.values(c.NetworkSettings.Networks).every((n) => !n.Gateway),
      ),
    "isolation_failed",
    "ENV05",
    "runtime-network-not-internal",
  );
  need(
    Object.keys(app.NetworkSettings.Ports ?? {}).every(
      (p) => !app.NetworkSettings.Ports[p],
    ) &&
      Object.keys(mail.NetworkSettings.Ports ?? {}).every(
        (p) => !mail.NetworkSettings.Ports[p],
      ),
    "isolation_failed",
    "ENV05",
    "direct-private-service-publication",
  );
  for (const [port, url] of [
    ["3000/tcp", s.apiUrl],
    ["4200/tcp", s.frontendUrl],
    ["8025/tcp", s.mailpitUrl],
  ]) {
    const mapping = ingress.NetworkSettings.Ports[port];
    need(
      mapping?.length === 1 &&
        mapping[0].HostIp === "127.0.0.1" &&
        new URL(url).port === mapping[0].HostPort,
      "isolation_failed",
      "ENV04",
      "mapped-port-mismatch",
    );
  }
  const ports = await env.exec(s, ["cat", ".dev-serve-ports.json"]);
  const p = JSON.parse(ports.stdout);
  need(
    p.api.port === 3000 && p.frontend.port === 4200 && Number.isInteger(p.pid),
    "environment_failed",
    "ENV04",
    "ports-file-invalid",
  );
  await env.exec(s, ["bash", "-c", "kill -0 " + p.pid]);
  const api = await fetch(s.apiUrl + "/api/info", {
      redirect: "error",
      signal: AbortSignal.timeout(3000),
    }),
    frontend = await fetch(s.frontendUrl, {
      redirect: "error",
      signal: AbortSignal.timeout(3000),
    });
  need(
    api.status === 200 && frontend.status === 200,
    "environment_failed",
    "ENV04",
    "live-readiness-failed",
  );
  const toolchain = json(join(env.commands.root, "toolchain.json"));
  need(
    Boolean(verifyToolchain(toolchain.stdout, rt.inputs)),
    "evidence_missing",
    "ENV02",
    "toolchain-executable-drift",
  );
  const commands = env.commands.store.commands(env.commands.lease.runId);
  const required = [rt.api.COMMANDS.bootstrap, rt.api.COMMANDS.client];
  for (const args of required) {
    const c = commands.find(
      (c) =>
        JSON.stringify(c.spec.args.slice(-args.length)) ===
        JSON.stringify(args),
    );
    need(
      c?.state === "finished" &&
        c.result?.outcome === "success" &&
        c.result.exitCode === 0,
      "setup_failed",
      "ENV02",
      "required-command-incomplete",
    );
  }
  const bootstrap = commands.find(
    (c) =>
      JSON.stringify(c.spec.args.slice(-rt.api.COMMANDS.bootstrap.length)) ===
      JSON.stringify(rt.api.COMMANDS.bootstrap),
  );
  need(
    readFileSync(bootstrap.result.stdout, "utf8").includes(
      "api:migrations-run",
    ),
    "evidence_missing",
    "ENV02",
    "migration-receipt-missing",
  );
  const db = join(s.root, "storage/cycle/attraccess.sqlite");
  need(
    realpathSync(db).startsWith(realpathSync(s.root) + "/storage/") &&
      statSync(db).isFile(),
    "isolation_failed",
    "ENV03",
    "database-not-owned",
  );
  return {
    containers: [app, mail, ingress].map((c) => ({
      id: c.Id,
      image: c.Image,
      owner: c.Config.Labels["rocky-next.owner"],
      startedAt: c.State.StartedAt,
      pid: c.State.Pid,
    })),
    network: { id: network.Id, internal: network.Internal },
    ports: p,
    service: await readyService(env, s),
    portsSha256: sha(ports.stdout),
    mapped: ingress.NetworkSettings.Ports,
    database: { path: db, device: statSync(db).dev, inode: statSync(db).ino },
    toolchainSha256: sha(toolchain.stdout),
    commands: required.map(
      (args) =>
        commands.find(
          (c) =>
            JSON.stringify(c.spec.args.slice(-args.length)) ===
            JSON.stringify(args),
        ).id,
    ),
  };
}
export async function repeatedIsolation(rt, env, s) {
  // isolationProbe retains its completed Mailpit namespace container. Match the
  // reviewed producer's documented repeated-probe lifecycle without touching an
  // active, foreign or uncertain resource; its prior command receipts stay intact.
  env.commands.store.assertLease(env.commands.lease);
  const name = env.ownership.owner + "-mail-net-probe";
  need(
    env.ownership.containers.includes(name),
    "isolation_failed",
    "ENV05",
    "missing-owned-prior-mail-probe",
  );
  const probe = rt.internal.assertOwned(env.ownership, "container", name);
  const mail = rt.internal.assertOwned(env.ownership, "container", s.mailpit);
  need(
    probe.State.Running === false &&
      probe.State.ExitCode === 0 &&
      probe.HostConfig.NetworkMode === "container:" + mail.Id &&
      probe.Image === rt.inputs.prepared.devImage,
    "isolation_failed",
    "ENV05",
    "prior-mail-probe-not-completed-owned-resource",
  );
  const retained = {
    id: probe.Id,
    owner: probe.Config.Labels["rocky-next.owner"],
    startedAt: probe.State.StartedAt,
    finishedAt: probe.State.FinishedAt,
    exitCode: probe.State.ExitCode,
    networkMode: probe.HostConfig.NetworkMode,
  };
  env.commands.save(
    "prior-probe-" + s.nxWorkspaceDataDirectory.split("/").at(-1),
    retained,
  );
  await env.commands.mutation(
    ["rm", probe.Id],
    "independent-completed-probe-remove-" +
      s.nxWorkspaceDataDirectory.split("/").at(-1),
    3000,
  );
  return { previousCompletedProbe: retained, ...(await env.isolationProbe(s)) };
}
export async function fixtureState(rt, env, s, prior = []) {
  const admin = env.api(s);
  need(
    (await admin.login(s.admin)).status === 201,
    "fixture_failed",
    "ENV06",
    "fixture-admin-credentials",
  );
  const current = await admin.request("/api/users/me");
  need(current.status === 200, "fixture_failed", "ENV06", "fixture-admin-read");
  s.admin.id = current.body.id;
  permissions(current.body, "admin");
  const expectedAdmin = [
    ...readFileSync(
      join(rt.api.TARGET.source, "libs/shared/src/lib/system-permissions.ts"),
      "utf8",
    ).matchAll(/\| '([^']+)'/g),
  ]
    .map((m) => m[1])
    .sort();
  need(
    JSON.stringify([...current.body.effectivePermissions].sort()) ===
      JSON.stringify(expectedAdmin),
    "fixture_failed",
    "ENV06",
    "admin-exact-permissions",
  );
  const adminRoles = await admin.request(
    "/api/users/" + current.body.id + "/roles",
  );
  need(
    adminRoles.status === 200,
    "fixture_failed",
    "ENV06",
    "admin-roles-unavailable",
  );
  roleAssignments(adminRoles.body, current.body, "admin", s.id);
  const userReads = {
    admin: {
      id: current.body.id,
      permissions: current.body.effectivePermissions,
      roles: adminRoles.body,
    },
  };
  for (const [kind, user] of Object.entries(s.users)) {
    const api = env.api(s);
    need(
      (await api.login(user)).status === 201,
      "fixture_failed",
      "ENV06",
      "fixture-user-credentials",
    );
    const me = await api.request("/api/users/me");
    need(me.status === 200, "fixture_failed", "ENV06", "fixture-user-read");
    permissions(me.body, kind);
    userReads[kind] = {
      id: me.body.id,
      permissions: me.body.effectivePermissions,
    };
    const roles = await admin.request("/api/users/" + me.body.id + "/roles");
    need(
      roles.status === 200,
      "fixture_failed",
      "ENV06",
      "member-or-denied-admin-role",
    );
    userReads[kind].roles = roleAssignments(roles.body, me.body, kind, s.id);
  }
  const resources = await admin.request("/api/resources?limit=100");
  need(
    resources.status === 200 && Array.isArray(resources.body.data),
    "fixture_failed",
    "ENV03",
    "resource-list-unavailable",
  );
  const data = resources.body.data;
  need(
    data.length === 1 &&
      data[0].name === "resource-" + s.id &&
      data[0].groups?.length === 1 &&
      data[0].groups[0].name === "group-" + s.id,
    "isolation_failed",
    "ENV03",
    "resource-group-or-cycle-sentinel-mismatch",
  );
  const db = new DatabaseSync(join(s.root, "storage/cycle/attraccess.sqlite"), {
    readOnly: true,
  });
  let names;
  try {
    names = db
      .prepare("SELECT username FROM user")
      .all()
      .map((r) => r.username);
  } finally {
    db.close();
  }
  for (const old of prior) {
    need(
      !data.some((r) => r.description === old.description) &&
        !names.includes(old.username),
      "isolation_failed",
      "ENV03",
      "prior-fixture-survived",
    );
    if (old.cookie)
      need(
        (
          await env
            .api(s)
            .request("/api/users/me", { headers: { cookie: old.cookie } })
        ).status === 401,
        "isolation_failed",
        "ENV03",
        "prior-session-survived",
      );
  }
  // Keep structural/group checks above contamination detection, so unrelated
  // damage cannot satisfy X08. A known prior sentinel is diagnosed before the
  // generic current-description check; unknown/wrong descriptions still fail.
  need(
    data[0].description === "cycle-sentinel-" + s.id,
    "isolation_failed",
    "ENV03",
    "resource-group-or-cycle-sentinel-mismatch",
  );
  return { users: userReads, resource: data[0] };
}
export function cleanupState(rt, env, receipt) {
  clean(receipt);
  for (const args of [
    ["ps", "-aq"],
    ["network", "ls", "-q"],
  ])
    need(
      rt.internal
        .dockerRead(env.ownership, [
          ...args,
          "--filter",
          "label=rocky-next.owner=" + env.ownership.owner,
        ])
        .trim() === "",
      "isolation_failed",
      "ENV13",
      "owned-resource-survived",
    );
  need(
    (env.ownership.browsers ?? []).every((p) => !rt.processIdentity.matches(p)),
    "isolation_failed",
    "ENV13",
    "browser-survived",
  );
  const db = new DatabaseSync(join(env.commands.root, "run.sqlite"), {
    readOnly: true,
  });
  let effects;
  try {
    effects = db
      .prepare("SELECT data FROM effects")
      .all()
      .map((r) => JSON.parse(r.data));
  } finally {
    db.close();
  }
  need(
    !effects.some((e) => ["pending", "sending"].includes(e.state)),
    "isolation_failed",
    "ENV13",
    "pending-effect",
  );
  return {
    receipt,
    effects: effects.map((e) => ({ key: e.key, kind: e.kind, state: e.state })),
    independentEmptyListing: true,
  };
}

export function freshDatabase(s) {
  const db = new DatabaseSync(join(s.root, "storage/cycle/attraccess.sqlite"), {
    readOnly: true,
  });
  try {
    const users = Number(db.prepare("SELECT COUNT(*) AS n FROM user").get().n),
      settings = db
        .prepare(
          "SELECT parent,key FROM setting WHERE parent IN ('app','smtp')",
        )
        .all();
    need(
      users === 0 && settings.length === 0,
      "fixture_failed",
      "ENV10",
      "fresh-install-db-preseeded",
    );
    return { users, appAndSmtpSettings: settings };
  } finally {
    db.close();
  }
}
