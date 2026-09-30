import {
  ATT764_RECIPE,
  ATT764_TASK,
  ATT764_TITLE,
  att764CommitArgs,
  currentCheckRecipe,
  discoverCurrent,
  stageATT764,
  applyATT764,
  freezeATT764Instructions,
} from "../attraccess/current.js";
import {
  cpSync,
  openSync,
  closeSync,
  fstatSync,
  readSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { Store, type Lease, type Versions } from "../store/index.js";
import { Evidence, type Artifact } from "../evidence/index.js";
import { canonical, identity, type Json } from "../store/json.js";
import {
  OpencodeAdapter,
  OpencodeWorkerClient,
  assertAgentObservation,
  assertOpencodeDataHomeIsolation,
  type OpencodeConfig,
} from "../agents/opencode/index.js";
import { assertBinaryIdentity } from "../runner/process.js";
import { CommandRunner, type CommandResult } from "../runner/index.js";
import type {
  Action,
  Event,
  ReceiptKind,
  Observation,
  CoordinatorTransport,
} from "../coordinator/index.js";
import {
  GitHub,
  execute,
  type Execute,
  type PullRequest,
  type CIObservation,
  type MergeRequest,
} from "../delivery/github.js";
import {
  buildRuntime,
  defaults,
  readAuthority,
  validateOperatorConfig,
  type OperatorConfig,
  type HostAuthority,
} from "./config.js";
import { assertHomeAvailable, ownHome } from "./ownership.js";
import { terminal } from "../coordinator/contracts.js";

export interface OperatorRun {
  id: string;
  revision: number;
  issue: string;
  previousRunId: string | null;
  createdAt: number;
  config: OperatorConfig;
  workspace: string;
  branch: string;
  phase: string;
  message: string;
  head: string;
  base: string;
  pr: PullRequest | null;
  ci: CIObservation | null;
  mergeRequest: MergeRequest | null;
  approval: {
    head: string;
    base: string;
    integration: string | null;
    at: number;
    approver: string;
  } | null;
  closedAt: number | null;
  closeoutNote: string;
  diff: string;
  evidenceClass: string;
}
type OperatorAdapter = Pick<
  OpencodeAdapter,
  "begin" | "interrupt" | "versions" | "qualification" | "capability"
> & {
  prepareLaunch: (
    action: Readonly<Action>,
    input: Parameters<OpencodeAdapter["prepareLaunch"]>[1],
  ) =>
    | ReturnType<OpencodeAdapter["prepareLaunch"]>
    | Promise<ReturnType<OpencodeAdapter["prepareLaunch"]>>;
  close?: () => Promise<void>;
  notDispatched?: (
    action: Action,
    reason: string,
  ) => Promise<Extract<Event, { type: "result" }>>;
};
export interface Dependencies {
  execute?: Execute;
  github?: GitHub;
  authority?: HostAuthority;
  runtime?: OpencodeConfig;
  adapter?: (
    store: Store,
    lease: Lease,
    config: OpencodeConfig,
  ) => OpencodeAdapter;
}
export class OperatorService extends EventEmitter {
  readonly store: Store;
  readonly evidence: Evidence;
  readonly versions: Versions;
  readonly exec: Execute;
  readonly github: GitHub;
  private heartbeat: NodeJS.Timeout;
  private ciTimer: NodeJS.Timeout;
  private starting = false;
  private stopping = false;
  private approving = new Set<string>();
  private approvalWork = new Map<string, Promise<unknown>>();
  private active = new Map<string, Promise<void>>();
  private leases = new Map<string, Lease>();
  private adapters = new Map<string, OperatorAdapter>();
  private releaseHome: () => void;
  constructor(
    readonly home: string,
    readonly deps: Dependencies = {},
  ) {
    super();
    assertHomeAvailable(home);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    this.store = new Store(join(home, "state.sqlite"));
    try {
      this.releaseHome = ownHome(home, this.store);
    } catch (error) {
      this.store.close();
      throw error;
    }
    this.evidence = new Evidence(join(home, "evidence"));
    let build = "development";
    try {
      build = JSON.parse(
        readFileSync(
          new URL("../build-identity.json", import.meta.url),
          "utf8",
        ),
      ).buildId;
    } catch {
      /* tests */
    }
    this.versions = deps.runtime?.versions ?? {
      workflow: "operator-mvp-1",
      adapter: "opencode-98",
      prompt: "operator-1",
      runner: "foundation-1",
      build,
    };
    this.heartbeat = setInterval(() => {
      for (const lease of this.leases.values())
        try {
          this.store.renew(lease, 60000);
        } catch {
          /* Runner fencing handles lease loss. */
        }
    }, 3000);
    this.heartbeat.unref();
    this.exec = deps.execute ?? execute;
    this.github = deps.github ?? new GitHub(this.exec);
    this.ciTimer = setInterval(() => {
      for (const run of this.runs())
        if (
          ["awaiting_ci", "merge_requested"].includes(run.phase) &&
          !this.active.has(run.id)
        ) {
          if (Date.now() > run.createdAt + run.config.totalMinutes * 60000) {
            run.message =
              run.phase === "merge_requested"
                ? "Merge confirmation deadline exceeded; refresh to reconcile the sent request"
                : "CI observation deadline exceeded";
            run.phase = "blocked";
            this.save(run);
          } else
            void this.refresh(run.id).catch((error) => {
              const current = this.run(run.id);
              if (current.phase !== "cancelled") {
                current.phase = "blocked";
                current.message = (error as Error).message;
                this.save(current);
              }
            });
        }
    }, 30000);
    this.ciTimer.unref();
    for (const run of this.runs())
      if (
        [
          "preparing",
          "baseline",
          "implementing",
          "verifying",
          "reviewing",
          "publishing",
          "merging",
        ].includes(run.phase)
      ) {
        run.phase = this.store.coordinatorSnapshot(run.id)?.cancelled
          ? "cancelled"
          : "recovery_required";
        run.message =
          "Daemon restarted during work. Retained processes/effects need reconciliation; this run will not be relaunched.";
        this.save(run, true);
      }
  }
  config() {
    return (
      this.store.operatorRecord<OperatorConfig>("config") ?? { ...defaults }
    );
  }
  configure(value: unknown) {
    const config = validateOperatorConfig(value);
    this.store.saveOperatorRecord("config", config);
    this.emit("change");
    return config;
  }
  runs() {
    return this.store
      .operatorRecords<OperatorRun>("run/")
      .map((run) => this.run(run.id));
  }
  run(id: string) {
    const r = this.store.operatorRecord<OperatorRun>("run/" + id);
    if (!r) throw new Error("Run not found");
    r.revision ??= 0;
    if (this.store.coordinatorSnapshot(id) && this.store.get(id).cancelled) {
      if (r.phase !== "cancelled")
        r.message =
          "Cancellation is authoritative; retained work/effects remain available for inspection";
      r.phase = "cancelled";
    }
    return r;
  }
  detail(id: string) {
    const r = this.run(id);
    return {
      ...r,
      rerunReady:
        !!r.config &&
        !this.stopping &&
        !this.starting &&
        !this.active.size &&
        !this.approving.size &&
        !this.store.implementationSlot() &&
        this.currentIssueRun(r.config) === r.id &&
        this.rerunBlocker(r) === null,
      effects: this.store.coordinatorSnapshot(id) ? this.store.effects(id) : [],
      snapshot: this.store.coordinatorSnapshot(id) ?? null,
      activity: this.store.coordinatorSnapshot(id)
        ? this.store
            .commands(id)
            .slice(-3)
            .map((command) => ({
              id: command.id,
              state: command.state,
              stdout: logTail(
                join(
                  (command.spec as unknown as { outputDir: string }).outputDir,
                  "stdout.log",
                ),
              ),
              stderr: logTail(
                join(
                  (command.spec as unknown as { outputDir: string }).outputDir,
                  "stderr.log",
                ),
              ),
            }))
        : [],
      events: this.store.coordinatorSnapshot(id)
        ? this.store.events(id).slice(-100)
        : [],
      commands: this.store.coordinatorSnapshot(id)
        ? this.store.commands(id)
        : [],
    };
  }
  save(run: OperatorRun, orphanRecovery = false) {
    const revision = run.revision ?? 0;
    const snapshot = this.store.coordinatorSnapshot(run.id);
    if (
      snapshot &&
      this.store.get(run.id).cancelled &&
      run.phase !== "cancelled"
    )
      throw new Error("cancelled");
    const next = { ...run, revision: revision + 1 };
    this.store.compareOperatorRecord(
      "run/" + run.id,
      revision,
      next,
      snapshot && !orphanRecovery ? this.lease(run) : undefined,
    );
    run.revision = next.revision;
    this.emit("change");
  }
  authority() {
    return this.deps.authority ?? readAuthority(this.home);
  }
  runtime(authority: HostAuthority) {
    return (
      this.deps.runtime ?? buildRuntime(this.home, authority, this.versions)
    );
  }
  async preflight(
    config = this.config(),
    capture?: (
      authority: HostAuthority,
      runtime: OpencodeConfig,
      target: Json | null,
    ) => void,
  ) {
    const blockers: string[] = [];
    let target: Json | null = null;
    let runtime: OpencodeConfig | null = null;
    if (!config.repositoryPath)
      blockers.push(
        "Choose a local target checkout. Rocky creates its own copy and does not edit the original.",
      );
    if (config.repository.toLowerCase() === "attraccess/attraccess") {
      for (let dir = resolve(this.home); ; ) {
        if (existsSync(join(dir, ".git"))) {
          blockers.push(
            "Choose ROCKY_NEXT_HOME outside a Git checkout for isolated OpenCode runs.",
          );
          break;
        }
        if (dirname(dir) === dir) break;
        dir = dirname(dir);
      }
      try {
        const profile = JSON.parse(
          readFileSync(join(this.home, "target.json"), "utf8"),
        );
        const source = discoverCurrent(
          config.repositoryPath,
          join(this.home, "attraccess"),
        );
        const baseHead = await this.exec(
          "git",
          ["rev-parse", config.baseBranch],
          config.repositoryPath,
        );
        if (
          profile.recipe !== ATT764_RECIPE ||
          profile.base !== source.commit ||
          baseHead !== profile.base ||
          canonical(profile.recipeFiles) !== canonical(source.recipeFiles)
        )
          throw new Error("Prepared source has changed");
        if (config.task !== ATT764_TASK) throw new Error("Unsupported task");
        target = profile;
        await this.exec(
          "docker",
          ["info", "--format", "{{.ServerVersion}}"],
          this.home,
        );
      } catch {
        blockers.push(
          "Prepare this checkout with rocky-next setup /path/to/attraccess (Docker must be running).",
        );
      }
    }
    if (!config.task.trim())
      blockers.push("Describe the scoped coding task and acceptance criteria.");
    let authority: HostAuthority | null = null;
    try {
      authority = this.authority();
    } catch (e) {
      blockers.push((e as Error).message);
    }
    if (!authority)
      blockers.push(
        "Live execution setup is pending. Run rocky-next setup, then follow the setup guide below.",
      );
    if (
      authority &&
      authority.repository.toLowerCase() !== config.repository.toLowerCase()
    )
      blockers.push("The target is outside the approved host authority.");
    if (authority?.task && authority.task !== config.task)
      blockers.push("The task differs from the approved ATT-764 scope.");
    if (
      authority &&
      config.repository.toLowerCase() === "attraccess/attraccess" &&
      (authority.profile !== ATT764_RECIPE ||
        authority.task !== ATT764_TASK ||
        canonical(authority.checks) !== canonical([currentCheckRecipe()]))
    )
      blockers.push(
        "Host authority must use the prepared ATT-764 check recipe.",
      );
    if (config.repositoryPath) {
      try {
        const root = await this.exec(
          "git",
          ["rev-parse", "--show-toplevel"],
          config.repositoryPath,
        );
        if (resolve(root) !== resolve(config.repositoryPath)) throw new Error();
        await this.exec(
          "git",
          ["rev-parse", "--verify", `${config.baseBranch}^{commit}`],
          config.repositoryPath,
        );
        const remote = await this.exec(
          "git",
          ["remote", "get-url", "origin"],
          config.repositoryPath,
        );
        const repo =
          /^(?:https:\/\/github\.com\/|git@github\.com:)([^/]+\/[^/]+?)(?:\.git)?$/.exec(
            remote,
          )?.[1];
        if (repo?.toLowerCase() !== config.repository.toLowerCase())
          throw new Error(
            "Target origin does not match selected GitHub repository",
          );
      } catch {
        blockers.push(
          "Target checkout, base branch, or matching GitHub origin is unavailable.",
        );
      }
    }
    if (authority)
      try {
        const rt = this.runtime(authority);
        runtime = rt;
        assertBinaryIdentity(rt.binary);
        if (
          !assertOpencodeDataHomeIsolation(
            rt.dataHome,
            rt.hostIdentity.userHome,
          ).authProvisioned
        )
          blockers.push(
            "Provision OpenCode auth into the Rocky-owned data directory.",
          );
      } catch (e) {
        blockers.push("OpenCode setup: " + (e as Error).message);
      }
    if (!this.deps.github)
      try {
        await this.exec("gh", ["auth", "status"], this.home);
      } catch {
        blockers.push("Run gh auth login for target PR and CI access.");
      }
    if (!blockers.length && authority && runtime)
      capture?.(
        structuredClone(authority),
        structuredClone(runtime),
        structuredClone(target),
      );
    return {
      technicalDetails: !authority
        ? "authority.json is absent: accepted live-run authority, native OpenCode probe evidence, credential-boundary decision, execution qualification and reviewed target checks are required. Setup does not grant itself live authority. Current Attraccess setup prepares the owned ATT-764 environment and checks."
        : "Host authority is frozen for each admitted run.",
      ready: !blockers.length,
      blockers,
      harness: "opencode",
      model: runtime?.roles.implementer.model ?? null,
      roles: runtime
        ? [
            { role: "Implementer", steps: runtime.roles.implementer.steps },
            {
              role: "Independent reviewer",
              steps: runtime.roles.reviewer.steps,
            },
          ]
        : [],
      checks: authority?.checks.map((c) => c.name) ?? [],
      requiredCI: authority?.requiredCI ?? [],
    };
  }
  private currentIssueRun(config: OperatorConfig) {
    const repository = config.repository.toLowerCase(),
      issue = operatorIssue(config);
    return (
      this.store.coordinatorIssue(repository, issue) ??
      this.runs().find(
        (r) =>
          r.config?.repository.toLowerCase() === repository &&
          (r.issue ?? operatorIssue(r.config)) === issue,
      )?.id ??
      null
    );
  }
  private rerunBlocker(prior: OperatorRun): string | null {
    const snapshot = this.store.coordinatorSnapshot(prior.id);
    if (
      !["cancelled", "closed", "no_code"].includes(prior.phase) ||
      (snapshot && (!terminal(snapshot) || snapshot.execution)) ||
      this.store.commands(prior.id).some((c) => c.state !== "finished")
    )
      return "Previous workflow must be terminal and quiescent before rerun";
    if (
      this.store
        .effects(prior.id)
        .some(
          (e) => e.kind !== "coordinator-action" && e.state !== "confirmed",
        ) ||
      (this.mergeEffect(prior) &&
        !(prior.pr?.merged && prior.pr.head === prior.head))
    )
      return "Previous external effect requires reconciliation before rerun";
    return null;
  }
  async start(options: { previousRunId?: string } = {}) {
    if (
      this.starting ||
      this.active.size ||
      this.store.implementationSlot() ||
      this.runs().some((r) => r.phase === "recovery_required")
    )
      throw new Error(
        "An active or unreconciled run already owns the workflow",
      );
    this.starting = true;
    try {
      const config = this.config();
      const issue = operatorIssue(config);
      const priorId = this.currentIssueRun(config);
      if (priorId) {
        if (options.previousRunId !== priorId)
          throw new Error(
            "Issue already owns a run; explicit predecessor rerun required",
          );
        const blocker = this.rerunBlocker(this.run(priorId));
        if (blocker) throw new Error(blocker);
      } else if (options.previousRunId)
        throw new Error("Predecessor run not found for this issue");
      const frozen: {
        authority?: HostAuthority;
        runtime?: OpencodeConfig;
        target?: Json | null;
      } = {};
      const preflight = await this.preflight(
        config,
        (authority, runtime, target) =>
          Object.assign(frozen, { authority, runtime, target }),
      );
      const id = randomUUID();
      const run: OperatorRun = {
        id,
        revision: 0,
        issue,
        previousRunId: priorId,
        createdAt: Date.now(),
        config,
        workspace: join(this.home, "workspaces", id),
        branch: "rocky/" + id,
        phase: preflight.ready ? "preparing" : "blocked",
        message: preflight.blockers.join("\n"),
        head: "",
        base: "",
        pr: null,
        ci: null,
        mergeRequest: null,
        approval: null,
        closedAt: null,
        closeoutNote: "",
        diff: "",
        evidenceClass: this.deps.runtime?.evidenceClass ?? "live-subscription",
      };
      this.save(run);
      if (preflight.ready) {
        const authority = frozen.authority!;
        this.store.saveOperatorRecord("authority/" + id, authority);
        this.store.saveOperatorRecord("runtime/" + id, frozen.runtime!);
        if (authority.profile === ATT764_RECIPE)
          this.store.saveOperatorRecord("target/" + id, frozen.target!);
        this.launch(run, () => this.pipeline(run));
      }
      return this.detail(id);
    } finally {
      this.starting = false;
    }
  }
  private launch(run: OperatorRun, work: () => Promise<void>) {
    const pending = Promise.resolve()
      .then(work)
      .catch((e) => {
        const current = this.run(run.id);
        if (
          current.phase === "cancelled" ||
          this.store.coordinatorSnapshot(run.id)?.cancelled
        )
          return;
        current.phase = current.mergeRequest
          ? "merge_requested"
          : this.store.coordinatorSnapshot(run.id)?.execution ||
              this.store.commands(run.id).some((c) => c.state !== "finished")
            ? "recovery_required"
            : "blocked";
        current.message = (e as Error).message;
        this.save(current);
      })
      .finally(async () => {
        await this.adapters.get(run.id)?.close?.();
        this.active.delete(run.id);
        const l = this.leases.get(run.id);
        if (l)
          try {
            this.store.release(l);
          } catch {
            /* lost lease */
          }
        this.leases.delete(run.id);
        this.adapters.delete(run.id);
      });
    this.active.set(run.id, pending);
  }
  private lease(run: OperatorRun) {
    let l = this.leases.get(run.id);
    if (!l) {
      l = this.store.claim(
        run.id,
        "daemon-" + process.pid,
        this.versions,
        60000,
      );
      this.leases.set(run.id, l);
    } else this.store.renew(l, 60000);
    return l;
  }
  private cancelled(run: OperatorRun) {
    return (
      this.stopping ||
      this.run(run.id).phase === "cancelled" ||
      this.store.coordinatorSnapshot(run.id)?.cancelled === true
    );
  }
  private assertActive(run: OperatorRun) {
    if (this.cancelled(run))
      throw new Error("Run cancelled; owned work retained");
    this.store.assertLease(this.lease(run));
  }
  private apply(
    run: OperatorRun,
    event: Exclude<Event, { type: "observation" | "receipt" }>,
  ) {
    const source =
      event.type === "result"
        ? "transport"
        : event.type === "schedule"
          ? "scheduler"
          : "control";
    const key = randomUUID();
    this.store.ingestCoordinator(run.id, source, key, event);
    const s = this.store.applyCoordinator(
      this.lease(run),
      this.store.coordinatorSnapshot(run.id)!.revision,
      source,
      key,
    );
    this.emit("change");
    return s;
  }
  private receipt(
    run: OperatorRun,
    kind: ReceiptKind,
    outcome: "pass" | "fail" | "blocked",
    data: unknown,
    artifacts: Artifact[] = [],
    observation?: Observation,
  ) {
    const l = this.lease(run);
    observation ??= this.store.beginCoordinatorObservation(
      l,
      kind,
      randomUUID(),
    );
    const s = this.store.coordinatorSnapshot(run.id)!;
    const ref = this.evidence.record({
      schema: 1,
      kind,
      inputs: {
        head: s.head,
        base: s.scope.base,
        scope: identity(s.scope),
        scenario: "operator-mvp",
        fixture: run.config.repository,
        command: kind,
        toolchain: process.version,
        build: s.versions.build,
        checkPlan: s.checkPlan,
        coordinatorInput: s.inputDigest,
      },
      outcome,
      artifacts: [...artifacts, this.evidence.put(canonical(data))],
      ...{ signature: identity(data), diagnostics: "available", observation },
    });
    const id = randomUUID();
    this.store.registerCoordinatorReceipt(l, id, kind, this.evidence, ref);
    this.store.applyCoordinator(
      l,
      this.store.coordinatorSnapshot(run.id)!.revision,
      "evidence",
      id,
    );
    this.emit("change");
  }
  private schedule(run: OperatorRun, kind: Action["kind"]) {
    const s = this.apply(run, { type: "schedule", kind });
    if (!s.execution)
      throw new Error(s.blocker?.detail ?? "Action cannot be scheduled");
    return s.execution;
  }
  private async localChecks(
    run: OperatorRun,
    kind: "baseline" | "checks",
    authority: HostAuthority,
  ) {
    run.phase = kind === "baseline" ? "baseline" : "verifying";
    run.message = "Running frozen target checks";
    this.save(run);
    const action = this.schedule(
        run,
        kind === "baseline" ? "baseline" : "verify",
      ),
      l = this.lease(run),
      runner = new CommandRunner(this.store);
    const observation = this.store.beginCoordinatorObservation(
      l,
      kind,
      "local-checks/" + action.key,
    );
    const logs: Artifact[] = [];
    const results: unknown[] = [];
    let passed = true;
    for (const check of authority.checks) {
      this.assertActive(run);
      const remaining = Math.min(
        action.deadline - Date.now(),
        run.config.actionMinutes * 60000,
      );
      if (remaining < 1) throw new Error("Check deadline exceeded");
      const record = await runner.run(l, {
        file: check.file,
        args:
          authority.profile === ATT764_RECIPE
            ? [
                ...check.args,
                kind === "baseline" ? "baseline" : "product",
                join(this.home, "attraccess"),
                run.base,
              ]
            : check.args,
        cwd: run.workspace,
        timeoutMs: remaining,
        cleanupMs: 1000,
        logBytes: 1048576,
        outputDir: join(this.home, "logs", run.id),
      });
      if (record.state !== "finished")
        throw new Error(
          "Check process quiescence unresolved; recovery required",
        );
      const r = record.result as unknown as CommandResult | null;
      results.push({ name: check.name, result: r });
      for (const path of [r?.stdout, r?.stderr])
        if (path && existsSync(path))
          logs.push(this.evidence.put(readFileSync(path)));
      if (this.cancelled(run) || r?.outcome !== "success" || r.exitCode !== 0) {
        passed = false;
        break;
      }
    }
    // Finished commands prove quiescence even when cancellation became authoritative
    // during the await. Settle this exact action before refusing any further work.
    this.apply(run, {
      type: "result",
      actionKey: action.key,
      inputDigest: action.inputDigest,
      quiescent: true,
      usage: {
        schema: 1,
        status: "known",
        tokens: 0,
        source: { kind: "local-no-model", reference: identity(results) },
      },
      outcome: this.cancelled(run) ? "interrupted" : "complete",
      head: run.head,
      detail: kind + " command results retained",
    });
    this.assertActive(run);
    const dirty = await this.exec(
      "git",
      ["status", "--porcelain", "--untracked-files=no"],
      run.workspace,
    );
    this.assertActive(run);
    if (dirty)
      throw new Error("Checks modified committed source; evidence is stale");
    this.receipt(
      run,
      kind,
      passed ? "pass" : "fail",
      results,
      logs,
      observation,
    );
    if (!passed)
      throw new Error(
        kind === "baseline"
          ? "Baseline environment/check failure; implementation was not started"
          : "Product checks failed; automatic repair is deferred",
      );
  }
  private async agent(
    run: OperatorRun,
    kind: "implement" | "review",
    authority: HostAuthority,
  ) {
    run.phase = kind === "implement" ? "implementing" : "reviewing";
    run.message =
      kind === "implement"
        ? "OpenCode is implementing the scoped task"
        : "Independent read-only review";
    this.save(run);
    const action = this.schedule(run, kind),
      l = this.lease(run),
      config = this.store.operatorRecord<OpencodeConfig>("runtime/" + run.id)!;
    const observation =
      kind === "review"
        ? this.store.beginCoordinatorObservation(
            l,
            "review",
            "agent-review/" + action.key,
          )
        : undefined;
    const adapter: OperatorAdapter =
      this.deps.adapter?.(this.store, l, config) ??
      new OpencodeWorkerClient(this.store, l, config);
    this.adapters.set(run.id, adapter);
    const role = kind === "implement" ? "implementer" : "reviewer";
    const protocol = {
      schema: 1,
      actionKey: action.key,
      inputDigest: action.inputDigest,
      role,
      outcome: kind === "implement" ? "changed" : "complete",
      summary: "Describe the change or concrete blocking findings",
    };
    const prompt = `Task and acceptance criteria:\n${run.config.task}\n\n${kind === "review" ? `Review the diff and current evidence independently. Outcome failed for blockers; complete only with no blockers.\nDiff:\n${run.diff.slice(0, 180000)}\nChecks/CI:\n${canonical(this.store.coordinatorSnapshot(run.id)!.receipts)}` : "Implement only this task. Do not edit .github workflows, weaken tests, or access files outside the source tree."}\n\nFinal response must be exactly one JSON object with this shape and these bindings (set outcome and summary truthfully):\n${JSON.stringify(protocol)}`;
    const repositoryInstructions =
      this.store.operatorRecord<string>("instructions/" + run.id) ?? "";
    let plan: Awaited<ReturnType<OperatorAdapter["prepareLaunch"]>>;
    try {
      plan = await adapter.prepareLaunch(action, {
        prompt:
          prompt +
          (repositoryInstructions
            ? "\n\nFrozen repository instructions (host captured):\n" +
              repositoryInstructions
            : ""),
        stage: (src) =>
          authority.profile === ATT764_RECIPE
            ? stageATT764(run.workspace, src)
            : copySource(run.workspace, src),
      });
    } catch (error) {
      if (!adapter.notDispatched) throw error;
      const event = await adapter.notDispatched(
        action,
        (error as Error).message,
      );
      this.apply(run, event);
      if (this.cancelled(run)) return false;
      throw error;
    }
    const transport: CoordinatorTransport = {
      versions: this.versions,
      capability: null,
      qualification: config.qualification,
      interrupt: (a) => adapter.interrupt(a),
      begin: async (a) => {
        const result = await adapter.begin(a);
        // Preserve the native result (including its exact usage and quiescence) so
        // cancellation can drain the durable action without adopting staged code.
        if (this.cancelled(run)) return result;
        try {
          this.assertActive(run);
          if (["changed", "complete", "no_code"].includes(result.outcome)) {
            try {
              const admitted = assertAgentObservation(
                this.store,
                config,
                plan,
                result,
              );
              this.store.saveOperatorRecord(
                "agent-admission/" + action.key,
                admitted,
              );
            } catch (error) {
              const detail =
                "Native observation admission failed: " +
                (error as Error).message;
              this.store.saveOperatorRecord(
                "agent-admission-failure/" + action.key,
                {
                  detail,
                  actionKey: action.key,
                  nativeResult: JSON.parse(canonical(result)),
                },
              );
              return { ...result, outcome: "failed", head: run.head, detail };
            }
          }
          if (kind === "review") {
            if (result.head !== plan.headPre)
              return {
                ...result,
                outcome: "failed",
                head: run.head,
                detail: "Reviewer changed source",
              };
            return { ...result, head: run.head };
          }
          if (result.outcome === "changed" && result.quiescent) {
            if (authority.profile === ATT764_RECIPE) {
              applyATT764(plan.paths.src, run.workspace);
            } else {
              for (const name of readdirSync(run.workspace))
                if (name !== ".git")
                  rmSync(join(run.workspace, name), {
                    recursive: true,
                    force: true,
                  });
              copySource(plan.paths.src, run.workspace);
            }
            await this.exec("git", ["add", "--all"], run.workspace);
            if (this.cancelled(run)) return result;
            this.assertActive(run);
            const changed = await this.exec(
              "git",
              ["diff", "--cached", "--name-only"],
              run.workspace,
            );
            if (this.cancelled(run)) return result;
            this.assertActive(run);
            if (!changed.trim())
              return {
                ...result,
                outcome: "failed",
                head: run.head,
                detail: "No code change",
              };
            if (changed.split("\n").some((p) => p.startsWith(".github/")))
              throw new Error("Workflow changes require separate host review");
            await this.exec(
              "git",
              authority.profile === ATT764_RECIPE
                ? att764CommitArgs()
                : [
                    "-c",
                    "user.name=Rocky",
                    "-c",
                    "user.email=rocky@localhost",
                    "commit",
                    "-m",
                    run.config.task.split("\n")[0]!.slice(0, 180),
                  ],
              run.workspace,
            );
            if (this.cancelled(run)) return result;
            this.assertActive(run);
            const head = await this.exec(
              "git",
              ["rev-parse", "HEAD"],
              run.workspace,
            );
            if (this.cancelled(run)) return result;
            this.assertActive(run);
            const diff = await this.exec(
              "git",
              ["diff", run.base, head, "--"],
              run.workspace,
            );
            if (this.cancelled(run)) return result;
            this.assertActive(run);
            run.head = head;
            run.diff = diff;
            this.save(run);
            return { ...result, head: run.head };
          }
          return { ...result, head: run.head };
        } catch (error) {
          if (this.cancelled(run)) return result;
          throw error;
        }
      },
    };
    try {
      await this.store.dispatchCoordinator(l, action.key, transport);
    } catch (error) {
      if (
        this.cancelled(run) &&
        adapter.notDispatched &&
        !this.store.duplexInvocation(action.key)
      ) {
        const event = await adapter.notDispatched(
          action,
          (error as Error).message,
        );
        this.apply(run, event);
        return false;
      }
      throw error;
    }
    const s = this.store.applyCoordinator(
      l,
      this.store.coordinatorSnapshot(run.id)!.revision,
      "transport",
      `result/${action.key}`,
    );
    this.emit("change");
    if (s.cancelled) return false;
    if (s.blocker || s.unqualifiedResults.length)
      throw new Error(
        s.blocker?.detail ?? "Agent lifecycle or usage unresolved",
      );
    if (s.stage === "no_code") {
      run.phase = "no_code";
      run.message = "Resolved without a code change; no PR";
      this.save(run);
      return false;
    }
    if (kind === "review")
      this.receipt(
        run,
        "review",
        "pass",
        {
          action: action.key,
          commands: this.store.commands(run.id).map((c) => c.id),
        },
        [],
        observation,
      );
    return true;
  }
  private async effect<T>(
    run: OperatorRun,
    kind: string,
    payload: unknown,
    begin: () => Promise<T>,
  ): Promise<T> {
    this.assertActive(run);
    const l = this.lease(run),
      key = `operator/${run.id}/${kind}/${run.head}`;
    this.store.intent(l, {
      key,
      kind,
      payload: JSON.parse(canonical(payload)) as Json,
    });
    const old = this.store.effect(key)!;
    if (old.state === "confirmed") return old.receipt as T;
    if (old.state !== "pending")
      throw new Error(
        `${kind} needs reconciliation; refusing duplicate external effect`,
      );
    const result = await this.store.dispatch(l, key, {
      begin: async () => JSON.parse(canonical(await begin())) as Json,
    });
    if (result.state !== "confirmed")
      throw new Error(
        `${kind} outcome unresolved; inspect remote state before another attempt`,
      );
    return result.receipt as T;
  }
  private authorityFor(run: OperatorRun) {
    const value = this.store.operatorRecord<HostAuthority>(
      "authority/" + run.id,
    );
    if (!value) throw new Error("Frozen host authority unavailable");
    return value;
  }
  private async pipeline(run: OperatorRun) {
    const authority = this.authorityFor(run);
    await this.exec(
      "git",
      [
        "clone",
        "--no-hardlinks",
        "--single-branch",
        "--branch",
        run.config.baseBranch,
        "--",
        resolve(run.config.repositoryPath),
        run.workspace,
      ],
      this.home,
    );
    if (this.stopping || this.run(run.id).phase === "cancelled")
      throw new Error(
        "Daemon stopped during preparation; source copy retained",
      );
    await this.exec("git", ["checkout", "-b", run.branch], run.workspace);
    run.base = run.head = await this.exec(
      "git",
      ["rev-parse", "HEAD"],
      run.workspace,
    );
    if (authority.profile === ATT764_RECIPE) {
      const frozen = this.store.operatorRecord("target/" + run.id) as {
        base: string;
      };
      if (!frozen || frozen.base !== run.base)
        throw new Error(
          "Prepared source changed before clone; run setup again",
        );
      this.store.saveOperatorRecord(
        "instructions/" + run.id,
        freezeATT764Instructions(run.workspace),
      );
    }
    if (this.run(run.id).phase === "cancelled")
      throw new Error("Run cancelled during preparation");
    this.store.admitCoordinator({
      runId: run.id,
      repository: run.config.repository.toLowerCase(),
      issue: run.issue,
      rerun: run.previousRunId ? run.id : "first",
      previousRunId:
        run.previousRunId && this.store.coordinatorSnapshot(run.previousRunId)
          ? run.previousRunId
          : null,
      workspace: run.workspace,
      versions: this.versions,
      scope: {
        schema: 1,
        revision: 1,
        behavior: [run.config.task],
        exclusions: ["Deployments", "Automatic CI repair", "Linear automation"],
        surfaces: ["scoped target change"],
        fixtureIds: ["host-reviewed-target-recipe"],
        acceptanceManifest: identity(authority.checks),
        base: run.base,
        deliveryMode: "approval-gated",
      },
      head: run.head,
      checkPlan: identity(authority.checks),
      limits: {
        totalTokens: 10000000,
        totalElapsedMs: run.config.totalMinutes * 60000,
        actionTokens: 1,
        actionElapsedMs: run.config.actionMinutes * 60000,
      },
      capability: null,
      budget: {
        mode: "subscription-observed-v1",
        reportedTokenThreshold: run.config.reportedTokenThreshold,
      },
      qualification: authority.qualification,
    });
    this.save(run);
    await this.localChecks(run, "baseline", authority);
    if (!(await this.agent(run, "implement", authority))) return;
    await this.localChecks(run, "checks", authority);
    this.assertActive(run);
    run.phase = "publishing";
    run.message = "Publishing draft PR";
    this.save(run);
    const published = await this.effect(
      run,
      "draft",
      { head: run.head, branch: run.branch },
      () =>
        this.github.draft(
          run.config.repository,
          run.branch,
          run.config.baseBranch,
          run.head,
          run.workspace,
          authority.profile === ATT764_RECIPE ? ATT764_TITLE : run.config.task,
          () => this.assertActive(run),
        ),
    );
    this.recordDelivery(run, published);
    this.assertActive(run);
    run.pr = published;
    run.phase = "awaiting_ci";
    run.message =
      "Draft created. Watching current head and integration checks; refresh anytime.";
    this.save(run);
  }
  private recordDelivery(
    run: OperatorRun,
    pr: PullRequest | null,
    request?: MergeRequest,
  ) {
    const current = this.run(run.id);
    if (pr) current.pr = pr;
    if (request) current.mergeRequest = request;
    this.save(current);
    Object.assign(run, current);
  }
  private mergeEffect(run: OperatorRun) {
    return this.store.effect(`operator/${run.id}/merge/${run.head}`);
  }
  /** An already-sent request only admits read-only reconciliation, including after cancellation. */
  private async reconcileMerge(run: OperatorRun, pr?: PullRequest) {
    const effect = this.mergeEffect(run);
    if (!effect || effect.state === "pending")
      throw new Error("No sent merge request to reconcile");
    pr ??= await this.github.pull(
      run.config.repository,
      run.pr!.number,
      run.workspace,
    );
    const expected = (effect.payload as { head: string }).head;
    if (pr.head !== expected) {
      this.recordDelivery(run, pr);
      throw new Error(
        "Merge reconciliation found a changed PR head; approved request retained for inspection",
      );
    }
    if (effect.state !== "confirmed" && pr.merged && pr.mergeCommit) {
      await this.store.reconcile(this.lease(run), effect.key, async () => ({
        status: "confirmed",
        receipt: {
          number: pr!.number,
          head: expected,
          requestedAt: null,
          reconciledAt: Date.now(),
        },
      }));
    }
    const current = this.run(run.id);
    current.pr = pr;
    if (effect.state === "confirmed")
      current.mergeRequest ??= {
        number: pr.number,
        head: expected,
        requestedAt:
          (effect.receipt as unknown as MergeRequest).requestedAt ?? null,
      };
    if (current.phase !== "cancelled") {
      current.phase =
        pr.merged && pr.mergeCommit
          ? "merged"
          : effect.state === "confirmed"
            ? "merge_requested"
            : "recovery_required";
      current.message =
        pr.merged && pr.mergeCommit
          ? "GitHub confirmed the merge. Record manual closeout."
          : effect.state === "confirmed"
            ? "GitHub acknowledged the merge request. Waiting for confirmed merge; refresh only observes it."
            : "Merge outcome unresolved. Remote inspection is required; this request will not be repeated.";
    }
    this.save(current);
    Object.assign(run, current);
  }
  private ciIdentity(ci: CIObservation) {
    return identity({ ...ci, observedAt: 0 });
  }
  private async collectCI(run: OperatorRun, pr: PullRequest) {
    this.assertActive(run);
    const attempts = await this.github.attempts(
      run.config.repository,
      pr,
      run.workspace,
    );
    this.assertActive(run);
    const observation = this.store.beginCoordinatorObservation(
      this.lease(run),
      "ci",
      "github-ci/" + identity(attempts),
    );
    this.emit("change");
    const ci = await this.github.observe(
      run.config.repository,
      pr,
      this.authorityFor(run).requiredCI,
      run.workspace,
    );
    this.assertActive(run);
    if (identity(ci.attempts) !== identity(attempts)) {
      // This response discovers a newer attempt. Discard its results and begin that collector;
      // a subsequent read must supply its result, rather than rebinding this delayed response.
      this.store.beginCoordinatorObservation(
        this.lease(run),
        "ci",
        "github-ci/" + identity(ci.attempts),
      );
      run.approval = null;
      this.save(run);
      throw new Error(
        "CI attempt changed during collection; refresh before review or approval",
      );
    }
    const changed = !run.ci || this.ciIdentity(run.ci) !== this.ciIdentity(ci);
    if (changed) {
      run.approval = null;
      // A conflicting settled result under the same upstream ID is never replayed as old approval evidence.
      if (
        run.ci &&
        this.store.coordinatorSnapshot(run.id)!.receipts.ci?.observation
          .generation === observation.generation
      ) {
        this.store.beginCoordinatorObservation(
          this.lease(run),
          "ci",
          "github-ci-conflict/" + this.ciIdentity(ci),
        );
        run.ci = ci;
        this.save(run);
        throw new Error(
          "Conflicting completed CI evidence requires a new upstream attempt; approval refused",
        );
      }
    }
    run.ci = ci;
    run.pr = pr;
    this.save(run);
    if (changed && ci.outcome !== "pending")
      this.receipt(
        run,
        "ci",
        ci.outcome,
        { ...ci, observedAt: 0 },
        [],
        observation,
      );
    return { ci, changed };
  }
  async refresh(id: string) {
    if (this.active.has(id) || this.approving.has(id))
      throw new Error("Run is busy");
    const run = this.run(id);
    if (!run.pr) throw new Error("No pull request yet");
    if (["merged", "closed"].includes(run.phase)) return this.detail(id);
    this.launch(run, async () => {
      // Merge confirmation changes base/integration SHA. Reconcile before considering stale pre-merge CI inputs.
      if (
        this.mergeEffect(run)?.state &&
        this.mergeEffect(run)!.state !== "pending"
      ) {
        await this.reconcileMerge(run);
        return;
      }
      this.assertActive(run);
      const authority = this.authorityFor(run);
      const pr = await this.github.pull(
        run.config.repository,
        run.pr!.number,
        run.workspace,
      );
      this.assertActive(run);
      if (pr.head !== run.head || pr.base !== run.base) {
        run.approval = null;
        run.pr = pr;
        this.save(run);
        throw new Error(
          "PR head or base changed; previous evidence and approval are stale. Start an explicit new run.",
        );
      }
      const { ci, changed } = await this.collectCI(run, pr);
      if (!changed && this.store.coordinatorSnapshot(id)?.receipts.review)
        return;
      if (ci.outcome === "pending") {
        run.phase = "awaiting_ci";
        run.message = "CI pending or required checks have not appeared";
        this.save(run);
        return;
      }
      if (ci.outcome === "fail")
        throw new Error(
          "CI failed. Automatic CI repair is deferred; inspect the failed checks.",
        );
      if (!(await this.agent(run, "review", authority))) return;
      this.assertActive(run);
      run.phase = "awaiting_approval";
      run.message =
        "Checks and independent review passed. Review the diff and approve this exact commit.";
      this.save(run);
    });
    return this.detail(id);
  }
  async approve(id: string, head: string) {
    if (this.active.has(id) || this.approving.has(id))
      throw new Error("Run is busy");
    const work = this.approveCurrent(id, head);
    this.approvalWork.set(id, work);
    try {
      return await work;
    } finally {
      this.approvalWork.delete(id);
    }
  }
  private async approveCurrent(id: string, head: string) {
    if (this.active.has(id) || this.approving.has(id))
      throw new Error("Run is busy");
    const run = this.run(id);
    if (
      run.phase !== "awaiting_approval" ||
      !run.pr ||
      run.head !== head ||
      this.store.coordinatorSnapshot(id)?.stage !== "handoff_ready"
    )
      throw new Error("Current revision is not ready for approval");
    this.approving.add(id);
    try {
      this.assertActive(run);
      const pr = await this.github.pull(
        run.config.repository,
        run.pr.number,
        run.workspace,
      );
      this.assertActive(run);
      if (
        pr.head !== head ||
        pr.base !== run.base ||
        pr.integration !== run.ci?.integration
      ) {
        run.approval = null;
        run.pr = pr;
        run.phase = "blocked";
        run.message =
          "Approval rejected: PR inputs changed. Refresh or start an explicit new run.";
        this.save(run);
        throw new Error(run.message);
      }
      const { ci, changed } = await this.collectCI(run, pr);
      if (
        changed ||
        ci.outcome !== "pass" ||
        this.store.coordinatorSnapshot(id)?.stage !== "handoff_ready"
      ) {
        run.approval = null;
        run.phase = ci.outcome === "pending" ? "awaiting_ci" : "blocked";
        run.message =
          "Approval rejected: CI attempt/evidence changed; refresh for independent review.";
        this.save(run);
        throw new Error(run.message);
      }
      run.approval = {
        head,
        base: pr.base,
        integration: pr.integration,
        at: Date.now(),
        approver: "local operator",
      };
      this.receipt(run, "approval", "pass", run.approval);
      run.message = "Exact commit approved. Merge remains a separate action.";
      this.save(run);
      return this.detail(id);
    } finally {
      this.approving.delete(id);
      const lease = this.leases.get(id);
      if (lease && !this.active.has(id)) {
        this.store.release(lease);
        this.leases.delete(id);
      }
    }
  }
  async merge(id: string, head: string) {
    if (this.active.has(id) || this.approving.has(id))
      throw new Error("Run is busy");
    const run = this.run(id);
    if (
      this.mergeEffect(run)?.state &&
      this.mergeEffect(run)!.state !== "pending"
    )
      throw new Error(
        "Merge already requested or unresolved; use read-only reconciliation",
      );
    if (
      run.phase !== "awaiting_approval" ||
      !run.approval ||
      run.approval.head !== head ||
      head !== run.head ||
      !run.pr ||
      !this.store.coordinatorSnapshot(id)?.receipts.approval
    )
      throw new Error("A current exact-head approval is required");
    this.launch(run, async () => {
      this.assertActive(run);
      const pr = await this.github.pull(
        run.config.repository,
        run.pr!.number,
        run.workspace,
      );
      this.assertActive(run);
      if (
        pr.head !== head ||
        pr.base !== run.approval!.base ||
        pr.integration !== run.approval!.integration
      ) {
        run.approval = null;
        this.save(run);
        throw new Error("Stale approval: PR inputs changed");
      }
      const { ci, changed } = await this.collectCI(run, pr);
      if (
        changed ||
        ci.outcome !== "pass" ||
        !this.store.coordinatorSnapshot(id)?.receipts.approval
      )
        throw new Error(
          "CI attempt/evidence changed; stale approval refused before merge",
        );
      run.phase = "merging";
      run.message = "Requesting merge for approved commit";
      this.save(run);
      if (pr.draft) {
        const ready = await this.effect(run, "ready", { head }, () =>
          this.github.ready(run.config.repository, pr, run.workspace),
        );
        this.recordDelivery(run, ready);
        this.assertActive(run);
        if (
          ready.head !== head ||
          ready.base !== run.approval!.base ||
          ready.integration !== run.approval!.integration
        )
          throw new Error(
            "PR inputs changed while marking ready; merge refused",
          );
        const afterReady = await this.collectCI(run, ready);
        if (
          afterReady.changed ||
          afterReady.ci.outcome !== "pass" ||
          !this.store.coordinatorSnapshot(id)?.receipts.approval
        )
          throw new Error(
            "CI attempt changed while marking ready; stale approval refused before merge",
          );
      }
      const request = await this.effect(
        run,
        "merge",
        { head, approval: run.approval },
        () => this.github.merge(run.config.repository, pr, head, run.workspace),
      );
      this.recordDelivery(run, null, {
        number: pr.number,
        head,
        requestedAt: request.requestedAt ?? Date.now(),
      });
      if (run.phase !== "cancelled") {
        run.phase = "merge_requested";
        run.message =
          "GitHub acknowledged the merge request; awaiting confirmed merge.";
        this.save(run);
      }
      await this.reconcileMerge(run);
    });
    return this.detail(id);
  }
  closeout(id: string, note: string) {
    const run = this.run(id);
    if (run.phase !== "merged" || !run.pr?.merged || !note.trim())
      throw new Error("Confirmed merge and a closeout note are required");
    run.closedAt = Date.now();
    run.closeoutNote = note.slice(0, 4000);
    run.phase = "closed";
    run.message = "Manual closeout recorded";
    this.save(run);
    return this.detail(id);
  }
  async cancel(id: string) {
    const run = this.run(id);
    if (["merged", "closed", "no_code"].includes(run.phase))
      throw new Error("Completed workflow cannot be cancelled");
    if (this.store.coordinatorSnapshot(id)) {
      this.apply(run, { type: "cancel" });
      this.store.cancel(id);
    }
    const adapter = this.adapters.get(id);
    const lease = this.leases.get(id);
    run.phase = "cancelled";
    run.message = this.mergeEffect(run)
      ? "Run cancelled. Already-sent GitHub requests can still complete; refresh observes their outcome."
      : "Cancellation requested; owned processes are being drained";
    this.save(run);
    if (adapter && lease) this.store.interruptCoordinator(lease, adapter);
  }
  async idle() {
    await Promise.all([
      ...this.active.values(),
      ...[...this.approvalWork.values()].map((work) =>
        work.catch(() => undefined),
      ),
    ]);
  }
  async close() {
    this.stopping = true;
    clearInterval(this.heartbeat);
    clearInterval(this.ciTimer);
    for (const id of new Set([
      ...this.active.keys(),
      ...this.approvalWork.keys(),
    ]))
      try {
        await this.cancel(id);
      } catch {
        /* preparation */
      }
    await this.idle();
    this.releaseHome();
    this.store.close();
  }
}
function operatorIssue(config: OperatorConfig) {
  return config.repository.toLowerCase() === "attraccess/attraccess"
    ? "ATT-764"
    : "manual/" + identity({ task: config.task });
}
function copySource(from: string, to: string) {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from))
    if (![".git", "node_modules"].includes(name))
      cpSync(join(from, name), join(to, name), {
        recursive: true,
        dereference: false,
      });
}

function logTail(path: string) {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const bytes = fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(bytes, 16000));
    readSync(fd, buffer, 0, buffer.length, Math.max(0, bytes - buffer.length));
    return buffer.toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
