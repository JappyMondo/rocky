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
  CLAUDE_CODE_HARNESS,
  validateClaudeCodeConfig,
  type ValidatedClaudeCodeConfig,
} from "./config.js";
import {
  assertClaudeSourceEnvAdmissible,
  buildClaudeSealedEnv,
} from "./env.js";
import {
  allowedToolRoster,
  buildClaudeArgv,
  expectedInitRoster,
  roleForKind,
  type ClaudeRole,
} from "./argv.js";
import { renderClaudeSettings } from "./settings.js";
import {
  assertClaudeDiscoveryAdmissible,
  claudeDiscoveryDrift,
  inventoryClaudeDiscovery,
  type ClaudeDiscoveryInventory,
  type ClaudeDiscoveryInput,
} from "./discovery.js";
import {
  createClaudeRunTree,
  validateClaudeRunLayout,
  type ClaudeRunPaths,
} from "./paths.js";
import {
  classifyClaudeStream,
  type ClaudeExpectations,
  type ClaudeStreamVerdict,
} from "./stream.js";
import { mapClaudeUsage } from "./usage.js";
import { assembleClaudeReceipt, claudeReceiptPath } from "./receipt.js";

export interface ClaudeLaunchInput {
  /** Exact approved prompt bytes; delivered once on stdin followed by a single EOF. */
  prompt: string | Uint8Array;
  /** Optional host staging callback populating SRC before validation/hashing. */
  stage?: (src: string) => void;
}
export interface AgentLaunchPlan {
  schema: 1;
  action: Action;
  role: ClaudeRole;
  paths: ClaudeRunPaths;
  bundle: AgentLaunchBundle;
  prompt: { text: string; bytes: number; sha256: string };
  inventoryPre: ClaudeDiscoveryInventory;
  headPre: string;
  binaryC0: BinaryIdentity;
  spec: CommandSpec;
  limits: DuplexLimits;
  streamLimits: {
    maxLineBytes: number;
    maxTotalBytes: number;
    maxFrames: number;
  };
  expectations: ClaudeExpectations;
  /** Projection hash (sha256 of the projected canonical --json-schema wire bytes, #111);
   * the frozen 2020-12 source schema remains the host-side validation authority. */
  requestSchemaSha256: string;
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
 * Claude Code CLI subscription harness adapter (Taskbot #97) implementing the frozen
 * rocky-claude-code-95-v1 contract: one fresh pinned `claude -p --output-format stream-json`
 * invocation per action, subscription OAuth used by the CLI parent only (never read, copied,
 * symlinked or proxied), sealed positive-allowlist environment, discovery pinning, strict bounded
 * stream-json decoding with tool_use/tool_result pairing, authoritative permission_denials, the
 * exit-code matrix, SIGTERM-only cancellation with no fictitious acknowledgements, and usage
 * mapped onto subscription-observed-v1 schema 2. The model final is a proposal only: it never
 * establishes checks, CI, review or head authority. capability is always null and the
 * qualification binding is an explicit host input — this package ships no approved binding, so
 * production admission remains unavailable until independent qualification exists.
 */
export class ClaudeCodeAdapter {
  readonly capability = null;
  readonly qualification: ExecutionQualification;
  readonly versions: Versions;
  readonly config: ValidatedClaudeCodeConfig;
  #store: Store;
  #lease: Lease;
  #runner: DuplexRunner;
  #sourceEnv: Record<string, string | undefined>;
  #plans = new Map<string, AgentLaunchPlan>();
  constructor(
    store: Store,
    lease: Lease,
    config: unknown,
    options: { sourceEnv?: Record<string, string | undefined> } = {},
  ) {
    this.#store = store;
    this.#lease = JSON.parse(canonical(lease)) as Lease;
    this.config = validateClaudeCodeConfig(config);
    this.#runner = new DuplexRunner(store);
    this.#sourceEnv = options.sourceEnv ?? process.env;
    store.assertLease(this.#lease);
    this.qualification = this.config.qualification;
    this.versions = this.config.versions;
  }
  /** C0 prepare: render and digest the immutable bundle, verify the pinned binary, inventory and
   * seal discovery, stage and validate the RUN tree, and freeze the prompt. Synchronous; any
   * rejection here yields zero spawn. */
  prepareLaunch(
    action: Readonly<Action>,
    input: ClaudeLaunchInput,
  ): AgentLaunchPlan {
    const frozen = JSON.parse(canonical(action)) as Action;
    const role = this.#role(frozen);
    assertClaudeSourceEnvAdmissible(this.#sourceEnv);
    const config = this.config;
    const limits = config.limits;
    const now = this.#store.clock();
    if (frozen.deadline <= now + limits.cleanupReserveMs + limits.killGraceMs)
      throw namedError("claude-deadline-insufficient");
    const prompt = validateAgentPrompt(input.prompt, limits.maxPromptBytes);
    // C0 binary identity precedes any RUN-tree side effect: a refused profile leaves nothing
    // behind and is never substituted (CC01, G-VERSION).
    const binaryC0 = assertBinaryIdentity({
      path: config.binary.path,
      sha256: config.binary.sha256,
      bytes: config.binary.bytes,
    });
    if (!existsSync(resolve(config.runsRoot)))
      mkdirSync(resolve(config.runsRoot), { recursive: true, mode: 0o700 });
    const runsRoot = realpathSync(resolve(config.runsRoot));
    const runRoot = join(runsRoot, `run-${digest(frozen.key).slice(0, 32)}`);
    // Canonical (realpath) identity for the dedicated config dir and existing deny roots.
    if (!existsSync(config.configDir))
      throw namedError("claude-config-dir-missing");
    if (realpathSync(config.configDir) !== config.configDir)
      throw namedError("claude-path-not-canonical:configDir");
    for (const root of config.denyRoots)
      if (existsSync(root) && realpathSync(root) !== root)
        throw namedError("claude-path-not-canonical:denyRoot");
    const paths = createClaudeRunTree(runRoot);
    validateClaudeRunLayout(paths, {
      configDir: config.configDir,
      denyRoots: config.denyRoots,
    });
    input.stage?.(paths.src);
    const inventoryPre = inventoryClaudeDiscovery(this.#discoveryInput(paths));
    assertClaudeDiscoveryAdmissible(inventoryPre, {
      configDir: config.configDir,
    });
    const headPre = deriveTreeHead(paths.src, limits.maxTreeNodes);
    const settingsPath = join(paths.inputs, "settings.json");
    const instructionsPath = join(paths.inputs, "instructions.md");
    const settingsCanonical = renderClaudeSettings({
      configDir: config.configDir,
      parentHome: paths.parentHome,
      parentTmp: paths.parentTmp,
      inputs: paths.inputs,
      scratch: paths.scratch,
      userHome: config.hostIdentity.userHome,
      denyRoots: config.denyRoots,
    });
    const settingsFile = writeInputFile(settingsPath, settingsCanonical);
    const instructionsFile = writeInputFile(
      instructionsPath,
      config.appendInstructions,
    );
    const argv = buildClaudeArgv({
      role,
      model: config.roles[role].model,
      effort: config.roles[role].effort,
      maxTurns: limits.maxTurns,
      settingsPath,
      requestSchemaCanonical: config.requestSchemaCanonical,
      instructionsPath,
      maxArgvBytes: limits.maxArgvBytes,
    });
    const env = buildClaudeSealedEnv(
      {
        parentHome: paths.parentHome,
        configDir: config.configDir,
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
      harness: CLAUDE_CODE_HARNESS,
      binary: {
        path: binaryC0.path,
        sha256: binaryC0.sha256,
        bytes: binaryC0.bytes,
      },
      argv,
      env,
      cwd: paths.src,
      input: { bytes: prompt.bytes, sha256: prompt.sha256 },
      files: [settingsFile, instructionsFile],
      discoveryDigest: inventoryPre.digest,
    });
    // Deterministic supervisor backstop: the reserved action allowance minus the cleanup
    // reserve. The EXACT original deadline is enforced transactionally by the store's
    // dispatch guard on every supervisor tick and queue operation, and is never restarted.
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
    const plan: AgentLaunchPlan = {
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
        version: config.binary.version,
        model: config.roles[role].model,
        role,
        roster: expectedInitRoster(
          role,
          config.initExpectations.toolsIncludeStructuredOutput,
        ),
        allowedTools: allowedToolRoster(role),
        cwd: paths.src,
        approvedSkills: config.initExpectations.skills,
        approvedSlashCommands: config.initExpectations.slashCommands,
        maxToolUses: limits.maxToolUses,
        maxResultBytes: limits.maxResultBytes,
      },
      requestSchemaSha256: config.requestSchemaSha256,
      preparedAt: now,
    };
    const existing = this.#plans.get(frozen.key);
    if (existing) {
      // Idempotent re-prepare (restart reconciliation): an identical re-rendering returns the
      // frozen plan; a changed bundle for the same action is a conflict, never a silent replace.
      if (existing.bundle.bundleDigest !== bundle.bundleDigest)
        throw namedError("claude-plan-conflict");
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
    if (!plan) throw namedError("claude-launch-not-prepared");
    if (canonical(plan.action) !== canonical(action))
      throw namedError("claude-action-mismatch");
    assertClaudeSourceEnvAdmissible(this.#sourceEnv);
    // C1 recomputation inside the dispatch guarded start: one-byte drift between C0 and C1
    // yields zero spawn. The pinned binary itself is re-hashed by the gate inside the guarded
    // spawn transaction, so a drifted binary also never launches.
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
  /** Durable cancellation request: SIGTERM of the owned group is performed by the supervisor.
   * No interrupt acknowledgement or remote-stop claim is ever made here. */
  interrupt(action: Readonly<Action>) {
    this.#runner.interrupt(this.#lease, action);
  }
  plan(actionKey: string): AgentLaunchPlan | undefined {
    return this.#plans.get(actionKey);
  }
  async #settle(plan: AgentLaunchPlan, id: string): Promise<ResultEvent> {
    const { record, quiescent } = await this.#runner.wait(this.#lease, id);
    const settlement = this.settleCommand(plan, id, record, quiescent);
    return settlementToResultEvent(settlement, plan.action);
  }
  /** C5 settlement from the durable command record: post-run rehash, strict stream decode,
   * classification, usage mapping, host-derived head and the receipt. Also the reconciliation
   * entrypoint after a restart: it observes an existing terminal command and never relaunches. */
  settleCommand(
    plan: AgentLaunchPlan,
    id: string,
    record?: CommandRecord,
    quiescent?: boolean,
  ): AgentSettlement {
    const rec = record ?? this.#store.command(id);
    if (!rec || rec.runId !== plan.action.runId)
      throw namedError("claude-command-not-found");
    if (rec.state === "starting" || rec.state === "running")
      throw namedError("claude-command-unsettled");
    const duplex = rec.duplex;
    if (!duplex) throw namedError("claude-command-not-found");
    const res = (rec.result ?? null) as CommandResultShape | null;
    const physicalQuiescent =
      rec.state === "finished" &&
      duplex.stdoutEof === true &&
      duplex.stderrEof === true &&
      (quiescent ?? true);
    const settledAt = this.#store.clock();
    const post = this.#measurePostRun(plan);
    let verdict: ClaudeStreamVerdict | null = null;
    let decodeError: string | null = null;
    let classification: SettlementClass;
    let outcome: AgentSettlement["outcome"];
    let usage: HarnessUsage;
    let detail: string;
    let proposal: Json | null = null;
    const unknown = (reason: string) =>
      unknownHarnessUsage(CLAUDE_CODE_HARNESS, reason);
    if (rec.state === "recovery-required" || res === null) {
      classification = "interrupted";
      outcome = "interrupted";
      usage = unknown("claude-command-recovery-required");
      detail = "claude-interrupted:recovery-required";
    } else if (res.outcome === "cancelled" || duplex.revoked) {
      // A late result after cancel is ignored: cancellation settles the attempt as unknown.
      classification = "interrupted";
      outcome = "interrupted";
      usage = unknown("claude-cancelled-sigterm");
      detail = "claude-interrupted:cancelled-late-result-ignored";
    } else if (res.outcome === "timeout") {
      classification = "interrupted";
      outcome = "interrupted";
      usage = unknown("claude-deadline-exceeded");
      detail = "claude-interrupted:deadline-exceeded";
    } else if (res.outcome === "lease-lost") {
      classification = "interrupted";
      outcome = "interrupted";
      usage = unknown("claude-lease-lost");
      detail = "claude-interrupted:lease-lost";
    } else if (
      duplex.failure === "binary-identity-drift" ||
      duplex.failure === "binary-identity-missing"
    ) {
      classification = "fatal";
      outcome = "failed";
      usage = unknown("claude-binary-unavailable");
      detail = `claude-fatal:${duplex.failure}`;
    } else if (post.drift.length) {
      classification = "unresolved";
      outcome = "interrupted";
      usage = unknown("claude-discovery-drift");
      detail = `claude-unresolved:discovery-drift:${post.drift.join(";")}`;
    } else {
      const decoded = this.#decodeRawStream(plan, res);
      decodeError = decoded.decodeError;
      verdict = classifyClaudeStream({
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
      const usageDecision = mapClaudeUsage({
        resultFrame: (verdict.result as Json | null) ?? null,
        resultRawLine: verdict.resultRawLine,
        requestedModel: plan.expectations.model,
        // A fatal observation (auth signal, provider, fallback model key, version drift,
        // startup failure) rejects the run BEFORE usage mapping: its telemetry is never
        // reported as subscription usage.
        lifecycleResolved:
          verdict.resolvedLifecycle && verdict.settlement !== "fatal",
        unresolvedReason:
          verdict.settlement === "fatal"
            ? `claude-fatal-before-usage-mapping:${verdict.reasons[0] ?? "fatal"}`
            : verdict.reasons[0],
      });
      usage = usageDecision.usage;
      if (verdict.settlement === "complete" && usageDecision.invalidTelemetry) {
        classification = "unresolved";
        outcome = "failed";
        detail = `claude-unresolved:${usageDecision.invalidTelemetry}`;
      } else if (verdict.settlement === "complete") {
        classification = "complete";
        proposal = verdict.proposal;
        const proposed = (proposal as unknown as { outcome: string }).outcome;
        outcome = proposed as AgentSettlement["outcome"];
        detail =
          usageDecision.usage.status === "reported"
            ? "claude-complete:protocol-qualified-proposal"
            : `claude-complete:proposal-with-${usageDecision.usage.status}-usage`;
      } else {
        classification = verdict.settlement;
        outcome = verdict.resolvedLifecycle ? "failed" : "interrupted";
        if (classification === "policy-denied" || classification === "fatal")
          outcome = "failed";
        const primary = verdict.reasons.slice(0, 4).join("|") || "unresolved";
        detail = `claude-${classification}:${primary}`;
      }
    }
    const head = this.#derivePostHead(plan);
    const settlement: AgentSettlement = {
      schema: 1,
      harness: CLAUDE_CODE_HARNESS,
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
  #recheckBundle(plan: AgentLaunchPlan) {
    for (const file of plan.bundle.files) {
      let bytes;
      try {
        bytes = readFileSync(file.path);
      } catch {
        throw namedError(`claude-bundle-drift:${file.name}`);
      }
      if (digest(bytes) !== file.sha256 || bytes.length !== file.bytes)
        throw namedError(`claude-bundle-drift:${file.name}`);
    }
    if (canonical(plan.spec.args) !== canonical(plan.bundle.argv))
      throw namedError("claude-bundle-drift:argv");
    if (canonical(plan.spec.env ?? []) !== canonical(plan.bundle.env))
      throw namedError("claude-bundle-drift:env");
    if (
      plan.spec.file !== plan.bundle.binary.path ||
      plan.spec.cwd !== plan.bundle.cwd
    )
      throw namedError("claude-bundle-drift:spawn-binding");
    const prompt = validateAgentPrompt(
      plan.prompt.text,
      this.config.limits.maxPromptBytes,
    );
    if (
      prompt.sha256 !== plan.bundle.input.sha256 ||
      prompt.bytes !== plan.bundle.input.bytes
    )
      throw namedError("claude-bundle-drift:prompt");
    const inventory = inventoryClaudeDiscovery(
      this.#discoveryInput(plan.paths),
    );
    assertClaudeDiscoveryAdmissible(inventory, {
      configDir: this.config.configDir,
    });
    if (inventory.digest !== plan.bundle.discoveryDigest)
      throw namedError("claude-bundle-drift:discovery");
    if (
      deriveTreeHead(plan.paths.src, this.config.limits.maxTreeNodes) !==
      plan.headPre
    )
      throw namedError("claude-bundle-drift:staged-tree");
  }
  #role(action: Action): ClaudeRole {
    const config = this.config;
    if (action.schema !== 2 || action.budgetMode !== SUBSCRIPTION_BUDGET_MODE)
      throw namedError("claude-subscription-mode-required");
    if (!isAgentWork(action.kind)) throw namedError("claude-agent-work-only");
    if (action.runId !== this.#lease.runId)
      throw namedError("claude-action-run-mismatch");
    if (canonical(action.versions) !== canonical(config.versions))
      throw namedError("claude-versions-mismatch");
    if (action.qualificationId !== config.qualification.id)
      throw namedError("claude-qualification-mismatch");
    return roleForKind(action.kind);
  }
  #discoveryInput(paths: ClaudeRunPaths): ClaudeDiscoveryInput {
    const config = this.config;
    return {
      managed: config.discovery.managed,
      managedDirs: config.discovery.managedDirs,
      mdm: config.discovery.mdm,
      configDir: config.configDir,
      src: paths.src,
      runRoot: paths.runRoot,
      maxTreeNodes: config.limits.maxTreeNodes,
    };
  }
  #measurePostRun(plan: AgentLaunchPlan): {
    inventoryPost: ClaudeDiscoveryInventory;
    binaryC5: BinaryIdentity | { unavailable: string };
    drift: string[];
  } {
    const inventoryPost = inventoryClaudeDiscovery(
      this.#discoveryInput(plan.paths),
    );
    const drift = claudeDiscoveryDrift(plan.inventoryPre, inventoryPost);
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
    plan: AgentLaunchPlan,
    res: CommandResultShape,
  ): {
    frames: Json[];
    lines: string[];
    decodeError: string | null;
  } {
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
  #derivePostHead(plan: AgentLaunchPlan): string {
    try {
      return deriveTreeHead(plan.paths.src, this.config.limits.maxTreeNodes);
    } catch {
      // An unreadable staged tree never fabricates a head; return a named non-adoptable value.
      return `unreadable-staged-tree:${digest(plan.action.key)}`;
    }
  }
  #writeReceipt(
    plan: AgentLaunchPlan,
    record: CommandRecord,
    verdict: ClaudeStreamVerdict | null,
    settlement: AgentSettlement,
    post: {
      inventoryPost: ClaudeDiscoveryInventory;
      binaryC5: BinaryIdentity | { unavailable: string };
      drift: string[];
    },
    decodeError: string | null,
    settledAt: number,
  ) {
    try {
      const receipt = assembleClaudeReceipt({
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
      const path = claudeReceiptPath(plan.paths, record.id);
      writeFileSync(path, `${canonical(receipt)}\n`, { mode: 0o600 });
      chmodSync(path, 0o600);
    } catch {
      // Receipt assembly is evidence, never a side effect that may mask the settlement itself.
    }
  }
}
function writeInputFile(
  path: string,
  contents: string,
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
  if (roundTrip.toString("utf8") !== contents)
    throw namedError("claude-input-file-roundtrip");
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
