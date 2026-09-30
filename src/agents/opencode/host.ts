import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { digest, identity, canonical, type Json } from "../../store/json.js";
import type { ExecutionQualification } from "../../coordinator/contracts.js";
import type { OpencodeConfig } from "./config.js";
import {
  OPENCODE_CONTRACT_ID,
  OPENCODE_PINNED_PROVIDER,
  opencodeAgentName,
} from "./config.js";
import { renderOpencodeConfigContent } from "./launch.js";
import { OPENCODE_TOOL_ROSTER } from "./stream.js";
import {
  verifyDependencyTemplate,
  type DependencyTemplate,
} from "./dependencies.js";

export interface HostArtifact {
  path: string;
  sha256: string;
  bytes: number;
}
export interface HostContext {
  repository: string;
  task: string | null;
  profile: string | null;
  checks: { name: string; file: string; args: string[] }[];
  requiredCI: string[];
  liveApproval: string;
  nativeProbeEvidence: string;
  authBoundaryApproval: string;
}
export interface HostAdmission {
  schema: 1;
  status: "first-live-observation-required";
  runtimeDigest: string;
  renderedConfigSha256: string;
  context: HostContext;
  authBoundary: { accepted: true; reference: string; evidence: HostArtifact };
  nativeEvidence: HostArtifact[];
  rosterEvidence: HostArtifact;
  dependencies: DependencyTemplate;
  binding: string;
}
export function runtimeDescriptor(
  config:
    | OpencodeConfig
    | Omit<OpencodeConfig, "qualification" | "hostAdmission">,
): Json {
  const {
    qualification: _q,
    hostAdmission: _h,
    ...rest
  } = config as OpencodeConfig;
  delete (rest as Record<string, unknown>).configDigest;
  return JSON.parse(canonical(rest)) as Json;
}
export function roleConfigContent(config: Pick<OpencodeConfig, "roles">) {
  return renderOpencodeConfigContent({
    implementer: { role: "implementer", ...config.roles.implementer },
    reviewer: { role: "reviewer", ...config.roles.reviewer },
  });
}
export function qualificationForManifest(
  manifest: HostAdmission,
): ExecutionQualification {
  const { binding: _b, ...payload } = manifest;
  const binding = identity(payload);
  if (binding !== manifest.binding)
    throw new Error("opencode-host-manifest-binding");
  return {
    schema: 1,
    id: "host-opencode-" + binding,
    harness: "opencode",
    contractId: OPENCODE_CONTRACT_ID,
    budgetMode: "subscription-observed-v1",
    binding,
  };
}
export function readHostArtifact(
  ref: HostArtifact,
  config: OpencodeConfig,
): Buffer {
  const privateRoot = join(dirname(config.dataHome), "qualification");
  if (
    !ref ||
    !ref.path?.startsWith(privateRoot + "/") ||
    !/^[a-f0-9]{64}$/.test(ref.sha256) ||
    !Number.isSafeInteger(ref.bytes) ||
    ref.bytes < 1 ||
    ref.bytes > 16 * 1024 * 1024
  )
    throw new Error("opencode-host-artifact-reference");
  const stat = lstatSync(ref.path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o7777) !== 0o600 ||
    realpathSync(ref.path) !== ref.path ||
    stat.size !== ref.bytes
  )
    throw new Error("opencode-host-artifact-metadata");
  const bytes = readFileSync(ref.path);
  if (digest(bytes) !== ref.sha256)
    throw new Error("opencode-host-artifact-drift");
  return bytes;
}
export function assertInstalledWorkerBuild(config: OpencodeConfig) {
  if (config.evidenceClass !== "live-subscription") return;
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const build = JSON.parse(
    readFileSync(join(root, "build-identity.json"), "utf8"),
  );
  const { buildId, ...payload } = build;
  // build.mjs deliberately hashes its insertion-ordered JSON payload.
  if (
    process.version !== "v24.16.0" ||
    build.node !== process.version ||
    build.sourceDirty !== false ||
    buildId !== digest(JSON.stringify(payload)) ||
    config.versions.build !== buildId
  )
    throw new Error("opencode-worker-build-unqualified");
  for (const [key, hash] of Object.entries(build.files)) {
    if (
      !key.startsWith("dist/") ||
      key.includes("..") ||
      digest(readFileSync(join(root, key.slice(5)))) !== hash
    )
      throw new Error("opencode-worker-build-drift");
  }
}
export function assertHostAdmission(
  config: OpencodeConfig,
  expectedContext?: HostContext,
) {
  const m = config.hostAdmission;
  if (!m || m.schema !== 1 || m.status !== "first-live-observation-required")
    throw new Error("opencode-host-manifest-required");
  if (
    m.runtimeDigest !== identity(runtimeDescriptor(config)) ||
    m.renderedConfigSha256 !== digest(roleConfigContent(config)) ||
    identity(config.qualification) !== identity(qualificationForManifest(m))
  )
    throw new Error("opencode-host-runtime-binding");
  if (expectedContext && identity(m.context) !== identity(expectedContext))
    throw new Error("opencode-host-authority-drift");
  for (const name of [
    "liveApproval",
    "nativeProbeEvidence",
    "authBoundaryApproval",
  ] as const)
    if (!m.context[name]?.trim())
      throw new Error("opencode-host-authority-reference");
  if (
    m.authBoundary.accepted !== true ||
    m.authBoundary.reference !== m.context.authBoundaryApproval
  )
    throw new Error("opencode-auth-boundary-undecided");
  const decision = JSON.parse(
    readHostArtifact(m.authBoundary.evidence, config).toString(),
  );
  if (
    decision.schema !== 1 ||
    decision.accepted !== true ||
    decision.reference !== m.authBoundary.reference ||
    decision.boundary !== "plain-0600-auth-file-bash-reachability"
  )
    throw new Error("opencode-auth-boundary-evidence");
  if (!m.nativeEvidence.length)
    throw new Error("opencode-native-evidence-missing");
  for (const ref of m.nativeEvidence) readHostArtifact(ref, config);
  if (
    !m.dependencies.root.startsWith(
      join(dirname(config.dataHome), "qualification") + "/",
    )
  )
    throw new Error("opencode-dependency-owned-root");
  verifyDependencyTemplate(m.dependencies);
  const roster = JSON.parse(
    readHostArtifact(m.rosterEvidence, config).toString(),
  );
  if (
    roster.schema !== 1 ||
    roster.evidenceClass !== "native-zero-turn" ||
    identity(roster.binary) !== identity(config.binary) ||
    roster.configContentSha256 !== m.renderedConfigSha256 ||
    roster.catalogSha256 !== config.modelsCatalog.sha256 ||
    roster.dependencyInventorySha256 !== m.dependencies.inventorySha256 ||
    roster.sealedRecipe !== "opencode-sealed-v1"
  )
    throw new Error("opencode-roster-evidence-binding");
  for (const role of ["implementer", "reviewer"] as const) {
    const probe = roster.roles?.[role];
    if (
      !probe ||
      identity(probe.argv) !==
        identity(["debug", "agent", opencodeAgentName(role)]) ||
      probe.exitCode !== 0 ||
      probe.quiescent !== true
    )
      throw new Error("opencode-roster-probe-lifecycle");
    const raw = JSON.parse(readHostArtifact(probe.raw, config).toString());
    const rc = config.roles[role];
    if (
      raw.name !== opencodeAgentName(role) ||
      raw.model?.providerID !== OPENCODE_PINNED_PROVIDER ||
      raw.model?.modelID !== rc.model.split("/")[1] ||
      raw.steps !== rc.steps ||
      raw.prompt !== rc.prompt ||
      !raw.tools ||
      Array.isArray(raw.tools)
    )
      throw new Error("opencode-roster-role-binding");
    const enabled = Object.keys(raw.tools).filter(
      (key) => raw.tools[key] === true,
    );
    if (
      Object.values(raw.tools).some((value) => typeof value !== "boolean") ||
      enabled.some((tool) => !OPENCODE_TOOL_ROSTER[role].has(tool))
    )
      throw new Error("opencode-roster-unexpected-tool");
    const required =
      role === "reviewer"
        ? ["read", "glob", "grep"]
        : ["bash", "read", "glob", "grep", "edit", "write", "todowrite"];
    if (required.some((tool) => !enabled.includes(tool)))
      throw new Error("opencode-roster-missing-tool");
  }
  assertInstalledWorkerBuild(config);
  return m;
}
/** Host-only authoring: this validates actual retained inputs and never claims a native successful turn. */
export function bindHostAdmission(
  config:
    | OpencodeConfig
    | Omit<OpencodeConfig, "qualification" | "hostAdmission">,
  inputs: Omit<
    HostAdmission,
    "schema" | "status" | "runtimeDigest" | "renderedConfigSha256" | "binding"
  >,
): HostAdmission {
  const payload = {
    schema: 1 as const,
    status: "first-live-observation-required" as const,
    runtimeDigest: identity(runtimeDescriptor(config)),
    renderedConfigSha256: digest(roleConfigContent(config)),
    ...inputs,
  };
  return { ...payload, binding: identity(payload) };
}
