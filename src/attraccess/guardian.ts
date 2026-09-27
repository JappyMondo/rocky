import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { cleanOwned, type Ownership } from "./resources.js";
import { delay, identify } from "../runner/process.js";
const root = process.argv[2];
if (!root) throw new Error("guardian-root-required");
writeFileSync(
  join(root, "guardian.json"),
  JSON.stringify(identify(process.pid)),
  { mode: 0o600 },
);
while (true) {
  if (existsSync(join(root, "stopped.json"))) break;
  let ownership: Ownership;
  try {
    ownership = JSON.parse(
      readFileSync(join(root, "control", "ownership.json"), "utf8"),
    ) as Ownership;
  } catch {
    await delay(250);
    continue;
  }
  if (Date.now() > ownership.expiresAt) {
    try {
      cleanOwned(ownership);
      writeFileSync(
        join(root, "guardian-complete.json"),
        JSON.stringify({ reason: "expired", at: Date.now() }),
        { mode: 0o600 },
      );
    } catch (error) {
      writeFileSync(
        join(root, "guardian-error.json"),
        JSON.stringify({
          reason: "cleanup-required",
          error: error instanceof Error ? error.message : "unknown",
        }),
        { mode: 0o600 },
      );
    }
    break;
  }
  await delay(250);
}
