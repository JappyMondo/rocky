// Taskbot #81 owned fake-CLI support: REAL spawned fake processes + real SQLite stores under
// .qualification/codex-exec-81 (or CODEX_ARTIFACT_ROOT). The fake binary is an owned synthetic
// script; nothing here touches the pinned real codex binary, credentials or the network, and the
// synthetic qualification grants nothing outside these tests.
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  coordinatorModule,
  admission,
  apply,
  finish,
  result,
  receipt,
  versions,
  retain,
} from "./coordinator-support.mjs";
const {
  Store,
  Evidence,
  CodexExecAdapter,
  deriveTreeHead,
  defaultCodexPlatformDenyRoots,
} = coordinatorModule;
export { apply, finish, result, receipt, versions, retain, deriveTreeHead };
export const MODE = "subscription-observed-v1";
export const sha = (value) => createHash("sha256").update(value).digest("hex");
// Synthetic, self-described test identity. NOT an approved binding; grants nothing in production.
export const qualification = {
  schema: 1,
  id: "synthetic-unapproved-codex-exec-81-test",
  harness: "codex-exec",
  contractId: "rocky-subscription-88-v1",
  budgetMode: MODE,
  binding: sha("synthetic-unapproved-codex-exec-binding"),
};
export const IMPLEMENTER_MODEL = "gpt-6-sol";
export const IMPLEMENTER_EFFORT = "medium";
export const REVIEWER_MODEL = "gpt-6-astra";
export const REVIEWER_EFFORT = "high";
export const SOURCE_COMMIT = "36650394c5b38c2990ccf2a3457165ca3e9d9726";
export function buildFakeBinary(dir) {
  mkdirSync(dir, { recursive: true });
  const source = readFileSync(
    resolve("tests/fixtures/codex-exec-fake-cli.mjs"),
  );
  const path = join(dir, "codex-0.157.1-fake.mjs");
  writeFileSync(
    path,
    Buffer.concat([Buffer.from(`#!${process.execPath}\n`), source]),
  );
  chmodSync(path, 0o755);
  const bytes = readFileSync(path);
  return {
    path,
    sha256: sha(bytes),
    bytes: bytes.length,
    version: "0.157.1",
    buildTime: null,
    sourceCommit: SOURCE_COMMIT,
  };
}
export function contractBinding() {
  const read = (p) => readFileSync(resolve(p));
  return {
    contractId: "rocky-subscription-88-v1",
    manifestSha256: sha(read("acceptance/subscription/manifest.json")),
    scenariosSha256: sha(read("acceptance/subscription/scenarios.json")),
    frozenSha256: sha(read("acceptance/subscription/frozen.sha256.json")),
    approvalReference: "taskbot-89-independent-contract-review",
  };
}
export function baseConfig(f, overrides = {}) {
  const base = {
    harness: "codex-exec",
    versions,
    qualification,
    contract: contractBinding(),
    binary: f.binary,
    roles: {
      implementer: { model: IMPLEMENTER_MODEL, effort: IMPLEMENTER_EFFORT },
      reviewer: { model: REVIEWER_MODEL, effort: REVIEWER_EFFORT },
    },
    codexHome: f.codexHome,
    authBackend: { credentialsStore: "file", secretAuthStorage: false },
    hostIdentity: { userHome: homedir(), userName: "fake-test-user" },
    denyRoots: [f.denyRoot],
    platformDenyRoots: defaultCodexPlatformDenyRoots(),
    permissionProfiles: {
      implementer: "rocky_implementer",
      reviewer: "rocky_reviewer",
    },
    discovery: {
      system: [
        join(f.discoveryRoot, "config.toml"),
        join(f.discoveryRoot, "requirements.toml"),
        join(f.discoveryRoot, "managed_config.toml"),
      ],
      systemDirs: [join(f.discoveryRoot, "skills")],
      mdm: [join(f.discoveryRoot, "com.openai.codex.plist")],
      approvedGlobalAgentsSha256: null,
      codexHomeSkillsApproved: false,
    },
    requestSchema: readFileSync(
      resolve("acceptance/subscription/final.schema.json"),
      "utf8",
    ),
    envOptions: { shell: false, user: false },
    limits: {
      maxPromptBytes: 65536,
      maxArgvBytes: 65536,
      maxOverrideValueBytes: 65536,
      maxOverrides: 64,
      maxStdoutBytes: 262144,
      maxStderrBytes: 65536,
      maxLineBytes: 65536,
      maxFrames: 256,
      maxItems: 64,
      maxFinalBytes: 32768,
      maxAggregatedOutputBytes: 65536,
      maxDenyEntries: 512,
      maxImages: 4,
      maxImageBytes: 4194304,
      killGraceMs: 250,
      cleanupReserveMs: 250,
      quiescenceTimeoutMs: 2000,
      maxTreeNodes: 2000,
    },
    runsRoot: f.runsRoot,
    evidenceClass: "owned-fake-cli",
  };
  const merged = { ...base, ...overrides };
  // Deep-merge a partial limits override so tests can tune one bound without restating all.
  if (overrides.limits) merged.limits = { ...base.limits, ...overrides.limits };
  return merged;
}
// A clean, owned source environment: the ambient test-process env is NOT inherited by the child
// (sealed allowlist), and forbidden keys planted here must refuse the launch pre-spawn.
export function cleanSourceEnv() {
  return {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: homedir(),
    TMPDIR: tmpdir(),
    LANG: "en_US.UTF-8",
  };
}
export function codexFixture(name, options = {}) {
  const dir = realpathSync(
    mkdtempSync(
      join(tmpdir(), `codex81-${name.replace(/[^a-z0-9-]/gi, "-")}-`),
    ),
  );
  const artifactRoot = resolve(
    process.env.CODEX_ARTIFACT_ROOT ?? ".qualification/codex-exec-81/artifacts",
    `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(artifactRoot, { recursive: true });
  const store = new Store(join(artifactRoot, "state.sqlite"), Date.now);
  const f = {
    dir,
    artifactRoot,
    store,
    binary: buildFakeBinary(join(artifactRoot, "bin")),
    codexHome: join(dir, "codex-home"),
    runsRoot: join(dir, "runs"),
    discoveryRoot: join(dir, "discovery"),
    denyRoot: join(dir, "deny-root"),
  };
  for (const path of [f.codexHome, f.runsRoot, f.discoveryRoot, f.denyRoot])
    mkdirSync(path, { recursive: true, mode: 0o700 });
  // A synthetic, nonsecret shared config.toml so the F5 trust-persistence byte check has a stable
  // baseline. Its content is never a credential and is only measured (sha256/size) by the host.
  writeFileSync(
    join(f.codexHome, "config.toml"),
    "# synthetic shared codex home for Taskbot #81 owned-fake-CLI tests\n",
  );
  const admissionInput = {
    ...admission("run-1"),
    capability: null,
    budget: {
      mode: MODE,
      reportedTokenThreshold: options.threshold ?? 100000,
    },
    qualification,
    head: options.head ?? "head-1",
    limits: {
      totalTokens: 100000,
      totalElapsedMs: 600000,
      actionTokens: 100,
      actionElapsedMs: options.actionElapsedMs ?? 60000,
    },
  };
  store.admitCoordinator(admissionInput);
  const lease = store.claim("run-1", "owner", versions, 1000000);
  f.lease = lease;
  f.evidence = new Evidence(join(artifactRoot, "evidence"));
  f.sourceEnv = cleanSourceEnv();
  f.config = baseConfig(f, options.config);
  f.adapter = new CodexExecAdapter(store, lease, f.config, {
    sourceEnv: f.sourceEnv,
  });
  return f;
}
export function localUsage() {
  return {
    schema: 1,
    status: "known",
    tokens: 0,
    source: {
      kind: "local-no-model",
      reference: "synthetic-owned-local-command-receipt",
    },
  };
}
let syntheticReceipts = 0;
/** Synthetic schema-2 telemetry for host-side setup steps; never a provider receipt. */
export function syntheticReported(input, output) {
  return {
    schema: 2,
    status: "reported",
    source: "native-harness-telemetry",
    harness: "codex-exec",
    receipt: sha(`synthetic-setup-telemetry-${++syntheticReceipts}`),
    components: {
      input,
      cachedInput: null,
      cacheWriteInput: null,
      output,
      reasoningOutput: null,
    },
  };
}
export function baselinePass(f) {
  apply(f.store, f.lease, { type: "schedule", kind: "baseline" });
  finish(f, { usage: localUsage() });
  receipt(f, "baseline");
}
export function implementChanged(f, head = "head-2") {
  baselinePass(f);
  apply(f.store, f.lease, { type: "schedule", kind: "implement" });
  finish(f, { usage: syntheticReported(10, 5), outcome: "changed", head });
  apply(f.store, f.lease, { type: "schedule", kind: "verify" });
  finish(f, { usage: localUsage() });
  receipt(f, "checks");
}
export function schedule(f, kind) {
  const s = apply(f.store, f.lease, { type: "schedule", kind });
  if (!s.execution) throw new Error(`schedule-blocked:${s.blocker?.detail}`);
  return s.execution;
}
export function finalProposal(action, role, outcome = "changed", extra = {}) {
  return {
    schema: 1,
    actionKey: action.key,
    inputDigest: action.inputDigest,
    role,
    outcome,
    summary: "synthetic owned fake-CLI proposal",
    ...extra,
  };
}
/** The default positive usage object (reported total 1540 = input 1200 + output 340). */
export const defaultUsage = {
  input_tokens: 1200,
  cached_input_tokens: 800,
  cache_write_input_tokens: 100,
  output_tokens: 340,
  reasoning_output_tokens: 40,
};
/** A complete, source-shaped successful exec stream (F02 positive control): thread.started,
 * turn.started, a settled command, a completed-only patch, the final agent_message, turn.completed
 * with usage, then exit 0. Options inject faults at each seam. */
export function successScript(proposal, options = {}) {
  const script = [
    ...(options.preThread ?? []),
    options.threadFrag
      ? {
          outFrag: { type: "thread.started", thread_id: "fake-thread-0001" },
          size: options.threadFrag,
        }
      : { thread: options.thread ?? {} },
    { turnStarted: {} },
    ...(options.afterTurn ?? []),
    {
      itemStarted: {
        id: "item_0",
        itemType: "command_execution",
        command: "npm test",
      },
    },
    {
      itemCompleted: {
        id: "item_0",
        itemType: "command_execution",
        command: "npm test",
        status: "completed",
        exit_code: 0,
        aggregated_output: "ok",
      },
    },
    ...(options.ordinary ?? []),
    {
      itemCompleted: {
        id: "item_1",
        itemType: "file_change",
        changes: [{ path: "output.txt" }],
        status: "completed",
      },
    },
    ...(options.writeSrc ? [{ writeSrc: options.writeSrc }] : []),
    {
      itemCompleted: {
        id: "item_final",
        itemType: "agent_message",
        text: JSON.stringify(proposal),
      },
    },
    { turnCompleted: { usage: options.usage ?? {} } },
    ...(options.post ?? []),
  ];
  if (options.exit !== undefined) script.push({ exit: options.exit });
  return { script };
}
/** A top-level error event (will_retry reconnect shape) — always fails closed (F10). */
export const willRetryErrorEvent = {
  type: "error",
  message: "stream disconnected before completion: error sending request",
  will_retry: true,
};
/** Prepare + dispatch through the real Store seam; returns the plan and the pending promise. */
export function dispatchCodex(f, action, promptDocument, options = {}) {
  const prompt =
    typeof promptDocument === "string"
      ? promptDocument
      : JSON.stringify(promptDocument);
  const plan = f.adapter.prepareLaunch(action, {
    prompt,
    ...(options.stage ? { stage: options.stage } : {}),
    ...(options.images ? { images: options.images } : {}),
  });
  options.afterPrepare?.(plan);
  const pending = f.store.dispatchCoordinator(f.lease, action.key, f.adapter);
  f.pending = pending;
  f.activeAction = action;
  f.activePlan = plan;
  pending.catch((error) => {
    f.dispatchError = error;
  });
  return { plan, pending };
}
export async function settleCodex(f, action, pending) {
  await pending;
  return f.store.applyCoordinator(
    f.lease,
    f.store.coordinatorSnapshot(f.lease.runId).revision,
    "transport",
    `result/${action.key}`,
  );
}
/** Deterministic teardown: cancel any live invocation, drain the tracked dispatch and close. */
export async function closeFixture(f) {
  if (f.pending) {
    try {
      if (f.activeAction) f.adapter.interrupt(f.activeAction);
    } catch {
      /* already settled */
    }
    await f.pending.then(
      () => {},
      () => {},
    );
    f.pending = null;
  }
  try {
    f.store.close();
  } catch {
    /* already closed */
  }
}
export function readReceipt(plan, commandId) {
  return JSON.parse(
    readFileSync(join(plan.paths.logs, `receipt-${commandId}.json`), "utf8"),
  );
}
export function fakeRecord(plan) {
  return JSON.parse(
    readFileSync(join(plan.paths.parentTmp, "fake-record.json"), "utf8"),
  );
}
export function writeMarker(plan, name) {
  writeFileSync(join(plan.paths.parentTmp, name), "go");
}
export async function waitForFile(path, timeoutMs = 10000) {
  const { existsSync } = await import("node:fs");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`wait-for-file-timeout:${path}`);
}
export function commandOf(f) {
  const commands = f.store.commands(f.lease.runId);
  return commands[commands.length - 1];
}
export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}
