// Taskbot #81 protocol tests: strict `codex exec --json` JSONL classification (S04/S07/S08/S09)
// against the frozen rocky-subscription-88-v1 contract, driven by the owned fake CLI over REAL
// spawned processes and real SQLite stores (F02/F03/F04/F05/F08/F12/F13 protocol rules). Every run
// is owned-fake-cli evidence: no native binary, no credentials, no network, no model calls. The
// exact native serde frame shape is a synthetic-native gate (N06); these tests exercise the RULES.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  codexFixture,
  closeFixture,
  baselinePass,
  implementChanged,
  schedule,
  finalProposal,
  successScript,
  dispatchCodex,
  settleCodex,
  readReceipt,
  fakeRecord,
  deriveTreeHead,
  localUsage,
  syntheticReported,
  apply,
  finish,
  receipt as registerReceipt,
  defaultUsage,
  willRetryErrorEvent,
} from "./codex-exec-support.mjs";

async function runScenario(name, scriptFn, options = {}) {
  const f = codexFixture(name, options.fixture);
  const ctx = { f };
  try {
    let action;
    let role = "implementer";
    if (options.review) {
      implementChanged(f);
      action = schedule(f, "review");
      role = "reviewer";
    } else {
      baselinePass(f);
      action = schedule(f, options.kind ?? "implement");
    }
    const proposal = finalProposal(
      action,
      role,
      options.review ? "complete" : "changed",
    );
    const script = scriptFn({ f, action, proposal, role });
    const { plan, pending } = dispatchCodex(f, action, script, options);
    const snapshot = await settleCodex(f, action, pending);
    const command = f.store.commands(f.lease.runId).at(-1);
    Object.assign(ctx, {
      action,
      role,
      plan,
      proposal,
      snapshot,
      command,
      receipt: readReceipt(plan, command.id),
    });
    ctx.settlement = ctx.receipt.settlement;
    return ctx;
  } catch (error) {
    await closeFixture(f);
    throw error;
  }
}
const close = (ctx) => closeFixture(ctx.f);
const detail = (ctx) => ctx.receipt.settlement.detail;
const writeOut = { path: "output.txt", content: "bounded change\n" };
/** A complete, otherwise-valid stream as a raw frame list; each P04 case mutates one seam. */
const completeFrames = (proposal) => [
  { thread: {} },
  { turnStarted: {} },
  {
    itemStarted: { id: "item_0", itemType: "command_execution", command: "ls" },
  },
  {
    itemCompleted: {
      id: "item_0",
      itemType: "command_execution",
      command: "ls",
      status: "completed",
      exit_code: 0,
      aggregated_output: "ok",
    },
  },
  {
    itemCompleted: {
      id: "item_final",
      itemType: "agent_message",
      text: JSON.stringify(proposal),
    },
  },
  { turnCompleted: { usage: {} } },
  { exit: 0 },
];

test("P01 complete positive control: full conjunction yields a protocol-qualified PROPOSAL only (F02/S04/S07/S08)", async () => {
  const ctx = await runScenario("P01-success", ({ proposal }) =>
    successScript(proposal, { writeSrc: writeOut }),
  );
  try {
    const { f, plan, snapshot, receipt, action, proposal } = ctx;
    assert.equal(receipt.settlement.classification, "complete");
    assert.equal(receipt.settlement.outcome, "changed");
    assert.equal(snapshot.blocker, null);
    assert.equal(snapshot.stage, "verifying");
    // The head is host-derived from the staged tree, never from the model's final message.
    assert.equal(snapshot.head, deriveTreeHead(plan.paths.src));
    assert.notEqual(snapshot.head, "head-1");
    assert.deepEqual(receipt.head, {
      pre: plan.headPre,
      post: deriveTreeHead(plan.paths.src),
    });
    // The proposal is retained but establishes no authority: head adoption invalidated the baseline
    // receipt and the model final registered no checks/CI/review receipt of any kind.
    assert.deepEqual(receipt.result.final, proposal);
    assert.deepEqual(Object.keys(snapshot.receipts), []);
    assert.match(
      receipt.result.proposalAuthority,
      /proposal only; never authoritative/,
    );
    // Usage: reported from the single terminal turn.completed only; subsets never added twice.
    assert.equal(snapshot.budgets.harnessReportedTokens, 1540);
    assert.equal(snapshot.budgets.harnessAmbiguousZero, 0);
    assert.equal(snapshot.budgets.unknownActions, 0);
    assert.deepEqual(snapshot.unqualifiedResults, []);
    const usage = f.store.effect(action.key).receipt.usage;
    assert.deepEqual(usage, {
      schema: 2,
      status: "reported",
      source: "native-harness-telemetry",
      harness: "codex-exec",
      receipt: usage.receipt,
      components: {
        input: 1200,
        cachedInput: 800,
        cacheWriteInput: 100,
        output: 340,
        reasoningOutput: 40,
      },
    });
    // The usage receipt is the sha256 of the retained raw turn.completed line.
    const stdoutRaw = readFileSync(receipt.stream.rawStdoutLog, "utf8");
    const turnLine = stdoutRaw
      .split("\n")
      .find((line) => line.includes('"type":"turn.completed"'));
    assert.equal(
      usage.receipt,
      createHash("sha256").update(turnLine, "utf8").digest("hex"),
    );
    // Separated lifecycle conjuncts: exit 0, both carrier EOFs, both child EOFs, decoder complete,
    // quiescence — recorded separately, never collapsed into the exit code.
    assert.deepEqual(
      {
        exitCode: receipt.lifecycle.exitCode,
        signal: receipt.lifecycle.signal,
        stdoutEof: receipt.lifecycle.stdoutEof,
        stderrEof: receipt.lifecycle.stderrEof,
        childStdoutEof: receipt.lifecycle.childStdoutEof,
        childStderrEof: receipt.lifecycle.childStderrEof,
        decoderComplete: receipt.lifecycle.decoderComplete,
        quiescent: receipt.lifecycle.quiescent,
      },
      {
        exitCode: 0,
        signal: null,
        stdoutEof: true,
        stderrEof: true,
        childStdoutEof: true,
        childStderrEof: true,
        decoderComplete: true,
        quiescent: true,
      },
    );
    // Exact immutable input: the child received the exact prompt bytes once, one EOF, no resend.
    const record = fakeRecord(plan);
    assert.equal(record.stdin.sha256, plan.bundle.input.sha256);
    assert.equal(record.stdin.bytes, plan.bundle.input.bytes);
    assert.equal(record.stdin.eofCount, 1);
    assert.deepEqual(
      receipt.stream.sends.map((s) => [
        s.key.endsWith(":prompt") ? "prompt" : "eof",
        s.state,
        s.end,
      ]),
      [
        ["prompt", "written", false],
        ["eof", "written", true],
      ],
    );
    // thread.started is the only correlation identity; nothing else is exposed or fabricated.
    assert.equal(receipt.threadIdentity.threadStartedObserved, true);
    assert.equal(receipt.threadIdentity.threadId, "fake-thread-0001");
    // Trust persistence prevented and the shared config.toml unchanged.
    assert.equal(receipt.trustPersistence.unchanged, true);
    assert.equal(receipt.trustPersistence.untrustedOverridePresent, true);
    assert.equal(receipt.trustPersistence.projectlessTree, true);
    assert.deepEqual(receipt.discovery.drift, []);
    assert.equal(receipt.binary.measuredC0.sha256, f.binary.sha256);
    assert.equal(receipt.binary.measuredC5.sha256, f.binary.sha256);
    // Receipt honesty: gates remain open gaps; evidence class is owned-fake-cli.
    assert.equal(receipt.evidenceClass, "owned-fake-cli");
    const gates = receipt.gaps.map((g) => g.gate);
    for (const gate of [
      "G-OVERRIDES",
      "G-MODEL",
      "G-EFFORT",
      "G-AUTH",
      "G-TRUST",
      "G-FRAME-SHAPE",
      "G-VISUAL",
      "G-WRITES",
      "G-SIGINT",
      "L01-L02",
      "N01-N08",
    ])
      assert.ok(gates.includes(gate), `missing gap ${gate}`);
    assert.equal(receipt.usage.status, "reported");
    // The ordinary settled command (exit 0) is recorded; no ordinary failures here.
    assert.deepEqual(receipt.stream.ordinaryFailures, []);
    assert.equal(receipt.stream.itemCount, 3);
  } finally {
    close(ctx);
  }
});

