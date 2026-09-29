import { chmodSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Per-action runtime path layout (CC12; acceptance/claude-code manifest launch.runtimePaths,
 * source #94/878 Placeholders): RUN is a fresh per-action root (canonical realpath, 0700, no
 * .git/CLAUDE*.md/AGENTS.md/.claude in RUN or any ancestor); SRC=RUN/stage/source,
 * SCR=RUN/scratch, PH=RUN/parent/home, PT=RUN/parent/tmp, INP=RUN/inputs (0400 files),
 * LOGS=RUN/parent/logs (Rocky-owned capture, never granted). Paths are absolute, NFC, contain no
 * control chars, glob metachars or ','. Grants are pairwise non-overlapping, none inside the
 * dedicated config dir, and the config dir is not inside any grant.
 */
export interface ClaudeRunPaths {
  runRoot: string;
  src: string;
  scratch: string;
  parentHome: string;
  parentTmp: string;
  inputs: string;
  logs: string;
}
export function assertClaudeRuntimePath(value: unknown, name: string): string {
  if (typeof value !== "string" || !value)
    throw new Error(`claude-path-required:${name}`);
  const path = value;
  if (
    !path.startsWith("/") ||
    path.includes("\0") ||
    path.includes(",") ||
    /[*?[\]{}]/.test(path) ||
    /[\u0000-\u001f\u007f]/.test(path) ||
    path.normalize("NFC") !== path
  )
    throw new Error(`claude-path-invalid:${name}`);
  return path;
}
function isBelow(child: string, parent: string): boolean {
  return (
    child === parent ||
    child.startsWith(parent.endsWith("/") ? parent : `${parent}/`)
  );
}
export function validateClaudeRunLayout(
  paths: ClaudeRunPaths,
  bindings: { configDir: string; denyRoots: readonly string[] },
) {
  for (const [name, value] of Object.entries(paths))
    if (realpathSync(value) !== value)
      throw new Error(`claude-path-not-canonical:${name}`);
  const grants: [string, string][] = [
    ["src", paths.src],
    ["scratch", paths.scratch],
    ["parentHome", paths.parentHome],
    ["parentTmp", paths.parentTmp],
    ["inputs", paths.inputs],
    ["logs", paths.logs],
  ];
  for (const [name, grant] of grants) {
    if (!isBelow(grant, paths.runRoot))
      throw new Error(`claude-path-outside-run:${name}`);
    if (
      isBelow(grant, bindings.configDir) ||
      isBelow(bindings.configDir, grant)
    )
      throw new Error(`claude-path-config-overlap:${name}`);
    for (const root of bindings.denyRoots)
      if (isBelow(grant, root) || isBelow(root, grant))
        throw new Error(`claude-path-deny-overlap:${name}`);
  }
  for (let i = 0; i < grants.length; i++)
    for (let j = i + 1; j < grants.length; j++) {
      const [, a] = grants[i]!;
      const [, b] = grants[j]!;
      if (isBelow(a, b) || isBelow(b, a))
        throw new Error("claude-path-grant-overlap");
    }
}
/** Create (or idempotently re-verify) the fresh per-action RUN tree. An existing root is only
 * admitted when it still matches the exact owned layout; anything else refuses. */
export function createClaudeRunTree(runRoot: string): ClaudeRunPaths {
  assertClaudeRuntimePath(runRoot, "runRoot");
  const paths: ClaudeRunPaths = {
    runRoot: resolve(runRoot),
    src: join(resolve(runRoot), "stage/source"),
    scratch: join(resolve(runRoot), "scratch"),
    parentHome: join(resolve(runRoot), "parent/home"),
    parentTmp: join(resolve(runRoot), "parent/tmp"),
    inputs: join(resolve(runRoot), "inputs"),
    logs: join(resolve(runRoot), "parent/logs"),
  };
  if (!existsSync(paths.runRoot)) {
    mkdirSync(paths.runRoot, { recursive: false, mode: 0o700 });
    chmodSync(paths.runRoot, 0o700);
    for (const dir of [
      "stage",
      "stage/source",
      "scratch",
      "parent",
      "parent/home",
      "parent/tmp",
      "parent/logs",
      "inputs",
    ])
      mkdirSync(join(paths.runRoot, dir), { recursive: false, mode: 0o700 });
    chmodSync(paths.inputs, 0o700);
  } else {
    for (const value of Object.values(paths))
      if (!existsSync(value)) throw new Error("claude-run-root-corrupt");
  }
  return paths;
}
