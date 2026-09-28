import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { canonical, identity, type Json } from "./json.js";
import { configure } from "../config/index.js";
import { Evidence, type Artifact } from "../evidence/index.js";
import { initialSnapshot, reduce } from "../coordinator/reducer.js";
import { canonical as json } from "./json.js";
import {
  validateCoordinatorAdmission,
  validateEvent,
  validateAction,
  validateSnapshot,
  validateCapability,
  text,
  integer,
  terminal,
  type Admission,
  type RunSnapshot,
  type Event,
  type InboxSource,
  type ReceiptKind,
  type ReceiptState,
  type Action,
} from "../coordinator/contracts.js";
import type { CoordinatorTransport } from "../coordinator/transport.js";
export type Versions = {
  workflow: string;
  adapter: string;
  prompt: string;
  runner: string;
  build: string;
};
export type Lease = {
  runId: string;
  owner: string;
  fence: number;
  versions: Versions;
};
export type Run = {
  id: string;
  head: string;
  base: string;
  scope: string;
  versions: Versions;
  stage: string;
  cancelled: boolean;
  config: ReturnType<typeof configure>;
};
export type Effect = {
  key: string;
  runId: string;
  kind: string;
  payload: Json;
  payloadHash: string;
  state: "pending" | "sending" | "unresolved" | "confirmed";
  receipt: Json | null;
};
export type CommandRecord = {
  id: string;
  runId: string;
  token: string;
  lease: Lease;
  spec: Json;
  createdAt: number;
  state: "starting" | "running" | "finished" | "recovery-required";
  supervisor: ProcessIdentity | null;
  group: ProcessIdentity | null;
  result: Json | null;
};
export type ProcessIdentity = { pid: number; fingerprint: string };
export class Store {
  readonly path: string;
  #db: DatabaseSync;
  constructor(
    path: string,
    readonly clock: () => number = Date.now,
    busyTimeoutMs = 5000,
  ) {
    if (
      !Number.isSafeInteger(busyTimeoutMs) ||
      busyTimeoutMs < 1 ||
      busyTimeoutMs > 5000
    )
      throw new Error("invalid-store-busy-timeout");
    this.path = resolve(path);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    this.#db = new DatabaseSync(this.path, { timeout: busyTimeoutMs });
    try {
      const schema = Number(
        this.#db.prepare("PRAGMA user_version").get()?.user_version,
      );
      if (schema !== 0 && schema !== 1 && schema !== 2) {
        throw new Error("incompatible-store-schema");
      }
      this.#db
        .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, data TEXT NOT NULL, owner TEXT, fence INTEGER NOT NULL DEFAULT 0, expires INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id), kind TEXT NOT NULL, data TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS effects(key TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), data TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'append-only'); END;
      CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'append-only'); END;
      CREATE TABLE IF NOT EXISTS coordinator_snapshots(run_id TEXT PRIMARY KEY REFERENCES runs(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS coordinator_issues(repository TEXT NOT NULL, issue TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES runs(id), PRIMARY KEY(repository,issue));
      CREATE TABLE IF NOT EXISTS coordinator_reruns(repository TEXT NOT NULL, issue TEXT NOT NULL, rerun TEXT NOT NULL, run_id TEXT NOT NULL UNIQUE REFERENCES runs(id), PRIMARY KEY(repository,issue,rerun));
      CREATE TABLE IF NOT EXISTS coordinator_inbox(source TEXT NOT NULL, event_id TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES runs(id), payload TEXT NOT NULL, payload_hash TEXT NOT NULL, consumed_revision INTEGER, PRIMARY KEY(source,event_id));
      CREATE TABLE IF NOT EXISTS coordinator_receipts(run_id TEXT NOT NULL REFERENCES runs(id), kind TEXT NOT NULL, hash TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(run_id,kind,hash));
      CREATE TABLE IF NOT EXISTS coordinator_slot(singleton INTEGER PRIMARY KEY CHECK(singleton=1), run_id TEXT NOT NULL REFERENCES runs(id), action_key TEXT NOT NULL UNIQUE REFERENCES effects(key), fence INTEGER NOT NULL, owner TEXT NOT NULL);
      PRAGMA user_version=2; COMMIT;`);
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }
  close() {
    this.#db.close();
  }
  #transaction<T>(body: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = body();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }
  #event(id: string, kind: string, data: unknown) {
    this.#db
      .prepare("INSERT INTO events(run_id,kind,data,at) VALUES(?,?,?,?)")
      .run(id, kind, canonical(data), this.clock());
  }
  #row(id: string) {
    const row = this.#db.prepare("SELECT * FROM runs WHERE id=?").get(id);
    if (!row) throw new Error("run-not-found");
    return row;
  }
  get(id: string): Run {
    return JSON.parse(String(this.#row(id).data)) as Run;
  }
  events(id: string) {
    return this.#db
      .prepare("SELECT * FROM events WHERE run_id=? ORDER BY seq")
      .all(id)
      .map((r) => ({
        ...r,
        kind: String(r.kind),
        data: JSON.parse(String(r.data)) as Json,
      }));
  }
  admit(input: {
    id: string;
    head: string;
    base: string;
    scope: string;
    versions: Versions;
    config?: unknown;
  }) {
    for (const value of [
      input.id,
      input.head,
      input.base,
      input.scope,
      ...Object.values(input.versions),
    ])
      if (typeof value !== "string" || !value)
        throw new Error("missing-identity");
    if (
      Object.keys(input.versions).sort().join() !==
      "adapter,build,prompt,runner,workflow"
    )
      throw new Error("invalid-versions");
    const run: Run = {
      id: input.id,
      head: input.head,
      base: input.base,
      scope: input.scope,
      versions: JSON.parse(canonical(input.versions)),
      stage: "admitted",
      cancelled: false,
      config: configure(input.config),
    };
    this.#transaction(() => {
      this.#db
        .prepare("INSERT INTO runs(id,data) VALUES(?,?)")
        .run(run.id, canonical(run));
      this.#event(run.id, "admitted", run);
    });
    return this.get(run.id);
  }
  claim(
    runId: string,
    owner: string,
    versions: Versions,
    ttlMs: number,
  ): Lease {
    this.#ttl(ttlMs);
    if (!owner) throw new Error("owner-required");
    return this.#transaction(() => {
      const row = this.#row(runId);
      const run = this.get(runId);
      if (canonical(run.versions) !== canonical(versions))
        throw new Error("incompatible-versions");
      if (Number(row.expires) > this.clock()) throw new Error("lease-busy");
      const fence = Number(row.fence) + 1;
      this.#db
        .prepare("UPDATE runs SET owner=?,fence=?,expires=? WHERE id=?")
        .run(owner, fence, this.clock() + ttlMs, runId);
      this.#event(runId, "claimed", { owner, fence });
      return { runId, owner, fence, versions: JSON.parse(canonical(versions)) };
    });
  }
  #ttl(ttl: number) {
    if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 2147483647)
      throw new Error("invalid-lease-duration");
  }
  #guard(lease: Lease, allowCancelled = false) {
    const row = this.#row(lease.runId);
    const run = this.get(lease.runId);
    if (
      row.owner !== lease.owner ||
      Number(row.fence) !== lease.fence ||
      Number(row.expires) <= this.clock()
    )
      throw new Error("stale-lease");
    if (canonical(run.versions) !== canonical(lease.versions))
      throw new Error("incompatible-versions");
    if (run.cancelled && !allowCancelled) throw new Error("cancelled");
    return run;
  }
  assertLease(lease: Lease, allowCancelled = false) {
    this.#guard(lease, allowCancelled);
  }
  /** Synchronous initiation only. No asynchronous work may be deferred before initiating the operation. */
  guardedStart<T>(lease: Lease, start: () => T): T {
    return this.#transaction(() => {
      this.#guard(lease);
      return start();
    });
  }
  renew(lease: Lease, ttlMs: number) {
    this.#ttl(ttlMs);
    this.#transaction(() => {
      this.#guard(lease, true);
      this.#db
        .prepare("UPDATE runs SET expires=? WHERE id=?")
        .run(this.clock() + ttlMs, lease.runId);
    });
  }
  release(lease: Lease) {
    this.#transaction(() => {
      this.#guard(lease, true);
      this.#db.prepare("UPDATE runs SET expires=0 WHERE id=?").run(lease.runId);
      this.#event(lease.runId, "released", { fence: lease.fence });
    });
  }
  cancel(runId: string) {
    this.#transaction(() => {
      const run = this.get(runId);
      if (run.cancelled) return;
      run.cancelled = true;
      this.#save(run);
      this.#event(runId, "cancelled", {});
    });
  }
  #save(run: Run) {
    this.#db
      .prepare("UPDATE runs SET data=? WHERE id=?")
      .run(canonical(run), run.id);
  }
  transition(
    lease: Lease,
    stage: string,
    intent?: { key: string; kind: string; payload: Json },
  ) {
    if (!stage) throw new Error("stage-required");
    this.#transaction(() => {
      const run = this.#guard(lease);
      this.#legacyOnly(run.id);
      run.stage = stage;
      this.#save(run);
      this.#event(run.id, "transition", { stage });
      if (intent) this.#intent(run.id, intent);
    });
  }
  revise(lease: Lease, inputs: { head: string; base: string; scope: string }) {
    this.#transaction(() => {
      const run = this.#guard(lease);
      this.#legacyOnly(run.id);
      for (const value of Object.values(inputs))
        if (!value) throw new Error("missing-identity");
      Object.assign(run, inputs);
      this.#save(run);
      this.#event(run.id, "inputs-revised", inputs);
    });
  }
  #intent(runId: string, input: { key: string; kind: string; payload: Json }) {
    const payloadHash = identity(input.payload);
    const old = this.effect(input.key);
    if (old) {
      if (
        old.runId !== runId ||
        old.kind !== input.kind ||
        old.payloadHash !== payloadHash
      )
        throw new Error("operation-key-conflict");
      return;
    }
    if (!input.key || !input.kind)
      throw new Error("operation-identity-required");
    const effect: Effect = {
      ...input,
      runId,
      payloadHash,
      state: "pending",
      receipt: null,
    };
    this.#db
      .prepare("INSERT INTO effects(key,run_id,data) VALUES(?,?,?)")
      .run(input.key, runId, canonical(effect));
    this.#event(runId, "effect-intent", { key: input.key, payloadHash });
  }
  effect(key: string): Effect | undefined {
    const r = this.#db.prepare("SELECT data FROM effects WHERE key=?").get(key);
    return r ? (JSON.parse(String(r.data)) as Effect) : undefined;
  }
  #ownedEffect(lease: Lease, key: string) {
    const e = this.effect(key);
    if (!e || e.runId !== lease.runId) throw new Error("effect-not-found");
    return e;
  }
  #saveEffect(e: Effect) {
    this.#db
      .prepare("UPDATE effects SET data=? WHERE key=?")
      .run(canonical(e), e.key);
  }
  async dispatch(
    lease: Lease,
    key: string,
    transport: { begin: (effect: Readonly<Effect>) => Promise<Json> },
  ): Promise<Effect> {
    this.#transaction(() => {
      this.#guard(lease);
      const e = this.#ownedEffect(lease, key);
      if (e.kind === "coordinator-action")
        throw new Error("coordinator-dispatch-required");
      if (e.state !== "pending") throw new Error("reconciliation-required");
      e.state = "sending";
      this.#saveEffect(e);
      this.#event(e.runId, "effect-sending", { key });
    });
    // Intent and sending state are durable before this actual dispatch seam. Cancellation/claim serializes here.
    const pending = this.guardedStart(lease, () =>
      transport.begin(this.#ownedEffect(lease, key)),
    );
    try {
      const receipt = await pending;
      this.#confirm(lease, key, receipt);
    } catch {
      this.#transaction(() => {
        this.#guard(lease, true);
        const e = this.#ownedEffect(lease, key);
        if (e.state !== "confirmed") {
          e.state = "unresolved";
          this.#saveEffect(e);
          this.#event(e.runId, "effect-unresolved", { key });
        }
      });
    }
    return this.#ownedEffect(lease, key);
  }
  #confirm(lease: Lease, key: string, receipt: Json) {
    canonical(receipt);
    this.#transaction(() => {
      this.#guard(lease, true);
      const e = this.#ownedEffect(lease, key);
      if (e.state === "pending") throw new Error("effect-not-sent");
      if (e.state === "confirmed") {
        if (canonical(e.receipt) !== canonical(receipt))
          throw new Error("receipt-conflict");
        return;
      }
      e.state = "confirmed";
      e.receipt = receipt;
      this.#saveEffect(e);
      this.#event(e.runId, "effect-confirmed", { key, receipt });
    });
  }
  async reconcile(
    lease: Lease,
    key: string,
    observe: (
      effect: Readonly<Effect>,
    ) => Promise<
      { status: "confirmed"; receipt: Json } | { status: "unknown" }
    >,
  ) {
    this.#guard(lease, true);
    const e = this.#ownedEffect(lease, key);
    if (e.state === "confirmed") return e;
    if (e.state === "pending") throw new Error("effect-not-sent");
    let observation: Awaited<ReturnType<typeof observe>>;
    try {
      observation = await observe(e);
    } catch {
      observation = { status: "unknown" };
    }
    if (observation.status === "confirmed")
      this.#confirm(lease, key, observation.receipt);
    else
      this.#transaction(() => {
        this.#guard(lease, true);
        const latest = this.#ownedEffect(lease, key);
        if (latest.state === "confirmed") return;
        latest.state = "unresolved";
        this.#saveEffect(latest);
        this.#event(latest.runId, "effect-unresolved", { key });
      });
    return this.#ownedEffect(lease, key);
  }
  command(id: string): CommandRecord | undefined {
    const row = this.#db
      .prepare("SELECT data FROM commands WHERE id=?")
      .get(id);
    return row ? (JSON.parse(String(row.data)) as CommandRecord) : undefined;
  }
  commands(runId: string): CommandRecord[] {
    return this.#db
      .prepare("SELECT data FROM commands WHERE run_id=?")
      .all(runId)
      .map((r) => JSON.parse(String(r.data)) as CommandRecord);
  }
  reserveCommand(lease: Lease, id: string, token: string, spec: Json) {
    this.#transaction(() => {
      this.#guard(lease);
      if (this.commands(lease.runId).some((c) => c.state !== "finished"))
        throw new Error("command-recovery-required");
      const record: CommandRecord = {
        id,
        runId: lease.runId,
        token,
        lease,
        spec,
        createdAt: this.clock(),
        state: "starting",
        supervisor: null,
        group: null,
        result: null,
      };
      this.#db
        .prepare("INSERT INTO commands(id,run_id,data) VALUES(?,?,?)")
        .run(id, lease.runId, canonical(record));
      this.#event(lease.runId, "command-reserved", { id, spec });
    });
  }
  /** Capability used only by the owned supervisor for process observations/cleanup, never run progression. */
  observeCommand(
    id: string,
    token: string,
    update: Partial<
      Pick<CommandRecord, "supervisor" | "group" | "state" | "result">
    >,
  ) {
    this.#transaction(() => {
      const c = this.command(id);
      if (!c || c.token !== token)
        throw new Error("command-capability-invalid");
      if (c.state === "finished") throw new Error("command-already-finished");
      Object.assign(c, update);
      this.#db
        .prepare("UPDATE commands SET data=? WHERE id=?")
        .run(canonical(c), id);
      this.#event(c.runId, "command-observed", { id, ...update });
    });
  }
  #legacyOnly(runId: string) {
    if (this.coordinatorSnapshot(runId))
      throw new Error("coordinator-transaction-required");
  }
  coordinatorSnapshot(runId: string): RunSnapshot | undefined {
    const row = this.#db
      .prepare("SELECT data FROM coordinator_snapshots WHERE run_id=?")
      .get(runId);
    if (!row) return undefined;
    const s = JSON.parse(String(row.data)) as RunSnapshot;
    validateSnapshot(s);
    return s;
  }
  #snapshot(runId: string) {
    const s = this.coordinatorSnapshot(runId);
    if (!s) throw new Error("coordinator-run-not-found");
    return s;
  }
  #saveSnapshot(s: RunSnapshot) {
    validateSnapshot(s);
    this.#db
      .prepare("UPDATE coordinator_snapshots SET data=? WHERE run_id=?")
      .run(json(s), s.runId);
    const run = this.get(s.runId);
    Object.assign(run, {
      stage: s.stage,
      cancelled: s.cancelled,
      head: s.head,
      base: s.scope.base,
      scope: identity(s.scope),
    });
    this.#save(run);
  }
  /** Admission and issue/rerun ownership share the same database transaction. */
  admitCoordinator(admission: Admission): RunSnapshot {
    validateCoordinatorAdmission(admission);
    return this.#transaction(() => {
      const previous = this.#db
        .prepare(
          "SELECT run_id FROM coordinator_issues WHERE repository=? AND issue=?",
        )
        .get(admission.repository, admission.issue);
      if (previous) {
        if (admission.previousRunId !== previous.run_id)
          throw new Error("issue-already-owned-explicit-rerun-required");
        const old = this.#snapshot(String(previous.run_id));
        if (
          !terminal(old) ||
          old.execution ||
          this.implementationSlot()?.runId === old.runId ||
          this.commands(old.runId).some((c) => c.state !== "finished")
        )
          throw new Error("previous-run-not-quiescent-terminal");
      } else if (admission.previousRunId !== null)
        throw new Error("previous-run-not-found");
      const s = initialSnapshot(admission, this.clock());
      const run: Run = {
        id: s.runId,
        head: s.head,
        base: s.scope.base,
        scope: identity(s.scope),
        versions: s.versions,
        stage: s.stage,
        cancelled: false,
        config: configure({ delivery: s.scope.deliveryMode }),
      };
      this.#db
        .prepare("INSERT INTO runs(id,data) VALUES(?,?)")
        .run(run.id, json(run));
      this.#db
        .prepare("INSERT INTO coordinator_snapshots(run_id,data) VALUES(?,?)")
        .run(run.id, json(s));
      this.#db
        .prepare(
          "INSERT INTO coordinator_reruns(repository,issue,rerun,run_id) VALUES(?,?,?,?)",
        )
        .run(s.repository, s.issue, s.rerun, s.runId);
      this.#db
        .prepare(
          "INSERT INTO coordinator_issues(repository,issue,run_id) VALUES(?,?,?) ON CONFLICT(repository,issue) DO UPDATE SET run_id=excluded.run_id",
        )
        .run(s.repository, s.issue, s.runId);
      this.#event(run.id, "coordinator-admitted", s);
      return s;
    });
  }
  #ingest(runId: string, source: InboxSource, eventId: string, event: Event) {
    text(eventId);
    validateEvent(event, source);
    this.#snapshot(runId);
    const hash = identity({ runId, event });
    const prior = this.#db
      .prepare(
        "SELECT payload_hash,consumed_revision FROM coordinator_inbox WHERE source=? AND event_id=?",
      )
      .get(source, eventId);
    if (prior) {
      if (prior.payload_hash !== hash)
        throw new Error("inbox-payload-conflict");
      return {
        duplicate: true,
        consumedRevision:
          prior.consumed_revision === null
            ? null
            : Number(prior.consumed_revision),
      };
    }
    this.#db
      .prepare(
        "INSERT INTO coordinator_inbox(source,event_id,run_id,payload,payload_hash) VALUES(?,?,?,?,?)",
      )
      .run(source, eventId, runId, json(event), hash);
    this.#event(runId, "coordinator-inbox", { source, eventId, hash });
    return { duplicate: false, consumedRevision: null };
  }
  /** These are trusted host entrypoints, never exposed as agent tools. Receipt authority has its own path. */
  ingestCoordinator(
    runId: string,
    source: Exclude<InboxSource, "evidence">,
    eventId: string,
    event: Exclude<Event, { type: "receipt" }>,
  ) {
    if ((source as string) === "evidence")
      throw new Error("receipt-registration-required");
    return this.#transaction(() => this.#ingest(runId, source, eventId, event));
  }
  /** Trusted checker/CI/reviewer integration only. Content-addressing proves integrity, not producer identity. */
  registerCoordinatorReceipt(
    lease: Lease,
    eventId: string,
    kind: ReceiptKind,
    evidence: Evidence,
    reference: Artifact,
  ) {
    return this.#transaction(() => {
      this.#guard(lease);
      const s = this.#snapshot(lease.runId);
      const receipt = JSON.parse(evidence.read(reference).toString());
      const i = receipt.inputs;
      if (
        !i ||
        i.head !== s.head ||
        i.base !== s.scope.base ||
        i.scope !== identity(s.scope) ||
        i.build !== s.versions.build ||
        i.checkPlan !== s.checkPlan ||
        i.coordinatorInput !== s.inputDigest
      )
        throw new Error("stale-evidence");
      const checked = evidence.validate(reference, i);
      if (
        !checked.receipt ||
        !["pass", "fail", "blocked"].includes(checked.reason) ||
        receipt.kind !== kind
      )
        throw new Error("invalid-authoritative-receipt");
      // Signature/diagnostic metadata belongs to the hashed receipt, never to an agent's event envelope.
      const state: ReceiptState = {
        reference,
        inputs: i,
        outcome: receipt.outcome,
        signature: receipt.signature,
        diagnostics: receipt.diagnostics,
      };
      const event: Event = { type: "receipt", kind, receipt: state };
      validateEvent(event, "evidence");
      this.#db
        .prepare(
          "INSERT OR IGNORE INTO coordinator_receipts(run_id,kind,hash,data) VALUES(?,?,?,?)",
        )
        .run(s.runId, kind, reference.sha256, json(state));
      return this.#ingest(s.runId, "evidence", eventId, event);
    });
  }
  implementationSlot(): {
    runId: string;
    actionKey: string;
    fence: number;
    owner: string;
  } | null {
    const r = this.#db
      .prepare("SELECT * FROM coordinator_slot WHERE singleton=1")
      .get();
    return r
      ? {
          runId: String(r.run_id),
          actionKey: String(r.action_key),
          fence: Number(r.fence),
          owner: String(r.owner),
        }
      : null;
  }
  /** All state, budget, inbox-consumption, slot and effect intent changes commit together. */
  applyCoordinator(
    lease: Lease,
    expectedRevision: number,
    source: InboxSource,
    eventId: string,
  ): RunSnapshot {
    integer(expectedRevision);
    return this.#transaction(() => {
      const run = this.#guard(lease, true);
      const old = this.#snapshot(run.id);
      const issueOwner = this.#db
        .prepare(
          "SELECT run_id FROM coordinator_issues WHERE repository=? AND issue=?",
        )
        .get(old.repository, old.issue);
      if (issueOwner?.run_id !== run.id)
        throw new Error("issue-ownership-superseded");
      if (json(old.versions) !== json(lease.versions))
        throw new Error("incompatible-versions");
      const row = this.#db
        .prepare(
          "SELECT * FROM coordinator_inbox WHERE source=? AND event_id=? AND run_id=?",
        )
        .get(source, eventId, run.id);
      if (!row) throw new Error("inbox-event-not-found");
      if (row.consumed_revision !== null) return old;
      if (old.revision !== expectedRevision)
        throw new Error("revision-conflict");
      const event = JSON.parse(String(row.payload)) as Event;
      validateEvent(event, source);
      if (event.type === "receipt") {
        const trusted = this.#db
          .prepare(
            "SELECT data FROM coordinator_receipts WHERE run_id=? AND kind=? AND hash=?",
          )
          .get(run.id, event.kind, event.receipt.reference.sha256);
        if (!trusted || trusted.data !== json(event.receipt))
          throw new Error("unregistered-receipt");
      }
      if (run.cancelled && !old.cancelled) {
        old.cancelled = true;
        old.stage = old.execution ? "cancelling" : "cancelled";
      }
      const { snapshot: next, actions } = reduce(old, event, this.clock());
      if (old.execution && !next.execution) {
        if (this.commands(run.id).some((c) => c.state !== "finished"))
          throw new Error("owned-commands-unquiesced");
        const slot = this.implementationSlot();
        if (
          !slot ||
          slot.runId !== run.id ||
          slot.actionKey !== old.execution.key
        )
          throw new Error("slot-ownership-conflict");
        // A new run owner can reconcile the old action, but cannot restart it under a new fence.
        this.#db
          .prepare("DELETE FROM coordinator_slot WHERE singleton=1")
          .run();
        const effect = this.#ownedEffect(lease, old.execution.key);
        effect.state = "confirmed";
        effect.receipt = JSON.parse(json(event));
        this.#saveEffect(effect);
        this.#event(run.id, "coordinator-action-quiescent", {
          key: old.execution.key,
          fence: lease.fence,
        });
      }
      for (const action of actions) {
        if (this.implementationSlot())
          throw new Error("implementation-capacity-busy");
        if (this.commands(run.id).some((c) => c.state !== "finished"))
          throw new Error("owned-commands-unquiesced");
        this.#intent(run.id, {
          key: action.key,
          kind: "coordinator-action",
          payload: JSON.parse(json(action)),
        });
        this.#db
          .prepare(
            "INSERT INTO coordinator_slot(singleton,run_id,action_key,fence,owner) VALUES(1,?,?,?,?)",
          )
          .run(run.id, action.key, lease.fence, lease.owner);
      }
      this.#saveSnapshot(next);
      this.#db
        .prepare(
          "UPDATE coordinator_inbox SET consumed_revision=? WHERE source=? AND event_id=?",
        )
        .run(next.revision, source, eventId);
      this.#event(run.id, "coordinator-transition", {
        source,
        eventId,
        revision: next.revision,
        inputDigest: next.inputDigest,
        actions: actions.map((a) => a.key),
        budgets: next.budgets,
        stage: next.stage,
      });
      return next;
    });
  }
  #dispatchable(lease: Lease, key: string, transport: CoordinatorTransport) {
    this.#guard(lease);
    const s = this.#snapshot(lease.runId),
      slot = this.implementationSlot();
    const a = s.execution;
    if (
      !a ||
      a.key !== key ||
      a.inputDigest !== s.inputDigest ||
      s.cancelled ||
      s.blocker ||
      s.wait
    )
      throw new Error("action-no-longer-dispatchable");
    if (
      !slot ||
      slot.runId !== lease.runId ||
      slot.actionKey !== key ||
      slot.fence !== lease.fence ||
      slot.owner !== lease.owner
    )
      throw new Error("stale-slot-fence");
    if (this.clock() >= a.deadline) throw new Error("action-deadline-exceeded");
    validateAction(a);
    validateCapability(transport.capability);
    if (a.capabilityId && transport.capability?.id !== a.capabilityId)
      throw new Error("hard-limits-capability-mismatch");
    if (json(transport.versions) !== json(s.versions))
      throw new Error("incompatible-transport-versions");
    return a;
  }
  /** No blind retry after sending. A lost response leaves the slot occupied for explicit reconciliation. */
  async dispatchCoordinator(
    lease: Lease,
    key: string,
    transport: CoordinatorTransport,
  ) {
    this.#transaction(() => {
      this.#dispatchable(lease, key, transport);
      const effect = this.#ownedEffect(lease, key);
      if (effect.state !== "pending")
        throw new Error("reconciliation-required");
      effect.state = "sending";
      this.#saveEffect(effect);
      this.#event(lease.runId, "coordinator-action-sending", { key });
    });
    // Initiation must be synchronous inside this gate; the promise represents subsequent observation.
    const pending = this.guardedStart(lease, () =>
      transport.begin(this.#dispatchable(lease, key, transport)),
    );
    const result = await pending;
    validateEvent(result, "transport");
    if (result.type !== "result" || result.actionKey !== key)
      throw new Error("transport-result-mismatch");
    // Ingestion survives lease expiry and cancellation; applying still requires the current lease/revision.
    return this.ingestCoordinator(
      lease.runId,
      "transport",
      `result/${key}`,
      result,
    );
  }
  /** Interrupt acknowledgements are not quiescence. Completion arrives through the result inbox. */
  interruptCoordinator(lease: Lease, transport: CoordinatorTransport) {
    return this.#transaction(() => {
      this.#guard(lease, true);
      const s = this.#snapshot(lease.runId);
      if (!s.execution) return;
      if (!s.cancelled && !this.get(s.runId).cancelled && !s.wait && !s.blocker)
        throw new Error("interruption-not-requested");
      if (json(transport.versions) !== json(s.versions))
        throw new Error("incompatible-transport-versions");
      this.#event(s.runId, "coordinator-interrupt-request", {
        key: s.execution.key,
      });
      return transport.interrupt(s.execution);
    });
  }
}
