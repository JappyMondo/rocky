import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  Store,
  type CommandRecord,
  type Lease,
  type Versions,
} from "../../store/index.js";
import { canonical, digest, type Json } from "../../store/json.js";
import {
  isAgentWork,
  SUBSCRIPTION_BUDGET_MODE,
  type Action,
  type Event,
  type ExecutionQualification,
  type HarnessUsage,
} from "../../coordinator/contracts.js";
import { DuplexRunner, type DuplexLimits } from "../../runner/duplex.js";
import type { CommandSpec } from "../../runner/index.js";
import {
  assertBinaryIdentity,
  measureBinaryIdentity,
  type BinaryIdentity,
} from "../../runner/process.js";
import {
  deriveTreeHead,
  sealAgentLaunchBundle,
  settlementToResultEvent,
  unknownHarnessUsage,
  validateAgentPrompt,
  StrictNdjsonDecoder,
  type AgentLaunchBundle,
  type AgentSettlement,
  type SettlementClass,
} from "../seam.js";
import {
  CODEX_EXEC_HARNESS,
  validateCodexExecConfig,
  type ValidatedCodexExecConfig,
} from "./config.js";
import { assertCodexSourceEnvAdmissible, buildCodexSealedEnv } from "./env.js";
import { buildCodexArgv, codexRoleForKind, type CodexRole } from "./argv.js";
import {
  buildCodexOverrideAssignments,
  renderCodexOverrideSet,
  renderCodexPermissionProfile,
  type TomlValue,
} from "./overrides.js";
import {
  assertCodexDiscoveryAdmissible,
  codexDiscoveryDrift,
  inventoryCodexDiscovery,
  type CodexDiscoveryInventory,
  type CodexDiscoveryInput,
} from "./discovery.js";
import {
  createCodexRunTree,
  validateCodexRunLayout,
  type CodexRunPaths,
} from "./paths.js";
import { codexUntrustedProjectsOverride } from "./trust.js";
import {
  classifyCodexStream,
  type CodexExpectations,
  type CodexStreamVerdict,
} from "./stream.js";
import { mapCodexUsage } from "./usage.js";
import { assembleCodexReceipt, codexReceiptPath } from "./receipt.js";

export interface CodexLaunchImage {
  /** Approved reviewer-only visual input bytes (PNG); written 0400 into INP and hash-bound. */
  name: string;
  bytes: Uint8Array;
}
export interface CodexLaunchInput {
  /** Exact approved prompt bytes; delivered once on stdin followed by a single EOF. */
  prompt: string | Uint8Array;
  /** Optional host staging callback populating SRC before validation/hashing. */
  stage?: (src: string) => void;
  /** Reviewer-only approved visual inputs (native transform gated N08). */
  images?: readonly CodexLaunchImage[];
}
export interface CodexLaunchPlan {
  schema: 1;
  action: Action;
  role: CodexRole;
  paths: CodexRunPaths;
  bundle: AgentLaunchBundle;
  prompt: { text: string; bytes: number; sha256: string };
  inventoryPre: CodexDiscoveryInventory;
  headPre: string;
  binaryC0: BinaryIdentity;
  spec: CommandSpec;
  limits: DuplexLimits;
  streamLimits: {
    maxLineBytes: number;
    maxTotalBytes: number;
    maxFrames: number;
  };
  expectations: CodexExpectations;
  requestSchemaSha256: string;
  overrideAssignments: readonly string[];
  preparedAt: number;
}
type ResultEvent = Extract<Event, { type: "result" }>;
interface CommandResultShape {
  outcome: string;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  cleanupError?: string;
}
function namedError(message: string): Error {
  return new Error(message);
}

/**
 * Direct Codex exec subscription harness adapter (Taskbot #81) implementing the frozen
 * rocky-subscription-88-v1 contract: one fresh pinned `codex exec --json` invocation per action, the
 * subscription login used by the trusted CLI parent only (never read, copied, symlinked or proxied),
 * a sealed positive-allowlist environment, audited TOML `-c` overrides with a real round-trip parser
 * (F1) and the sandbox+named-permissions ban (F7), discovery pinning with the F5 trust-persistence
 * prevention (explicit untrusted override + projectless tree + post-run shared-config byte check),
 * strict bounded exec-JSONL decoding with item lifecycle/error-item classification, the interrupted
 * (no terminal + exit 1) and turn.failed semantics, SIGTERM-only cancellation with no fictitious
 * acknowledgements, and usage mapped onto subscription-observed-v1 schema 2. The model final is a
 * proposal only: it never establishes checks, CI, review or head authority. capability is always null
 * and the qualification binding is an explicit host input — this package ships no approved binding,
 * so production admission remains unavailable until independent qualification exists.
 */
