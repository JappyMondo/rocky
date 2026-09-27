import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { ROOT, sha, json } from "./runtime.mjs";
import { verifyComplement, originalSource } from "./source-provenance.mjs";
import { toolchainIdentity } from "./toolchain-identity.mjs";

export const HISTORICAL_PREPARATIONS = {
  member: "evaluator-sanity-member-2026-09-27T19-06-23-331Z",
  fresh_2fa: "evaluator-sanity-fresh-2fa-2026-09-27T20-08-01-699Z",
  shelly: "evaluator-sanity-shelly-2026-09-27T19-26-30-590Z",
};
const changedRuntimeFiles = [
  "dist/attraccess/environment.d.ts",
  "dist/attraccess/environment.js",
  "dist/attraccess/policy.d.ts",
  "dist/attraccess/policy.js",
  "dist/attraccess/source.d.ts",
  "dist/attraccess/source.js",
];
export function verifyRuntimeComplement(before, after) {
  if (
    JSON.stringify(Object.keys(before).sort()) !==
    JSON.stringify(Object.keys(after).sort())
  )
    throw Error("preparation-reuse-runtime-path-drift");
  const changed = Object.keys(before)
    .filter((p) => before[p] !== after[p])
    .sort();
  if (JSON.stringify(changed) !== JSON.stringify(changedRuntimeFiles))
    throw Error("preparation-reuse-unrelated-runtime-change");
  return changed;
}
export function preparationReuse(rt) {
  const path = join(
      ROOT,
      ".qualification/attraccess/handoff-2ff6cab/proposed-inputs.json",
    ),
    digest = sha(readFileSync(path));
  if (
    digest !==
    "9f4b3ce3e6492f560fabfa164717821f275fcae1b60d118d6193c97ff0950f85"
  )
    throw Error("historical-input-drift");
  const old = json(path),
    current = rt.inputs,
    same = (a, b, name) => {
      if (rt.api.canonical(a) !== rt.api.canonical(b))
        throw Error("preparation-reuse-drift:" + name);
    };
  const integrity = rt.api.runtimeIntegrity(old.packageRoot);
  for (const [key, observed] of Object.entries({
    rockyBuildId: integrity.buildId,
    installedBuildInventorySha256: integrity.installedBuildInventorySha256,
    runtimeDependenciesSha256: integrity.runtimeDependenciesSha256,
    driverTreeSha256: integrity.driverTreeSha256,
    runtimePackageSha256: integrity.packageSha256,
  }))
    same(old[key], observed, "historical-" + key);
  for (const key of [
    "runtimeDependenciesSha256",
    "driverTreeSha256",
    "runtimePackageSha256",
    "limits",
    "commands",
    "browser",
  ])
    same(old[key], current[key], key);
  same(old.shelly.sha256, current.shelly.sha256, "zip");
  same(old.shelly.members, current.shelly.members, "zip-members");
  same(
    old.prepared.mailpitImage,
    current.prepared.mailpitImage,
    "mailpit-image",
  );
  same(
    toolchainIdentity(old.toolchain.stdout),
    toolchainIdentity(current.toolchain.stdout, {
      files: Object.keys(current.prepared.sourceInventory).length,
      commit: current.targetCommit,
      tree: current.targetTree,
    }),
    "toolchain",
  );
  const provenance = originalSource(rt);
  same(
    old.targetCommit,
    provenance.original.commit,
    "historical-original-commit",
  );
  same(
    old.sourceInventorySha256,
    provenance.original.inventorySha256,
    "historical-original-inventory",
  );
  verifyComplement(
    old.prepared.sourceInventory,
    current.prepared.sourceInventory,
    provenance.changedFiles[0],
  );
  const oldBuild = json(join(old.packageRoot, "dist/build-identity.json")),
    newBuild = json(join(current.packageRoot, "dist/build-identity.json"));
  const changed = verifyRuntimeComplement(oldBuild.files, newBuild.files);
  // Independently verify that the installed environment delta is confined to the
  // source verifier, and the policy delta to TARGET. The fresh current wizard
  // exercises these changed source guards, bootstrap and actual image.
  const outsideVerifier = (root) => {
    const s = readFileSync(
        join(root, "dist/attraccess/environment.js"),
        "utf8",
      ),
      a = s.indexOf("    async verifySource("),
      b = s.indexOf("    async runScenario(", a);
    if (a < 0 || b < a) throw Error("preparation-reuse-verifier-boundary");
    return s.slice(0, a) + s.slice(b);
  };
  same(
    outsideVerifier(old.packageRoot),
    outsideVerifier(current.packageRoot),
    "environment-outside-source-verifier",
  );
  const policy = (root) =>
    readFileSync(join(root, "dist/attraccess/policy.js"), "utf8").split(
      "export const LIMITS =",
    );
  const beforePolicy = policy(old.packageRoot),
    afterPolicy = policy(current.packageRoot);
  if (beforePolicy.length !== 2 || afterPolicy.length !== 2)
    throw Error("preparation-reuse-policy-boundary");
  same(beforePolicy[1], afterPolicy[1], "limits-commands-generated-checkplan");
  const oldContract = JSON.parse(
      execFileSync(
        "git",
        ["show", old.sourceCommit + ":acceptance/environment/manifest.json"],
        { cwd: ROOT, encoding: "utf8" },
      ),
    ),
    contract = json(join(ROOT, "acceptance/environment/manifest.json"));
  const behaviorKeys = [
    "admission_binding",
    "policy",
    "recipe",
    "fixtures",
    "selectors_and_endpoints",
    "cycles",
    "assertions",
    "adversarial",
    "adapter_binding",
    "check_policy",
  ];
  for (const key of behaviorKeys)
    same(oldContract[key], contract[key], "protected-behavior-" + key);
  return {
    scope:
      "historical unscored preparation reuse only; not current-build execution or scored qualification",
    qualificationCredit: false,
    historicalInputs: { path, sha256: digest },
    originalBuildId: old.rockyBuildId,
    originalTargetCommit: old.targetCommit,
    originalContractSha256: old.contractSha256,
    currentBuildId: current.rockyBuildId,
    currentTargetCommit: current.targetCommit,
    provenance,
    unchangedRuntimeFiles: Object.keys(oldBuild.files).length - changed.length,
    changedRuntimeFiles: Object.fromEntries(
      changed.map((p) => [
        p,
        { before: oldBuild.files[p], after: newBuild.files[p] },
      ]),
    ),
    reviewedChangeScope:
      "TARGET identity/provenance and source verification only; environment implementation outside verifySource, policy after TARGET, dependencies, driver, browser, frozen ZIP, toolchain and 3,467 target files match exactly",
    currentImageValidation:
      "Required full current-fixture wizard independently checks the new image, source inventory, toolchain, isolation, setup and lifecycle",
    oldImage: old.prepared.devImage,
    currentImage: current.prepared.devImage,
    behaviorKeys,
    originalScenarioPolicy:
      "Each selected outcome retains its actual loaded script hashes; subsequent evaluator repairs are separate supporting evidence, never retroactively executed",
  };
}
