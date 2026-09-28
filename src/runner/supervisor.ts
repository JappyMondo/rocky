import { spawn } from "node:child_process";
import {
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Store, type ProcessIdentity } from "../store/index.js";
import type { Json } from "../store/json.js";
import type { CommandSpec, CommandResult } from "./index.js";
import { Evidence } from "../evidence/index.js";
import { identify, signalGroup, groupAbsent, delay } from "./process.js";
const [db, id, token] = process.argv.slice(2);
if (!db || !id || !token) throw new Error("invalid-supervisor-arguments");
const store = new Store(db);
const command = store.command(id);
if (!command || command.token !== token)
  throw new Error("command-capability-invalid");
const spec = command.spec as unknown as CommandSpec;
let group: ProcessIdentity | null = null;
const stdout = join(spec.outputDir, "stdout.log"),
  stderr = join(spec.outputDir, "stderr.log");
const out = openSync(stdout, "wx", 0o600),
  err = openSync(stderr, "wx", 0o600);
let outBytes = 0,
  errBytes = 0,
  outTruncated = false,
  errTruncated = false;
let result: CommandResult = {
  outcome: "failed",
  exitCode: null,
  signal: null,
  stdout,
  stderr,
  stdoutTruncated: false,
  stderrTruncated: false,
};
let finished = false,
  stopping = false;
let pipesEof = 0;
let quiescent = false;
const capture = (fd: number, isOut: boolean) => (data: Buffer) => {
  const used = isOut ? outBytes : errBytes;
  const chunk = data.subarray(0, Math.max(0, spec.logBytes - used));
  if (chunk.length) {
    writeSync(fd, chunk);
    fsyncSync(fd);
  }
  if (isOut) {
    outBytes += chunk.length;
    outTruncated ||= chunk.length < data.length;
  } else {
    errBytes += chunk.length;
    errTruncated ||= chunk.length < data.length;
  }
  if (command.duplex && chunk.length < data.length) {
    store.observeDuplex(id, token, { failure: "duplex-log-limit" });
    result.outcome = "failed";
    finished = true;
  }
};
try {
  const own = identify(process.pid);
  if (!own) throw new Error("supervisor-identity-unavailable");
  store.observeCommand(id, token, { supervisor: own });
  store.assertLease(command.lease);
  const gate = spawn(
    process.execPath,
    [fileURLToPath(new URL("./gate.js", import.meta.url)), db, id, token],
    {
      detached: true,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    },
  );
  gate.stdout?.on("data", capture(out, true));
  gate.stdout?.on("end", () => {
    pipesEof++;
    if (command.duplex) store.observeDuplex(id, token, { stdoutEof: true });
  });
  gate.stderr?.on("end", () => {
    pipesEof++;
    if (command.duplex) store.observeDuplex(id, token, { stderrEof: true });
  });
  gate.stderr?.on("data", capture(err, false));
  gate.on("error", () => {
    finished = true;
  });
  gate.on("message", (message: unknown) => {
    if (stopping || (command.duplex && finished)) return;
    const m = message as {
      exitCode: number | null;
      signal: string | null;
      error?: string;
      duplexFailure?: string;
    };
    if (m.duplexFailure) {
      result.outcome =
        m.duplexFailure === "cancelled" ||
        m.duplexFailure === "duplex-input-closed"
          ? "cancelled"
          : m.duplexFailure === "stale-lease"
            ? "lease-lost"
            : m.duplexFailure === "action-deadline-exceeded"
              ? "timeout"
              : "failed";
      finished = true;
      return;
    }
    result.exitCode = m.exitCode;
    result.signal = m.signal;
    result.outcome =
      m.error === "cancelled"
        ? "cancelled"
        : m.error === "stale-lease"
          ? "lease-lost"
          : m.exitCode === 0
            ? "success"
            : "failed";
    finished = true;
  });
  gate.on("exit", () => {
    finished = true;
  });
  if (!gate.pid) throw new Error("gate-spawn-failed");
  group = identify(gate.pid);
  if (!group) throw new Error("group-identity-unavailable");
  store.observeCommand(id, token, { group, state: "running" });
  // Target spawn performs its own final transactional guard after receiving this message.
  gate.send("go");
  const deadline = Date.now() + spec.timeoutMs;
  while (!finished) {
    try {
      store.assertLease(command.lease);
      if (command.duplex) {
        store.assertDuplexAction(command.lease, command.duplex.action);
        const d = store.command(id)?.duplex;
        if (d?.revoked) {
          result.outcome = "cancelled";
          break;
        }
        if (d?.failure) {
          result.outcome = "failed";
          break;
        }
      }
    } catch (error) {
      result.outcome =
        (error as Error).message === "cancelled"
          ? "cancelled"
          : (error as Error).message === "action-deadline-exceeded"
            ? "timeout"
            : "lease-lost";
      break;
    }
    if (Date.now() >= deadline) {
      result.outcome = "timeout";
      break;
    }
    await delay(20);
  }
  stopping = true;
  if (group) {
    if (!command.duplex || !groupAbsent(group)) signalGroup(group, "SIGTERM");
    await delay(spec.cleanupMs);
    if (!command.duplex || !groupAbsent(group)) signalGroup(group, "SIGKILL");
  }
  if (command.duplex) {
    const cleanupDeadline = Date.now() + Math.max(1000, spec.cleanupMs);
    while (Date.now() < cleanupDeadline) {
      const d = store.command(id)?.duplex;
      if (
        group &&
        groupAbsent(group) &&
        pipesEof === 2 &&
        d?.stdoutEof &&
        d.stderrEof
      ) {
        quiescent = true;
        break;
      }
      await delay(20);
    }
    if (!quiescent) result.outcome = "recovery-required";
  } else await delay(30);
} catch (error) {
  const message = error instanceof Error ? error.message : "";
  if (command.duplex) result.cleanupError = message;
  result.outcome =
    message === "cancelled"
      ? "cancelled"
      : message === "stale-lease"
        ? "lease-lost"
        : "recovery-required";
  if (group) {
    try {
      signalGroup(group, "SIGKILL");
    } catch {
      /* Never signal uncertain/reused identities. */
    }
  }
} finally {
  // Cancellation/lease errors before verified cleanup must not release the command or capacity.
  if (command.duplex && !quiescent) result.outcome = "recovery-required";
  if (
    command.duplex &&
    store.command(id)?.duplex?.failure &&
    result.outcome === "success"
  )
    result.outcome = "failed";
  fsyncSync(out);
  fsyncSync(err);
  closeSync(out);
  closeSync(err);
  const evidence = new Evidence(join(spec.outputDir, "artifacts"));
  result.stdoutArtifact = evidence.put(readFileSync(stdout));
  result.stderrArtifact = evidence.put(readFileSync(stderr));
  result.stdoutTruncated = outTruncated;
  result.stderrTruncated = errTruncated;
  store.observeCommand(id, token, {
    state:
      result.outcome === "recovery-required" ? "recovery-required" : "finished",
    result: result as unknown as Json,
  });
  store.close();
}
