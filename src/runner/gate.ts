import { spawn } from "node:child_process";
import { Store } from "../store/index.js";
import type { CommandSpec } from "./index.js";
const [db, id, token] = process.argv.slice(2);
if (!db || !id || !token) throw new Error("invalid-gate-arguments");
const store = new Store(db);
const command = store.command(id);
if (!command || command.token !== token)
  throw new Error("command-capability-invalid");
// Keep the process group leader alive until the supervisor finishes group cleanup.
const keepalive = setInterval(() => {}, 1000);
process.on("SIGTERM", () => {});
process.once("message", (message) => {
  if (message !== "go") return;
  try {
    const spec = command.spec as unknown as CommandSpec;
    const child = store.guardedStart(command.lease, () =>
      spawn(spec.file, spec.args, {
        cwd: spec.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: spec.cwd,
          TMPDIR: spec.outputDir,
        },
      }),
    );
    child.stdout?.pipe(process.stdout);
    child.stderr?.pipe(process.stderr);
    child.once("error", () =>
      process.send?.({ exitCode: null, signal: null, error: "spawn-failed" }),
    );
    child.once("exit", (exitCode, signal) =>
      process.send?.({ exitCode, signal }),
    );
  } catch (error) {
    process.send?.({
      exitCode: null,
      signal: null,
      error: error instanceof Error ? error.message : "start-failed",
    });
  }
});
process.on("disconnect", () => {
  clearInterval(keepalive);
  try {
    process.kill(-process.pid, "SIGKILL");
  } catch {
    process.exit(1);
  }
});
