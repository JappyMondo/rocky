import { execFileSync } from "node:child_process";
import type { ProcessIdentity } from "../store/index.js";
export function identify(pid: number): ProcessIdentity | null {
  if (!Number.isSafeInteger(pid) || pid < 2) return null;
  try {
    const fingerprint = execFileSync(
      "/bin/ps",
      ["-p", String(pid), "-o", "lstart=", "-o", "command="],
      { encoding: "utf8", timeout: 1000 },
    ).trim();
    return fingerprint ? { pid, fingerprint } : null;
  } catch {
    return null;
  }
}
export function matches(value: ProcessIdentity): boolean {
  return identify(value.pid)?.fingerprint === value.fingerprint;
}
export function signalGroup(value: ProcessIdentity, signal: NodeJS.Signals) {
  if (!matches(value)) throw new Error("process-identity-uncertain");
  process.kill(-value.pid, signal);
}
export const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
