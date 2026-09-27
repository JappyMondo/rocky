import { validateAdmission, type AdmissionApproval } from "./admission.js";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statfsSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { EnvironmentCommands } from "./commands.js";
import { TARGET, LIMITS, COMMANDS, GENERATED } from "./policy.js";
import { ownedPath, sourceInventory, type SourceInventory } from "./source.js";
import {
  persistOwnership,
  cleanOwned,
  assertOwned,
  dockerRead,
  type Ownership,
} from "./resources.js";
import {
  account,
  ApiSession,
  verifyMail,
  mailboxIds,
  redact,
  type Account,
} from "./http.js";
import { openBrowser, type BrowserSession } from "../runner/browser.js";
import { digest, canonical, type Json } from "../store/json.js";
import { delay, identify, matches } from "../runner/process.js";
export type Fixture =
  | "admin_resources"
  | "member"
  | "denied"
  | "fresh_2fa"
  | "fresh_install"
  | "shelly";
export interface PreparedEnvironment {
  devImage: string;
  mailpitImage: string;
  sourceInventory: SourceInventory;
  browserExecutable: string;
  shellyZip: string;
}
export interface Session {
  id: string;
  root: string;
  fixture: Fixture;
  container: string;
  mailpit: string;
  ingress: string;
  network: string;
  prepareNetwork: string;
  apiUrl: string;
  frontendUrl: string;
  mailpitUrl: string;
  admin: Account;
  users: Record<string, Account>;
  ports: unknown;
  instanceId?: string;
}
const COMMUNITY =
  "I AM USING THIS SOFTWARE ONLY FOR NON-PROFIT AND COMPLY TO ALL TERMS OF THE LICENSE.md at https://github.com/Attraccess/Attraccess/blob/main/LICENSE.md";
export type EnvironmentAuthority =
  | { purpose: "preparation" }
  | {
      purpose: "qualification";
      admissionPath: string;
      approval: AdmissionApproval;
    };