test("P02 fragmented multibyte UTF-8 across frame boundaries decodes identically (F03/S04)", async () => {
  const ctx = await runScenario("P02-fragmented", ({ proposal }) =>
    successScript(proposal, {
      threadFrag: 1,
      afterTurn: [
        {
          outFrag: {
            type: "item.completed",
            id: "item_r",
            item: { type: "reasoning", text: "grüße 世界 🜀 reasoning" },
          },
          size: 3,
        },
      ],
      writeSrc: writeOut,
    }),
  );
  try {
    assert.equal(ctx.settlement.classification, "complete");
    assert.equal(ctx.snapshot.blocker, null);
    assert.equal(ctx.snapshot.stage, "verifying");
  } finally {
    close(ctx);
  }
});

test("P03 reviewer role: read-only profile composes; a head mismatch stays unexpected-result (S02/S04)", async () => {
  const f = codexFixture("P03-reviewer");
  try {
    implementChanged(f);
    const action = schedule(f, "review");
    const proposal = finalProposal(action, "reviewer", "complete");
    const { plan, pending } = dispatchCodex(
      f,
      action,
      successScript(proposal, {}),
    );
    assert.equal(plan.role, "reviewer");
    assert.ok(
      plan.overrideAssignments.some((a) =>
        a.startsWith('default_permissions="rocky_reviewer"'),
      ),
    );
    // The fresh reviewer SRC derives the empty-tree head, which differs from the implemented
    // snapshot head: the protocol run completes, but the reducer must refuse the head binding.
    const snapshot = await settleCodex(f, action, pending);
    assert.equal(snapshot.blocker?.detail, "unexpected-result");
    assert.equal(snapshot.blocker?.kind, "recovery");
    const command = f.store.commands(f.lease.runId).at(-1);
    const receipt = readReceipt(plan, command.id);
    assert.equal(receipt.settlement.classification, "complete");
    assert.equal(receipt.settlement.outcome, "complete");
  } finally {
    await closeFixture(f);
  }
});

test("P03b reviewer with a host-staged matching head: complete result adopts no head change (S02/S04)", async () => {
  const { mkdtempSync, realpathSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const staged = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), "codex81-staged-")),
  );
  writeFileSync(join(staged, "review-file.txt"), "reviewed tree\n");
  const stagedHead = deriveTreeHead(staged);
  const emptyDir = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), "codex81-empty-")),
  );
  const emptyHead = deriveTreeHead(emptyDir);
  const g = codexFixture("P03b-reviewer", { head: emptyHead });
  try {
    baselinePass(g);
    apply(g.store, g.lease, { type: "schedule", kind: "implement" });
    finish(g, {
      usage: syntheticReported(10, 5),
      outcome: "changed",
      head: stagedHead,
    });
    apply(g.store, g.lease, { type: "schedule", kind: "verify" });
    finish(g, { usage: localUsage() });
    registerReceipt(g, "checks");
    const action = schedule(g, "review");
    const proposal = finalProposal(action, "reviewer", "complete");
    const { plan, pending } = dispatchCodex(
      g,
      action,
      successScript(proposal, {}),
      {
        stage: (src) =>
          writeFileSync(join(src, "review-file.txt"), "reviewed tree\n"),
      },
    );
    const snapshot = await settleCodex(g, action, pending);
    assert.equal(snapshot.blocker, null);
    assert.equal(snapshot.head, stagedHead);
    const command = g.store.commands(g.lease.runId).at(-1);
    const receipt = readReceipt(plan, command.id);
    assert.equal(receipt.settlement.classification, "complete");
    assert.equal(receipt.settlement.outcome, "complete");
    assert.deepEqual(receipt.result.final, proposal);
    assert.deepEqual(Object.keys(snapshot.receipts).sort(), ["checks"]);
  } finally {
    await closeFixture(g);
  }
});

