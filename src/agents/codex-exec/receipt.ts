import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { canonical, digest, type Json } from "../../store/json.js";
import type { AgentSettlement } from "../seam.js";
import type { BinaryIdentity } from "../../runner/process.js";
import type { CommandRecord } from "../../store/index.js";
import type { ValidatedCodexExecConfig } from "./config.js";
import type { CodexDiscoveryInventory } from "./discovery.js";
import type { CodexRunPaths } from "./paths.js";
import type { CodexLaunchPlan } from "./adapter.js";
import type { CodexStreamVerdict } from "./stream.js";

/**
 * Receipt assembly per acceptance/subscription manifest receiptRequirements (S10). Every field is a
 * measured observation or an explicitly recorded gap; unobservable requirements are honest `unknown`
 * entries referencing their gates, never fabricated evidence. The receipt retains the post-run rehash
 * of the approved discovery inventory AND of the shared CODEX_HOME config.toml (F5/F6): any drift
 * during the run makes the result stale/unknown. The shared config.toml is measured as a nonsecret
 * sha256/size by the host; its content is never retained.
 */
export interface CodexReceiptInput {
  plan: CodexLaunchPlan;
  record: CommandRecord;
  verdict: CodexStreamVerdict | null;
  settlement: AgentSettlement;
  config: ValidatedCodexExecConfig;
  paths: CodexRunPaths;
  binaryC0: BinaryIdentity;
  binaryC5: BinaryIdentity | { unavailable: string };
  inventoryPre: CodexDiscoveryInventory;
  inventoryPost: CodexDiscoveryInventory;
  drift: string[];
  decodeError: string | null;
  settledAt: number;
}
export function assembleCodexReceipt(input: CodexReceiptInput): Json {
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
  const usageRaw = (verdict?.turnCompletedFrame?.usage ?? null) as Json;
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
    role: {
      role: plan.role,
      model: config.roles[plan.role].model,
      effort: config.roles[plan.role].effort,
      permissionProfile: config.permissionProfiles[plan.role],
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
    overrides: {
      assignments: plan.overrideAssignments,
      roundTripRule:
        "each -c value round-trips a real (owned) TOML value parser with structural equality before admission (F1); sandbox_mode is a prohibited key and default_permissions never co-occurs with a CLI sandbox override (F7)",
    },
    authHome: {
      mode: "shared-designated",
      codexHome: config.codexHome,
      credentialsStore: config.authBackend.credentialsStore,
      secretAuthStorage: config.authBackend.secretAuthStorage,
      credentialReadCopySymlinkProxy: false,
      rawStatusRetention: false,
      forcedLoginLogoutPolicy: false,
      accountModeClassification:
        "unavailable; exec output carries no auth mode and Rocky never reads auth bytes (gate G-AUTH/G7)",
    },
    trustPersistence: {
      untrustedOverridePresent: plan.overrideAssignments.some((a) =>
        a.startsWith("projects="),
      ),
      projectlessTree:
        !input.inventoryPre.stagedGitPresent &&
        !input.inventoryPre.ancestorGitPresent,
      sharedConfigTomlPre: input.inventoryPre.sharedConfigToml,
      sharedConfigTomlPost: input.inventoryPost.sharedConfigToml,
      unchanged:
        input.inventoryPre.sharedConfigToml.sha256 ===
        input.inventoryPost.sharedConfigToml.sha256,
    },
    discovery: {
      pre: input.inventoryPre,
      post: input.inventoryPost,
      drift: input.drift,
      codexHomeChildrenGained: input.inventoryPost.codexHomeChildren
        .map((c) => c.name)
        .filter(
          (name) =>
            !input.inventoryPre.codexHomeChildren.some((c) => c.name === name),
        ),
    },
    threadIdentity: {
      threadStartedObserved: verdict?.threadStartedObserved ?? false,
      threadId: verdict?.threadId ?? null,
      notExposed: [
        "turn id",
        "turn.error:null",
        "JSON-RPC request ids",
        "pending-server-request map",
        "continuous usage",
      ],
    },
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
      errorItems: verdict?.errorItems ?? [],
      errorEvents: verdict?.errorEvents ?? [],
      ordinaryFailures: verdict?.ordinaryFailures ?? [],
      itemCount: verdict?.itemCount ?? 0,
      sends: (duplex?.sends ?? []).map((s) => ({
        key: s.key,
        state: s.state,
        end: s.end,
        attempted: s.attempted ?? false,
      })),
      revoked: duplex?.revoked ?? false,
    },
    result: {
      final: settlement.proposal,
      finalRawText: verdict?.finalRawText ?? null,
      finalRawTextSha256:
        verdict?.finalRawText == null
          ? null
          : digest(Buffer.from(verdict.finalRawText, "utf8")),
      turnCompletedUsageRaw: usageRaw,
      turnCompletedUsageSha256:
        usageRaw === null ? null : digest(JSON.stringify(usageRaw)),
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
    head: { pre: plan.headPre, post: settlement.head },
    timestamps: {
      preparedAt: plan.preparedAt,
      commandCreatedAt: record.createdAt,
      settledAt: input.settledAt,
    },
    limits: config.limits,
    gaps: codexReceiptGaps(config, verdict),
    receiptDigest: "",
  };
  const canonicalBytes = canonical(receipt);
  const frozen = JSON.parse(canonicalBytes) as Record<string, Json>;
  return { ...frozen, receiptDigest: digest(canonicalBytes) };
}
/** Honest gaps: surfaces not observable in exec --json or not established by this evidence class,
 * each bound to its open gate. Never a qualified claim. */
