import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync, readSync, statSync } from "node:fs";
import type { ProcessIdentity } from "../store/index.js";
/** Host-measured pinned-binary identity. The hash is never taken from the tool's own --version. */
export interface BinaryIdentity {
  path: string;
  sha256: string;
  bytes: number;
}
/**
 * Re-measure a pinned binary at the guarded-start admission checkpoint (C1). A symlink, a missing
 * file, a non-regular file or any hash/size drift throws before spawn, so the profile becomes
 * unavailable and is never substituted. Reading is measurement only; the bytes are not retained.
 */
export function measureBinaryIdentity(path: string): BinaryIdentity {
  if (typeof path !== "string" || !path.startsWith("/"))
    throw new Error("binary-identity-missing");
  if (lstatSync(path).isSymbolicLink())
    throw new Error("binary-identity-drift");
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error("binary-identity-missing");
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(4 * 1024 * 1024);
  const fd = openSync(path, "r");
  try {
    let position = 0;
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.length, position);
      if (read === 0) break;
      hash.update(chunk.subarray(0, read));
      position += read;
    }
  } finally {
    closeSync(fd);
  }
  return { path, sha256: hash.digest("hex"), bytes: stat.size };
}
export function assertBinaryIdentity(pinned: BinaryIdentity): BinaryIdentity {
  let measured: BinaryIdentity;
  try {
    measured = measureBinaryIdentity(pinned.path);
  } catch (error) {
    throw new Error(
      (error as Error).message === "binary-identity-drift"
        ? "binary-identity-drift"
        : "binary-identity-missing",
    );
  }
  if (measured.sha256 !== pinned.sha256 || measured.bytes !== pinned.bytes)
    throw new Error("binary-identity-drift");
  return measured;
}
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