test("P04 item and terminal contradictions each reject a successful proposal (F04/S04)", async () => {
  const cases = [
    [
      "missing-thread",
      (frames) => frames.filter((s) => s.thread === undefined),
      /thread-started-missing/,
    ],
    [
      "duplicate-thread",
      (frames) => [{ thread: {} }, ...frames],
      /multiple-thread-started/,
    ],
    [
      "blank-thread-id",
      (frames) =>
        frames.map((s) =>
          s.thread !== undefined ? { thread: { thread_id: "  " } } : s,
        ),
      /thread-id-blank/,
    ],
    [
      "missing-turn-started",
      (frames) => frames.filter((s) => s.turnStarted === undefined),
      /turn-started-missing/,
    ],
    [
      "completed-only-command",
      (frames) => frames.filter((s) => s.itemStarted === undefined),
      /command-completed-only:item_0/,
    ],
    [
      "duplicate-item-start",
      (frames) => {
        const out = [...frames];
        const idx = out.findIndex((s) => s.itemStarted !== undefined);
        out.splice(idx + 1, 0, {
          itemStarted: { id: "item_0", itemType: "command_execution" },
        });
        return out;
      },
      /item-duplicate-start:item_0/,
    ],
    [
      "item-type-change",
      (frames) =>
        frames.map((s) =>
          s.itemCompleted !== undefined && s.itemCompleted.id === "item_0"
            ? {
                itemCompleted: {
                  id: "item_0",
                  itemType: "file_change",
                  changes: [],
                  status: "completed",
                },
              }
            : s,
        ),
      /item-type-change:item_0/,
    ],
    [
      "update-before-start",
      (frames) => {
        const out = [...frames];
        const idx = out.findIndex((s) => s.itemStarted !== undefined);
        out.splice(idx, 0, {
          itemUpdated: { id: "item_0", itemType: "command_execution" },
        });
        return out;
      },
      /item-update-before-start:item_0/,
    ],
    [
      "duplicate-completion",
      (frames) => {
        const out = [...frames];
        const idx = out.findIndex(
          (s) =>
            s.itemCompleted !== undefined && s.itemCompleted.id === "item_0",
        );
        out.splice(idx + 1, 0, out[idx]);
        return out;
      },
      /item-duplicate-completion:item_0/,
    ],
    [
      "pending-status",
      (frames) =>
        frames.map((s) =>
          s.itemCompleted !== undefined && s.itemCompleted.id === "item_0"
            ? {
                itemCompleted: {
                  ...s.itemCompleted,
                  status: "pending",
                  exit_code: undefined,
                },
              }
            : s,
        ),
      /item-pending:command_execution:item_0/,
    ],
    [
      "started-unresolved",
      (frames) =>
        frames.filter(
          (s) =>
            !(s.itemCompleted !== undefined && s.itemCompleted.id === "item_0"),
        ),
      /item-unresolved:command_execution:item_0/,
    ],
    [
      "todo-unresolved",
      (frames) => {
        const out = [...frames];
        const idx = out.findIndex((s) => s.itemStarted !== undefined);
        out.splice(idx + 1, 0, {
          itemStarted: { id: "item_todo", itemType: "todo_list" },
        });
        return out;
      },
      /item-unresolved:todo_list:item_todo/,
    ],
    [
      "frame-after-terminal",
      (frames) => {
        const out = [...frames];
        const idx = out.findIndex((s) => s.turnCompleted !== undefined);
        out.splice(idx + 1, 0, { turnStarted: {} });
        return out;
      },
      /frame-after-terminal|multiple-turn-started/,
    ],
    [
      "duplicate-terminal",
      (frames) => {
        const out = [...frames];
        const idx = out.findIndex((s) => s.turnCompleted !== undefined);
        out.splice(idx + 1, 0, { turnCompleted: { usage: {} } });
        return out;
      },
      /duplicate-terminal/,
    ],
  ];
  for (const [name, mutate, pattern] of cases) {
    const ctx = await runScenario(
      `P04-${name}`,
      ({ proposal }) => ({ script: mutate(completeFrames(proposal)) }),
      {},
    );
    try {
      assert.equal(ctx.settlement.classification, "unresolved", name);
      assert.match(detail(ctx), pattern, name);
      // A rejected run never adopts the head and never becomes a successful proposal. Usage may be
      // reported (a clean turn.completed lifecycle is honest accounting) or unknown, but is never a
      // fabricated known-zero; the rejection itself is what matters here.
      assert.ok(
        ["reported", "unknown", "ambiguous-zero"].includes(
          ctx.receipt.usage.status,
        ),
        name,
      );
      assert.equal(ctx.snapshot.head, "head-1", name);
      assert.notEqual(ctx.snapshot.stage, "verifying", name);
    } finally {
      close(ctx);
    }
  }
  // A completed todo_list is informational only: its synthesized task state neither corroborates
  // nor blocks — it is NOT an injection or rejection class (F10 amendment #93).
  const todo = await runScenario(
    "P04-todo-informational",
    ({ proposal }) => ({
      script: [
        { thread: {} },
        { turnStarted: {} },
        { itemStarted: { id: "item_todo", itemType: "todo_list" } },
        {
          itemCompleted: {
            id: "item_todo",
            itemType: "todo_list",
            items: [{ text: "step", status: "completed" }],
            status: "completed",
          },
        },
        {
          itemCompleted: {
            id: "item_final",
            itemType: "agent_message",
            text: JSON.stringify(proposal),
          },
        },
        { turnCompleted: { usage: {} } },
        { exit: 0 },
      ],
    }),
    { stage: undefined },
  );
  try {
    // No writeSrc, so the staged tree is empty; the proposal is accepted (complete) and the head
    // adopts the empty-tree digest. The todo task state played no role in classification.
    assert.equal(todo.settlement.classification, "complete");
  } finally {
    close(todo);
  }
});

