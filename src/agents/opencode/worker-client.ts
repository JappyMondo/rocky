import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type {
  Action,
  ExecutionQualification,
} from "../../coordinator/contracts.js";
import { Store, type Lease, type Versions } from "../../store/index.js";
import { canonical, digest, identity } from "../../store/json.js";
import { identify, groupAbsent, matches, delay } from "../../runner/process.js";
import {
  unknownHarnessUsage,
  deriveTreeHead,
  sealAgentLaunchBundle,
  validateAgentPrompt,
} from "../seam.js";
import {
  validateOpencodeConfig,
  opencodeRoleForKind,
  type OpencodeConfig,
} from "./config.js";
import { assertInstalledWorkerBuild } from "./host.js";
import {
  createOpencodeRunTree,
  buildOpencodeArgv,
  inventoryOpencodeIsolation,
  assertOpencodeIsolationAdmissible,
  assertOpencodeDataHomeIsolation,
} from "./launch.js";
import { roleConfigContent } from "./host.js";
import { buildOpencodeSealedEnv } from "./env.js";
import type { OpencodeLaunchInput, OpencodeLaunchPlan } from "./adapter.js";
import type { AgentResult } from "./observation.js";
import { retainImmutable } from "./retention.js";
import {
  validateWorkerMessage,
  workerMessage,
  type WorkerRequest,
  type WorkerMessage,
} from "./worker-protocol.js";

