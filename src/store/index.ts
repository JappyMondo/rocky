import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { canonical, identity, type Json } from "./json.js";
import { configure } from "../config/index.js";
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
  ) {
    this.path = resolve(path);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    this.#db = new DatabaseSync(this.path, { timeout: 5000 });
    const schema = Number(
      this.#db.prepare("PRAGMA user_version").get()?.user_version,
    );
    if (schema !== 0 && schema !== 1) {
      this.#db.close();
      throw new Error("incompatible-store-schema");
    }
    this.#db
      .exec(`PRAGMA user_version=1; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, data TEXT NOT NULL, owner TEXT, fence INTEGER NOT NULL DEFAULT 0, expires INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id), kind TEXT NOT NULL, data TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS effects(key TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), data TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'append-only'); END;
      CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'append-only'); END;`);
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
      .map((r) => ({ ...r, data: JSON.parse(String(r.data)) as Json }));
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
      run.stage = stage;
      this.#save(run);
      this.#event(run.id, "transition", { stage });
      if (intent) this.#intent(run.id, intent);
    });
  }
  revise(lease: Lease, inputs: { head: string; base: string; scope: string }) {
    this.#transaction(() => {
      const run = this.#guard(lease);
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
}