test("P05 error items, error events and turn.failed all fail closed (F04/F05/S04/S09)", async () => {
  // A ConfigWarning error item before turn.completed rejects (error-item surface, F10).
  for (const text of [
    "ConfigWarning: unknown field",
    "DeprecationNotice: legacy key",
    "event stream lagged; dropped 3 events",
    "model rerouted to gpt-6-astra",
  ]) {
    const ctx = await runScenario(
      `P05-error-item-${text.slice(0, 12).replace(/[^a-z0-9]/gi, "-")}`,
      ({ proposal }) => {
        const frames = completeFrames(proposal);
        const idx = frames.findIndex((s) => s.turnCompleted !== undefined);
        frames.splice(idx, 0, {
          itemCompleted: { id: "item_err", itemType: "error", text },
        });
        return { script: frames };
      },
    );
    try {
      assert.equal(ctx.settlement.classification, "fatal");
      assert.match(detail(ctx), /error-item:/);
      assert.equal(ctx.receipt.settlement.outcome, "failed");
      assert.equal(ctx.receipt.usage.status, "unknown");
      assert.equal(ctx.snapshot.head, "head-1");
      assert.equal(ctx.receipt.stream.errorItems.length, 1);
    } finally {
      close(ctx);
    }
  }
  // A will_retry top-level error event followed by turn.completed still fails closed.
  const retry = await runScenario("P05-will-retry", ({ proposal }) => {
    const frames = completeFrames(proposal);
    const idx = frames.findIndex((s) => s.turnCompleted !== undefined);
    frames.splice(idx, 0, { out: willRetryErrorEvent });
    return { script: frames };
  });
  try {
    assert.equal(retry.settlement.classification, "fatal");
    assert.match(detail(retry), /error-event/);
    assert.equal(retry.receipt.usage.status, "unknown");
    assert.equal(retry.receipt.stream.errorEvents.length, 1);
  } finally {
    close(retry);
  }
  // turn.failed + exit 1 is fatal, never success.
  const failed = await runScenario("P05-turn-failed", () => ({
    script: [
      { thread: {} },
      { turnStarted: {} },
      { turnFailed: {} },
      { exit: 1 },
    ],
  }));
  try {
    assert.equal(failed.settlement.classification, "fatal");
    assert.match(detail(failed), /turn-failed/);
    assert.equal(failed.receipt.settlement.outcome, "failed");
    assert.equal(failed.receipt.usage.status, "unknown");
    assert.equal(failed.receipt.lifecycle.exitCode, 1);
  } finally {
    close(failed);
  }
});

