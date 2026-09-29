// Taskbot #97 lifecycle tests: CC05/CC09/CC12 cancellation, deadline, physical quiescence,
// stdin consumption evidence, crash windows and post-run discovery drift (F04/F12/F13/F14),
// driven by the owned fake CLI over REAL spawned processes and real SQLite stores.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import childProcess from "node:child_process";
import {
  claudeFixture,
  closeFixture,
  baselinePass,
  schedule,
  finalProposal,
  successScript,
  dispatchClaude,
  settleClaude,
  readReceipt,
  fakeRecord,
  writeMarker,
  waitForFile,
  alive,
  qualification,
  versions,
} from "./claude-code-support.mjs";

async function pause(ms) {
  await new Promise((r) => setTimeout(r, ms));
}
async function until(fn, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = fn();
    if (value) return value;
    await pause(20);
  }
  throw new Error("condition-timeout");
}

test("L01 cancellation is SIGTERM-only: death by signal with NO result classifies unknown, no interrupt ack is claimed, group descendants die and unrelated sentinels survive (F12/CC09)", async () => {
  const f = claudeFixture("L01-cancel");
  // An unrelated sentinel process outside the owned group must survive the cleanup.
  const sentinel = childProcess.spawn(
    process.execPath,
    ["-e", "setInterval(()=>{},500)"],
    { detached: true, stdio: "ignore" },
  );
  sentinel.unref();
  try {
    baselinePass(f);
    const action = schedule(f, "implement");
    const { plan, pending } = dispatchClaude(f, action, {
      script: [
        { init: {} },
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
    const snapshot = await settleClaude(f, action, pending);
    const command = f.store.commands(f.lease.runId).at(-1);
    const receipt = readReceipt(plan, command.id);
    assert.equal(receipt.settlement.classification, "interrupted");
    assert.equal(receipt.settlement.outcome, "interrupted");
    assert.match(receipt.settlement.detail, /cancelled-late-result-ignored/);
    assert.equal(receipt.usage.status, "unknown");
    // The owned group was SIGTERMed and died with NO result frame: unknown, never success.
    // The cancelled-cleanup path deliberately drops the late child-exit message (the durable
    // outcome is `cancelled`), so the receipt records the classification and revocation rather
    // than a fabricated signal detail; the exact SIGTERM->143 mapping is pinned native CLI
    // behavior gated by N05, never claimed from fake evidence.
    assert.ok([null, "SIGTERM"].includes(receipt.lifecycle.signal));
    assert.equal(command.result.outcome, "cancelled");
    assert.equal(receipt.result.fields, null);
    // EOFs and quiescence are recorded separately from the exit.
    assert.equal(receipt.lifecycle.stdoutEof, true);
    assert.equal(receipt.lifecycle.stderrEof, true);
    assert.equal(receipt.lifecycle.quiescent, true);
    assert.equal(receipt.stream.revoked, true);
    // The in-group descendant was killed; the unrelated sentinel survived.
    await until(() => !alive(descendant));
    assert.equal(alive(sentinel.pid), true);
    // Snapshot: cancelled run; the interrupted result settled execution; the slot released.
    assert.equal(snapshot.stage, "cancelled");
    assert.equal(snapshot.execution, null);
    assert.equal(f.store.implementationSlot(), null);
    // No interrupt acknowledgement was ever claimed: the durable effect receipt is the
    // interrupted result itself, and the prompt send never gained a second attempt.
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

test("L02 a late result after cancel is ignored, and an ignored SIGTERM escalates to bounded SIGKILL (F12/CC09)", async () => {
  const f = claudeFixture("L02-late-result");
  try {
    baselinePass(f);
    const action = schedule(f, "implement");
    // The fake ignores the first SIGTERM, emits a FULL success result afterwards and exits 143.
    const { plan, pending } = dispatchClaude(f, action, {
      script: [
        { init: {} },
        { sigtermLate: { frames: ["$result"], exitCode: 143 } },
        { marker: "fake-ready" },
        { waitFile: "never-appears", timeoutMs: 15000 },
      ],
    });
    await waitForFile(join(plan.paths.parentTmp, "fake-ready"));
    f.store.cancel(f.lease.runId);
    f.adapter.interrupt(action);
    const snapshot = await settleClaude(f, action, pending);
    const command = f.store.commands(f.lease.runId).at(-1);
    const receipt = readReceipt(plan, command.id);
    // The late success result reached the raw log but is IGNORED: the attempt stays interrupted
    // with unknown usage; no head is ever adopted from a post-cancel result.
    const raw = readFileSync(command.result.stdout, "utf8");
    assert.ok(raw.includes('"type":"result"'));
    assert.equal(receipt.settlement.classification, "interrupted");
    assert.equal(receipt.usage.status, "unknown");
    assert.equal(snapshot.head, "head-1");
    assert.equal(snapshot.stage, "cancelled");
  } finally {
    await closeFixture(f);
  }
  // Ignored SIGTERM escalates to SIGKILL for the owned group only.
  const g = claudeFixture("L02-sigkill");
  try {
    baselinePass(g);
    const action = schedule(g, "implement");
    const { plan, pending } = dispatchClaude(g, action, {
      script: [
        { init: {} },
        { ignoreSigterm: true },
        { marker: "fake-ready" },
        { sleep: 15000 },
      ],
    });
    await waitForFile(join(plan.paths.parentTmp, "fake-ready"));
    const childPid = fakeRecord(plan).pid;
    g.adapter.interrupt(action);
    const snapshot = await settleClaude(g, action, pending);
    const command = g.store.commands(g.lease.runId).at(-1);
    const receipt = readReceipt(plan, command.id);
    assert.equal(receipt.settlement.classification, "interrupted");
    assert.equal(command.result.outcome, "cancelled");
    assert.equal(receipt.usage.status, "unknown");
    assert.equal(snapshot.stage, "recovery_required");
    assert.equal(snapshot.blocker?.kind, "recovery");
    // The bounded TERM->KILL escalation is proven physically: the SIGTERM-ignoring child is
    // dead after cleanup, and no interrupt acknowledgement was ever claimed.
    await until(() => !alive(childPid));
  } finally {
    await closeFixture(g);
  }
});

test("L03 the original action deadline stops the run with reserved cleanup time and never restarts (F12/CC09)", async () => {
  const f = claudeFixture("L03-deadline", { actionElapsedMs: 4000 });
  try {
    baselinePass(f);
    const action = schedule(f, "implement");
    const { plan, pending } = dispatchClaude(f, action, {
      script: [{ init: {} }, { marker: "fake-ready" }, { sleep: 20000 }],
    });
    await waitForFile(join(plan.paths.parentTmp, "fake-ready"));
    const snapshot = await settleClaude(f, action, pending);
    const command = f.store.commands(f.lease.runId).at(-1);
    const receipt = readReceipt(plan, command.id);
    assert.equal(receipt.settlement.classification, "interrupted");
    assert.match(receipt.settlement.detail, /deadline-exceeded/);
    assert.equal(receipt.usage.status, "unknown");
    // The ORIGINAL deadline is retained unchanged in the receipt; it never restarted.
    assert.equal(receipt.attempt.deadline, action.deadline);
    assert.equal(command.result.outcome, "timeout");
    // The reducer's deadline high-water check classifies the exhausted original deadline as a
    // budget blocker; the adapter detail keeps the interrupted classification reason.
    assert.equal(snapshot.blocker?.kind, "budget");
    assert.equal(snapshot.blocker?.detail, "action-deadline-exceeded");
  } finally {
    await closeFixture(f);
  }
});

test("L04 stdin consumption: exact bytes once plus one EOF; exit-before-read and silent buffering stay attempted-unknown with no resend (F04/CC05)", async () => {
  // Exact bytes: a prompt with newlines, Unicode, quotes, shell metacharacters and JSON-looking
  // text arrives byte-identical exactly once, with a single EOF and no shell interpretation.
  const f = claudeFixture("L04-exact");
  const pwnCanary = `/tmp/claude97-pwn-${process.pid}-${Date.now()}`;
  try {
    baselinePass(f);
    const action = schedule(f, "implement");
    const proposal = finalProposal(action, "implementer");
    const script = successScript(proposal, {
      writeSrc: { path: "exact.txt", content: "exact\n" },
    });
    script.note = `new\nlines 'quotes' "dq" $(touch ${pwnCanary}) \`id\` ; rm -rf / ü 世界 {json:1}`;
    const { plan, pending } = dispatchClaude(f, action, script);
    const snapshot = await settleClaude(f, action, pending);
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
    // Exactly one prompt send plus one EOF send, both attempted exactly once; never a resend.
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
  // Exit before reading stdin: no init is observed, so the attempt stays attempted-unknown —
  // no resend, no success — whether the write EPIPEd or disappeared into the pipe buffer.
  const h = claudeFixture("L04-exit-before-read");
  try {
    baselinePass(h);
    const action = schedule(h, "implement");
    // Prepare first (creates PT), plant the marker scenario, then dispatch: the fake exits(1)
    // WITHOUT ever attaching a stdin reader.
    const prompt = JSON.stringify({ script: [{ init: {} }, { exit: 0 }] });
    const plan = h.adapter.prepareLaunch(action, { prompt });
    writeFileSync(
      join(plan.paths.parentTmp, "fake-scenario.json"),
      JSON.stringify({ readStdin: false, script: [{ exit: 1 }] }),
    );
    const pending = h.store.dispatchCoordinator(h.lease, action.key, h.adapter);
    const snapshot = await settleClaude(h, action, pending);
    const command = h.store.commands(h.lease.runId).at(-1);
    const receipt = readReceipt(plan, command.id);
    // No init: consumption unproven. Interrupted/unknown, never success, never a resend.
    assert.equal(receipt.initIdentity, null);
    assert.ok(
      receipt.gaps.some(
        (gap) => gap.gate === "CC05" && /attempted-unknown/.test(gap.gap),
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
    // Depending on the exit race the write was attempted (writing/written) or never claimed
    // (queued); in every case it is attempted at most once and never resent.
    assert.ok(["queued", "writing", "written"].includes(promptSend.state));
    if (promptSend.state !== "queued") assert.equal(promptSend.attempted, true);
  } finally {
    await closeFixture(h);
  }
  // Silent buffering: the fake never reads and never exits; the deadline stops the run while the
  // prompt write stays attempted (pipe-buffered) with no init and no resend.
  const k = claudeFixture("L04-silent-buffer", { actionElapsedMs: 4000 });
  try {
    baselinePass(k);
    const action = schedule(k, "implement");
    const prompt = JSON.stringify({ script: [{ init: {} }] });
    const plan = k.adapter.prepareLaunch(action, { prompt });
    writeFileSync(
      join(plan.paths.parentTmp, "fake-scenario.json"),
      JSON.stringify({ readStdin: false, script: [{ sleep: 20000 }] }),
    );
    const pending = k.store.dispatchCoordinator(k.lease, action.key, k.adapter);
    const snapshot = await settleClaude(k, action, pending);
    const command = k.store.commands(k.lease.runId).at(-1);
    const receipt = readReceipt(plan, command.id);
    assert.equal(receipt.initIdentity, null);
    assert.equal(receipt.settlement.classification, "interrupted");
    assert.match(receipt.settlement.detail, /deadline-exceeded/);
    assert.equal(receipt.usage.status, "unknown");
    assert.equal(snapshot.blocker?.kind, "budget");
    assert.equal(snapshot.blocker?.detail, "action-deadline-exceeded");
    const record = fakeRecord(plan);
    assert.equal(record.stdin.bytes, 0);
    assert.equal(record.stdin.eofCount, 0);
  } finally {
    await closeFixture(k);
  }
});

test("L05 an escaped stderr-holding descendant keeps the stream unfinalized: never transport success, capacity settles through recovery (F09/F12)", async () => {
  const f = claudeFixture("L05-escaped");
  let escapedPid = null;
  try {
    baselinePass(f);
    const action = schedule(f, "implement");
    const proposal = finalProposal(action, "implementer");
    const { plan, pending } = dispatchClaude(
      f,
      action,
      successScript(proposal, {
        afterInit: [{ spawn: "escaped-stderr" }],
        writeSrc: { path: "esc.txt", content: "esc\n" },
      }),
    );
    const snapshot = await settleClaude(f, action, pending);
    escapedPid = Number(
      readFileSync(join(plan.paths.parentTmp, "fake-escaped.pid"), "utf8"),
    );
    const command = f.store.commands(f.lease.runId).at(-1);
    const receipt = readReceipt(plan, command.id);
    // A complete-looking success stream is NOT accepted: the child stderr EOF never arrived,
    // so stdout content alone did not establish cleanup.
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

test("L06 post-run discovery drift makes the result stale/unknown, never success (F13/CC04)", async () => {
  // A staged-tree instruction file appears during the run (planted by the fake itself).
  const f = claudeFixture("L06-tree-drift");
  try {
    baselinePass(f);
    const action = schedule(f, "implement");
    const proposal = finalProposal(action, "implementer");
    const { plan, pending } = dispatchClaude(
      f,
      action,
      successScript(proposal, {
        afterInit: [{ writeSrc: { path: "AGENTS.md", content: "hostile\n" } }],
        writeSrc: { path: "work.txt", content: "w\n" },
      }),
    );
    const snapshot = await settleClaude(f, action, pending);
    const command = f.store.commands(f.lease.runId).at(-1);
    const receipt = readReceipt(plan, command.id);
    assert.equal(receipt.settlement.classification, "unresolved");
    assert.match(receipt.settlement.detail, /discovery-drift/);
    assert.ok(
      receipt.discovery.drift.some((d) =>
        d.startsWith("instruction-files-appeared"),
      ),
    );
    assert.equal(receipt.usage.status, "unknown");
    assert.equal(snapshot.head, "head-1");
    assert.equal(snapshot.blocker?.kind, "recovery");
  } finally {
    await closeFixture(f);
  }
  // The dedicated configDir gains settings.json during the run: the children-name set check
  // runs even when hashes are unavailable.
  const g = claudeFixture("L06-cfg-drift");
  try {
    baselinePass(g);
    const action = schedule(g, "implement");
    const proposal = finalProposal(action, "implementer");
    const { plan, pending } = dispatchClaude(
      g,
      action,
      successScript(proposal, {
        afterInit: [
          { marker: "mid-run" },
          { waitFile: "resume", timeoutMs: 15000 },
        ],
        writeSrc: { path: "cfg.txt", content: "c\n" },
      }),
    );
    await waitForFile(join(plan.paths.parentTmp, "mid-run"));
    writeFileSync(join(g.configDir, "settings.json"), "{}");
    writeMarker(plan, "resume");
    const snapshot = await settleClaude(g, action, pending);
    const command = g.store.commands(g.lease.runId).at(-1);
    const receipt = readReceipt(plan, command.id);
    assert.equal(receipt.settlement.classification, "unresolved");
    assert.ok(
      receipt.discovery.drift.some((d) => d.startsWith("config-dir-gained")),
    );
    assert.equal(snapshot.head, "head-1");
    assert.equal(snapshot.blocker?.kind, "recovery");
  } finally {
    await closeFixture(g);
  }
  // A managed layer appears during the run.
  const h = claudeFixture("L06-managed-drift");
  try {
    baselinePass(h);
    const action = schedule(h, "implement");
    const proposal = finalProposal(action, "implementer");
    const { plan, pending } = dispatchClaude(
      h,
      action,
      successScript(proposal, {
        afterInit: [
          { marker: "mid-run" },
          { waitFile: "resume", timeoutMs: 15000 },
        ],
        writeSrc: { path: "m.txt", content: "m\n" },
      }),
    );
    await waitForFile(join(plan.paths.parentTmp, "mid-run"));
    writeFileSync(join(h.discoveryRoot, "managed-settings.json"), "{}");
    writeMarker(plan, "resume");
    const snapshot = await settleClaude(h, action, pending);
    const command = h.store.commands(h.lease.runId).at(-1);
    const receipt = readReceipt(plan, command.id);
    assert.equal(receipt.settlement.classification, "unresolved");
    assert.ok(
      receipt.discovery.drift.some((d) => d.startsWith("managed-presence")),
    );
    assert.equal(snapshot.head, "head-1");
  } finally {
    await closeFixture(h);
  }
  // A server-managed cache (remote-settings.json) appears in the dedicated configDir.
  const k = claudeFixture("L06-remote-drift");
  try {
    baselinePass(k);
    const action = schedule(k, "implement");
    const proposal = finalProposal(action, "implementer");
    const { plan, pending } = dispatchClaude(
      k,
      action,
      successScript(proposal, {
        afterInit: [
          { marker: "mid-run" },
          { waitFile: "resume", timeoutMs: 15000 },
        ],
        writeSrc: { path: "r.txt", content: "r\n" },
      }),
    );
    await waitForFile(join(plan.paths.parentTmp, "mid-run"));
    writeFileSync(join(k.configDir, "remote-settings.json"), "{}");
    writeMarker(plan, "resume");
    const snapshot = await settleClaude(k, action, pending);
    const command = k.store.commands(k.lease.runId).at(-1);
    const receipt = readReceipt(plan, command.id);
    assert.ok(
      receipt.discovery.drift.some((d) =>
        d.startsWith("server-managed-presence"),
      ),
    );
    assert.equal(snapshot.head, "head-1");
  } finally {
    await closeFixture(k);
  }
});

test("L07 owner crash after synchronous begin rolls back: zero fake launch, effect stays sending, no blind retry (F14/CC12)", async () => {
  const f = claudeFixture("L07-rollback");
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
            prompt: JSON.stringify(successScript(proposal)),
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
    // Only the supervisor was initiated; it exits on its own missing-row check, so the fake
    // CLI never launches.
    assert.equal(spawned.length, 1);
    const [exitCode] = await once(spawned[0], "exit");
    assert.equal(exitCode, 1);
    // The rolled-back start leaves no command row, so the settle observation rejects honestly
    // instead of manufacturing a result for a start that never durably existed.
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

test("L08 durable text-send intent across crash/reopen: reserved/claimed/attempted never resend (F14/CC05)", async () => {
  for (const phase of ["reserved", "claimed", "attempted"]) {
    const f = claudeFixture(`L08-${phase}`);
    try {
      baselinePass(f);
      const action = schedule(f, "implement");
      const id = `claude-reserved-${phase}`;
      const token = "synthetic-owned-test-capability";
      const spec = {
        file: f.binary.path,
        args: ["-p"],
        cwd: f.dir,
        timeoutMs: 5000,
        cleanupMs: 250,
        logBytes: 8192,
        outputDir: join(f.artifactRoot, "reserved-out"),
      };
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
      // The identical queued text returns its prior state; a conflicting payload is rejected.
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
      // Recovery is explicit; the reservation and slot survive; nothing relaunched.
      const recovered = new CommandRunner(f.store).recover(f.lease, id);
      assert.equal(recovered.state, "recovery-required");
      assert.equal(f.store.commands(f.lease.runId).length, 1);
      assert.ok(f.store.implementationSlot());
    } finally {
      await closeFixture(f);
    }
  }
});

test("L09 supervisor loss mid-run: reconcile to recovery-required, no relaunch, capacity stays fenced (F12/F14)", async () => {
  const f = claudeFixture("L09-supervisor-loss");
  try {
    baselinePass(f);
    const action = schedule(f, "implement");
    const { plan, pending } = dispatchClaude(f, action, {
      script: [{ init: {} }, { marker: "fake-ready" }, { sleep: 20000 }],
    });
    await waitForFile(join(plan.paths.parentTmp, "fake-ready"));
    const before = f.store.command(f.store.duplexInvocation(action.key).id);
    const supervisorPid = before.supervisor.pid;
    const childPid = fakeRecord(plan).pid;
    process.kill(supervisorPid, "SIGKILL");
    await until(() => !alive(supervisorPid));
    const snapshot = await settleClaude(f, action, pending);
    // The gate's disconnect handler kills the owned group: the fake child cannot survive.
    await until(() => !alive(childPid));
    const command = f.store.commands(f.lease.runId).at(-1);
    assert.equal(command.state, "recovery-required");
    assert.equal(snapshot.blocker?.kind, "recovery");
    assert.equal(snapshot.blocker?.detail, "execution-not-quiescent");
    // Execution ownership stays fenced: the slot survives an unquiescent interruption.
    assert.ok(f.store.implementationSlot());
    assert.equal(snapshot.execution?.key, action.key);
    // A second dispatch refuses (no blind relaunch); the invocation row stays singular.
    await assert.rejects(
      f.store.dispatchCoordinator(f.lease, action.key, f.adapter),
      /reconciliation-required|action-no-longer-dispatchable/,
    );
    assert.equal(f.store.commands(f.lease.runId).length, 1);
  } finally {
    await closeFixture(f);
  }
});

test("L10 duplicate and late results with the same action identity never re-execute or double-count (F14)", async () => {
  const f = claudeFixture("L10-duplicates");
  try {
    baselinePass(f);
    const action = schedule(f, "implement");
    const proposal = finalProposal(action, "implementer");
    const { plan, pending } = dispatchClaude(
      f,
      action,
      successScript(proposal, {
        writeSrc: { path: "dup.txt", content: "d\n" },
      }),
    );
    const snapshot = await settleClaude(f, action, pending);
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

test("L11 lease loss mid-run settles as interrupted; ingestion survives but applying requires the current lease (CC09/CC12)", async () => {
  const f = claudeFixture("L11-lease-loss");
  try {
    baselinePass(f);
    const action = schedule(f, "implement");
    const { plan, pending } = dispatchClaude(f, action, {
      script: [{ init: {} }, { marker: "fake-ready" }, { sleep: 20000 }],
    });
    await waitForFile(join(plan.paths.parentTmp, "fake-ready"));
    f.store.release(f.lease);
    f.store.claim(f.lease.runId, "next-owner", versions, 1000000);
    const command = await until(() => {
      const c = f.store.command(f.store.duplexInvocation(action.key).id);
      return c.state === "finished" && c;
    });
    assert.equal(command.result.outcome, "lease-lost");
    // Ingestion survives lease loss; the interrupted result is durable...
    await pending;
    // ...but the stale lease cannot APPLY it: publication stays with the current owner.
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

test("L12 restart reconciliation: prepareLaunch is idempotent, a live invocation is observation-only and a changed bundle conflicts (F14/CC12)", async () => {
  const f = claudeFixture("L12-restart");
  try {
    baselinePass(f);
    const action = schedule(f, "implement");
    const proposal = finalProposal(action, "implementer");
    const prompt = JSON.stringify(
      successScript(proposal, {
        afterInit: [
          { marker: "fake-ready" },
          { waitFile: "resume", timeoutMs: 20000 },
        ],
        writeSrc: { path: "restart.txt", content: "r\n" },
      }),
    );
    const plan = f.adapter.prepareLaunch(action, { prompt });
    const pending = f.store.dispatchCoordinator(f.lease, action.key, f.adapter);
    await waitForFile(join(plan.paths.parentTmp, "fake-ready"));
    // A restarted owner re-prepares the SAME action: identical bundle, same run tree, and the
    // frozen plan (including its original deadline arithmetic) is returned unchanged.
    const plan2 = f.adapter.prepareLaunch(action, { prompt });
    assert.equal(plan2, plan);
    assert.equal(plan2.paths.runRoot, plan.paths.runRoot);
    // Begin again while the first invocation lives: observation only — one command row, the
    // durable sends keep their state and are never resent.
    const id = f.store.duplexInvocation(action.key).id;
    const settle2 = f.adapter.begin(action);
    assert.equal(f.store.duplexInvocation(action.key).id, id);
    assert.equal(f.store.commands(f.lease.runId).length, 1);
    assert.equal(
      f.store.command(id).duplex.sends.filter((s) => s.end).length,
      1,
    );
    writeMarker(plan, "resume");
    const snapshot = await settleClaude(f, action, pending);
    const second = await settle2;
    assert.equal(second.type, "result");
    assert.equal(second.actionKey, action.key);
    assert.equal(second.outcome, "changed");
    assert.equal(snapshot.stage, "verifying");
    assert.equal(snapshot.budgets.harnessReportedTokens, 1540);
    // A conflicting re-prepare (changed prompt bytes) for the same action is refused.
    assert.throws(
      () => f.adapter.prepareLaunch(action, { prompt: `${prompt} ` }),
      /claude-plan-conflict/,
    );
  } finally {
    await closeFixture(f);
  }
});
