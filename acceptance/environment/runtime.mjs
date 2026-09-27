import { readFileSync, realpathSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { createHash } from "node:crypto";

export const ROOT = "/Users/jappy/.t3/worktrees/rocky/rocky-next";
export const INPUTS = join(
  ROOT,
  ".qualification/attraccess/handoff-d413790/proposed-inputs.json",
);
export const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const json = (path) => JSON.parse(readFileSync(path, "utf8"));
export function workspace() {
  if (
    realpathSync(process.cwd()) !== ROOT ||
    execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
    }).trim() !== ROOT ||
    execFileSync("git", ["branch", "--show-current"], {
      encoding: "utf8",
    }).trim() !== "rocky-next"
  )
    throw Error("wrong-evaluator-workspace");
}
export function writePrivate(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
}
export async function runtime() {
  workspace();
  if (
    sha(readFileSync(INPUTS)) !==
    "f48d64a8c9ef2fef93044c7dea3e9413807cfe14e1def72288cd27884a7deec4"
  )
    throw Error("producer-input-drift");
  const inputs = json(INPUTS);
  const api = await import(
    pathToFileURL(join(inputs.packageRoot, "dist/index.js"))
  );
  const internal = await import(
    pathToFileURL(join(inputs.packageRoot, "dist/attraccess/resources.js"))
  );
  const processIdentity = await import(
    pathToFileURL(join(inputs.packageRoot, "dist/runner/process.js"))
  );
  verifyRuntime({ inputs, api });
  return { inputs, api, internal, processIdentity };
}
export function verifyProtected() {
  for (const p of [
    "acceptance/environment/manifest.json",
    "acceptance/environment/README.md",
    "acceptance/environment/SHA256SUMS",
    "acceptance/contracts/requirements.json",
    "acceptance/contracts/foundation-scenarios.json",
    "acceptance/contracts/README.md",
    "acceptance/contracts/SHA256SUMS",
  ])
    if (
      sha(readFileSync(join(ROOT, p))) !==
      sha(
        execFileSync(
          "git",
          ["show", "60f1e2e326e4379acf090f833ca64d3861349340:" + p],
          { cwd: ROOT },
        ),
      )
    )
      throw Error("protected-contract-drift:" + p);
}
export function verifyRuntime({ inputs, api }) {
  verifyProtected();
  if (
    sha(readFileSync(inputs.prepared.browserExecutable)) !==
      inputs.browser.sha256 ||
    sha(readFileSync(inputs.prepared.shellyZip)) !== inputs.shelly.sha256
  )
    throw Error("prepared-browser-or-zip-drift");
  const build = json(join(inputs.packageRoot, "dist/build-identity.json"));
  if (
    build.sourceDirty ||
    build.sourceCommit !== inputs.sourceCommit ||
    build.buildId !== inputs.rockyBuildId ||
    api.adapterIdentity() !== inputs.adapterSha256 ||
    api.TARGET.commit !== inputs.targetCommit ||
    api.TARGET.tree !== inputs.targetTree ||
    sha(api.canonical(inputs.prepared.sourceInventory)) !==
      inputs.sourceInventorySha256
  )
    throw Error("installed-source-build-or-target-drift");
  const integrity = api.runtimeIntegrity();
  for (const [field, actual] of Object.entries({
    installedBuildInventorySha256: integrity.installedBuildInventorySha256,
    runtimeDependenciesSha256: integrity.runtimeDependenciesSha256,
    driverTreeSha256: integrity.driverTreeSha256,
    runtimePackageSha256: integrity.packageSha256,
  }))
    if (inputs[field] !== actual)
      throw Error("installed-runtime-drift:" + field);
  return integrity;
}
export function attemptRoot(prefix) {
  workspace();
  const id =
    prefix + "-" + new Date().toISOString().replace(/[^a-zA-Z0-9-]/g, "-");
  const root = join(ROOT, ".qualification/attraccess", id);
  mkdirSync(root, { mode: 0o700 });
  return { id, root };
}
