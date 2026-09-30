import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { digest, identity, canonical } from "../../store/json.js";
import type { Store, CommandRecord } from "../../store/index.js";
import {
  validateUsage,
  type Event,
  type HarnessUsage,
} from "../../coordinator/contracts.js";
import type { OpencodeConfig } from "./config.js";
import type { OpencodeLaunchPlan } from "./adapter.js";
import {
  deriveTreeHead,
  StrictNdjsonDecoder,
  parseStrictJson,
  settlementToResultEvent,
  unknownHarnessUsage,
} from "../seam.js";
import { classifyOpencodeStream } from "./stream.js";
import { auditOpencodeExport, auditObservedOpencodeExport } from "./export.js";
import { mapOpencodeUsage } from "./usage.js";
import { assertBinaryIdentity, groupAbsent } from "../../runner/process.js";
import type { CommandResult } from "../../runner/index.js";
import type { AgentSettlement } from "../seam.js";
import type {
  OpencodeExportAudit,
  OpencodeExportObservation,
} from "./export.js";
import type { HostArtifact } from "./host.js";
import {
  assertOpencodeDataHomeIsolation,
  inventoryOpencodeIsolation,
  assertOpencodeIsolationAdmissible,
  type OpencodeIsolationInventory,
} from "./launch.js";
import { dependencyInventory } from "./dependencies.js";
import { assertHostAdmission, roleConfigContent } from "./host.js";

