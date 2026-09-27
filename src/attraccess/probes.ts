import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { EnvironmentCommands } from "./commands.js";
import {
  persistOwnership,
  cleanOwned,
  CleanupIncomplete,
  type Ownership,
  type CleanupReceipt,
} from "./resources.js";
import { LIMITS } from "./policy.js";
export class OwnedProbes {
  readonly ownership: Ownership;
  #heartbeat: NodeJS.Timeout;
  #stop: Promise<CleanupReceipt> | undefined;
  #closing = false;
  constructor(readonly commands: EnvironmentCommands) {
    this.ownership = {
      owner: "rn-probe-" + randomUUID(),
      root: commands.root,
      docker: commands.docker,
      dockerHost: commands.dockerHost,
      expiresAt: Date.now() + LIMITS.leaseMs,
      containers: [],
      networks: [],
    };
    persistOwnership(this.ownership);
    commands.store.guardedStart(commands.lease, () => {
      const guardian = spawn(
        process.execPath,
        [
          fileURLToPath(new URL("./guardian.js", import.meta.url)),
          commands.root,
        ],
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
        commands.store.assertLease(commands.lease);
        this.ownership.expiresAt = Date.now() + LIMITS.leaseMs;
        persistOwnership(this.ownership);
      } catch {
        /* Expired guardian owns reconciliation. */
      }
    }, 1000);
  }
  async run(
    image: string,
    args: string[],
    options: string[] = [],
    timeoutMs = 30000,
  ) {
    const deadline = Date.now() + timeoutMs;
    const remaining = () => {
      const n = deadline - Date.now();
      if (n <= 0) throw Error("owned-probe-timeout");
      return n;
    };
    const name = this.ownership.owner + "-" + this.ownership.containers.length;
    // Stable identity is durable before the create intent, including a lost response.
    this.ownership.containers.push(name);
    persistOwnership(this.ownership);
    await this.commands.mutation(
      [
        "create",
        "--name",
        name,
        "--label",
        "rocky-next.owner=" + this.ownership.owner,
        "--network",
        "none",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--memory",
        "512m",
        "--pids-limit",
        "64",
        ...options,
        image,
        ...args,
      ],
      name + "-create",
      remaining(),
    );
    await this.commands.mutation(["start", name], name + "-start", remaining());
    const wait = await this.commands.dockerCommand(["wait", name], remaining());
    const logs = await this.commands.dockerCommand(
      ["logs", name],
      Math.min(remaining(), 10000),
    );
    const exitCode = Number(wait.stdout.trim());
    this.commands.save(name + "-result", {
      name,
      exitCode,
      waitCommandId: wait.record.id,
      logCommandId: logs.record.id,
    });
    if (exitCode !== 0) throw Error("owned-probe-exit:" + exitCode);
    return logs;
  }
  close(): Promise<CleanupReceipt> {
    if (!this.#stop) {
      const attempt = this.#close();
      this.#stop = attempt;
      void attempt.catch(() => {
        if (this.#stop === attempt) this.#stop = undefined;
      });
    }
    return this.#stop;
  }
  async #close() {
    clearInterval(this.#heartbeat);
    const deadline = Date.now() + LIMITS.teardownMs;
    try {
      if (!this.#closing) {
        this.#closing = true;
        this.commands.store.cancel(this.commands.lease.runId);
      }
      this.ownership.expiresAt = deadline;
      persistOwnership(this.ownership);
      const receipt = await cleanOwned(this.ownership, deadline);
      if (receipt.status !== "complete") throw new CleanupIncomplete(receipt);
      writeFileSync(
        join(this.commands.root, "stopped.json"),
        JSON.stringify(receipt),
        { mode: 0o600 },
      );
      return receipt;
    } finally {
      this.commands.close();
    }
  }
}
