import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { digest, identity, canonical } from "../../store/json.js";
import type { Store } from "../../store/index.js";
import type { Event, HarnessUsage } from "../../coordinator/contracts.js";
import type { OpencodeConfig } from "./config.js";
import type { OpencodeLaunchPlan } from "./adapter.js";
import { deriveTreeHead, StrictNdjsonDecoder } from "../seam.js";
import { classifyOpencodeStream } from "./stream.js";
import { auditOpencodeExport } from "./export.js";
import { mapOpencodeUsage } from "./usage.js";
import { assertBinaryIdentity } from "../../runner/process.js";
import type { CommandResult } from "../../runner/index.js";
import type { AgentSettlement } from "../seam.js";
import type { OpencodeExportAudit } from "./export.js";
import type { HostArtifact } from "./host.js";
import {
  assertOpencodeDataHomeIsolation,
  inventoryOpencodeIsolation,
  assertOpencodeIsolationAdmissible,
  type OpencodeIsolationInventory,
} from "./launch.js";
import { dependencyInventory } from "./dependencies.js";
import { assertHostAdmission } from "./host.js";

interface StoredObservation {
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
  receiptDigest: string;
  bundleDigest: string;
  evidenceClass: string;
  attempt: { actionKey: string; inputDigest: string };
  contract: { qualification: OpencodeConfig["qualification"] };
  lifecycle: { quiescent: boolean };
  exportAudit: { audit: OpencodeExportAudit; rawRetainedAt: string | null };
  usage: HarnessUsage;
  settlement: { classification: string; outcome: string };
  isolation: { drift: string[]; post: OpencodeIsolationInventory };
  head: { post: string };
}
export type AgentResult = Extract<Event, { type: "result" }>;
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
  if (config.evidenceClass === "live-subscription") assertHostAdmission(config);
  assertBinaryIdentity(config.binary);
  assertOpencodeDataHomeIsolation(
    config.dataHome,
    config.hostIdentity.userHome,
  );
  const saved = store.operatorRecord<StoredObservation>(
    "opencode-observation/" + plan.action.key,
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
  const receipt = JSON.parse(
    retained(
      path,
      saved.receipt.sha256,
      saved.receipt.bytes,
      4 * 1024 * 1024,
    ).toString(),
  ) as NativeReceipt;
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
  const decoder = new StrictNdjsonDecoder(plan.streamLimits);
  decoder.push(readFileSync(commandResult.stdout));
  decoder.end();
  const d = command.duplex!;
  const verdict = classifyOpencodeStream({
    frames: decoder.frames,
    decodeError: null,
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
      quiescent: result.quiescent && receipt.lifecycle.quiescent === true,
    },
  });
  if (
    verdict.settlement !== "complete" ||
    !verdict.stepStartCount ||
    !verdict.stepFinishCount ||
    !verdict.sessionId ||
    !verdict.final
  )
    throw new Error("opencode-first-observation-stream");
  const exportPath = join(plan.paths.logs, `export-${command.id}.json`);
  const exportInfo = receipt.exportAudit.audit;
  if (receipt.exportAudit.rawRetainedAt !== exportPath || !exportInfo?.ok)
    throw new Error("opencode-first-observation-export");
  const exported = retained(
    exportPath,
    exportInfo.rawSha256,
    exportInfo.rawBytes,
    config.limits.maxExportBytes,
  ).toString();
  const [providerID, modelID] = config.roles[plan.role].model.split("/");
  const audit = auditOpencodeExport(exported, {
    sessionId: verdict.sessionId,
    version: config.binary.version,
    directory: plan.paths.src,
    providerID: providerID!,
    modelID: modelID!,
    summedTokens: verdict.summedTokens,
  });
  const usage = mapOpencodeUsage({
    lifecycleResolved: verdict.resolvedLifecycle,
    audit,
    summedTokens: verdict.summedTokens,
  });
  if (
    !audit.ok ||
    audit.divergence ||
    usage.status !== "reported" ||
    identity(usage) !== identity(result.usage) ||
    identity(usage) !== identity(receipt.usage) ||
    receipt.settlement.classification !== "complete" ||
    receipt.settlement.outcome !== result.outcome ||
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
