import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { canonical, identity, type Json } from "./json.js";
import { configure } from "../config/index.js";
import { Evidence, type Artifact } from "../evidence/index.js";
import { initialSnapshot, reduce } from "../coordinator/reducer.js";
import {
  migrateLegacySnapshot,
  migrateUsageSnapshot,
} from "../coordinator/migration.js";
import { canonical as json } from "./json.js";
import {
  validateCoordinatorAdmission,
  validateEvent,
  validateAction,
  validateSnapshot,
  validateObservation,
  evidenceBundle,
  type Observation,
  validateCapability,
  validateQualification,
  isAgentWork,
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
import {
  validateDuplexLimits,
  type DuplexState,
  type DuplexBinding,
  type DuplexSend,
} from "../runner/duplex.js";
import {
  freezeProviderRequest,
  type ProviderRecord,
} from "../agents/provider-ledger.js";
import {
  freezeStockContract,
  freezeStockRequest,
  stockProgression,
  validateStockHeaders,
  type StockContract,
  type StockCompletion,
} from "../agents/stock-request.js";
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
  duplex?: DuplexState;
};
export type ProcessIdentity = { pid: number; fingerprint: string };
export class Store {
  readonly path: string;
  #db: DatabaseSync;
  #transactionDepth = 0;
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
      if (
        schema !== 0 &&
        schema !== 1 &&
        schema !== 2 &&
        schema !== 3 &&
        schema !== 4 &&
        schema !== 5 &&
        schema !== 6 &&
        schema !== 7 &&
        schema !== 8
      ) {
        throw new Error("incompatible-store-schema");
      }
      this.#db
        .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS operator_records(key TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, data TEXT NOT NULL, owner TEXT, fence INTEGER NOT NULL DEFAULT 0, expires INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id), kind TEXT NOT NULL, data TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS effects(key TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), data TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'append-only'); END;
      CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'append-only'); END;
      CREATE TABLE IF NOT EXISTS provider_stock_contracts(action_key TEXT PRIMARY KEY REFERENCES effects(key), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS provider_stock_progressions(action_key TEXT NOT NULL REFERENCES effects(key), progression TEXT NOT NULL, request_id TEXT NOT NULL, ordinal INTEGER NOT NULL, PRIMARY KEY(action_key,progression), UNIQUE(action_key,ordinal));
      CREATE TABLE IF NOT EXISTS provider_revocations(action_key TEXT PRIMARY KEY REFERENCES effects(key), run_id TEXT NOT NULL REFERENCES runs(id));
      CREATE TABLE IF NOT EXISTS provider_requests(action_key TEXT NOT NULL REFERENCES effects(key), request_id TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES runs(id), data TEXT NOT NULL, PRIMARY KEY(action_key,request_id));
      CREATE TABLE IF NOT EXISTS coordinator_snapshots(run_id TEXT PRIMARY KEY REFERENCES runs(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS coordinator_issues(repository TEXT NOT NULL, issue TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES runs(id), PRIMARY KEY(repository,issue));
      CREATE TABLE IF NOT EXISTS coordinator_reruns(repository TEXT NOT NULL, issue TEXT NOT NULL, rerun TEXT NOT NULL, run_id TEXT NOT NULL UNIQUE REFERENCES runs(id), PRIMARY KEY(repository,issue,rerun));
      CREATE TABLE IF NOT EXISTS coordinator_inbox(source TEXT NOT NULL, event_id TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES runs(id), payload TEXT NOT NULL, payload_hash TEXT NOT NULL, consumed_revision INTEGER, PRIMARY KEY(source,event_id));
      CREATE TABLE IF NOT EXISTS coordinator_receipts(run_id TEXT NOT NULL REFERENCES runs(id), kind TEXT NOT NULL, hash TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(run_id,kind,hash));
      CREATE TABLE IF NOT EXISTS coordinator_slot(singleton INTEGER PRIMARY KEY CHECK(singleton=1), run_id TEXT NOT NULL REFERENCES runs(id), action_key TEXT NOT NULL UNIQUE REFERENCES effects(key), fence INTEGER NOT NULL, owner TEXT NOT NULL);
      `);
      if (schema < 4) {
        for (const row of this.#db
          .prepare("SELECT run_id,data FROM coordinator_snapshots")
          .all()) {
          const previous = JSON.parse(String(row.data));
          const cancelled = this.get(String(row.run_id)).cancelled;
          const intermediate =
            schema < 3 ? migrateLegacySnapshot(previous, cancelled) : previous;
          const next = migrateUsageSnapshot(intermediate, cancelled);
          // Legacy receipts lack attempt/bundle authority. Keep the original in append-only migration evidence.
          this.#event(String(row.run_id), "coordinator-schema-migrated", {
            from: schema < 3 ? 1 : 2,
            to: 3,
            previous,
          });
          this.#saveSnapshot(next);
        }
      }
      // Storage 8 may hold subscription-mode snapshot4 rows, so earlier readers must refuse it.
      // Existing snapshot3 rows are strict-mode records and are deliberately left byte-identical;
      // anything else in an older database is corrupt and rolls the whole upgrade back.
      if (schema !== 0 && schema < 8)
        for (const row of this.#db
          .prepare("SELECT data FROM coordinator_snapshots")
          .all()) {
          const previous = JSON.parse(String(row.data));
          validateSnapshot(previous);
          if (previous.schema !== 3)
            throw new Error("incompatible-coordinator-schema");
        }
      this.#db.exec("PRAGMA user_version=8; COMMIT;");
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }
  /** Daemon projections/configuration; coordinator snapshots remain workflow authority. */
  operatorRecord<T>(key: string): T | undefined {
    const row = this.#db
      .prepare("SELECT data FROM operator_records WHERE key=?")
      .get(key);
    return row ? (JSON.parse(String(row.data)) as T) : undefined;
  }
  saveOperatorRecord(key: string, value: unknown) {
    this.#db
      .prepare(
        "INSERT INTO operator_records(key,data) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
      )
      .run(key, canonical(value));
  }
  operatorRecords<T>(prefix: string): T[] {
    return this.#db
      .prepare(
        "SELECT data FROM operator_records WHERE substr(key,1,?)=? ORDER BY rowid DESC",
      )
      .all(prefix.length, prefix)
      .map((row) => JSON.parse(String(row.data)) as T);
  }
  intent(lease: Lease, input: { key: string; kind: string; payload: Json }) {
    this.#transaction(() => {
      this.#guard(lease);
      this.#intent(lease.runId, input);
    });
  }
  close() {
    this.#db.close();
  }
  #transaction<T>(body: () => T): T {
    const nested = this.#transactionDepth > 0;
    const point = `rocky_${this.#transactionDepth}`;
    this.#db.exec(nested ? `SAVEPOINT ${point}` : "BEGIN IMMEDIATE");
    this.#transactionDepth++;
    try {
      const result = body();
      this.#db.exec(nested ? `RELEASE ${point}` : "COMMIT");
      return result;
    } catch (error) {
      this.#db.exec(
        nested ? `ROLLBACK TO ${point}; RELEASE ${point}` : "ROLLBACK",
      );
      throw error;
    } finally {
      this.#transactionDepth--;
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
  reserveCommand(
    lease: Lease,
    id: string,
    token: string,
    spec: Json,
    binding?: DuplexBinding,
  ) {
    this.#transaction(() => {
      this.#guard(lease);
      if (this.commands(lease.runId).some((c) => c.state !== "finished"))
        throw new Error("command-recovery-required");
      if (binding) {
        validateDuplexLimits(binding.limits);
        const pinned = binding.binaryIdentity;
        if (
          pinned !== undefined &&
          (typeof pinned.path !== "string" ||
            !pinned.path.startsWith("/") ||
            typeof pinned.sha256 !== "string" ||
            !/^[a-f0-9]{64}$/.test(pinned.sha256) ||
            !Number.isSafeInteger(pinned.bytes) ||
            pinned.bytes < 1)
        )
          throw new Error("invalid-binary-identity");
        this.assertDuplexAction(lease, binding.action);
        if (this.duplexInvocation(binding.action.key))
          throw new Error("duplex-invocation-conflict");
      }
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
        ...(binding
          ? {
              duplex: {
                schema: 1 as const,
                ...binding,
                sends: [],
                frames: [],
                inputBytes: 0,
                outputBytes: 0,
                revoked: false,
                failure: null,
                stdoutEof: false,
                stderrEof: false,
                childStdoutEof: false,
                childStderrEof: false,
                decoderComplete: false,
              },
            }
          : {}),
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
  /** Checks the exact durable action and slot; never substitutes a transport capability claim. */
  assertDuplexAction(lease: Lease, action: Action) {
    this.#guard(lease);
    validateAction(action);
    const s = this.#snapshot(lease.runId),
      slot = this.implementationSlot();
    if (
      action.runId !== lease.runId ||
      json(s.execution) !== json(action) ||
      action.inputDigest !== s.inputDigest ||
      s.cancelled ||
      s.blocker ||
      s.wait
    )
      throw new Error("action-no-longer-dispatchable");
    if (
      !slot ||
      slot.runId !== lease.runId ||
      slot.actionKey !== action.key ||
      slot.fence !== lease.fence ||
      slot.owner !== lease.owner
    )
      throw new Error("stale-slot-fence");
    if (Math.max(this.clock(), s.budgets.observedAt) >= action.deadline)
      throw new Error("action-deadline-exceeded");
    const effect = this.effect(action.key);
    if (effect?.state !== "sending" || json(effect.payload) !== json(action))
      throw new Error("duplex-action-not-sending");
  }
  /** Neutral name for the same exact action/fence/cancellation/dispatch guard. */
  assertProviderAction(lease: Lease, action: Action) {
    this.assertDuplexAction(lease, action);
    if (
      this.#db
        .prepare(
          "SELECT action_key FROM provider_revocations WHERE action_key=?",
        )
        .get(action.key)
    )
      throw new Error("provider-action-revoked");
  }
  /** Revocation is monotonic and remains effective after restart; this does not claim remote cancellation. */
  revokeProviderAction(action: Action) {
    this.#transaction(() => {
      const effect = this.effect(action.key);
      if (
        !effect ||
        effect.runId !== action.runId ||
        json(effect.payload) !== json(action)
      )
        throw new Error("provider-action-mismatch");
      const result = this.#db
        .prepare(
          "INSERT OR IGNORE INTO provider_revocations(action_key,run_id) VALUES(?,?)",
        )
        .run(action.key, action.runId);
      if (result.changes)
        this.#event(action.runId, "provider-revoked", {
          actionKey: action.key,
        });
    });
  }
  providerRecords(actionKey: string): ProviderRecord[] {
    return this.#db
      .prepare(
        "SELECT data FROM provider_requests WHERE action_key=? ORDER BY rowid",
      )
      .all(actionKey)
      .map((row) => JSON.parse(String(row.data)) as ProviderRecord);
  }
  providerRecord(actionKey: string, id: string): ProviderRecord | undefined {
    const row = this.#db
      .prepare(
        "SELECT data FROM provider_requests WHERE action_key=? AND request_id=?",
      )
      .get(actionKey, id);
    return row ? (JSON.parse(String(row.data)) as ProviderRecord) : undefined;
  }
  #saveProvider(record: ProviderRecord) {
    this.#db
      .prepare(
        "UPDATE provider_requests SET data=? WHERE action_key=? AND request_id=?",
      )
      .run(json(record), record.action.key, record.id);
    this.#event(record.action.runId, "provider-transition", record);
  }
  /** Counting itself has a durable identity; duplicate/ambiguous starts never invoke it again. */
  prepareProvider(
    lease: Lease,
    action: Action,
    id: string,
    body: unknown,
    outputCap: number,
  ): ProviderRecord {
    if (this.#transactionDepth)
      throw new Error("provider-prepare-inside-transaction");
    return this.#transaction(() => {
      this.assertProviderAction(lease, action);
      if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id))
        throw new Error("provider-request-id");
      integer(outputCap, 1);
      if (outputCap > action.tokens) throw new Error("provider-budget");
      const request = freezeProviderRequest(body);
      if (this.stockContract(action.key))
        throw new Error("provider-mode-conflict");
      return this.#insertProvider(lease, action, id, request, outputCap);
    });
  }
  #insertProvider(
    lease: Lease,
    action: Action,
    id: string,
    request: import("../agents/provider-ledger.js").FrozenRequest,
    outputCap: number,
  ): ProviderRecord {
    if (this.providerRecord(action.key, id))
      throw new Error("provider-reconciliation-required");
    const records = this.providerRecords(action.key);
    if (records.length >= 64) throw new Error("provider-attempt-limit");
    if (
      records.some(
        (r) => !["completed", "incomplete", "rejected"].includes(r.state),
      )
    )
      throw new Error("provider-outstanding");
    const record: ProviderRecord = {
      schema: 1,
      id,
      action: JSON.parse(json(action)),
      lease: JSON.parse(json(lease)),
      request,
      outputCap,
      state: "counting",
      inputTokens: null,
      chargedTokens: 0,
      usage: null,
      reason: null,
    };
    this.#db
      .prepare(
        "INSERT INTO provider_requests(action_key,request_id,run_id,data) VALUES(?,?,?,?)",
      )
      .run(action.key, id, action.runId, json(record));
    this.#event(action.runId, "provider-transition", record);
    return record;
  }
  stockContract(actionKey: string): StockContract | undefined {
    const row = this.#db
      .prepare("SELECT data FROM provider_stock_contracts WHERE action_key=?")
      .get(actionKey);
    return row ? JSON.parse(String(row.data)) : undefined;
  }
  registerStockContract(lease: Lease, action: Action, value: StockContract) {
    return this.#transaction(() => {
      this.assertProviderAction(lease, action);
      const contract = freezeStockContract(value);
      if (
        contract.actionKey !== action.key ||
        contract.inputDigest !== action.inputDigest ||
        contract.head !== this.#snapshot(action.runId).head ||
        contract.outputCap > action.tokens
      )
        throw new Error("stock-contract-binding");
      const old = this.stockContract(action.key);
      if (old) {
        if (json(old) !== json(contract))
          throw new Error("stock-contract-conflict");
        return old;
      }
      if (this.providerRecords(action.key).length)
        throw new Error("provider-mode-conflict");
      this.#db
        .prepare(
          "INSERT INTO provider_stock_contracts(action_key,data) VALUES(?,?)",
        )
        .run(action.key, json(contract));
      this.#event(action.runId, "stock-contract-registered", contract);
      return contract;
    });
  }
  /** Freeze and consume semantic history in the SAME transaction as counting admission. */
  prepareStockProvider(
    lease: Lease,
    action: Action,
    body: unknown,
    wireDigest: string,
    headers: Record<string, unknown>,
    assertCurrent: (
      request: import("../agents/provider-ledger.js").FrozenRequest,
    ) => void,
  ) {
    if (this.#transactionDepth)
      throw new Error("provider-prepare-inside-transaction");
    return this.#transaction(() => {
      this.assertProviderAction(lease, action);
      const contract = this.stockContract(action.key);
      if (!contract) throw new Error("stock-contract-missing");
      if (!/^[a-f0-9]{64}$/.test(wireDigest))
        throw new Error("stock-wire-digest");
      const { request, turn, input } = freezeStockRequest(body, contract);
      validateStockHeaders(headers, contract, turn);
      const records = this.providerRecords(action.key),
        previous = records.at(-1);
      const progression = stockProgression(contract, input, turn, previous);
      if (assertCurrent(request) !== undefined)
        throw new Error("provider-guard-must-be-synchronous");
      this.assertProviderAction(lease, action);
      const ordinal = records.length + 1,
        id = `stock-${ordinal}`;
      this.#db
        .prepare(
          "INSERT INTO provider_stock_progressions(action_key,progression,request_id,ordinal) VALUES(?,?,?,?)",
        )
        .run(action.key, progression, id, ordinal);
      const record = this.#insertProvider(
        lease,
        action,
        id,
        request,
        contract.outputCap,
      );
      record.stock = {
        contractDigest: identity(contract),
        ordinal,
        turn,
        parent: previous?.id ?? null,
        progression,
        wireDigest,
        headersDigest: identity(headers),
        response: null,
        forwarding: "pending",
      };
      this.#saveProvider(record);
      return record;
    });
  }
  finishStockProvider(
    actionKey: string,
    id: string,
    outcome: Pick<ProviderRecord, "state" | "usage" | "reason">,
    response: StockCompletion,
  ) {
    return this.#transaction(() => {
      const current = this.providerRecord(actionKey, id);
      if (!current?.stock) throw new Error("stock-request-missing");
      if (current.stock.response) throw new Error("stock-response-replayed");
      if (
        this.providerRecords(actionKey).some(
          (r) => r.stock?.response?.responseId === response.responseId,
        )
      )
        throw new Error("stock-response-id-reused");
      // Repeated cumulative input references are legitimate. Newly returned output
      // identities must be fresh against both native-bound input and provider history.
      const priorItems = this.providerRecords(actionKey).flatMap(
        (r) => r.stock?.response?.items ?? [],
      );
      const inputItems = JSON.parse(current.request.body).input as {
        id?: Json;
      }[];
      const boundItemIds = new Set(
        [...inputItems, ...priorItems]
          .map((item) => item.id)
          .filter((itemId) => itemId !== undefined),
      );
      for (const item of response.items) {
        if (item.id === undefined) continue;
        if (boundItemIds.has(item.id)) throw new Error("stock-item-id-reused");
        boundItemIds.add(item.id);
      }
      const previousCalls = priorItems
        .map((v) => v.call_id)
        .filter((v) => v !== undefined);
      if (
        response.items.some(
          (v) => v.call_id !== undefined && previousCalls.includes(v.call_id),
        )
      )
        throw new Error("stock-call-id-reused");
      const record = this.finishProvider(actionKey, id, outcome);
      record.stock!.response = response;
      this.#saveProvider(record);
      return record;
    });
  }
  /** Commit a single forwarding attempt before client bytes. Accounting never means client consumption. */
  forwardStockProvider<T>(
    lease: Lease,
    action: Action,
    id: string,
    assertCurrent: () => void,
    send: () => T,
  ): T {
    if (this.#transactionDepth)
      throw new Error("provider-forward-inside-transaction");
    this.#transaction(() => {
      const r = this.providerRecord(action.key, id);
      if (
        !r?.stock?.response ||
        !["completed", "incomplete"].includes(r.state) ||
        r.stock.forwarding !== "pending"
      )
        throw new Error("stock-forward-state");
      r.stock.forwarding = "sending";
      this.#saveProvider(r);
    });
    return this.#transaction(() => {
      this.assertProviderAction(lease, action);
      if (assertCurrent() !== undefined)
        throw new Error("provider-guard-must-be-synchronous");
      this.assertProviderAction(lease, action);
      return send();
    });
  }
  observeStockForward(actionKey: string, id: string) {
    this.#transaction(() => {
      const r = this.providerRecord(actionKey, id);
      if (!r?.stock || r.stock.forwarding !== "sending")
        throw new Error("stock-forward-state");
      r.stock.forwarding = "finished";
      this.#saveProvider(r);
    });
  }

  reserveProvider(
    lease: Lease,
    action: Action,
    id: string,
    inputTokens: number,
  ) {
    if (this.#transactionDepth)
      throw new Error("provider-reserve-inside-transaction");
    return this.#transaction(() => {
      this.assertProviderAction(lease, action);
      integer(inputTokens);
      const record = this.providerRecord(action.key, id);
      if (
        !record ||
        record.state !== "counting" ||
        json(record.lease) !== json(lease) ||
        json(record.action) !== json(action)
      )
        throw new Error("provider-reservation-state");
      const charged = inputTokens + record.outputCap;
      integer(charged, 1);
      const prior = this.providerRecords(action.key).reduce(
        (sum, r) => sum + r.chargedTokens,
        0,
      );
      if (charged > action.tokens - prior) throw new Error("provider-budget");
      record.inputTokens = inputTokens;
      record.chargedTokens = charged;
      record.state = "reserved";
      this.#saveProvider(record);
      return record;
    });
  }
  /** Commit attempt BEFORE I/O, then synchronously initiate under the same write lock as cancellation/fencing.
   * A callback must initiate immediately and never await a preflight. An ambiguous callback is never retried.
   */
  dispatchProvider<T>(
    lease: Lease,
    action: Action,
    id: string,
    assertCurrent: () => void,
    send: (record: ProviderRecord) => T,
  ): T {
    if (this.#transactionDepth)
      throw new Error("provider-send-inside-transaction");
    this.#transaction(() => {
      const record = this.providerRecord(action.key, id);
      if (
        !record ||
        record.state !== "reserved" ||
        json(record.lease) !== json(lease) ||
        json(record.action) !== json(action)
      )
        throw new Error("provider-send-state");
      record.state = "sending";
      this.#saveProvider(record);
    });
    return this.#transaction(() => {
      this.assertProviderAction(lease, action);
      const current = assertCurrent();
      if (current !== undefined)
        throw new Error("provider-guard-must-be-synchronous");
      this.assertProviderAction(lease, action);
      return send(this.providerRecord(action.key, id)!);
    });
  }
  /** Observation may outlive lease/cancellation; it never authorizes a new side effect or refunds a charge. */
  finishProvider(
    actionKey: string,
    id: string,
    outcome: Pick<ProviderRecord, "state" | "usage" | "reason">,
  ) {
    return this.#transaction(() => {
      const record = this.providerRecord(actionKey, id);
      if (!record) throw new Error("provider-not-found");
      if (
        json({
          state: record.state,
          usage: record.usage,
          reason: record.reason,
        }) === json(outcome)
      )
        return record;
      if (!["counting", "reserved", "sending"].includes(record.state))
        throw new Error("provider-receipt-conflict");
      if (outcome.state === "rejected") {
        if (record.state === "sending" || outcome.usage !== null)
          throw new Error("provider-receipt-state");
      } else if (outcome.state === "unknown") {
        if (outcome.usage !== null) throw new Error("provider-unknown-usage");
      } else if (["completed", "incomplete"].includes(outcome.state)) {
        const u = outcome.usage;
        if (
          record.state !== "sending" ||
          !u ||
          u.input !== record.inputTokens ||
          u.output > record.outputCap ||
          u.total !== u.input + u.output ||
          (u.reasoning !== null && u.reasoning > u.output)
        )
          throw new Error("provider-usage-mismatch");
        for (const n of [u.input, u.output, u.total]) integer(n);
        if (u.reasoning !== null) integer(u.reasoning);
        else if (!record.stock) throw new Error("provider-reasoning-unknown");
        if (!/^[a-f0-9]{64}$/.test(u.receipt))
          throw new Error("provider-receipt-hash");
      } else throw new Error("provider-receipt-state");
      if (outcome.reason !== null && !/^[a-z-]{1,80}$/.test(outcome.reason))
        throw new Error("provider-reason");
      Object.assign(record, outcome);
      this.#saveProvider(record);
      return record;
    });
  }
  /** Bounded, credential-free ingress observation, never raw Authorization or attacker text. */
  observeProvider(
    runId: string,
    observation: {
      method: string;
      route: string;
      bytes: number;
      digest: string;
      outcome: string;
    },
  ) {
    integer(observation.bytes);
    if (
      !/^[a-f0-9]{64}$/.test(observation.digest) ||
      ![observation.method, observation.route, observation.outcome].every((v) =>
        /^[a-z-]{1,80}$/.test(v),
      )
    )
      throw new Error("provider-observation");
    this.#event(runId, "provider-ingress", observation);
  }
  assertDuplexStart(id: string, token: string) {
    const c = this.#duplex(id, token);
    this.assertDuplexAction(c.lease, c.duplex.action);
    if (c.duplex.revoked || c.duplex.failure)
      throw new Error("duplex-input-closed");
  }
  duplexInvocation(key: string): CommandRecord | undefined {
    const rows = this.#db.prepare("SELECT data FROM commands").all();
    return rows
      .map((r) => JSON.parse(String(r.data)) as CommandRecord)
      .find((c) => c.duplex?.action.key === key);
  }
  #duplex(id: string, token: string) {
    const c = this.command(id);
    if (!c?.duplex || c.token !== token)
      throw new Error("duplex-capability-invalid");
    if (c.state === "finished" || c.state === "recovery-required")
      throw new Error("duplex-not-running");
    return c as CommandRecord & { duplex: DuplexState };
  }
  #saveDuplex(c: CommandRecord, observation: Json) {
    this.#db
      .prepare("UPDATE commands SET data=? WHERE id=?")
      .run(canonical(c), c.id);
    this.#event(c.runId, "duplex-observed", { id: c.id, observation });
  }
  queueDuplex(
    lease: Lease,
    id: string,
    key: string,
    frame: Json,
    end = false,
  ): DuplexSend {
    const wire = end ? "" : canonical(frame) + "\n";
    return this.#queueDuplexSend(lease, id, key, wire, end);
  }
  /** Queue exact raw UTF-8 text as a once-only stdin write: no JSON framing, no added newline.
   * Durable attempted-before-IO, conflict and limit semantics are identical to queueDuplex. */
  queueDuplexText(lease: Lease, id: string, key: string, text: string) {
    if (typeof text !== "string" || !text)
      throw new Error("invalid-duplex-text");
    const bytes = Buffer.from(text, "utf8");
    let decoded: string;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error("invalid-duplex-text");
    }
    if (decoded !== text) throw new Error("invalid-duplex-text");
    return this.#queueDuplexSend(lease, id, key, text, false);
  }
  #queueDuplexSend(
    lease: Lease,
    id: string,
    key: string,
    wire: string,
    end: boolean,
  ): DuplexSend {
    return this.#transaction(() => {
      const record = this.command(id);
      if (!record?.duplex || record.runId !== lease.runId)
        throw new Error("duplex-not-found");
      if (!key || key.length > 256) throw new Error("invalid-duplex-send-key");
      const old = record.duplex.sends.find((s) => s.key === key);
      if (old) {
        if (old.wire !== wire || old.end !== end)
          throw new Error("duplex-send-conflict");
        return old; // Observation only, including after cancellation/restart. Never resend.
      }
      const c = this.#duplex(id, record.token),
        d = c.duplex;
      this.assertDuplexAction(lease, d.action);
      if (json(c.lease) !== json(lease)) throw new Error("stale-duplex-fence");
      if (d.revoked || d.failure || d.sends.some((s) => s.end))
        throw new Error("duplex-input-closed");
      const bytes = Buffer.byteLength(wire);
      if (
        bytes > d.limits.frameBytes ||
        d.inputBytes + bytes > d.limits.inputBytes ||
        d.sends.length >= d.limits.inputFrames
      )
        throw new Error("duplex-input-limit");
      const send: DuplexSend = { key, wire, end, state: "queued" };
      d.sends.push(send);
      d.inputBytes += bytes;
      this.#saveDuplex(c, { send: key, state: "queued", bytes });
      return send;
    });
  }
  /** Commit ambiguity BEFORE any pipe write. A writing row is never eligible again. */
  claimDuplexSend(id: string, token: string): DuplexSend | undefined {
    return this.#transaction(() => {
      const c = this.#duplex(id, token),
        d = c.duplex;
      this.assertDuplexAction(c.lease, d.action);
      if (d.revoked || d.failure) throw new Error("duplex-input-closed");
      if (d.sends.some((s) => s.state === "writing"))
        throw new Error("duplex-send-unknown");
      const send = d.sends.find((s) => s.state === "queued");
      if (!send) return;
      send.state = "writing";
      this.#saveDuplex(c, { send: send.key, state: "writing" });
      return send;
    });
  }
  /** Initiate exactly one previously reserved write while holding the same fence/cancel transaction. */
  writeDuplex(
    id: string,
    token: string,
    key: string,
    write: (send: DuplexSend) => void,
  ) {
    // This commit must precede the OS side effect. A failed final guard consumes the attempt too.
    if (this.#transactionDepth)
      throw new Error("duplex-write-inside-transaction");
    this.#transaction(() => {
      const c = this.#duplex(id, token),
        send = c.duplex.sends.find((s) => s.key === key);
      if (!send || send.state !== "writing" || send.attempted)
        throw new Error("duplex-send-unknown");
      send.attempted = true;
      this.#saveDuplex(c, { send: key, state: "attempted" });
    });
    return this.#transaction(() => {
      const c = this.#duplex(id, token),
        d = c.duplex;
      this.assertDuplexAction(c.lease, d.action);
      if (d.revoked || d.failure) throw new Error("duplex-input-closed");
      const send = d.sends.find((s) => s.key === key)!;
      write(send);
    });
  }
  finishDuplexSend(id: string, token: string, key: string) {
    this.#transaction(() => {
      const c = this.#duplex(id, token),
        send = c.duplex.sends.find((s) => s.key === key);
      if (!send || send.state !== "writing" || !send.attempted)
        throw new Error("duplex-send-not-reserved");
      send.state = "written";
      this.#saveDuplex(c, { send: key, state: "written" });
    });
  }
  observeDuplex(
    id: string,
    token: string,
    update: {
      frame?: Json;
      bytes?: number;
      stdoutEof?: true;
      stderrEof?: true;
      childStdoutEof?: true;
      childStderrEof?: true;
      decoderComplete?: true;
      failure?: string;
    },
  ) {
    this.#transaction(() => {
      const c = this.#duplex(id, token),
        d = c.duplex;
      if (update.bytes !== undefined) {
        if (!Number.isSafeInteger(update.bytes) || update.bytes < 0)
          throw new Error("invalid-duplex-bytes");
        d.outputBytes += update.bytes;
        if (d.outputBytes > d.limits.outputBytes) {
          d.outputBytes = d.limits.outputBytes;
          d.failure ??= "duplex-output-limit";
        }
      }
      if (Object.hasOwn(update, "frame") && !d.failure) {
        if (
          d.frames.length >= d.limits.outputFrames ||
          Buffer.byteLength(canonical(update.frame)) + 1 > d.limits.frameBytes
        )
          d.failure = "duplex-output-limit";
        else d.frames.push(update.frame!);
      }
      d.stdoutEof ||= update.stdoutEof ?? false;
      d.stderrEof ||= update.stderrEof ?? false;
      d.childStdoutEof ||= update.childStdoutEof ?? false;
      d.childStderrEof ||= update.childStderrEof ?? false;
      d.decoderComplete ||= update.decoderComplete ?? false;
      d.failure ??= update.failure ?? null;
      this.#saveDuplex(c, {
        frames: d.frames.length,
        outputBytes: d.outputBytes,
        failure: d.failure,
        stdoutEof: d.stdoutEof,
        stderrEof: d.stderrEof,
        childStdoutEof: d.childStdoutEof,
        childStderrEof: d.childStderrEof,
        decoderComplete: d.decoderComplete,
      });
    });
  }
  revokeDuplex(lease: Lease, key: string) {
    this.#transaction(() => {
      this.#guard(lease, true);
      const c = this.duplexInvocation(key);
      if (!c?.duplex || c.runId !== lease.runId)
        throw new Error("duplex-not-found");
      c.duplex.revoked = true;
      this.#saveDuplex(c, { revoked: true });
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
    const run = this.get(s.runId);
    // Run cancellation can arrive independently of the snapshot; no later save may revoke it.
    if (run.cancelled && !s.cancelled) {
      s.cancelled = true;
      s.stage = s.execution ? "cancelling" : "cancelled";
      s.wait = null;
    }
    validateSnapshot(s);
    this.#db
      .prepare("UPDATE coordinator_snapshots SET data=? WHERE run_id=?")
      .run(json(s), s.runId);
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
    event: Exclude<Event, { type: "receipt" | "observation" }>,
  ) {
    if ((source as string) === "evidence")
      throw new Error("receipt-registration-required");
    return this.#transaction(() => this.#ingest(runId, source, eventId, event));
  }
  /** Obtain before launching a collector. Stable collectorKey retries return the original token, even after supersession. */
  beginCoordinatorObservation(
    lease: Lease,
    kind: ReceiptKind,
    collectorKey: string,
  ): Observation {
    text(collectorKey);
    return this.#transaction(() => {
      this.#guard(lease);
      const s = this.#snapshot(lease.runId);
      const owner = this.#db
        .prepare(
          "SELECT run_id FROM coordinator_issues WHERE repository=? AND issue=?",
        )
        .get(s.repository, s.issue);
      if (owner?.run_id !== s.runId)
        throw new Error("issue-ownership-superseded");
      const hash = identity({ kind, collectorKey });
      const prior = this.#db
        .prepare(
          "SELECT data FROM coordinator_receipts WHERE run_id=? AND kind=? AND hash=?",
        )
        .get(s.runId, "observation", hash);
      if (prior)
        return JSON.parse(String(prior.data)).observation as Observation;
      const observation: Observation = {
        schema: 1,
        runId: s.runId,
        kind,
        collectorKey,
        generation: (s.observations[kind]?.generation ?? 0) + 1,
        inputDigest: s.inputDigest,
        bundleDigest: evidenceBundle(s, kind),
      };
      validateObservation(observation);
      const { snapshot } = reduce(
        s,
        { type: "observation", observation },
        this.clock(),
      );
      this.#db
        .prepare(
          "INSERT INTO coordinator_receipts(run_id,kind,hash,data) VALUES(?,?,?,?)",
        )
        .run(
          s.runId,
          "observation",
          hash,
          json({ observation, receiptHash: null }),
        );
      this.#saveSnapshot(snapshot);
      this.#event(s.runId, "coordinator-observation-begun", {
        observation,
        revision: snapshot.revision,
      });
      return observation;
    });
  }
  #assertObservation(
    s: RunSnapshot,
    kind: ReceiptKind,
    observation: Observation,
    receiptHash: string,
  ) {
    validateObservation(observation);
    if (
      observation.runId !== s.runId ||
      observation.kind !== kind ||
      observation.inputDigest !== s.inputDigest
    )
      throw new Error("stale-observation-inputs");
    if (json(s.observations[kind] ?? null) !== json(observation))
      throw new Error("superseded-observation");
    if (observation.bundleDigest !== evidenceBundle(s, kind))
      throw new Error("stale-evidence-bundle");
    const hash = identity({ kind, collectorKey: observation.collectorKey });
    const row = this.#db
      .prepare(
        "SELECT data FROM coordinator_receipts WHERE run_id=? AND kind='observation' AND hash=?",
      )
      .get(s.runId, hash);
    if (!row) throw new Error("unissued-observation");
    const record = JSON.parse(String(row.data));
    if (json(record.observation) !== json(observation))
      throw new Error("observation-conflict");
    if (record.receiptHash !== null && record.receiptHash !== receiptHash)
      throw new Error("observation-result-conflict");
    return { hash, record };
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
        observation: receipt.observation,
        reference,
        inputs: i,
        outcome: receipt.outcome,
        signature: receipt.signature,
        diagnostics: receipt.diagnostics,
      };
      const event: Event = { type: "receipt", kind, receipt: state };
      validateEvent(event, "evidence");
      const { hash, record } = this.#assertObservation(
        s,
        kind,
        state.observation,
        reference.sha256,
      );
      record.receiptHash = reference.sha256;
      this.#db
        .prepare(
          "UPDATE coordinator_receipts SET data=? WHERE run_id=? AND kind='observation' AND hash=?",
        )
        .run(json(record), s.runId, hash);
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
      if (event.type === "result") {
        const effect = this.effect(event.actionKey);
        if (
          effect?.runId === run.id &&
          effect.kind === "coordinator-action" &&
          effect.state === "confirmed"
        ) {
          if (json(effect.receipt) !== json(event))
            throw new Error("action-result-conflict");
          this.#db
            .prepare(
              "UPDATE coordinator_inbox SET consumed_revision=? WHERE source=? AND event_id=?",
            )
            .run(old.revision, source, eventId);
          this.#event(run.id, "coordinator-result-replayed", {
            source,
            eventId,
            actionKey: event.actionKey,
          });
          return old;
        }
      }
      if (event.type === "receipt") {
        this.#assertObservation(
          old,
          event.kind,
          event.receipt.observation,
          event.receipt.reference.sha256,
        );
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
    if (Math.max(this.clock(), s.budgets.observedAt) >= a.deadline)
      throw new Error("action-deadline-exceeded");
    validateAction(a);
    validateCapability(transport.capability);
    const qualification = transport.qualification ?? null;
    validateQualification(qualification);
    if (a.schema === 1) {
      if (a.capabilityId && transport.capability?.id !== a.capabilityId)
        throw new Error("hard-limits-capability-mismatch");
      if (qualification) throw new Error("transport-budget-mode-mismatch");
    } else {
      // A subscription transport cannot carry hard-limit claims into this mode.
      if (transport.capability)
        throw new Error("transport-budget-mode-mismatch");
      // Keyed on the action kind, not the row's qualificationId: a tampered/missing id on an
      // agent-work action must not bypass the exact-match requirement.
      if (isAgentWork(a.kind) && json(qualification) !== json(s.qualification))
        throw new Error("execution-qualification-mismatch");
    }
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
