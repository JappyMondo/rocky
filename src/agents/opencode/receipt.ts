import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { canonical, digest, type Json } from "../../store/json.js";
import type { AgentSettlement } from "../seam.js";
import type { BinaryIdentity } from "../../runner/process.js";
import type { CommandRecord } from "../../store/index.js";
import type { ValidatedOpencodeConfig } from "./config.js";
import type { OpencodeIsolationInventory, OpencodeRunPaths } from "./launch.js";
import type { OpencodeExportAudit } from "./export.js";
import type { OpencodeStreamVerdict } from "./stream.js";

/**
 * Lean receipt (Taskbot #98): every field is a measured observation or an explicitly recorded
 * gap; unobservable surfaces are honest `unknown`/gap entries referencing their #104 gates, never
 * fabricated evidence. Identity (pinned + C0/C5 measured), the immutable bundle (argv/env digests,
 * sealed config content digest), the isolation inventory pre/post with drift, stream + export-audit
 * summaries, settlement, usage, host-derived head and the open-gates list.
 */
export interface OpencodeReceiptInput {
  actionKey: string;
  inputDigest: string;
  runId: string;
  deadline: number;
  role: string;
  model: string;
  agent: string;
  paths: OpencodeRunPaths;
  record: CommandRecord;
  verdict: OpencodeStreamVerdict | null;
  settlement: AgentSettlement;
  config: ValidatedOpencodeConfig;
  binaryC0: BinaryIdentity;
  binaryC5: BinaryIdentity | { unavailable: string };
  inventoryPre: OpencodeIsolationInventory;
  inventoryPost: OpencodeIsolationInventory;
  drift: string[];
  configContent: string;
  configContentSha256: string;
  argvSha256: string;
  envSha256: string;
  inputSha256: string;
  bundleDigest: string;
  exportAudit: OpencodeExportAudit | null;
  exportRawPath: string | null;
  decodeError: string | null;
  headPre: string;
  preparedAt: number;
  settledAt: number;
}
export function assembleOpencodeReceipt(input: OpencodeReceiptInput): Json {
  const { record, verdict, settlement, config } = input;
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
  const receipt: Record<string, unknown> = {
    schema: 1,
    contract: {
      contractId: config.qualification.contractId,
      qualification: config.qualification,
      hostAdmission: config.hostAdmission ?? null,
      approvalReference:
        "none: PoC identity, no protected-contract ceremony (user decision 2026-09-29; #106/#107 cancelled)",
    },
    evidenceClass: config.evidenceClass,
    attempt: {
      commandId: record.id,
      actionKey: input.actionKey,
      inputDigest: input.inputDigest,
      runId: input.runId,
      lease: record.lease,
      fence: record.lease.fence,
      versions: record.lease.versions,
      deadline: input.deadline,
    },
    role: {
      role: input.role,
      agent: input.agent,
      model: input.model,
      steps:
        config.roles[input.role as "implementer" | "reviewer"]?.steps ?? null,
    },
    binary: {
      pinned: config.binary,
      measuredC0: input.binaryC0,
      c1Rule:
        "gate re-measures sha256/size inside the guarded start; drift records a durable failure and zero spawn",
      measuredC5: input.binaryC5,
    },
    bundleDigest: input.bundleDigest,
    bundle: {
      argvSha256: input.argvSha256,
      envSha256: input.envSha256,
      configContent: input.configContent,
      configContentSha256: input.configContentSha256,
      inputSha256: input.inputSha256,
      cwd: input.paths.src,
    },
    isolation: {
      dataHome: config.dataHome,
      sharedUserDataDirMode: "unrepresentable (fail-closed path comparison)",
      authProvisioned: input.inventoryPre.authProvisioned,
      credentialReadCopySymlinkProxy: false,
      pre: input.inventoryPre,
      post: input.inventoryPost,
      drift: input.drift,
    },
    stream: {
      framesObserved: verdict?.framesObserved ?? 0,
      sessionId: verdict?.sessionId ?? null,
      textPartCount: verdict?.textPartCount ?? 0,
      toolUseCount: verdict?.toolUseCount ?? 0,
      stepStartCount: verdict?.stepStartCount ?? 0,
      stepFinishCount: verdict?.stepFinishCount ?? 0,
      summedTokens: verdict?.summedTokens ?? null,
      errorEvents: verdict?.errorEvents ?? [],
      policyDenials: verdict?.policyDenials ?? [],
      offRosterTools: verdict?.offRosterTools ?? [],
      ordinaryFailures: verdict?.ordinaryFailures ?? [],
      decodeError: input.decodeError,
      transportFailure: duplex?.failure ?? null,
      stdoutTruncated: result?.stdoutTruncated ?? false,
      stderrTruncated: result?.stderrTruncated ?? false,
      stderrBytes: result ? safeSize(result.stderr) : 0,
      stdoutArtifact: result?.stdoutArtifact ?? null,
      stderrArtifact: result?.stderrArtifact ?? null,
      rawStdoutLog: result?.stdout ?? null,
      rawStderrLog: result?.stderr ?? null,
      sends: (duplex?.sends ?? []).map((s) => ({
        key: s.key,
        state: s.state,
        end: s.end,
        attempted: s.attempted ?? false,
      })),
      revoked: duplex?.revoked ?? false,
    },
    exportAudit: {
      requiredForSuccess: true,
      ran: input.exportAudit !== null,
      audit: input.exportAudit,
      rawRetainedAt: input.exportRawPath,
      authority:
        "evidence-about-the-run, second bounded process after quiescence in the same sealed env (G-EXPORT-AUTHORITY)",
    },
    result: {
      final: settlement.proposal,
      finalRawText: verdict?.finalRawText ?? null,
      finalRawTextSha256:
        verdict?.finalRawText == null
          ? null
          : digest(Buffer.from(verdict.finalRawText, "utf8")),
      proposalAuthority:
        "proposal only; never authoritative checks/CI/review/head (host deriveTreeHead only)",
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
    head: { pre: input.headPre, post: settlement.head },
    timestamps: {
      preparedAt: input.preparedAt,
      commandCreatedAt: record.createdAt,
      settledAt: input.settledAt,
    },
    limits: config.limits,
    gaps: opencodeReceiptGaps(config, verdict),
    receiptDigest: "",
  };
  const canonicalBytes = canonical(receipt);
  const frozen = JSON.parse(canonicalBytes) as Record<string, Json>;
  return { ...frozen, receiptDigest: digest(canonicalBytes) };
}
/** Honest open gates, each traceable to #104 research. Never a qualified claim. */
export function opencodeReceiptGaps(
  config: ValidatedOpencodeConfig,
  verdict: OpencodeStreamVerdict | null,
): { gate: string; gap: string }[] {
  const gaps = [
    {
      gate: "G-SIG",
      gap: "signal semantics unprobed (F24 [P]): cancellation is SIGTERM-only via the owned group, exit-by-signal ⇒ unknown, late stdout ignored, and no interrupt acknowledgement is ever claimed",
    },
    {
      gate: "G-USAGE-COMPONENTS",
      gap: "whether export aggregate output already includes reasoning/cache components is unproven (F25 [P]); subsets are passed through as observed and never added to the total",
    },
    {
      gate: "G-NPM",
      gap: config.hostAdmission
        ? "The verified dependency template was pre-materialized and checked C0/C1/C5; full native install/write behavior remains unqualified"
        : "config bootstrap can background-install @opencode-ai/plugin into config dirs (F14b); the per-action CFG is fresh and inventoried, not pre-materialized — live runs require the pre-materialization proof",
    },
    {
      gate: "G-WRITES",
      gap: "native startup and run writes are not proven confined to the isolated HOME/XDG/DB/SRC tree; pre/post inventory records bounded surfaces but is not a complete filesystem write oracle",
    },
    {
      gate: "G-AUTHFILE",
      gap: config.hostAdmission
        ? `User accepted plain-file/bash reachability boundary: ${config.hostAdmission.authBoundary.reference}. Metadata-only C0/C1/C5 checks do not prove credential confinement; Rocky never opens/copies/proxies auth bytes.`
        : "auth.json is a plain 0600 file and bash-obfuscation reachability is unproven (F7 [P]); NOT decided by the user — explicit user decision REQUIRED before any live run; Rocky never reads/copies/proxies it (path-existence metadata only)",
    },
    {
      gate: "G-DEFAULT-PROMPT",
      gap: "agent.prompt REPLACES the default system prompt (F15): the sealed role-prompt bytes are the WHOLE system prompt; no append-system-prompt surface exists",
    },
    {
      gate: "G-ROSTER",
      gap: config.hostAdmission
        ? `Effective role availability is bound to retained native zero-turn debug-agent evidence ${config.hostAdmission.rosterEvidence.sha256}; per-run tool use corroborates only actual use, not availability or sandbox confinement.`
        : "the effective tool roster is not observable in the run stream (F18); enforcement is tool-absence + permission deny, evidenced per-run only by absence of off-roster tool_use; out-of-seal debug-config probes are a native step",
    },
    {
      gate: "G-MANAGED",
      gap: "managed dir + MDM plist layers cannot be overridden by config (F13 7/8); inventoried names-only each run, any presence ⇒ profile unavailable",
    },
    {
      gate: "G-EXPORT-AUTHORITY",
      gap: "export runs as a second process against the same isolated OPENCODE_DB after quiescence; WAL ordering/locking behavior [P]",
    },
    {
      gate: "G-EFFORT",
      gap: "no --variant is passed; reasoning effort is requested-only elsewhere and never echoed",
    },
  ];
  if (config.evidenceClass !== "live-subscription")
    gaps.push({
      gate: "LIVE",
      gap: "live qualification is a separate root-granted step (#14), gated additionally on the explicit user G-AUTHFILE decision; this receipt is not live evidence and the installed opencode binary was never executed",
    });
  if (config.evidenceClass === "owned-fake-cli")
    gaps.push({
      gate: "NP1-NP5",
      gap: "native role matrix, event-stream/assistant usage, authfile, lifecycle and variant behavior remain unproven; fake frame/part fixtures derive from the v1.18.32 source clone, while a zero-turn v1.18.33 probe confirms only the empty export envelope and registry IDs; this child is an owned fake CLI",
    });
  if (!verdict?.sessionId)
    gaps.push({
      gate: "PROMPT-CONSUMPTION",
      gap: "no event observed: prompt consumption is unproven (F23: no init analogue); the attempt stays attempted-unknown with no resend",
    });
  return gaps;
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
export function opencodeReceiptPath(
  paths: OpencodeRunPaths,
  commandId: string,
) {
  return join(paths.logs, `receipt-${commandId}.json`);
}
export function opencodeExportRawPath(
  paths: OpencodeRunPaths,
  commandId: string,
) {
  return join(paths.logs, `export-${commandId}.json`);
}
