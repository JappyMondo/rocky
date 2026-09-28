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

/** Query only the owned group. Never interpret permission, timeout or parser failure as absence. */
export function groupAbsent(group: ProcessIdentity): boolean {
  if (process.platform === "darwin") {
    // Darwin kill(-pgid, 0) may return EPERM for an absent group. Its documented ps -g
    // selection uses process group leaders. Only a complete empty selection proves absence.
    try {
      const output = execFileSync(
        "/bin/ps",
        ["-g", String(group.pid), "-o", "pid=", "-o", "pgid="],
        { encoding: "utf8", timeout: 1000, stdio: ["ignore", "pipe", "pipe"] },
      );
      const rows = output.trim().split("\n");
      if (
        !output.trim() ||
        rows.some(
          (row) =>
            !/^\s*\d+\s+\d+\s*$/.test(row) ||
            Number(row.trim().split(/\s+/)[1]) !== group.pid,
        )
      )
        throw new Error("process-group-observation-uncertain");
      return false;
    } catch (error) {
      const e = error as {
        status?: number;
        signal?: string;
        stdout?: string;
        stderr?: string;
      };
      if (e.status === 1 && !e.signal && e.stdout === "" && e.stderr === "")
        return true;
      throw new Error("process-group-observation-uncertain");
    }
  }
  try {
    process.kill(-group.pid, 0);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    throw new Error("process-group-observation-uncertain");
  }
}
