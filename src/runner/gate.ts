import { spawn } from "node:child_process";
import { Store } from "../store/index.js";
import { JsonLineDecoder } from "./duplex.js";
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
    const child = store.guardedStart(command.lease, () => {
      if (command.duplex) store.assertDuplexStart(id, token);
      return spawn(spec.file, spec.args, {
        cwd: spec.cwd,
        stdio: [command.duplex ? "pipe" : "ignore", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: spec.cwd,
          TMPDIR: spec.outputDir,
        },
      });
    });
    if (command.duplex) {
      let failed = false,
        busy = false;
      const fail = (error: unknown) => {
        if (failed) return;
        failed = true;
        const failure =
          error instanceof Error ? error.message : "duplex-io-failure";
        try {
          store.observeDuplex(id, token, { failure });
        } catch {
          /* Supervisor retains recovery. */
        }
        process.send?.({ duplexFailure: failure });
      };
      const decoder = new JsonLineDecoder(
        command.duplex.limits.frameBytes,
        (frame) => {
          store.observeDuplex(id, token, { frame });
          if (store.command(id)?.duplex?.failure)
            throw new Error("duplex-output-limit");
        },
      );
      child.stdout?.on("data", (chunk: Buffer) => {
        if (failed) return;
        try {
          store.observeDuplex(id, token, { bytes: chunk.length });
          if (store.command(id)?.duplex?.failure)
            throw new Error("duplex-output-limit");
          decoder.push(chunk);
        } catch (error) {
          fail(error);
        }
      });
      child.stdout?.on("end", () => {
        try {
          decoder.end();
        } catch (error) {
          fail(error);
        }
        try {
          store.observeDuplex(id, token, {
            childStdoutEof: true,
            ...(!failed ? { decoderComplete: true } : {}),
          });
        } catch (error) {
          fail(error);
        }
      });
      child.stderr?.on("end", () => {
        try {
          store.observeDuplex(id, token, { childStderrEof: true });
        } catch (error) {
          fail(error);
        }
      });
      child.stdin?.on("error", fail);
      const pump = setInterval(() => {
        if (failed || busy) return;
        try {
          const send = store.claimDuplexSend(id, token);
          if (!send) return;
          busy = true;
          store.writeDuplex(id, token, send.key, (next) => {
            const written = (error?: Error | null) => {
              if (error) {
                fail(error);
                return;
              }
              try {
                store.finishDuplexSend(id, token, next.key);
                busy = false;
              } catch (error) {
                fail(error);
              }
            };
            if (next.end) child.stdin!.end(written);
            else child.stdin!.write(next.wire, written);
          });
        } catch (error) {
          fail(error);
        }
      }, 10);
      child.once("exit", () => clearInterval(pump));
    }
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
