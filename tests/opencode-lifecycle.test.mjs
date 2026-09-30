// Taskbot #98 lifecycle tests: cancellation, deadline, physical quiescence, stdin consumption
// evidence, restart reconciliation and post-run drift, driven by the owned fake CLI over REAL
// spawned processes and real SQLite stores (#104 research F23/F24, PART 4 §1/§4; FK4/FK7/FK8).
// Signal semantics themselves are G-SIG (unprobed native behavior): cancellation is SIGTERM-only
// via the owned supervisor group, exit-by-signal/cancel settles unknown, and no interrupt
// acknowledgement is ever claimed.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { once } from "node:events";
import childProcess from "node:child_process";
import {
  opencodeFixture,
  closeFixture,
  baselinePass,
  schedule,
  finalProposal,
  successScript,
  dispatchOpencode,
  settleOpencode,
  readReceipt,
  fakeRecord,
  writeMarker,
  waitForFile,
  alive,
  versions,
  qualification,
  PINNED_VERSION,
} from "./opencode-support.mjs";

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

test("L01 cancellation is SIGTERM-only: interrupted/unknown, late stdout ignored, group descendants die, unrelated sentinel survives (F24/FK7)", async () => {
  const f = opencodeFixture("L01-cancel");
  const sentinel = childProcess.spawn(
    process.execPath,
    ["-e", "setInterval(()=>{},500)"],
    { detached: true, stdio: "ignore" },
  );
  sentinel.unref();
  try {
    baselinePass(f);
    const action = schedule(f, "implement");
    const { plan, pending } = dispatchOpencode(f, action, {
      script: [
        { stepStart: {} },
        { spawn: "group" },
        { marker: "fake-ready" },
        // On SIGTERM the fake emits a LATE complete-looking text frame and exits 143: none of it
        // may be adopted — the cancelled attempt is already settled interrupted/unknown.
        {
          sigtermLate: {
            lines: [
              `{"type":"text","timestamp":1,"sessionID":"fake-session-0001","part":{"id":"late","sessionID":"fake-session-0001","messageID":"m","type":"text","text":"{\\"outcome\\":\\"changed\\"}","time":{"start":1,"end":2}}}\n`,
            ],
            exitCode: 143,
          },
        },
        { waitFile: "never-appears", timeoutMs: 15000 },
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
    const snapshot = await settleOpencode(f, action, pending);
    const command = f.store.commands(f.lease.runId).at(-1);
    const receipt = readReceipt(plan, command.id);
    assert.equal(receipt.settlement.classification, "interrupted");
    assert.equal(receipt.settlement.outcome, "interrupted");
    assert.match(receipt.settlement.detail, /cancelled-late-result-ignored/);
    assert.equal(receipt.usage.status, "unknown");
    // The late post-SIGTERM frame never became a proposal or a head; no interrupt ack is claimed
    // and the exact SIGTERM→exit mapping stays gated G-SIG (never claimed from fake evidence).
    assert.equal(receipt.result.final, null);
    assert.ok([null, "SIGTERM"].includes(receipt.lifecycle.signal));
    assert.equal(command.result.outcome, "cancelled");
    assert.equal(receipt.stream.revoked, true);
    assert.equal(receipt.lifecycle.quiescent, true);
    // The export audit never ran for the interrupted attempt.
    assert.equal(receipt.exportAudit.ran, false);
    await until(() => !alive(descendant));
    assert.equal(alive(sentinel.pid), true);
    assert.equal(snapshot.stage, "cancelled");
    assert.equal(snapshot.execution, null);
    assert.equal(f.store.implementationSlot(), null);
    // The prompt send never gained a second attempt.
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

test("L02 the original action deadline stops the run with reserved cleanup time and never restarts (F24)", async () => {
  const f = opencodeFixture("L02-deadline", { actionElapsedMs: 4000 });
  try {
    baselinePass(f);
    const action = schedule(f, "implement");
    const { plan, pending } = dispatchOpencode(f, action, {
      script: [{ stepStart: {} }, { marker: "fake-ready" }, { sleep: 20000 }],
    });
    await waitForFile(join(plan.paths.parentTmp, "fake-ready"));
    const snapshot = await settleOpencode(f, action, pending);
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
    assert.equal(receipt.exportAudit.ran, false);
  } finally {
    await closeFixture(f);
  }
});

test("L03 stdin consumption: exact bytes once + one EOF; exit-before-read stays attempted-unknown with no resend (F23/FK4)", async () => {
  // Exit before reading stdin: NO event exists that could evidence prompt consumption (no init
  // analogue, F23), so the attempt stays attempted-unknown — no resend, no success.
  const f = opencodeFixture("L03-exit-before-read");
  try {
    baselinePass(f);
    const action = schedule(f, "implement");
    const prompt = JSON.stringify({ script: [{ stepStart: {} }, { exit: 0 }] });
    const plan = f.adapter.prepareLaunch(action, { prompt });
    writeFileSync(
      join(plan.paths.parentTmp, "fake-scenario.json"),
      JSON.stringify({ readStdin: false, script: [{ exit: 1 }] }),
    );
    const pending = f.store.dispatchCoordinator(f.lease, action.key, f.adapter);
    const snapshot = await settleOpencode(f, action, pending);
    const command = f.store.commands(f.lease.runId).at(-1);
    const receipt = readReceipt(plan, command.id);
    // Zero stdout + exit 1 + stderr-less fake refusal: startup-shaped fatal or unresolved, but
    // never success, and usage unknown either way.
    assert.ok(
      ["fatal", "unresolved"].includes(receipt.settlement.classification),
      receipt.settlement.classification,
    );
    assert.equal(receipt.usage.status, "unknown");
    assert.equal(receipt.stream.sessionId, null);
    assert.ok(
      receipt.gaps.some(
        (gap) =>
          gap.gate === "PROMPT-CONSUMPTION" &&
          /attempted-unknown/.test(gap.gap),
      ),
    );
    assert.equal(snapshot.head, "head-1");
    const record = fakeRecord(plan);
    assert.equal(record.stdin.eofCount, 0);
    assert.equal(record.stdin.bytes, 0);
    // Exactly one prompt send, attempted-before-IO, never resent after ambiguity.
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
    await closeFixture(f);
  }
  // Durable text-send intent across crash/reopen: reserved/claimed/attempted never resend and
  // different bytes for the same key conflict (reuse of the accepted duplex semantics, not a
  // fork — F23: single EOF, no resend after ambiguity).
  for (const phase of ["reserved", "claimed", "attempted"]) {
    const g = opencodeFixture(`L03-${phase}`);
    try {
      baselinePass(g);
      const action = schedule(g, "implement");
      const id = `opencode-reserved-${phase}`;
      const token = "synthetic-owned-test-capability";
      const spec = {
        file: g.binary.path,
        args: ["run"],
        cwd: g.dir,
        timeoutMs: 5000,
        cleanupMs: 250,
        logBytes: 8192,
        outputDir: join(g.artifactRoot, "reserved-out"),
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
      const dispatch = g.store.dispatchCoordinator(g.lease, action.key, {
        versions,
        capability: null,
        qualification,
        begin(a) {
          g.store.reserveCommand(g.lease, id, token, spec, {
            action: a,
            limits,
            request: { action: a, spec, limits },
          });
          return new Promise(() => {});
        },
        interrupt() {},
      });
      dispatch.catch(() => {});
      assert.ok(g.store.command(id));
      const promptText = "exact prompt bytes — ü\n";
      g.store.queueDuplexText(g.lease, id, "prompt", promptText);
      if (phase !== "reserved") g.store.claimDuplexSend(id, token);
      if (phase === "attempted")
        assert.throws(
          () =>
            g.store.writeDuplex(id, token, "prompt", () => {
              writeFileSync(join(g.dir, "side-effect"), "ONE");
              throw new Error("owner-crash-mid-write");
            }),
          /owner-crash-mid-write/,
        );
      // Reopen exactly like a restarted owner.
      const path = g.store.path;
      g.store.close();
      const { Store, CommandRunner } = await import("../dist/index.js");
      g.store = new Store(path, Date.now);
      const again = g.store.queueDuplexText(g.lease, id, "prompt", promptText);
      assert.equal(again.state, phase === "reserved" ? "queued" : "writing");
      assert.throws(
        () => g.store.queueDuplexText(g.lease, id, "prompt", "different bytes"),
        /duplex-send-conflict/,
      );
      // Raw text is exact: no JSON framing or trailing newline is added.
      assert.equal(again.wire, promptText);
      if (phase === "attempted") {
        assert.throws(
          () =>
            g.store.writeDuplex(id, token, "prompt", () =>
              writeFileSync(join(g.dir, "side-effect"), "TWICE"),
            ),
          /duplex-send-unknown/,
        );
        assert.equal(readFileSync(join(g.dir, "side-effect"), "utf8"), "ONE");
      }
      const recovered = new CommandRunner(g.store).recover(g.lease, id);
      assert.equal(recovered.state, "recovery-required");
      assert.equal(g.store.commands(g.lease.runId).length, 1);
      assert.ok(g.store.implementationSlot());
    } finally {
      await closeFixture(g);
    }
  }
});

test("L04 restart reconciliation: prepareLaunch is idempotent, a live invocation is observation-only, sends never resend, and a changed bundle conflicts (FK1)", async () => {
  const f = opencodeFixture("L04-restart");
  try {
    baselinePass(f);
    const action = schedule(f, "implement");
    const proposal = finalProposal(action, "implementer");
    const prompt = JSON.stringify(
      successScript(proposal, {
        writeSrc,
        afterStepStart: [
          { marker: "fake-ready" },
          { waitFile: "resume", timeoutMs: 20000 },
        ],
      }),
    );
    const plan = f.adapter.prepareLaunch(action, { prompt });
    // Write the export marker BEFORE dispatch (the audit runs automatically at settlement).
    writeFileSync(
      join(plan.paths.parentTmp, "fake-export.json"),
      JSON.stringify({
        raw: `${JSON.stringify(
          {
            info: {
              id: "fake-session-0001",
              slug: "s",
              projectID: "p",
              directory: plan.paths.src,
              title: "t",
              version: PINNED_VERSION,
              time: { created: 1, updated: 2 },
              tokens: {
                input: 1200,
                output: 340,
                reasoning: 40,
                cache: { read: 800, write: 100 },
              },
            },
            messages: [
              {
                info: {
                  role: "assistant",
                  modelID: "qwen3.8-max",
                  providerID: "alibaba-token-plan",
                  tokens: {
                    input: 1200,
                    output: 340,
                    reasoning: 40,
                    cache: { read: 800, write: 100 },
                  },
                },
                parts: [],
              },
            ],
          },
          null,
          2,
        )}\n`,
        exit: 0,
      }),
    );
    const pending = f.store.dispatchCoordinator(f.lease, action.key, f.adapter);
    await waitForFile(join(plan.paths.parentTmp, "fake-ready"));
    // A restarted owner re-prepares the SAME action: identical bundle, same run tree, frozen plan.
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
    const snapshot = await settleOpencode(f, action, pending);
    const second = await settle2;
    assert.equal(second.type, "result");
    assert.equal(second.actionKey, action.key);
    assert.equal(second.outcome, "changed");
    assert.equal(snapshot.stage, "verifying");
    assert.equal(snapshot.budgets.harnessReportedTokens, 1540);
    // A conflicting re-prepare (changed prompt bytes) for the same action is refused.
    assert.throws(
      () => f.adapter.prepareLaunch(action, { prompt: `${prompt} ` }),
      /opencode-plan-conflict/,
    );
  } finally {
    await closeFixture(f);
  }
});

test("L05 post-run drift: staged instruction files, catalog mutation and C5 binary drift make the result stale/unknown, never success (FK8)", async () => {
  // (a) A staged instruction file appears during the run (planted by the fake itself). Even with
  // OPENCODE_DISABLE_PROJECT_CONFIG the staged-tree rule fails closed on drift.
  const f = opencodeFixture("L05-tree-drift");
  try {
    baselinePass(f);
    const action = schedule(f, "implement");
    const proposal = finalProposal(action, "implementer");
    const { plan, pending } = dispatchOpencode(
      f,
      action,
      successScript(proposal, {
        writeSrc: { path: "work.txt", content: "w\n" },
        afterStepStart: [
          { writeSrc: { path: "AGENTS.md", content: "hostile\n" } },
        ],
      }),
    );
    const snapshot = await settleOpencode(f, action, pending);
    const command = f.store.commands(f.lease.runId).at(-1);
    const receipt = readReceipt(plan, command.id);
    assert.equal(receipt.settlement.classification, "unresolved");
    assert.match(receipt.settlement.detail, /isolation-drift/);
    assert.ok(
      receipt.isolation.drift.some((d) =>
        d.startsWith("staged-instruction-files-appeared"),
      ),
    );
    assert.equal(receipt.usage.status, "unknown");
    assert.equal(snapshot.head, "head-1");
    assert.equal(receipt.exportAudit.ran, false);
  } finally {
    await closeFixture(f);
  }
  // (b) The pinned catalog changes during the run.
  const g = opencodeFixture("L05-catalog-drift");
  try {
    baselinePass(g);
    const action = schedule(g, "implement");
    const proposal = finalProposal(action, "implementer");
    const { plan, pending } = dispatchOpencode(
      g,
      action,
      successScript(proposal, {
        writeSrc,
        afterStepStart: [
          { marker: "mid-run" },
          { waitFile: "resume", timeoutMs: 15000 },
        ],
      }),
    );
    await waitForFile(join(plan.paths.parentTmp, "mid-run"));
    writeFileSync(g.modelsCatalog.path, '{"synthetic":"mutated-mid-run"}');
    writeMarker(plan, "resume");
    const snapshot = await settleOpencode(g, action, pending);
    const command = g.store.commands(g.lease.runId).at(-1);
    const receipt = readReceipt(plan, command.id);
    assert.equal(receipt.settlement.classification, "unresolved");
    assert.ok(
      receipt.isolation.drift.some((d) => d === "catalog-hash-changed"),
    );
    assert.equal(receipt.usage.status, "unknown");
    assert.equal(snapshot.head, "head-1");
  } finally {
    await closeFixture(g);
  }
  // (c) One-byte C5 binary drift after the C1-gated spawn: caught at settlement.
  const h = opencodeFixture("L05-c5-drift");
  try {
    baselinePass(h);
    const action = schedule(h, "implement");
    const proposal = finalProposal(action, "implementer");
    const { plan, pending } = dispatchOpencode(
      h,
      action,
      successScript(proposal, {
        writeSrc,
        afterStepStart: [
          { marker: "mid-run" },
          { waitFile: "resume", timeoutMs: 15000 },
        ],
      }),
    );
    await waitForFile(join(plan.paths.parentTmp, "mid-run"));
    writeFileSync(
      h.binary.path,
      Buffer.concat([readFileSync(h.binary.path), Buffer.from("\n")]),
    );
    writeMarker(plan, "resume");
    const snapshot = await settleOpencode(h, action, pending);
    const command = h.store.commands(h.lease.runId).at(-1);
    const receipt = readReceipt(plan, command.id);
    assert.equal(receipt.settlement.classification, "unresolved");
    assert.ok(
      receipt.isolation.drift.some((d) =>
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
    await closeFixture(h);
  }
});
