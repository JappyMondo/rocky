import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { canonical, digest, type Json } from "../../store/json.js";
import type { AgentSettlement } from "../seam.js";
import type { BinaryIdentity } from "../../runner/process.js";
import type { CommandRecord } from "../../store/index.js";
import type { ValidatedClaudeCodeConfig } from "./config.js";
import type { ClaudeDiscoveryInventory } from "./discovery.js";
import { claudeKeychainServiceName } from "./discovery.js";
import type { ClaudeRunPaths } from "./paths.js";
import type { AgentLaunchPlan } from "./adapter.js";
import type { ClaudeStreamVerdict } from "./stream.js";

/**
 * Receipt assembly per acceptance/claude-code manifest receiptRequirements (CC12). Every field is
 * a measured observation or an explicitly recorded gap; unobservable requirements are honest
 * `unknown` entries referencing their gates, never fabricated evidence.
 */
export interface ClaudeReceiptInput {
  plan: AgentLaunchPlan;
  record: CommandRecord;
  verdict: ClaudeStreamVerdict | null;
  settlement: AgentSettlement;
  config: ValidatedClaudeCodeConfig;
  paths: ClaudeRunPaths;
  binaryC0: BinaryIdentity;
  binaryC5: BinaryIdentity | { unavailable: string };
  inventoryPre: ClaudeDiscoveryInventory;
  inventoryPost: ClaudeDiscoveryInventory;
  drift: string[];
  decodeError: string | null;
  settledAt: number;
}
export function assembleClaudeReceipt(input: ClaudeReceiptInput): Json {
  const { plan, record, verdict, settlement, config } = input;
  const duplex = record.duplex;
  const result = record.result as {
    outcome: string;
    exitCode: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
    stdoutArtifact?: { sha256: string; bytes: number };
    stderrArtifact?: { sha256: string; bytes: number };
    cleanupError?: string;
  } | null;
  const stderrBytes = result ? safeSize(result.stderr) : 0;
  const initFields = verdict?.init
    ? pick(verdict.init, [
        "session_id",
        "apiKeySource",
        "claude_code_version",
        "cwd",
        "tools",
        "mcp_servers",
        "model",
        "permissionMode",
        "skills",
        "plugins",
        "slash_commands",
      ])
    : null;
  const resultFields = verdict?.result
    ? pick(verdict.result, [
        "subtype",
        "is_error",
        "terminal_reason",
        "permission_denials",
        "modelUsage",
        "structured_output",
        "result_index",
        "startup_failure_reason",
        "num_turns",
        "total_cost_usd",
      ])
    : null;
  const modelUsageRaw = (verdict?.result?.modelUsage ?? null) as Json;
  const receipt: Record<string, unknown> = {
    schema: 1,
    contract: {
      contractId: config.contract.contractId,
      manifestSha256: config.contract.manifestSha256,
      scenariosSha256: config.contract.scenariosSha256,
      frozenSha256: config.contract.frozenSha256,
      approvalReference: config.contract.approvalReference,
    },
    evidenceClass: config.evidenceClass,
    attempt: {
      commandId: record.id,
      actionKey: plan.action.key,
      inputDigest: plan.action.inputDigest,
      runId: plan.action.runId,
      lease: record.lease,
      fence: record.lease.fence,
      versions: plan.action.versions,
      deadline: plan.action.deadline,
    },
    binary: {
      pinned: config.binary,
      measuredC0: input.binaryC0,
      c1Rule:
        "gate re-measures sha256/size inside the guarded start; drift records a durable failure and zero spawn",
      measuredC5: input.binaryC5,
    },
    bundleDigest: plan.bundle.bundleDigest,
    bundle: {
      argv: plan.bundle.argv,
      env: plan.bundle.env,
      cwd: plan.bundle.cwd,
      input: plan.bundle.input,
      files: plan.bundle.files,
      discoveryDigest: plan.bundle.discoveryDigest,
    },
    authHome: {
      mode: "dedicated",
      configDir: config.configDir,
      keychainServiceName: claudeKeychainServiceName(config.configDir),
      credentialReadCopySymlinkProxy: false,
    },
    discovery: {
      pre: input.inventoryPre,
      post: input.inventoryPost,
      drift: input.drift,
      configDirChildrenGained: input.inventoryPost.configDirChildren.filter(
        (name) => !input.inventoryPre.configDirChildren.includes(name),
      ),
    },
    initIdentity: initFields,
    stream: {
      framesObserved: verdict?.framesObserved ?? duplex?.frames.length ?? 0,
      transportFramesRetained: duplex?.frames.length ?? 0,
      outputBytes: duplex?.outputBytes ?? 0,
      inputBytes: duplex?.inputBytes ?? 0,
      decodeError: input.decodeError,
      transportFailure: duplex?.failure ?? null,
      stdoutTruncated: result?.stdoutTruncated ?? false,
      stderrTruncated: result?.stderrTruncated ?? false,
      stderrBytes,
      stdoutArtifact: result?.stdoutArtifact ?? null,
      stderrArtifact: result?.stderrArtifact ?? null,
      rawStdoutLog: result?.stdout ?? null,
      rawStderrLog: result?.stderr ?? null,
      apiRetries: verdict?.apiRetries ?? [],
      permissionDeniedEvents: verdict?.permissionDeniedEvents ?? [],
      ordinaryFailures: verdict?.ordinaryFailures ?? [],
      toolUseCount: verdict?.toolUseCount ?? 0,
      sends: (duplex?.sends ?? []).map((s) => ({
        key: s.key,
        state: s.state,
        end: s.end,
        attempted: s.attempted ?? false,
      })),
      revoked: duplex?.revoked ?? false,
    },
    result: {
      fields: resultFields,
      modelUsageRaw,
      modelUsageSha256:
        modelUsageRaw === null ? null : digest(JSON.stringify(modelUsageRaw)),
      resultIndexContinuity: verdict
        ? verdict.reasons.filter((r) => r.startsWith("result-index"))
        : [],
      proposal: settlement.proposal,
    },
    lifecycle: {
      commandOutcome: result?.outcome ?? record.state,
      exitCode: result?.exitCode ?? null,
      signal: result?.signal ?? null,
      stdoutEof: duplex?.stdoutEof ?? false,
      stderrEof: duplex?.stderrEof ?? false,
      childStdoutEof: duplex?.childStdoutEof ?? false,
      childStderrEof: duplex?.childStderrEof ?? false,
      decoderComplete: duplex?.decoderComplete ?? false,
      cleanupError: result?.cleanupError ?? null,
      quiescent: settlement.quiescent,
    },
    settlement: {
      classification: settlement.classification,
      outcome: settlement.outcome,
      detail: settlement.detail,
      reasons: verdict?.reasons ?? [],
    },
    usage: settlement.usage,
    head: { pre: plan.headPre, post: settlement.head },
    timestamps: {
      preparedAt: plan.preparedAt,
      commandCreatedAt: record.createdAt,
      settledAt: input.settledAt,
    },
    limits: config.limits,
    gaps: claudeReceiptGaps(config, verdict),
    receiptDigest: "",
  };
  // canonical() fail-closes on any non-plain value; the digest binds the exact receipt bytes.
  const canonicalBytes = canonical(receipt);
  const frozen = JSON.parse(canonicalBytes) as Record<string, Json>;
  return { ...frozen, receiptDigest: digest(canonicalBytes) };
}
/** Honest gaps: surfaces that are not observable in the stream or not established by this
 * evidence class, each bound to its open gate. Never a qualified claim. */
