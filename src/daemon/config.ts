import {
  existsSync,
  readFileSync,
  realpathSync,
  mkdirSync,
  copyFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { assertBinaryIdentity } from "../runner/process.js";
import { digest, identity } from "../store/json.js";
import {
  validateOpencodeConfig,
  defaultOpencodeManagedPaths,
  OPENCODE_PINNED_MODEL,
  OPENCODE_PINNED_VERSION,
  OPENCODE_PINNED_BINARY_PATH,
  OPENCODE_PINNED_SHA256,
  OPENCODE_PINNED_BYTES,
  type OpencodeConfig,
} from "../agents/opencode/index.js";
import {
  assertHostAdmission,
  qualificationForManifest,
  type HostAdmission,
  type HostContext,
} from "../agents/opencode/host.js";
import type { ExecutionQualification } from "../coordinator/contracts.js";
import type { Versions } from "../store/index.js";
import { assertHomeAvailable } from "./ownership.js";

export interface OperatorConfig {
  repositoryPath: string;
  repository: string;
  baseBranch: string;
  task: string;
  actionMinutes: number;
  totalMinutes: number;
  reportedTokenThreshold: number;
}
export const defaults: OperatorConfig = {
  repositoryPath: "",
  repository: "attraccess/attraccess",
  baseBranch: "main",
  task: "",
  actionMinutes: 15,
  totalMinutes: 120,
  reportedTokenThreshold: 100000,
};
export interface CheckRecipe {
  name: string;
  file: string;
  args: string[];
}
/** Reviewed setup facts, deliberately unavailable through the web API. No credentials. */
export interface HostAuthority {
  task?: string;
  profile?: string;
  repository: string;
  liveApproval: string;
  nativeProbeEvidence: string;
  authBoundaryApproval: string;
  qualification: ExecutionQualification;
  hostAdmission?: HostAdmission;
  checks: CheckRecipe[];
  requiredCI: string[];
}
export function homePath() {
  return resolve(process.env.ROCKY_NEXT_HOME ?? join(homedir(), ".rocky-next"));
}
export function validateOperatorConfig(value: unknown): OperatorConfig {
  const v = value as OperatorConfig;
  if (
    !v ||
    Object.keys(v).sort().join() !== Object.keys(defaults).sort().join()
  )
    throw new Error("Invalid configuration fields");
  for (const key of [
    "repositoryPath",
    "repository",
    "baseBranch",
    "task",
  ] as const)
    if (
      typeof v[key] !== "string" ||
      v[key].includes("\0") ||
      v[key].length > 16000
    )
      throw new Error(`Invalid ${key}`);
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(v.repository) ||
    !/^[\w./-]+$/.test(v.baseBranch) ||
    v.baseBranch.startsWith("-") ||
    v.baseBranch.includes("..")
  )
    throw new Error("Use owner/repository and a valid base branch");
  for (const key of [
    "actionMinutes",
    "totalMinutes",
    "reportedTokenThreshold",
  ] as const)
    if (
      !Number.isSafeInteger(v[key]) ||
      v[key] < 1 ||
      v[key] > (key === "reportedTokenThreshold" ? 10000000 : 1440)
    )
      throw new Error(`Invalid ${key}`);
  if (v.totalMinutes < v.actionMinutes * 4)
    throw new Error("Total time must reserve at least four action allowances");
  return structuredClone(v);
}
export function readAuthority(home: string): HostAuthority | null {
  const file = join(home, "authority.json");
  if (!existsSync(file)) return null;
  const v = JSON.parse(readFileSync(file, "utf8")) as HostAuthority;
  for (const k of [
    "repository",
    "liveApproval",
    "nativeProbeEvidence",
    "authBoundaryApproval",
  ] as const)
    if (!v[k]?.trim()) throw new Error(`Host authority is missing ${k}`);
  if (
    !Array.isArray(v.checks) ||
    !v.checks.length ||
    !Array.isArray(v.requiredCI) ||
    !v.requiredCI.length
  )
    throw new Error("Host authority needs real checks and required CI names");
  for (const c of v.checks)
    if (
      !c.name ||
      !c.file?.startsWith("/") ||
      !Array.isArray(c.args) ||
      c.args.some((a) => typeof a !== "string")
    )
      throw new Error("Invalid host check recipe");
  if (!v.hostAdmission)
    throw new Error(
      "Host authority needs a retained conditional qualification manifest",
    );
  if (
    identity(v.qualification) !==
    identity(qualificationForManifest(v.hostAdmission))
  )
    throw new Error("Host qualification does not match manifest");
  return v;
}
export function hostContext(authority: HostAuthority): HostContext {
  return {
    repository: authority.repository,
    task: authority.task ?? null,
    profile: authority.profile ?? null,
    checks: authority.checks,
    requiredCI: authority.requiredCI,
    liveApproval: authority.liveApproval,
    nativeProbeEvidence: authority.nativeProbeEvidence,
    authBoundaryApproval: authority.authBoundaryApproval,
  };
}
export function buildRuntime(
  home: string,
  authority: HostAuthority,
  versions: Versions,
): OpencodeConfig {
  if (!authority.hostAdmission)
    throw new Error("opencode-host-manifest-required");
  const runtime = validateOpencodeConfig({
    ...describeRuntime(home, authority, versions),
    qualification: authority.qualification,
    hostAdmission: authority.hostAdmission,
  });
  assertHostAdmission(runtime, hostContext(authority));
  return runtime;
}
/** Host authoring descriptor: no qualification ID or claims are generated here. */
export function describeRuntime(
  home: string,
  authority: HostAuthority,
  versions: Versions,
): Omit<OpencodeConfig, "qualification" | "hostAdmission"> {
  const catalog = join(home, "models.json");
  const common = `You are a bounded Rocky coding agent. Work only in the supplied source directory. Never access credentials, push, create PRs, merge, or alter the check policy. Finish with ONLY the exact JSON final protocol supplied in the task. No Markdown fences.`;
  return {
    harness: "opencode",
    versions,
    binary: {
      path: discoverOpencode(),
      sha256: OPENCODE_PINNED_SHA256,
      bytes: OPENCODE_PINNED_BYTES,
      version: OPENCODE_PINNED_VERSION,
    },
    roles: {
      implementer: {
        model: OPENCODE_PINNED_MODEL,
        steps: authority.profile === "attraccess-att764-v1" ? 12 : 32,
        prompt:
          common +
          " Implement the scoped behavior and its tests; preserve all existing acceptance checks.",
      },
      reviewer: {
        model: OPENCODE_PINNED_MODEL,
        steps: authority.profile === "attraccess-att764-v1" ? 6 : 12,
        prompt:
          common +
          " Review independently using read-only tools. Complete means no blocking findings; failed means blocking findings. Include concrete findings in summary.",
      },
    },
    dataHome: join(home, "opencode-data"),
    modelsCatalog: { path: catalog, sha256: digest(readFileSync(catalog)) },
    managedPaths: defaultOpencodeManagedPaths(),
    hostIdentity: { userHome: homedir() },
    runsRoot: join(home, "agents"),
    evidenceClass: "live-subscription",
    limits: {
      maxPromptBytes: 524288,
      maxArgvBytes: 65536,
      maxStdoutBytes: 4194304,
      maxStderrBytes: 1048576,
      maxLineBytes: 262144,
      maxFrames: 4096,
      maxParts: 2048,
      maxFinalBytes: 32768,
      maxExportBytes: 8388608,
      exportTimeoutMs: 30000,
      killGraceMs: 1000,
      cleanupReserveMs: 2000,
      maxTreeNodes: 100000,
    },
  };
}
export function setup(home: string) {
  assertHomeAvailable(home);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  for (const path of ["opencode-data", "agents", "workspaces"])
    mkdirSync(join(home, path), { recursive: true, mode: 0o700 });
  const catalog = join(homedir(), ".cache/opencode/models.json");
  if (!existsSync(join(home, "models.json")) && existsSync(catalog))
    copyFileSync(catalog, join(home, "models.json"));
  const authorityTemplate = {
    repository: "attraccess/attraccess",
    liveApproval: "",
    nativeProbeEvidence: "",
    authBoundaryApproval: "",
    qualification: null,
    hostAdmission: null,
    checks: [],
    requiredCI: [],
  };
  if (!existsSync(join(home, "authority.example.json")))
    writeFileSync(
      join(home, "authority.example.json"),
      JSON.stringify(authorityTemplate, null, 2) + "\n",
      { mode: 0o600 },
    );
  let github = "gh authentication unavailable";
  try {
    execFileSync("gh", ["auth", "status"], { stdio: "pipe", timeout: 5000 });
    github = "gh authenticated";
  } catch {
    /* no credential output */
  }
  const binaryPath = discoverOpencode();
  let binaryStatus = "supported pinned identity";
  try {
    assertBinaryIdentity({
      path: binaryPath,
      sha256: OPENCODE_PINNED_SHA256,
      bytes: OPENCODE_PINNED_BYTES,
    });
  } catch {
    binaryStatus = existsSync(binaryPath)
      ? `Installed binary differs from supported ${OPENCODE_PINNED_VERSION} identity; qualification required`
      : "OpenCode is not installed";
  }
  return {
    opencode: { path: binaryPath, status: binaryStatus },
    home: realpathSync(home),
    node: process.version,
    github,
    catalog: existsSync(join(home, "models.json")),
    next: [
      `Open the local UI with rocky-next start.`,
      `Host setup: ${join(home, "authority.example.json")} lists only remaining reviewed authority/check inputs; runtime paths, prompts and limits are assembled automatically.`,
      `Provision OpenCode auth into XDG_DATA_HOME=${join(home, "opencode-data")} using the reviewed isolated login procedure in docs/opencode-adapter.md. Rocky never copies your auth file.`,
    ],
  };
}

export function discoverOpencode() {
  try {
    assertBinaryIdentity({
      path: OPENCODE_PINNED_BINARY_PATH,
      sha256: OPENCODE_PINNED_SHA256,
      bytes: OPENCODE_PINNED_BYTES,
    });
    return realpathSync(OPENCODE_PINNED_BINARY_PATH);
  } catch {
    // PATH remains diagnostic when the approved identity is absent; admission still rechecks the pin.
  }
  try {
    return realpathSync(
      execFileSync("/usr/bin/which", ["opencode"], {
        encoding: "utf8",
        timeout: 2000,
      }).trim(),
    );
  } catch {
    return OPENCODE_PINNED_BINARY_PATH;
  }
}
