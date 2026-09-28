import test from "node:test";
import assert from "node:assert/strict";
import {
  readFileSync,
  existsSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { once } from "node:events";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { Store, DuplexRunner } from "../dist/index.js";
import {
  fixture,
  apply,
  result,
  versions,
  retain,
  baseline,
  capability,
  admission,
} from "./coordinator-support.mjs";
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const x = fn();
    if (x) return x;
    await pause(20);
  }
  throw Error("condition-timeout");
}
const limits = {
  frameBytes: 1024,
  inputBytes: 8192,
  outputBytes: 8192,
  inputFrames: 32,
  outputFrames: 32,
};
function setup(
  name,
  mode = "echo",
  extra = {},
  frameLimits = limits,
  kind = "baseline",
) {
  const f = fixture(`duplex-${name}`, Date.now);
  // Fixture admission defaults to one second; extend only synthetic local action allowance.
  const runner = new DuplexRunner(f.store);
  const spec = {
    file: process.execPath,
    args: [join(process.cwd(), "tests/duplex-fixture.mjs"), mode, f.dir],
    cwd: f.dir,
    outputDir: f.dir,
    timeoutMs: 5000,
    cleanupMs: 100,
    logBytes: 8192,
    ...extra,
  };
  if (kind === "implement") baseline(f);
  apply(f.store, f.lease, { type: "schedule", kind });
  const action = f.store.coordinatorSnapshot(f.lease.runId).execution;
  let id;
  const transport = {
    versions,
    capability: kind === "implement" ? capability : null,
    begin(a) {
      id = runner.start(f.lease, a, spec, frameLimits);
      return new Promise(() => {});
    },
    interrupt(a) {
      runner.interrupt(f.lease, a);
    },
  };
  // The pending observation is intentionally never converted to an application result.
  f.store.dispatchCoordinator(f.lease, action.key, transport).catch((e) => {
    f.dispatchError = e;
  });
  assert.ok(id);
  return { ...f, runner, spec, action, id, transport, frameLimits };
}
async function stop(f) {
  if (
    f.store.command(f.id)?.state === "running" ||
    f.store.command(f.id)?.state === "starting"
  )
    f.runner.interrupt(f.lease, f.action);
  const completion = await f.runner.wait(f.lease, f.id);
  retain(f, {
    completion,
    events: f.store.events(f.lease.runId),
    snapshot: f.store.coordinatorSnapshot(f.lease.runId),
  });
  f.store.close();
  return completion;
}
function absent(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    if (e.code === "ESRCH") return true;
    throw e;
  }
}
test("D01 real fragmented echo, stable invocation/send identities, EOF and protocol final remain separate", async () => {
  const f = setup("echo");
  try {
    assert.equal(f.runner.capability, null);
    assert.equal(f.runner.start(f.lease, f.action, f.spec, limits), f.id);
    assert.throws(
      () =>
        f.runner.start(
          f.lease,
          f.action,
          { ...f.spec, args: ["other"] },
          limits,
        ),
      /invocation-conflict/,
    );
    f.runner.send(f.lease, f.id, "one", { value: "hello ü" });
    assert.throws(
      () => f.runner.send(f.lease, f.id, "one", { value: "conflict" }),
      /send-conflict/,
    );
    f.runner.send(f.lease, f.id, "two", [1, 2]);
    f.runner.end(f.lease, f.id, "end");
    const done = await f.runner.wait(f.lease, f.id);
    assert.equal(done.quiescent, true);
    assert.equal(done.record.result.outcome, "success");
    assert.deepEqual(done.record.duplex.frames, [
      { echo: { value: "hello ü" } },
      { echo: [1, 2] },
      { ended: true },
    ]);
    assert.equal(
      done.record.duplex.sends.filter((s) => s.state === "written").length,
      3,
    );
    assert.equal(
      f.runner.send(f.lease, f.id, "one", { value: "hello ü" }).state,
      "written",
    );
    assert.equal(f.store.implementationSlot().actionKey, f.action.key);
    assert.equal(
      f.store.coordinatorSnapshot(f.lease.runId).budgets.reservedTokens,
      0,
    );
  } finally {
    await stop(f);
  }
});
for (const [mode, failure] of [
  ["multi", null],
  ["empty", null],
  ["malformed", "duplex-malformed-frame"],
  ["invalid-utf8", "duplex-malformed-frame"],
  ["oversize", "duplex-frame-limit"],
  ["partial", "duplex-partial-frame"],
  ["flood", "duplex-output-limit"],
  ["stderr", "duplex-log-limit"],
]) {
  test(`D02 real ${mode} bounded framing`, async () => {
    const f = setup(mode, mode);
    try {
      const done = await f.runner.wait(f.lease, f.id);
      assert.equal(done.quiescent, true);
      assert.equal(done.record.duplex.failure, failure);
      assert.equal(done.record.result.outcome, failure ? "failed" : "success");
      assert.ok(done.record.duplex.frames.length <= limits.outputFrames);
      assert.ok(done.record.duplex.outputBytes <= limits.outputBytes);
      assert.ok(
        readFileSync(done.record.result.stdout).length <= f.spec.logBytes,
      );
      if (mode === "empty") assert.deepEqual(done.record.duplex.frames, []);
      if (mode === "multi")
        assert.deepEqual(done.record.duplex.frames, [{ a: "ü" }, { b: 2 }]);
    } finally {
      await stop(f);
    }
  });
}
test("D03 cancel with live owned descendant: no post-cancel write and slot survives until cleanup", async () => {
  const f = setup("cancel-descendant", "descendant");
  try {
    await until(() => existsSync(`${f.dir}/descendant.pid`));
    const pid = Number(readFileSync(`${f.dir}/descendant.pid`));
    f.store.cancel(f.lease.runId);
    assert.throws(
      () => f.runner.send(f.lease, f.id, "late", { late: true }),
      /cancelled/,
    );
    assert.throws(
      () =>
        apply(
          f.store,
          f.lease,
          result(f.store.coordinatorSnapshot(f.lease.runId)),
        ),
      /owned-commands-unquiesced/,
    );
    assert.ok(f.store.implementationSlot());
    const done = await f.runner.wait(f.lease, f.id);
    assert.equal(done.quiescent, true);
    assert.equal(done.record.result.outcome, "cancelled");
    await until(() => absent(pid));
    const settled = apply(
      f.store,
      f.lease,
      result(f.store.coordinatorSnapshot(f.lease.runId), {
        outcome: "interrupted",
        usage: { schema: 1, status: "unknown", reason: "local-transport-only" },
      }),
    );
    assert.equal(f.store.implementationSlot(), null);
    assert.equal(settled.budgets.reservedTokens, 0);
  } finally {
    await stop(f);
  }
});
test("D04 real blocked stdin leaves one bounded ambiguous write at deadline", async () => {
  const large = { ...limits, frameBytes: 524288, inputBytes: 1100000 };
  const f = setup("backpressure", "blocked-input", {}, large);
  try {
    await until(() => f.store.command(f.id).duplex.frames.length);
    f.runner.send(f.lease, f.id, "large-one", { text: "x".repeat(500000) });
    f.runner.send(f.lease, f.id, "large-two", { text: "x".repeat(500000) });
    assert.throws(
      () =>
        f.runner.send(f.lease, f.id, "overflow", { text: "x".repeat(500000) }),
      /input-limit/,
    );
    const blocked = await until(() => {
      const c = f.store.command(f.id);
      return (
        c.duplex.sends.some((s) => s.state === "writing" && s.attempted) && c
      );
    });
    assert.equal(
      blocked.duplex.sends.filter((s) => s.state === "writing").length,
      1,
    );
    const done = await f.runner.wait(f.lease, f.id);
    assert.equal(done.quiescent, true);
    assert.equal(done.record.result.outcome, "timeout");
    assert.equal(done.record.duplex.sends[0].state, "writing");
    assert.equal(done.record.duplex.sends[1].state, "queued");
    assert.ok(!existsSync(`${f.dir}/received`));
  } finally {
    await stop(f);
  }
});
test("D05 lease loss blocks fresh writes and actual supervisor cleans child", async () => {
  const f = setup("lease-loss", "hold");
  try {
    await until(() => f.store.command(f.id).duplex.frames.length);
    f.store.release(f.lease);
    const next = f.store.claim(f.lease.runId, "next", versions, 100000);
    assert.throws(
      () => f.runner.send(f.lease, f.id, "stale", {}),
      /stale-lease/,
    );
    assert.throws(
      () => f.runner.send(next, f.id, "new-owner", {}),
      /stale-slot-fence/,
    );
    const done = await until(() => {
      const c = f.store.command(f.id);
      return c.state === "finished" && c;
    });
    assert.equal(done.result.outcome, "lease-lost");
    assert.ok(f.store.implementationSlot());
  } finally {
    await stop(f);
  }
});
test("D06 supervisor death gives explicit recovery, surviving slot, no restarted invocation", async () => {
  const f = setup("supervisor-loss", "hold");
  try {
    await until(() => f.store.command(f.id).duplex.frames.length);
    const before = f.store.command(f.id);
    process.kill(before.supervisor.pid, "SIGKILL");
    await until(() => absent(before.supervisor.pid));
    const recovered = f.runner.commands.recover(f.lease, f.id);
    assert.equal(recovered.state, "recovery-required");
    assert.equal(f.runner.start(f.lease, f.action, f.spec, limits), f.id);
    assert.equal(f.store.commands(f.lease.runId).length, 1);
    assert.throws(
      () => f.runner.send(f.lease, f.id, "after-loss", {}),
      /not-running/,
    );
    assert.ok(f.store.implementationSlot());
    await until(() => absent(Number(readFileSync(`${f.dir}/target.pid`))));
  } finally {
    await stop(f);
  }
});
test("D07 outer rollback after real supervisor initiation cannot execute the target", async () => {
  const f = fixture("duplex-rollback", Date.now),
    runner = new DuplexRunner(f.store);
  apply(f.store, f.lease, { type: "schedule", kind: "baseline" });
  const action = f.store.coordinatorSnapshot(f.lease.runId).execution;
  const spec = {
    file: process.execPath,
    args: [join(process.cwd(), "tests/duplex-fixture.mjs"), "empty", f.dir],
    cwd: f.dir,
    outputDir: f.dir,
    timeoutMs: 1000,
    cleanupMs: 100,
    logBytes: 1024,
  };
  const spawned = [],
    original = childProcess.spawn;
  childProcess.spawn = (...args) => {
    const child = original(...args);
    spawned.push(child);
    return child;
  };
  syncBuiltinESMExports();
  let id;
  try {
    await assert.rejects(
      f.store.dispatchCoordinator(f.lease, action.key, {
        versions,
        capability: null,
        begin(a) {
          id = runner.start(f.lease, a, spec, limits);
          throw Error("after-synchronous-begin");
        },
        interrupt() {},
      }),
      /after-synchronous-begin/,
    );
  } finally {
    childProcess.spawn = original;
    syncBuiltinESMExports();
  }
  assert.equal(spawned.length, 1);
  const child = spawned[0];
  const [exitCode, signal] = await once(child, "exit");
  assert.equal(exitCode, 1);
  assert.equal(signal, null);
  assert.equal(f.store.command(id), undefined);
  assert.equal(f.store.duplexInvocation(action.key), undefined);
  assert.equal(existsSync(`${f.dir}/target.pid`), false);
  assert.equal(f.store.effect(action.key).state, "sending");
  assert.ok(f.store.implementationSlot());
  retain(f, {
    id,
    supervisorPid: child.pid,
    exitCode,
    signal,
    events: f.store.events(f.lease.runId),
  });
  f.store.close();
});

