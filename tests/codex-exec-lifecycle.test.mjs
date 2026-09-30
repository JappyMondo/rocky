// Taskbot #81 lifecycle tests: cancellation, deadline, physical quiescence, stdin consumption
// evidence, crash windows, post-run drift (incl. F5 trust persistence and C5 binary drift) and
// restart reconciliation (S05/S06/S07/S10; F06/F07/F08), driven by the owned fake CLI over REAL
// spawned processes and real SQLite stores. Test IDs L01–L14 are adapter lifecycle tests; they are
// NOT the frozen contract's live-subscription scenarios L01–L02, which remain unexecuted/blocked.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import childProcess from "node:child_process";
import {
  codexFixture,
  closeFixture,
  baselinePass,
  schedule,
  finalProposal,
  successScript,
  dispatchCodex,
  settleCodex,
  readReceipt,
  fakeRecord,
  writeMarker,
  waitForFile,
  alive,
  qualification,
  versions,
} from "./codex-exec-support.mjs";

async function until(fn, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("condition-timeout");
}
const writeSrc = { path: "output.txt", content: "bounded change\n" };

test("L01 cancellation is SIGTERM-only: death with NO terminal classifies interrupted/unknown, no interrupt ack, group descendants die, unrelated sentinel survives (F07/S05/S06)", async () => {
  const f = codexFixture("L01-cancel");
  const sentinel = childProcess.spawn(
    process.execPath,
    ["-e", "setInterval(()=>{},500)"],
    { detached: true, stdio: "ignore" },
  );
  sentinel.unref();
  try {
    baselinePass(f);
    const action = schedule(f, "implement");
    const { plan, pending } = dispatchCodex(f, action, {
      script: [
        { thread: {} },
        { turnStarted: {} },
        { spawn: "group" },
        { marker: "fake-ready" },
        { sleep: 15000 },
      ],
    });
    await waitForFile(join(plan.paths.parentTmp, "fake-ready"));
    const descendant = Number(
      readFileSync(join(plan.paths.parentTmp, "fake-descendant.pid"), "utf8"),
    );
    assert.ok(alive(fakeRecord(plan).pid));
    // Cancellation persists first; the supervisor then SIGTERMs the owned group.
    f.store.cancel(f.lease.runId);
    f.adapter.interrupt(action);
    const snapshot = await settleCodex(f, action, pending);
    const command = f.store.commands(f.lease.runId).at(-1);
    const receipt = readReceipt(plan, command.id);
    assert.equal(receipt.settlement.classification, "interrupted");
    assert.equal(receipt.settlement.outcome, "interrupted");
    assert.match(receipt.settlement.detail, /cancelled-late-result-ignored/);
    assert.equal(receipt.usage.status, "unknown");
    // The owned group was SIGTERMed and died with NO terminal frame: interrupted/unknown, never
    // success. The cancelled-cleanup path drops the late child-exit message, so the receipt records
    // the classification + revocation, not a fabricated signal; the exact SIGTERM->exit mapping is
    // pinned native behavior gated by N07, never claimed from fake evidence.
    assert.ok([null, "SIGTERM"].includes(receipt.lifecycle.signal));
    assert.equal(command.result.outcome, "cancelled");
    assert.equal(receipt.result.final, null);
    assert.equal(receipt.lifecycle.stdoutEof, true);
    assert.equal(receipt.lifecycle.stderrEof, true);
    assert.equal(receipt.lifecycle.quiescent, true);
    assert.equal(receipt.stream.revoked, true);
    await until(() => !alive(descendant));
    assert.equal(alive(sentinel.pid), true);
    assert.equal(snapshot.stage, "cancelled");
    assert.equal(snapshot.execution, null);
    assert.equal(f.store.implementationSlot(), null);
    // No interrupt acknowledgement was ever claimed: the durable effect receipt IS the interrupted
    // result, and the prompt send never gained a second attempt.
    const effect = f.store.effect(action.key);
    assert.equal(effect.state, "confirmed");
    assert.equal(effect.receipt.outcome, "interrupted");
    assert.equal(
      receipt.stream.sends.filter((s) => s.key.endsWith(":prompt")).length,
      1,
    );
  } finally {
    try {
      process.kill(sentinel.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
    await closeFixture(f);
  }
});

test("L02 a late terminal after cancel is ignored; an ignored SIGTERM escalates to bounded SIGKILL (F07/S05)", async () => {
  const f = codexFixture("L02-late");
  try {
    baselinePass(f);
    const action = schedule(f, "implement");
    // The fake ignores the first SIGTERM, emits a FULL turn.completed afterwards and exits 143.
    const { plan, pending } = dispatchCodex(f, action, {
      script: [
        { thread: {} },
        { turnStarted: {} },
        { marker: "fake-ready" },
        {
          sigtermLate: {
            frames: [
              {
                type: "turn.completed",
                usage: {
                  input_tokens: 1200,
                  cached_input_tokens: 800,
                  cache_write_input_tokens: 100,
                  output_tokens: 340,
                  reasoning_output_tokens: 40,
                },
              },
            ],
            exitCode: 143,
          },
        },
        { waitFile: "never-appears", timeoutMs: 15000 },
      ],
    });
    await waitForFile(join(plan.paths.parentTmp, "fake-ready"));
    f.store.cancel(f.lease.runId);
    f.adapter.interrupt(action);
    const snapshot = await settleCodex(f, action, pending);
    const command = f.store.commands(f.lease.runId).at(-1);
    const receipt = readReceipt(plan, command.id);
    // The attempt stays interrupted with unknown usage; no head is ever adopted from a post-cancel
    // terminal, whatever reached the raw log.
    assert.equal(receipt.settlement.classification, "interrupted");
    assert.equal(receipt.usage.status, "unknown");
    assert.equal(snapshot.head, "head-1");
    assert.equal(snapshot.stage, "cancelled");
  } finally {
    await closeFixture(f);
  }
  // Ignored SIGTERM escalates to SIGKILL for the owned group only.
  const g = codexFixture("L02-sigkill");
  try {
    baselinePass(g);
    const action = schedule(g, "implement");
    const { plan, pending } = dispatchCodex(g, action, {
      script: [
        { thread: {} },
        { ignoreSigterm: true },
        { marker: "fake-ready" },
        { sleep: 15000 },
      ],
    });
    await waitForFile(join(plan.paths.parentTmp, "fake-ready"));
    const childPid = fakeRecord(plan).pid;
    g.adapter.interrupt(action);
    const snapshot = await settleCodex(g, action, pending);
    const command = g.store.commands(g.lease.runId).at(-1);
    const receipt = readReceipt(plan, command.id);
    assert.equal(receipt.settlement.classification, "interrupted");
    assert.equal(command.result.outcome, "cancelled");
    assert.equal(receipt.usage.status, "unknown");
    assert.equal(snapshot.stage, "recovery_required");
    assert.equal(snapshot.blocker?.kind, "recovery");
    // The bounded TERM->KILL escalation is proven physically; no interrupt ack was ever claimed.
    await until(() => !alive(childPid));
  } finally {
    await closeFixture(g);
  }
});

test("L03 the original action deadline stops the run with reserved cleanup time and never restarts (F07/S05)", async () => {
  const f = codexFixture("L03-deadline", { actionElapsedMs: 4000 });
  try {
    baselinePass(f);
    const action = schedule(f, "implement");
    const { plan, pending } = dispatchCodex(f, action, {
      script: [{ thread: {} }, { marker: "fake-ready" }, { sleep: 20000 }],
    });
    await waitForFile(join(plan.paths.parentTmp, "fake-ready"));
    const snapshot = await settleCodex(f, action, pending);
    const command = f.store.commands(f.lease.runId).at(-1);
    const receipt = readReceipt(plan, command.id);
    assert.equal(receipt.settlement.classification, "interrupted");
    assert.match(receipt.settlement.detail, /deadline-exceeded/);
    assert.equal(receipt.usage.status, "unknown");
    // The ORIGINAL deadline is retained unchanged in the receipt; it never restarted.
    assert.equal(receipt.attempt.deadline, action.deadline);
    assert.equal(command.result.outcome, "timeout");
    assert.equal(snapshot.blocker?.kind, "budget");
    assert.equal(snapshot.blocker?.detail, "action-deadline-exceeded");
  } finally {
    await closeFixture(f);
  }
});

test("L04 stdin consumption: exact bytes once + one EOF; exit-before-read and silent buffering stay attempted-unknown with no resend (F06/S06)", async () => {
  // Exact bytes: a prompt with newlines, Unicode, quotes, shell metacharacters and JSON-looking text
  // arrives byte-identical exactly once, one EOF, no shell interpretation.
  const f = codexFixture("L04-exact");
  const pwnCanary = `/tmp/codex81-pwn-${process.pid}-${Date.now()}`;
  try {
    baselinePass(f);
    const action = schedule(f, "implement");
    const proposal = finalProposal(action, "implementer");
    const script = successScript(proposal, { writeSrc });
    script.note = `new\nlines 'quotes' "dq" $(touch ${pwnCanary}) \`id\` ; rm -rf / ü 世界 {json:1}`;
    const { plan, pending } = dispatchCodex(f, action, script);
    const snapshot = await settleCodex(f, action, pending);
    assert.equal(snapshot.blocker, null);
    const record = fakeRecord(plan);
    const promptBytes = Buffer.from(JSON.stringify(script), "utf8");
    assert.equal(record.stdin.bytes, promptBytes.length);
    assert.equal(record.stdin.sha256, plan.bundle.input.sha256);
    assert.equal(record.stdin.eofCount, 1);
    assert.deepEqual(
      readFileSync(join(plan.paths.parentTmp, "fake-stdin.log")),
      promptBytes,
    );
    // No shell interpretation happened: the metacharacters never created their side effect.
    assert.equal(existsSync(pwnCanary), false);
    const command = f.store.commands(f.lease.runId).at(-1);
    const receipt = readReceipt(plan, command.id);
    assert.equal(receipt.stream.sends.length, 2);
    assert.deepEqual(
      receipt.stream.sends.map((s) => [s.end, s.state, s.attempted]),
      [
        [false, "written", true],
        [true, "written", true],
      ],
    );
  } finally {
    await closeFixture(f);
  }
  // Exit before reading stdin: no thread.started is observed, so the attempt stays attempted-unknown
  // — no resend, no success — whether the write EPIPEd or disappeared into the pipe buffer (F9).
  const h = codexFixture("L04-exit-before-read");
  try {
    baselinePass(h);
    const action = schedule(h, "implement");
    const prompt = JSON.stringify({ script: [{ thread: {} }, { exit: 0 }] });
    const plan = h.adapter.prepareLaunch(action, { prompt });
    writeFileSync(
      join(plan.paths.parentTmp, "fake-scenario.json"),
      JSON.stringify({ readStdin: false, script: [{ exit: 1 }] }),
    );
    const pending = h.store.dispatchCoordinator(h.lease, action.key, h.adapter);
    const snapshot = await settleCodex(h, action, pending);
    const command = h.store.commands(h.lease.runId).at(-1);
    const receipt = readReceipt(plan, command.id);
    assert.equal(receipt.threadIdentity.threadStartedObserved, false);
    assert.equal(receipt.threadIdentity.threadId, null);
    assert.ok(
      receipt.gaps.some(
        (gap) => gap.gate === "S06" && /attempted-unknown/.test(gap.gap),
      ),
    );
    assert.equal(receipt.settlement.classification, "unresolved");
    assert.equal(receipt.settlement.outcome, "interrupted");
    assert.equal(receipt.usage.status, "unknown");
    assert.equal(snapshot.blocker?.kind, "recovery");
    const record = fakeRecord(plan);
    assert.equal(record.stdin.eofCount, 0);
    assert.equal(record.stdin.bytes, 0);
    assert.equal(
      receipt.stream.sends.filter((s) => s.key.endsWith(":prompt")).length,
      1,
    );
    const promptSend = receipt.stream.sends.find((s) =>
      s.key.endsWith(":prompt"),
    );
    assert.ok(["queued", "writing", "written"].includes(promptSend.state));
    if (promptSend.state !== "queued") assert.equal(promptSend.attempted, true);
  } finally {
    await closeFixture(h);
  }
  // Silent buffering: the fake never reads and never exits; the deadline stops the run while the
  // prompt write stays attempted (pipe-buffered) with no thread.started and no resend.
  const k = codexFixture("L04-silent-buffer", { actionElapsedMs: 4000 });
  try {
    baselinePass(k);
    const action = schedule(k, "implement");
    const prompt = JSON.stringify({ script: [{ thread: {} }] });
    const plan = k.adapter.prepareLaunch(action, { prompt });
    writeFileSync(
      join(plan.paths.parentTmp, "fake-scenario.json"),
      JSON.stringify({ readStdin: false, script: [{ sleep: 20000 }] }),
    );
    const pending = k.store.dispatchCoordinator(k.lease, action.key, k.adapter);
    const snapshot = await settleCodex(k, action, pending);
    const command = k.store.commands(k.lease.runId).at(-1);
    const receipt = readReceipt(plan, command.id);
    assert.equal(receipt.threadIdentity.threadStartedObserved, false);
    assert.equal(receipt.settlement.classification, "interrupted");
    assert.match(receipt.settlement.detail, /deadline-exceeded/);
    assert.equal(receipt.usage.status, "unknown");
    assert.equal(snapshot.blocker?.kind, "budget");
    const record = fakeRecord(plan);
    assert.equal(record.stdin.bytes, 0);
    assert.equal(record.stdin.eofCount, 0);
  } finally {
    await closeFixture(k);
  }
});

test("L05 an escaped stderr-holding descendant keeps the stream unfinalized: never transport success (F07/S05)", async () => {
  const f = codexFixture("L05-escaped");
  let escapedPid = null;
  try {
    baselinePass(f);
    const action = schedule(f, "implement");
    const proposal = finalProposal(action, "implementer");
    const { plan, pending } = dispatchCodex(
      f,
      action,
      successScript(proposal, {
        afterTurn: [{ spawn: "escaped-stderr" }],
        writeSrc,
      }),
    );
    const snapshot = await settleCodex(f, action, pending);
    escapedPid = Number(
      readFileSync(join(plan.paths.parentTmp, "fake-escaped.pid"), "utf8"),
    );
    const command = f.store.commands(f.lease.runId).at(-1);
    const receipt = readReceipt(plan, command.id);
    // A complete-looking success stream is NOT accepted: the child stderr EOF never arrived, so
    // stdout content alone did not establish cleanup.
    assert.equal(receipt.settlement.classification, "unresolved");
    assert.match(
      receipt.settlement.detail,
      /transport-failure:duplex-stream-incomplete/,
    );
    assert.equal(receipt.lifecycle.childStderrEof, false);
    assert.equal(receipt.lifecycle.stdoutEof, true);
    assert.equal(receipt.lifecycle.stderrEof, true);
    assert.equal(receipt.usage.status, "unknown");
    assert.equal(snapshot.head, "head-1");
    assert.equal(snapshot.blocker?.kind, "recovery");
  } finally {
    if (escapedPid) {
      try {
        process.kill(escapedPid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    await closeFixture(f);
  }
});

test("L06 post-run discovery drift makes the result stale/unknown, never success (F06/F08/S10)", async () => {
  // A staged-tree instruction file appears during the run (planted by the fake itself).
  const f = codexFixture("L06-tree-drift");
  try {
    baselinePass(f);
    const action = schedule(f, "implement");
    const proposal = finalProposal(action, "implementer");
    const { plan, pending } = dispatchCodex(
      f,
      action,
      successScript(proposal, {
        afterTurn: [{ writeSrc: { path: "AGENTS.md", content: "hostile\n" } }],
        writeSrc: { path: "work.txt", content: "w\n" },
      }),
    );
    const snapshot = await settleCodex(f, action, pending);
    const command = f.store.commands(f.lease.runId).at(-1);
    const receipt = readReceipt(plan, command.id);
    assert.equal(receipt.settlement.classification, "unresolved");
    assert.match(receipt.settlement.detail, /discovery-drift/);
    assert.ok(
      receipt.discovery.drift.some((d) =>
        d.startsWith("staged-agents-files-appeared"),
      ),
    );
    assert.equal(receipt.usage.status, "unknown");
    assert.equal(snapshot.head, "head-1");
    assert.equal(snapshot.blocker?.kind, "recovery");
  } finally {
    await closeFixture(f);
  }
  // A system/managed layer appears during the run (paused via marker/waitFile).
  const g = codexFixture("L06-system-drift");
  try {
    baselinePass(g);
    const action = schedule(g, "implement");
    const proposal = finalProposal(action, "implementer");
    const { plan, pending } = dispatchCodex(
      g,
      action,
      successScript(proposal, {
        afterTurn: [
          { marker: "mid-run" },
          { waitFile: "resume", timeoutMs: 15000 },
        ],
        writeSrc,
      }),
    );
    await waitForFile(join(plan.paths.parentTmp, "mid-run"));
    writeFileSync(join(g.discoveryRoot, "managed_config.toml"), "x=1");
    writeMarker(plan, "resume");
    const snapshot = await settleCodex(g, action, pending);
    const command = g.store.commands(g.lease.runId).at(-1);
    const receipt = readReceipt(plan, command.id);
    assert.equal(receipt.settlement.classification, "unresolved");
    assert.ok(
      receipt.discovery.drift.some((d) => d.startsWith("system-presence")),
    );
    assert.equal(snapshot.head, "head-1");
  } finally {
    await closeFixture(g);
  }
  // The effective global AGENTS digest changes during the run.
  const h = codexFixture("L06-agents-drift");
  try {
    baselinePass(h);
    const action = schedule(h, "implement");
    const proposal = finalProposal(action, "implementer");
    const { plan, pending } = dispatchCodex(
      h,
      action,
      successScript(proposal, {
        afterTurn: [
          { marker: "mid-run" },
          { waitFile: "resume", timeoutMs: 15000 },
        ],
        writeSrc,
      }),
    );
    await waitForFile(join(plan.paths.parentTmp, "mid-run"));
    writeFileSync(join(h.codexHome, "AGENTS.override.md"), "mutated global\n");
    writeMarker(plan, "resume");
    const snapshot = await settleCodex(h, action, pending);
    const command = h.store.commands(h.lease.runId).at(-1);
    const receipt = readReceipt(plan, command.id);
    assert.equal(receipt.settlement.classification, "unresolved");
    assert.ok(
      receipt.discovery.drift.some((d) =>
        d.startsWith("global-agents-digest-changed"),
      ),
    );
    assert.equal(snapshot.head, "head-1");
  } finally {
    await closeFixture(h);
  }
});

test("L07 owner crash after synchronous begin rolls back: zero fake launch, effect stays sending, no blind retry (F06/S06)", async () => {
  const f = codexFixture("L07-rollback");
  const spawned = [];
  const original = childProcess.spawn;
  try {
    baselinePass(f);
    const action = schedule(f, "implement");
    const proposal = finalProposal(action, "implementer");
    childProcess.spawn = (...args) => {
      const child = original(...args);
      spawned.push(child);
      return child;
    };
    syncBuiltinESMExports();
    let settlePromise;
    await assert.rejects(
      f.store.dispatchCoordinator(f.lease, action.key, {
        versions,
        capability: null,
        qualification,
        begin(a) {
          f.adapter.prepareLaunch(a, {
            prompt: JSON.stringify(successScript(proposal, { writeSrc })),
          });
          settlePromise = f.adapter.begin(a);
          settlePromise.catch(() => {});
          throw new Error("owner-crash-after-synchronous-begin");
        },
        interrupt(a) {
          f.adapter.interrupt(a);
        },
      }),
      /owner-crash-after-synchronous-begin/,
    );
    // Only the supervisor was initiated; it exits on its own missing-row check, so the fake CLI
    // never launches.
    assert.equal(spawned.length, 1);
    const [exitCode] = await once(spawned[0], "exit");
    assert.equal(exitCode, 1);
    await assert.rejects(settlePromise, /command-not-found/);
    assert.equal(f.store.commands(f.lease.runId).length, 0);
    assert.equal(f.store.duplexInvocation(action.key), undefined);
    const plan = f.adapter.plan(action.key);
    assert.equal(
      existsSync(join(plan.paths.parentTmp, "fake-record.json")),
      false,
    );
    assert.equal(f.store.effect(action.key).state, "sending");
    assert.ok(f.store.implementationSlot());
    // A second dispatch refuses: no blind retry after an ambiguous start.
    await assert.rejects(
      f.store.dispatchCoordinator(f.lease, action.key, f.adapter),
      /reconciliation-required/,
    );
  } finally {
    childProcess.spawn = original;
    syncBuiltinESMExports();
    await closeFixture(f);
  }
});

test("L08 durable text-send intent across crash/reopen: reserved/claimed/attempted never resend (F06/S06)", async () => {
  for (const phase of ["reserved", "claimed", "attempted"]) {
    const f = codexFixture(`L08-${phase}`);
    try {
      baselinePass(f);
      const action = schedule(f, "implement");
      const id = `codex-reserved-${phase}`;
      const token = "synthetic-owned-test-capability";
      const spec = {
        file: f.binary.path,
        args: ["exec"],
        cwd: f.dir,
        timeoutMs: 5000,
        cleanupMs: 250,
        logBytes: 8192,
        outputDir: join(f.artifactRoot, "reserved-out"),
      };
      const { mkdirSync } = await import("node:fs");
      mkdirSync(spec.outputDir, { recursive: true });
      const limits = {
        frameBytes: 4096,
        inputBytes: 4096,
        outputBytes: 8192,
        inputFrames: 2,
        outputFrames: 32,
      };
      const dispatch = f.store.dispatchCoordinator(f.lease, action.key, {
        versions,
        capability: null,
        qualification,
        begin(a) {
          f.store.reserveCommand(f.lease, id, token, spec, {
            action: a,
            limits,
            request: { action: a, spec, limits },
          });
          return new Promise(() => {});
        },
        interrupt() {},
      });
      dispatch.catch(() => {});
      assert.ok(f.store.command(id));
      const promptText = "exact prompt bytes — ü\n";
      f.store.queueDuplexText(f.lease, id, "prompt", promptText);
      if (phase !== "reserved") f.store.claimDuplexSend(id, token);
      if (phase === "attempted")
        assert.throws(
          () =>
            f.store.writeDuplex(id, token, "prompt", () => {
              writeFileSync(join(f.dir, "side-effect"), "ONE");
              throw new Error("owner-crash-mid-write");
            }),
          /owner-crash-mid-write/,
        );
      // Reopen exactly like a restarted owner.
      const path = f.store.path;
      f.store.close();
      const { Store, CommandRunner } = await import("../dist/index.js");
      f.store = new Store(path, Date.now);
      const again = f.store.queueDuplexText(f.lease, id, "prompt", promptText);
      assert.equal(again.state, phase === "reserved" ? "queued" : "writing");
      assert.throws(
        () => f.store.queueDuplexText(f.lease, id, "prompt", "different bytes"),
        /duplex-send-conflict/,
      );
      // Raw text is exact: no JSON framing or trailing newline is added.
      assert.equal(again.wire, promptText);
      if (phase !== "reserved")
        assert.throws(
          () => f.store.claimDuplexSend(id, token),
          /duplex-send-unknown/,
        );
      if (phase === "attempted") {
        assert.throws(
          () =>
            f.store.writeDuplex(id, token, "prompt", () =>
              writeFileSync(join(f.dir, "side-effect"), "TWICE"),
            ),
          /duplex-send-unknown/,
        );
        assert.equal(readFileSync(join(f.dir, "side-effect"), "utf8"), "ONE");
      }
      const recovered = new CommandRunner(f.store).recover(f.lease, id);
      assert.equal(recovered.state, "recovery-required");
      assert.equal(f.store.commands(f.lease.runId).length, 1);
      assert.ok(f.store.implementationSlot());
    } finally {
      await closeFixture(f);
    }
  }
});

test("L09 supervisor loss mid-run: reconcile to recovery-required, no relaunch, capacity stays fenced (F07/S05)", async () => {
  const f = codexFixture("L09-supervisor-loss");
  try {
    baselinePass(f);
    const action = schedule(f, "implement");
    const { plan, pending } = dispatchCodex(f, action, {
      script: [{ thread: {} }, { marker: "fake-ready" }, { sleep: 20000 }],
    });
    await waitForFile(join(plan.paths.parentTmp, "fake-ready"));
    const before = f.store.command(f.store.duplexInvocation(action.key).id);
    const supervisorPid = before.supervisor.pid;
    const childPid = fakeRecord(plan).pid;
    process.kill(supervisorPid, "SIGKILL");
    await until(() => !alive(supervisorPid));
    const snapshot = await settleCodex(f, action, pending);
    await until(() => !alive(childPid));
    const command = f.store.commands(f.lease.runId).at(-1);
    assert.equal(command.state, "recovery-required");
    assert.equal(snapshot.blocker?.kind, "recovery");
    assert.equal(snapshot.blocker?.detail, "execution-not-quiescent");
    assert.ok(f.store.implementationSlot());
    assert.equal(snapshot.execution?.key, action.key);
    await assert.rejects(
      f.store.dispatchCoordinator(f.lease, action.key, f.adapter),
      /reconciliation-required|action-no-longer-dispatchable/,
    );
    assert.equal(f.store.commands(f.lease.runId).length, 1);
  } finally {
    await closeFixture(f);
  }
});

test("L10 duplicate and late results with the same action identity never re-execute or double-count (F06/S06)", async () => {
  const f = codexFixture("L10-duplicates");
  try {
    baselinePass(f);
    const action = schedule(f, "implement");
    const proposal = finalProposal(action, "implementer");
    const { plan, pending } = dispatchCodex(
      f,
      action,
      successScript(proposal, { writeSrc }),
    );
    const snapshot = await settleCodex(f, action, pending);
    const reported = snapshot.budgets.harnessReportedTokens;
    assert.equal(reported, 1540);
    const settledResult = f.store.effect(action.key).receipt;
    // An identical retry under a NEW inbox id replays without spending or changing anything.
    f.store.ingestCoordinator(
      f.lease.runId,
      "transport",
      `duplicate/${action.key}`,
      settledResult,
    );
    const replayed = f.store.applyCoordinator(
      f.lease,
      f.store.coordinatorSnapshot(f.lease.runId).revision,
      "transport",
      `duplicate/${action.key}`,
    );
    assert.equal(replayed.revision, snapshot.revision);
    assert.equal(replayed.budgets.harnessReportedTokens, reported);
    assert.equal(replayed.stage, snapshot.stage);
    // A CHANGED payload under the same inbox identity is rejected outright.
    assert.throws(
      () =>
        f.store.ingestCoordinator(
          f.lease.runId,
          "transport",
          `duplicate/${action.key}`,
          { ...settledResult, detail: "forged-late-result" },
        ),
      /inbox-payload-conflict/,
    );
    // A conflicting settled result for the same action is rejected.
    f.store.ingestCoordinator(
      f.lease.runId,
      "transport",
      `conflict/${action.key}`,
      { ...settledResult, detail: "conflicting-outcome" },
    );
    assert.throws(
      () =>
        f.store.applyCoordinator(
          f.lease,
          f.store.coordinatorSnapshot(f.lease.runId).revision,
          "transport",
          `conflict/${action.key}`,
        ),
      /action-result-conflict/,
    );
    void plan;
  } finally {
    await closeFixture(f);
  }
});

test("L11 lease loss mid-run settles as interrupted; ingestion survives but applying requires the current lease (S05/S06)", async () => {
  const f = codexFixture("L11-lease-loss");
  try {
    baselinePass(f);
    const action = schedule(f, "implement");
    const { plan, pending } = dispatchCodex(f, action, {
      script: [{ thread: {} }, { marker: "fake-ready" }, { sleep: 20000 }],
    });
    await waitForFile(join(plan.paths.parentTmp, "fake-ready"));
    // Handoff only after the supervisor has durably published the running command. The
    // fake-ready marker proves the child is live; this row is the lease observer's boundary.
    const id = f.store.duplexInvocation(action.key).id;
    await until(() => {
      const c = f.store.command(id);
      return c.state === "running" && c.supervisor && c.group;
    });
    f.store.release(f.lease);
    f.store.claim(f.lease.runId, "next-owner", versions, 1000000);
    const command = await until(() => {
      const c = f.store.command(id);
      return c.state === "finished" && c;
    });
    assert.equal(command.result.outcome, "lease-lost");
    await pending;
    // The stale lease cannot APPLY the result: publication stays with the current owner.
    assert.throws(
      () =>
        f.store.applyCoordinator(
          f.lease,
          f.store.coordinatorSnapshot(f.lease.runId).revision,
          "transport",
          `result/${action.key}`,
        ),
      /stale-lease/,
    );
    const receipt = readReceipt(plan, command.id);
    assert.equal(receipt.settlement.classification, "interrupted");
    assert.match(receipt.settlement.detail, /lease-lost/);
    assert.equal(receipt.usage.status, "unknown");
  } finally {
    await closeFixture(f);
  }
});

test("L12 restart reconciliation: prepareLaunch is idempotent, a live invocation is observation-only and a changed bundle conflicts (F06/S06)", async () => {
  const f = codexFixture("L12-restart");
  try {
    baselinePass(f);
    const action = schedule(f, "implement");
    const proposal = finalProposal(action, "implementer");
    const prompt = JSON.stringify(
      successScript(proposal, {
        afterTurn: [
          { marker: "fake-ready" },
          { waitFile: "resume", timeoutMs: 20000 },
        ],
        writeSrc,
      }),
    );
    const plan = f.adapter.prepareLaunch(action, { prompt });
    const pending = f.store.dispatchCoordinator(f.lease, action.key, f.adapter);
    await waitForFile(join(plan.paths.parentTmp, "fake-ready"));
    // A restarted owner re-prepares the SAME action: identical bundle, same run tree, frozen plan.
    const plan2 = f.adapter.prepareLaunch(action, { prompt });
    assert.equal(plan2, plan);
    assert.equal(plan2.paths.runRoot, plan.paths.runRoot);
    // Begin again while the first invocation lives: observation only — one command row, the durable
    // sends keep their state and are never resent.
    const id = f.store.duplexInvocation(action.key).id;
    const settle2 = f.adapter.begin(action);
    assert.equal(f.store.duplexInvocation(action.key).id, id);
    assert.equal(f.store.commands(f.lease.runId).length, 1);
    assert.equal(
      f.store.command(id).duplex.sends.filter((s) => s.end).length,
      1,
    );
    writeMarker(plan, "resume");
    const snapshot = await settleCodex(f, action, pending);
    const second = await settle2;
    assert.equal(second.type, "result");
    assert.equal(second.actionKey, action.key);
    assert.equal(second.outcome, "changed");
    assert.equal(snapshot.stage, "verifying");
    assert.equal(snapshot.budgets.harnessReportedTokens, 1540);
    // A conflicting re-prepare (changed prompt bytes) for the same action is refused.
    assert.throws(
      () => f.adapter.prepareLaunch(action, { prompt: `${prompt} ` }),
      /codex-plan-conflict/,
    );
  } finally {
    await closeFixture(f);
  }
});

test("L13 trust persistence: the post-run shared config.toml byte check detects mutation → unresolved/unknown; the untrusted override prevents it in the fake env (F05/S01/S10)", async () => {
  // (a) Detection: a mid-run mutation of the shared config.toml (as native trust persistence would
  // cause) is caught by the post-run byte check and makes the result stale/unknown.
  const f = codexFixture("L13-detect");
  try {
    baselinePass(f);
    const action = schedule(f, "implement");
    const proposal = finalProposal(action, "implementer");
    const { plan, pending } = dispatchCodex(
      f,
      action,
      successScript(proposal, {
        afterTurn: [
          { marker: "mid-run" },
          { waitFile: "resume", timeoutMs: 15000 },
        ],
        writeSrc,
      }),
    );
    await waitForFile(join(plan.paths.parentTmp, "mid-run"));
    // Simulate the native trust-persistence write into the shared config.toml mid-run.
    writeFileSync(
      join(f.codexHome, "config.toml"),
      '[projects."/staged"]\ntrust_level = "trusted"\n',
    );
    writeMarker(plan, "resume");
    const snapshot = await settleCodex(f, action, pending);
    const command = f.store.commands(f.lease.runId).at(-1);
    const receipt = readReceipt(plan, command.id);
    assert.equal(receipt.settlement.classification, "unresolved");
    assert.match(receipt.settlement.detail, /discovery-drift/);
    assert.ok(
      receipt.discovery.drift.some((d) =>
        d.startsWith("shared-config-toml-mutated"),
      ),
    );
    assert.equal(receipt.trustPersistence.unchanged, false);
    assert.equal(receipt.usage.status, "unknown");
    assert.equal(snapshot.head, "head-1");
    assert.equal(snapshot.blocker?.kind, "recovery");
  } finally {
    await closeFixture(f);
  }
  // (b) Prevention: on a normal run the explicit untrusted override for the canonical staged root is
  // present and the shared config.toml stays byte-identical (the fake never persists trust). Native
  // proof that codex itself does not persist trust under the override is gated N01.
  const g = codexFixture("L13-prevent");
  try {
    baselinePass(g);
    const action = schedule(g, "implement");
    const proposal = finalProposal(action, "implementer");
    const before = readFileSync(join(g.codexHome, "config.toml"));
    const { plan, pending } = dispatchCodex(
      g,
      action,
      successScript(proposal, { writeSrc }),
    );
    const snapshot = await settleCodex(g, action, pending);
    const command = g.store.commands(g.lease.runId).at(-1);
    const receipt = readReceipt(plan, command.id);
    assert.equal(receipt.settlement.classification, "complete");
    // The untrusted override targets the canonical staged root exactly.
    const projects = plan.overrideAssignments.find((a) =>
      a.startsWith("projects="),
    );
    assert.ok(projects.includes(plan.paths.src));
    assert.ok(projects.includes('trust_level"="untrusted"'));
    // The shared config.toml is byte-identical after the run; no drift, success stands.
    assert.deepEqual(readFileSync(join(g.codexHome, "config.toml")), before);
    assert.equal(receipt.trustPersistence.unchanged, true);
    assert.equal(receipt.trustPersistence.projectlessTree, true);
    assert.deepEqual(receipt.discovery.drift, []);
    assert.equal(snapshot.blocker, null);
  } finally {
    await closeFixture(g);
  }
});

test("L14 C5 binary-identity drift: a mid-run binary mutation is caught at settlement → unresolved/unknown, never success (S01/S10)", async () => {
  const f = codexFixture("L14-c5-drift");
  try {
    baselinePass(f);
    const action = schedule(f, "implement");
    const proposal = finalProposal(action, "implementer");
    const { plan, pending } = dispatchCodex(
      f,
      action,
      successScript(proposal, {
        afterTurn: [
          { marker: "mid-run" },
          { waitFile: "resume", timeoutMs: 15000 },
        ],
        writeSrc,
      }),
    );
    await waitForFile(join(plan.paths.parentTmp, "mid-run"));
    // One-byte drift of the pinned binary AFTER C1 spawn but BEFORE C5 settlement re-measurement.
    writeFileSync(
      f.binary.path,
      Buffer.concat([readFileSync(f.binary.path), Buffer.from("\n")]),
    );
    writeMarker(plan, "resume");
    const snapshot = await settleCodex(f, action, pending);
    const command = f.store.commands(f.lease.runId).at(-1);
    const receipt = readReceipt(plan, command.id);
    assert.equal(receipt.settlement.classification, "unresolved");
    assert.ok(
      receipt.discovery.drift.some((d) =>
        d.startsWith("binary-identity-drift-c5"),
      ),
    );
    assert.equal(
      receipt.binary.measuredC5.sha256 !== receipt.binary.measuredC0.sha256,
      true,
    );
    assert.equal(receipt.usage.status, "unknown");
    assert.equal(snapshot.head, "head-1");
    assert.equal(snapshot.blocker?.kind, "recovery");
  } finally {
    await closeFixture(f);
  }
});