test("P06 final and error authority: the last completed agent_message is the only final (F05/S04)", async () => {
  // Prose final (not JSON) rejects.
  const prose = await runScenario("P06-prose", () => ({
    script: [
      { thread: {} },
      { turnStarted: {} },
      {
        itemCompleted: {
          id: "item_final",
          itemType: "agent_message",
          text: "All done! The tests pass.",
        },
      },
      { turnCompleted: { usage: {} } },
      { exit: 0 },
    ],
  }));
  try {
    assert.equal(prose.settlement.classification, "unresolved");
    assert.match(detail(prose), /final-invalid/);
  } finally {
    close(prose);
  }
  // An earlier schema-shaped progress message cannot supply the final; the LAST one is prose.
  const earlier = await runScenario("P06-earlier-progress", ({ proposal }) => ({
    script: [
      { thread: {} },
      { turnStarted: {} },
      {
        itemCompleted: {
          id: "item_p",
          itemType: "agent_message",
          text: JSON.stringify(proposal),
        },
      },
      {
        itemCompleted: {
          id: "item_final",
          itemType: "agent_message",
          text: "progress note, not the final",
        },
      },
      { turnCompleted: { usage: {} } },
      { exit: 0 },
    ],
  }));
  try {
    assert.equal(earlier.settlement.classification, "unresolved");
    assert.match(detail(earlier), /final-invalid/);
  } finally {
    close(earlier);
  }
  // Two schema-shaped finals reject.
  const dup = await runScenario("P06-multiple-finals", ({ proposal }) => ({
    script: [
      { thread: {} },
      { turnStarted: {} },
      {
        itemCompleted: {
          id: "item_a",
          itemType: "agent_message",
          text: JSON.stringify(proposal),
        },
      },
      {
        itemCompleted: {
          id: "item_b",
          itemType: "agent_message",
          text: JSON.stringify(proposal),
        },
      },
      { turnCompleted: { usage: {} } },
      { exit: 0 },
    ],
  }));
  try {
    assert.match(detail(dup), /multiple-schema-shaped-finals/);
  } finally {
    close(dup);
  }
  // Wrong action/input/role binding rejects.
  for (const [label, patch] of [
    ["action", (p) => ({ ...p, actionKey: `${p.actionKey}-other` })],
    ["input", (p) => ({ ...p, inputDigest: "0".repeat(64) })],
    ["role", (p) => ({ ...p, role: "reviewer" })],
  ]) {
    const ctx = await runScenario(`P06-binding-${label}`, ({ proposal }) => {
      const frames = completeFrames(patch(proposal));
      return { script: frames };
    });
    try {
      assert.match(detail(ctx), /final-binding/, label);
    } finally {
      close(ctx);
    }
  }
  // Extra/missing schema fields reject.
  const extra = await runScenario("P06-extra-field", ({ proposal }) => ({
    script: completeFrames({ ...proposal, extra: "field" }),
  }));
  try {
    assert.match(detail(extra), /final-invalid/);
  } finally {
    close(extra);
  }
  const missing = await runScenario("P06-missing-field", ({ proposal }) => {
    const { summary, ...rest } = proposal;
    return { script: completeFrames(rest) };
  });
  try {
    assert.match(detail(missing), /final-invalid/);
  } finally {
    close(missing);
  }
  // A final before the last settled tool rejects.
  const beforeTool = await runScenario(
    "P06-final-before-tool",
    ({ proposal }) => ({
      script: [
        { thread: {} },
        { turnStarted: {} },
        {
          itemCompleted: {
            id: "item_final",
            itemType: "agent_message",
            text: JSON.stringify(proposal),
          },
        },
        {
          itemStarted: {
            id: "item_c",
            itemType: "command_execution",
            command: "ls",
          },
        },
        {
          itemCompleted: {
            id: "item_c",
            itemType: "command_execution",
            command: "ls",
            status: "completed",
            exit_code: 0,
            aggregated_output: "ok",
          },
        },
        { turnCompleted: { usage: {} } },
        { exit: 0 },
      ],
    }),
  );
  try {
    assert.match(detail(beforeTool), /final-before-tool/);
  } finally {
    close(beforeTool);
  }
  // Missing final (no agent_message) rejects.
  const noFinal = await runScenario("P06-no-final", () => ({
    script: [
      { thread: {} },
      { turnStarted: {} },
      { turnCompleted: { usage: {} } },
      { exit: 0 },
    ],
  }));
  try {
    assert.match(detail(noFinal), /no-final/);
  } finally {
    close(noFinal);
  }
  // turn.completed before the final rejects.
  const terminalFirst = await runScenario(
    "P06-terminal-before-final",
    ({ proposal }) => ({
      script: [
        { thread: {} },
        { turnStarted: {} },
        { turnCompleted: { usage: {} } },
        {
          itemCompleted: {
            id: "item_final",
            itemType: "agent_message",
            text: JSON.stringify(proposal),
          },
        },
        { exit: 0 },
      ],
    }),
  );
  try {
    assert.match(
      detail(terminalFirst),
      /frame-after-terminal|terminal-before-final/,
    );
  } finally {
    close(terminalFirst);
  }
  // Nonzero exit after an otherwise valid final: exit-matrix violation, never success.
  const exit1 = await runScenario("P06-exit1", ({ proposal }) =>
    successScript(proposal, { writeSrc: writeOut, exit: 1 }),
  );
  try {
    assert.equal(exit1.settlement.classification, "unresolved");
    assert.match(detail(exit1), /exit-matrix-violation/);
    assert.equal(exit1.receipt.usage.status, "unknown");
    assert.equal(exit1.snapshot.head, "head-1");
  } finally {
    close(exit1);
  }
  // Interrupted turn: no terminal event + exit 1 ⇒ interrupted/unknown, never success (F10).
  const interrupted = await runScenario("P06-interrupted", ({ proposal }) => ({
    script: [
      { thread: {} },
      { turnStarted: {} },
      {
        itemCompleted: {
          id: "item_final",
          itemType: "agent_message",
          text: JSON.stringify(proposal),
        },
      },
      { exit: 1 },
    ],
  }));
  try {
    assert.match(detail(interrupted), /no-terminal/);
    assert.equal(interrupted.receipt.settlement.outcome, "interrupted");
    assert.equal(interrupted.receipt.usage.status, "unknown");
    assert.equal(interrupted.snapshot.head, "head-1");
  } finally {
    close(interrupted);
  }
});

test("P07 framing, bounds and malformed garbage reject with retained bounded evidence (F03/S04)", async () => {
  // Non-JSON garbage line.
  const garbage = await runScenario("P07-garbage", ({ proposal }) => {
    const frames = completeFrames(proposal);
    frames.splice(2, 0, { outText: "not json at all\n" });
    return { script: frames };
  });
  try {
    assert.equal(garbage.settlement.classification, "unresolved");
    assert.match(
      detail(garbage),
      /transport-failure:duplex-malformed-frame|stream-decode:strict-malformed-frame/,
    );
  } finally {
    close(garbage);
  }
  // Invalid UTF-8 bytes.
  const invalid = Buffer.from('{"type":"turn.started","bad":"', "utf8");
  const badUtf8 = await runScenario("P07-utf8", () => ({
    script: [
      { thread: {} },
      {
        outRaw: Buffer.concat([
          invalid,
          Buffer.from([0xff, 0xfe]),
          Buffer.from('"}\n', "utf8"),
        ]).toString("base64"),
      },
      { exit: 0 },
    ],
  }));
  try {
    assert.match(
      detail(badUtf8),
      /transport-failure:duplex-malformed-frame|stream-decode:strict-invalid-utf8/,
    );
  } finally {
    close(badUtf8);
  }
  // Duplicate JSON keys within a frame: the transport JSON decoder cannot see them, the adapter's
  // strict decoder rejects (never silently discarded).
  const dupKeys = await runScenario("P07-dupkeys", () => ({
    script: [
      { thread: {} },
      { outText: '{"type":"turn.started","type":"turn.started"}\n' },
      { exit: 0 },
    ],
  }));
  try {
    assert.match(detail(dupKeys), /stream-decode:strict-duplicate-key/);
  } finally {
    close(dupKeys);
  }
  // Extra unknown field on a success-path envelope rejects (F03).
  const extraField = await runScenario("P07-extra-field", () => ({
    script: [
      { thread: { thread_id: "t", surprise: "x" } },
      { turnStarted: {} },
      { turnCompleted: { usage: {} } },
      { exit: 0 },
    ],
  }));
  try {
    assert.match(detail(extraField), /thread-started-shape/);
  } finally {
    close(extraField);
  }
  // Unknown top-level frame type rejects.
  const unknownType = await runScenario("P07-unknown-type", () => ({
    script: [
      { thread: {} },
      { out: { type: "totally.unknown" } },
      { turnStarted: {} },
      { turnCompleted: { usage: {} } },
      { exit: 0 },
    ],
  }));
  try {
    assert.match(detail(unknownType), /unknown-frame-type/);
  } finally {
    close(unknownType);
  }
  // Non-object JSON rejects.
  const nonObject = await runScenario("P07-nonobject", () => ({
    script: [{ outText: "42\n" }, { thread: {} }, { exit: 0 }],
  }));
  try {
    assert.match(detail(nonObject), /frame-not-object/);
  } finally {
    close(nonObject);
  }
  // Truncated stream: partial last line then carrier EOF.
  const truncated = await runScenario("P07-truncated", () => ({
    script: [
      { thread: {} },
      { outText: '{"type":"turn.completed"' },
      { exit: 0 },
    ],
  }));
  try {
    assert.match(
      detail(truncated),
      /transport-failure:duplex-partial-frame|stream-decode:strict-partial-line/,
    );
  } finally {
    close(truncated);
  }
  // Oversize single line beyond the configured bound (the fake generates the pad at runtime so the
  // prompt stays small). Valid thread/turn frames precede it so the decode error is the signal.
  const oversize = await runScenario("P07-oversize", () => ({
    script: [
      { thread: {} },
      { turnStarted: {} },
      { outPad: 70000 },
      { exit: 0 },
    ],
  }));
  try {
    assert.equal(oversize.settlement.classification, "unresolved");
    assert.match(
      detail(oversize),
      /transport-failure:duplex-frame-limit|stream-decode:strict-line-limit/,
    );
    assert.equal(oversize.receipt.usage.status, "unknown");
  } finally {
    close(oversize);
  }
});