export interface StoredObservation {
  schema: 1;
  actionKey: string;
  inputDigest: string;
  bundleDigest: string;
  commandId: string;
  evidenceClass: string;
  receipt: HostArtifact | null;
  settlement: AgentSettlement;
}
interface NativeReceipt {
  schema: number;
  receiptDigest: string;
  bundleDigest: string;
  evidenceClass: string;
  attempt: {
    commandId: string;
    runId: string;
    actionKey: string;
    inputDigest: string;
    deadline: number;
    versions: OpencodeConfig["versions"];
  };
  contract: {
    qualification: OpencodeConfig["qualification"];
    hostAdmission: unknown;
  };
  binary: { pinned: OpencodeConfig["binary"]; measuredC0: unknown };
  bundle: {
    argvSha256: string;
    envSha256: string;
    configContent: string;
    configContentSha256: string;
    inputSha256: string;
    cwd: string;
  };
  role: { role: string; agent: string; model: string; steps: number };
  limits: OpencodeConfig["limits"];
  timestamps: { preparedAt: number; settledAt: number };
  result: { final: AgentSettlement["proposal"] };
  lifecycle: { quiescent: boolean };
  exportAudit: { audit: OpencodeExportAudit; rawRetainedAt: string | null };
  usage: HarnessUsage;
  settlement: Pick<AgentSettlement, "classification" | "outcome" | "detail">;
  isolation: { drift: string[]; post: OpencodeIsolationInventory };
  head: { post: string };
}
export type AgentResult = Extract<Event, { type: "result" }>;
interface StoredExportObservation {
  schema: 1;
  commandId: string;
  runId: string;
  actionKey: string;
  inputDigest: string;
  bundleDigest: string;
  binary: OpencodeConfig["binary"];
  argv: string[];
  envSha256: string;
  cwd: string;
  rawPath: string;
  timeoutMs: number;
  maxExportBytes: number;
  observation: OpencodeExportObservation;
}
function retained(path: string, sha256: string, bytes: number, limit: number) {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size !== bytes ||
    bytes > limit
  )
    throw new Error("opencode-observation-artifact-metadata");
  const data = readFileSync(path);
  if (digest(data) !== sha256)
    throw new Error("opencode-observation-artifact-drift");
  return data;
}
/** Independent HOST admission from durable native records, not IPC/model-provided success. */
export function assertAgentObservation(
  store: Store,
  config: OpencodeConfig,
  plan: OpencodeLaunchPlan,
  result: AgentResult,
) {
  const saved = store.operatorRecord<StoredObservation>(
    "opencode-observation/" + plan.action.key,
  );
  return validateAgentObservation(store, config, plan, result, saved);
}
function validateAgentObservation(
  store: Store,
  config: OpencodeConfig,
  plan: OpencodeLaunchPlan,
  result: AgentResult,
  saved: StoredObservation | undefined,
  telemetry?: ReturnType<typeof nativeTelemetry>,
) {
  if (config.evidenceClass === "live-subscription") assertHostAdmission(config);
  assertBinaryIdentity(config.binary);
  assertOpencodeDataHomeIsolation(
    config.dataHome,
    config.hostIdentity.userHome,
  );
  if (
    !saved ||
    saved.schema !== 1 ||
    saved.actionKey !== plan.action.key ||
    saved.inputDigest !== plan.action.inputDigest ||
    saved.bundleDigest !== plan.bundle.bundleDigest ||
    saved.evidenceClass !== config.evidenceClass ||
    !saved.receipt
  )
    throw new Error("opencode-observation-not-retained");
  const command = store.command(saved.commandId);
  if (
    !command ||
    command.state !== "finished" ||
    command.duplex?.stdoutEof !== true ||
    command.duplex?.stderrEof !== true ||
    !command.group ||
    !groupAbsent(command.group) ||
    identity(command.duplex?.action) !== identity(plan.action) ||
    identity(command.duplex?.request) !==
      identity({
        action: plan.action,
        spec: plan.spec,
        limits: plan.limits,
        bundleDigest: plan.bundle.bundleDigest,
        binaryIdentity: plan.bundle.binary,
      })
  )
    throw new Error("opencode-observation-command-binding");
  const commandResult = command.result as unknown as CommandResult;
  const path = join(plan.paths.logs, `receipt-${command.id}.json`);
  if (saved.receipt.path !== path)
    throw new Error("opencode-observation-receipt-path");
  const receipt = parseStrictJson(
    retained(
      path,
      saved.receipt.sha256,
      saved.receipt.bytes,
      4 * 1024 * 1024,
    ).toString(),
  ) as NativeReceipt;
  assertReceiptBinding(receipt, config, plan, command.id);
  const currentInventory = inventoryOpencodeIsolation({
    config: { ...config, configDigest: identity(config) },
    paths: plan.paths,
    authProvisioned: true,
  });
  assertOpencodeIsolationAdmissible(currentInventory, {
    ...config,
    configDigest: identity(config),
  });
  if (identity(currentInventory) !== identity(receipt.isolation.post))
    throw new Error("opencode-observation-isolation-drift");
  if (
    config.hostAdmission &&
    dependencyInventory(join(plan.paths.configHome, "opencode")) !==
      config.hostAdmission.dependencies.inventorySha256
  )
    throw new Error("opencode-observation-dependency-drift");
  const suppliedDigest = receipt.receiptDigest;
  if (
    digest(canonical({ ...receipt, receiptDigest: "" })) !== suppliedDigest ||
    receipt.bundleDigest !== plan.bundle.bundleDigest ||
    receipt.attempt.actionKey !== plan.action.key ||
    receipt.attempt.inputDigest !== plan.action.inputDigest ||
    receipt.evidenceClass !== config.evidenceClass ||
    identity(receipt.contract.qualification) !== identity(config.qualification)
  )
    throw new Error("opencode-observation-receipt-binding");
  for (const name of ["stdout", "stderr"] as const) {
    const ref =
      name === "stdout"
        ? commandResult.stdoutArtifact
        : commandResult.stderrArtifact;
    if (
      !ref ||
      commandResult[name] !== join(plan.paths.logs, command.id, name + ".log")
    )
      throw new Error("opencode-observation-raw-missing");
    retained(
      commandResult[name],
      ref.sha256,
      ref.bytes,
      name === "stdout"
        ? config.limits.maxStdoutBytes
        : config.limits.maxStderrBytes,
    );
  }
  const { verdict, audit, usage } =
    telemetry ?? nativeTelemetry(store, config, plan, command, receipt);
  if (
    result.quiescent !== true ||
    verdict.settlement !== "complete" ||
    !verdict.stepStartCount ||
    !verdict.stepFinishCount ||
    !verdict.sessionId ||
    !verdict.final ||
    !audit
  )
    throw new Error("opencode-first-observation-stream-or-export");
  if (
    !audit.ok ||
    receipt.exportAudit.audit?.ok !== true ||
    identity(audit) !== identity(receipt.exportAudit.audit) ||
    audit.divergence ||
    usage.status !== "reported" ||
    identity(usage) !== identity(result.usage) ||
    identity(usage) !== identity(receipt.usage) ||
    receipt.settlement.classification !== "complete" ||
    receipt.settlement.outcome !== result.outcome ||
    identity(receipt.result.final) !== identity(verdict.final) ||
    receipt.isolation.drift.length ||
    result.actionKey !== plan.action.key ||
    result.inputDigest !== plan.action.inputDigest
  )
    throw new Error("opencode-first-observation-usage-or-lifecycle");
  const head = deriveTreeHead(plan.paths.src, config.limits.maxTreeNodes);
  if (
    head !== result.head ||
    head !== receipt.head.post ||
    (verdict.final as { outcome: string }).outcome !== result.outcome
  )
    throw new Error("opencode-observation-host-head");
  return {
    commandId: command.id,
    receipt: saved.receipt,
    evidenceClass: config.evidenceClass,
    admission:
      config.evidenceClass === "live-subscription"
        ? "native-first-observation-passed"
        : "owned-fake-only",
  };
}

