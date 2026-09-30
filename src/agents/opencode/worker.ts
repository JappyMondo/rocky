// Trusted adapter worker. No target staging, coordinator application, Git/GitHub or lease renewal.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../../store/index.js";
import { canonical, digest } from "../../store/json.js";
import { identify } from "../../runner/process.js";
import { assertBinaryIdentity } from "../../runner/process.js";
import { assertOpencodeSourceEnvAdmissible } from "./env.js";
import { assertOpencodeDataHomeIsolation } from "./launch.js";
import { assertHostAdmission } from "./host.js";
import { validateOpencodeConfig } from "./config.js";
import { OpencodeAdapter } from "./adapter.js";
import { retainImmutable } from "./retention.js";
import {
  validateWorkerMessage,
  workerMessage,
  type WorkerRequest,
} from "./worker-protocol.js";

const file = process.argv[2];
if (!file || !process.send) throw new Error("opencode-worker-request-required");
const request = JSON.parse(readFileSync(file, "utf8")) as WorkerRequest;
if (
  request.schema !== 1 ||
  !request.nonce ||
  !request.directory ||
  file !== join(request.directory, "request.json")
)
  throw new Error("opencode-worker-request-shape");
const config = validateOpencodeConfig(request.config);
const store = new Store(request.db);
let connected = true,
  begun = false,
  prepared = false,
  pending: Promise<unknown> | null = null,
  closing = false;
const exportAbort = new AbortController();
const adapter = new OpencodeAdapter(store, request.lease, config, {
  renewLease: false,
  canStart: () => connected,
  exportSignal: exportAbort.signal,
});
const send = (
  type: Parameters<typeof workerMessage>[1],
  payload: unknown = null,
) => {
  if (connected && process.connected)
    process.send!(workerMessage(request, type, payload));
};
const close = () => {
  if (closing) return;
  closing = true;
  store.close();
  if (process.connected) process.disconnect();
};
function fail(error: unknown) {
  const message =
    error instanceof Error
      ? error.message.slice(0, 1024)
      : "opencode-worker-failure";
  try {
    retainImmutable(
      join(request.directory, "failure.json"),
      canonical({ schema: 1, actionKey: request.action.key, message, begun }),
    );
  } catch {
    /* Native command rows remain recoverable. */
  }
  send("error", { message });
  close();
}
process.on("disconnect", () => {
  connected = false;
  exportAbort.abort();
  if (!pending) close();
});
process.on("message", (value) => {
  try {
    const m = validateWorkerMessage(value, request);
    if (m.type === "stop") {
      connected = false;
      exportAbort.abort();
      if (!pending) close();
      return;
    }
    if (m.type === "freeze" && !prepared && !begun) {
      store.assertLease(request.lease);
      const plan = adapter.prepareLaunch(request.action, {
        prompt: request.prompt,
      });
      prepared = true;
      send("plan", plan);
      return;
    }
    if (m.type !== "begin" || !prepared || begun || !connected)
      throw new Error("opencode-worker-protocol-state");
    begun = true;
    store.assertDuplexAction(request.lease, request.action);
    pending = adapter
      .begin(request.action)
      .then((result) => {
        retainImmutable(
          join(request.directory, "result.json"),
          canonical({ schema: 1, actionKey: request.action.key, result }),
        );
        send("result", result);
        close();
      })
      .catch(fail);
  } catch (error) {
    fail(error);
  }
});
try {
  // The real process environment is checked, not a host-supplied projection.
  assertOpencodeSourceEnvAdmissible(process.env);
  store.assertLease(request.lease);
  if (
    canonical(store.coordinatorSnapshot(request.action.runId)?.execution) !==
    canonical(request.action)
  )
    throw new Error("opencode-worker-action-mismatch");
  if (config.evidenceClass === "live-subscription") assertHostAdmission(config);
  assertBinaryIdentity(config.binary);
  assertOpencodeDataHomeIsolation(
    config.dataHome,
    config.hostIdentity.userHome,
  );
  const processIdentity = identify(process.pid);
  if (!processIdentity) throw new Error("opencode-worker-identity");
  retainImmutable(
    join(request.directory, "worker.json"),
    canonical({
      schema: 1,
      process: processIdentity,
      actionKey: request.action.key,
      lease: request.lease,
      build: config.versions.build,
      sourceEnvNames: Object.keys(process.env).sort(),
    }),
  );
  send("preflight", {
    runRoot: join(
      config.runsRoot,
      "run-" + digest(request.action.key).slice(0, 32),
    ),
    process: processIdentity,
  });
} catch (error) {
  fail(error);
}