export function codexReceiptGaps(
  config: ValidatedCodexExecConfig,
  verdict: CodexStreamVerdict | null,
): { gate: string; gap: string }[] {
  const gaps = [
    {
      gate: "G-OVERRIDES",
      gap: "effective config/tool roster is not observable in exec --json (print_config_summary emits only thread.started); override exactness is producer-audited and round-trip validated, native effectiveness remains gated N01",
    },
    {
      gate: "G-MODEL",
      gap: "model/effort are requested-only; the served model is never echoed, a reroute surfaces only as an error item, and silent reroute detection is a live/native gate (L01)",
    },
    {
      gate: "G-EFFORT",
      gap: "model_reasoning_effort is requested-only and never echoed; no claim of applied effort is made",
    },
    {
      gate: "G-AUTH",
      gap: "exec output carries no auth mode and Rocky never reads auth bytes; nonsecret account/mode classification is a separate harness-owned step with residual TOCTOU (G7), not performed here",
    },
    {
      gate: "G-TRUST",
      gap: "trust persistence is prevented by the explicit untrusted override + projectless tree and detected by a nonsecret shared config.toml byte check; native proof that config.toml is unchanged is N01",
    },
    {
      gate: "G-FRAME-SHAPE",
      gap: "the exact native exec-JSONL serde field names are an owned source-consistent interpretation of the pinned taxonomy; the native lifecycle/frame shape is gated N06",
    },
    {
      gate: "G-VISUAL",
      gap: "reviewer --image input transform/delivery and view_image absence are gated N08; a hash/path request alone is not proof of functional image consumption",
    },
    {
      gate: "G-WRITES",
      gap: "native writes into the shared CODEX_HOME despite overrides/ephemeral (tmp/arg0 helper links, auth refresh, caches) are inventoried by name/hash, not natively bounded (G4)",
    },
    {
      gate: "G-SIGINT",
      gap: "cancellation is SIGTERM-only via the owned group; an interrupted turn emits no terminal and exits 1, and no turn/interrupt acknowledgement is ever claimed",
    },
  ];
  if (config.evidenceClass !== "live-subscription")
    gaps.push({
      gate: "L01-L02",
      gap: "live subscription/model qualification is a separate root-granted step (blocked on OpenAI credits — external access gap); this receipt is not live evidence",
    });
  if (config.evidenceClass === "owned-fake-cli")
    gaps.push({
      gate: "N01-N08",
      gap: "native behavior (discovery sealing, role/permission matrix, alternate/ambient authority, lifecycle, cleanup, visual route) is unproven; the child is an owned fake CLI",
    });
  if (!verdict?.threadStartedObserved)
    gaps.push({
      gate: "S06",
      gap: "thread.started not observed: prompt consumption is unproven (a pipe-buffered write proves nothing, F9); the attempt stays attempted-unknown with no resend",
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
export function codexReceiptPath(paths: CodexRunPaths, commandId: string) {
  return join(paths.logs, `receipt-${commandId}.json`);
}