export class CodexExecAdapter {
  readonly capability = null;
  readonly qualification: ExecutionQualification;
  readonly versions: Versions;
  readonly config: ValidatedCodexExecConfig;
  #store: Store;
  #lease: Lease;
  #runner: DuplexRunner;
  #sourceEnv: Record<string, string | undefined>;
  #plans = new Map<string, CodexLaunchPlan>();
  constructor(
    store: Store,
    lease: Lease,
    config: unknown,
    options: { sourceEnv?: Record<string, string | undefined> } = {},
  ) {
    this.#store = store;
    this.#lease = JSON.parse(canonical(lease)) as Lease;
    this.config = validateCodexExecConfig(config);
    this.#runner = new DuplexRunner(store);
    this.#sourceEnv = options.sourceEnv ?? process.env;
    store.assertLease(this.#lease);
    this.qualification = this.config.qualification;
    this.versions = this.config.versions;
  }
  /** C0 prepare: render and digest the immutable bundle, verify the pinned binary, inventory and
   * seal discovery, stage and validate the projectless RUN tree, render audited overrides, and
   * freeze the prompt. Synchronous; any rejection here yields zero spawn. */
  prepareLaunch(
    action: Readonly<Action>,
    input: CodexLaunchInput,
  ): CodexLaunchPlan {
    const frozen = JSON.parse(canonical(action)) as Action;
    const role = this.#role(frozen);
    assertCodexSourceEnvAdmissible(this.#sourceEnv);
    const config = this.config;
    const limits = config.limits;
    const now = this.#store.clock();
    if (frozen.deadline <= now + limits.cleanupReserveMs + limits.killGraceMs)
      throw namedError("codex-deadline-insufficient");
    const prompt = validateAgentPrompt(input.prompt, limits.maxPromptBytes);
    // C0 binary identity precedes any RUN-tree side effect: a refused profile leaves nothing behind
    // and is never substituted (S01/S09).
    const binaryC0 = assertBinaryIdentity({
      path: config.binary.path,
      sha256: config.binary.sha256,
      bytes: config.binary.bytes,
    });
    // Images are reviewer-only approved visual inputs; an implementer with images refuses.
    const images = input.images ?? [];
    if (images.length && role !== "reviewer")
      throw namedError("codex-implementer-images");
    if (images.length > limits.maxImages)
      throw namedError("codex-image-count-limit");
    if (!existsSync(resolve(config.runsRoot)))
      mkdirSync(resolve(config.runsRoot), { recursive: true, mode: 0o700 });
    const runsRoot = realpathSync(resolve(config.runsRoot));
    const runRoot = join(runsRoot, `run-${digest(frozen.key).slice(0, 32)}`);
    // The shared CODEX_HOME must exist and be canonical; deny roots must be canonical when present.
    if (!existsSync(config.codexHome)) throw namedError("codex-home-missing");
    if (realpathSync(config.codexHome) !== config.codexHome)
      throw namedError("codex-path-not-canonical:codexHome");
    for (const root of config.denyRoots)
      if (existsSync(root) && realpathSync(root) !== root)
        throw namedError("codex-path-not-canonical:denyRoot");
    const paths = createCodexRunTree(runRoot);
    validateCodexRunLayout(paths, {
      codexHome: config.codexHome,
      denyRoots: config.denyRoots,
    });
    input.stage?.(paths.src);
    const inventoryPre = inventoryCodexDiscovery(this.#discoveryInput(paths));
    assertCodexDiscoveryAdmissible(inventoryPre, {
      approvedGlobalAgentsSha256: config.discovery.approvedGlobalAgentsSha256,
      codexHomeSkillsApproved: config.discovery.codexHomeSkillsApproved,
    });
    const headPre = deriveTreeHead(paths.src, limits.maxTreeNodes);
    // The request schema is a REQUEST projection of the protected final schema; the host always
    // re-validates the last completed agent_message against the full schema independently.
    const schemaPath = join(paths.inputs, "final.request.schema.json");
    const schemaFile = writeInputFile(
      schemaPath,
      config.requestSchemaCanonical,
    );
    const imageFiles = images.map((image, index) => {
      if (image.bytes.byteLength > limits.maxImageBytes)
        throw namedError("codex-image-bytes-limit");
      if (!/^[A-Za-z0-9._-]+$/.test(image.name))
        throw namedError("codex-image-name");
      const path = join(paths.inputs, `img-${index}-${image.name}`);
      const file = writeInputFile(path, image.bytes);
      return file;
    });
    const overrideAssignments = this.#buildOverrideAssignments(
      role,
      paths,
      inventoryPre,
    );
    const argv = buildCodexArgv({
      model: config.roles[role].model,
      effort: config.roles[role].effort,
      schemaPath,
      overrideAssignments,
      images: imageFiles.map((file) => file.path),
      maxArgvBytes: limits.maxArgvBytes,
    });
    const env = buildCodexSealedEnv(
      {
        parentHome: paths.parentHome,
        codexHome: config.codexHome,
        parentTmp: paths.parentTmp,
      },
      {
        shell: config.envOptions.shell,
        user: config.envOptions.user,
        userName: config.hostIdentity.userName,
      },
    );
    const bundle = sealAgentLaunchBundle({
      schema: 1,
      harness: CODEX_EXEC_HARNESS,
      binary: {
        path: binaryC0.path,
        sha256: binaryC0.sha256,
        bytes: binaryC0.bytes,
      },
      argv,
      env,
      cwd: paths.src,
      input: { bytes: prompt.bytes, sha256: prompt.sha256 },
      files: [schemaFile, ...imageFiles],
      discoveryDigest: inventoryPre.digest,
    });
    // Deterministic supervisor backstop: the reserved action allowance minus the cleanup reserve.
    // The EXACT original deadline is enforced transactionally by the store's dispatch guard on every
    // supervisor tick and queue operation, and is never restarted.
    const timeoutMs = Math.max(
      1,
      Math.min(2147483647, frozen.elapsedMs - limits.cleanupReserveMs),
    );
    const spec: CommandSpec = {
      file: config.binary.path,
      args: [...argv],
      cwd: paths.src,
      timeoutMs,
      cleanupMs: limits.killGraceMs,
      logBytes: Math.max(limits.maxStdoutBytes, limits.maxStderrBytes),
      outputDir: paths.logs,
      env,
    };
    const duplexLimits: DuplexLimits = {
      frameBytes: Math.max(limits.maxLineBytes, prompt.bytes),
      inputBytes: prompt.bytes + 64,
      outputBytes: limits.maxStdoutBytes,
      inputFrames: 2,
      outputFrames: limits.maxFrames,
    };
    const plan: CodexLaunchPlan = {
      schema: 1,
      action: frozen,
      role,
      paths,
      bundle,
      prompt,
      inventoryPre,
      headPre,
      binaryC0,
      spec,
      limits: duplexLimits,
      streamLimits: {
        maxLineBytes: limits.maxLineBytes,
        maxTotalBytes: limits.maxStdoutBytes,
        maxFrames: limits.maxFrames,
      },
      expectations: {
        model: config.roles[role].model,
        role,
        maxItems: limits.maxItems,
        maxFinalBytes: limits.maxFinalBytes,
        maxAggregatedOutputBytes: limits.maxAggregatedOutputBytes,
      },
      requestSchemaSha256: config.requestSchemaSha256,
      overrideAssignments,
      preparedAt: now,
    };
    const existing = this.#plans.get(frozen.key);
    if (existing) {
      // Idempotent re-prepare (restart reconciliation): an identical re-rendering returns the frozen
      // plan; a changed bundle for the same action is a conflict, never a silent replace.
      if (existing.bundle.bundleDigest !== bundle.bundleDigest)
        throw namedError("codex-plan-conflict");
      return existing;
    }
    this.#plans.set(frozen.key, plan);
    return plan;
  }
  /** Transport begin: synchronous initiation under the dispatch guarded start. C1 (lease/fence/
   * deadline/binary rehash) is rechecked by the store and the gate inside the guarded spawn; C2 is
   * the durable command reservation; C3 queues the exact prompt bytes plus one EOF with durable
   * attempted-before-IO semantics and never resends after ambiguity. */
  begin(action: Readonly<Action>): Promise<ResultEvent> {
    const plan = this.#plans.get(action.key);
    if (!plan) throw namedError("codex-launch-not-prepared");
    if (canonical(plan.action) !== canonical(action))
      throw namedError("codex-action-mismatch");
    assertCodexSourceEnvAdmissible(this.#sourceEnv);
    // C1 recomputation inside the dispatch guarded start: one-byte drift between C0 and C1 yields
    // zero spawn. The pinned binary is re-hashed by the gate inside the guarded spawn transaction.
    this.#recheckBundle(plan);
    const id = this.#runner.start(
      this.#lease,
      plan.action,
      plan.spec,
      plan.limits,
      {
        binaryIdentity: {
          path: plan.bundle.binary.path,
          sha256: plan.bundle.binary.sha256,
          bytes: plan.bundle.binary.bytes,
        },
        bundleDigest: plan.bundle.bundleDigest,
      },
    );
    this.#runner.sendText(
      this.#lease,
      id,
      `${action.key}:prompt`,
      plan.prompt.text,
    );
    this.#runner.end(this.#lease, id, `${action.key}:eof`);
    return this.#settle(plan, id);
  }
  /** Durable cancellation request: SIGTERM of the owned group is performed by the supervisor. No
   * interrupt acknowledgement or remote-stop claim is ever made here. */
  interrupt(action: Readonly<Action>) {
    this.#runner.interrupt(this.#lease, action);
  }
  plan(actionKey: string): CodexLaunchPlan | undefined {
    return this.#plans.get(actionKey);
  }
  async #settle(plan: CodexLaunchPlan, id: string): Promise<ResultEvent> {
    const { record, quiescent } = await this.#runner.wait(this.#lease, id);
    const settlement = this.settleCommand(plan, id, record, quiescent);
    return settlementToResultEvent(settlement, plan.action);
  }
  /** C5 settlement from the durable command record: post-run rehash (discovery inventory + shared
   * config.toml + binary), strict stream decode, classification, usage mapping, host-derived head and
   * the receipt. Also the reconciliation entrypoint after a restart: it observes an existing terminal
   * command and never relaunches. */
  settleCommand(
    plan: CodexLaunchPlan,
    id: string,
    record?: CommandRecord,
    quiescent?: boolean,
  ): AgentSettlement {
    const rec = record ?? this.#store.command(id);
    if (!rec || rec.runId !== plan.action.runId)
      throw namedError("codex-command-not-found");
    if (rec.state === "starting" || rec.state === "running")
      throw namedError("codex-command-unsettled");
    const duplex = rec.duplex;
    if (!duplex) throw namedError("codex-command-not-found");
    const res = (rec.result ?? null) as CommandResultShape | null;
    const physicalQuiescent =
      rec.state === "finished" &&
      duplex.stdoutEof === true &&
      duplex.stderrEof === true &&
      (quiescent ?? true);
    const settledAt = this.#store.clock();
    const post = this.#measurePostRun(plan);
    let verdict: CodexStreamVerdict | null = null;
    let decodeError: string | null = null;
    let classification: SettlementClass;
    let outcome: AgentSettlement["outcome"];
    let usage: HarnessUsage;
    let detail: string;
    let proposal: Json | null = null;
    const unknown = (reason: string) =>
      unknownHarnessUsage(CODEX_EXEC_HARNESS, reason);
    if (rec.state === "recovery-required" || res === null) {
      classification = "interrupted";
      outcome = "interrupted";
      usage = unknown("codex-command-recovery-required");
      detail = "codex-interrupted:recovery-required";
    } else if (res.outcome === "cancelled" || duplex.revoked) {
      // A late result after cancel is ignored: cancellation settles the attempt as unknown.
      classification = "interrupted";
      outcome = "interrupted";
      usage = unknown("codex-cancelled-sigterm");
      detail = "codex-interrupted:cancelled-late-result-ignored";
    } else if (res.outcome === "timeout") {
      classification = "interrupted";
      outcome = "interrupted";
      usage = unknown("codex-deadline-exceeded");
      detail = "codex-interrupted:deadline-exceeded";
    } else if (res.outcome === "lease-lost") {
      classification = "interrupted";
      outcome = "interrupted";
      usage = unknown("codex-lease-lost");
      detail = "codex-interrupted:lease-lost";
    } else if (
      duplex.failure === "binary-identity-drift" ||
      duplex.failure === "binary-identity-missing"
    ) {
      classification = "fatal";
      outcome = "failed";
      usage = unknown("codex-binary-unavailable");
      detail = `codex-fatal:${duplex.failure}`;
    } else if (post.drift.length) {
      classification = "unresolved";
      outcome = "interrupted";
      usage = unknown("codex-discovery-drift");
      detail = `codex-unresolved:discovery-drift:${post.drift.join(";")}`;
    } else {
      const decoded = this.#decodeRawStream(plan, res);
      decodeError = decoded.decodeError;
      verdict = classifyCodexStream({
        frames: decoded.frames,
        lines: decoded.lines,
        decodeError,
        lifecycle: {
          exitCode: res.exitCode,
          signal: res.signal,
          stdoutEof: duplex.stdoutEof === true,
          stderrEof: duplex.stderrEof === true,
          childStdoutEof: duplex.childStdoutEof === true,
          childStderrEof: duplex.childStderrEof === true,
          decoderComplete: duplex.decoderComplete === true,
          transportFailure: duplex.failure,
          stdoutTruncated: res.stdoutTruncated === true,
          stderrTruncated: res.stderrTruncated === true,
          stderrBytes: safeFileSize(res.stderr),
          quiescent: physicalQuiescent,
        },
        expectations: plan.expectations,
        binding: {
          actionKey: plan.action.key,
          inputDigest: plan.action.inputDigest,
        },
      });
      const usageDecision = mapCodexUsage({
        turnCompletedFrame: (verdict.turnCompletedFrame as Json | null) ?? null,
        turnCompletedRawLine: verdict.turnCompletedRawLine,
        // A fatal observation (error item/event, turn.failed, startup refusal, binary drift) rejects
        // the run BEFORE usage mapping: its telemetry is never reported as subscription usage.
        lifecycleResolved:
          verdict.resolvedLifecycle && verdict.settlement !== "fatal",
        unresolvedReason:
          verdict.settlement === "fatal"
            ? `codex-fatal-before-usage-mapping:${verdict.reasons[0] ?? "fatal"}`
            : verdict.reasons[0],
      });
      usage = usageDecision.usage;
      if (verdict.settlement === "complete" && usageDecision.invalidTelemetry) {
        classification = "unresolved";
        outcome = "failed";
        detail = `codex-unresolved:${usageDecision.invalidTelemetry}`;
      } else if (verdict.settlement === "complete") {
        classification = "complete";
        proposal = verdict.final;
        const proposed = (proposal as unknown as { outcome: string }).outcome;
        outcome = proposed as AgentSettlement["outcome"];
        detail =
          usageDecision.usage.status === "reported"
            ? "codex-complete:protocol-qualified-proposal"
            : `codex-complete:proposal-with-${usageDecision.usage.status}-usage`;
      } else {
        classification = verdict.settlement;
        outcome = verdict.resolvedLifecycle ? "failed" : "interrupted";
        if (classification === "policy-denied" || classification === "fatal")
          outcome = "failed";
        const primary = verdict.reasons.slice(0, 4).join("|") || "unresolved";
        detail = `codex-${classification}:${primary}`;
      }
    }
    const head = this.#derivePostHead(plan);
    const settlement: AgentSettlement = {
      schema: 1,
      harness: CODEX_EXEC_HARNESS,
      classification,
      outcome,
      quiescent: physicalQuiescent,
      usage,
      head,
      detail,
      proposal,
    };
    this.#writeReceipt(
      plan,
      rec,
      verdict,
      settlement,
      post,
      decodeError,
      settledAt,
    );
    return settlement;
  }
  #buildOverrideAssignments(
    role: CodexRole,
    paths: CodexRunPaths,
    inventory: CodexDiscoveryInventory,
  ): readonly string[] {
    const config = this.config;
    const profileName = config.permissionProfiles[role];
    const permissionsValue = renderCodexPermissionProfile({
      role,
      profileName,
      src: paths.src,
      scratch: paths.scratch,
      parentRoot: join(paths.runRoot, "parent"),
      native: paths.native,
      inputs: paths.inputs,
      codexHomeChildren: inventory.codexHomeChildren.map((c) => c.name),
      codexHome: config.codexHome,
      denyRoots: config.denyRoots,
      platformDenyRoots: config.platformDenyRoots,
      maxDenyEntries: config.limits.maxDenyEntries,
    }) as TomlValue;
    const projectsValue = codexUntrustedProjectsOverride(paths.src)
      .value as TomlValue;
    const overrideSet = renderCodexOverrideSet({
      effort: config.roles[role].effort,
      credentialsStore: config.authBackend.credentialsStore,
      secretAuthStorage: config.authBackend.secretAuthStorage,
      permissionProfileName: profileName,
      permissionsValue,
      projectsValue,
      sqliteHome: paths.nativeSqlite,
      logDir: paths.nativeLog,
      shellHome: join(paths.scratch, "home"),
      shellTmp: join(paths.scratch, "tmp"),
    });
    return buildCodexOverrideAssignments(overrideSet, {
      maxOverrideValueBytes: config.limits.maxOverrideValueBytes,
      maxOverrides: config.limits.maxOverrides,
    });
  }
  #recheckBundle(plan: CodexLaunchPlan) {
    for (const file of plan.bundle.files) {
      let bytes;
      try {
        bytes = readFileSync(file.path);
      } catch {
        throw namedError(`codex-bundle-drift:${file.name}`);
      }
      if (digest(bytes) !== file.sha256 || bytes.length !== file.bytes)
        throw namedError(`codex-bundle-drift:${file.name}`);
    }
    if (canonical(plan.spec.args) !== canonical(plan.bundle.argv))
      throw namedError("codex-bundle-drift:argv");
    if (canonical(plan.spec.env ?? []) !== canonical(plan.bundle.env))
      throw namedError("codex-bundle-drift:env");
    if (
      plan.spec.file !== plan.bundle.binary.path ||
      plan.spec.cwd !== plan.bundle.cwd
    )
      throw namedError("codex-bundle-drift:spawn-binding");
    const prompt = validateAgentPrompt(
      plan.prompt.text,
      this.config.limits.maxPromptBytes,
    );
    if (
      prompt.sha256 !== plan.bundle.input.sha256 ||
      prompt.bytes !== plan.bundle.input.bytes
    )
      throw namedError("codex-bundle-drift:prompt");
    const inventory = inventoryCodexDiscovery(this.#discoveryInput(plan.paths));
    assertCodexDiscoveryAdmissible(inventory, {
      approvedGlobalAgentsSha256:
        this.config.discovery.approvedGlobalAgentsSha256,
      codexHomeSkillsApproved: this.config.discovery.codexHomeSkillsApproved,
    });
    if (inventory.digest !== plan.bundle.discoveryDigest)
      throw namedError("codex-bundle-drift:discovery");
    if (
      deriveTreeHead(plan.paths.src, this.config.limits.maxTreeNodes) !==
      plan.headPre
    )
      throw namedError("codex-bundle-drift:staged-tree");
  }
  #role(action: Action): CodexRole {
    const config = this.config;
    if (action.schema !== 2 || action.budgetMode !== SUBSCRIPTION_BUDGET_MODE)
      throw namedError("codex-subscription-mode-required");
    if (!isAgentWork(action.kind)) throw namedError("codex-agent-work-only");
    if (action.runId !== this.#lease.runId)
      throw namedError("codex-action-run-mismatch");
    if (canonical(action.versions) !== canonical(config.versions))
      throw namedError("codex-versions-mismatch");
    if (action.qualificationId !== config.qualification.id)
      throw namedError("codex-qualification-mismatch");
    return codexRoleForKind(action.kind);
  }
  #discoveryInput(paths: CodexRunPaths): CodexDiscoveryInput {
    const config = this.config;
    return {
      codexHome: config.codexHome,
      system: config.discovery.system,
      systemDirs: config.discovery.systemDirs,
      mdm: config.discovery.mdm,
      src: paths.src,
      runRoot: paths.runRoot,
      maxTreeNodes: config.limits.maxTreeNodes,
      approvedGlobalAgentsSha256: config.discovery.approvedGlobalAgentsSha256,
      codexHomeSkillsApproved: config.discovery.codexHomeSkillsApproved,
    };
  }
  #measurePostRun(plan: CodexLaunchPlan): {
    inventoryPost: CodexDiscoveryInventory;
    binaryC5: BinaryIdentity | { unavailable: string };
    drift: string[];
  } {
    const inventoryPost = inventoryCodexDiscovery(
      this.#discoveryInput(plan.paths),
    );
    const drift = codexDiscoveryDrift(plan.inventoryPre, inventoryPost);
    let binaryC5: BinaryIdentity | { unavailable: string };
    try {
      binaryC5 = measureBinaryIdentity(plan.bundle.binary.path);
      if (
        binaryC5.sha256 !== plan.binaryC0.sha256 ||
        binaryC5.bytes !== plan.binaryC0.bytes
      )
        drift.push("binary-identity-drift-c5");
    } catch {
      binaryC5 = { unavailable: "binary-missing-at-c5" };
      drift.push("binary-unavailable-at-c5");
    }
    return { inventoryPost, binaryC5, drift };
  }
  #decodeRawStream(
    plan: CodexLaunchPlan,
    res: CommandResultShape,
  ): { frames: Json[]; lines: string[]; decodeError: string | null } {
    const decoder = new StrictNdjsonDecoder(plan.streamLimits);
    let decodeError: string | null = null;
    try {
      decoder.push(readFileSync(res.stdout));
      decoder.end();
    } catch (error) {
      decodeError = (error as Error).message || "strict-decode-failed";
    }
    return { frames: decoder.frames, lines: decoder.lines, decodeError };
  }
  #derivePostHead(plan: CodexLaunchPlan): string {
    try {
      return deriveTreeHead(plan.paths.src, this.config.limits.maxTreeNodes);
    } catch {
      // An unreadable staged tree never fabricates a head; return a named non-adoptable value.
      return `unreadable-staged-tree:${digest(plan.action.key)}`;
    }
  }
  #writeReceipt(
    plan: CodexLaunchPlan,
    record: CommandRecord,
    verdict: CodexStreamVerdict | null,
    settlement: AgentSettlement,
    post: {
      inventoryPost: CodexDiscoveryInventory;
      binaryC5: BinaryIdentity | { unavailable: string };
      drift: string[];
    },
    decodeError: string | null,
    settledAt: number,
  ) {
    try {
      const receipt = assembleCodexReceipt({
        plan,
        record,
        verdict,
        settlement,
        config: this.config,
        paths: plan.paths,
        binaryC0: plan.binaryC0,
        binaryC5: post.binaryC5,
        inventoryPre: plan.inventoryPre,
        inventoryPost: post.inventoryPost,
        drift: post.drift,
        decodeError,
        settledAt,
      });
      const path = codexReceiptPath(plan.paths, record.id);
      writeFileSync(path, `${canonical(receipt)}\n`, { mode: 0o600 });
      chmodSync(path, 0o600);
    } catch {
      // Receipt assembly is evidence, never a side effect that may mask the settlement itself.
    }
  }
}
function writeInputFile(
  path: string,
  contents: string | Uint8Array,
): { name: string; path: string; sha256: string; bytes: number } {
  // Idempotent re-render: an existing 0400 file cannot be truncated in place, so replace it.
  try {
    unlinkSync(path);
  } catch {
    /* first render */
  }
  writeFileSync(path, contents, { mode: 0o400 });
  chmodSync(path, 0o400);
  const roundTrip = readFileSync(path);
  if (typeof contents === "string" && roundTrip.toString("utf8") !== contents)
    throw namedError("codex-input-file-roundtrip");
  return {
    name: path.split("/").pop()!,
    path,
    sha256: digest(roundTrip),
    bytes: roundTrip.length,
  };
}
function safeFileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
