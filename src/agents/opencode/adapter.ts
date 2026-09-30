import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { assertHostAdmission } from "./host.js";
import {
  materializeDependencies,
  dependencyInventory,
} from "./dependencies.js";
import { retainImmutable } from "./retention.js";
import {
  reconcileRetainedObservation,
  retainNativeStopFacts,
} from "./observation.js";
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
  OPENCODE_HARNESS,
  OPENCODE_PINNED_PROVIDER,
  opencodeAgentName,
  opencodeRoleForKind,
  validateOpencodeConfig,
  type OpencodeRole,
  type ValidatedOpencodeConfig,
} from "./config.js";
import {
  assertOpencodeSourceEnvAdmissible,
  buildOpencodeSealedEnv,
} from "./env.js";
import {
  assertOpencodeDataHomeIsolation,
  assertOpencodeIsolationAdmissible,
  buildOpencodeArgv,
  createOpencodeRunTree,
  inventoryOpencodeIsolation,
  opencodeIsolationDrift,
  renderOpencodeConfigContent,
  type OpencodeIsolationInventory,
  type OpencodeRunPaths,
} from "./launch.js";
import {
  classifyOpencodeStream,
  type OpencodeExpectations,
  type OpencodeStreamVerdict,
} from "./stream.js";
import { runOpencodeExportAudit, type OpencodeExportAudit } from "./export.js";
import { mapOpencodeUsage } from "./usage.js";
import {
  assembleOpencodeReceipt,
  opencodeExportRawPath,
  opencodeReceiptPath,
} from "./receipt.js";