/** Host proxy. All staging callbacks execute here; the actual adapter runs in a clean process. */
export class OpencodeWorkerClient {
  readonly capability = null;
  readonly qualification: ExecutionQualification;
  readonly versions: Versions;
  readonly config: OpencodeConfig;
  private request?: WorkerRequest;
  private child?: ChildProcess;
  private plan?: OpencodeLaunchPlan;
  private phase = "new";
  private failure?: string;
  private inbox = new Map<string, unknown>();
  private workerIdentity?: NonNullable<ReturnType<typeof identify>>;
  constructor(
    private store: Store,
    private lease: Lease,
    config: OpencodeConfig,
  ) {
    this.config = validateOpencodeConfig(config);
    this.qualification = this.config.qualification;
    this.versions = this.config.versions;
    assertInstalledWorkerBuild(this.config);
  }
  private send(type: WorkerMessage["type"]) {
    if (!this.request || !this.child?.connected)
      throw new Error("opencode-worker-disconnected");
    this.child.send(workerMessage(this.request, type), (error) => {
      if (error) this.failure = "opencode-worker-ipc-send";
    });
  }
  private async receive(type: string) {
    const end = Math.min(this.request!.action.deadline, Date.now() + 30000);
    while (!this.inbox.has(type)) {
      if (this.failure) throw new Error(this.failure);
      if (Date.now() >= end)
        throw new Error("opencode-worker-handshake-timeout");
      await delay(10);
    }
    return this.inbox.get(type);
  }
  async prepareLaunch(
    action: Readonly<Action>,
    input: OpencodeLaunchInput,
  ): Promise<OpencodeLaunchPlan> {
    if (this.phase !== "new")
      throw new Error("opencode-worker-already-prepared");
    this.store.assertLease(this.lease);
    const prompt = validateAgentPrompt(
      input.prompt,
      this.config.limits.maxPromptBytes,
    );
    const directory = join(
      dirname(this.config.runsRoot),
      "workers",
      digest(action.key),
    );
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (realpathSync(directory) !== directory)
      throw new Error("opencode-worker-path-not-canonical");
    const home = join(directory, "home"),
      tmp = join(directory, "tmp");
    mkdirSync(home, { mode: 0o700 });
    mkdirSync(tmp, { mode: 0o700 });
    const request: WorkerRequest = {
      schema: 1,
      nonce: randomUUID(),
      db: this.store.path,
      lease: this.lease,
      action: JSON.parse(canonical(action)),
      config: this.config,
      prompt: prompt.text,
      directory,
    };
    this.request = request;
    const requestPath = join(directory, "request.json");
    retainImmutable(requestPath, canonical(request));
    this.child = spawn(
      process.execPath,
      [fileURLToPath(new URL("./worker.js", import.meta.url)), requestPath],
      {
        detached: true,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        env: {
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          HOME: home,
          TMPDIR: tmp,
          LANG: "en_US.UTF-8",
        },
      },
    );
    if (this.child.pid)
      this.workerIdentity = identify(this.child.pid) ?? {
        pid: this.child.pid,
        fingerprint: "not-observed-before-exit",
      };
    this.child.on("error", () => {
      this.failure = "opencode-worker-spawn-failed";
    });
    this.child.on("message", (value) => {
      try {
        const m = validateWorkerMessage(value, request);
        if (
          !["preflight", "plan", "result", "error"].includes(m.type) ||
          this.inbox.has(m.type)
        )
          throw new Error("opencode-worker-protocol-state");
        if (m.type === "error") {
          const error = m.payload as { message: string };
          this.failure =
            typeof error?.message === "string"
              ? error.message.slice(0, 1024)
              : "opencode-worker-error";
        } else this.inbox.set(m.type, m.payload);
      } catch {
        this.failure = "opencode-worker-protocol";
        if (this.child?.connected) this.child.disconnect();
      }
    });
    this.child.on("exit", () => {
      if (!this.inbox.has("result") && !this.failure)
        this.failure = "opencode-worker-exited-without-result";
    });
    try {
      const preflight = (await this.receive("preflight")) as {
        runRoot: string;
        process: NonNullable<ReturnType<typeof identify>>;
      };
      const expectedRoot = join(
        realpathSync(this.config.runsRoot),
        "run-" + digest(action.key).slice(0, 32),
      );
      if (
        preflight.runRoot !== expectedRoot ||
        preflight.process.pid !== this.child.pid ||
        !matches(preflight.process)
      )
        throw new Error("opencode-worker-preflight-binding");
      this.workerIdentity = preflight.process;
      this.store.assertLease(this.lease);
      const paths = createOpencodeRunTree(expectedRoot);
      input.stage?.(paths.src);
      this.store.assertLease(this.lease);
      this.send("freeze");
      const plan = (await this.receive("plan")) as OpencodeLaunchPlan;
      this.verifyPlan(plan, request, paths);
      this.plan = plan;
      this.phase = "prepared";
      return plan;
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  private verifyPlan(
    plan: OpencodeLaunchPlan,
    request: WorkerRequest,
    paths: OpencodeLaunchPlan["paths"],
  ) {
    const config = validateOpencodeConfig(this.config),
      role = opencodeRoleForKind(request.action.kind);
    const isolation = assertOpencodeDataHomeIsolation(
      config.dataHome,
      config.hostIdentity.userHome,
    );
    const inventory = inventoryOpencodeIsolation({
      config,
      paths,
      authProvisioned: isolation.authProvisioned,
    });
    assertOpencodeIsolationAdmissible(inventory, config);
    const content = roleConfigContent(config);
    const argv = buildOpencodeArgv({
      role,
      model: config.roles[role].model,
      dir: paths.src,
      maxArgvBytes: config.limits.maxArgvBytes,
    });
    const env = buildOpencodeSealedEnv({
      home: paths.parentHome,
      tmpdir: paths.parentTmp,
      pwd: paths.src,
      configHome: paths.configHome,
      dataHome: config.dataHome,
      cacheHome: paths.cacheHome,
      stateHome: paths.stateHome,
      db: paths.db,
      modelsPath: config.modelsCatalog.path,
      configContent: content,
    });
    const prompt = validateAgentPrompt(
      request.prompt,
      config.limits.maxPromptBytes,
    );
    const bundle = sealAgentLaunchBundle({
      schema: 1,
      harness: "opencode",
      binary: {
        path: config.binary.path,
        sha256: config.binary.sha256,
        bytes: config.binary.bytes,
      },
      argv,
      env,
      cwd: paths.src,
      input: { bytes: prompt.bytes, sha256: prompt.sha256 },
      files: [],
      discoveryDigest: inventory.digest,
    });
    const spec = {
      file: config.binary.path,
      args: argv,
      cwd: paths.src,
      timeoutMs: Math.max(
        1,
        Math.min(
          2147483647,
          request.action.elapsedMs - config.limits.cleanupReserveMs,
        ),
      ),
      cleanupMs: config.limits.killGraceMs,
      logBytes: Math.max(
        config.limits.maxStdoutBytes,
        config.limits.maxStderrBytes,
      ),
      outputDir: paths.logs,
      env,
    };
    const limits = {
      frameBytes: Math.max(config.limits.maxLineBytes, prompt.bytes),
      inputBytes: prompt.bytes + 64,
      outputBytes: config.limits.maxStdoutBytes,
      inputFrames: 2,
      outputFrames: config.limits.maxFrames,
    };
    const streamLimits = {
      maxLineBytes: config.limits.maxLineBytes,
      maxTotalBytes: config.limits.maxStdoutBytes,
      maxFrames: config.limits.maxFrames,
    };
    const expectations = {
      role,
      maxParts: config.limits.maxParts,
      maxFinalBytes: config.limits.maxFinalBytes,
    };
    if (
      plan.schema !== 1 ||
      Object.keys(plan).sort().join() !==
        "action,binaryC0,bundle,configContent,configContentSha256,expectations,headPre,inventoryPre,limits,paths,preparedAt,prompt,role,schema,spec,streamLimits" ||
      identity(plan.spec) !== identity(spec) ||
      identity(plan.limits) !== identity(limits) ||
      identity(plan.streamLimits) !== identity(streamLimits) ||
      identity(plan.expectations) !== identity(expectations) ||
      identity(plan.binaryC0) !== identity(bundle.binary) ||
      !Number.isSafeInteger(plan.preparedAt) ||
      plan.preparedAt > Date.now() ||
      identity(plan.action) !== identity(request.action) ||
      identity(plan.paths) !== identity(paths) ||
      plan.role !== role ||
      identity(plan.bundle) !== identity(bundle) ||
      plan.headPre !== deriveTreeHead(paths.src, config.limits.maxTreeNodes) ||
      plan.configContent !== content ||
      plan.configContentSha256 !== digest(content) ||
      identity(plan.prompt) !== identity(prompt) ||
      identity(plan.inventoryPre) !== identity(inventory) ||
      identity(plan.spec.args) !== identity(argv) ||
      identity(plan.spec.env) !== identity(env) ||
      plan.spec.file !== config.binary.path ||
      plan.spec.cwd !== paths.src ||
      plan.spec.outputDir !== paths.logs
    )
      throw new Error("opencode-worker-plan-binding");
  }
  begin(action: Readonly<Action>): Promise<AgentResult> {
    if (
      !this.plan ||
      !this.request ||
      this.phase !== "prepared" ||
      canonical(action) !== canonical(this.request.action)
    )
      throw new Error("opencode-worker-begin-binding");
    this.store.assertDuplexAction(this.lease, this.request.action);
    this.phase = "sending";
    this.send("begin"); // synchronous guarded initiation
    return this.observeResult();
  }
  private async observeResult(): Promise<AgentResult> {
    while (
      !this.inbox.has("result") &&
      !this.failure &&
      Date.now() <
        this.request!.action.deadline +
          this.config.limits.cleanupReserveMs +
          5000
    )
      await delay(20);
    if (!this.inbox.has("result")) {
      if (this.child?.connected) this.child.disconnect();
      try {
        this.store.revokeDuplex(this.lease, this.request!.action.key);
      } catch {
        /* Current supervisor also observes cancellation/lease expiry. */
      }
      // The supervisor owns native cleanup. Observe it; worker loss never authorizes re-send.
      const deadline =
        this.request!.action.deadline +
        this.config.limits.cleanupReserveMs +
        5000;
      let command = this.store.duplexInvocation(this.request!.action.key);
      while (
        command &&
        command.state !== "finished" &&
        command.state !== "recovery-required" &&
        Date.now() < deadline
      ) {
        await delay(25);
        command = this.store.command(command.id)!;
      }
      await this.drain();
      const quiet = this.physicalQuiescence();
      const result: AgentResult = {
        type: "result",
        actionKey: this.request!.action.key,
        inputDigest: this.request!.action.inputDigest,
        outcome: "interrupted",
        head: this.plan!.headPre,
        quiescent: quiet,
        usage: unknownHarnessUsage(
          "opencode",
          this.failure ?? "opencode-worker-observation-unresolved",
        ),
        detail: this.failure ?? "opencode-worker-observation-unresolved",
      };
      retainImmutable(
        join(this.request!.directory, "host-failure.json"),
        canonical(result),
      );
      return result;
    }
    const result = this.inbox.get("result") as AgentResult;
    await this.drain();
    if (
      !this.workerIdentity ||
      !groupAbsent(this.workerIdentity) ||
      result?.type !== "result" ||
      result.actionKey !== this.request!.action.key ||
      result.inputDigest !== this.request!.action.inputDigest
    )
      throw new Error("opencode-worker-result-binding-or-drain");
    const quiet = this.physicalQuiescence();
    if (result.quiescent !== quiet) {
      const revised: AgentResult = {
        ...result,
        quiescent: quiet,
        outcome: "interrupted",
        detail: "opencode-worker-quiescence-not-corroborated",
      };
      retainImmutable(
        join(this.request!.directory, "host-failure.json"),
        canonical({ result: revised, original: result }),
      );
      return revised;
    }
    return result;
  }
  private physicalQuiescence() {
    if (!this.workerIdentity || !groupAbsent(this.workerIdentity)) return false;
    // Re-read AFTER worker drain; a stale absent invocation is never no-dispatch proof.
    const command = this.store.duplexInvocation(this.request!.action.key);
    return (
      !command ||
      (command.state === "finished" &&
        command.duplex?.stdoutEof === true &&
        command.duplex.stderrEof === true &&
        (!command.group || groupAbsent(command.group)))
    );
  }
  private async drain() {
    const end = Date.now() + this.config.limits.killGraceMs + 2000;
    while (
      this.workerIdentity &&
      !groupAbsent(this.workerIdentity) &&
      Date.now() < end
    )
      await delay(20);
  }
  async notDispatched(action: Action, reason: string): Promise<AgentResult> {
    if (
      !this.request ||
      canonical(this.request.action) !== canonical(action) ||
      this.phase === "sending" ||
      this.store.duplexInvocation(action.key)
    )
      throw new Error("opencode-worker-dispatch-state-uncertain");
    await this.close();
    const quiet = this.physicalQuiescence();
    const result: AgentResult = {
      type: "result",
      actionKey: action.key,
      inputDigest: action.inputDigest,
      outcome: "interrupted",
      head:
        this.plan?.headPre ??
        this.store.coordinatorSnapshot(action.runId)!.head,
      quiescent: quiet,
      usage: unknownHarnessUsage(
        "opencode",
        "opencode-not-dispatched:" + reason,
      ),
      detail: "opencode-not-dispatched:" + reason,
    };
    retainImmutable(
      join(this.request.directory, "host-not-dispatched.json"),
      canonical(result),
    );
    return result;
  }
  interrupt(action: Action) {
    if (this.store.duplexInvocation(action.key))
      this.store.revokeDuplex(this.lease, action.key);
    else if (this.child?.connected) this.send("stop");
  }
  async close() {
    if (this.child?.connected) {
      try {
        this.send("stop");
      } catch {
        /* Closed. */
      }
      this.child.disconnect();
    }
    await this.drain();
  }
}
