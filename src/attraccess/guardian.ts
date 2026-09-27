import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { cleanOwned, type Ownership } from "./resources.js";
import { delay, identify } from "../runner/process.js";
import { LIMITS } from "./policy.js";
const root = process.argv[2];
if (!root) throw Error("guardian-root-required");
writeFileSync(
  join(root, "guardian.json"),
  JSON.stringify(identify(process.pid)),
  { mode: 0o600 },
);
while (!existsSync(join(root, "stopped.json"))) {
  let state: Ownership;
  try {
    state = JSON.parse(
      readFileSync(join(root, "control", "ownership.json"), "utf8"),
    );
  } catch {
    await delay(250);
    continue;
  }
  if (Date.now() <= state.expiresAt) {
    await delay(250);
    continue;
  }
  // A recovery window is separately recorded; no automatic extension of a caller's teardown.
  const deadline = Date.now() + LIMITS.teardownMs;
  let complete = false,
    attempts = 0;
  while (Date.now() < deadline && !existsSync(join(root, "stopped.json"))) {
    const receipt = await cleanOwned(state, deadline);
    attempts++;
    if (receipt.status === "complete") {
      complete = true;
      break;
    }
    await delay(Math.min(250, Math.max(0, deadline - Date.now())));
  }
  complete ||= existsSync(join(root, "stopped.json"));
  writeFileSync(
    join(root, complete ? "guardian-complete.json" : "guardian-error.json"),
    JSON.stringify({
      reason: complete ? "expired-cleaned" : "reconciliation-required",
      at: Date.now(),
      deadline,
      attempts,
    }),
    { mode: 0o600 },
  );
  break;
}
