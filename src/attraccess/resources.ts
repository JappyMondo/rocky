import { execFileSync, execFile } from "node:child_process";
import {
  writeFileSync,
  renameSync,
  readFileSync,
  mkdirSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { matches, signalGroup, identify } from "../runner/process.js";
import type { ProcessIdentity } from "../store/index.js";
import { sealAndReadEffects, mutationHazards } from "./mutations.js";
import { delay } from "../runner/process.js";
import { LIMITS } from "./policy.js";
export interface Ownership {
  owner: string;
  runId?: string;
  docker: string;
  dockerHost: string;
  root: string;
  expiresAt: number;
  containers: string[];
  networks: string[];
  browsers?: ProcessIdentity[];
}
export function persistOwnership(state: Ownership) {
  mkdirSync(join(state.root, "control"), { recursive: true, mode: 0o700 });
  const tmp = join(state.root, "control", ".ownership-" + randomUUID());
  writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  renameSync(tmp, join(state.root, "control", "ownership.json"));
}
export function dockerRead(state: Ownership, args: string[]) {
  return execFileSync(state.docker, ["--host", state.dockerHost, ...args], {
    encoding: "utf8",
    timeout: 15000,
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
  });
}
export function assertOwned(
  state: Ownership,
  kind: "container" | "network",
  id: string,
) {
  const inspect = JSON.parse(dockerRead(state, [kind, "inspect", id]))[0];
  const labels = kind === "container" ? inspect.Config?.Labels : inspect.Labels;
  if (labels?.["rocky-next.owner"] !== state.owner)
    throw new Error("foreign-resource");
  return inspect;
}
export interface CleanupReceipt {
  at: string;
  owner: string;
  status: "complete" | "incomplete";
  deadline: number;
  elapsedMs: number;
  removed: { containers: string[]; networks: string[] };
  remaining: {
    containers: string[] | null;
    networks: string[] | null;
    browsers: number[];
  };
  errors: { operation: string; error: string }[];
  pendingMutations: { key: string; reason: string }[];
}
export class CleanupIncomplete extends Error {
  constructor(readonly receipt: CleanupReceipt) {
    super("owned-cleanup-incomplete");
  }
}
// Each invocation has one aggregate budget. Failure receipts survive; a later invocation
// reconciles the durable label again, never blindly retries an uncertain create.
export async function cleanOwned(
  state: Ownership,
  deadline = Date.now() + LIMITS.teardownMs,
): Promise<CleanupReceipt> {
  const started = Date.now(),
    token = randomUUID(),
    lock = join(state.root, "cleanup.lock");
  const receipt: CleanupReceipt = {
    at: new Date().toISOString(),
    owner: state.owner,
    status: "incomplete",
    deadline,
    elapsedMs: 0,
    removed: { containers: [], networks: [] },
    remaining: { containers: null, networks: null, browsers: [] },
    errors: [],
    pendingMutations: [],
  };
  const fail = (operation: string, error: unknown) =>
    receipt.errors.push({
      operation,
      error: error instanceof Error ? error.message : String(error),
    });
  const save = () => {
    receipt.elapsedMs = Date.now() - started;
    const bytes = JSON.stringify(receipt, null, 2);
    writeFileSync(join(state.root, "cleanup-" + token + ".json"), bytes, {
      mode: 0o600,
      flag: "wx",
    });
    const temporary = join(state.root, ".cleanup-" + token);
    writeFileSync(temporary, bytes, { mode: 0o600 });
    renameSync(temporary, join(state.root, "cleanup.json"));
  };
  let acquired = false;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        writeFileSync(
          lock,
          JSON.stringify({ token, process: identify(process.pid) }),
          { mode: 0o600, flag: "wx" },
        );
        acquired = true;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const holder = JSON.parse(readFileSync(lock, "utf8")) as {
          process: ProcessIdentity | null;
        };
        if (!holder.process || matches(holder.process))
          throw new Error("cleanup-already-active");
        unlinkSync(lock); // Dead owner only; never displace a live cleaner.
      }
    }
    if (!acquired) throw new Error("cleanup-lock-unavailable");
    const run = (args: string[]) =>
      new Promise<string>((resolve, reject) => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          reject(new Error("cleanup-deadline-exceeded"));
          return;
        }
        execFile(
          state.docker,
          ["--host", state.dockerHost, ...args],
          {
            encoding: "utf8",
            timeout: Math.max(1, Math.min(15000, remaining)),
            killSignal: "SIGKILL",
            maxBuffer: 1024 * 1024,
          },
          (error, stdout, stderr) => {
            if (error) {
              const e = new Error(
                (error as NodeJS.ErrnoException).code === "ETIMEDOUT" ||
                error.killed
                  ? "cleanup-command-timeout"
                  : String(stderr).trim() || error.message,
              );
              reject(e);
            } else resolve(stdout);
          },
        );
      });
    const listing = async (kind: "containers" | "networks") => {
      try {
        return (
          await run(
            kind === "containers"
              ? [
                  "ps",
                  "-aq",
                  "--filter",
                  "label=rocky-next.owner=" + state.owner,
                ]
              : [
                  "network",
                  "ls",
                  "-q",
                  "--filter",
                  "label=rocky-next.owner=" + state.owner,
                ],
          )
        )
          .trim()
          .split(/\s+/)
          .filter(Boolean);
      } catch (e) {
        fail("list-" + kind, e);
        return null;
      }
    };
    for (const browser of state.browsers ?? []) {
      try {
        if (Date.now() >= deadline) throw Error("cleanup-deadline-exceeded");
        if (matches(browser)) {
          const pgid = Number(
            execFileSync(
              "/bin/ps",
              ["-p", String(browser.pid), "-o", "pgid="],
              {
                encoding: "utf8",
                timeout: Math.max(1, Math.min(1000, deadline - Date.now())),
                killSignal: "SIGKILL",
              },
            ).trim(),
          );
          if (pgid !== browser.pid)
            throw Error("browser-group-identity-uncertain");
          signalGroup(browser, "SIGKILL");
        }
      } catch (e) {
        fail("browser-" + browser.pid, e);
        receipt.remaining.browsers.push(browser.pid);
      }
    }
    // Cancel serializes with the actual dispatch seam in each independent keeper.
    // An empty label snapshot is only absence now, never evidence against a late create.
    if (Date.now() >= deadline) throw Error("cleanup-deadline-exceeded");
    const effects = sealAndReadEffects(state.root, state.runId);
    const initial = {
      containers: await listing("containers"),
      networks: await listing("networks"),
    };
    receipt.pendingMutations = await mutationHazards(
      state.root,
      state.owner,
      effects,
      async (kind, name) => JSON.parse(await run([kind, "inspect", name]))[0],
    );
    if (receipt.pendingMutations.length) {
      receipt.remaining.containers = initial.containers;
      receipt.remaining.networks = initial.networks;
      fail("mutation-quiescence", new Error("pending-daemon-effects"));
      return receipt;
    }
    for (const kind of ["containers", "networks"] as const) {
      const known = await listing(kind);
      for (const id of known ?? []) {
        try {
          const singular = kind === "containers" ? "container" : "network";
          let inspected;
          try {
            inspected = JSON.parse(await run([singular, "inspect", id]))[0];
          } catch (e) {
            if (/No such (container|network|object)/i.test(String(e))) continue;
            throw e;
          }
          const labels =
            kind === "containers"
              ? inspected?.Config?.Labels
              : inspected?.Labels;
          if (labels?.["rocky-next.owner"] !== state.owner)
            throw Error("foreign-resource");
          try {
            await run(
              kind === "containers"
                ? ["rm", "--force", id]
                : ["network", "rm", id],
            );
          } catch (e) {
            if (!/No such (container|network|object)/i.test(String(e))) throw e;
          }
          receipt.removed[kind].push(id);
        } catch (e) {
          fail("remove-" + kind + ":" + id, e);
        }
      }
    }
    for (const browser of state.browsers ?? []) {
      if (
        !receipt.remaining.browsers.includes(browser.pid) &&
        (Date.now() >= deadline || matches(browser))
      ) {
        receipt.remaining.browsers.push(browser.pid);
        fail("browser-final-proof", new Error("browser-exit-unconfirmed"));
      }
    }
    receipt.remaining.containers = await listing("containers");
    receipt.remaining.networks = await listing("networks");
    if (
      receipt.remaining.containers?.length === 0 &&
      receipt.remaining.networks?.length === 0 &&
      receipt.remaining.browsers.length === 0 &&
      !receipt.errors.some((e) => e.error === "foreign-resource")
    )
      receipt.status = "complete";
  } catch (e) {
    fail("cleanup", e);
  } finally {
    if (acquired) {
      try {
        if (JSON.parse(readFileSync(lock, "utf8")).token === token)
          unlinkSync(lock);
      } catch (e) {
        fail("cleanup-lock-release", e);
        receipt.status = "incomplete";
      }
    }
    save();
  }
  return receipt;
}

export async function settleOwned(
  state: Ownership,
  deadline = Date.now() + LIMITS.teardownMs,
) {
  let receipt: CleanupReceipt;
  do {
    receipt = await cleanOwned(state, deadline);
    if (receipt.status === "complete" || !receipt.pendingMutations.length)
      return receipt;
    await delay(Math.max(0, Math.min(250, deadline - Date.now())));
  } while (Date.now() < deadline);
  return receipt;
}
