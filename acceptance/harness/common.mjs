import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  lstatSync,
  openSync,
  closeSync,
  fsyncSync,
} from "node:fs";
import { resolve, join } from "node:path";

export const ROOT = "/Users/jappy/.t3/worktrees/rocky/rocky-next";
export const EVIDENCE = join(ROOT, ".qualification/harness-contract-59");
export const REPAIR_EVIDENCE = join(
  ROOT,
  ".qualification/harness-contract-59-repair",
);
export const BINARY = "/opt/homebrew/Caskroom/codex/0.157.1/bin/codex";
export const BINARY_SHA =
  "27ceb5f9b957b43a519efe4eaa3816a0bffb0a531a2c89af18840c0a3c016a7d";
export const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const fileSha = (path) => sha(readFileSync(path));
export function guard() {
  const git = (...args) =>
    execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
  if (
    resolve(process.cwd()) !== ROOT ||
    git("rev-parse", "--show-toplevel") !== ROOT ||
    git("branch", "--show-current") !== "rocky-next"
  )
    throw Error("wrong-root-or-branch");
  return git("rev-parse", "HEAD");
}
export function save(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function inventory(root) {
  const result = [];
  function walk(path, relative) {
    for (const name of readdirSync(path).sort()) {
      const abs = join(path, name),
        rel = relative ? `${relative}/${name}` : name,
        st = lstatSync(abs);
      if (st.isSymbolicLink()) throw Error(`inventory-symlink:${rel}`);
      if (st.isDirectory()) walk(abs, rel);
      else if (st.isFile())
        result.push({ path: rel, bytes: st.size, sha256: fileSha(abs) });
      else throw Error(`inventory-special:${rel}`);
    }
  }
  walk(root, "");
  return result;
}
export function processes() {
  return execFileSync("/bin/ps", ["-axo", "pid=,ppid=,pgid=,lstart=,comm="], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .map((line) => {
      const m = line
        .trim()
        .match(
          /^(\d+)\s+(\d+)\s+(\d+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(.+)$/,
        );
      return m
        ? { pid: +m[1], ppid: +m[2], pgid: +m[3], start: m[4], command: m[5] }
        : null;
    })
    .filter(Boolean);
}
