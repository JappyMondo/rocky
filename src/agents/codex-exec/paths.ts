import { chmodSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Per-action runtime path layout (S01/S07; acceptance/subscription manifest launch.runtimePaths,
 * source #92/858 §A placeholders). RUN is a fresh per-action root (canonical realpath, 0700, and
 * PROJECTLESS: no .git in RUN or any ancestor, which together with the explicit untrusted override
 * prevents trust persistence into the shared CODEX_HOME — F5). SRC=RUN/stage/source (staged product
 * tree, no .git), SCR=RUN/scratch, PH=RUN/parent/home, PT=RUN/parent/tmp, NAT=RUN/native (private
 * sqlite/log), INP=RUN/inputs (0400 files), LOGS=RUN/parent/logs (Rocky-owned capture, never
 * granted). Paths are absolute, NFC, contain no control chars, glob metachars or ','. Grants are
 * pairwise non-overlapping, none inside the shared CODEX_HOME, and CODEX_HOME is not inside any
 * grant. The shared CODEX_HOME is auth state, NOT sterile; the private runtime HOME/TMP/logs are.
 */
export interface CodexRunPaths {
  runRoot: string;
  src: string;
  scratch: string;
  parentHome: string;
  parentTmp: string;
  native: string;
  nativeSqlite: string;
  nativeLog: string;
  inputs: string;
  logs: string;
}
export function assertCodexRuntimePath(value: unknown, name: string): string {
  if (typeof value !== "string" || !value)
    throw new Error(`codex-path-required:${name}`);
  const path = value;
  if (
    !path.startsWith("/") ||
    path.includes("\0") ||
    path.includes(",") ||
    /[*?[\]{}]/.test(path) ||
    /[\u0000-\u001f\u007f]/.test(path) ||
    path.normalize("NFC") !== path
  )
    throw new Error(`codex-path-invalid:${name}`);
  return path;
}
function isBelow(child: string, parent: string): boolean {
  return (
    child === parent ||
    child.startsWith(parent.endsWith("/") ? parent : `${parent}/`)
  );
}
export function validateCodexRunLayout(
  paths: CodexRunPaths,
  bindings: { codexHome: string; denyRoots: readonly string[] },
) {
  for (const [name, value] of Object.entries(paths))
    if (realpathSync(value) !== value)
      throw new Error(`codex-path-not-canonical:${name}`);
  const grants: [string, string][] = [
    ["src", paths.src],
    ["scratch", paths.scratch],
    ["parentHome", paths.parentHome],
    ["parentTmp", paths.parentTmp],
    ["native", paths.native],
    ["inputs", paths.inputs],
    ["logs", paths.logs],
  ];
  for (const [name, grant] of grants) {
    if (!isBelow(grant, paths.runRoot))
      throw new Error(`codex-path-outside-run:${name}`);
    if (
      isBelow(grant, bindings.codexHome) ||
      isBelow(bindings.codexHome, grant)
    )
      throw new Error(`codex-path-codex-home-overlap:${name}`);
    for (const root of bindings.denyRoots)
      if (isBelow(grant, root) || isBelow(root, grant))
        throw new Error(`codex-path-deny-overlap:${name}`);
  }
  for (let i = 0; i < grants.length; i++)
    for (let j = i + 1; j < grants.length; j++) {
      const [, a] = grants[i]!;
      const [, b] = grants[j]!;
      if (isBelow(a, b) || isBelow(b, a))
        throw new Error("codex-path-grant-overlap");
    }
  // Native sqlite/log are nested inside NAT by design; they are not independent grants.
  if (!isBelow(paths.nativeSqlite, paths.native))
    throw new Error("codex-path-native-sqlite");
  if (!isBelow(paths.nativeLog, paths.native))
    throw new Error("codex-path-native-log");
}
/** Create (or idempotently re-verify) the fresh per-action RUN tree. An existing root is only
 * admitted when it still matches the exact owned layout; anything else refuses. */
export function createCodexRunTree(runRoot: string): CodexRunPaths {
  assertCodexRuntimePath(runRoot, "runRoot");
  const root = resolve(runRoot);
  const paths: CodexRunPaths = {
    runRoot: root,
    src: join(root, "stage/source"),
    scratch: join(root, "scratch"),
    parentHome: join(root, "parent/home"),
    parentTmp: join(root, "parent/tmp"),
    native: join(root, "native"),
    nativeSqlite: join(root, "native/sqlite"),
    nativeLog: join(root, "native/log"),
    inputs: join(root, "inputs"),
    logs: join(root, "parent/logs"),
  };
  if (!existsSync(paths.runRoot)) {
    mkdirSync(paths.runRoot, { recursive: false, mode: 0o700 });
    chmodSync(paths.runRoot, 0o700);
    for (const dir of [
      "stage",
      "stage/source",
      "scratch",
      "scratch/home",
      "scratch/tmp",
      "parent",
      "parent/home",
      "parent/tmp",
      "parent/logs",
      "native",
      "native/sqlite",
      "native/log",
      "inputs",
    ])
      mkdirSync(join(paths.runRoot, dir), { recursive: false, mode: 0o700 });
    chmodSync(paths.inputs, 0o700);
  } else {
    for (const value of Object.values(paths))
      if (!existsSync(value)) throw new Error("codex-run-root-corrupt");
  }
  return paths;
}