function reserved(name) {
  const f = fixture(`duplex-${name}`, Date.now),
    runner = new DuplexRunner(f.store);
  baseline(f);
  apply(f.store, f.lease, { type: "schedule", kind: "implement" });
  const action = f.store.coordinatorSnapshot(f.lease.runId).execution;
  const spec = {
    file: process.execPath,
    args: ["-e", "process.exit(1)"],
    cwd: f.dir,
    outputDir: f.dir,
    timeoutMs: 1000,
    cleanupMs: 100,
    logBytes: 1024,
  };
  const id = `reserved-${name}`,
    token = "synthetic-owned-test-capability";
  f.store
    .dispatchCoordinator(f.lease, action.key, {
      versions,
      capability,
      begin(a) {
        f.store.reserveCommand(f.lease, id, token, spec, {
          action: a,
          limits,
          request: { action: a, spec, limits },
        });
        return new Promise(() => {});
      },
      interrupt() {},
    })
    .catch((e) => {
      f.dispatchError = e;
    });
  assert.ok(f.store.command(id));
  return { ...f, runner, action, spec, id, token };
}
function reopen(f) {
  f.store.close();
  f.store = new Store(`${f.dir}/state.sqlite`);
  f.runner = new DuplexRunner(f.store);
}
for (const phase of ["reserved", "claimed", "attempted"])
  test(`D08 persisted crash/reopen at ${phase}, no automatic start/send replay and reservation retained`, () => {
    const f = reserved(phase);
    try {
      f.runner.send(f.lease, f.id, "stable", { synthetic: true });
      if (phase !== "reserved") f.store.claimDuplexSend(f.id, f.token);
      if (phase === "attempted")
        assert.throws(
          () =>
            f.store.writeDuplex(f.id, f.token, "stable", () => {
              writeFileSync(`${f.dir}/effect`, "ONE");
              throw Error("lost-callback");
            }),
          /lost-callback/,
        );
      reopen(f);
      assert.equal(f.runner.start(f.lease, f.action, f.spec, limits), f.id);
      const send = f.runner.send(f.lease, f.id, "stable", { synthetic: true });
      assert.equal(send.state, phase === "reserved" ? "queued" : "writing");
      if (phase !== "reserved")
        assert.throws(
          () => f.store.claimDuplexSend(f.id, f.token),
          /send-unknown/,
        );
      if (phase === "attempted") {
        assert.throws(
          () =>
            f.store.writeDuplex(f.id, f.token, "stable", () =>
              writeFileSync(`${f.dir}/effect`, "TWICE"),
            ),
          /send-unknown/,
        );
        assert.equal(readFileSync(`${f.dir}/effect`, "utf8"), "ONE");
      }
      assert.equal(
        f.runner.commands.recover(f.lease, f.id).state,
        "recovery-required",
      );
      assert.ok(f.store.implementationSlot());
      assert.equal(
        f.store.coordinatorSnapshot(f.lease.runId).budgets.reservedTokens,
        100,
      );
      retain(f, {
        record: f.store.command(f.id),
        snapshot: f.store.coordinatorSnapshot(f.lease.runId),
        events: f.store.events(f.lease.runId),
      });
    } finally {
      f.store.close();
    }
  });
