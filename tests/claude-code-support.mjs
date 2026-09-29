// Taskbot #97 owned fake-CLI support: REAL spawned fake processes + real SQLite stores under
// .qualification/claude-code-97 (or CLAUDE_ARTIFACT_ROOT). The fake binary is an owned synthetic
// script; nothing here touches the pinned real Claude binary, credentials or the network, and
// the synthetic qualification grants nothing outside these tests.
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
const { Store, Evidence, ClaudeCodeAdapter, deriveTreeHead } =
  coordinatorModule;
export { apply, finish, result, receipt, versions, retain, deriveTreeHead };
export const MODE = "subscription-observed-v1";
export const sha = (value) => createHash("sha256").update(value).digest("hex");
// Synthetic, self-described test identity. NOT an approved binding; grants nothing in production.
export const qualification = {
  schema: 1,
  id: "synthetic-unapproved-claude-code-97-test",
  harness: "claude-code",
  contractId: "rocky-claude-code-95-v1",
  budgetMode: MODE,
  binding: sha("synthetic-unapproved-claude-code-binding"),
};
export const TEST_MODEL = "claude-synthetic-test-model";
export function buildFakeBinary(dir) {
  mkdirSync(dir, { recursive: true });
  const source = readFileSync(
    resolve("tests/fixtures/claude-code-fake-cli.mjs"),
  );
  const path = join(dir, "claude-2.1.283-fake.mjs");
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
    version: "2.1.283",
    buildTime: null,
  };
}
export function contractBinding() {
  const read = (p) => readFileSync(resolve(p));
  return {
    contractId: "rocky-claude-code-95-v1",
    manifestSha256: sha(read("acceptance/claude-code/manifest.json")),
    scenariosSha256: sha(read("acceptance/claude-code/scenarios.json")),
    frozenSha256: sha(read("acceptance/claude-code/frozen.sha256.json")),
    approvalReference: "taskbot-96-independent-contract-review",
  };
}
export function baseConfig(f, overrides = {}) {
  return {
    harness: "claude-code",
    versions,
    qualification,
    contract: contractBinding(),
    binary: f.binary,
    roles: {
      implementer: { model: TEST_MODEL, effort: "high" },
      reviewer: { model: TEST_MODEL, effort: "high" },
    },
    configDir: f.configDir,
    hostIdentity: { userHome: homedir(), userName: "fake-test-user" },
    denyRoots: [f.denyRoot],
    discovery: {
      managed: [join(f.discoveryRoot, "managed-settings.json")],
      managedDirs: [join(f.discoveryRoot, "managed-settings.d")],
      mdm: [join(f.discoveryRoot, "com.anthropic.claudecode.plist")],
    },
    appendInstructions:
      "Synthetic owned fake-CLI instructions for Taskbot #97 adapter tests. Bounded work only.",
    requestSchema: readFileSync(
      resolve("acceptance/subscription/final.schema.json"),
      "utf8",
    ),
    initExpectations: {
      skills: [],
      slashCommands: [],
      toolsIncludeStructuredOutput: false,
    },
    envOptions: { shell: false, user: false },
    limits: {
      maxTurns: 8,
      maxPromptBytes: 65536,
      maxArgvBytes: 65536,
      maxSettingsBytes: 65536,
      maxStdoutBytes: 262144,
      maxStderrBytes: 65536,
      maxLineBytes: 65536,
      maxFrames: 256,
      maxToolUses: 16,
      maxResultBytes: 32768,
      killGraceMs: 250,
      cleanupReserveMs: 250,
      quiescenceTimeoutMs: 2000,
      maxTreeNodes: 2000,
    },
    runsRoot: f.runsRoot,
    evidenceClass: "owned-fake-cli",
    ...overrides,
  };
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
export function claudeFixture(name, options = {}) {
  const dir = realpathSync(
    mkdtempSync(
      join(tmpdir(), `claude97-${name.replace(/[^a-z0-9-]/gi, "-")}-`),
    ),
  );
  const artifactRoot = resolve(
    process.env.CLAUDE_ARTIFACT_ROOT ??
      ".qualification/claude-code-97/artifacts",
    `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(artifactRoot, { recursive: true });
  const store = new Store(join(artifactRoot, "state.sqlite"), Date.now);
  const f = {
    dir,
    artifactRoot,
    store,
    binary: buildFakeBinary(join(artifactRoot, "bin")),
    configDir: join(dir, "claude-config"),
    runsRoot: join(dir, "runs"),
    discoveryRoot: join(dir, "discovery"),
    denyRoot: join(dir, "deny-root"),
  };
  for (const path of [f.configDir, f.runsRoot, f.discoveryRoot, f.denyRoot])
    mkdirSync(path, { recursive: true, mode: 0o700 });
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
  f.adapter = new ClaudeCodeAdapter(store, lease, f.config, {
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
    harness: "claude-code",
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
/** A raw protocol frame used as a step is normalized to an {out} emit step. */
function normalizeStep(step) {
  return step && typeof step === "object" && typeof step.type === "string"
    ? { out: step }
    : step;
}
export function successScript(proposal, options = {}) {
  const tool = options.role === "reviewer" ? "Read" : "Bash";
  const script = [
    ...(options.preInit ?? []).map(normalizeStep),
    options.initFrag
      ? { initFrag: options.initFrag }
      : { init: options.init ?? {} },
    ...(options.afterInit ?? []).map(normalizeStep),
    ...(options.ordinary ?? []).map(normalizeStep),
    {
      toolUse: {
        id: "tu_1",
        name: options.tool ?? tool,
        input: { synthetic: true },
      },
    },
    { toolResult: { id: "tu_1", content: "ok" } },
    ...(options.writeSrc ? [{ writeSrc: options.writeSrc }] : []),
    {
      toolUse: {
        id: "tu_struct",
        name: "StructuredOutput",
        input: proposal,
      },
    },
    { toolResult: { id: "tu_struct", content: "accepted" } },
    options.resultFrag
      ? { resultFrag: options.resultFrag }
      : { result: { structured_output: proposal, ...(options.result ?? {}) } },
    ...(options.post ?? []).map(normalizeStep),
  ];
  if (options.exit !== undefined) script.push({ exit: options.exit });
  return { script };
}
export const apiRetryFrame = {
  type: "system",
  subtype: "api_retry",
  attempt: 1,
  max_retries: 3,
  retry_delay_ms: 10,
  error_status: 529,
  error: "overloaded",
};
export const permissionDeniedFrame = {
  type: "system",
  subtype: "permission_denied",
  tool_name: "Bash",
  tool_use_id: "tu_denied",
  decision_reason_type: "rule",
  decision_reason: "synthetic deny rule",
  message: "denied by rule",
};
/** Prepare + dispatch through the real Store seam; returns the plan and the pending promise.
 * The fixture tracks the pending dispatch so closeFixture can always settle it. */
export function dispatchClaude(f, action, promptDocument, options = {}) {
  const prompt =
    typeof promptDocument === "string"
      ? promptDocument
      : JSON.stringify(promptDocument);
  const plan = f.adapter.prepareLaunch(action, {
    prompt,
    ...(options.stage ? { stage: options.stage } : {}),
  });
  options.afterPrepare?.(plan);
  const pending = f.store.dispatchCoordinator(f.lease, action.key, f.adapter);
  f.pending = pending;
  f.activeAction = action;
  f.activePlan = plan;
  // Observation branch: records the dispatch error without ever re-throwing into an
  // unhandled rejection when a test fails before awaiting.
  pending.catch((error) => {
    f.dispatchError = error;
  });
  return { plan, pending };
}
export async function settleClaude(f, action, pending) {
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