/** Reconstruct usage from the durable native stream and retained export, including negative
 * settlements that honestly retain measured usage after a later host refusal. */
function nativeTelemetry(
  store: Store,
  config: OpencodeConfig,
  plan: OpencodeLaunchPlan,
  command: CommandRecord,
  receipt: NativeReceipt,
) {
  const commandResult = command.result as unknown as CommandResult;
  const decoder = new StrictNdjsonDecoder(plan.streamLimits);
  let decodeError: string | null = null;
  try {
    decoder.push(readFileSync(commandResult.stdout));
    decoder.end();
  } catch (error) {
    decodeError = (error as Error).message || "strict-decode-failed";
  }
  const d = command.duplex!;
  const verdict = classifyOpencodeStream({
    frames: decoder.frames,
    decodeError,
    expectations: plan.expectations,
    binding: {
      actionKey: plan.action.key,
      inputDigest: plan.action.inputDigest,
    },
    lifecycle: {
      exitCode: commandResult.exitCode,
      signal: commandResult.signal,
      stdoutEof: d.stdoutEof,
      stderrEof: d.stderrEof,
      childStdoutEof: d.childStdoutEof === true,
      childStderrEof: d.childStderrEof === true,
      decoderComplete: d.decoderComplete === true,
      transportFailure: d.failure,
      stdoutTruncated: commandResult.stdoutTruncated,
      stderrTruncated: commandResult.stderrTruncated,
      stderrBytes: commandResult.stderrArtifact!.bytes,
      quiescent: command.state === "finished" && d.stdoutEof && d.stderrEof,
    },
  });

  const exportPath = join(plan.paths.logs, `export-${command.id}.json`);
  const proof = store.operatorRecord<StoredExportObservation>(
    "opencode-export-observation/" + command.id,
  );
  if (
    proof &&
    (proof.schema !== 1 ||
      proof.commandId !== command.id ||
      proof.runId !== plan.action.runId ||
      proof.actionKey !== plan.action.key ||
      proof.inputDigest !== plan.action.inputDigest ||
      proof.bundleDigest !== plan.bundle.bundleDigest ||
      identity(proof.binary) !== identity(plan.bundle.binary) ||
      identity(proof.argv) !== identity(["export", verdict.sessionId]) ||
      proof.envSha256 !== digest(canonical(plan.bundle.env)) ||
      proof.cwd !== plan.paths.src ||
      proof.rawPath !== exportPath ||
      proof.timeoutMs !== config.limits.exportTimeoutMs ||
      proof.maxExportBytes !== config.limits.maxExportBytes)
  )
    throw new Error("opencode-replay-export-binding");
  const hasRaw = existsSync(exportPath) && !lstatSync(exportPath).isDirectory();
  let audit: OpencodeExportAudit | null = null;
  if (hasRaw) {
    if (!verdict.sessionId) throw new Error("opencode-replay-export-binding");
    // Older receipts lack an exporter observation. Discover and audit their actual bounded
    // file first; the receipt's export pointer/audit can only be compared afterwards.
    const stat = lstatSync(exportPath);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > config.limits.maxExportBytes
    )
      throw new Error("opencode-replay-export-binding");
    const info = proof?.observation ?? {
      rawSha256: digest(readFileSync(exportPath)),
      rawBytes: stat.size,
    };
    if (!info?.rawSha256) throw new Error("opencode-replay-export-binding");
    const raw = retained(
      exportPath,
      info.rawSha256,
      info.rawBytes,
      config.limits.maxExportBytes,
    ).toString();
    const [providerID, modelID] = config.roles[plan.role].model.split("/");
    const expectations = {
      sessionId: verdict.sessionId,
      version: config.binary.version,
      directory: plan.paths.src,
      providerID: providerID!,
      modelID: modelID!,
      summedTokens: verdict.summedTokens,
    };
    audit = proof
      ? auditObservedOpencodeExport(raw, proof.observation, expectations)
      : auditOpencodeExport(raw, expectations);
  } else if (proof) {
    const facts = proof.observation;
    if (
      facts.rawRetained ||
      facts.audit.ok ||
      facts.audit.reason !== "export-retention-failed" ||
      facts.audit.rawSha256 !== facts.rawSha256 ||
      facts.audit.rawBytes !== facts.rawBytes
    )
      throw new Error("opencode-replay-export-raw-unavailable");
    audit = facts.audit;
  }
  if (
    identity(audit) !== identity(receipt.exportAudit.audit) ||
    (audit !== null && receipt.exportAudit.rawRetainedAt !== exportPath) ||
    (audit === null && receipt.exportAudit.rawRetainedAt !== null) ||
    (proof && identity(audit) !== identity(proof.observation.audit))
  )
    throw new Error("opencode-replay-native-telemetry-export-conflict");
  const interruption =
    d.revoked || commandResult.outcome === "cancelled"
      ? "opencode-cancelled-sigterm"
      : commandResult.outcome === "timeout"
        ? "opencode-deadline-exceeded"
        : commandResult.outcome === "lease-lost"
          ? "opencode-lease-lost"
          : null;
  const usage = interruption
    ? unknownHarnessUsage("opencode", interruption)
    : verdict.settlement !== "complete"
      ? unknownHarnessUsage(
          "opencode",
          `opencode-${verdict.settlement}-before-usage-mapping:${verdict.reasons[0] ?? "unsettled"}`,
        )
      : mapOpencodeUsage({
          lifecycleResolved: verdict.resolvedLifecycle,
          audit,
          summedTokens: verdict.summedTokens,
        });
  return { verdict, audit, usage, interruption };
}
/** Receipt labels cannot decide whether native telemetry is inspected. This pure comparison
 * follows evidence reconstruction and preserves unavailable/cancelled source observations. */
