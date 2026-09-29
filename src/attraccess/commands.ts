import { execFileSync, spawn } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { delay } from "../runner/process.js";
import {
  prepareMutation,
  creationFor,
  durableJson,
  type MutationResult,
} from "./mutations.js";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store, type Lease } from "../store/index.js";
import { CommandRunner, type CommandResult } from "../runner/index.js";
import { Evidence } from "../evidence/index.js";
import { LIMITS, TARGET } from "./policy.js";
import { identify } from "../runner/process.js";
import { verifyInstalledBuild } from "./integrity.js";
import { redact } from "./http.js";
import type { Json } from "../store/json.js";
export class EnvironmentCommands {
  readonly store: Store;
  readonly lease: Lease;
  readonly runner: CommandRunner;
  readonly evidence: Evidence;
  readonly docker: string;
  readonly dockerHost: string;
  #heartbeat: NodeJS.Timeout;
  #activeMarker: string;
  #closed = false;
  constructor(
    readonly root: string,
    readonly attempt: string,
    docker?: { executable: string; host: string },
    scope = "environment-preparation",
  ) {
    verifyInstalledBuild();
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.store = new Store(join(root, "run.sqlite"));
    const versions = {
      workflow: "environment-1",
      adapter: "attraccess-1",
      prompt: "none",
      runner: "foundation-1",
      build: JSON.parse(
        readFileSync(
          new URL("../build-identity.json", import.meta.url),
          "utf8",
        ),
      ).buildId,
    };
    this.store.admit({
      id: attempt,
      head: TARGET.commit,
      base: TARGET.commit,
      scope,
      versions,
      config: { leaseMs: LIMITS.leaseMs },
    });
    this.lease = this.store.claim(
      attempt,
      "environment-" + randomUUID(),
      versions,
      LIMITS.leaseMs,
    );
    this.runner = new CommandRunner(this.store);
    this.evidence = new Evidence(join(root, "evidence"));
    this.docker =
      docker?.executable ??
      execFileSync("/usr/bin/which", ["docker"], {
        encoding: "utf8",
      }).trim();
    this.dockerHost =
      docker?.host ??
      execFileSync(
        this.docker,
        ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
        { encoding: "utf8" },
      ).trim();
    if (!this.dockerHost.startsWith("unix://"))
      throw new Error("local-docker-required");
    const markerRoot = fileURLToPath(
      new URL(
        "../../.qualification/attraccess/active-runtimes",
        import.meta.url,
      ),
    );
    mkdirSync(markerRoot, { recursive: true, mode: 0o700 });
    this.#activeMarker = join(markerRoot, randomUUID() + ".json");
    writeFileSync(
      this.#activeMarker,
      JSON.stringify({
        process: identify(process.pid),
        build: versions.build,
        attempt,
      }),
      { mode: 0o600 },
    );
    this.#heartbeat = setInterval(() => {
      try {
        this.store.renew(this.lease, LIMITS.leaseMs);
      } catch {
        /* Canceled/stale work remains fenced. */
      }
    }, 1000);
  }
  async command(
    file: string,
    args: string[],
    timeoutMs = LIMITS.setupMs,
    cwd = process.cwd(),
  ) {
    const record = await this.runner.run(this.lease, {
      file,
      args,
      cwd,
      timeoutMs,
      cleanupMs: LIMITS.cleanupMs,
      logBytes: LIMITS.logBytes,
      outputDir: join(this.root, "commands"),
    });
    const result = record.result as unknown as CommandResult;
    if (!result || result.outcome !== "success")
      throw new Error(
        "environment-command-failed:" + record.id + ":" + result?.outcome,
      );
    return {
      record,
      stdout: readFileSync(result.stdout, "utf8"),
      stderr: readFileSync(result.stderr, "utf8"),
    };
  }
  async dockerCommand(args: string[], timeoutMs = LIMITS.setupMs) {
    return this.command(
      this.docker,
      ["--host", this.dockerHost, ...args],
      timeoutMs,
    );
  }
  async mutation(args: string[], key: string, timeoutMs = 30000) {
    const effectKey = this.attempt + "/" + key;
    const dir = prepareMutation({
      key: effectKey,
      root: this.root,
      docker: this.docker,
      dockerHost: this.dockerHost,
      args,
      lease: this.lease,
      timeoutMs,
      creation: creationFor(args),
    });
    this.store.transition(this.lease, "environment-effect", {
      key: effectKey,
      kind: "owned-docker",
      payload: { args },
    });
    const effect = await this.store.dispatch(this.lease, effectKey, {
      begin: () => {
        durableJson(join(dir, "launch.json"), { at: new Date().toISOString() });
        const worker = spawn(
          process.execPath,
          [
            fileURLToPath(new URL("./mutation-worker.js", import.meta.url)),
            dir,
          ],
          {
            detached: true,
            stdio: "ignore",
            env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
          },
        );
        worker.once("error", (error) =>
          durableJson(join(dir, "result.json"), {
            status: "not-dispatched",
            at: new Date().toISOString(),
            stdout: "",
            stderr: error.message,
          }),
        );
        worker.unref();
        return (async () => {
          const deadline = Date.now() + timeoutMs + 5000;
          while (!existsSync(join(dir, "result.json"))) {
            if (Date.now() >= deadline)
              throw Error("docker-transport-outcome-unresolved");
            await delay(25);
          }
          const result = JSON.parse(
            readFileSync(join(dir, "result.json"), "utf8"),
          ) as MutationResult;
          if (result.status !== "acknowledged")
            throw Error("docker-operation-unconfirmed");
          return { stdout: result.stdout, stderr: result.stderr };
        })();
      },
    });
    if (effect.state !== "confirmed")
      throw Error("docker-effect-reconciliation-required:" + effect.key);
    return effect.receipt as { stdout: string; stderr: string };
  }
  async httpEffect<T>(
    request: { method: string; path: string },
    start: () => Promise<T>,
  ): Promise<T> {
    if (["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase()))
      return this.store.guardedStart(this.lease, start);
    const key = this.attempt + "/http/" + randomUUID();
    this.store.transition(this.lease, "fixture-http-intent", {
      key,
      kind: "owned-fixture-http",
      payload: request,
    });
    let result: T;
    const effect = await this.store.dispatch(this.lease, key, {
      begin: () =>
        start().then((value) => {
          result = value;
          return redact(value) as Json;
        }),
    });
    if (effect.state !== "confirmed")
      throw new Error("fixture-http-reconciliation-required:" + key);
    return result!;
  }
  async inspectImage(image: string) {
    return JSON.parse(
      (await this.dockerCommand(["image", "inspect", image])).stdout,
    )[0];
  }
  save(name: string, value: unknown) {
    const bytes = JSON.stringify(value, null, 2) + "\n";
    writeFileSync(join(this.root, name + ".json"), bytes, { mode: 0o600 });
    return this.evidence.put(bytes);
  }
  close() {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#heartbeat);
    this.store.close();
    try {
      unlinkSync(this.#activeMarker);
    } catch {
      /* Stale markers require matching live identity to block builds. */
    }
  }
}
