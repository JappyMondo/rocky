import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  fixture,
  apply,
  versions,
  retain,
  coordinatorModule,
} from "./coordinator-support.mjs";
const { DuplexRunner } = coordinatorModule;
const limits = {
  frameBytes: 1024,
  inputBytes: 8192,
  outputBytes: 8192,
  inputFrames: 32,
  outputFrames: 32,
};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const v = fn();
    if (v) return v;
    await pause(10);
  }
  throw Error("condition-timeout");
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
function start(mode) {
  const f = fixture(`duplex-eof-${mode}`, Date.now),
    runner = new DuplexRunner(f.store);
  const spec = {
    file: process.execPath,
    args: [resolve("tests/duplex-eof-fixture.mjs"), mode, f.dir],
    cwd: f.dir,
    outputDir: f.dir,
    timeoutMs: 3000,
    cleanupMs: 100,
    logBytes: 8192,
  };
  apply(f.store, f.lease, { type: "schedule", kind: "baseline" });
  const action = f.store.coordinatorSnapshot(f.lease.runId).execution;
  let id;
  f.store
    .dispatchCoordinator(f.lease, action.key, {
      versions,
      capability: null,
      begin(a) {
        id = runner.start(f.lease, a, spec, limits);
        return new Promise(() => {});
      },
      interrupt(a) {
        runner.interrupt(f.lease, a);
      },
    })
    .catch((e) => {
      f.dispatchError = e;
    });
  assert.ok(id);
  return { ...f, runner, id, action };
}
for (const mode of [
  "partial-holder",
  "complete-holder",
  "complete",
  "cancel",
  "early-revoke",
])
  test(`EOF ${mode}: decoder provenance remains separate from physical cleanup`, async () => {
    const f = start(mode);
    let completion;
    try {
      if (mode === "early-revoke") f.runner.interrupt(f.lease, f.action);
      if (mode === "cancel") {
        await until(() => f.store.command(f.id).duplex.outputBytes > 0);
        f.store.cancel(f.lease.runId);
      }
      completion = await f.runner.wait(f.lease, f.id);
      // Always retain the rejected result before evaluating the assertions.
      retain(f, {
        module: process.env.COORDINATOR_TEST_MODULE ?? "../dist/index.js",
        mode,
        completion,
        events: f.store.events(f.lease.runId),
        snapshot: f.store.coordinatorSnapshot(f.lease.runId),
      });
      assert.equal(completion.quiescent, true);
      const c = completion.record;
      assert.equal(c.duplex.stdoutEof, true);
      assert.equal(c.duplex.stderrEof, true);
      if (mode.endsWith("holder")) {
        const direct = JSON.parse(readFileSync(`${f.dir}/direct.json`)),
          holder = JSON.parse(readFileSync(`${f.dir}/holder.json`));
        assert.equal(direct.pgid, c.group.pid);
        assert.equal(holder.pgid, c.group.pid);
        assert.equal(c.result.exitCode, 0);
        assert.equal(existsSync(`${f.dir}/holder-ignored-term`), true);
        await until(() => absent(holder.pid));
        assert.equal(
          readFileSync(c.result.stdout, "utf8"),
          mode === "partial-holder" ? '{"partial":' : '{"complete":true}\n',
        );
        assert.equal(
          c.duplex.outputBytes,
          Buffer.byteLength(readFileSync(c.result.stdout)),
        );
        assert.equal(c.result.outcome, "failed");
        assert.equal(c.duplex.failure, "duplex-stream-incomplete");
        assert.equal(c.duplex.decoderComplete, false);
        assert.equal(c.duplex.childStdoutEof, false);
      } else if (mode === "complete") {
        assert.equal(c.result.outcome, "success");
        assert.equal(c.duplex.failure, null);
        assert.equal(c.duplex.decoderComplete, true);
        assert.equal(c.duplex.childStdoutEof, true);
        assert.equal(c.duplex.childStderrEof, true);
        assert.deepEqual(c.duplex.frames, [{ complete: true }]);
      } else {
        assert.ok(["cancelled", "failed"].includes(c.result.outcome));
        if (mode === "early-revoke") {
          assert.equal(existsSync(`${f.dir}/direct.json`), false);
          assert.equal(c.duplex.decoderComplete, false);
          assert.equal(c.duplex.childStdoutEof, false);
        }
      }
      assert.ok(f.store.implementationSlot()); // A protocol-neutral cleanup never settles application state.
    } finally {
      if (!completion) {
        f.runner.interrupt(f.lease, f.action);
        completion = await f.runner.wait(f.lease, f.id);
        retain(f, { mode, completion });
      }
      f.store.close();
    }
  });