for (const cause of [
  "cancel",
  "revoke",
  "fence",
  "input",
  "deadline",
  "versions",
])
  test(`D09 final per-write ${cause} guard prevents reserved side effect`, () => {
    const f = reserved(`guard-${cause}`);
    try {
      f.runner.send(f.lease, f.id, "one", {});
      f.store.claimDuplexSend(f.id, f.token);
      if (cause === "cancel") f.store.cancel(f.lease.runId);
      if (cause === "revoke") f.runner.interrupt(f.lease, f.action);
      if (cause === "fence") {
        f.store.release(f.lease);
        f.store.claim(f.lease.runId, "other", versions, 100000);
      }
      if (cause === "input") {
        const s = f.store.coordinatorSnapshot(f.lease.runId);
        apply(f.store, f.lease, {
          type: "revise",
          head: "head-next",
          checkPlan: s.checkPlan,
          scope: s.scope,
        });
      }
      if (cause === "deadline") {
        const now = Date.now();
        f.store.clock = () => f.action.deadline + 1;
        apply(f.store, f.lease, { type: "tick" });
        f.store.clock = () => now;
      }
      if (cause === "versions")
        apply(f.store, f.lease, {
          type: "incompatible",
          detail: "new incompatible worker",
        });
      assert.throws(
        () =>
          f.store.writeDuplex(f.id, f.token, "one", () =>
            writeFileSync(`${f.dir}/forbidden`, "BAD"),
          ),
        /cancelled|input-closed|stale-lease|no-longer-dispatchable|deadline-exceeded/,
      );
      assert.equal(existsSync(`${f.dir}/forbidden`), false);
      reopen(f);
      assert.equal(f.store.command(f.id).duplex.sends[0].state, "writing");
      assert.equal(f.store.command(f.id).duplex.sends[0].attempted, true);
      assert.ok(f.store.implementationSlot());
      assert.equal(
        f.store.coordinatorSnapshot(f.lease.runId).budgets.reservedTokens,
        100,
      );
      retain(f, {
        record: f.store.command(f.id),
        events: f.store.events(f.lease.runId),
      });
    } finally {
      f.store.close();
    }
  });
