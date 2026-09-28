import { Store } from "../dist/index.js";
import { versions, admission } from "./coordinator-support.mjs";
const [mode, path, id = "run-1"] = process.argv.slice(2);
const s = new Store(path, () => 1000);
try {
  if (mode === "admit") {
    s.admitCoordinator(admission(id, { issue: "same" }));
    process.send({ ok: true, id });
  } else if (mode === "ingest") {
    process.send(
      s.ingestCoordinator("run-1", "scheduler", "shared-event", {
        type: "schedule",
        kind: "baseline",
      }),
    );
  } else {
    const lease = s.claim(id, `worker-${process.pid}`, versions, 1000);
    s.ingestCoordinator(id, "scheduler", `start-${id}`, {
      type: "schedule",
      kind: "baseline",
    });
    if (mode === "crash") process.send({ starting: true });
    const snapshot = s.applyCoordinator(lease, 0, "scheduler", `start-${id}`);
    process.send({ ok: true, snapshot, lease });
    if (mode === "crash" || mode === "committed") await new Promise(() => {});
  }
} catch (e) {
  process.send({ error: e.message });
}
s.close();
