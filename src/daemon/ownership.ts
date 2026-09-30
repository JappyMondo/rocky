import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { identify, matches } from "../runner/process.js";
import type { ProcessIdentity } from "../store/index.js";
import type { Store } from "../store/index.js";

type Owner = { process: ProcessIdentity; token: string };
function readOwner(path: string): Owner {
  const owner = JSON.parse(readFileSync(path, "utf8")) as Owner;
  if (
    !owner.process ||
    !Number.isSafeInteger(owner.process.pid) ||
    typeof owner.process.fingerprint !== "string"
  )
    throw new Error("Owned process identity is unreadable; inspect " + path);
  return owner;
}
/** Inspect identities before setup or startup changes any existing state. */
export function assertHomeAvailable(home: string) {
  for (const name of ["daemon.json", "operator-owner.json"]) {
    const path = join(home, name);
    if (existsSync(path) && matches(readOwner(path).process))
      throw new Error(
        "An active owned daemon/workflow is running; stop it before setup or startup",
      );
  }
}
export function ownHome(home: string, store: Store) {
  assertHomeAvailable(home);
  const path = join(home, "operator-owner.json");
  const processIdentity = identify(process.pid);
  if (!processIdentity) throw new Error("Cannot identify workflow owner");
  const owner: Owner = { process: processIdentity, token: randomUUID() };
  // SQLite serializes simultaneous claims, including recovery of an orphaned file marker.
  store.claimOperatorOwner(owner);
  try {
    writeFileSync(path, JSON.stringify(owner), { mode: 0o600 });
  } catch (error) {
    store.releaseOperatorOwner(owner.token);
    throw error;
  }
  return () => {
    if (existsSync(path) && readOwner(path).token === owner.token)
      unlinkSync(path);
    store.releaseOperatorOwner(owner.token);
  };
}