test("D10 real charged agent-shaped invocation: unknown completion retains full charge after actual local cleanup", async () => {
  const f = setup("charged", "empty", {}, limits, "implement");
  try {
    const done = await f.runner.wait(f.lease, f.id);
    assert.equal(done.quiescent, true);
    const s = apply(
      f.store,
      f.lease,
      result(f.store.coordinatorSnapshot(f.lease.runId), {
        outcome: "no_code",
        usage: {
          schema: 1,
          status: "unknown",
          reason: "synthetic child has no provider receipt",
        },
      }),
    );
    assert.equal(s.budgets.reservedTokens, 100);
    assert.equal(s.budgets.unknownActions, 1);
    assert.notEqual(s.stage, "handoff_ready");
    assert.deepEqual(s.unqualifiedResults, ["implement"]);
    assert.equal(f.store.implementationSlot(), null);
    reopen(f);
    assert.equal(
      f.store.coordinatorSnapshot(f.lease.runId).budgets.reservedTokens,
      100,
    );
  } finally {
    await stop(f);
  }
});
test("D11 real revocation before gate start blocks target even though supervisor was initiated", async () => {
  const f = setup("early-revoke", "empty");
  try {
    f.runner.interrupt(f.lease, f.action);
    const done = await f.runner.wait(f.lease, f.id);
    assert.equal(existsSync(`${f.dir}/target.pid`), false);
    assert.equal(done.quiescent, true);
    assert.ok(["cancelled", "failed"].includes(done.record.result.outcome));
  } finally {
    await stop(f);
  }
});

