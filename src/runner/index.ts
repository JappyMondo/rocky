import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Store, type Lease, type CommandRecord } from "../store/index.js";
import { canonical, type Json } from "../store/json.js";
import type { Artifact } from "../evidence/index.js";
import { delay, matches } from "./process.js";
export interface CommandSpec {
  file: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  cleanupMs: number;
  logBytes: number;
  outputDir: string;
}
export interface CommandResult {
  outcome:
    | "success"
    | "failed"
    | "timeout"
    | "cancelled"
    | "lease-lost"
    | "recovery-required";
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  stdoutArtifact?: Artifact;
  stderrArtifact?: Artifact;
}
function validate(spec: CommandSpec) {
  if (process.platform === "win32") throw new Error("posix-runner-required");
  for (const key of ["timeoutMs", "cleanupMs", "logBytes"] as const)
    if (
      !Number.isSafeInteger(spec[key]) ||
      spec[key] < 1 ||
      spec[key] > 2147483647
    )
      throw new Error("invalid-command-limit");
  if (
    !spec.file ||
    !Array.isArray(spec.args) ||
    spec.args.some((a) => typeof a !== "string")
  )
    throw new Error("invalid-command");
  canonical(spec);
}
export class CommandRunner {
  constructor(readonly store: Store) {}
  start(lease: Lease, spec: CommandSpec): string {
    validate(spec);
    this.store.assertLease(lease);
    const id = randomUUID();
    const token = randomUUID();
    const normalized = {
      ...spec,
      cwd: resolve(spec.cwd),
      outputDir: resolve(spec.outputDir, id),
    };
    mkdirSync(normalized.outputDir, { recursive: true, mode: 0o700 });
    this.store.reserveCommand(lease, id, token, normalized as unknown as Json);
    try {
      this.store.guardedStart(lease, () => {
        const child = spawn(
          process.execPath,
          [
            fileURLToPath(new URL("./supervisor.js", import.meta.url)),
            this.store.path,
            id,
            token,
          ],
          {
            detached: true,
            stdio: "ignore",
            env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
          },
        );
        child.on("error", () => {
          try {
            this.store.observeCommand(id, token, {
              state: "recovery-required",
            });
          } catch {
            /* Durable starting row is recoverable even if store closed. */
          }
        });
        child.unref();
      });
    } catch (error) {
      this.store.observeCommand(id, token, { state: "recovery-required" });
      throw error;
    }
    return id;
  }
  async wait(lease: Lease, id: string): Promise<CommandRecord> {
    const ttl = this.store.get(lease.runId).config.values.leaseMs;
    let renewed = 0;
    while (true) {
      const c = this.store.command(id);
      if (!c || c.runId !== lease.runId) throw new Error("command-not-found");
      if (c.state === "finished" || c.state === "recovery-required") return c;
      if (Date.now() - renewed > ttl / 3) {
        try {
          this.store.renew(lease, ttl);
          renewed = Date.now();
        } catch {
          /* Supervisor observes lease loss and retains output. */
        }
      }
      const spec = c.spec as unknown as CommandSpec;
      if (Date.now() - c.createdAt > spec.timeoutMs + spec.cleanupMs + 5000) {
        this.store.observeCommand(id, c.token, { state: "recovery-required" });
        return this.store.command(id)!;
      }
      if (
        (c.supervisor && !matches(c.supervisor)) ||
        (!c.supervisor && Date.now() - c.createdAt > 2000)
      )
        return this.recover(lease, id);
      await delay(25);
    }
  }
  async run(lease: Lease, spec: CommandSpec) {
    return this.wait(lease, this.start(lease, spec));
  }
  recover(lease: Lease, id: string): CommandRecord {
    this.store.assertLease(lease, true);
    const c = this.store.command(id);
    if (!c || c.runId !== lease.runId) throw new Error("command-not-found");
    if (c.state === "finished" || c.state === "recovery-required") return c;
    if (c.supervisor && matches(c.supervisor)) return c;
    // Missing/ambiguous supervisor identity never authorizes signalling a retained arbitrary PID.
    this.store.observeCommand(id, c.token, { state: "recovery-required" });
    return this.store.command(id)!;
  }
}
