// A single native feasibility probe. This is not a production transport/gateway.
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  renameSync,
  existsSync,
  readdirSync,
  lstatSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { once } from "node:events";
import { checkAttempt } from "./check.mjs";
import { definition, prepareSyntheticRepository } from "./fixture.mjs";
import { trustedIdentity } from "./provenance.mjs";
import { candidatePolicy } from "./policy.mjs";
import { nativeConfig } from "./native-config.mjs";
import { DENIAL_VARIANT, NativeSettlement } from "./settlement.mjs";
import {
  validateNativeInvocation,
  consumeOnce,
  nativeGatePath,
  inspectNativeHelpers,
  requirePositiveControl,
} from "./native-integration.mjs";
import {
  ROOT,
  EVIDENCE,
  NATIVE_EVIDENCE,
  BINARY,
  BINARY_SHA,
  guard,
  sha,
  fileSha,
  save,
  inventory,
  processes,
} from "./common.mjs";

const head = guard(); // Wrong root must stop before any evidence/resource mutation.
const invocationAuthority = validateNativeInvocation({
  root: ROOT,
  branch: execFileSync("git", ["branch", "--show-current"], {
    encoding: "utf8",
  }).trim(),
  head,
  expectedHead: process.argv[4],
  argv: process.argv.slice(2),
  dirty: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }),
});
const attempt = join(
  NATIVE_EVIDENCE,
  `attempt-${new Date().toISOString().replaceAll(":", "-")}`,
);
const reference = trustedIdentity(head);
mkdirSync(attempt, { recursive: true, mode: 0o700 });
const started = Date.now(),
  deadline = started + 60000,
  workDeadline = deadline - 10000;
const source = join(attempt, "source"),
  authority = join(attempt, "private"),
  codexHome = join(attempt, "runtime/codex-home"),
  home = join(attempt, "scratch/home"),
  scratch = join(attempt, "scratch");
save(join(attempt, "admission.json"), {
  schema: 1,
  attempt,
  head,
  contract: reference.contract,
  started,
  deadline,
  workDeadline,
  classification: "synthetic_native",
  capability: null,
  authority: invocationAuthority,
  scope: "allowed-source-then-protected-canary-same-native-route",
  observationVariant: DENIAL_VARIANT,
});
let server,
  app,
  guardian,
  heartbeat,
  leader,
  terminal,
  threadId,
  turnId,
  failure,
  timer,
  settlement,
  appClosed = false;
const settlementAbort = new AbortController();
let requestCount = 0,
  seq = 0,
  bytesLogged = 0,
  cleanup;
const activeUpstreams = new Set();
const pending = new Map(),
  frames = [],
  calls = [],
  httpRequests = [];
const sourceBefore = inventory(join(ROOT, "acceptance/harness"));
if (JSON.stringify(sourceBefore) !== JSON.stringify(reference.source))
  throw Error("source-not-at-trusted-commit");
mkdirSync(join(attempt, "loaded-source"), { mode: 0o700 });
for (const entry of sourceBefore)
  writeFileSync(
    join(attempt, "loaded-source", entry.path),
    readFileSync(join(ROOT, "acceptance/harness", entry.path)),
    { mode: 0o400, flag: "wx" },
  );
const schemaRoot = join(EVIDENCE, "schema-discovery/schema-experimental");
const schemaBefore = inventory(schemaRoot);
if (
  sha(JSON.stringify(schemaBefore)) !== reference.contract.schemaInventorySha256
)
  throw Error("schema-identity-mismatch");