test("D12 group observation treats permission, timeout and malformed ps as unknown; only exact empty selection proves absence", async () => {
  const { groupAbsent } = await import("../dist/runner/process.js");
  if (process.platform !== "darwin") return;
  const original = childProcess.execFileSync,
    observations = [];
  try {
    for (const error of [
      { code: "EPERM", status: 1, stdout: "", stderr: "permission denied" },
      {
        code: "ETIMEDOUT",
        status: null,
        signal: "SIGTERM",
        stdout: "",
        stderr: "",
      },
      { status: 1, stdout: "partial", stderr: "" },
    ]) {
      childProcess.execFileSync = () => {
        throw error;
      };
      syncBuiltinESMExports();
      assert.throws(
        () => groupAbsent({ pid: process.pid, fingerprint: "synthetic" }),
        /observation-uncertain/,
      );
      observations.push({ error, absence: false });
    }
    childProcess.execFileSync = () => "garbage\n";
    syncBuiltinESMExports();
    assert.throws(
      () => groupAbsent({ pid: process.pid, fingerprint: "synthetic" }),
      /observation-uncertain/,
    );
    childProcess.execFileSync = () => `${process.pid} ${process.pid}\n`;
    syncBuiltinESMExports();
    assert.equal(
      groupAbsent({ pid: process.pid, fingerprint: "synthetic" }),
      false,
    );
    childProcess.execFileSync = () => {
      throw { status: 1, signal: null, stdout: "", stderr: "" };
    };
    syncBuiltinESMExports();
    assert.equal(
      groupAbsent({ pid: process.pid, fingerprint: "synthetic" }),
      true,
    );
  } finally {
    childProcess.execFileSync = original;
    syncBuiltinESMExports();
  }
  const f = reserved("uncertain-identity");
  try {
    f.store.observeCommand(f.id, f.token, {
      supervisor: { pid: process.pid, fingerprint: "not-this-process" },
      group: { pid: process.pid, fingerprint: "not-this-group" },
    });
    const c = f.runner.commands.recover(f.lease, f.id);
    assert.equal(c.state, "recovery-required");
    assert.ok(f.store.implementationSlot());
    assert.equal(c.duplex.stdoutEof, false);
    retain(f, { observations, record: c });
  } finally {
    f.store.close();
  }
});
test("D13 nested savepoint rollback is isolated but outer rollback undoes every nested reservation", () => {
  const f = fixture("duplex-savepoints", Date.now);
  try {
    f.store.guardedStart(f.lease, () => {
      assert.throws(
        () =>
          f.store.guardedStart(f.lease, () => {
            f.store.reserveCommand(f.lease, "rolled", "token", {});
            throw Error("inner");
          }),
        /inner/,
      );
      assert.equal(f.store.command("rolled"), undefined);
      f.store.reserveCommand(f.lease, "kept", "token", {});
    });
    assert.ok(f.store.command("kept"));
    assert.equal(
      f.store.events(f.lease.runId).filter((e) => e.kind === "command-reserved")
        .length,
      1,
    );
    retain(f, {
      record: f.store.command("kept"),
      events: f.store.events(f.lease.runId),
    });
  } finally {
    f.store.close();
  }
});

