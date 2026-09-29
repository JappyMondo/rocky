// Taskbot #98 owned fake-CLI support: REAL spawned fake processes + real SQLite stores under
// .qualification/opencode-98/artifacts (or OPENCODE_ARTIFACT_ROOT). The fake binary is an owned
// synthetic script; nothing here touches the pinned real opencode binary (which is NEVER executed
// in #98), real credentials or the network, and the synthetic qualification grants nothing
// outside these tests. The fixture data home is Rocky-owned synthetic state; the user's real
// ~/.local/share/opencode is never read, listed or touched (path-string comparisons only).
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
  retain,
  versions,
} from "./coordinator-support.mjs";
const { Store, Evidence, OpencodeAdapter, deriveTreeHead } = coordinatorModule;
export { apply, finish, result, receipt, retain, versions, deriveTreeHead };
export const MODE = "subscription-observed-v1";
export const sha = (value) => createHash("sha256").update(value).digest("hex");
// Synthetic, self-described test identity. NOT an approved binding; grants nothing in production.
export const qualification = {
  schema: 1,
  id: "synthetic-unapproved-opencode-98-test",
  harness: "opencode",
  contractId: "rocky-opencode-poc-98-v1",
  budgetMode: MODE,
  binding: sha("synthetic-unapproved-opencode-98-binding"),
};
export const PINNED_MODEL = "alibaba-token-plan/qwen3.8-max";
export const PINNED_PROVIDER = "alibaba-token-plan";
export const PINNED_MODEL_ID = "qwen3.8-max";
export const PINNED_VERSION = "1.18.32";
export const DEFAULT_SESSION = "fake-session-0001";
export function buildFakeBinary(dir) {
  mkdirSync(dir, { recursive: true });
  const source = readFileSync(resolve("tests/fixtures/opencode-fake-cli.mjs"));
  const path = join(dir, "opencode-1.18.32-fake.mjs");
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
    version: PINNED_VERSION,
  };
}
export function baseConfig(f, overrides = {}) {
  const base = {
    harness: "opencode",
    versions,
    qualification,
    binary: f.binary,
    roles: {
      implementer: {
        model: PINNED_MODEL,
        steps: 8,
        prompt: "SYNTHETIC Rocky implementer role prompt (test bytes).",
      },
      reviewer: {
        model: PINNED_MODEL,
        steps: 4,
        prompt: "SYNTHETIC Rocky reviewer role prompt (test bytes).",
      },
    },
    dataHome: f.dataHome,
    modelsCatalog: f.modelsCatalog,
    managedPaths: f.managedPaths,
    hostIdentity: { userHome: homedir() },
    limits: {
      maxPromptBytes: 65536,
      maxArgvBytes: 65536,
      maxStdoutBytes: 262144,
      maxStderrBytes: 65536,
      maxLineBytes: 65536,
      maxFrames: 256,
      maxParts: 64,
      maxFinalBytes: 32768,
      maxExportBytes: 1048576,
      exportTimeoutMs: 10000,
      killGraceMs: 250,
      cleanupReserveMs: 250,
      maxTreeNodes: 2000,
    },
    runsRoot: f.runsRoot,
    evidenceClass: "owned-fake-cli",
  };
  const merged = { ...base, ...overrides };
  if (overrides.limits) merged.limits = { ...base.limits, ...overrides.limits };
  if (overrides.roles) merged.roles = { ...base.roles, ...overrides.roles };
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
export function opencodeFixture(name, options = {}) {
  const dir = realpathSync(
    mkdtempSync(
      join(tmpdir(), `opencode98-${name.replace(/[^a-z0-9-]/gi, "-")}-`),
    ),
  );
  const artifactRoot = resolve(
    process.env.OPENCODE_ARTIFACT_ROOT ??
      ".qualification/opencode-98/artifacts",
    `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(artifactRoot, { recursive: true });
  const store = new Store(join(artifactRoot, "state.sqlite"), Date.now);
  const f = {
    dir,
    artifactRoot,
    store,
    binary: buildFakeBinary(join(artifactRoot, "bin")),
    dataHome: join(dir, "opencode-data"),
    runsRoot: join(dir, "runs"),
    managedPaths: [
      join(dir, "managed", "opencode.json"),
      join(dir, "managed", "ai.opencode.managed.plist"),
    ],
  };
  mkdirSync(f.runsRoot, { recursive: true, mode: 0o700 });
  // Rocky-owned synthetic data home: the ONE-TIME user-assisted auth provisioning is simulated by
  // an obviously synthetic marker file. These are NOT credential bytes; the adapter never reads
  // this file (path-existence metadata only).
  mkdirSync(join(f.dataHome, "opencode"), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(f.dataHome, "opencode", "auth.json"),
    '{"synthetic":"owned-test-marker-not-a-credential"}\n',
    { mode: 0o600 },
  );
  // Pinned synthetic models catalog (stands in for the host-measured models.json pin).
  const catalogPath = join(dir, "models-catalog.json");
  writeFileSync(
    catalogPath,
    JSON.stringify({
      synthetic: "owned-test-catalog-not-the-real-models.dev-cache",
      provider: PINNED_PROVIDER,
      model: PINNED_MODEL_ID,
    }),
  );
  f.modelsCatalog = {
    path: catalogPath,
    sha256: sha(readFileSync(catalogPath)),
  };
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
  f.adapter = new OpencodeAdapter(store, lease, f.config, {
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
    harness: "opencode",
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
/** Default positive stream telemetry: step_finish totals input 1200 / output 340 (reported total
 * 1540), with reasoning/cache subsets. The default export document mirrors these exactly. */
export const defaultTokens = {
  input: 1200,
  output: 340,
  reasoning: 40,
  cacheRead: 800,
  cacheWrite: 100,
};
/** A complete, source-shaped successful run stream (positive control): step_start →
 * tool_use(bash, completed) → step_finish(tokens) → text(final proposal) → EOF → exit 0. Options
 * inject faults at each seam. There is deliberately NO result/done frame (F21). */
export function successScript(proposal, options = {}) {
  const t = { ...defaultTokens, ...(options.tokens ?? {}) };
  const script = [
    ...(options.pre ?? []),
    { stepStart: {} },
    ...(options.afterStepStart ?? []),
    { toolUse: { tool: "bash", output: "ok" } },
    ...(options.afterTool ?? []),
    ...(options.writeSrc ? [{ writeSrc: options.writeSrc }] : []),
    {
      stepFinish: {
        input: t.input,
        output: t.output,
        reasoning: t.reasoning,
        cacheRead: t.cacheRead,
        cacheWrite: t.cacheWrite,
      },
    },
    ...(options.afterStepFinish ?? []),
    { text: { text: JSON.stringify(proposal) } },
    ...(options.post ?? []),
  ];
  const document = { script };
  if (options.sessionID !== undefined) document.sessionID = options.sessionID;
  if (options.exit !== undefined) document.exit = options.exit;
  return document;
}
/** Build a well-formed `opencode export` stdout document (pinned source shape: JSON.stringify of
 * {info: SessionInfo, messages}, pretty-printed). Every field the audit consumes is overridable so
 * mismatch fixtures stay one-line changes. */
export function exportDoc(options = {}) {
  const tokens = { ...defaultTokens, ...(options.tokens ?? {}) };
  const assistantTokens = {
    input: tokens.input,
    output: tokens.output,
    reasoning: tokens.reasoning,
    cache: { read: tokens.cacheRead, write: tokens.cacheWrite },
    cost: 0,
  };
  const info = {
    id: options.sessionID ?? DEFAULT_SESSION,
    slug: "fake-slug",
    projectID: "fake-project",
    directory: options.directory ?? "/synthetic/src",
    title: "fake session",
    version: options.version ?? PINNED_VERSION,
    time: { created: 1, updated: 2 },
    ...(options.omitModel
      ? {}
      : {
          model: {
            id: options.modelID ?? PINNED_MODEL_ID,
            providerID: options.providerID ?? PINNED_PROVIDER,
          },
        }),
    ...(options.omitInfoTokens
      ? {}
      : {
          tokens: {
            input: options.infoTokens?.input ?? tokens.input,
            output: options.infoTokens?.output ?? tokens.output,
            reasoning: tokens.reasoning,
            cache: { read: tokens.cacheRead, write: tokens.cacheWrite },
          },
        }),
  };
  const messages = [
    {
      info: {
        role: "user",
        id: "fake-message-0000",
        sessionID: info.id,
        time: { created: 1 },
      },
      parts: [],
    },
    {
      info: {
        role: "assistant",
        id: "fake-message-0001",
        sessionID: info.id,
        parentID: "fake-message-0000",
        modelID: options.modelID ?? PINNED_MODEL_ID,
        providerID: options.providerID ?? PINNED_PROVIDER,
        agent: options.agent ?? "rocky-implementer",
        mode: "primary",
        cost: 0,
        tokens: {
          input: assistantTokens.input,
          output: assistantTokens.output,
          reasoning: assistantTokens.reasoning,
          cache: assistantTokens.cache,
        },
        path: { cwd: info.directory, root: info.directory },
        time: { created: 1, completed: 2 },
        ...(options.assistantError ? { error: options.assistantError } : {}),
      },
      parts: [],
    },
  ];
  return { info, messages };
}
/** The default well-formed export marker for a plan: success conjunct satisfied. */
export function defaultExportMarker(plan, options = {}) {
  return {
    raw: `${JSON.stringify(exportDoc({ directory: plan.paths.src, ...options }), null, 2)}\n`,
    exit: 0,
  };
}
/** Prepare + dispatch through the real Store seam; returns the plan and the pending promise.
 * The export marker defaults to a well-formed audit document bound to this plan; pass
 * exportMarker: null to leave export unavailable, or a function/object to script a fault. */
export function dispatchOpencode(f, action, promptDocument, options = {}) {
  const prompt =
    typeof promptDocument === "string"
      ? promptDocument
      : JSON.stringify(promptDocument);
  const plan = f.adapter.prepareLaunch(action, {
    prompt,
    ...(options.stage ? { stage: options.stage } : {}),
  });
  options.afterPrepare?.(plan);
  let marker;
  if (options.exportMarker === undefined) marker = defaultExportMarker(plan);
  else if (options.exportMarker === null) marker = null;
  else
    marker =
      typeof options.exportMarker === "function"
        ? options.exportMarker(plan)
        : options.exportMarker;
  if (marker)
    writeFileSync(
      join(plan.paths.parentTmp, "fake-export.json"),
      JSON.stringify(marker),
    );
  const pending = f.store.dispatchCoordinator(f.lease, action.key, f.adapter);
  f.pending = pending;
  f.activeAction = action;
  f.activePlan = plan;
  pending.catch((error) => {
    f.dispatchError = error;
  });
  return { plan, pending };
}
export async function settleOpencode(f, action, pending) {
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
/** The export-audit child's own recorded argv/env/cwd (separate record; the export spawn must
 * never clobber the run's evidence). */
export function fakeExportRecord(plan) {
  return JSON.parse(
    readFileSync(join(plan.paths.parentTmp, "fake-export-record.json"), "utf8"),
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
