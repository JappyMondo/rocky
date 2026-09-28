// Taskbot #90: harness-neutral subscription-observed-v1 budget mode (contract acceptance/subscription
// at 572accf, M01-M05 plus F08-F11 coordinator semantics). Every test uses the real SQLite Store.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import ts from "typescript";
import {
  coordinatorModule,
  admission,
  apply,
  finish,
  receipt,
  knownUsage,
  versions,
  capability,
  fixture,
  baseline as strictBaseline,
  retain,
} from "./coordinator-support.mjs";
const { Store, Evidence, validateEvent } = coordinatorModule;

const MODE = "subscription-observed-v1";
const ACCEPTED_SOURCE = "572accff349b2f5e5f33e51445c2d6cbbb0d4493";
const sha = (v) => createHash("sha256").update(String(v)).digest("hex");
// Synthetic, self-described test identity. It is not an approved binding and grants nothing outside tests.
const qualification = {
  schema: 1,
  id: "synthetic-unapproved-test-qualification",
  harness: "synthetic-harness",
  contractId: "synthetic-test-contract",
  budgetMode: MODE,
  binding: sha("synthetic-unapproved-binding"),
};
const local = knownUsage(0, false);
let receipts = 0;
function reported(input, output, extra = {}) {
  return {
    schema: 2,
    status: "reported",
    source: "native-harness-telemetry",
    harness: qualification.harness,
    receipt: sha(`raw-telemetry-${++receipts}`),
    components: {
      input,
      cachedInput: null,
      cacheWriteInput: null,
      output,
      reasoningOutput: null,
      ...extra,
    },
  };
}
const ambiguous = () => ({
  schema: 2,
  status: "ambiguous-zero",
  source: "native-harness-telemetry",
  harness: qualification.harness,
  receipt: sha(`raw-all-zero-${++receipts}`),
});
const unknown = {
  schema: 2,
  status: "unknown",
  source: "native-harness-telemetry",
  harness: qualification.harness,
  reason: "terminal-telemetry-missing",
};
function subscriptionAdmission(runId = "run-1", overrides = {}) {
  const base = admission(runId);
  return {
    ...base,
    capability: null,
    budget: { mode: MODE, reportedTokenThreshold: 100 },
    qualification,
    limits: { ...base.limits, actionTokens: 40 },
    ...overrides,
  };
}
function subscriptionFixture(name, overrides = {}) {
  const root = resolve(
    process.env.COORDINATOR_ARTIFACT_ROOT ??
      ".qualification/subscription-budget-90/artifacts",
    `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(root, { recursive: true });
  const store = new Store(`${root}/state.sqlite`, () => 1000);
  const s = store.admitCoordinator(subscriptionAdmission("run-1", overrides));
  const lease = store.claim("run-1", "owner", versions, 1000000);
  return {
    dir: root,
    store,
    lease,
    evidence: new Evidence(`${root}/evidence`),
    s,
  };
}
function reopen(f, owner = "restarted") {
  const path = f.store.path;
  f.store.release(f.lease);
  f.store.close();
  f.store = new Store(path, () => 1000);
  f.lease = f.store.claim("run-1", owner, versions, 1000000);
}
const snap = (f) => f.store.coordinatorSnapshot("run-1");
const schedule = (f, kind) =>
  apply(f.store, f.lease, { type: "schedule", kind });
function baseline(f) {
  schedule(f, "baseline");
  finish(f, { usage: local });
  receipt(f, "baseline");
}
function implement(f, usage, head = "head-2") {
  baseline(f);
  schedule(f, "implement");
  return finish(f, { usage, outcome: "changed", head });
}
function verify(f, outcome = "pass") {
  schedule(f, "verify");
  finish(f, { usage: local });
  return receipt(f, "checks", outcome);
}
function blockedWithoutCharge(before, after, detail) {
  assert.equal(after.execution, null);
  assert.equal(after.blocker?.kind, "budget");
  assert.equal(after.blocker?.detail, detail);
  assert.deepEqual(
    { ...after.budgets, observedAt: 0, elapsedMs: 0 },
    { ...before.budgets, observedAt: 0, elapsedMs: 0 },
  );
}

test("SB01 admission binds an explicit harness-neutral mode; no hard-limit capability, caller flag or strict/subscription mixing", () => {
  const f = fixture("SB01");
  const attempts = [
    [{ capability }, /subscription-mode-rejects-hard-limits-capability/],
    [
      { qualification: { ...qualification, hardTokenLimit: true } },
      /invalid-contract-fields/,
    ],
    [
      { qualification: { ...qualification, binding: "approved" } },
      /invalid-execution-qualification/,
    ],
    [{ budget: { mode: MODE, reportedTokenThreshold: 0 } }, /invalid-counter/],
    [
      {
        budget: {
          mode: MODE,
          reportedTokenThreshold: 100,
          hardAggregateTokenLimit: true,
        },
      },
      /invalid-contract-fields/,
    ],
    [
      {
        budget: {
          mode: "subscription-observed-v2",
          reportedTokenThreshold: 100,
        },
      },
      /unsupported-budget-mode/,
    ],
  ];
  for (const [overrides, error] of attempts)
    assert.throws(
      () => f.store.admitCoordinator(subscriptionAdmission("run-x", overrides)),
      error,
    );
  assert.throws(
    () =>
      f.store.admitCoordinator({
        ...admission("run-y"),
        qualification,
      }),
    /strict-mode-rejects-subscription-qualification/,
  );
  assert.throws(() => f.store.get("run-x"));
  assert.throws(() => f.store.get("run-y"));
  // Unqualified subscription runs are stored as snapshot4 but cannot start any work.
  const s = f.store.admitCoordinator(
    subscriptionAdmission("run-z", { qualification: null }),
  );
  assert.equal(s.schema, 4);
  assert.deepEqual(s.budget, { mode: MODE, reportedTokenThreshold: 100 });
  assert.equal(s.capability, null);
  assert.equal(s.budgets.harnessReportedTokens, 0);
  assert.equal(s.budgets.knownTokens, 0);
  assert.deepEqual(s.blocker, {
    kind: "capability",
    detail: "subscription-execution-qualification-unavailable",
  });
  // Existing strict admissions are unchanged snapshot3 records.
  const strict = f.store.coordinatorSnapshot("run-1");
  assert.equal(strict.schema, 3);
  assert.equal("budget" in strict, false);
  assert.equal("harnessReportedTokens" in strict.budgets, false);
  retain(f, { unqualified: s, strict });
  f.store.close();
});

test("SB02 reported overrun is retained unclipped; threshold stops every later agent action while local verify and CI observation continue (F09)", () => {
  const f = subscriptionFixture("SB02");
  const usage = reported(80, 40, { cachedInput: 30, reasoningOutput: 10 });
  baseline(f);
  const active = schedule(f, "implement");
  let s = finish(f, { usage, outcome: "changed", head: "head-2" });
  assert.equal(s.head, "head-2");
  assert.equal(s.stage, "verifying");
  assert.equal(s.budgets.harnessReportedTokens, 120);
  assert.equal(s.budgets.reservedTokens, 40);
  assert.equal(s.budgets.knownTokens, 0);
  assert.equal(s.blocker, null);
  reopen(f);
  s = verify(f);
  assert.equal(s.stage, "awaiting_delivery_evidence");
  let before = snap(f);
  s = schedule(f, "review");
  blockedWithoutCharge(before, s, "subscription-reported-threshold-reached");
  assert.equal(f.store.implementationSlot(), null);
  reopen(f);
  s = schedule(f, "observe_ci");
  assert.equal(s.execution.schema, 2);
  assert.equal(s.execution.qualificationId, null);
  finish(f, { usage: local });
  receipt(f, "ci", "fail", "ci-failure");
  before = snap(f);
  s = schedule(f, "repair_ci");
  blockedWithoutCharge(before, s, "subscription-reported-threshold-reached");
  assert.equal(s.budgets.ci, 0);
  // Arbitrate and product repair take the same single gate; nothing was reserved or counted.
  for (const kind of ["arbitrate", "repair_product", "implement"])
    assert.throws(() => schedule(f, kind), /run-blocked|invalid-stage-action/);
  // The durable effect receipt retains the exact unclipped components and raw-telemetry digest.
  assert.deepEqual(f.store.effect(active.execution.key).receipt.usage, usage);
  assert.equal(active.execution.tokens, 40);
  assert.equal(snap(f).budgets.harnessReportedTokens, 120);
  retain(f, { usage, s });
  f.store.close();
});

for (const [input, output, allowed] of [
  [60, 39, true],
  [60, 40, false],
  [61, 40, false],
])
  test(`SB03 accumulated reported total ${input + output} vs threshold 100 (F09 99/100/101)`, () => {
    const f = subscriptionFixture(`SB03-${input + output}`);
    implement(f, reported(input, 0));
    verify(f);
    receipt(f, "ci");
    let s = schedule(f, "review");
    // First agent action is below threshold; the review itself is still admitted.
    assert.equal(s.execution?.kind, "review");
    assert.equal(s.execution.qualificationId, qualification.id);
    assert.equal(s.execution.tokens, 40);
    s = finish(f, { usage: reported(0, output), outcome: "complete" });
    assert.equal(s.budgets.harnessReportedTokens, input + output);
    receipt(f, "review", "fail", "blocking-finding");
    const next = snap(f);
    s = schedule(f, "repair_review");
    if (allowed) {
      assert.equal(s.execution?.kind, "repair_review");
      assert.equal(s.budgets.review, 1);
      assert.equal(s.budgets.reservedTokens, next.budgets.reservedTokens + 40);
    } else
      blockedWithoutCharge(next, s, "subscription-reported-threshold-reached");
    f.store.close();
  });

test("SB04 ambiguous all-zero success is never known zero: head not adopted, barrier survives revision/reopen, agent repair stops, local work continues (F08, M04)", () => {
  const f = subscriptionFixture("SB04");
  let s = implement(f, ambiguous(), "unqualified-head");
  assert.equal(s.head, "head-1");
  assert.equal(s.stage, "recovery_required");
  assert.equal(s.blocker.detail, "successful-result-usage-ambiguous-zero");
  assert.deepEqual(s.unqualifiedResults, ["implement"]);
  assert.equal(s.budgets.harnessAmbiguousZero, 1);
  assert.equal(s.budgets.harnessReportedTokens, 0);
  assert.equal(s.budgets.knownTokens, 0);
  reopen(f);
  s = apply(f.store, f.lease, {
    type: "revise",
    head: s.head,
    scope: { ...s.scope, revision: 2 },
    checkPlan: s.checkPlan,
  });
  s = verify(f, "fail");
  assert.equal(s.stage, "verifying");
  const before = snap(f);
  s = schedule(f, "repair_product");
  blockedWithoutCharge(before, s, "subscription-usage-unresolved");
  assert.equal(s.budgets.product, 0);
  assert.deepEqual(s.unqualifiedResults, ["implement"]);
  reopen(f);
  assert.deepEqual(snap(f), s);
  f.store.close();
});

test("SB05 unknown usage on a failed review blocks later CI agent repair but not CI observation; review exhaustion alone keeps CI entitlement (F10)", () => {
  const f = subscriptionFixture("SB05");
  implement(f, reported(10, 5));
  verify(f);
  let s = schedule(f, "review");
  s = finish(f, { usage: unknown, outcome: "failed", detail: "lost review" });
  assert.equal(s.budgets.unknownActions, 1);
  assert.deepEqual(s.unqualifiedResults, []);
  s = schedule(f, "observe_ci");
  assert.equal(s.execution.kind, "observe_ci");
  finish(f, { usage: local });
  receipt(f, "ci", "fail", "ci-failure");
  const before = snap(f);
  s = schedule(f, "repair_ci");
  blockedWithoutCharge(before, s, "subscription-usage-unresolved");
  // Contrast: exhausted review correction alone does not spend or block the reserved CI repair.
  const g = subscriptionFixture("SB05-review-exhausted");
  implement(g, reported(10, 5));
  verify(g);
  receipt(g, "ci");
  schedule(g, "review");
  finish(g, { usage: reported(5, 5), outcome: "complete" });
  receipt(g, "review", "fail", "finding-1");
  schedule(g, "repair_review");
  finish(g, { usage: reported(5, 5), outcome: "changed", head: "head-3" });
  verify(g);
  receipt(g, "ci");
  schedule(g, "review");
  finish(g, { usage: reported(5, 5), outcome: "complete" });
  receipt(g, "review", "fail", "finding-2");
  s = apply(g.store, g.lease, { type: "schedule", kind: "repair_review" });
  assert.equal(s.blocker.detail, "review-correction-exhausted");
  receipt(g, "ci", "fail", "ci-failure");
  s = apply(g.store, g.lease, { type: "schedule", kind: "repair_ci" });
  assert.equal(s.execution.kind, "repair_ci");
  assert.equal(s.budgets.ci, 1);
  assert.equal(s.budgets.review, 1);
  assert.equal(s.budgets.harnessReportedTokens, 45);
  retain(g, s);
  f.store.close();
  g.store.close();
});

test("SB06 unknown then drain and duplicate/conflicting finals: usage immutable, never double-counted, barrier kept across restart (M03)", () => {
  const f = subscriptionFixture("SB06");
  baseline(f);
  const active = schedule(f, "implement");
  let s = finish(f, {
    usage: unknown,
    outcome: "changed",
    head: "late",
    quiescent: false,
  });
  assert.deepEqual(s.executionUsage, unknown);
  assert.deepEqual(s.unqualifiedResults, ["implement"]);
  assert.ok(f.store.implementationSlot());
  reopen(f);
  assert.throws(
    () =>
      finish(f, { usage: reported(10, 10), outcome: "changed", head: "late" }),
    /action-usage-conflict/,
  );
  s = finish(f, { usage: unknown, outcome: "failed", head: active.head });
  assert.equal(f.store.implementationSlot(), null);
  assert.equal(s.budgets.unknownActions, 1);
  assert.deepEqual(s.unqualifiedResults, ["implement"]);
  // Duplicate settled result under a new inbox ID is consumed without accounting.
  const g = subscriptionFixture("SB06-duplicate");
  baseline(g);
  const a = schedule(g, "implement");
  const usage = reported(30, 20);
  const event = {
    type: "result",
    actionKey: a.execution.key,
    inputDigest: a.execution.inputDigest,
    quiescent: true,
    usage,
    outcome: "changed",
    head: "head-2",
    detail: "synthetic",
  };
  const settled = apply(g.store, g.lease, event, "transport", "first");
  assert.equal(settled.budgets.harnessReportedTokens, 50);
  reopen(g);
  assert.deepEqual(
    apply(g.store, g.lease, event, "transport", "redelivered"),
    settled,
  );
  assert.throws(
    () =>
      apply(
        g.store,
        g.lease,
        { ...event, usage: reported(30, 21) },
        "transport",
        "altered",
      ),
    /action-result-conflict/,
  );
  assert.equal(snap(g).budgets.harnessReportedTokens, 50);
  assert.deepEqual(g.store.effect(a.execution.key).receipt, event);
  f.store.close();
  g.store.close();
});

test("SB07 native telemetry cannot be relabelled: provider receipts, caller known-zero, wrong harness and malformed components reject before mutation (F08, M03)", () => {
  const f = subscriptionFixture("SB07");
  baseline(f);
  const active = schedule(f, "implement");
  for (const [usage, error] of [
    [knownUsage(30), /subscription-agent-usage-requires-harness-telemetry/],
    [
      knownUsage(0, false),
      /subscription-agent-usage-requires-harness-telemetry/,
    ],
    [
      { ...reported(10, 10), harness: "other-harness" },
      /usage-harness-mismatch/,
    ],
  ])
    assert.throws(
      () => finish(f, { usage, outcome: "changed", head: "x" }),
      error,
    );
  const bad = [
    reported(0, 0),
    reported(10, 5, { cachedInput: 8, cacheWriteInput: 3 }),
    reported(10, 5, { reasoningOutput: 6 }),
    reported(-1, 5),
    reported(1.5, 5),
    reported(Number.MAX_SAFE_INTEGER, 1),
    { ...reported(10, 5), source: "provider-receipt" },
    { ...reported(10, 5), total: 15 },
    { ...reported(10, 5), receipt: "raw" },
    { ...ambiguous(), components: reported(0, 0).components },
    { ...unknown, harness: "" },
    { ...unknown, schema: 1 },
  ];
  for (const usage of bad)
    assert.throws(() =>
      validateEvent({ ...finishEvent(active), usage }, "transport"),
    );
  assert.deepEqual(snap(f), active);
  assert.ok(f.store.implementationSlot());
  // Strict runs keep refusing harness telemetry (no mode change through a result).
  const g = fixture("SB07-strict");
  strictBaseline(g);
  apply(g.store, g.lease, { type: "schedule", kind: "implement" });
  assert.throws(
    () => finish(g, { usage: reported(10, 10), outcome: "changed", head: "x" }),
    /harness-usage-requires-subscription-mode/,
  );
  f.store.close();
  g.store.close();
});
function finishEvent(s) {
  return {
    type: "result",
    actionKey: s.execution.key,
    inputDigest: s.execution.inputDigest,
    quiescent: true,
    usage: local,
    outcome: "changed",
    head: "x",
    detail: "synthetic",
  };
}

test("SB08 dispatch requires the exact run qualification; hard-limit transports, stale fences, changed versions, cancel and deadline keep counting reported usage", async () => {
  const f = subscriptionFixture("SB08");
  baseline(f);
  const s = schedule(f, "implement");
  const calls = [];
  const transport = (over = {}) => ({
    versions,
    capability: null,
    qualification,
    begin(action) {
      calls.push(action);
      return new Promise(() => {});
    },
    interrupt() {},
    ...over,
  });
  for (const [over, error] of [
    [{ capability }, /transport-budget-mode-mismatch/],
    [
      { qualification: { ...qualification, binding: sha("other") } },
      /execution-qualification-mismatch/,
    ],
    [{ qualification: null }, /execution-qualification-mismatch/],
    [
      { versions: { ...versions, adapter: "changed" } },
      /incompatible-transport-versions/,
    ],
  ])
    await assert.rejects(
      () =>
        f.store.dispatchCoordinator(f.lease, s.execution.key, transport(over)),
      error,
    );
  const old = f.lease;
  reopen(f);
  await assert.rejects(
    () => f.store.dispatchCoordinator(old, s.execution.key, transport()),
    /lease|stale-slot-fence/,
  );
  assert.equal(calls.length, 0);
  assert.throws(() =>
    f.store.claim(
      "run-1",
      "other-version",
      { ...versions, adapter: "v2" },
      1000,
    ),
  );
  f.store.cancel("run-1");
  const after = finish(f, {
    usage: reported(150, 30),
    outcome: "changed",
    head: "never-adopted",
  });
  assert.equal(after.stage, "cancelled");
  assert.equal(after.head, "head-1");
  assert.equal(after.budgets.harnessReportedTokens, 180);
  assert.equal(after.budgets.reservedTokens, 40);
  // Deadline: a late reported result is still counted but cannot be adopted.
  const g = subscriptionFixture("SB08-deadline");
  baseline(g);
  const a = schedule(g, "implement");
  g.store.release(g.lease);
  g.store.close();
  g.store = new Store(g.store.path, () => a.execution.deadline + 1);
  g.lease = g.store.claim("run-1", "late", versions, 1000000);
  const late = finish(g, {
    usage: reported(5, 5),
    outcome: "changed",
    head: "late",
  });
  assert.equal(late.blocker.detail, "action-deadline-exceeded");
  assert.equal(late.head, "head-1");
  assert.equal(late.budgets.harnessReportedTokens, 10);
  // Strict transports cannot carry a subscription qualification either.
  const h = fixture("SB08-strict");
  strictBaseline(h);
  const strict = apply(h.store, h.lease, {
    type: "schedule",
    kind: "implement",
  });
  await assert.rejects(
    () =>
      h.store.dispatchCoordinator(h.lease, strict.execution.key, {
        ...transport(),
        capability,
      }),
    /transport-budget-mode-mismatch/,
  );
  f.store.close();
  g.store.close();
  h.store.close();
});

test("SB09 model results cannot mint authoritative receipts and the budget mode cannot be revised in place (M02, M05)", () => {
  const f = subscriptionFixture("SB09");
  implement(f, reported(10, 10));
  const s = snap(f);
  const forged = {
    type: "receipt",
    kind: "checks",
    receipt: {
      observation: {},
      reference: {},
      inputs: {},
      outcome: "pass",
      signature: "model",
      diagnostics: "available",
    },
  };
  assert.throws(
    () => f.store.ingestCoordinator("run-1", "transport", "forged", forged),
    /event-authority-rejected/,
  );
  for (const extra of [
    { budget: { mode: "strict-provider-v1" } },
    { budget: { mode: MODE, reportedTokenThreshold: 1000000 } },
    { qualification: null },
  ])
    assert.throws(
      () =>
        apply(f.store, f.lease, {
          type: "revise",
          head: s.head,
          scope: { ...s.scope, revision: 2 },
          checkPlan: s.checkPlan,
          ...extra,
        }),
      /invalid-contract-fields/,
    );
  assert.deepEqual(snap(f), s);
  f.store.close();
});

async function acceptedSource(dir) {
  const loaded = new Map();
  const visit = (path) => {
    if (loaded.has(path)) return;
    const code = execFileSync(
      "git",
      ["show", `${ACCEPTED_SOURCE}:src/${path}.ts`],
      {
        encoding: "utf8",
      },
    );
    loaded.set(
      path,
      execFileSync("git", ["rev-parse", `${ACCEPTED_SOURCE}:src/${path}.ts`], {
        encoding: "utf8",
      }).trim(),
    );
    const out = `${dir}/accepted/${path}.js`;
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(
      out,
      ts.transpileModule(code, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2023,
          module: ts.ModuleKind.ES2022,
        },
      }).outputText,
    );
    for (const [, spec] of code.matchAll(/from\s+"(\.{1,2}\/[^"]+)\.js"/g))
      visit(resolve(`/${dirname(path)}`, spec).slice(1));
  };
  visit("store/index");
  return {
    blobs: Object.fromEntries(loaded),
    Store: (await import(`${dir}/accepted/store/index.js`)).Store,
    contracts: await import(`${dir}/accepted/coordinator/contracts.js`),
  };
}

test("SB10 exact accepted 572accf strict records survive the storage8 boundary unchanged; forged rows roll back; old reader refuses (M01, M02)", async () => {
  const f = fixture("SB10");
  f.store.close();
  const old = await acceptedSource(f.dir);
  const oldPath = `${f.dir}/accepted.sqlite`;
  const store = new old.Store(oldPath, () => 1000);
  const keys = {};
  const run = (id) => {
    store.admitCoordinator(admission(id));
    const lease = store.claim(id, "accepted", versions, 1000000);
    const g = { ...f, store, lease };
    strictBaseline(g);
    keys[id] = apply(store, lease, {
      type: "schedule",
      kind: "implement",
    }).execution.key;
    return g;
  };
  // Unknown-success barrier, hard over-allocation violation and an outstanding cancelled drain.
  const barrier = run("run-1");
  finish(barrier, {
    usage: { schema: 1, status: "unknown", reason: "lost" },
    outcome: "changed",
    head: "x",
  });
  const over = run("run-2");
  const overEvent = {
    ...finishEvent(snapshot(store, "run-2")),
    usage: knownUsage(150),
    detail: "d",
  };
  apply(store, over.lease, overEvent, "transport", "over");
  const drain = run("run-3");
  const pending = snapshot(store, "run-3");
  store.cancel("run-3");
  store.ingestCoordinator("run-3", "transport", "queued-drain", {
    ...finishEvent(pending),
    usage: { schema: 1, status: "unknown", reason: "cancelled" },
    outcome: "interrupted",
    head: pending.head,
  });
  const state = (s) => ({
    runs: ["run-1", "run-2", "run-3"].map((id) => ({
      run: s.get(id),
      snapshot: s.coordinatorSnapshot(id),
      events: s.events(id),
    })),
    slot: s.implementationSlot(),
    effects: ["run-1", "run-2", "run-3"].map((id) => s.effect(keys[id])),
  });
  for (const g of [barrier, over, drain]) store.release(g.lease);
  const before = state(store);
  const tables = (path) => {
    const db = new DatabaseSync(path);
    const out = Object.fromEntries(
      [
        "runs",
        "events",
        "effects",
        "coordinator_snapshots",
        "coordinator_inbox",
        "coordinator_slot",
        "coordinator_receipts",
      ].map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()]),
    );
    out.version = db.prepare("PRAGMA user_version").get().user_version;
    db.close();
    return out;
  };
  store.close();
  const original = readFileSync(oldPath);
  const rows = tables(oldPath);
  assert.equal(rows.version, 7);
  // Forged mode/version rows in an accepted database fail closed and leave it at storage 7.
  for (const [name, forge] of [
    [
      "forged-mode",
      (s) => ({ ...s, budget: { mode: MODE, reportedTokenThreshold: 1 } }),
    ],
    [
      "forged-schema4",
      (s) => ({
        ...s,
        schema: 4,
        budget: { mode: MODE, reportedTokenThreshold: 1 },
        qualification: null,
        capability: null,
        budgets: {
          ...s.budgets,
          harnessReportedTokens: 0,
          harnessAmbiguousZero: 0,
        },
      }),
    ],
  ]) {
    const path = `${f.dir}/${name}.sqlite`;
    copyFileSync(oldPath, path);
    const db = new DatabaseSync(path);
    const s = JSON.parse(
      db
        .prepare("SELECT data FROM coordinator_snapshots WHERE run_id='run-1'")
        .get().data,
    );
    db.prepare(
      "UPDATE coordinator_snapshots SET data=? WHERE run_id='run-1'",
    ).run(JSON.stringify(forge(s)));
    db.close();
    assert.throws(
      () => new Store(path, () => 1000),
      /invalid-contract-fields|incompatible-coordinator-schema/,
    );
    assert.equal(tables(path).version, 7);
  }
  const upgraded = `${f.dir}/upgraded.sqlite`;
  copyFileSync(oldPath, upgraded);
  let next = new Store(upgraded, () => 1000);
  assert.deepEqual(state(next), before);
  const after = tables(upgraded);
  assert.equal(after.version, 8);
  assert.deepEqual({ ...after, version: 7 }, rows);
  const [b1, b2, b3] = before.runs.map((r) => r.snapshot);
  assert.equal(b1.schema, 3);
  assert.deepEqual(b1.unqualifiedResults, ["implement"]);
  assert.equal(b2.blocker.detail, "hard-token-contract-violated");
  assert.equal(before.runs[2].run.cancelled, true);
  assert.ok(b3.execution);
  // Queued strict drain applies under original semantics; settled replay is not double-counted.
  const lease3 = next.claim("run-3", "upgraded", versions, 1000000);
  const drained = next.applyCoordinator(
    lease3,
    b3.revision,
    "transport",
    "queued-drain",
  );
  assert.equal(drained.stage, "cancelled");
  assert.equal(drained.schema, 3);
  assert.equal(drained.budgets.unknownActions, 1);
  assert.equal(next.implementationSlot(), null);
  const lease2 = next.claim("run-2", "upgraded", versions, 1000000);
  assert.deepEqual(
    apply(next, lease2, overEvent, "transport", "over-replayed"),
    b2,
  );
  // Strict run cannot receive harness telemetry and cannot become subscription mode by rerun in place.
  const lease1 = next.claim("run-1", "upgraded", versions, 1000000);
  assert.throws(
    () =>
      next.admitCoordinator(
        subscriptionAdmission("run-1b", {
          issue: "run-1",
          previousRunId: "run-1",
          rerun: "subscription",
        }),
      ),
    /previous-run-not-quiescent-terminal/,
  );
  apply(next, lease1, { type: "cancel" });
  const rerun = next.admitCoordinator(
    subscriptionAdmission("run-1b", {
      issue: "run-1",
      previousRunId: "run-1",
      rerun: "subscription",
    }),
  );
  assert.equal(rerun.schema, 4);
  assert.equal(rerun.budgets.unknownActions, 0);
  const oldRun = next.coordinatorSnapshot("run-1");
  assert.equal(oldRun.schema, 3);
  assert.deepEqual(oldRun.unqualifiedResults, ["implement"]);
  next.close();
  assert.deepEqual(readFileSync(oldPath), original);
  assert.throws(() => new old.Store(upgraded), /incompatible-store-schema/);
  assert.throws(
    () => old.contracts.validateSnapshot(rerun),
    /incompatible-coordinator-schema/,
  );
  writeFileSync(
    `${f.dir}/accepted-source.json`,
    JSON.stringify(
      { source: ACCEPTED_SOURCE, blobs: old.blobs, before, rerun },
      null,
      2,
    ),
  );
});
function snapshot(store, id) {
  return store.coordinatorSnapshot(id);
}
