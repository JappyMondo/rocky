// Independent bounded recovery of the one explicitly registered process group.
import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { processes } from "./common.mjs";
const [statePath, stopPath, logPath] = process.argv.slice(2);
function record(value) {
  appendFileSync(logPath, JSON.stringify({ at: Date.now(), ...value }) + "\n", {
    mode: 0o600,
  });
}
let last;
const timer = setInterval(() => {
  try {
    const state = JSON.parse(readFileSync(statePath));
    last = state;
    if (existsSync(stopPath)) {
      record({ type: "normal-stop" });
      clearInterval(timer);
      return;
    }
    if (Date.now() < state.deadline && Date.now() - state.heartbeat < 6000)
      return;
    const all = processes(),
      leader = all.find((p) => p.pid === state.leader.pid);
    if (
      !leader ||
      leader.start !== state.leader.start ||
      leader.pgid !== state.leader.pid
    ) {
      record({
        type: "recovery-unresolved",
        reason: "leader-identity-unavailable",
        remaining: all.filter((p) => p.pgid === state.leader.pid),
      });
    } else {
      record({ type: "recovery-kill", leader });
      process.kill(-leader.pid, "SIGKILL");
    }
    clearInterval(timer);
    setTimeout(
      () =>
        record({
          type: "recovery-final",
          remaining: processes().filter((p) => p.pgid === state.leader.pid),
        }),
      1000,
    );
  } catch (error) {
    record({
      type: "guardian-error",
      error: error.message,
      registered: Boolean(last),
    });
    clearInterval(timer);
  }
}, 500);