export class AttraccessEnvironment {
  readonly commands: EnvironmentCommands;
  readonly ownership: Ownership;
  #heartbeat: NodeJS.Timeout;
  #browsers = new Set<BrowserSession>();
  #sequence = 0;
  #sessions = new Set<Session>();
  #observers = new Map<Session, ApiSession>();
  #stopped?: Promise<ReturnType<typeof cleanOwned>>;
  constructor(
    readonly prepared: PreparedEnvironment,
    readonly attemptId: string,
    readonly authority: EnvironmentAuthority = { purpose: "preparation" },
  ) {
    if (authority.purpose === "qualification")
      validateAdmission(authority.admissionPath, authority.approval, prepared);
    if (!/^[A-Za-z0-9-]+$/.test(attemptId))
      throw new Error("invalid-attempt-id");
    const root = ownedPath(join(TARGET.root, "attempts", attemptId));
    if (existsSync(root)) throw new Error("attempt-already-exists");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.commands = new EnvironmentCommands(
      root,
      attemptId,
      undefined,
      authority.purpose === "qualification"
        ? "environment-qualification"
        : "environment-preparation",
    );
    this.ownership = {
      owner: "rn-" + randomUUID(),
      root,
      docker: this.commands.docker,
      dockerHost: this.commands.dockerHost,
      expiresAt: Date.now() + LIMITS.leaseMs,
      containers: [],
      networks: [],
    };
    persistOwnership(this.ownership);
    this.commands.store.guardedStart(this.commands.lease, () => {
      const guardian = spawn(
        process.execPath,
        [fileURLToPath(new URL("./guardian.js", import.meta.url)), root],
        {
          detached: true,
          stdio: "ignore",
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        },
      );
      guardian.unref();
    });
    this.#heartbeat = setInterval(() => {
      try {
        this.commands.store.renew(this.commands.lease, LIMITS.leaseMs);
        this.commands.store.assertLease(this.commands.lease);
        this.ownership.expiresAt = Date.now() + LIMITS.leaseMs;
        persistOwnership(this.ownership);
      } catch {
        for (const browser of this.#browsers)
          void browser.close().catch(() => {});
        /* Guardian expires and cleans only this durable owner. */
      }
    }, 1000);
  }
  async #mutate(args: string[], name: string) {
    this.commands.store.assertLease(this.commands.lease);
    return this.commands.mutation(args, String(++this.#sequence) + "-" + name);
  }
  async #inspect(container: string) {
    return assertOwned(this.ownership, "container", container);
  }
  #private(session: Session, name: string, value: unknown) {
    writeFileSync(
      join(session.root, "private", name + ".json"),
      JSON.stringify(value),
      { mode: 0o600 },
    );
  }
  async provision(
    fixture: Fixture,
    options: { hostPorts?: { api: number; frontend: number } } = {},
  ): Promise<Session> {
    for (const port of Object.values(options.hostPorts ?? {}))
      if (!Number.isSafeInteger(port) || port < 1024 || port > 65535)
        throw new Error("invalid-owned-port-request");
    this.commands.store.assertLease(this.commands.lease);
    const disk = statfsSync(TARGET.root);
    const availableBytes = disk.bavail * disk.bsize;
    this.commands.save("disk-admission", {
      availableBytes,
      minimumBytes: LIMITS.diskMinimumBytes,
    });
    if (availableBytes < LIMITS.diskMinimumBytes)
      throw new Error("insufficient-owned-environment-disk-headroom");
    const root = join(this.commands.root, "container");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    mkdirSync(join(root, "private"), { mode: 0o700 });
    mkdirSync(join(root, "storage"), { mode: 0o700 });
    mkdirSync(join(root, "storage", "cycle"), { mode: 0o700 });
    const name = this.ownership.owner;
    const network = name + "-runtime",
      prepareNetwork = name + "-prepare";
    await this.#mutate(
      [
        "network",
        "create",
        "--internal",
        "--label",
        "rocky-next.owner=" + name,
        network,
      ],
      "runtime-network",
    );
    this.ownership.networks.push(network);
    persistOwnership(this.ownership);
    await this.#mutate(
      [
        "network",
        "create",
        "--label",
        "rocky-next.owner=" + name,
        prepareNetwork,
      ],
      "prepare-network",
    );
    this.ownership.networks.push(prepareNetwork);
    persistOwnership(this.ownership);
    const heartbeatScript = `const fs=require('fs');setInterval(()=>{try{const s=JSON.parse(fs.readFileSync('/control/ownership.json'));if(Date.now()>s.expiresAt)process.exit(70);}catch{process.exit(71);}},500);`;
    writeFileSync(join(root, "heartbeat.cjs"), heartbeatScript, {
      mode: 0o600,
    });
    writeFileSync(
      join(root, "private", "app.env"),
      "AUTH_SESSION_SECRET=" + randomBytes(32).toString("hex") + "\n",
      { mode: 0o600 },
    );
    const mailpit = name + "-mail";
    await this.#mutate(
      [
        "create",
        "--name",
        mailpit,
        "--label",
        "rocky-next.owner=" + name,
        "--network",
        network,
        "--network-alias",
        "mailpit",

        "--memory",
        "128m",
        "--cpus",
        "0.5",
        "--pids-limit",
        "64",
        "--read-only",
        "--tmpfs",
        "/tmp:rw,size=64m",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--env",
        "MP_MAX_MESSAGES=30",
        this.prepared.mailpitImage,
      ],
      "mail-create",
    );
    this.ownership.containers.push(mailpit);
    persistOwnership(this.ownership);
    await this.#mutate(["start", mailpit], "mail-start");
    const container = name + "-app";
    await this.#mutate(
      [
        "create",
        "--name",
        container,
        "--label",
        "rocky-next.owner=" + name,
        "--hostname",
        container,
        "--network",
        prepareNetwork,

        "--memory",
        String(LIMITS.memoryBytes),
        "--cpus",
        String(LIMITS.cpus),
        "--pids-limit",
        String(LIMITS.pids),
        "--init",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--stop-timeout",
        "3",
        "--tmpfs",
        "/tmp:rw,size=512m",
        "--tmpfs",
        "/fault:rw,size=64k",
        "--mount",
        "type=bind,src=" + root + ",dst=/owned",
        "--mount",
        "type=bind,src=" +
          join(this.commands.root, "control") +
          ",dst=/control,readonly",
        "--mount",
        "type=bind,src=" + join(root, "storage") + ",dst=/app/storage",
        "--mount",
        "type=bind,src=" +
          join(root, "private", "app.env") +
          ",dst=/app/.env,readonly",
        "--env",
        "RESTART_BY_EXIT=true",
        "--env",
        "NX_NATIVE_FILE_CACHE_DIRECTORY=/app/.nx/native",
        this.prepared.devImage,
        "node",
        "/owned/heartbeat.cjs",
      ],
      "app-create",
    );
    this.ownership.containers.push(container);
    persistOwnership(this.ownership);
    await this.#mutate(["start", container], "app-start");
    const ingressNetwork = name + "-ingress";
    await this.#mutate(
      [
        "network",
        "create",
        "--label",
        "rocky-next.owner=" + name,
        ingressNetwork,
      ],
      "ingress-network",
    );
    this.ownership.networks.push(ingressNetwork);
    persistOwnership(this.ownership);
    const proxy = `const net=require('net');for(const [port,host,target] of [[3000,'app',3000],[4200,'app',4200],[8025,'mailpit',8025]])net.createServer(client=>{const upstream=net.connect(target,host);client.on('error',()=>upstream.destroy());upstream.on('error',()=>client.destroy());client.on('close',()=>upstream.destroy());upstream.on('close',()=>client.destroy());client.pipe(upstream).pipe(client);}).listen(port,'0.0.0.0');`;
    writeFileSync(join(root, "proxy.cjs"), proxy, { mode: 0o600 });
    const ingress = name + "-ingress";
    await this.#mutate(
      [
        "create",
        "--name",
        ingress,
        "--label",
        "rocky-next.owner=" + name,
        "--network",
        ingressNetwork,
        "--publish",
        "127.0.0.1:" + (options.hostPorts?.api ?? "") + ":3000",
        "--publish",
        "127.0.0.1:" + (options.hostPorts?.frontend ?? "") + ":4200",
        "--publish",
        "127.0.0.1::8025",
        "--memory",
        "128m",
        "--cpus",
        "0.5",
        "--pids-limit",
        "64",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--mount",
        "type=bind,src=" + join(root, "proxy.cjs") + ",dst=/proxy.cjs,readonly",
        this.prepared.devImage,
        "node",
        "/proxy.cjs",
      ],
      "ingress-create",
    );
    this.ownership.containers.push(ingress);
    persistOwnership(this.ownership);
    await this.#mutate(
      ["network", "connect", network, ingress],
      "ingress-connect",
    );
    await this.#mutate(["start", ingress], "ingress-start");
    const app = await this.#inspect(container),
      mail = await this.#inspect(mailpit),
      gateway = await this.#inspect(ingress);
    this.commands.save("publication-configuration", {
      ports: gateway.NetworkSettings.Ports,
      networks: gateway.NetworkSettings.Networks,
      hostConfig: gateway.HostConfig,
      mailpitPorts: mail.NetworkSettings.Ports,
    });
    const port = (o: any, p: string) => {
      const mappings = o.NetworkSettings.Ports[p];
      if (mappings?.length !== 1 || mappings[0].HostIp !== "127.0.0.1")
        throw new Error("non-loopback-publication");
      return Number(mappings[0].HostPort);
    };
    const session: Session = {
      id: this.attemptId,
      root,
      fixture,
      container,
      mailpit,
      ingress,
      network,
      prepareNetwork,
      apiUrl: "http://127.0.0.1:" + port(gateway, "3000/tcp"),
      frontendUrl: "http://127.0.0.1:" + port(gateway, "4200/tcp"),
      mailpitUrl: "http://127.0.0.1:" + port(gateway, "8025/tcp"),
      admin: account("admin"),
      users: {},
      ports: gateway.NetworkSettings.Ports,
    };
    this.#sessions.add(session);
    this.#private(session, "admin", session.admin);
    this.#writeEnv(session, false);
    this.commands.save("container-configuration", {
      container: app.Id,
      image: app.Image,
      hostConfig: {
        networkMode: app.HostConfig.NetworkMode,
        portBindings: app.HostConfig.PortBindings,
        capDrop: app.HostConfig.CapDrop,
        securityOpt: app.HostConfig.SecurityOpt,
        memory: app.HostConfig.Memory,
        nanoCpus: app.HostConfig.NanoCpus,
        pidsLimit: app.HostConfig.PidsLimit,
        mounts: app.Mounts,
      },
      mailpitId: mail.Id,
      owner: name,
    });
    this.commands.save(
      "source-before-bootstrap",
      await this.verifySource(session),
    );
    const toolchain = await this.exec(session, [
      "bash",
      "-c",
      "command -v node pnpm bash sed rm git zip && node --version && pnpm --version && sha256sum /usr/local/bin/node /usr/local/bin/pnpm /usr/bin/zip",
    ]);
    this.commands.save("toolchain", { stdout: toolchain.stdout });
    await this.exec(session, COMMANDS.bootstrap);
    await this.exec(session, COMMANDS.client);
    if (fixture !== "fresh_install") await this.#seed(session);
    await this.verifySource(session);
    return session;
  }
  #writeEnv(s: Session, disabled: boolean) {
    const path = join(s.root, "private", "app.env");
    const prior = readFileSync(path, "utf8");
    const secret = prior
      .split("\n")
      .find((l) => l.startsWith("AUTH_SESSION_SECRET="));
    if (!secret) throw new Error("missing-session-secret");
    const lines = [
      secret,
      "STORAGE_ROOT=/app/storage/cycle",
      "PLUGIN_DIR=/app/storage/plugins",
      "PORT=3000",
      "VITE_PORT=4200",
      "VITE_PREVIEW_PORT=4300",
      "NX_DAEMON=false",
      "NX_SKIP_NX_CACHE=true",
      "NX_NATIVE_FILE_CACHE_DIRECTORY=/app/.nx/native",
      "CI=true",
      "INSTALL_ESP_IDF=false",
      "RESTART_BY_EXIT=true",
      "LOG_LEVELS=error,warn,log",
    ];
    if (s.fixture !== "fresh_install")
      lines.push(
        "ATTRACCESS_URL=" + s.apiUrl,
        "ATTRACCESS_FRONTEND_URL=" + s.frontendUrl,
        "LICENSE_KEY=" + COMMUNITY,
        "SMTP_SERVICE=SMTP",
        "SMTP_HOST=mailpit",
        "SMTP_PORT=1025",
        "SMTP_FROM=no-reply@fixture.invalid",
        "SMTP_SECURE=false",
      );
    if (disabled) lines.push("DISABLE_PLUGINS=true");
    writeFileSync(path, lines.join("\n") + "\n", { mode: 0o600 });
  }
  async exec(s: Session, args: readonly string[], timeoutMs = LIMITS.setupMs) {
    await this.#inspect(s.container);
    return this.commands.dockerCommand(
      ["exec", "--workdir", "/app", s.container, ...args],
      timeoutMs,
    );
  }
  async #seed(s: Session) {
    const seed = {
      ...s.admin,
      db: "/app/storage/cycle/attraccess.sqlite",
      fixture: "/owned/private/seed-fixture.json",
    };
    this.#private(s, "seed-input", seed);
    this.#private(s, "seed-fixture", {
      resourceGroups: [
        { name: "group-" + s.id, description: "owned environment fixture" },
      ],
      resources: [
        {
          name: "resource-" + s.id,
          type: "machine",
          description: "cycle-sentinel-" + s.id,
          groups: ["group-" + s.id],
        },
      ],
    });
    const wrapper = `const fs=require('fs'),cp=require('child_process');const s=JSON.parse(fs.readFileSync('/owned/private/seed-input.json'));const r=cp.spawnSync(process.execPath,['scripts/seed-dev-user.mjs','--db',s.db,'--username',s.username,'--email',s.email,'--password',s.password,'--fixture',s.fixture],{cwd:'/app',encoding:'utf8'});fs.writeFileSync('/owned/private/seed-raw.log',r.stdout+r.stderr,{mode:384});console.log('Seed execution complete; credential output private');process.exit(r.status??1);`;
    writeFileSync(join(s.root, "private", "seed.cjs"), wrapper, {
      mode: 0o600,
    });
    await this.exec(s, ["node", "/owned/private/seed.cjs"]);
  }
  async start(s: Session) {
    await this.#inspect(s.container);
    const app = await this.#inspect(s.container);
    if (app.NetworkSettings.Networks[s.prepareNetwork]) {
      await this.#mutate(
        ["network", "connect", "--alias", "app", s.network, s.container],
        "runtime-connect",
      );
      await this.#mutate(
        ["network", "disconnect", s.prepareNetwork, s.container],
        "preparation-egress-disconnect",
      );
      await this.#mutate(
        ["network", "rm", s.prepareNetwork],
        "prepare-network-remove",
      );
    }
    const wrapper = `const fs=require('fs'),cp=require('child_process');const fd=fs.openSync('/owned/private/serve.log','w',384);let total=0,retained=0;const child=cp.spawn('pnpm',['serve'],{cwd:'/app',env:process.env,stdio:['ignore','pipe','pipe']});fs.writeFileSync('/owned/private/serve-process.json',JSON.stringify({pid:child.pid,startedAt:Date.now()}),{mode:384});for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{total+=chunk.length;const n=Math.min(chunk.length,${LIMITS.logBytes}-retained);if(n>0){fs.writeSync(fd,chunk,0,n);retained+=n;}});child.on('close',(code,signal)=>{fs.closeSync(fd);fs.writeFileSync('/owned/private/serve-exit.json',JSON.stringify({code,signal,totalBytes:total,retainedBytes:retained,truncated:total>retained}),{mode:384});process.exit(code??1);});`;
    writeFileSync(join(s.root, "private", "serve.cjs"), wrapper, {
      mode: 0o600,
    });
    await this.exec(s, [
      "bash",
      "-c",
      "node /owned/private/serve.cjs >/dev/null 2>&1 & echo $! > /owned/private/serve.pid",
    ]);
    return this.readiness(s);
  }
  async readiness(s: Session) {
    const end = Date.now() + LIMITS.serveMs;
    let last = "not-ready";
    while (Date.now() < end) {
      this.commands.store.assertLease(this.commands.lease);
      try {
        const portResult = await this.exec(
          s,
          ["cat", ".dev-serve-ports.json"],
          10000,
        );
        const ports = JSON.parse(portResult.stdout);
        if (ports.api.port !== 3000 || ports.frontend.port !== 4200)
          throw new Error("unexpected-internal-ports");
        const [api, frontend] = await Promise.all([
          fetch(s.apiUrl + "/api/info", { signal: AbortSignal.timeout(3000) }),
          fetch(s.frontendUrl, { signal: AbortSignal.timeout(3000) }),
        ]);
        if (!api.ok || !frontend.ok) throw new Error("readiness-http-failed");
        const info = await api.json();
        const receipt = {
          at: new Date().toISOString(),
          ports,
          portsSha256: digest(portResult.stdout),
          mappings: s.ports,
          apiStatus: api.status,
          frontendStatus: frontend.status,
          info,
          containerId: (await this.#inspect(s.container)).Id,
        };
        this.commands.save("readiness-" + ++this.#sequence, receipt);
        return receipt;
      } catch (error) {
        last = error instanceof Error ? error.message : "unknown";
        await delay(1000);
      }
    }
    throw new Error("environment-readiness-timeout:" + last);
  }
  async isolationProbe(s: Session) {
    await this.#inspect(s.container);
    const ingressNetwork = this.ownership.owner + "-ingress";
    const sentinel = this.ownership.owner + "-egress-sentinel";
    await this.#mutate(
      [
        "create",
        "--name",
        sentinel,
        "--label",
        "rocky-next.owner=" + this.ownership.owner,
        "--network",
        ingressNetwork,
        "--read-only",
        "--memory",
        "128m",
        "--pids-limit",
        "32",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        this.prepared.devImage,
        "node",
        "-e",
        "require('net').createServer(s=>s.end('owned-sentinel')).listen(9090,'0.0.0.0')",
      ],
      "egress-sentinel-create",
    );
    this.ownership.containers.push(sentinel);
    persistOwnership(this.ownership);
    await this.#mutate(["start", sentinel], "egress-sentinel-start");
    const inspect = await this.#inspect(sentinel);
    const ip = inspect.NetworkSettings.Networks[ingressNetwork].IPAddress;
    const probe = (expect: boolean) =>
      `const net=require('net');const s=net.connect(9090,${JSON.stringify(ip)});let done=false;const finish=(connected,error)=>{if(done)return;done=true;s.destroy();console.log(JSON.stringify({target:'owned-sentinel',connected,error}));process.exit(connected===${expect}?0:2);};s.setTimeout(2000,()=>finish(false,'timeout'));s.on('connect',()=>finish(true,null));s.on('error',e=>finish(false,e.code));`;
    const positive = await this.commands.dockerCommand(
      ["exec", s.ingress, "node", "-e", probe(true)],
      10000,
    );
    const appNegative = await this.exec(s, ["node", "-e", probe(false)], 10000);
    await this.#inspect(s.mailpit);
    const mailProbe = this.ownership.owner + "-mail-net-probe";
    const mailNegative = await this.commands.dockerCommand(
      [
        "run",
        "--rm",
        "--name",
        mailProbe,
        "--label",
        "rocky-next.owner=" + this.ownership.owner,
        "--network",
        "container:" + s.mailpit,
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        this.prepared.devImage,
        "node",
        "-e",
        probe(false),
      ],
      10000,
    );
    const receipt = {
      sentinelId: inspect.Id,
      positive: JSON.parse(positive.stdout),
      appNegative: JSON.parse(appNegative.stdout),
      mailNegative: JSON.parse(mailNegative.stdout),
      appNetworks: (await this.#inspect(s.container)).NetworkSettings.Networks,
      mailNetworks: (await this.#inspect(s.mailpit)).NetworkSettings.Networks,
    };
    this.commands.save("network-isolation", receipt);
    await this.#mutate(["rm", "--force", sentinel], "egress-sentinel-remove");
    return receipt;
  }
  api(s: Session) {
    if (!this.#sessions.has(s)) throw new Error("foreign-session");
    return new ApiSession(s.apiUrl, 15000, (request, start) =>
      this.commands.httpEffect(request, start),
    );
  }
  async provisionAccounts(s: Session) {
    if (s.fixture === "fresh_install")
      return {
        fixture: "fresh_install",
        admin: s.admin,
        communityLicense: COMMUNITY,
        smtp: {
          service: "SMTP",
          host: "mailpit",
          port: 1025,
          secure: false,
          from: "no-reply@fixture.invalid",
        },
      };
    const admin = this.api(s);
    const login = await admin.login(s.admin);
    if (login.status !== 201 && login.status !== 200)
      throw new Error("fixture-admin-login-failed");
    await this.captureInstance(s, admin);
    const result: Record<string, unknown> = {
      admin: await admin.request("/api/users/me"),
    };
    if (["member", "denied", "fresh_2fa"].includes(s.fixture))
      for (const kind of s.fixture === "fresh_2fa"
        ? ["fresh_2fa"]
        : ["member", "denied"]) {
        const user = account(kind);
        const anonymous = this.api(s);
        const priorMail = await mailboxIds(s.mailpitUrl);
        const created = await anonymous.json("/api/users", "POST", {
          ...user,
          strategy: "local_password",
        });
        if (created.status !== 201)
          throw new Error("fixture-registration-failed");
        user.id = (created.body as { id: number }).id;
        const verified = await verifyMail(
          s.mailpitUrl,
          user,
          anonymous,
          s.frontendUrl,
          priorMail,
        );
        if (verified.status !== 201 && verified.status !== 200)
          throw new Error("fixture-email-verification-failed");
        if (kind === "member") {
          const role = await admin.json("/api/rbac/roles", "POST", {
            name: "role-" + s.id,
            permissionKeys: ["resources.update"],
          });
          if (role.status !== 201)
            throw new Error("fixture-role-create-failed");
          const grant = await admin.json(
            "/api/users/" + user.id + "/roles",
            "POST",
            { roleId: (role.body as { id: number }).id },
          );
          if (grant.status !== 201 && grant.status !== 200)
            throw new Error("fixture-role-grant-failed");
        }
        const session = this.api(s);
        await session.login(user);
        result[kind] = {
          createdStatus: created.status,
          verifiedStatus: verified.status,
          me: await session.request("/api/users/me"),
        };
        s.users[kind] = user;
        this.#private(s, "account-" + kind, user);
      }
    this.commands.save("fixture-readbacks", redact(result));
    return result;
  }
  async captureInstance(s: Session, observer: ApiSession) {
    if (!this.#sessions.has(s) || observer.base !== s.apiUrl)
      throw new Error("foreign-session");
    const result = await observer.request("/api/plugins/status");
    const body = result.body as { instanceId?: string; disabled?: boolean };
    if (result.status !== 200 || typeof body.instanceId !== "string")
      throw new Error("instance-identity-unavailable");
    s.instanceId = body.instanceId;
    this.#observers.set(s, observer);
    this.commands.save("instance-" + ++this.#sequence, {
      status: result.status,
      ...body,
    });
    return body;
  }
  async restart(
    s: Session,
    options: { pluginMode: "enabled" | "disabled"; observer?: ApiSession },
  ) {
    await this.#inspect(s.container);
    this.#writeEnv(s, options.pluginMode === "disabled");
    // Restart the entire receipt-owned container; RESTART_BY_EXIT prevents detached plugin replacement.
    await this.#mutate(["restart", "--time", "3", s.container], "app-restart");
    const readiness = await this.start(s);
    const previousInstanceId = s.instanceId;
    const observer = options.observer ?? this.#observers.get(s) ?? this.api(s);
    if (!options.observer && !this.#observers.has(s))
      await observer.login(s.admin);
    const instance = await this.captureInstance(s, observer);
    if (previousInstanceId && previousInstanceId === instance.instanceId)
      throw new Error("restart-instance-unchanged");
    return { readiness, previousInstanceId, instance };
  }
  async verifySource(s: Session) {
    const original = digest(canonical(sourceInventory()));
    if (original !== digest(canonical(this.prepared.sourceInventory)))
      throw new Error("original-target-source-drift");
    writeFileSync(
      join(s.root, "private", "source-inventory.json"),
      JSON.stringify(this.prepared.sourceInventory),
      { mode: 0o600 },
    );
    const script = `const fs=require('fs'),p=require('path'),c=require('crypto');const files=JSON.parse(fs.readFileSync('/owned/private/source-inventory.json'));const changed=[];for(const [name,entry] of Object.entries(files)){try{const path=p.join('/app',name),st=fs.lstatSync(path),bytes=st.isSymbolicLink()?Buffer.from(fs.readlinkSync(path)):fs.readFileSync(path);if(c.createHash('sha256').update(bytes).digest('hex')!==entry.sha256 || (entry.mode==='120000')!==st.isSymbolicLink() || (entry.mode==='100755' && !(st.mode&64)))changed.push(name);}catch{changed.push(name);}}console.log(JSON.stringify({files:Object.keys(files).length,changed}));process.exit(changed.length?2:0);`;
    writeFileSync(join(s.root, "private", "inventory.cjs"), script, {
      mode: 0o600,
    });
    const result = await this.exec(s, ["node", "/owned/private/inventory.cjs"]);
    const git = await this.exec(s, [
      "git",
      "rev-parse",
      "HEAD",
      "HEAD^{tree}",
      "--show-toplevel",
    ]);
    if (git.stdout.trim() !== [TARGET.commit, TARGET.tree, "/app"].join("\n"))
      throw new Error("wrong-target-git-identity");
    const branch = (
      await this.exec(s, ["git", "branch", "--show-current"])
    ).stdout.trim();
    if (branch) throw new Error("target-snapshot-not-detached");
    const generated = (
      await this.exec(s, [
        "git",
        "ls-files",
        "--others",
        "--directory",
        "--no-empty-directory",
        "-z",
      ])
    ).stdout
      .split("\0")
      .filter(Boolean);
    const unexpected = generated.filter(
      (path) =>
        !GENERATED.some(
          (allowed) =>
            path === allowed ||
            (allowed.endsWith("/") && path.startsWith(allowed)),
        ) && !/^(.+\/)?node_modules\/$/.test(path),
    );
    if (unexpected.length)
      throw new Error("unexpected-generated-output:" + unexpected.join(","));
    return {
      inventory: JSON.parse(result.stdout),
      originalSourceInventorySha256: original,
      git: git.stdout,
      branch,
      base: TARGET.commit,
      head: TARGET.commit,
      generated,
    };
  }
  async runScenario<T>(
    s: Session,
    scenario: {
      id: string;
      locale: "en" | "de";
      viewport: { width: number; height: number };
      admissionPath: string;
      approval: AdmissionApproval;
    },
    execute: (browser: BrowserSession, session: Session) => Promise<T>,
  ): Promise<T> {
    if (!/^[A-Za-z0-9-]+$/.test(scenario.id))
      throw new Error("invalid-scenario-id");
    validateAdmission(scenario.admissionPath, scenario.approval, this.prepared);
    const key = this.attemptId + "/browser/" + randomUUID();
    this.commands.store.transition(
      this.commands.lease,
      "browser-scenario-intent",
      {
        key,
        kind: "owned-browser-scenario",
        payload: {
          id: scenario.id,
          locale: scenario.locale,
          viewport: scenario.viewport,
          admissionSha256: scenario.approval.admissionSha256,
        },
      },
    );
    let result: T;
    let failure: unknown;
    const effect = await this.commands.store.dispatch(
      this.commands.lease,
      key,
      {
        begin: () =>
          this.#executeScenario(s, scenario, execute)
            .then((value) => {
              result = value;
              return { scenarioId: scenario.id, executionCompleted: true };
            })
            .catch((error) => {
              failure = error;
              throw error;
            }),
      },
    );
    if (effect.state !== "confirmed")
      throw failure ?? new Error("browser-scenario-reconciliation-required");
    return result!;
  }
  async #executeScenario<T>(
    s: Session,
    scenario: {
      id: string;
      locale: "en" | "de";
      viewport: { width: number; height: number };
      admissionPath: string;
      approval: AdmissionApproval;
    },
    execute: (browser: BrowserSession, session: Session) => Promise<T>,
  ): Promise<T> {
    if (
      this.authority.purpose !== "qualification" ||
      this.authority.admissionPath !== scenario.admissionPath ||
      this.authority.approval.admissionSha256 !==
        scenario.approval.admissionSha256
    )
      throw new Error("qualification-authority-required");
    validateAdmission(scenario.admissionPath, scenario.approval, this.prepared);
    // Preparation never calls this method; every execution revalidates the independently approved immutable binding.
    await this.readiness(s);
    if (this.#browsers.size >= LIMITS.browserContexts)
      throw new Error("browser-capacity");
    this.commands.store.assertLease(this.commands.lease);
    const browser = await openBrowser(
      join(s.root, "private", "browser-" + scenario.id),
      {
        executablePath: this.prepared.browserExecutable,
        locale: scenario.locale,
        viewport: scenario.viewport,
        timeoutMs: LIMITS.browserMs,
        onProcess: (identity) => {
          this.commands.store.assertLease(this.commands.lease);
          (this.ownership.browsers ??= []).push(identity);
          persistOwnership(this.ownership);
        },
      },
    );
    this.#browsers.add(browser);
    await browser.context.route("**/*", (route) => {
      try {
        this.commands.store.assertLease(this.commands.lease);
      } catch {
        return route.abort("aborted");
      }
      const url = new URL(route.request().url());
      return [s.apiUrl, s.frontendUrl].includes(url.origin) ||
        ["data:", "blob:"].includes(url.protocol)
        ? route.continue()
        : route.abort("blockedbyclient");
    });
    let rejectDeadline: (error: Error) => void;
    const deadline = new Promise<never>((_, reject) => {
      rejectDeadline = reject;
    });
    const timeout = setTimeout(() => {
      this.commands.store.cancel(this.commands.lease.runId);
      void browser.close();
      rejectDeadline(new Error("browser-scenario-timeout"));
    }, LIMITS.browserMs);
    try {
      return await Promise.race([execute(browser, s), deadline]);
    } finally {
      clearTimeout(timeout);
      const receipt = await browser.close();
      this.commands.save("browser-" + scenario.id, receipt);
      this.#browsers.delete(browser);
    }
  }
  async fault(
    s: Session,
    kind: "service-death" | "cancel" | "browser-timeout" | "storage-exhaustion",
  ) {
    if (kind === "cancel") {
      this.commands.store.cancel(this.commands.lease.runId);
      return this.stop();
    }
    if (kind === "browser-timeout") {
      for (const browser of this.#browsers) await browser.close();
      return { kind };
    }
    if (kind === "storage-exhaustion")
      return this.exec(
        s,
        [
          "node",
          "-e",
          "require('fs').writeFileSync('/fault/owned-pressure',Buffer.alloc(1024*1024))",
        ],
        10000,
      );
    const owned = await this.#inspect(s.container);
    await this.#mutate(["kill", "--signal", "KILL", owned.Id], "service-death");
    return { kind, containerId: owned.Id };
  }
  stop() {
    return (this.#stopped ??= this.#stop());
  }
  async #stop() {
    this.ownership.expiresAt = Date.now() + LIMITS.teardownMs;
    persistOwnership(this.ownership);
    clearInterval(this.#heartbeat);
    for (const b of this.#browsers)
      try {
        await b.close();
      } catch {
        /* Raw private partial trace retained. */
      }
    this.#browsers.clear();
    const receipt = cleanOwned(this.ownership);
    writeFileSync(
      join(this.commands.root, "stopped.json"),
      JSON.stringify(receipt),
      { mode: 0o600 },
    );
    this.commands.close();
    return receipt;
  }
}