test("D14 exact previous schema4 reader creates preserved charged/cancelled outstanding records; refuses current schema7", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const ts = (await import("typescript")).default;
  const f = fixture("duplex-schema4", Date.now);
  f.store.close();
  const sourceCommit = "a2b565942859aa05655dac03d50fe8a090661a95";
  for (const path of [
    "store/index",
    "store/json",
    "config/index",
    "evidence/index",
    "coordinator/contracts",
    "coordinator/reducer",
    "coordinator/migration",
  ]) {
    const source = childProcess.execFileSync(
      "git",
      ["show", `${sourceCommit}:src/${path}.ts`],
      { encoding: "utf8" },
    );
    const output = `${f.dir}/previous/${path}.js`;
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(
      output,
      ts.transpileModule(source, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2023,
          module: ts.ModuleKind.ES2022,
        },
      }).outputText,
    );
  }
  const PreviousStore = (await import(`${f.dir}/previous/store/index.js`))
    .Store;
  f.store = new PreviousStore(`${f.dir}/schema4.sqlite`);
  f.store.admitCoordinator(admission());
  f.lease = f.store.claim("run-1", "old-owner", versions, 100000);
  baseline(f);
  apply(f.store, f.lease, { type: "schedule", kind: "implement" });
  f.store.reserveCommand(f.lease, "old-command", "old-token", {});
  f.store.cancel("run-1");
  const snapshot = (store) => ({
    run: store.get("run-1"),
    snapshot: store.coordinatorSnapshot("run-1"),
    commands: store.commands("run-1"),
    slot: store.implementationSlot(),
    events: store.events("run-1"),
  });
  const before = snapshot(f.store);
  f.store.close();
  const original = readFileSync(`${f.dir}/schema4.sqlite`);
  copyFileSync(`${f.dir}/schema4.sqlite`, `${f.dir}/upgraded.sqlite`);
  f.store = new Store(`${f.dir}/upgraded.sqlite`);
  const after = snapshot(f.store);
  assert.deepEqual(after, before);
  assert.equal(after.run.cancelled, true);
  assert.equal(after.snapshot.budgets.reservedTokens, 100);
  assert.ok(after.slot);
  assert.equal(after.commands[0].state, "starting");
  f.store.close();
  assert.deepEqual(readFileSync(`${f.dir}/schema4.sqlite`), original);
  assert.throws(
    () => new PreviousStore(`${f.dir}/upgraded.sqlite`),
    /incompatible-store-schema/,
  );
  const sql = new DatabaseSync(`${f.dir}/upgraded.sqlite`);
  assert.equal(sql.prepare("PRAGMA user_version").get().user_version, 8);
  sql.close();
  retain(f, {
    sourceCommit,
    before,
    after,
    oldReaderRejected: true,
    originalUnchanged: true,
  });
});

test("D15 real supervisor SIGKILL during a backpressured write survives reopen without restart or resend", async () => {
  const large = { ...limits, frameBytes: 524288, inputBytes: 1100000 };
  const f = setup("ambiguous-live-reopen", "blocked-input", {}, large);
  const payload = { text: "x".repeat(500000) };
  try {
    await until(() => f.store.command(f.id).duplex.frames.length);
    f.runner.send(f.lease, f.id, "ambiguous", payload);
    const before = await until(() => {
      const c = f.store.command(f.id);
      return (
        c.duplex.sends[0]?.state === "writing" &&
        c.duplex.sends[0].attempted &&
        c
      );
    });
    process.kill(before.supervisor.pid, "SIGKILL");
    await until(() => absent(before.supervisor.pid));
    await until(() => absent(Number(readFileSync(`${f.dir}/target.pid`))));
    reopen(f);
    assert.equal(f.runner.start(f.lease, f.action, f.spec, large), f.id);
    assert.equal(
      f.runner.send(f.lease, f.id, "ambiguous", payload).state,
      "writing",
    );
    assert.equal(f.store.command(f.id).duplex.sends.length, 1);
    const recovered = f.runner.commands.recover(f.lease, f.id);
    assert.equal(recovered.state, "recovery-required");
    assert.equal(f.store.commands(f.lease.runId).length, 1);
    assert.ok(f.store.implementationSlot());
    assert.equal(existsSync(`${f.dir}/received`), false);
    writeFileSync(`${f.dir}/before-loss.json`, JSON.stringify(before, null, 2));
  } finally {
    await stop(f);
  }
});