function assertNegativeTelemetry(
  settlement: AgentSettlement,
  telemetry: ReturnType<typeof nativeTelemetry>,
) {
  const { verdict, audit, usage, interruption } = telemetry;
  if (identity(usage) !== identity(settlement.usage))
    throw new Error("opencode-replay-negative-usage-or-proposal");
  if (interruption) {
    if (
      settlement.classification !== "interrupted" ||
      settlement.outcome !== "interrupted" ||
      settlement.proposal !== null
    )
      throw new Error("opencode-replay-negative-usage-or-proposal");
    return;
  }
  if (verdict.settlement === "complete" && audit?.ok) {
    if (
      !["complete", "unresolved"].includes(settlement.classification) ||
      (settlement.classification === "unresolved" &&
        settlement.outcome !== "failed") ||
      identity(verdict.final) !== identity(settlement.proposal) ||
      (settlement.classification === "complete" &&
        (verdict.final as { outcome: string }).outcome !== settlement.outcome)
    )
      throw new Error("opencode-replay-negative-usage-or-proposal");
    return;
  }
  const classification =
    verdict.settlement === "complete"
      ? audit && !audit.ok && audit.fatal
        ? "fatal"
        : "unresolved"
      : verdict.settlement;
  const outcome =
    verdict.settlement === "complete" ||
    verdict.resolvedLifecycle ||
    ["fatal", "policy-denied"].includes(classification)
      ? "failed"
      : "interrupted";
  if (
    settlement.classification !== classification ||
    settlement.outcome !== outcome ||
    settlement.proposal !== null
  )
    throw new Error("opencode-replay-negative-usage-or-proposal");
}
function assertSettlementShape(receipt: NativeReceipt) {
  const { classification, outcome } = receipt.settlement;
  const outcomes: Record<string, readonly string[]> = {
    complete: ["changed", "complete", "no_code", "failed"],
    fatal: ["failed"],
    "policy-denied": ["failed"],
    unresolved: ["failed", "interrupted"],
    interrupted: ["interrupted"],
  };
  if (
    typeof classification !== "string" ||
    typeof outcome !== "string" ||
    !Object.hasOwn(outcomes, classification) ||
    !outcomes[classification]!.includes(outcome) ||
    receipt.usage.schema !== 2 ||
    receipt.usage.harness !== "opencode" ||
    typeof receipt.lifecycle.quiescent !== "boolean"
  )
    throw new Error("opencode-replay-settlement-shape");
  validateUsage(receipt.usage);
}