test("P07z stdout total-byte overflow trips the transport bound and rejects (F03/S04)", async () => {
  const f = codexFixture("P07z", {
    config: {
      limits: {
        maxStdoutBytes: 8192,
        maxStderrBytes: 8192,
        maxLineBytes: 2048,
        maxFrames: 1000,
        maxItems: 1000,
        maxFinalBytes: 2048,
      },
    },
  });
  try {
    baselinePass(f);
    const action = schedule(f, "implement");
    // Many shape-VALID reasoning items so the byte total (not a content/shape fault) trips the
    // transport output bound; the raw capture stays bounded and the run rejects as unresolved.
    const { plan, pending } = dispatchCodex(f, action, {
      script: [
        { thread: {} },
        { turnStarted: {} },
        ...Array.from({ length: 200 }, (_, n) => ({
          itemCompleted: {
            id: `item_r${n}`,
            itemType: "reasoning",
            text: "z".repeat(60),
          },
        })),
        { exit: 0 },
      ],
    });
    const snapshot = await settleCodex(f, action, pending);
    const command = f.store.commands(f.lease.runId).at(-1);
    const receipt = readReceipt(plan, command.id);
    assert.equal(receipt.settlement.classification, "unresolved");
    assert.equal(receipt.stream.transportFailure, "duplex-output-limit");
    assert.ok(receipt.stream.outputBytes <= 8192);
    assert.equal(receipt.usage.status, "unknown");
    assert.equal(snapshot.blocker?.kind, "recovery");
  } finally {
    await closeFixture(f);
  }
});

test("P07y item-count and aggregated-output bounds reject (F03/S04)", async () => {
  // Item-count bound: more started items than maxItems.
  const many = await runScenario(
    "P07y-items",
    () => ({
      script: [
        { thread: {} },
        { turnStarted: {} },
        ...Array.from({ length: 70 }, (_, n) => ({
          itemStarted: { id: `item_${n}`, itemType: "reasoning" },
        })),
        { exit: 0 },
      ],
    }),
    {},
  );
  try {
    assert.match(detail(many), /item-limit/);
  } finally {
    close(many);
  }
  // Aggregated-output bound on a command item (small bound, output exceeds it but fits the line).
  const big = await runScenario(
    "P07y-aggregated",
    () => ({
      script: [
        { thread: {} },
        { turnStarted: {} },
        {
          itemStarted: {
            id: "item_0",
            itemType: "command_execution",
            command: "cat",
          },
        },
        {
          itemCompleted: {
            id: "item_0",
            itemType: "command_execution",
            command: "cat",
            status: "completed",
            exit_code: 0,
            aggregated_output: "z".repeat(2000),
          },
        },
        { exit: 0 },
      ],
    }),
    { fixture: { config: { limits: { maxAggregatedOutputBytes: 1024 } } } },
  );
  try {
    assert.match(detail(big), /aggregated-output-limit/);
  } finally {
    close(big);
  }
});

test("P08 ordinary settled failures are retained and do not alone reject a later bound proposal (F12/F13/S04)", async () => {
  // A fully observed nonzero diagnostic command precedes a correct final: still complete.
  const regression = await runScenario("P08-regression", ({ proposal }) =>
    successScript(proposal, {
      writeSrc: { path: "fixed.txt", content: "repaired\n" },
      ordinary: [
        {
          itemStarted: {
            id: "item_fail",
            itemType: "command_execution",
            command: "npm test",
          },
        },
        {
          itemCompleted: {
            id: "item_fail",
            itemType: "command_execution",
            command: "npm test",
            status: "completed",
            exit_code: 1,
            aggregated_output: "FAIL: 2 tests failed (ordinary diagnostic)",
          },
        },
      ],
    }),
  );
  try {
    assert.equal(regression.settlement.classification, "complete");
    assert.equal(regression.snapshot.blocker, null);
    assert.deepEqual(regression.receipt.stream.ordinaryFailures, [
      { id: "item_fail", itemType: "command_execution", exitCode: 1 },
    ]);
  } finally {
    close(regression);
  }
  // A recoverable patch context-mismatch then a corrected patch with a DISTINCT id: still complete,
  // both item histories retained immutably.
  const patch = await runScenario("P08-patch", ({ proposal }) =>
    successScript(proposal, {
      writeSrc: { path: "patched.txt", content: "corrected\n" },
      ordinary: [
        {
          itemCompleted: {
            id: "item_p1",
            itemType: "file_change",
            changes: [{ path: "x.txt" }],
            status: "failed",
          },
        },
        {
          itemCompleted: {
            id: "item_p2",
            itemType: "file_change",
            changes: [{ path: "x.txt" }],
            status: "completed",
          },
        },
      ],
    }),
  );
  try {
    assert.equal(patch.settlement.classification, "complete");
    assert.deepEqual(patch.receipt.stream.ordinaryFailures, [
      { id: "item_p1", itemType: "file_change", exitCode: null },
    ]);
  } finally {
    close(patch);
  }
});

