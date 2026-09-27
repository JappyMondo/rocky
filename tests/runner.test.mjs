import test from "node:test";
import assert from "node:assert/strict";
import { spawn, fork, execFileSync } from "node:child_process";
import { once } from "node:events";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { CommandRunner } from "../dist/index.js";
import { fixture, versions, save, pause, until } from "./helpers.mjs";
function alive(pid) {
  try {
    const s = execFileSync("/bin/ps", ["-p", String(pid), "-o", "stat="], {
      encoding: "utf8",
    }).trim();
    return s && !s.startsWith("Z");
  } catch {
    return false;
  }
}
function spec(dir, extra = []) {
  return {
    file: process.execPath,
    args: ["tests/command-fixture.mjs", dir + "/descendant.pid", ...extra],
    cwd: process.cwd(),
    outputDir: dir,
    timeoutMs: 150,
    cleanupMs: 100,
    logBytes: 256,
  };
}
test("F07 real timeout retains markers, bounded output and kills owned descendant only", async () => {
  const { dir, store } = fixture("F07");
  const lease = store.claim("synthetic-001", "A", versions, 500);
  const runner = new CommandRunner(store);
  const sentinel = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    stdio: "ignore",
  });
  try {
    const record = await runner.run(lease, spec(dir, ["flood"]));
    const result = record.result;
    assert.equal(result.outcome, "timeout");
    assert.ok(readFileSync(result.stdout, "utf8").includes("UNIQUE-STDOUT"));
    assert.ok(readFileSync(result.stderr, "utf8").includes("UNIQUE-STDERR"));
    assert.ok(readFileSync(result.stdout).length <= 256);
    assert.equal(result.stdoutTruncated, true);
    assert.equal(result.stderrTruncated, true);
    const descendant = Number(readFileSync(dir + "/descendant.pid"));
    await until(() => !alive(descendant), 2000);
    assert.ok(alive(sentinel.pid));
    save(dir, "result", {
      record,
      descendantAlive: alive(descendant),
      sentinelAlive: alive(sentinel.pid),
    });
  } finally {
    sentinel.kill("SIGKILL");
    await once(sentinel, "exit");
    store.close();
  }
});
test("F05 cancellation stops real command and blocks subsequent start", async () => {
  const { dir, store } = fixture("F05-command");
  const lease = store.claim("synthetic-001", "A", versions, 500);
  const runner = new CommandRunner(store);
  const id = runner.start(lease, { ...spec(dir), timeoutMs: 5000 });
  const waiting = runner.wait(lease, id);
  await until(() => existsSync(dir + "/descendant.pid"));
  store.cancel(lease.runId);
  const record = await waiting;
  assert.equal(record.result.outcome, "cancelled");
  const descendant = Number(readFileSync(dir + "/descendant.pid"));
  await until(() => !alive(descendant), 2000);
  assert.throws(() => runner.start(lease, spec(dir)), /cancelled/);
  assert.ok(
    readFileSync(record.result.stdout, "utf8").includes("UNIQUE-STDOUT"),
  );
  save(dir, "cancelled", { record, events: store.events(lease.runId) });
  store.close();
});
test("F08 worker SIGKILL triggers supervised cleanup after expiry and no duplicate launch", async () => {
  const { dir, store } = fixture("F08");
  writeFileSync(dir + "/unpublished.txt", "UNPUBLISHED");
  const worker = fork("tests/worker.mjs", ["command", store.path, dir], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const [{ id }] = await once(worker, "message");
  await until(() => existsSync(dir + "/descendant.pid"));
  worker.kill("SIGKILL");
  await once(worker, "exit");
  await pause(550);
  const lease = store.claim("synthetic-001", "recovery", versions, 2000);
  const runner = new CommandRunner(store);
  const recovered = runner.recover(lease, id);
  assert.ok(["running", "finished"].includes(recovered.state));
  if (recovered.state !== "finished")
    assert.throws(
      () => runner.start(lease, spec(dir)),
      /command-recovery-required/,
    );
  const record = await until(() => {
    const c = store.command(id);
    return c.state === "finished" && c;
  }, 2000);
  assert.equal(record.result.outcome, "lease-lost");
  await until(
    () => !alive(Number(readFileSync(dir + "/descendant.pid"))),
    2000,
  );
  assert.equal(readFileSync(dir + "/unpublished.txt", "utf8"), "UNPUBLISHED");
  save(dir, "recovery", {
    recovered,
    record,
    events: store.events(lease.runId),
  });
  store.close();
});
test("F08 unknown process identity preserves sentinel and requires recovery", () => {
  const { dir, store } = fixture("F08-uncertain");
  const lease = store.claim("synthetic-001", "A", versions, 1000);
  store.reserveCommand(lease, "uncertain", "token", {});
  store.observeCommand("uncertain", "token", {
    supervisor: { pid: process.pid, fingerprint: "not-this-process" },
    group: { pid: process.pid, fingerprint: "not-this-process" },
  });
  const recovered = new CommandRunner(store).recover(lease, "uncertain");
  assert.equal(recovered.state, "recovery-required");
  assert.ok(alive(process.pid));
  assert.throws(
    () => new CommandRunner(store).start(lease, spec(dir)),
    /command-recovery-required/,
  );
  save(dir, "uncertain", recovered);
  store.close();
});
test("successful short command reports success separately from timeout", async () => {
  const { dir, store } = fixture("success");
  const lease = store.claim("synthetic-001", "A", versions, 500);
  const record = await new CommandRunner(store).run(lease, {
    ...spec(dir),
    file: process.execPath,
    args: ["-e", 'console.log("success-marker")'],
    timeoutMs: 1000,
  });
  assert.equal(record.result.outcome, "success");
  assert.equal(record.result.exitCode, 0);
  store.close();
});

test("supervisor death kills its gated group and preserves partial logs for recovery", async () => {
  const { dir, store } = fixture("supervisor-death");
  const lease = store.claim("synthetic-001", "A", versions, 1000);
  const runner = new CommandRunner(store);
  const id = runner.start(lease, { ...spec(dir), timeoutMs: 5000 });
  await until(() => existsSync(dir + "/descendant.pid"));
  const running = store.command(id);
  // The fixture creates descendant.pid before emitting stdout. Kill only after
  // observing bytes whose survival this test is intended to verify.
  await until(() =>
    readFileSync(running.spec.outputDir + "/stdout.log", "utf8").includes(
      "UNIQUE-STDOUT",
    ),
  );
  process.kill(running.supervisor.pid, "SIGKILL");
  await until(() => !alive(running.supervisor.pid));
  const recovered = runner.recover(lease, id);
  assert.equal(recovered.state, "recovery-required");
  await until(
    () => !alive(Number(readFileSync(dir + "/descendant.pid"))),
    2000,
  );
  assert.ok(
    readFileSync(running.spec.outputDir + "/stdout.log", "utf8").includes(
      "UNIQUE-STDOUT",
    ),
  );
  save(dir, "supervisor-death", { running, recovered });
  store.close();
});
