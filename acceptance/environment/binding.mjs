import {
  readFileSync,
  readdirSync,
  statSync,
  chmodSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ROOT,
  INPUTS,
  runtime,
  verifyRuntime,
  workspace,
  sha,
  json,
  writePrivate,
  attemptRoot,
} from "./runtime.mjs";
import { evaluatorFiles, concrete, verifyFiles } from "./identity.mjs";
import {
  completePreparations,
  retainedEvidence,
} from "./admission-evidence.mjs";
import { admissionSnapshot } from "./admission-ledger.mjs";
import { originalSource } from "./fixtures.mjs";

const git = (args) =>
  execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
const file = (path) => ({ path, sha256: sha(readFileSync(path)) });
export function preparationLedger() {
  const base = join(ROOT, ".qualification/attraccess");
  const producer = file(join(base, "handoff-2ff6cab/preparation-ledger.json"));
  const evaluator = readdirSync(base)
    .filter((n) => /^evaluator-(discovery|sanity)-/.test(n))
    .sort()
    .map((id) => {
      const root = join(base, id),
        outcome = join(root, "outcome.json");
      if (!existsSync(outcome)) throw Error("unfinished-preparation:" + id);
      const raw = json(outcome),
        corrections = readdirSync(root)
          .filter((n) => n.startsWith("assessment-correction-"))
          .sort()
          .map((n) => file(join(root, n)));
      return {
        id,
        rawStatus: raw.status,
        outcome: file(outcome),
        corrections,
        assessment: corrections.length
          ? "evidence_missing"
          : id.includes("17-13-04-170Z")
            ? "invalid-mixed-helper-version"
            : raw.status,
        scope: "unscored",
        qualificationCredit: false,
      };
    });
  return {
    producer,
    evaluator,
    admissionAttempts: admissionSnapshot(),
    scoredCycles: 0,
    scoredFaults: 0,
  };
}
export function verifyProposal(rt, path) {
  workspace();
  const a = json(path);
  concrete(a);
  if (
    a.scope !== "independent-environment-admission-proposal" ||
    a.qualificationAuthorized !== false
  )
    throw Error("invalid-unapproved-proposal-scope");
  if ((statSync(path).mode & 0o222) !== 0)
    throw Error("admission-must-be-readonly");
  if (
    git(["status", "--porcelain"]) !== "" ||
    git(["rev-parse", "HEAD"]) !== a.evaluator.commit
  )
    throw Error("evaluator-commit-or-worktree-drift");
  if (
    rt.api.canonical(evaluatorFiles()) !== rt.api.canonical(a.evaluator.files)
  )
    throw Error("evaluator-inventory-drift");
  verifyFiles(a.runtimeHelperFiles);
  verifyFiles(a.protectedFiles);
  verifyFiles(a.preparationEvidenceFiles);
  if (
    sha(readFileSync(process.execPath)) !== a.evaluator.hostNode.sha256 ||
    process.version !== a.evaluator.hostNode.version
  )
    throw Error("evaluator-host-node-drift");
  originalSource(rt);
  verifyRuntime(rt);
  verifyFiles(a.retainedEvidenceFiles);
  verifyFiles({ [a.evaluatorValidation.path]: a.evaluatorValidation.sha256 });
  const validation = json(a.evaluatorValidation.path);
  verifyFiles({
    [validation.stoppedState.path]: validation.stoppedState.sha256,
  });
  if (
    rt.api.canonical(validation.files) !==
      rt.api.canonical(a.evaluator.files) ||
    !validation.commands.length ||
    validation.commands.some((c) => c.exitCode !== 0)
  )
    throw Error("evaluator-validation-incomplete-or-stale");
  verifyFiles(
    Object.fromEntries(
      validation.commands.map((c) => [c.log.path, c.log.sha256]),
    ),
  );
  const expected = {
    devImage: rt.inputs.prepared.devImage,
    mailpitImage: rt.inputs.prepared.mailpitImage,
    browserExecutableSha256: rt.inputs.browser.sha256,
    shellyZipSha256: rt.inputs.shelly.sha256,
    sourceInventorySha256: rt.inputs.sourceInventorySha256,
    driverVersion: rt.inputs.browser.driver.split("@").at(-1),
    driverPackageSha256: rt.inputs.browser.driverPackageSha256,
    nodeVersion: rt.api.TARGET.node,
    pnpmVersion: rt.api.TARGET.pnpm,
    contractSha256: rt.inputs.contractSha256,
    targetCommit: rt.inputs.targetCommit,
    targetTree: rt.inputs.targetTree,
    rockyBuildId: rt.inputs.rockyBuildId,
    adapterSha256: rt.api.adapterIdentity(),
    checkPlanSha256: rt.inputs.checkPlanSha256,
    installedBuildInventorySha256: rt.inputs.installedBuildInventorySha256,
    runtimeDependenciesSha256: rt.inputs.runtimeDependenciesSha256,
    driverTreeSha256: rt.inputs.driverTreeSha256,
    runtimePackageSha256: rt.inputs.runtimePackageSha256,
  };
  for (const [key, value] of Object.entries(expected))
    if (a[key] !== value) throw Error("proposal-identity-drift:" + key);
  if (
    rt.api.canonical(a.limits) !== rt.api.canonical(rt.api.LIMITS) ||
    rt.api.canonical(a.commands) !== rt.api.canonical(rt.api.COMMANDS)
  )
    throw Error("proposal-policy-drift");
  if (sha(rt.api.canonical(a.checkPlan)) !== a.checkPlanSha256)
    throw Error("proposal-check-plan-drift");
  if (
    a.scenarioSha256 !== sha(rt.api.canonical(a.scenarioFiles)) ||
    a.fixtureSha256 !== sha(rt.api.canonical(a.fixtureFiles))
  )
    throw Error("proposal-file-inventory-drift");
  verifyFiles(a.scenarioFiles);
  verifyFiles(a.fixtureFiles);
  return {
    admission: a,
    sha256: sha(readFileSync(path)),
    qualificationAuthorized: false,
  };
}
export function verifyBinding(rt, path, approval) {
  verifyProposal(rt, path);
  if (
    /environment[_-]evaluator|foundation|restart[_-]repair/.test(
      approval.reviewer ?? "",
    )
  )
    throw Error("author-cannot-approve-own-binding");
  return rt.api.validateAdmission(path, approval, rt.inputs.prepared);
}
export async function buildProposal(validationPath) {
  const rt = await runtime();
  originalSource(rt);
  if (git(["status", "--porcelain"]) !== "")
    throw Error("commit-clean-evaluator-before-binding");
  const changedProduction = git([
    "diff",
    "--name-only",
    rt.inputs.sourceCommit,
    "HEAD",
  ])
    .split("\n")
    .filter(Boolean)
    .filter((p) => !p.startsWith("acceptance/environment/"));
  if (changedProduction.length)
    throw Error("installed-production-source-drift");
  if (!validationPath) throw Error("final-validation-receipt-required");
  const validation = json(validationPath);
  verifyFiles({
    [validation.stoppedState.path]: validation.stoppedState.sha256,
  });
  if (
    rt.api.canonical(validation.files) !== rt.api.canonical(evaluatorFiles()) ||
    !validation.commands.length ||
    validation.commands.some((c) => c.exitCode !== 0)
  )
    throw Error("stale-or-failed-final-validation");
  verifyFiles(
    Object.fromEntries(
      validation.commands.map((c) => [c.log.path, c.log.sha256]),
    ),
  );
  const all = evaluatorFiles(),
    fixtureFiles = Object.fromEntries(
      Object.entries(all).filter(([p]) =>
        /\/(fixtures|flows|assertions|runtime)\.mjs$|\/selectors\.json$/.test(
          p,
        ),
      ),
    );
  const require = createRequire(join(rt.inputs.packageRoot, "package.json")),
    driverPath = require.resolve("playwright/package.json");
  const protectedFiles = Object.fromEntries(
    [
      "acceptance/environment/manifest.json",
      "acceptance/environment/README.md",
      "acceptance/environment/SHA256SUMS",
      "acceptance/contracts/requirements.json",
      "acceptance/contracts/foundation-scenarios.json",
      "acceptance/contracts/README.md",
      "acceptance/contracts/SHA256SUMS",
    ]
      .filter((p) => existsSync(join(ROOT, p)))
      .map((p) => [join(ROOT, p), sha(readFileSync(join(ROOT, p)))]),
  );
  const runtimeHelperFiles = Object.fromEntries(
    [
      "dist/attraccess/resources.js",
      "dist/runner/process.js",
      "dist/runner/browser.js",
      "dist/attraccess/guardian.js",
      "dist/attraccess/admission.js",
    ].map((p) => [
      join(rt.inputs.packageRoot, p),
      sha(readFileSync(join(rt.inputs.packageRoot, p))),
    ]),
  );
  const ledger = preparationLedger(),
    base = rt.api.TARGET.root;
  const preparationCoverage = completePreparations(rt, ledger);
  const retainedEvidenceFiles = retainedEvidence(ledger);
  const evidence = [
    validationPath,
    validation.stoppedState.path,
    ...validation.commands.map((c) => c.log.path),
    INPUTS,
    join(base, "handoff-2ff6cab/HANDOFF.md"),
    join(base, "handoff-2ff6cab/retained-files.json"),
    join(base, "handoff-2ff6cab/dependency-inventory.json"),
    join(base, "handoff-2ff6cab/checks.json"),
    join(base, "handoff-2ff6cab/runtime-integrity.json"),
    join(base, "image-packaging-2026-09-27T15-22-30-613Z/Dockerfile"),
    join(
      base,
      "prepare-2026-09-27T15-08-12.826Z/context/Dockerfile.development",
    ),
    join(base, "image-verify-2026-09-27T16-55-00-689Z/prepared-images.json"),
    join(base, "runtime-prep-2026-09-27T16-55-28-612Z/plugin-prepared.json"),
    join(base, "runtime-prep-2026-09-27T16-55-28-612Z/browser-prepared.json"),
    ledger.producer.path,
    ...ledger.evaluator.flatMap((x) => [
      x.outcome.path,
      ...x.corrections.map((c) => c.path),
    ]),
  ];
  const preparationEvidenceFiles = Object.fromEntries(
    evidence.map((p) => [p, sha(readFileSync(p))]),
  );
  const integrity = verifyRuntime(rt),
    i = rt.inputs;
  const proposal = {
    schemaVersion: 1,
    scope: "independent-environment-admission-proposal",
    qualificationAuthorized: false,
    contractSha256: i.contractSha256,
    targetCommit: i.targetCommit,
    targetTree: i.targetTree,
    devImage: i.prepared.devImage,
    mailpitImage: i.prepared.mailpitImage,
    browserExecutableSha256: i.browser.sha256,
    shellyZipSha256: i.shelly.sha256,
    sourceInventorySha256: i.sourceInventorySha256,
    rockyBuildId: i.rockyBuildId,
    installedBuildInventorySha256: integrity.installedBuildInventorySha256,
    runtimeDependenciesSha256: integrity.runtimeDependenciesSha256,
    driverTreeSha256: integrity.driverTreeSha256,
    runtimePackageSha256: integrity.packageSha256,
    adapterSha256: rt.api.adapterIdentity(),
    scenarioFiles: all,
    scenarioSha256: sha(rt.api.canonical(all)),
    fixtureFiles,
    fixtureSha256: sha(rt.api.canonical(fixtureFiles)),
    driverVersion: json(driverPath).version,
    driverPackageSha256: sha(readFileSync(driverPath)),
    nodeVersion: rt.api.TARGET.node,
    pnpmVersion: rt.api.TARGET.pnpm,
    limits: rt.api.LIMITS,
    commands: rt.api.COMMANDS,
    checkPlan: rt.api.checkPlan(i.targetCommit, i.targetCommit),
    checkPlanSha256: i.checkPlanSha256,
    protectedFiles,
    runtimeHelperFiles,
    preparationEvidenceFiles,
    retainedEvidenceFiles,
    preparationCoverage,
    evaluatorValidation: file(validationPath),
    evidenceInventoryPolicy:
      "Retained evaluator evidence directories and referenced producer evidence descendants only; no dependency caches or whole provisioned snapshots. Separate exact target source inventory.",
    producerReview: {
      project: "rocky-next",
      implementationTicket: 36,
      reviewTicket: 37,
      standardsComment: 242,
      specComment: 243,
      reviewedSourceCommit: rt.inputs.sourceCommit,
    },
    contractApproval: {
      project: "rocky-next",
      ticket: 23,
      comment: 106,
      reviewer: "/root/environment_review",
      reviewedCommit: "a0f268a8ef0c772c24bb9d73515290a407d37e99",
      lastContractChange: "740bdd3f687b365c9ca743d7503c3a54a1fe3394",
    },
    evaluator: {
      author: "/root/environment_evaluator",
      selectedModel: "gpt-6-astra",
      toolAcceptedModel: "gpt-6-astra",
      reasoningEffort: "high",
      backendSelfAttestation: "not available",
      root: ROOT,
      branch: "rocky-next",
      commit: git(["rev-parse", "HEAD"]),
      files: all,
      hostNode: {
        path: realpathSync(process.execPath),
        version: process.version,
        sha256: sha(readFileSync(process.execPath)),
      },
    },
    installedRuntime: {
      sourceCommit: i.sourceCommit,
      packageRoot: i.packageRoot,
      tarballSha256: i.packageSha256,
      buildIdentity: file(join(i.packageRoot, "dist/build-identity.json")),
      driverPackage: file(driverPath),
      sourcePackageLock: {
        commit: i.sourceCommit,
        path: "package-lock.json",
        sha256: sha(
          execFileSync("git", ["show", i.sourceCommit + ":package-lock.json"], {
            cwd: ROOT,
          }),
        ),
      },
    },
    target: {
      root: rt.api.TARGET.source,
      sourceInventory: i.prepared.sourceInventory,
      sourceLock: file(join(rt.api.TARGET.source, "pnpm-lock.yaml")),
      generatedPaths: rt.api.GENERATED,
    },
    toolchain: i.toolchain,
    browser: i.browser,
    shelly: {
      ...i.shelly,
      path: i.prepared.shellyZip,
      archivePolicy:
        "exact frozen upload bytes; each cycle retains its own build archive digest separately",
    },
    checkPlanScope:
      "environment only; later coding CI obligations remain required",
    network: {
      runtime:
        "owned internal Docker network; loopback ingress only; app/Mailpit private",
      browserOrigins:
        "session frontend and API origins only, plus data/blob; service workers blocked",
      forbidden:
        "shared services, target writes, physical device traffic, discovery, external SMTP",
      bootstrap:
        "owned prepare network for pinned dependency bootstrap; disconnected before serve",
    },
    lifecycle: {
      ownership:
        "durable private owner labels and exact process fingerprints; atomic persisted browser ownership; fenced Store dispatch",
      concurrency: 1,
      retryLimit: 1,
      guardianRecoveryMs: 30000,
      guardianPolicy:
        "separate recovery receipt; never promotes failed normal teardown",
      faultStorage: { path: "/fault", tmpfsBytes: 65536 },
      secretPolicy:
        "raw traces, auth, TOTP, email and logs private; public screenshots source-backed QR region and secret control masks",
    },
    scenarios: json(join(ROOT, "acceptance/environment/manifest.json")).cycles,
    faults: json(join(ROOT, "acceptance/environment/manifest.json"))
      .adversarial,
    selectors: json(join(ROOT, "acceptance/environment/selectors.json")),
    preparationLedger: ledger,
    approvalReference: {
      project: "rocky-next",
      ticket: 28,
      artifact: "environment-approval.json",
      role: "independent-reviewer",
      requiredModel: "gpt-6-astra",
      requiredEffort: "high",
      bindingField: "admissionSha256",
      contractField: "contractSha256",
      policy:
        "Separate real independent approval must name this artifact byte hash. This proposal is not approval.",
    },
  };
  concrete(proposal);
  const { root } = attemptRoot("admission-proposal"),
    path = join(root, "environment-admission.json");
  writePrivate(path, proposal);
  chmodSync(path, 0o444);
  writePrivate(join(root, "proposal-receipt.json"), {
    path,
    sha256: sha(readFileSync(path)),
    qualificationAuthorized: false,
    createdAt: new Date().toISOString(),
    evaluatorCommit: proposal.evaluator.commit,
  });
  return {
    path,
    sha256: sha(readFileSync(path)),
    qualificationAuthorized: false,
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  console.log(JSON.stringify(await buildProposal(process.argv[2])));