export function claudeReceiptGaps(
  config: ValidatedClaudeCodeConfig,
  verdict: ClaudeStreamVerdict | null,
): { gate: string; gap: string }[] {
  const gaps = [
    {
      gate: "G-SET",
      gap: "effective sandbox state is not observable in the stream; settings validity proof and per-run positive control remain gated",
    },
    {
      gate: "G-EFFORT",
      gap: "effort is requested-only and never echoed; no claim of applied effort is made",
    },
    {
      gate: "G-INIT-VALUES",
      gap: "exact init tools/skills/slash_commands expectations are config-frozen host approvals, not natively proven values",
    },
    {
      gate: "G-MODEL",
      gap: "role-table model IDs are host-frozen config; the served model is only read from modelUsage keys and assistant.message.model",
    },
    {
      gate: "G-KC",
      gap: "user-accepted limitation (2026-09-28, #95/883, #1/884): a model-run shell MAY reach the subscription keychain item; not a containment claim",
    },
    {
      gate: "G-SIGINT",
      gap: "cancellation is SIGTERM-only; SIGINT frames/exit remain unobserved",
    },
    {
      gate: "G-WRITES",
      gap: "configDir writes despite --no-session-persistence are inventoried by name, not bounded natively",
    },
  ];
  if (config.evidenceClass !== "live-subscription")
    gaps.push({
      gate: "L01-L04",
      gap: "live subscription qualification is a separate root-granted step; this receipt is not live evidence",
    });
  if (config.evidenceClass === "owned-fake-cli")
    gaps.push({
      gate: "N01-N06",
      gap: "native behavior (discovery sealing, role/sandbox matrix, settings silent-ignore, lifecycle probes) is unproven; the child is an owned fake CLI",
    });
  if (!verdict?.initObserved)
    gaps.push({
      gate: "CC05",
      gap: "system/init not observed: prompt consumption is unproven; the attempt stays attempted-unknown with no resend",
    });
  return gaps;
}
function pick(
  source: Record<string, unknown>,
  keys: string[],
): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const key of keys)
    out[key] = (source[key] === undefined ? null : source[key]) as Json;
  return out;
}
function safeSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    try {
      return readFileSync(path).length;
    } catch {
      return 0;
    }
  }
}
export function claudeReceiptPath(paths: ClaudeRunPaths, commandId: string) {
  return join(paths.logs, `receipt-${commandId}.json`);
}