test("P09 usage mapping onto subscription-observed-v1 schema 2 (F08/S08)", async () => {
  // All-zero usage on a complete run: ambiguous-zero, head NOT adopted, recovery barrier.
  const zero = await runScenario("P09-zero", ({ proposal }) =>
    successScript(proposal, {
      writeSrc: writeOut,
      usage: {
        input_tokens: 0,
        cached_input_tokens: 0,
        cache_write_input_tokens: 0,
        output_tokens: 0,
        reasoning_output_tokens: 0,
      },
    }),
  );
  try {
    assert.equal(zero.settlement.classification, "complete");
    assert.equal(zero.receipt.usage.status, "ambiguous-zero");
    assert.equal(zero.snapshot.stage, "recovery_required");
    assert.equal(
      zero.snapshot.blocker?.detail,
      "successful-result-usage-ambiguous-zero",
    );
    assert.deepEqual(zero.snapshot.unqualifiedResults, ["implement"]);
    assert.equal(zero.snapshot.budgets.harnessAmbiguousZero, 1);
    assert.equal(zero.snapshot.head, "head-1");
  } finally {
    close(zero);
  }
  // Absent usage object on turn.completed: ambiguous-zero, never a known zero.
  const absent = await runScenario("P09-absent", ({ proposal }) => ({
    script: [
      { thread: {} },
      { turnStarted: {} },
      {
        itemCompleted: {
          id: "item_final",
          itemType: "agent_message",
          text: JSON.stringify(proposal),
        },
      },
      { out: { type: "turn.completed" } },
      { writeSrc: writeOut },
      { exit: 0 },
    ],
  }));
  try {
    assert.equal(absent.receipt.usage.status, "ambiguous-zero");
    assert.equal(absent.snapshot.budgets.harnessAmbiguousZero, 1);
  } finally {
    close(absent);
  }
  // Interrupted (no terminal): unknown, never ambiguous-zero.
  const interrupted = await runScenario("P09-interrupted", ({ proposal }) => ({
    script: [
      { thread: {} },
      { turnStarted: {} },
      {
        itemCompleted: {
          id: "item_final",
          itemType: "agent_message",
          text: JSON.stringify(proposal),
        },
      },
      { exit: 1 },
    ],
  }));
  try {
    assert.equal(interrupted.receipt.usage.status, "unknown");
    assert.equal(interrupted.snapshot.budgets.unknownActions, 1);
  } finally {
    close(interrupted);
  }
  // Negative / fractional / inconsistent-subset counts reject and never fabricate numbers.
  const invalids = [
    ["negative", { input_tokens: -5, output_tokens: 10 }],
    ["fractional", { input_tokens: 1.5, output_tokens: 10 }],
    [
      "cache-superset",
      { input_tokens: 100, output_tokens: 50, cached_input_tokens: 200 },
    ],
    [
      "reasoning-trap",
      { input_tokens: 100, output_tokens: 50, reasoning_output_tokens: 80 },
    ],
  ];
  for (const [name, usage] of invalids) {
    const ctx = await runScenario(`P09-invalid-${name}`, ({ proposal }) =>
      successScript(proposal, { writeSrc: writeOut, usage }),
    );
    try {
      assert.equal(ctx.settlement.classification, "unresolved", name);
      assert.match(detail(ctx), /codex-usage-/, name);
      assert.equal(ctx.receipt.usage.status, "unknown", name);
      assert.equal(ctx.snapshot.head, "head-1", name);
    } finally {
      close(ctx);
    }
  }
  // Positive valid subsets map with the never-added-twice rule.
  const ok = await runScenario("P09-subsets", ({ proposal }) =>
    successScript(proposal, {
      writeSrc: writeOut,
      usage: {
        input_tokens: 500,
        cached_input_tokens: 300,
        cache_write_input_tokens: 50,
        output_tokens: 100,
        reasoning_output_tokens: 20,
      },
    }),
  );
  try {
    assert.equal(ok.receipt.usage.status, "reported");
    assert.equal(ok.snapshot.budgets.harnessReportedTokens, 600);
    const usage = ok.f.store.effect(ok.action.key).receipt.usage;
    assert.deepEqual(usage.components, {
      input: 500,
      cachedInput: 300,
      cacheWriteInput: 50,
      output: 100,
      reasoningOutput: 20,
    });
  } finally {
    close(ok);
  }
});