for (const entry of schemaBefore) {
  const target = join(attempt, "loaded-schema", entry.path);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(target, readFileSync(join(schemaRoot, entry.path)), {
    flag: "wx",
    mode: 0o400,
  });
}
consumeOnce(nativeGatePath(invocationAuthority), {
  ...invocationAuthority,
  attempt,
  consumedAt: Date.now(),
  sourceInventorySha256: sha(JSON.stringify(sourceBefore)),
});
const policy = candidatePolicy(attempt);
save(join(attempt, "policy.json"), policy);
let configSha256;
for (const entry of reference.observationVariant.sourceFiles) {
  const bytes = readFileSync(
    join(
      ROOT,
      ".qualification/harness-settlement-68/pinned-source",
      entry.path,
    ),
  );
  if (sha(bytes) !== entry.sha256 || bytes.length !== entry.bytes)
    throw Error("pinned-native-source-mismatch");
  mkdirSync(join(attempt, "loaded-native-source"), {
    recursive: true,
    mode: 0o700,
  });
  writeFileSync(join(attempt, "loaded-native-source", entry.path), bytes, {
    mode: 0o400,
    flag: "wx",
  });
}
const journal = (type, value) => {
  const row = { seq: ++seq, at: Date.now(), type, value };
  const line = JSON.stringify(row) + "\n";
  bytesLogged += Buffer.byteLength(line);
  if (bytesLogged > 8 * 1024 * 1024) throw Error("evidence-byte-limit");
  appendFileSync(join(attempt, "journal.jsonl"), line, { mode: 0o600 });
  frames.push(row);
  return row;
};
function fail(error) {
  failure ??= error instanceof Error ? error : Error(String(error));
  settlementAbort.abort(failure);
  for (const p of pending.values()) p.reject(failure);
  pending.clear();
}
function rpc(method, params) {
  if (failure || Date.now() >= workDeadline)
    return Promise.reject(failure ?? Error("work-deadline"));
  const id = `request-${seq + 1}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    journal("ipc-send", { id, method, params });
    app.stdin.write(JSON.stringify({ id, method, params }) + "\n", (error) => {
      if (error) fail(error);
    });
  });
}
function stdoutLine(line) {
  const msg = JSON.parse(line);
  const row = journal("ipc-receive", msg);
  settlement?.event(row);
  if (msg.id !== undefined && !msg.method) {
    const waiter = pending.get(msg.id);
    if (!waiter) throw Error("unknown-response-id");
    pending.delete(msg.id);
    if (msg.error)
      waiter.reject(Error(`rpc-error:${JSON.stringify(msg.error)}`));
    else waiter.resolve(msg.result);
  } else if (msg.id !== undefined)
    throw Error(`unexpected-server-request:${msg.method}`);
  else if (msg.method === "turn/completed") terminal = msg.params;
  else if (
    msg.method === "item/completed" &&
    msg.params?.item?.id === "native-probe-1"
  ) {
    requirePositiveControl(
      msg.params.item.exitCode,
      existsSync(allowedFile) ? fileSha(allowedFile) : null,
      existsSync(scratchAllowedFile) ? fileSha(scratchAllowedFile) : null,
    );
  }
}
function sendSse(res, event) {
  const raw = `data: ${JSON.stringify(event)}\n\n`;
  journal("upstream-response-event", {
    request: res.rockyRequestNumber,
    event,
    raw,
  });
  res.write(raw);
}
function complete(res, id) {
  sendSse(res, {
    type: "response.completed",
    response: {
      id,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    },
  });
  res.end();
}
const canary = `SYNTHETIC_ONLY_${randomUUID()}`;
const connectionKey = `synthetic-${randomUUID()}`;
const recipe = definition(attempt);
const { protectedFile, allowedFile, scratchAllowedFile, commands } = recipe;
async function upstream(req, res) {
  try {
    if (failure || Date.now() >= workDeadline)
      throw failure ?? Error("work-deadline");
    if (req.method !== "POST" || req.url !== "/v1/responses")
      throw Error(`unsupported-upstream-route:${req.method}:${req.url}`);
    if (
      req.socket.remoteAddress !== "127.0.0.1" ||
      req.headers.authorization !== `Bearer ${connectionKey}`
    )
      throw Error("unexpected-synthetic-upstream-client");
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 2 * 1024 * 1024) throw Error("request-byte-limit");
    }
    const body = JSON.parse(raw),
      number = ++requestCount;
    res.rockyRequestNumber = number;
    const requestPath = `request-${number}.json`;
    save(join(attempt, requestPath), {
      method: req.method,
      url: req.url,
      headers: req.headers,
      raw,
      body,
      connection: {
        requestNumber: number,
        remoteAddress: req.socket.remoteAddress,
        remotePort: req.socket.remotePort,
        localPort: req.socket.localPort,
      },
    });
    httpRequests.push({
      path: requestPath,
      sha256: fileSha(join(attempt, requestPath)),
    });
    const providerRow = journal("upstream-request", {
      number,
      requestPath,
      bodySha256: sha(raw),
    });
    if (number > 4) throw Error("unexpected-inference-retry");
    const names = body.tools?.map((t) => t.name ?? t.type);
    const permitted = [
      "exec_command",
      "write_stdin",
      "apply_patch",
      "view_image",
      "update_plan",
    ];
    if (
      !Array.isArray(names) ||
      !names.includes("exec_command") ||
      names.some((n) => !permitted.includes(n))
    )
      throw Error(`unexpected-native-tool-roster:${JSON.stringify(names)}`);
    if (number === 1) {
      save(join(attempt, "tool-roster.json"), body.tools);
      save(
        join(attempt, "helpers-before-dispatch.json"),
        inspectNativeHelpers(codexHome),
      );
    } else if (
      sha(JSON.stringify(body.tools)) !==
      sha(
        JSON.stringify(
          JSON.parse(readFileSync(join(attempt, "tool-roster.json"))),
        ),
      )
    )
      throw Error("tool-roster-changed");
    if (!settlement) throw Error("provider-before-thread-authority");
    await settlement.wait(null, workDeadline, settlementAbort.signal);
    settlement.provider(body, providerRow.seq);
    if (number > 1) {
      const previousId = `native-probe-${number - 1}`;
      await settlement.wait(previousId, workDeadline, settlementAbort.signal);
      const prior = settlement.calls[number - 2];
      if (number === 2)
        requirePositiveControl(
          prior.settlement.exitCode,
          existsSync(allowedFile) ? fileSha(allowedFile) : null,
          existsSync(scratchAllowedFile) ? fileSha(scratchAllowedFile) : null,
        );
      else if (
        !Number.isSafeInteger(prior.settlement.exitCode) ||
        prior.settlement.exitCode <= 0 ||
        prior.settlement.exitCode >= 128
      )
        throw Error("protected-operation-not-proven-denied");
      journal("native-settlement", {
        callId: previousId,
        mode: prior.settlement.mode,
        provisional: prior.settlement.mode === DENIAL_VARIANT,
        invocation: { threadId, turnId },
        mapping:
          "derived from sole active owned app-server invocation and authenticated loopback request",
      });
    }
    // Stop this single probe immediately if a protected read leaked or write changed it.
    const leaked = number >= 3 && raw.includes(canary);
    const changed = readFileSync(protectedFile, "utf8") !== canary;
    if (leaked || changed) {
      journal("boundary-failed", { leaked, changed });
      throw Error("protected-boundary-failed");
    }
    if (fileSha(join(codexHome, "config.toml")) !== configSha256)
      throw Error("runtime-config-mutated");
    if (failure || Date.now() >= workDeadline)
      throw failure ?? Error("work-deadline");
    journal("native-dispatch-preflight", {
      request: number,
      configSha256,
      helpers: inspectNativeHelpers(codexHome),
      ownedProcesses: processes().filter((p) => p.pgid === leader.pid),
      noPermissionOverrides: true,
    });
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    });
    const id = `synthetic-response-${number}`;
    sendSse(res, { type: "response.created", response: { id } });
    if (number <= 3 && !leaked && !changed) {
      const call_id = `native-probe-${number}`,
        args = recipe.args[number - 1];
      calls.push({
        callId: call_id,
        route: "exec_command",
        args,
        request: number,
        invocation: { threadId, turnId },
      });
      const injection = journal("injected-native-call", calls.at(-1));
      settlement.inject(calls.at(-1), injection.seq);
      sendSse(res, {
        type: "response.output_item.done",
        item: {
          type: "function_call",
          call_id,
          name: "exec_command",
          arguments: JSON.stringify(args),
        },
      });
    } else
      sendSse(res, {
        type: "response.output_item.done",
        item: {
          id: "synthetic-message",
          type: "message",
          role: "assistant",
          content: [
            { type: "output_text", text: '{"status":"synthetic-complete"}' },
          ],
        },
      });
    complete(res, id);
  } catch (error) {
    journal("upstream-error", { error: error.message });
    res.writeHead(500);
    res.end("synthetic probe stopped");
    fail(error);
  }
}
function ownership() {
  const value = {
    schema: 1,
    ownerPid: process.pid,
    leader,
    heartbeat: Date.now(),
    deadline,
  };
  writeFileSync(join(attempt, "ownership.tmp"), JSON.stringify(value), {
    mode: 0o600,
  });
  renameSync(join(attempt, "ownership.tmp"), join(attempt, "ownership.json"));
}
try {
  if (fileSha(BINARY) !== BINARY_SHA) throw Error("binary-identity-mismatch");
  for (const path of [
    source,
    join(authority, "codex-home"),
    authority,
    codexHome,
    home,
    scratch,
    join(scratch, "tmp"),
  ])
    mkdirSync(path, { recursive: true, mode: 0o700 });
  const syntheticGit = prepareSyntheticRepository(source);
  const gitEnv = {
    PATH: "/usr/bin:/bin",
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
  const git = (...args) =>
    execFileSync("/usr/bin/git", ["-C", source, ...args], {
      env: gitEnv,
      encoding: "utf8",
    }).trim();
  const observedGit = {
    root: git("rev-parse", "--show-toplevel"),
    commonDirectory: git(
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ),
    branch: git("branch", "--show-current"),
    head: git("rev-parse", "HEAD"),
    remotes: git("remote"),
    historyCount: git("rev-list", "--count", "HEAD"),
    inventory: inventory(join(source, ".git")),
  };
  save(join(attempt, "synthetic-git.json"), {
    ...syntheticGit,
    observed: observedGit,
  });
  if (
    observedGit.root !== source ||
    observedGit.commonDirectory !== join(source, ".git") ||
    observedGit.branch !== "rocky-next" ||
    observedGit.head !== syntheticGit.commit ||
    observedGit.remotes !== "" ||
    observedGit.historyCount !== "1"
  )
    throw Error("synthetic-git-not-isolated");
  writeFileSync(protectedFile, canary, { mode: 0o600, flag: "wx" });
  save(join(attempt, "fixture-before.json"), {
    protectedSha256: fileSha(protectedFile),
    protectedBytes: Buffer.byteLength(canary),
    protectedFile,
    allowedFile,
    scratchAllowedFile,
    allowedInitiallyAbsent: !existsSync(allowedFile),
  });
  server = createServer((req, res) => {
    const handling = upstream(req, res);
    activeUpstreams.add(handling);
    void handling.then(
      () => activeUpstreams.delete(handling),
      (error) => {
        activeUpstreams.delete(handling);
        fail(error);
      },
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
  const config = nativeConfig(attempt, endpoint);
  configSha256 = sha(config);
  writeFileSync(join(authority, "codex-home/config.toml"), config, {
    mode: 0o400,
    flag: "wx",
  });
  writeFileSync(join(codexHome, "config.toml"), config, {
    mode: 0o600,
    flag: "wx",
  });
  writeFileSync(join(attempt, "requested-config.toml"), config, {
    mode: 0o400,
    flag: "wx",
  });
  const env = {
    HOME: home,
    CODEX_HOME: codexHome,
    TMPDIR: policy.environment.TMPDIR,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    SHELL: "/bin/sh",
    LANG: "en_US.UTF-8",
    ROCKY_SYNTHETIC_ONLY_KEY: connectionKey,
  };
  const args = ["app-server", "--listen", "stdio://"];
  save(join(attempt, "inputs.json"), {
    sourceHead: head,
    observationVariant: DENIAL_VARIANT,
    contract: reference.contract,
    sourceFiles: sourceBefore,
    binary: { path: BINARY, sha256: fileSha(BINARY) },
    node: {
      path: process.execPath,
      sha256: fileSha(process.execPath),
      version: process.version,
    },
    os: execFileSync("/usr/bin/sw_vers", [], { encoding: "utf8" }),
    args,
    env,
    cwd: source,
    configSha256: sha(config),
    endpoint,
    commands,
    schema: schemaBefore,
    nativeExecutables: ["/bin/sh", "/bin/cat", "/usr/bin/sandbox-exec"].map(
      (path) => ({ path, sha256: fileSha(path) }),
    ),
    policySha256: fileSha(join(attempt, "policy.json")),
    helperRouteSource:
      "openai/codex@36650394c5b38c2990ccf2a3457165ca3e9d9726 codex-rs/arg0/src/lib.rs:394-410",
    stdio: ["pipe", "pipe", "pipe"],
    permissionOverrides: [],
  });
  app = spawn(BINARY, args, {
    cwd: source,
    env,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  app.on("error", fail);
  app.on("exit", (code, signal) => {
    journal("app-exit", { code, signal });
    if (!terminal) fail(Error("app-exited-before-terminal"));
  });
  app.on("close", () => {
    appClosed = true;
  });
  leader = processes().find((p) => p.pid === app.pid);
  if (!leader || leader.pgid !== app.pid)
    throw Error("missing-owned-process-identity");
  journal("app-start", leader);
  ownership();
  guardian = spawn(
    process.execPath,
    [
      join(ROOT, "acceptance/harness/guardian.mjs"),
      join(attempt, "ownership.json"),
      join(attempt, "guardian.stop"),
      join(attempt, "guardian.jsonl"),
    ],
    { cwd: ROOT, env: { PATH: "/usr/bin:/bin" }, stdio: "ignore" },
  );
  guardian.on("error", fail);
  journal("guardian-start", { pid: guardian.pid });
  heartbeat = setInterval(ownership, 1000);
  timer = setTimeout(
    () => fail(Error("work-deadline")),
    Math.max(0, workDeadline - Date.now()),
  );
  let buffer = "";
  app.stdout.setEncoding("utf8");
  app.stdout.on("data", (text) => {
    try {
      buffer += text;
      if (buffer.length > 2 * 1024 * 1024) throw Error("ipc-frame-limit");
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line) stdoutLine(line);
      }
    } catch (error) {
      fail(error);
    }
  });
  app.stdout.on("end", () => {
    journal("ipc-eof", { pendingBytes: Buffer.byteLength(buffer) });
    if (buffer.length) fail(Error("truncated-ipc-at-eof"));
  });
  app.stderr.on("data", (bytes) => {
    try {
      journal("app-stderr", bytes.toString());
    } catch (error) {
      fail(error);
    }
  });
  const init = await rpc("initialize", {
    clientInfo: { name: "rocky_synthetic_probe", version: "1" },
    capabilities: { experimentalApi: true },
  });
  save(join(attempt, "initialize.json"), init);
  journal("ipc-send", { method: "initialized" });
  app.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
  const thread = await rpc("thread/start", {
    cwd: source,
    model: "gpt-5.4",
    modelProvider: "synthetic",
    approvalPolicy: "never",
    permissions: "probe",
    ephemeral: true,
    baseInstructions:
      "Synthetic native-tool containment probe. No real inference or external effects.",
    developerInstructions: "Execute only the supplied synthetic native calls.",
    allowProviderModelFallback: false,
  });
  save(join(attempt, "thread.json"), thread);
  threadId = thread.thread.id;
  if (
    thread.cwd !== source ||
    thread.modelProvider !== "synthetic" ||
    thread.approvalPolicy !== "never" ||
    thread.activePermissionProfile?.id !== "probe" ||
    thread.instructionSources?.length
  )
    throw Error("unexpected-effective-thread-config");
  save(join(attempt, "config-after-thread.json"), {
    path: join(codexHome, "config.toml"),
    sha256: fileSha(join(codexHome, "config.toml")),
    expected: configSha256,
  });
  if (fileSha(join(codexHome, "config.toml")) !== configSha256)
    throw Error("runtime-config-mutated-after-thread");
  save(
    join(attempt, "helpers-after-thread.json"),
    inspectNativeHelpers(codexHome),
  );
  settlement = new NativeSettlement(recipe, { threadId, turnId: null });
  const turn = await rpc("turn/start", {
    threadId,
    input: [{ type: "text", text: "Run the bounded synthetic native probe." }],
    outputSchema: {
      type: "object",
      properties: { status: { const: "synthetic-complete" } },
      required: ["status"],
      additionalProperties: false,
    },
  });
  turnId = turn.turn.id;
  settlement.bindTurn(turnId);
  while (!terminal && !failure) await new Promise((r) => setTimeout(r, 25));
  if (failure) throw failure;
  if (
    terminal.threadId !== threadId ||
    terminal.turn.id !== turnId ||
    terminal.turn.status !== "completed" ||
    pending.size
  )
    throw Error("incomplete-or-mismatched-terminal");
  if (buffer.trim()) throw Error("truncated-ipc-frame");
  if (fileSha(join(codexHome, "config.toml")) !== configSha256)
    throw Error("runtime-config-mutated-after-turn");
} catch (error) {
  failure ??= error;
  journal("failure", {
    message: error.message,
    ownedProcesses: leader
      ? processes().filter((p) => p.pgid === leader.pid)
      : [],
    observedAt: Date.now(),
  });
} finally {
  clearTimeout(timer);
  settlementAbort.abort(failure ?? Error("cleanup-started"));
  const before = leader ? processes().filter((p) => p.pgid === leader.pid) : [];
  const current = before.find((p) => p.pid === leader?.pid);
  if (
    current &&
    current.start === leader.start &&
    current.pgid === leader.pid
  ) {
    process.kill(-leader.pid, "SIGTERM");
    const until = Math.min(deadline - 1000, Date.now() + 3000);
    while (processes().some((p) => p.pgid === leader.pid) && Date.now() < until)
      await new Promise((r) => setTimeout(r, 100));
    const survivors = processes().filter((p) => p.pgid === leader.pid);
    if (
      survivors.length &&
      survivors.some((p) => p.pid === leader.pid && p.start === leader.start)
    )
      process.kill(-leader.pid, "SIGKILL");
  }
  if (app && !appClosed) {
    await new Promise((resolve) => {
      const timeout = setTimeout(
        resolve,
        Math.max(0, deadline - Date.now() - 1500),
      );
      app.once("close", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    if (!appClosed) failure ??= Error("app-transcript-not-closed");
  }
  if (server) {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await Promise.allSettled([...activeUpstreams]);
  }
  const remaining = leader
    ? processes().filter((p) => p.pgid === leader.pid)
    : [];
  clearInterval(heartbeat);
  if (!remaining.length)
    writeFileSync(join(attempt, "guardian.stop"), "normal cleanup\n", {
      mode: 0o600,
      flag: "wx",
    });
  if (guardian) {
    for (let i = 0; i < 15 && guardian.exitCode === null; i++)
      await new Promise((r) => setTimeout(r, 100));
  }
  cleanup = {
    before,
    pendingUpstreams: activeUpstreams.size,
    remaining,
    guardianExited: !guardian || guardian.exitCode === 0,
    serverClosed: !server?.listening,
    finished: Date.now(),
    withinDeadline: Date.now() <= deadline,
    recoveryUsed:
      existsSync(join(attempt, "guardian.jsonl")) &&
      readFileSync(join(attempt, "guardian.jsonl"), "utf8").includes(
        "recovery-",
      ),
  };
  save(join(attempt, "cleanup.json"), cleanup);
}
if (existsSync(join(codexHome, "config.toml"))) {
  save(join(attempt, "config-after-cleanup.json"), {
    path: join(codexHome, "config.toml"),
    sha256: fileSha(join(codexHome, "config.toml")),
    expected: configSha256,
  });
  if (fileSha(join(codexHome, "config.toml")) !== configSha256)
    failure ??= Error("runtime-config-mutated-after-cleanup");
}
save(join(attempt, "fixture-after.json"), {
  protectedSha256: existsSync(protectedFile) ? fileSha(protectedFile) : null,
  allowedSha256: existsSync(allowedFile) ? fileSha(allowedFile) : null,
  scratchAllowedSha256: existsSync(scratchAllowedFile)
    ? fileSha(scratchAllowedFile)
    : null,
});
save(join(attempt, "observations.json"), {
  schema: 1,
  classification: "synthetic_native",
  capability: null,
  sourceFrozen:
    JSON.stringify(sourceBefore) ===
    JSON.stringify(inventory(join(ROOT, "acceptance/harness"))),
  calls,
  httpRequests,
  threadId: threadId ?? null,
  turnId: turnId ?? null,
  terminal: terminal ?? null,
  error: failure?.message ?? null,
  pending: [...pending.keys()],
  cleanup,
});
// Codex's disposable state/cache tree contains runtime links. Bind retained
// observations and exact loaded config, not a mutable dependency/state cache.
const evidenceFiles = readdirSync(attempt).filter((name) =>
  lstatSync(join(attempt, name)).isFile(),
);
if (existsSync(join(codexHome, "config.toml")))
  evidenceFiles.push(
    "runtime/codex-home/config.toml",
    "private/codex-home/config.toml",
  );
if (existsSync(protectedFile))
  evidenceFiles.push("private/protected-canary.txt");
for (const path of ["source/allowed.txt", "scratch/tmp/allowed.txt"])
  if (existsSync(join(attempt, path))) evidenceFiles.push(path);
for (const entry of inventory(join(attempt, "loaded-native-source")))
  evidenceFiles.push("loaded-native-source/" + entry.path);
for (const entry of inventory(join(attempt, "loaded-source")))
  evidenceFiles.push("loaded-source/" + entry.path);
for (const entry of inventory(join(attempt, "loaded-schema")))
  evidenceFiles.push("loaded-schema/" + entry.path);
save(
  join(attempt, "inventory.json"),
  evidenceFiles.sort().map((path) => ({
    path,
    bytes: lstatSync(join(attempt, path)).size,
    sha256: fileSha(join(attempt, path)),
  })),
);
let assessment;
try {
  assessment = checkAttempt(attempt, head);
} catch (error) {
  assessment = {
    status: "fail",
    reason: error.message,
    qualification: false,
    capability: null,
  };
}
save(join(attempt, "assessment.json"), assessment);
console.log(
  JSON.stringify({
    attempt,
    error: failure?.message ?? null,
    calls: calls.length,
    cleanup,
    assessment,
  }),
);
process.exitCode = assessment.status === "pass" ? 0 : 1;
