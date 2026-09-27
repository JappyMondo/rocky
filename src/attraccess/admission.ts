import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { digest, canonical } from "../store/json.js";
import { TARGET, LIMITS, COMMANDS, checkPlan } from "./policy.js";
import { runtimeIntegrity } from "./integrity.js";
import type { PreparedEnvironment } from "./environment.js";
export interface AdmissionApproval {
  ticket: 28;
  reviewer: string;
  role: "independent-reviewer";
  admissionSha256: string;
  contractSha256: string;
  decision: "approved";
}
export interface EnvironmentAdmission {
  contractSha256: string;
  targetCommit: string;
  targetTree: string;
  devImage: string;
  mailpitImage: string;
  browserExecutableSha256: string;
  shellyZipSha256: string;
  sourceInventorySha256: string;
  rockyBuildId: string;
  installedBuildInventorySha256: string;
  runtimeDependenciesSha256: string;
  driverTreeSha256: string;
  runtimePackageSha256: string;
  adapterSha256: string;
  scenarioSha256: string;
  fixtureSha256: string;
  checkPlanSha256: string;
  scenarioFiles: Record<string, string>;
  fixtureFiles: Record<string, string>;
  driverVersion: string;
  driverPackageSha256: string;
  nodeVersion: string;
  pnpmVersion: string;
  limits: typeof LIMITS;
  commands: typeof COMMANDS;
}
export function adapterIdentity() {
  const paths = readdirSync(new URL(".", import.meta.url))
    .filter((p) => p.endsWith(".js"))
    .sort();
  const files = Object.fromEntries(
    paths.map((p) => [p, digest(readFileSync(new URL(p, import.meta.url)))]),
  );
  files["../runner/browser.js"] = digest(
    readFileSync(new URL("../runner/browser.js", import.meta.url)),
  );
  return digest(canonical(files));
}
export function validateAdmission(
  path: string,
  approval: AdmissionApproval,
  prepared: PreparedEnvironment,
) {
  const bytes = readFileSync(path);
  const hash = digest(bytes);
  const admission = JSON.parse(bytes.toString()) as EnvironmentAdmission;
  if (
    approval.ticket !== 28 ||
    approval.role !== "independent-reviewer" ||
    approval.decision !== "approved" ||
    !approval.reviewer ||
    approval.reviewer.includes("foundation") ||
    approval.admissionSha256 !== hash ||
    approval.contractSha256 !== TARGET.contract
  )
    throw new Error("independent-admission-approval-required");
  for (const [key, value] of Object.entries(admission))
    if (
      value === null ||
      value === undefined ||
      value === "" ||
      (typeof value === "string" &&
        /^(pending|unknown|unfrozen|placeholder)$/i.test(value))
    )
      throw new Error("missing-admission-identity:" + key);
  const required = [
    "contractSha256",
    "targetCommit",
    "targetTree",
    "devImage",
    "mailpitImage",
    "browserExecutableSha256",
    "shellyZipSha256",
    "sourceInventorySha256",
    "rockyBuildId",
    "installedBuildInventorySha256",
    "runtimeDependenciesSha256",
    "driverTreeSha256",
    "runtimePackageSha256",
    "adapterSha256",
    "scenarioSha256",
    "fixtureSha256",
    "checkPlanSha256",
    "scenarioFiles",
    "fixtureFiles",
    "driverVersion",
    "driverPackageSha256",
    "nodeVersion",
    "pnpmVersion",
    "limits",
    "commands",
  ];
  for (const key of required)
    if (!Object.hasOwn(admission, key))
      throw new Error("missing-admission-field:" + key);
  for (const [key, files] of [
    ["scenario", admission.scenarioFiles],
    ["fixture", admission.fixtureFiles],
  ] as const) {
    if (!files || Object.keys(files).length === 0)
      throw new Error("missing-admission-code-files:" + key);
    for (const [file, expected] of Object.entries(files))
      if (digest(readFileSync(file)) !== expected)
        throw new Error("admission-file-drift:" + file);
    if (
      digest(canonical(files)) !==
      (key === "scenario" ? admission.scenarioSha256 : admission.fixtureSha256)
    )
      throw new Error("admission-file-inventory-drift:" + key);
  }
  const driverBytes = readFileSync(
    createRequire(import.meta.url).resolve("playwright/package.json"),
  );
  if (
    admission.driverVersion !== JSON.parse(driverBytes.toString()).version ||
    admission.driverPackageSha256 !== digest(driverBytes) ||
    admission.nodeVersion !== TARGET.node ||
    admission.pnpmVersion !== TARGET.pnpm
  )
    throw new Error("admission-toolchain-drift");
  if (
    admission.contractSha256 !== TARGET.contract ||
    admission.targetCommit !== TARGET.commit ||
    admission.targetTree !== TARGET.tree ||
    admission.devImage !== prepared.devImage ||
    admission.mailpitImage !== prepared.mailpitImage ||
    admission.browserExecutableSha256 !==
      digest(readFileSync(prepared.browserExecutable)) ||
    admission.shellyZipSha256 !== digest(readFileSync(prepared.shellyZip)) ||
    admission.sourceInventorySha256 !==
      digest(canonical(prepared.sourceInventory)) ||
    canonical(admission.limits) !== canonical(LIMITS) ||
    canonical(admission.commands) !== canonical(COMMANDS)
  )
    throw new Error("admission-input-drift");
  if (
    admission.adapterSha256 !== adapterIdentity() ||
    admission.checkPlanSha256 !==
      digest(canonical(checkPlan(TARGET.commit, TARGET.commit)))
  )
    throw new Error("admission-code-drift");
  const runtime = runtimeIntegrity();
  if (
    admission.installedBuildInventorySha256 !==
      runtime.installedBuildInventorySha256 ||
    admission.runtimeDependenciesSha256 !== runtime.runtimeDependenciesSha256 ||
    admission.driverTreeSha256 !== runtime.driverTreeSha256 ||
    admission.runtimePackageSha256 !== runtime.packageSha256
  )
    throw new Error("admission-runtime-drift");
  const build = JSON.parse(
    readFileSync(new URL("../build-identity.json", import.meta.url), "utf8"),
  );
  if (build.sourceDirty || admission.rockyBuildId !== build.buildId)
    throw new Error("admission-build-drift");
  return { admission, sha256: hash, approval };
}