function assertReceiptBinding(
  receipt: NativeReceipt,
  config: OpencodeConfig,
  plan: OpencodeLaunchPlan,
  commandId: string,
) {
  assertSettlementShape(receipt);
  if (
    receipt.schema !== 1 ||
    digest(canonical({ ...receipt, receiptDigest: "" })) !==
      receipt.receiptDigest ||
    receipt.attempt.commandId !== commandId ||
    receipt.attempt.runId !== plan.action.runId ||
    receipt.attempt.actionKey !== plan.action.key ||
    receipt.attempt.inputDigest !== plan.action.inputDigest ||
    receipt.attempt.deadline !== plan.action.deadline ||
    identity(receipt.attempt.versions) !== identity(plan.action.versions) ||
    receipt.bundleDigest !== plan.bundle.bundleDigest ||
    receipt.evidenceClass !== config.evidenceClass ||
    identity(receipt.contract.qualification) !==
      identity(config.qualification) ||
    identity(receipt.contract.hostAdmission) !==
      identity(config.hostAdmission ?? null) ||
    identity(receipt.binary.pinned) !== identity(config.binary) ||
    identity(receipt.binary.measuredC0) !== identity(plan.binaryC0) ||
    receipt.bundle.argvSha256 !== digest(canonical(plan.bundle.argv)) ||
    receipt.bundle.envSha256 !== digest(canonical(plan.bundle.env)) ||
    receipt.bundle.inputSha256 !== plan.bundle.input.sha256 ||
    digest(plan.prompt.text) !== plan.bundle.input.sha256 ||
    Buffer.byteLength(plan.prompt.text) !== plan.bundle.input.bytes ||
    receipt.bundle.cwd !== plan.paths.src ||
    receipt.bundle.configContent !== plan.configContent ||
    plan.configContent !== roleConfigContent(config) ||
    digest(plan.configContent) !== plan.configContentSha256 ||
    receipt.bundle.configContentSha256 !== plan.configContentSha256 ||
    receipt.role.role !== plan.role ||
    receipt.role.agent !== "rocky-" + plan.role ||
    receipt.role.model !== config.roles[plan.role].model ||
    receipt.role.steps !== config.roles[plan.role].steps ||
    identity(receipt.limits) !== identity(config.limits) ||
    receipt.timestamps.preparedAt !== plan.preparedAt ||
    !Number.isSafeInteger(receipt.timestamps.settledAt)
  )
    throw new Error("opencode-observation-receipt-binding");
}
/** Terminal reconciliation reads immutable proof; it never launches native/export work. */
export function reconcileRetainedObservation(
  store: Store,
  config: OpencodeConfig,
  plan: OpencodeLaunchPlan,
  commandId: string,
  quiescent: boolean,
): StoredObservation | null {
  const key = "opencode-observation/" + plan.action.key,
    saved = store.operatorRecord<StoredObservation>(key);
  const path = join(plan.paths.logs, `receipt-${commandId}.json`);
  const exportPath = join(plan.paths.logs, `export-${commandId}.json`);
  const retainedExport =
    existsSync(exportPath) && !lstatSync(exportPath).isDirectory();
  if (!saved && !existsSync(path)) {
    if (retainedExport) throw new Error("opencode-replay-receipt-missing");
    return null;
  }
  // A first-write directory obstacle is not a retained receipt. Let the initial
  // settlement preserve measured usage and report its original retention failure.
  if (!saved && lstatSync(path).isDirectory() && !retainedExport) return null;
  if (saved && (!saved.receipt || saved.receipt.path !== path))
    throw new Error("opencode-replay-proof-unavailable");
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o7777) !== 0o600 ||
    stat.nlink !== 1 ||
    stat.size > 4 * 1024 * 1024
  )
    throw new Error("opencode-replay-proof-metadata");
  const bytes = readFileSync(path),
    ref = saved?.receipt ?? {
      path,
      sha256: digest(bytes),
      bytes: bytes.length,
    };
  retained(path, ref.sha256, ref.bytes, 4 * 1024 * 1024);
  const receipt = parseStrictJson(bytes.toString()) as NativeReceipt;
  assertReceiptBinding(receipt, config, plan, commandId);
  const command = store.command(commandId);
  if (
    !quiescent ||
    !command ||
    command.state !== "finished" ||
    command.duplex?.stdoutEof !== true ||
    command.duplex.stderrEof !== true ||
    !command.group ||
    !groupAbsent(command.group) ||
    identity(command.duplex.action) !== identity(plan.action) ||
    identity(command.duplex.request) !==
      identity({
        action: plan.action,
        spec: plan.spec,
        limits: plan.limits,
        bundleDigest: plan.bundle.bundleDigest,
        binaryIdentity: plan.bundle.binary,
      })
  )
    throw new Error("opencode-replay-physical-or-command-binding");
  assertBinaryIdentity(config.binary);
  if (config.evidenceClass === "live-subscription") assertHostAdmission(config);
  assertOpencodeDataHomeIsolation(
    config.dataHome,
    config.hostIdentity.userHome,
  );
  const inventory = inventoryOpencodeIsolation({
    config: { ...config, configDigest: identity(config) },
    paths: plan.paths,
    authProvisioned: true,
  });
  assertOpencodeIsolationAdmissible(inventory, {
    ...config,
    configDigest: identity(config),
  });
  if (
    identity(inventory) !== identity(receipt.isolation.post) ||
    deriveTreeHead(plan.paths.src, config.limits.maxTreeNodes) !==
      receipt.head.post
  )
    throw new Error("opencode-replay-c5-drift");
  const result = command.result as unknown as CommandResult;
  for (const name of ["stdout", "stderr"] as const) {
    const artifact =
      name === "stdout" ? result.stdoutArtifact : result.stderrArtifact;
    if (
      !artifact ||
      result[name] !== join(plan.paths.logs, command.id, name + ".log")
    )
      throw new Error("opencode-replay-raw-missing");
    retained(
      result[name],
      artifact.sha256,
      artifact.bytes,
      name === "stdout"
        ? config.limits.maxStdoutBytes
        : config.limits.maxStderrBytes,
    );
  }
  const settlement: AgentSettlement = {
    schema: 1,
    harness: "opencode",
    classification: receipt.settlement.classification,
    outcome: receipt.settlement.outcome,
    detail: receipt.settlement.detail,
    quiescent: receipt.lifecycle.quiescent,
    usage: receipt.usage,
    head: receipt.head.post,
    proposal: receipt.result.final,
  };
  const observation: StoredObservation = {
    schema: 1,
    actionKey: plan.action.key,
    inputDigest: plan.action.inputDigest,
    bundleDigest: plan.bundle.bundleDigest,
    commandId,
    evidenceClass: config.evidenceClass,
    receipt: ref,
    settlement,
  };
  if (saved && identity(saved) !== identity(observation))
    throw new Error("opencode-replay-observation-conflict");
  const telemetry = nativeTelemetry(store, config, plan, command, receipt);
  const event = settlementToResultEvent(settlement, plan.action);
  if (["changed", "complete", "no_code"].includes(settlement.outcome))
    validateAgentObservation(
      store,
      config,
      plan,
      event,
      observation,
      telemetry,
    );
  else assertNegativeTelemetry(settlement, telemetry);
  store.retainOperatorRecord(key, observation);
  return observation;
}
