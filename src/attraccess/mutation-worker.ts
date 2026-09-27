// Independent receipt keeper: preparer death does not destroy transport outcome.
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../store/index.js";
import { identify } from "../runner/process.js";
import {
  durableJson,
  type MutationRequest,
  type MutationResult,
} from "./mutations.js";
import { verifyInstalledBuild } from "./integrity.js";
import { TARGET } from "./policy.js";
const dir = process.argv[2];
if (!dir) throw Error("mutation-directory-required");
const request = JSON.parse(
  readFileSync(join(dir, "request.json"), "utf8"),
) as MutationRequest;
const build = verifyInstalledBuild(),
  identity = identify(process.pid);
if (!identity) throw Error("mutation-worker-identity-unavailable");
durableJson(join(dir, "worker.json"), identity);
const markers = join(TARGET.root, "active-runtimes");
mkdirSync(markers, { recursive: true, mode: 0o700 });
const marker = join(markers, randomUUID() + ".json");
writeFileSync(
  marker,
  JSON.stringify({
    process: identity,
    build: build.build.buildId,
    attempt: "mutation:" + request.key,
  }),
  { mode: 0o600 },
);
let store: Store | undefined;
try {
  store = new Store(join(request.root, "run.sqlite"));
  let result: MutationResult;
  let dispatchPossible = false;
  let pending: Promise<MutationResult> | undefined;
  try {
    result = await store.guardedStart(request.lease, () => {
      durableJson(join(dir, "dispatch.json"), {
        at: new Date().toISOString(),
        worker: identity,
      });
      dispatchPossible = true;
      pending = new Promise<MutationResult>((resolve) => {
        const child = execFile(
          request.docker,
          ["--host", request.dockerHost, ...request.args],
          {
            timeout: request.timeoutMs,
            killSignal: "SIGKILL",
            maxBuffer: 1024 * 1024,
          },
          (error, stdout, stderr) =>
            resolve({
              status: !error
                ? "acknowledged"
                : child.pid
                  ? "unknown"
                  : "not-dispatched",
              at: new Date().toISOString(),
              stdout,
              stderr,
            }),
        );
        // Metadata failure must not settle the transport before its callback.
        // The durable worker identity and sending outbox retain responsibility.
        if (child.pid) {
          try {
            durableJson(join(dir, "client.json"), identify(child.pid));
          } catch {
            /* No terminal outcome is inferred from a failed identity write. */
          }
        }
      });
      return pending;
    });
  } catch (error) {
    // A transaction commit can fail after spawning. Still await the actual
    // transport callback before publishing any terminal outcome.
    const terminal = pending ? await pending.catch(() => undefined) : undefined;
    result = terminal ?? {
      status: dispatchPossible ? "unknown" : "not-dispatched",
      at: new Date().toISOString(),
      stdout: "",
      stderr: error instanceof Error ? error.message : "dispatch-refused",
    };
  }
  durableJson(join(dir, "result.json"), result);
} finally {
  store?.close();
  unlinkSync(marker);
}