export interface OpencodeLaunchInput {
  /** Exact approved prompt bytes; delivered once on stdin followed by a single EOF (F10/F23). */
  prompt: string | Uint8Array;
  /** Optional host staging callback populating SRC before validation/hashing. */
  stage?: (src: string) => void;
}
export interface OpencodeLaunchPlan {
  schema: 1;
  action: Action;
  role: OpencodeRole;
  paths: OpencodeRunPaths;
  bundle: AgentLaunchBundle;
  prompt: { text: string; bytes: number; sha256: string };
  configContent: string;
  configContentSha256: string;
  inventoryPre: OpencodeIsolationInventory;
  headPre: string;
  binaryC0: BinaryIdentity;
  spec: CommandSpec;
  limits: DuplexLimits;
  streamLimits: {
    maxLineBytes: number;
    maxTotalBytes: number;
    maxFrames: number;
  };
  expectations: OpencodeExpectations;
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
 * Direct OpenCode CLI subscription harness adapter (Taskbot #98, PoC scope by user decision
 * 2026-09-29): one fresh pinned `opencode run --format=json` invocation per agent action,
 * implemented directly against the #104 research bundle (comments 958–965) on the shared #97 seam
 * — no protected-contract ceremony (#106/#107 cancelled). The token-plan subscription auth lives
 * in a Rocky-owned dedicated XDG_DATA_HOME provisioned ONE TIME by the user (documented
 * procedure; root decision from #104 acceptance, provisional — user may veto, and the G-AUTHFILE
 * gate requires an explicit user decision before any live run). Rocky NEVER reads, copies,
 * symlinks or proxies auth.json; the shared-user-data-dir mode is unrepresentable (fail-closed
 * path comparison). Behavior is config-level only (no argv flags exist for tools/system-prompt/
 * MCP/max-turns): a sealed OPENCODE_CONFIG_CONTENT carries the pinned provider, the role agents
 * (prompt REPLACES the default system prompt) and the permission tables, and isolation is
 * XDG_CONFIG_HOME + OPENCODE_DISABLE_PROJECT_CONFIG + isolated OPENCODE_DB + pinned catalog.
 * The stream has NO result/done event (F21), so completion is the conjunction: clean EOF + exit 0
 * + a parseable final text (host-revalidated, proposal-only) + the MANDATORY post-run
 * `opencode export <sessionID>` audit (served modelID/providerID/version/directory + aggregate
 * tokens). Usage maps onto #90 schema 2 from the export aggregate only. Live runs are deferred to
 * #14; this package never executes the installed opencode binary.
 */
export class OpencodeAdapter {
  readonly capability = null;
  readonly qualification: ExecutionQualification;
  readonly versions: Versions;
  readonly config: ValidatedOpencodeConfig;
  #store: Store;
  #lease: Lease;
  #runner: DuplexRunner;
  #sourceEnv: Record<string, string | undefined>;
  #renewLease = true;
  #exportSignal?: AbortSignal;
  #canStart: () => boolean = () => true;
  #settling = new Map<string, Promise<ResultEvent>>();
  #plans = new Map<string, OpencodeLaunchPlan>();
  constructor(
    store: Store,
    lease: Lease,
    config: unknown,
    options: {
      sourceEnv?: Record<string, string | undefined>;
      renewLease?: boolean;
      canStart?: () => boolean;
      exportSignal?: AbortSignal;
    } = {},
  ) {
    this.#store = store;
    this.#lease = JSON.parse(canonical(lease)) as Lease;
    this.config = validateOpencodeConfig(config);
    this.#runner = new DuplexRunner(store);
    this.#sourceEnv = options.sourceEnv ?? process.env;
    this.#renewLease = options.renewLease !== false;
    if (options.exportSignal) this.#exportSignal = options.exportSignal;
    this.#canStart = options.canStart ?? (() => true);
    store.assertLease(this.#lease);
    this.qualification = this.config.qualification;
    this.versions = this.config.versions;
  }
  /** C0 prepare: verify the pinned binary, create the per-action RUN tree, admit the data-dir
   * isolation, inventory the sealed environment, stage and hash the tree, render the sealed
   * config content and argv, and freeze the prompt. Synchronous; any rejection yields zero spawn
   * and (for identity/isolation refusals) zero run-tree side effects. */
  prepareLaunch(
    action: Readonly<Action>,
    input: OpencodeLaunchInput,
  ): OpencodeLaunchPlan {
    const frozen = JSON.parse(canonical(action)) as Action;
    const role = this.#role(frozen);
    assertOpencodeSourceEnvAdmissible(this.#sourceEnv);
    const config = this.config;
    if (config.evidenceClass === "live-subscription")
      assertHostAdmission(config);
    const limits = config.limits;
    const now = this.#store.clock();
    if (frozen.deadline <= now + limits.cleanupReserveMs + limits.killGraceMs)
      throw namedError("opencode-deadline-insufficient");
    const prompt = validateAgentPrompt(input.prompt, limits.maxPromptBytes);
    // C0 binary identity precedes any RUN-tree side effect: a refused profile leaves nothing
    // behind and is never substituted.
    const binaryC0 = assertBinaryIdentity({
      path: config.binary.path,
      sha256: config.binary.sha256,
      bytes: config.binary.bytes,
    });
    // Data-dir isolation is fail-closed BEFORE any run-tree side effect (root decision F8/#966).
    const isolation = assertOpencodeDataHomeIsolation(
      config.dataHome,
      config.hostIdentity.userHome,
    );
    if (!existsSync(resolve(config.runsRoot)))
      mkdirSync(resolve(config.runsRoot), { recursive: true, mode: 0o700 });
    const runsRoot = realpathSync(resolve(config.runsRoot));
    const runRoot = join(runsRoot, `run-${digest(frozen.key).slice(0, 32)}`);
    const paths = createOpencodeRunTree(runRoot);
    input.stage?.(paths.src);
    if (config.hostAdmission)
      materializeDependencies(
        config.hostAdmission.dependencies,
        paths.configHome,
      );
    const inventoryPre = inventoryOpencodeIsolation({
      config,
      paths,
      authProvisioned: isolation.authProvisioned,
    });
    assertOpencodeIsolationAdmissible(inventoryPre, config);
    const headPre = deriveTreeHead(paths.src, limits.maxTreeNodes);
    const configContent = renderOpencodeConfigContent({
      implementer: {
        role: "implementer",
        model: config.roles.implementer.model,
        steps: config.roles.implementer.steps,
        prompt: config.roles.implementer.prompt,
      },
      reviewer: {
        role: "reviewer",
        model: config.roles.reviewer.model,
        steps: config.roles.reviewer.steps,
        prompt: config.roles.reviewer.prompt,
      },
    });
    const argv = buildOpencodeArgv({
      role,
      model: config.roles[role].model,
      dir: paths.src,
      maxArgvBytes: limits.maxArgvBytes,
    });
    const env = buildOpencodeSealedEnv({
      home: paths.parentHome,
      tmpdir: paths.parentTmp,
      pwd: paths.src,
      configHome: paths.configHome,
      dataHome: config.dataHome,
      cacheHome: paths.cacheHome,
      stateHome: paths.stateHome,
      db: paths.db,
      modelsPath: config.modelsCatalog.path,
      configContent,
    });
    const bundle = sealAgentLaunchBundle({
      schema: 1,
      harness: OPENCODE_HARNESS,
      binary: {
        path: binaryC0.path,
        sha256: binaryC0.sha256,
        bytes: binaryC0.bytes,
      },
      argv,
      env,
      cwd: paths.src,
      input: { bytes: prompt.bytes, sha256: prompt.sha256 },
      files: [],
      discoveryDigest: inventoryPre.digest,
    });
    // Deterministic supervisor backstop: the reserved action allowance minus the cleanup reserve.
    // The EXACT original deadline is enforced transactionally by the store's dispatch guard.
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
    const plan: OpencodeLaunchPlan = {
      schema: 1,
      action: frozen,
      role,
      paths,
      bundle,
      prompt,
      configContent,
      configContentSha256: digest(Buffer.from(configContent, "utf8")),
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
        role,
        maxParts: limits.maxParts,
        maxFinalBytes: limits.maxFinalBytes,
      },
      preparedAt: now,
    };
    const existing = this.#plans.get(frozen.key);
    if (existing) {
      // Idempotent re-prepare (restart reconciliation): identical re-rendering returns the frozen
      // plan; a changed bundle for the same action is a conflict, never a silent replace.
      if (existing.bundle.bundleDigest !== bundle.bundleDigest)
        throw namedError("opencode-plan-conflict");
      return existing;
    }
    this.#plans.set(frozen.key, plan);
    return plan;
  }
  /** Transport begin: synchronous initiation under the dispatch guarded start. C1 (lease/fence/
   * deadline/binary rehash) is rechecked by the store and the gate inside the guarded spawn; C3
   * queues the exact prompt bytes plus one EOF (durable attempted-before-IO, never resent). */
  begin(action: Readonly<Action>): Promise<ResultEvent> {
    if (!this.#canStart()) throw namedError("opencode-worker-disconnected");
    const plan = this.#plans.get(action.key);
    if (!plan) throw namedError("opencode-launch-not-prepared");
    if (canonical(plan.action) !== canonical(action))
      throw namedError("opencode-action-mismatch");
    assertOpencodeSourceEnvAdmissible(this.#sourceEnv);
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
  /** Durable cancellation request: SIGTERM of the owned group is performed by the supervisor
   * (TERM→KILL escalation). No interrupt acknowledgement is ever claimed here (G-SIG). */
  interrupt(action: Readonly<Action>) {
    this.#runner.interrupt(this.#lease, action);
  }
  plan(actionKey: string): OpencodeLaunchPlan | undefined {
    return this.#plans.get(actionKey);
  }
  #settle(plan: OpencodeLaunchPlan, id: string): Promise<ResultEvent> {
    const old = this.#settling.get(id);
    if (old) return old;
    const pending = (async () => {
      const { record, quiescent } = await this.#runner.wait(this.#lease, id, {
        renewLease: this.#renewLease,
      });
      const settlement = await this.settleCommand(plan, id, record, quiescent);
      return settlementToResultEvent(settlement, plan.action);
    })();
    this.#settling.set(id, pending);
    return pending;
  }
  /** C5 settlement from the durable command record: post-run rehash (isolation inventory +
   * binary), strict stream decode, classification, the MANDATORY export-audit success conjunct,
   * usage mapping, host-derived head and the receipt. Also the reconciliation entrypoint after a
   * restart: it observes an existing terminal command and never relaunches. */
  async settleCommand(
    plan: OpencodeLaunchPlan,
    id: string,
    record?: CommandRecord,
    quiescent?: boolean,
  ): Promise<AgentSettlement> {
    // The waiter's record may predate a control revocation. C5 freezes the current durable
    // stop facts before classification; subsequent revocations cannot alter this observation.
    const rec = this.#store.command(id) ?? record;
    if (!rec || rec.runId !== plan.action.runId)
      throw namedError("opencode-command-not-found");
    if (rec.state === "starting" || rec.state === "running")
      throw namedError("opencode-command-unsettled");
    const duplex = rec.duplex;
    if (!duplex) throw namedError("opencode-command-not-found");
    const res = (rec.result ?? null) as CommandResultShape | null;
    const physicalQuiescent =
      rec.state === "finished" &&
      duplex.stdoutEof === true &&
      duplex.stderrEof === true &&
      quiescent === true;
    try {
      const retainedObservation = reconcileRetainedObservation(
        this.#store,
        this.config,
        plan,
        id,
        physicalQuiescent,
      );
      if (retainedObservation) return retainedObservation.settlement;
    } catch (error) {
      const refusal = {
        schema: 1,
        actionKey: plan.action.key,
        inputDigest: plan.action.inputDigest,
        commandId: id,
        bundleDigest: plan.bundle.bundleDigest,
        reason: (error as Error).message.slice(0, 512),
        previousObservation:
          this.#store.operatorRecord(
            "opencode-observation/" + plan.action.key,
          ) ?? null,
        disposition:
          "replay-refused; original evidence preserved; no native/export dispatch",
      };
      this.#store.retainOperatorRecord(
        "opencode-replay-refusal/" +
          plan.action.key +
          "/" +
          digest(canonical(refusal)),
        refusal,
      );
      throw error;
    }
    retainNativeStopFacts(this.#store, plan, rec, physicalQuiescent);
    const settledAt = this.#store.clock();
    let post = this.#measurePostRun(plan);
    let verdict: OpencodeStreamVerdict | null = null;
    let decodeError: string | null = null;
    let exportAudit: OpencodeExportAudit | null = null;
    let exportRawPath: string | null = null;
    let classification: SettlementClass;
    let outcome: AgentSettlement["outcome"];
    let usage: HarnessUsage;
    let detail: string;
    let proposal: Json | null = null;
    const unknown = (reason: string) =>
      unknownHarnessUsage(OPENCODE_HARNESS, reason);
    if (rec.state === "recovery-required" || res === null) {
      classification = "interrupted";
      outcome = "interrupted";
      usage = unknown("opencode-command-recovery-required");
      detail = "opencode-interrupted:recovery-required";
    } else if (res.outcome === "cancelled" || duplex.revoked) {
      // A late result after cancel is ignored: cancellation settles the attempt as unknown.
      classification = "interrupted";
      outcome = "interrupted";
      usage = unknown("opencode-cancelled-sigterm");
      detail = "opencode-interrupted:cancelled-late-result-ignored";
    } else if (res.outcome === "timeout") {
      classification = "interrupted";
      outcome = "interrupted";
      usage = unknown("opencode-deadline-exceeded");
      detail = "opencode-interrupted:deadline-exceeded";
    } else if (res.outcome === "lease-lost") {
      classification = "interrupted";
      outcome = "interrupted";
      usage = unknown("opencode-lease-lost");
      detail = "opencode-interrupted:lease-lost";
    } else if (
      duplex.failure === "binary-identity-drift" ||
      duplex.failure === "binary-identity-missing"
    ) {
      classification = "fatal";
      outcome = "failed";
      usage = unknown("opencode-binary-unavailable");
      detail = `opencode-fatal:${duplex.failure}`;
    } else if (post.drift.length) {
      classification = "unresolved";
      outcome = "interrupted";
      usage = unknown("opencode-isolation-drift");
      detail = `opencode-unresolved:isolation-drift:${post.drift.join(";")}`;
    } else {
      const decoded = this.#decodeRawStream(plan, res);
      decodeError = decoded.decodeError;
      verdict = classifyOpencodeStream({
        frames: decoded.frames,
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
      if (
        verdict.settlement === "complete" &&
        verdict.sessionId &&
        this.#canStart()
      ) {
        // The export audit is a REQUIRED success conjunct (F25/PART 4 §2): it runs only after
        // physical quiescence, in the same sealed env, against the same isolated OPENCODE_DB.
        exportRawPath = opencodeExportRawPath(plan.paths, rec.id);
        const [, modelID] = splitModel(this.config.roles[plan.role].model);
        let exportAllowed = true;
        try {
          this.#store.assertLease(this.#lease);
        } catch {
          exportAllowed = false;
        }
        if (exportAllowed)
          exportAudit = await runOpencodeExportAudit({
            start: (launch) =>
              this.#store.guardedStart(this.#lease, () => {
                if (!this.#canStart())
                  throw namedError("opencode-worker-disconnected");
                this.#store.assertDuplexAction(this.#lease, plan.action);
                assertBinaryIdentity(plan.bundle.binary);
                return launch();
              }),
            ...(this.#exportSignal ? { signal: this.#exportSignal } : {}),
            binaryPath: plan.bundle.binary.path,
            env: plan.bundle.env,
            cwd: plan.paths.src,
            timeoutMs: this.config.limits.exportTimeoutMs,
            maxExportBytes: this.config.limits.maxExportBytes,
            retainPath: exportRawPath,
            expectations: {
              sessionId: verdict.sessionId,
              version: this.config.binary.version,
              directory: plan.paths.src,
              providerID: OPENCODE_PINNED_PROVIDER,
              modelID,
              summedTokens: verdict.summedTokens,
            },
            observe: (observation) =>
              this.#store.retainOperatorRecord(
                "opencode-export-observation/" + rec.id,
                {
                  schema: 1,
                  commandId: rec.id,
                  runId: plan.action.runId,
                  actionKey: plan.action.key,
                  inputDigest: plan.action.inputDigest,
                  bundleDigest: plan.bundle.bundleDigest,
                  binary: plan.bundle.binary,
                  argv: ["export", verdict!.sessionId],
                  envSha256: digest(canonical(plan.bundle.env)),
                  cwd: plan.paths.src,
                  rawPath: exportRawPath,
                  timeoutMs: this.config.limits.exportTimeoutMs,
                  maxExportBytes: this.config.limits.maxExportBytes,
                  observation,
                },
              ),
          });
      }
      if (verdict.settlement === "complete" && exportAudit?.ok) {
        usage = mapOpencodeUsage({
          lifecycleResolved: verdict.resolvedLifecycle,
          audit: exportAudit,
          summedTokens: verdict.summedTokens,
        });
        classification = "complete";
        proposal = verdict.final;
        outcome = (proposal as unknown as { outcome: string })
          .outcome as AgentSettlement["outcome"];
        detail =
          usage.status === "reported"
            ? "opencode-complete:protocol-qualified-proposal"
            : `opencode-complete:proposal-with-${usage.status}-usage`;
      } else if (
        verdict.settlement === "complete" &&
        exportAudit &&
        !exportAudit.ok
      ) {
        // Export failure is never success: a served-identity mismatch is fatal; unavailable
        // evidence (spawn/timeout/parse/shape/missing session) is unresolved with unknown usage.
        classification = exportAudit.fatal ? "fatal" : "unresolved";
        outcome = "failed";
        usage = unknown(
          exportAudit.fatal
            ? `opencode-export-fatal:${exportAudit.reason}`
            : `opencode-export-unavailable:${exportAudit.reason}`,
        );
        detail = `opencode-${classification}:export-audit:${exportAudit.reason}`;
      } else if (verdict.settlement === "complete") {
        // Complete stream without a session ID cannot be audited ⇒ never success (defensive;
        // resolvedLifecycle already requires a session ID).
        classification = "unresolved";
        outcome = "failed";
        usage = unknown("opencode-export-not-run");
        detail = "opencode-unresolved:export-audit-missing-session-id";
      } else {
        classification = verdict.settlement;
        outcome = verdict.resolvedLifecycle ? "failed" : "interrupted";
        if (classification === "policy-denied" || classification === "fatal")
          outcome = "failed";
        usage = unknown(
          `opencode-${classification}-before-usage-mapping:${verdict.reasons[0] ?? "unsettled"}`,
        );
        const primary = verdict.reasons.slice(0, 4).join("|") || "unresolved";
        detail = `opencode-${classification}:${primary}`;
      }
    }
    post = this.#measurePostRun(plan);
    if (post.drift.length && classification === "complete") {
      classification = "unresolved";
      outcome = "failed";
      detail = "opencode-post-export-isolation-drift";
    }
    if (
      this.config.evidenceClass === "live-subscription" &&
      classification === "complete" &&
      (usage.status !== "reported" ||
        !verdict?.stepStartCount ||
        !verdict.stepFinishCount ||
        !exportAudit?.ok ||
        exportAudit.divergence)
    ) {
      classification = "unresolved";
      outcome = "failed";
      detail = "opencode-first-live-observation-incomplete";
    }
    const head = this.#derivePostHead(plan);
    const settlement: AgentSettlement = {
      schema: 1,
      harness: OPENCODE_HARNESS,
      classification,
      outcome,
      quiescent: physicalQuiescent,
      usage,
      head,
      detail,
      proposal,
    };
    let retained: { path: string; sha256: string; bytes: number } | null = null;
    try {
      retained = this.#writeReceipt(
        plan,
        rec,
        verdict,
        settlement,
        post,
        exportAudit,
        exportRawPath,
        decodeError,
        settledAt,
      );
    } catch {
      settlement.classification = "unresolved";
      settlement.outcome = "failed";
      settlement.detail = "opencode-receipt-retention-failed";
    }
    this.#store.retainOperatorRecord(
      "opencode-observation/" + plan.action.key,
      {
        schema: 1,
        actionKey: plan.action.key,
        inputDigest: plan.action.inputDigest,
        bundleDigest: plan.bundle.bundleDigest,
        commandId: rec.id,
        evidenceClass: this.config.evidenceClass,
        receipt: retained,
        settlement: JSON.parse(canonical(settlement)),
      },
    );
    return settlement;
  }
  #recheckBundle(plan: OpencodeLaunchPlan) {
    if (canonical(plan.spec.args) !== canonical(plan.bundle.argv))
      throw namedError("opencode-bundle-drift:argv");
    if (canonical(plan.spec.env ?? []) !== canonical(plan.bundle.env))
      throw namedError("opencode-bundle-drift:env");
    if (
      plan.spec.file !== plan.bundle.binary.path ||
      plan.spec.cwd !== plan.bundle.cwd
    )
      throw namedError("opencode-bundle-drift:spawn-binding");
    const prompt = validateAgentPrompt(
      plan.prompt.text,
      this.config.limits.maxPromptBytes,
    );
    if (
      prompt.sha256 !== plan.bundle.input.sha256 ||
      prompt.bytes !== plan.bundle.input.bytes
    )
      throw namedError("opencode-bundle-drift:prompt");
    if (this.config.evidenceClass === "live-subscription")
      assertHostAdmission(this.config);
    if (
      this.config.hostAdmission &&
      dependencyInventory(join(plan.paths.configHome, "opencode")) !==
        this.config.hostAdmission.dependencies.inventorySha256
    )
      throw namedError("opencode-dependency-materialization-drift");
    const isolation = assertOpencodeDataHomeIsolation(
      this.config.dataHome,
      this.config.hostIdentity.userHome,
    );
    const inventory = inventoryOpencodeIsolation({
      config: this.config,
      paths: plan.paths,
      authProvisioned: isolation.authProvisioned,
    });
    assertOpencodeIsolationAdmissible(inventory, this.config);
    if (inventory.digest !== plan.bundle.discoveryDigest)
      throw namedError("opencode-bundle-drift:isolation");
    if (
      deriveTreeHead(plan.paths.src, this.config.limits.maxTreeNodes) !==
      plan.headPre
    )
      throw namedError("opencode-bundle-drift:staged-tree");
  }
  #role(action: Action): OpencodeRole {
    const config = this.config;
    if (action.schema !== 2 || action.budgetMode !== SUBSCRIPTION_BUDGET_MODE)
      throw namedError("opencode-subscription-mode-required");
    if (!isAgentWork(action.kind)) throw namedError("opencode-agent-work-only");
    if (action.runId !== this.#lease.runId)
      throw namedError("opencode-action-run-mismatch");
    if (canonical(action.versions) !== canonical(config.versions))
      throw namedError("opencode-versions-mismatch");
    if (action.qualificationId !== config.qualification.id)
      throw namedError("opencode-qualification-mismatch");
    return opencodeRoleForKind(action.kind);
  }
  #measurePostRun(plan: OpencodeLaunchPlan): {
    inventoryPost: OpencodeIsolationInventory;
    binaryC5: BinaryIdentity | { unavailable: string };
    drift: string[];
  } {
    let authProvisioned = plan.inventoryPre.authProvisioned;
    let dataHomeInadmissible = false;
    try {
      authProvisioned = assertOpencodeDataHomeIsolation(
        this.config.dataHome,
        this.config.hostIdentity.userHome,
      ).authProvisioned;
    } catch {
      // A data dir that became inadmissible mid-run is itself drift.
      dataHomeInadmissible = true;
    }
    const inventoryPost = inventoryOpencodeIsolation({
      config: this.config,
      paths: plan.paths,
      authProvisioned,
    });
    const drift = opencodeIsolationDrift(plan.inventoryPre, inventoryPost);
    if (this.config.hostAdmission)
      try {
        if (
          dependencyInventory(join(plan.paths.configHome, "opencode")) !==
          this.config.hostAdmission.dependencies.inventorySha256
        )
          drift.push("dependency-materialization-drift");
        assertHostAdmission(this.config);
      } catch {
        drift.push("host-admission-drift");
      }
    if (dataHomeInadmissible) drift.push("data-home-inadmissible-post-run");
    if (authProvisioned !== plan.inventoryPre.authProvisioned)
      drift.push("auth-provisioning-changed");
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
    plan: OpencodeLaunchPlan,
    res: CommandResultShape,
  ): { frames: Json[]; decodeError: string | null } {
    const decoder = new StrictNdjsonDecoder(plan.streamLimits);
    let decodeError: string | null = null;
    try {
      decoder.push(readFileSync(res.stdout));
      decoder.end();
    } catch (error) {
      decodeError = (error as Error).message || "strict-decode-failed";
    }
    return { frames: decoder.frames, decodeError };
  }
  #derivePostHead(plan: OpencodeLaunchPlan): string {
    try {
      return deriveTreeHead(plan.paths.src, this.config.limits.maxTreeNodes);
    } catch {
      // An unreadable staged tree never fabricates a head; return a named non-adoptable value.
      return `unreadable-staged-tree:${digest(plan.action.key)}`;
    }
  }
  #writeReceipt(
    plan: OpencodeLaunchPlan,
    record: CommandRecord,
    verdict: OpencodeStreamVerdict | null,
    settlement: AgentSettlement,
    post: {
      inventoryPost: OpencodeIsolationInventory;
      binaryC5: BinaryIdentity | { unavailable: string };
      drift: string[];
    },
    exportAudit: OpencodeExportAudit | null,
    exportRawPath: string | null,
    decodeError: string | null,
    settledAt: number,
  ) {
    const receipt = assembleOpencodeReceipt({
      actionKey: plan.action.key,
      inputDigest: plan.action.inputDigest,
      runId: plan.action.runId,
      deadline: plan.action.deadline,
      role: plan.role,
      model: this.config.roles[plan.role].model,
      agent: opencodeAgentName(plan.role),
      paths: plan.paths,
      record,
      verdict,
      settlement,
      config: this.config,
      binaryC0: plan.binaryC0,
      binaryC5: post.binaryC5,
      inventoryPre: plan.inventoryPre,
      inventoryPost: post.inventoryPost,
      drift: post.drift,
      configContent: plan.configContent,
      configContentSha256: plan.configContentSha256,
      argvSha256: digest(canonical(plan.bundle.argv)),
      envSha256: digest(canonical(plan.bundle.env)),
      inputSha256: plan.bundle.input.sha256,
      bundleDigest: plan.bundle.bundleDigest,
      exportAudit,
      exportRawPath:
        exportRawPath && existsSync(exportRawPath) ? exportRawPath : null,
      decodeError,
      headPre: plan.headPre,
      preparedAt: plan.preparedAt,
      settledAt,
    });
    const path = opencodeReceiptPath(plan.paths, record.id);
    return retainImmutable(path, `${canonical(receipt)}\n`);
  }
}
/** Split the model string on the FIRST '/' (F4): provider/model. */
export function splitModel(model: string): [string, string] {
  const at = model.indexOf("/");
  if (at <= 0 || at === model.length - 1)
    throw namedError("opencode-model-shape");
  return [model.slice(0, at), model.slice(at + 1)];
}
function safeFileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