test("P09b reported overrun is retained unclipped; the threshold stops the next agent action while local verify/observe_ci continue (F09/S08)", async () => {
  const f = codexFixture("P09b-overrun", { threshold: 100 });
  try {
    baselinePass(f);
    const action = schedule(f, "implement");
    const proposal = finalProposal(action, "implementer", "changed");
    const { plan, pending } = dispatchCodex(
      f,
      action,
      successScript(proposal, {
        writeSrc: writeOut,
        usage: {
          input_tokens: 80,
          output_tokens: 40,
          cached_input_tokens: 30,
          cache_write_input_tokens: 0,
          reasoning_output_tokens: 10,
        },
      }),
    );
    const snapshot = await settleCodex(f, action, pending);
    // The 120 total (> threshold 100, > planning allowance) is retained in full, never clipped.
    assert.equal(snapshot.budgets.harnessReportedTokens, 120);
    assert.equal(snapshot.stage, "verifying");
    assert.equal(snapshot.blocker, null);
    // The durable effect receipt retains the exact unclipped components.
    const usage = f.store.effect(action.key).receipt.usage;
    assert.deepEqual(usage.components, {
      input: 80,
      cachedInput: 30,
      cacheWriteInput: 0,
      output: 40,
      reasoningOutput: 10,
    });
    // Local (non-agent) verify still runs within its own limits after the usage stop.
    apply(f.store, f.lease, { type: "schedule", kind: "verify" });
    finish(f, { usage: localUsage() });
    const verified = registerReceipt(f, "checks");
    assert.equal(verified.stage, "awaiting_delivery_evidence");
    // The next AUTOMATIC AGENT action is blocked by the reached threshold, without charge.
    const before = f.store.coordinatorSnapshot(f.lease.runId);
    const blocked = apply(f.store, f.lease, {
      type: "schedule",
      kind: "review",
    });
    assert.equal(blocked.execution, null);
    assert.equal(blocked.blocker?.kind, "budget");
    assert.equal(
      blocked.blocker?.detail,
      "subscription-reported-threshold-reached",
    );
    assert.equal(
      blocked.budgets.harnessReportedTokens,
      before.budgets.harnessReportedTokens,
    );
    // CI observation (local, non-agent) remains reachable after the agent stop.
    const observe = apply(f.store, f.lease, {
      type: "schedule",
      kind: "observe_ci",
    });
    assert.equal(observe.execution?.kind, "observe_ci");
    void plan;
  } finally {
    await closeFixture(f);
  }
});

test("P10 forbidden and unknown item types reject (S02/S04)", async () => {
  for (const itemType of ["mcp_tool_call", "collab_tool_call", "web_search"]) {
    const ctx = await runScenario(`P10-${itemType}`, ({ proposal }) => {
      const frames = completeFrames(proposal);
      const idx = frames.findIndex((s) => s.turnCompleted !== undefined);
      frames.splice(idx, 0, {
        itemCompleted: { id: "item_x", itemType, text: "x" },
      });
      return { script: frames };
    });
    try {
      assert.equal(ctx.settlement.classification, "policy-denied", itemType);
      assert.match(detail(ctx), /forbidden-item/, itemType);
      assert.equal(ctx.snapshot.head, "head-1", itemType);
    } finally {
      close(ctx);
    }
  }
  const unknown = await runScenario("P10-unknown-item", ({ proposal }) => {
    const frames = completeFrames(proposal);
    const idx = frames.findIndex((s) => s.turnCompleted !== undefined);
    frames.splice(idx, 0, {
      itemCompleted: { id: "item_u", itemType: "totally_unknown_item" },
    });
    return { script: frames };
  });
  try {
    assert.equal(unknown.settlement.classification, "unresolved");
    assert.match(detail(unknown), /unknown-item-type/);
  } finally {
    close(unknown);
  }
});

test("P11 no fabricated turn id / RPC ids / server-request map; only thread_id is exposed (S04)", async () => {
  const ctx = await runScenario("P11-not-exposed", ({ proposal }) =>
    successScript(proposal, { writeSrc: writeOut }),
  );
  try {
    const exposed = ctx.receipt.threadIdentity.notExposed;
    for (const field of [
      "turn id",
      "turn.error:null",
      "JSON-RPC request ids",
      "pending-server-request map",
      "continuous usage",
    ])
      assert.ok(exposed.includes(field), `missing notExposed ${field}`);
    assert.equal(typeof ctx.receipt.threadIdentity.threadId, "string");
    // No turn id or RPC id was invented anywhere in the settlement/receipt.
    assert.equal(ctx.receipt.settlement.classification, "complete");
    assert.equal(ctx.receipt.result.turnCompletedUsageSha256 !== null, true);
  } finally {
    close(ctx);
  }
});

test("P12 a source-defined declined status is a policy denial; an ordinary nonzero exit is not (S02/S04)", async () => {
  // A declined command (the #89/853 declined route; the exact native file_change denial form is
  // gated N03 and is never invented here) rejects as policy.
  const declined = await runScenario("P12-declined", ({ proposal }) => {
    const frames = completeFrames(proposal);
    const idx = frames.findIndex((s) => s.turnCompleted !== undefined);
    frames.splice(
      idx,
      0,
      {
        itemStarted: {
          id: "item_d",
          itemType: "command_execution",
          command: "rm",
        },
      },
      {
        itemCompleted: {
          id: "item_d",
          itemType: "command_execution",
          command: "rm",
          status: "declined",
        },
      },
    );
    return { script: frames };
  });
  try {
    assert.equal(declined.settlement.classification, "policy-denied");
    assert.match(detail(declined), /item-declined:command_execution:item_d/);
    assert.equal(declined.receipt.settlement.outcome, "failed");
    assert.equal(declined.snapshot.head, "head-1");
  } finally {
    close(declined);
  }
  // An ordinary nonzero exit is NOT a denial: it is a retained ordinary failure (paired control).
  const ordinary = await runScenario("P12-ordinary", ({ proposal }) =>
    successScript(proposal, {
      writeSrc: writeOut,
      ordinary: [
        {
          itemStarted: {
            id: "item_o",
            itemType: "command_execution",
            command: "false",
          },
        },
        {
          itemCompleted: {
            id: "item_o",
            itemType: "command_execution",
            command: "false",
            status: "completed",
            exit_code: 1,
            aggregated_output: "nonzero but settled",
          },
        },
      ],
    }),
  );
  try {
    assert.equal(ordinary.settlement.classification, "complete");
    assert.deepEqual(ordinary.receipt.stream.ordinaryFailures, [
      { id: "item_o", itemType: "command_execution", exitCode: 1 },
    ]);
  } finally {
    close(ordinary);
  }
  void defaultUsage;
});
