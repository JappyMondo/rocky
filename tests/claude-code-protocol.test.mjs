// Taskbot #97 protocol tests: CC06-CC11 stream-json classification against the frozen
// rocky-claude-code-95-v1 contract, driven by the owned fake CLI over REAL spawned processes and
// real SQLite stores (F05-F11 protocol rules). Every run is an owned-fake-cli evidence class:
// no native binary, no credentials, no network, no model calls.
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeFixture,
  closeFixture,
  baselinePass,
  implementChanged,
  schedule,
  finalProposal,
  successScript,
  dispatchClaude,
  settleClaude,
  readReceipt,
  fakeRecord,
  apiRetryFrame,
  permissionDeniedFrame,
  deriveTreeHead,
  localUsage,
  syntheticReported,
  apply,
  finish,
  receipt as registerReceipt,
  TEST_MODEL,
} from "./claude-code-support.mjs";

async function runScenario(name, scriptFn, options = {}) {
  const f = claudeFixture(name, options.fixture);
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
    const { plan, pending } = dispatchClaude(f, action, script, options);
    const snapshot = await settleClaude(f, action, pending);
    const command = f.store.commands(f.lease.runId).at(-1);
    ctx.action = action;
    ctx.role = role;
    ctx.plan = plan;
    ctx.proposal = proposal;
    ctx.snapshot = snapshot;
    ctx.command = command;
    ctx.receipt = readReceipt(plan, command.id);
    ctx.settlement = ctx.receipt.settlement;
    return ctx;
  } catch (error) {
    await closeFixture(f);
    throw error;
  }
}
const close = (ctx) => closeFixture(ctx.f);
const detail = (ctx) => ctx.receipt.settlement.detail;

test("P01 complete positive control: full conjunction yields a protocol-qualified PROPOSAL only (F05/CC06/CC07/CC08)", async () => {
  const ctx = await runScenario("P01-success", ({ proposal }) =>
    successScript(proposal, {
      writeSrc: { path: "output.txt", content: "bounded change\n" },
      afterInit: [apiRetryFrame, { ...apiRetryFrame, attempt: 2 }],
    }),
  );
  try {
    const { f, plan, snapshot, receipt, action, proposal } = ctx;
    assert.equal(receipt.settlement.classification, "complete");
    assert.equal(snapshot.blocker, null);
    assert.equal(snapshot.stage, "verifying");
    // The head is host-derived from the staged tree, never from the model's final message.
    assert.equal(snapshot.head, deriveTreeHead(plan.paths.src));
    assert.notEqual(snapshot.head, "head-1");
    assert.deepEqual(receipt.head, {
      pre: plan.headPre,
      post: deriveTreeHead(plan.paths.src),
    });
    // The proposal is retained but establishes no authority: head adoption invalidates all
    // receipts, and the model final registered no checks/CI/review receipt of any kind.
    assert.deepEqual(receipt.result.proposal, proposal);
    assert.deepEqual(Object.keys(snapshot.receipts), []);
    // Usage: reported from the single terminal result only; cache/thinking subsets never added.
    assert.equal(snapshot.budgets.harnessReportedTokens, 1540);
    assert.equal(snapshot.budgets.harnessAmbiguousZero, 0);
    assert.equal(snapshot.budgets.unknownActions, 0);
    assert.deepEqual(snapshot.unqualifiedResults, []);
    const usage = f.store.effect(action.key).receipt.usage;
    assert.deepEqual(usage, {
      schema: 2,
      status: "reported",
      source: "native-harness-telemetry",
      harness: "claude-code",
      receipt: usage.receipt,
      components: {
        input: 1200,
        cachedInput: 800,
        cacheWriteInput: 100,
        output: 340,
        reasoningOutput: 40,
      },
    });
    // The usage receipt is the sha256 of the retained raw terminal result line.
    const stdoutRaw = readFileSync(receipt.stream.rawStdoutLog, "utf8");
    const resultLine = stdoutRaw
      .split("\n")
      .find((line) => line.includes('"type":"result"'));
    const { createHash } = await import("node:crypto");
    assert.equal(
      usage.receipt,
      createHash("sha256").update(resultLine, "utf8").digest("hex"),
    );
    // api_retry events are accepted with the retries recorded (decision D-05), never fatal.
    assert.equal(receipt.stream.apiRetries.length, 2);
    // Separated lifecycle records: exit 0, both carrier EOFs, both child EOFs, decoder complete,
    // quiescence, recorded separately in the receipt.
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
    assert.equal(
      readFileSync(join(plan.paths.parentTmp, "fake-stdin.log"), "utf8"),
      JSON.stringify(
        successScript(proposal, {
          writeSrc: { path: "output.txt", content: "bounded change\n" },
          afterInit: [apiRetryFrame, { ...apiRetryFrame, attempt: 2 }],
        }),
      ),
    );
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
    // init identity conjunction recorded.
    assert.equal(receipt.initIdentity.apiKeySource, "none");
    assert.equal(receipt.initIdentity.claude_code_version, "2.1.283");
    assert.equal(receipt.initIdentity.cwd, plan.bundle.cwd);
    assert.equal(receipt.initIdentity.permissionMode, "dontAsk");
    assert.deepEqual(receipt.initIdentity.mcp_servers, []);
    assert.deepEqual(receipt.initIdentity.plugins, []);
    // Binary identity measured at C0 and re-measured at C5; discovery drift empty.
    assert.equal(receipt.binary.measuredC0.sha256, f.binary.sha256);
    assert.equal(receipt.binary.measuredC5.sha256, f.binary.sha256);
    assert.deepEqual(receipt.discovery.drift, []);
    // Receipt honesty: gates remain open gaps; evidence class is owned-fake-cli.
    assert.equal(receipt.evidenceClass, "owned-fake-cli");
    const gates = receipt.gaps.map((g) => g.gate);
    for (const gate of [
      "G-SET",
      "G-EFFORT",
      "G-INIT-VALUES",
      "G-MODEL",
      "G-KC",
      "G-SIGINT",
      "G-WRITES",
      "L01-L04",
      "N01-N06",
    ])
      assert.ok(gates.includes(gate), `missing gap ${gate}`);
    // total_cost_usd/num_turns stay informational telemetry in the receipt, never usage inputs.
    assert.equal(receipt.result.fields.total_cost_usd, 0.0123);
    assert.equal(receipt.result.fields.num_turns, 3);
    assert.equal(receipt.usage.status, "reported");
    // The served model is read from the stream, and equals the requested role-table model.
    assert.equal(receipt.initIdentity.model, TEST_MODEL);
    assert.deepEqual(Object.keys(receipt.result.fields.modelUsage), [
      TEST_MODEL,
    ]);
  } finally {
    close(ctx);
  }
});

test("P02 fragmented multibyte UTF-8 across frame boundaries decodes identically (F05/CC06)", async () => {
  const ctx = await runScenario("P02-fragmented", ({ proposal }) => ({
    script: [
      { initFrag: { size: 1, init: { note: "fragmented-ü-世界-🜀" } } },
      { toolUse: { id: "tu_1", name: "Bash" } },
      { toolResult: { id: "tu_1", content: "ok-ü" } },
      {
        toolUse: { id: "tu_s", name: "StructuredOutput", input: proposal },
      },
      { toolResult: { id: "tu_s" } },
      { resultFrag: { size: 3, result: { structured_output: proposal } } },
      { exit: 0 },
    ],
  }));
  try {
    assert.equal(ctx.settlement.classification, "complete");
    assert.equal(ctx.snapshot.blocker, null);
    assert.equal(ctx.snapshot.stage, "verifying");
  } finally {
    close(ctx);
  }
});

test("P03 reviewer role: read-only roster and --restricted compose; a head mismatch stays unexpected-result (CC03/CC08)", async () => {
  const f = claudeFixture("P03-reviewer");
  try {
    implementChanged(f);
    const action = schedule(f, "review");
    const proposal = finalProposal(action, "reviewer", "complete");
    const { plan, pending } = dispatchClaude(
      f,
      action,
      successScript(proposal, { role: "reviewer", tool: "Read" }),
    );
    assert.ok(plan.bundle.argv.includes("--restricted"));
    assert.ok(plan.bundle.argv.includes("--tools=Read,Glob,Grep"));
    for (const element of plan.bundle.argv)
      assert.ok(!element.startsWith("--add-dir"));
    assert.equal(plan.role, "reviewer");
    // The fresh reviewer SRC derives the empty-tree head, which differs from the implemented
    // snapshot head: the protocol run completes, but the reducer must refuse the head binding.
    const snapshot = await settleClaude(f, action, pending);
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

test("P03b reviewer with a host-staged matching head: complete result adopts no head change (CC03/CC08)", async () => {
  // The host stages the exact current-head tree into SRC, so the derived head must match.
  const staged = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), "claude97-staged-")),
  );
  writeFileSync(join(staged, "review-file.txt"), "reviewed tree\n");
  const stagedHead = deriveTreeHead(staged);
  const emptyDir = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), "claude97-empty-")),
  );
  const emptyHead = deriveTreeHead(emptyDir);
  const g = claudeFixture("P03b-reviewer", { head: emptyHead });
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
    const { plan, pending } = dispatchClaude(
      g,
      action,
      successScript(proposal, { role: "reviewer", tool: "Read" }),
      {
        stage: (src) =>
          writeFileSync(join(src, "review-file.txt"), "reviewed tree\n"),
      },
    );
    const snapshot = await settleClaude(g, action, pending);
    assert.equal(snapshot.blocker, null);
    assert.equal(snapshot.head, stagedHead);
    const command = g.store.commands(g.lease.runId).at(-1);
    const receipt = readReceipt(plan, command.id);
    assert.equal(receipt.settlement.classification, "complete");
    assert.equal(receipt.settlement.outcome, "complete");
    assert.deepEqual(receipt.result.proposal, proposal);
    assert.equal(receipt.usage.status, "reported");
    // A reviewer proposal never registers checks/CI/review authority by itself; the only
    // receipts are the host-registered ones (the baseline receipt was invalidated by the
    // earlier head adoption, per the existing coordinator semantics).
    assert.deepEqual(Object.keys(snapshot.receipts).sort(), ["checks"]);
  } finally {
    await closeFixture(g);
  }
});

test("P04 result subtype, is_error and exit-code matrix: exit code alone is never success evidence (F06/CC09)", async () => {
  // (a) exit 0 with NO result classifies unresolved/unknown despite exit 0.
  const a = await runScenario("P04a", () => ({
    script: [{ init: {} }, { exit: 0 }],
  }));
  try {
    assert.equal(a.settlement.classification, "unresolved");
    assert.match(detail(a), /no-result-exit-zero/);
    assert.equal(a.snapshot.blocker?.kind, "recovery");
    assert.equal(a.receipt.usage.status, "unknown");
    assert.equal(a.receipt.lifecycle.exitCode, 0);
  } finally {
    close(a);
  }
  // (b) success subtype with is_error:true and exit 1: rejected; subtype and is_error evaluated
  // independently; telemetry still reported because the lifecycle is resolved.
  const b = await runScenario("P04b", ({ proposal }) =>
    successScript(proposal, {
      result: { is_error: true },
      exit: 1,
      writeSrc: { path: "b.txt", content: "b\n" },
    }),
  );
  try {
    assert.equal(b.settlement.classification, "unresolved");
    assert.match(detail(b), /success-with-is-error/);
    assert.equal(b.snapshot.blocker?.kind, "needs_engineering");
    assert.equal(b.receipt.usage.status, "reported");
    assert.equal(b.snapshot.budgets.harnessReportedTokens, 1540);
    assert.equal(b.snapshot.head, "head-1");
  } finally {
    close(b);
  }
  // (c) every failure subtype rejects; subtype and is_error are evaluated independently.
  for (const subtype of [
    "error_max_turns",
    "error_during_execution",
    "error_max_budget_usd",
    "error_max_structured_output_retries",
  ]) {
    const c = await runScenario(`P04c-${subtype}`, () => ({
      script: [{ init: {} }, { result: { subtype } }, { exit: 0 }],
    }));
    try {
      assert.equal(c.settlement.classification, "unresolved");
      assert.match(detail(c), new RegExp(`result-subtype:${subtype}`));
      assert.equal(c.receipt.settlement.outcome, "failed");
      assert.equal(c.snapshot.blocker?.kind, "needs_engineering");
      // The lifecycle is resolved, so the honest positive telemetry is still reported.
      assert.equal(c.receipt.usage.status, "reported");
    } finally {
      close(c);
    }
  }
  // (d) success without structured_output is failure.
  const d = await runScenario("P04d", () => ({
    script: [{ init: {} }, { result: {} }, { exit: 0 }],
  }));
  try {
    assert.equal(d.settlement.classification, "unresolved");
    assert.match(detail(d), /missing-structured-output/);
    assert.equal(d.receipt.settlement.outcome, "failed");
  } finally {
    close(d);
  }
  // (e) schema-valid structured_output bound to the wrong action/input/role rejects.
  const e = await runScenario("P04e", ({ proposal }) =>
    successScript({ ...proposal, actionKey: `${proposal.actionKey}-other` }),
  );
  try {
    assert.equal(e.settlement.classification, "unresolved");
    assert.match(detail(e), /structured-output-binding/);
  } finally {
    close(e);
  }
  const e2 = await runScenario("P04e2", ({ proposal }) =>
    successScript({ ...proposal, inputDigest: "0".repeat(64) }),
  );
  try {
    assert.match(detail(e2), /structured-output-binding/);
  } finally {
    close(e2);
  }
  const e3 = await runScenario("P04e3", ({ proposal }) =>
    successScript({ ...proposal, summary: "" }),
  );
  try {
    assert.match(detail(e3), /structured-output-invalid/);
  } finally {
    close(e3);
  }
  const e4 = await runScenario("P04e4", ({ proposal }) =>
    successScript({ ...proposal, extra: "field" }),
  );
  try {
    assert.match(detail(e4), /structured-output-invalid/);
  } finally {
    close(e4);
  }
  // (f) exit 1 after an otherwise valid success result: exit-matrix violation, never success.
  const fCase = await runScenario("P04f", ({ proposal }) =>
    successScript(proposal, {
      exit: 1,
      writeSrc: { path: "f.txt", content: "f\n" },
    }),
  );
  try {
    assert.equal(fCase.settlement.classification, "unresolved");
    assert.match(detail(fCase), /exit-matrix-violation/);
    assert.equal(fCase.receipt.usage.status, "unknown");
    assert.equal(fCase.snapshot.blocker?.kind, "recovery");
    assert.equal(fCase.snapshot.head, "head-1");
  } finally {
    close(fCase);
  }
  // (g) startup refusal with startup_failure_reason is fatal...
  const g1 = await runScenario("P04g1", () => ({
    script: [
      { init: {} },
      {
        result: {
          subtype: "error_during_execution",
          startup_failure_reason: "sandbox_unavailable",
          modelUsage: {},
        },
      },
      { exit: 1 },
    ],
  }));
  try {
    assert.equal(g1.settlement.classification, "fatal");
    assert.match(detail(g1), /startup-failure/);
    assert.equal(g1.receipt.usage.status, "unknown");
  } finally {
    close(g1);
  }
  // ...and without it: stderr plus nonzero exit only — still fatal, zero frames.
  const g2 = await runScenario("P04g2", () => ({
    script: [
      {
        err: "Error: When using --print, --output-format=stream-json requires --verbose\n",
      },
      { exit: 1 },
    ],
  }));
  try {
    assert.equal(g2.settlement.classification, "fatal");
    assert.match(detail(g2), /startup-refusal/);
    assert.equal(g2.receipt.usage.status, "unknown");
    assert.equal(g2.receipt.initIdentity, null);
  } finally {
    close(g2);
  }
});

test("P05 tool_use/tool_result pairing and source-defined denials (F07/CC08)", async () => {
  // tool_use without tool_result: unresolved.
  const a = await runScenario("P05a", ({ proposal }) => ({
    script: [
      { init: {} },
      { toolUse: { id: "tu_1", name: "Bash" } },
      { result: { structured_output: proposal } },
      { exit: 0 },
    ],
  }));
  try {
    assert.equal(a.settlement.classification, "unresolved");
    assert.match(detail(a), /tool-use-unresolved:Bash:tu_1/);
  } finally {
    close(a);
  }
  // Duplicate tool_result for one tool_use_id.
  const b = await runScenario("P05b", ({ proposal }) => ({
    script: [
      { init: {} },
      { toolUse: { id: "tu_1", name: "Bash" } },
      { toolResult: { id: "tu_1" } },
      { toolResult: { id: "tu_1" } },
      { result: { structured_output: proposal } },
      { exit: 0 },
    ],
  }));
  try {
    assert.match(detail(b), /duplicate-tool-result:tu_1/);
  } finally {
    close(b);
  }
  // Orphan tool_result with an unseen id.
  const c = await runScenario("P05c", ({ proposal }) => ({
    script: [
      { init: {} },
      { toolResult: { id: "tu_ghost" } },
      { result: { structured_output: proposal } },
      { exit: 0 },
    ],
  }));
  try {
    assert.match(detail(c), /orphan-tool-result:tu_ghost/);
  } finally {
    close(c);
  }
  // result.permission_denials is the authoritative denial form: with and without the event.
  const denialResult = (proposal) => ({
    permission_denials: [
      { tool_name: "Bash", tool_use_id: "tu_d", tool_input: { command: "rm" } },
    ],
    structured_output: proposal,
  });
  const d1 = await runScenario("P05d1", ({ proposal }) => ({
    script: [
      { init: {} },
      { toolUse: { id: "tu_d", name: "Bash" } },
      { out: { ...permissionDeniedFrame, tool_use_id: "tu_d" } },
      { toolResult: { id: "tu_d", isError: true, content: "denied" } },
      { result: denialResult(proposal) },
      { exit: 0 },
    ],
  }));
  try {
    assert.equal(d1.settlement.classification, "policy-denied");
    assert.match(detail(d1), /system-permission-denied/);
    assert.equal(d1.receipt.stream.permissionDeniedEvents.length, 1);
    assert.equal(d1.receipt.result.fields.permission_denials.length, 1);
    // The denied tool failure is NOT counted as an ordinary failure.
    assert.deepEqual(d1.receipt.stream.ordinaryFailures, []);
    assert.equal(d1.snapshot.blocker?.kind, "needs_engineering");
  } finally {
    close(d1);
  }
  const d2 = await runScenario("P05d2", ({ proposal }) => ({
    script: [
      { init: {} },
      { toolUse: { id: "tu_d", name: "Bash" } },
      { toolResult: { id: "tu_d", isError: true, content: "denied" } },
      { result: denialResult(proposal) },
      { exit: 0 },
    ],
  }));
  try {
    assert.equal(d2.settlement.classification, "policy-denied");
    assert.match(detail(d2), /result-permission-denials/);
  } finally {
    close(d2);
  }
  // A permission_denied event alone rejects.
  const d3 = await runScenario("P05d3", ({ proposal }) => ({
    script: [
      { init: {} },
      { toolUse: { id: "tu_d", name: "Bash" } },
      { out: permissionDeniedFrame },
      { toolResult: { id: "tu_d", isError: true } },
      { result: { structured_output: proposal } },
      { exit: 0 },
    ],
  }));
  try {
    assert.equal(d3.settlement.classification, "policy-denied");
    assert.match(detail(d3), /system-permission-denied/);
  } finally {
    close(d3);
  }
  // Off-roster tool_use rejects as policy for each sampled forbidden family.
  for (const tool of ["Agent", "WebFetch", "mcp__x__y", "Skill", "Task"]) {
    const e = await runScenario(
      `P05e-${tool.replace(/[^a-z0-9]/gi, "-")}`,
      ({ proposal }) => ({
        script: [
          { init: {} },
          { toolUse: { id: "tu_x", name: tool } },
          { toolResult: { id: "tu_x" } },
          { result: { structured_output: proposal } },
          { exit: 0 },
        ],
      }),
    );
    try {
      assert.equal(e.settlement.classification, "policy-denied");
      assert.match(
        detail(e),
        new RegExp(
          `off-roster-tool:${tool.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
        ),
      );
    } finally {
      close(e);
    }
  }
  // A denied/declined StructuredOutput rejects as policy.
  const g = await runScenario("P05g", () => ({
    script: [
      { init: {} },
      { toolUse: { id: "tu_s", name: "StructuredOutput" } },
      { toolResult: { id: "tu_s", isError: true, content: "declined" } },
      { result: { subtype: "error_max_structured_output_retries" } },
      { exit: 1 },
    ],
  }));
  try {
    assert.equal(g.settlement.classification, "policy-denied");
    assert.match(detail(g), /structured-output-denied/);
  } finally {
    close(g);
  }
  // Duplicate tool_use ids reject as unresolved.
  const h = await runScenario("P05h", ({ proposal }) => ({
    script: [
      { init: {} },
      { toolUse: { id: "tu_1", name: "Bash" } },
      { toolUse: { id: "tu_1", name: "Read" } },
      { toolResult: { id: "tu_1" } },
      { result: { structured_output: proposal } },
      { exit: 0 },
    ],
  }));
  try {
    assert.match(detail(h), /tool-use-id-duplicate/);
  } finally {
    close(h);
  }
  // Positive controls: settled ordinary failures do NOT alone reject a later bound proposal.
  const i1 = await runScenario("P05i1", ({ proposal }) =>
    successScript(proposal, {
      writeSrc: { path: "i1.txt", content: "i1\n" },
      ordinary: [
        { toolUse: { id: "tu_f1", name: "Bash" } },
        {
          toolResult: {
            id: "tu_f1",
            isError: true,
            content:
              "npm test exited 1: sandbox denied write to /Library/Forbidden (ordinary output)",
          },
        },
      ],
    }),
  );
  try {
    assert.equal(i1.settlement.classification, "complete");
    assert.equal(i1.snapshot.blocker, null);
    assert.deepEqual(i1.receipt.stream.ordinaryFailures, [
      { toolUseId: "tu_f1", tool: "Bash" },
    ]);
  } finally {
    close(i1);
  }
  // Edit old_string mismatch then a corrected Edit with a DISTINCT tool_use_id.
  const i2 = await runScenario("P05i2", ({ proposal }) =>
    successScript(proposal, {
      writeSrc: { path: "i2.txt", content: "i2\n" },
      ordinary: [
        { toolUse: { id: "tu_e1", name: "Edit" } },
        {
          toolResult: {
            id: "tu_e1",
            isError: true,
            content: "old_string not found",
          },
        },
        { toolUse: { id: "tu_e2", name: "Edit" } },
        { toolResult: { id: "tu_e2", content: "edited" } },
      ],
    }),
  );
  try {
    assert.equal(i2.settlement.classification, "complete");
    assert.deepEqual(i2.receipt.stream.ordinaryFailures, [
      { toolUseId: "tu_e1", tool: "Edit" },
    ]);
    // The original failure record stays retained and immutable in the receipt.
    assert.equal(i2.receipt.stream.toolUseCount, 4);
  } finally {
    close(i2);
  }
});

test("P06 init identity and provider/model fatal gates (F08/CC02/CC08)", async () => {
  const initCase = async (name, initOverride, pattern, classification) => {
    const ctx = await runScenario(name, ({ proposal }) =>
      successScript(proposal, {
        init: initOverride,
        writeSrc: { path: "x.txt", content: "x\n" },
      }),
    );
    try {
      assert.equal(ctx.settlement.classification, classification);
      assert.match(detail(ctx), pattern);
      assert.equal(ctx.receipt.settlement.outcome, "failed");
      // The head is never adopted for a rejected run.
      assert.equal(ctx.snapshot.head, "head-1");
      // A rejected run records the subscription-exclusivity breach for auth-signal faults.
      return ctx.receipt;
    } finally {
      close(ctx);
    }
  };
  for (const apiKeySource of [
    "ANTHROPIC_API_KEY",
    "apiKeyHelper",
    "/login managed key",
  ])
    await initCase(
      `P06-key-${apiKeySource.replace(/[^a-z0-9]/gi, "-")}`,
      { apiKeySource },
      /init-api-key-source/,
      "fatal",
    );
  await initCase(
    "P06-version",
    { claude_code_version: "2.1.236" },
    /init-version-drift/,
    "fatal",
  );
  await initCase(
    "P06-cwd",
    { cwd: "/tmp/elsewhere" },
    /init-cwd/,
    "unresolved",
  );
  await initCase(
    "P06-mode",
    { permissionMode: "acceptEdits" },
    /init-permission-mode/,
    "unresolved",
  );
  await initCase(
    "P06-mcp",
    { mcp_servers: [{ name: "evil" }] },
    /init-mcp-servers/,
    "unresolved",
  );
  await initCase(
    "P06-plugins",
    { plugins: ["evil"] },
    /init-plugins/,
    "unresolved",
  );
  await initCase(
    "P06-skills",
    { skills: ["evil-skill"] },
    /init-skills/,
    "unresolved",
  );
  await initCase(
    "P06-slash",
    { slash_commands: ["/evil"] },
    /init-slash-commands/,
    "unresolved",
  );
  await initCase(
    "P06-roster",
    { tools: ["Read"] },
    /init-tools-roster/,
    "unresolved",
  );
  await initCase(
    "P06-session",
    { session_id: "   " },
    /init-session-blank/,
    "unresolved",
  );
  // modelUsage provider and silent-fallback key mismatches are fatal.
  for (const provider of [
    "bedrock",
    "vertex",
    "foundry",
    "anthropicAws",
    "mantle",
    "gateway",
  ]) {
    const ctx = await runScenario(`P06-provider-${provider}`, ({ proposal }) =>
      successScript(proposal, {
        result: {
          structured_output: proposal,
          modelUsage: {
            $model: {
              inputTokens: 10,
              outputTokens: 5,
              provider,
            },
          },
        },
        writeSrc: { path: "p.txt", content: "p\n" },
      }),
    );
    try {
      assert.equal(ctx.settlement.classification, "fatal");
      assert.match(detail(ctx), /model-usage-provider/);
      assert.equal(ctx.receipt.usage.status, "unknown");
    } finally {
      close(ctx);
    }
  }
  const fallback = await runScenario("P06-fallback", ({ proposal }) =>
    successScript(proposal, {
      result: {
        structured_output: proposal,
        modelUsage: {
          "claude-other-model": {
            inputTokens: 10,
            outputTokens: 5,
            provider: "firstParty",
          },
        },
      },
      writeSrc: { path: "fb.txt", content: "fb\n" },
    }),
  );
  try {
    assert.equal(fallback.settlement.classification, "fatal");
    assert.match(detail(fallback), /model-usage-key-mismatch/);
  } finally {
    close(fallback);
  }
});

test("P07 framing, bounds and malformed stream garbage all reject with retained bounded evidence (F09/CC06)", async () => {
  // Frames after the result reject.
  const a = await runScenario("P07a", ({ proposal }) =>
    successScript(proposal, {
      post: [{ out: apiRetryFrame }],
      writeSrc: { path: "a.txt", content: "a\n" },
    }),
  );
  try {
    assert.equal(a.settlement.classification, "unresolved");
    assert.match(detail(a), /frame-after-result/);
    assert.equal(a.receipt.usage.status, "unknown");
    assert.equal(a.snapshot.head, "head-1");
  } finally {
    close(a);
  }
  // Two results (task-notification origin) reject.
  const b = await runScenario("P07b", ({ proposal }) =>
    successScript(proposal, {
      post: [{ result: { result_index: 1 } }],
      writeSrc: { path: "b.txt", content: "b\n" },
    }),
  );
  try {
    assert.match(detail(b), /multiple-results/);
  } finally {
    close(b);
  }
  // A result_index gap means a lost result.
  const c = await runScenario("P07c", ({ proposal }) =>
    successScript(proposal, {
      result: { structured_output: proposal, result_index: 1 },
      writeSrc: { path: "c.txt", content: "c\n" },
    }),
  );
  try {
    assert.match(detail(c), /result-index-gap/);
  } finally {
    close(c);
  }
  // Unknown types/subtypes off the reviewed allowlist reject, including the
  // observedButNotAdmittedByDefault members.
  for (const frame of [
    { type: "system", subtype: "informational", level: "info", content: "x" },
    { type: "system", subtype: "compact_boundary" },
    { type: "system", subtype: "status" },
    { type: "system", subtype: "hook_started" },
    { type: "system", subtype: "task_started" },
    { type: "rate_limit_event" },
    { type: "auth_status" },
    { type: "stream_event" },
    { type: "prompt_suggestion" },
    { type: "totally-unknown" },
  ]) {
    const label = `${frame.type}-${frame.subtype ?? "x"}`.replace(
      /[^a-z0-9]/gi,
      "-",
    );
    const ctx = await runScenario(`P07d-${label}`, ({ proposal }) =>
      successScript(proposal, {
        afterInit: [{ out: frame }],
        writeSrc: { path: "d.txt", content: "d\n" },
      }),
    );
    try {
      assert.equal(ctx.settlement.classification, "unresolved");
      assert.match(detail(ctx), /unknown-frame-type/);
    } finally {
      close(ctx);
    }
  }
  // Non-JSON garbage line.
  const e = await runScenario("P07e", ({ proposal }) =>
    successScript(proposal, {
      afterInit: [{ outText: "not json at all\n" }],
      writeSrc: { path: "e.txt", content: "e\n" },
    }),
  );
  try {
    assert.equal(e.settlement.classification, "unresolved");
    assert.match(
      detail(e),
      /transport-failure:duplex-malformed-frame|stream-decode:strict-malformed-frame/,
    );
    assert.equal(e.receipt.usage.status, "unknown");
  } finally {
    close(e);
  }
  // Invalid UTF-8 bytes.
  const invalid = Buffer.from('{"type":"system","bad":"', "utf8");
  const f = await runScenario("P07f", () => ({
    script: [
      { init: {} },
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
    assert.equal(f.settlement.classification, "unresolved");
    assert.match(
      detail(f),
      /transport-failure:duplex-malformed-frame|stream-decode:strict-invalid-utf8/,
    );
  } finally {
    close(f);
  }
  // Duplicate JSON keys within a frame: the transport decoder cannot see them, the adapter's
  // strict decoder rejects (never silently discarded).
  const g = await runScenario("P07g", () => ({
    script: [
      { init: {} },
      {
        outText:
          '{"type":"system","subtype":"api_retry","attempt":1,"attempt":2}\n',
      },
      { exit: 0 },
    ],
  }));
  try {
    assert.equal(g.settlement.classification, "unresolved");
    assert.match(detail(g), /stream-decode:strict-duplicate-key/);
  } finally {
    close(g);
  }
  // Truncated stream: partial last line then carrier EOF.
  const h = await runScenario("P07h", () => ({
    script: [{ init: {} }, { outText: '{"type":"result"' }, { exit: 0 }],
  }));
  try {
    assert.equal(h.settlement.classification, "unresolved");
    assert.match(
      detail(h),
      /transport-failure:duplex-partial-frame|stream-decode:strict-partial-line/,
    );
  } finally {
    close(h);
  }
  // Oversize line beyond the configured bound (the fake generates the pad at runtime so the
  // prompt itself stays small).
  const i = await runScenario("P07i", () => ({
    script: [{ init: {} }, { outPad: 70000 }, { exit: 0 }],
  }));
  try {
    assert.equal(i.settlement.classification, "unresolved");
    assert.match(
      detail(i),
      /transport-failure:duplex-frame-limit|stream-decode:strict-line-limit/,
    );
  } finally {
    close(i);
  }
  // Non-object JSON rejects.
  const j = await runScenario("P07j", () => ({
    script: [{ outText: "42\n" }, { init: {} }, { exit: 0 }],
  }));
  try {
    assert.equal(j.settlement.classification, "unresolved");
    assert.match(detail(j), /frame-not-object|init-not-first/);
  } finally {
    close(j);
  }
  // Many in-bound frames are accepted by the transport; a missing result still rejects.
  const k = await runScenario("P07k", () => ({
    script: [
      { init: {} },
      ...Array.from({ length: 40 }, (_, n) => ({
        out: {
          type: "system",
          subtype: "api_retry",
          attempt: n,
          max_retries: 40,
          retry_delay_ms: 1,
          error_status: 529,
          error: "overloaded",
        },
      })),
      { exit: 0 },
    ],
  }));
  try {
    assert.equal(k.settlement.classification, "unresolved");
    assert.match(detail(k), /no-result/);
    assert.equal(k.receipt.stream.apiRetries.length, 40);
  } finally {
    close(k);
  }
});

test("P07z stdout total-byte overflow trips the transport bound and rejects (F09/CC06)", async () => {
  const f = claudeFixture("P07z", {
    config: {
      limits: {
        maxTurns: 8,
        maxPromptBytes: 65536,
        maxArgvBytes: 65536,
        maxSettingsBytes: 65536,
        maxStdoutBytes: 8192,
        maxStderrBytes: 8192,
        maxLineBytes: 2048,
        maxFrames: 256,
        maxToolUses: 16,
        maxResultBytes: 2048,
        killGraceMs: 250,
        cleanupReserveMs: 250,
        quiescenceTimeoutMs: 2000,
        maxTreeNodes: 2000,
      },
    },
  });
  try {
    baselinePass(f);
    const action = schedule(f, "implement");
    const { plan, pending } = dispatchClaude(f, action, {
      script: [
        { init: {} },
        ...Array.from({ length: 30 }, () => ({
          outText: `{"type":"system","subtype":"api_retry","pad":"${"y".repeat(500)}"}\n`,
        })),
        { exit: 0 },
      ],
    });
    const snapshot = await settleClaude(f, action, pending);
    const command = f.store.commands(f.lease.runId).at(-1);
    const receipt = readReceipt(plan, command.id);
    assert.equal(receipt.settlement.classification, "unresolved");
    assert.match(
      receipt.settlement.detail,
      /transport-failure:duplex-output-limit|stream-decode:strict-stream-total-limit/,
    );
    assert.equal(receipt.usage.status, "unknown");
    assert.equal(snapshot.blocker?.kind, "recovery");
    assert.ok(receipt.stream.outputBytes <= 8192);
  } finally {
    await closeFixture(f);
  }
});

test("P08 assistant errors, aborts and api_retry acceptance (F10/CC08)", async () => {
  for (const error of [
    "authentication_failed",
    "oauth_org_not_allowed",
    "account_on_hold",
    "billing_error",
    "model_not_found",
  ]) {
    const ctx = await runScenario(`P08-fatal-${error}`, ({ proposal }) =>
      successScript(proposal, {
        afterInit: [{ assistantError: { error } }],
        writeSrc: { path: "e.txt", content: "e\n" },
      }),
    );
    try {
      assert.equal(ctx.settlement.classification, "fatal");
      assert.match(detail(ctx), new RegExp(`assistant-error:${error}`));
      assert.equal(ctx.receipt.settlement.outcome, "failed");
    } finally {
      close(ctx);
    }
  }
  const rateLimited = await runScenario("P08-rate-limit", ({ proposal }) =>
    successScript(proposal, {
      afterInit: [{ assistantError: { error: "rate_limit" } }],
      writeSrc: { path: "r.txt", content: "r\n" },
    }),
  );
  try {
    assert.equal(rateLimited.settlement.classification, "unresolved");
    assert.match(detail(rateLimited), /assistant-error:rate_limit/);
  } finally {
    close(rateLimited);
  }
  const unknownError = await runScenario("P08-unknown-error", ({ proposal }) =>
    successScript(proposal, {
      afterInit: [{ assistantError: { error: "not-in-the-reviewed-union" } }],
      writeSrc: { path: "u.txt", content: "u\n" },
    }),
  );
  try {
    assert.match(detail(unknownError), /assistant-error-unknown/);
  } finally {
    close(unknownError);
  }
  const aborted = await runScenario("P08-aborted", ({ proposal }) =>
    successScript(proposal, {
      afterInit: [{ aborted: true }],
      writeSrc: { path: "ab.txt", content: "ab\n" },
    }),
  );
  try {
    assert.equal(aborted.settlement.classification, "unresolved");
    assert.match(detail(aborted), /assistant-aborted/);
  } finally {
    close(aborted);
  }
  // api_retry-then-success is ACCEPTED with the retries recorded (decision D-05).
  const retry = await runScenario("P08-retry-success", ({ proposal }) =>
    successScript(proposal, {
      afterInit: [
        apiRetryFrame,
        { ...apiRetryFrame, attempt: 2, error_status: 500 },
        { ...apiRetryFrame, attempt: 3, error_status: 529 },
      ],
      writeSrc: { path: "ok.txt", content: "ok\n" },
    }),
  );
  try {
    assert.equal(retry.settlement.classification, "complete");
    assert.equal(retry.snapshot.blocker, null);
    assert.equal(retry.snapshot.stage, "verifying");
    assert.equal(retry.receipt.stream.apiRetries.length, 3);
    assert.equal(retry.receipt.stream.apiRetries[2].attempt, 3);
  } finally {
    close(retry);
  }
});

test("P09 usage mapping onto subscription-observed-v1 schema 2 (F11/CC10/CC11)", async () => {
  // All-zero modelUsage on a complete run: ambiguous-zero, head NOT adopted, recovery barrier.
  const zero = await runScenario("P09-zero", ({ proposal }) =>
    successScript(proposal, {
      result: {
        structured_output: proposal,
        modelUsage: {
          $model: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            thinkingTokens: 0,
            provider: "firstParty",
          },
        },
      },
      writeSrc: { path: "z.txt", content: "z\n" },
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
  // Absent modelUsage on a complete run: ambiguous-zero, never a known zero.
  const absent = await runScenario("P09-absent", ({ proposal }) =>
    successScript(proposal, {
      result: { structured_output: proposal, modelUsage: null },
      writeSrc: { path: "abs.txt", content: "abs\n" },
    }),
  );
  try {
    assert.equal(absent.receipt.usage.status, "ambiguous-zero");
    assert.equal(absent.snapshot.budgets.harnessAmbiguousZero, 1);
  } finally {
    close(absent);
  }
  // Zeroed crash-shaped telemetry on a non-success result: unknown, never ambiguous-zero.
  const zeroedCrash = await runScenario("P09-crash", () => ({
    script: [
      { init: {} },
      {
        result: {
          subtype: "error_during_execution",
          is_error: true,
          modelUsage: {
            $model: { inputTokens: 0, outputTokens: 0, provider: "firstParty" },
          },
        },
      },
      { exit: 1 },
    ],
  }));
  try {
    assert.equal(zeroedCrash.receipt.usage.status, "unknown");
    assert.match(
      zeroedCrash.receipt.usage.reason,
      /claude-telemetry-zeroed-non-success/,
    );
    assert.equal(zeroedCrash.snapshot.budgets.unknownActions, 1);
  } finally {
    close(zeroedCrash);
  }
  // Negative / fractional / unsafe / inconsistent counts reject and never fabricate numbers.
  const invalids = [
    ["negative", { inputTokens: -5, outputTokens: 10, provider: "firstParty" }],
    [
      "fractional",
      { inputTokens: 1.5, outputTokens: 10, provider: "firstParty" },
    ],
    [
      "unsafe",
      {
        inputTokens: Number.MAX_SAFE_INTEGER,
        outputTokens: Number.MAX_SAFE_INTEGER,
        provider: "firstParty",
      },
    ],
    [
      "thinking-trap",
      {
        inputTokens: 100,
        outputTokens: 50,
        thinkingTokens: 80,
        provider: "firstParty",
      },
    ],
    [
      "cache-superset",
      {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 200,
        provider: "firstParty",
      },
    ],
  ];
  for (const [name, modelUsage] of invalids) {
    const ctx = await runScenario(`P09-invalid-${name}`, ({ proposal }) =>
      successScript(proposal, {
        result: {
          structured_output: proposal,
          modelUsage: { $model: modelUsage },
        },
        writeSrc: { path: `${name}.txt`, content: "x\n" },
      }),
    );
    try {
      assert.equal(ctx.settlement.classification, "unresolved");
      assert.match(detail(ctx), /claude-usage-/);
      assert.equal(ctx.receipt.usage.status, "unknown");
      assert.equal(ctx.snapshot.head, "head-1");
    } finally {
      close(ctx);
    }
  }
  // Positive valid subsets map with the never-added-twice rule (thinking ⊆ output, cache ⊆ input).
  const ok = await runScenario("P09-subsets", ({ proposal }) =>
    successScript(proposal, {
      result: {
        structured_output: proposal,
        modelUsage: {
          $model: {
            inputTokens: 500,
            outputTokens: 100,
            cacheReadInputTokens: 300,
            cacheCreationInputTokens: 50,
            thinkingTokens: 20,
            provider: "firstParty",
          },
        },
      },
      writeSrc: { path: "s.txt", content: "s\n" },
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
  // Todo/plan state is informational only: a plan-complete claim contradicting the tool history
  // neither corroborates nor blocks; classification rests on the observed conjunction alone.
  const plan = await runScenario("P09-plan", ({ proposal }) =>
    successScript(proposal, {
      afterInit: [
        {
          out: {
            type: "assistant",
            message: {
              id: "msg_plan",
              model: "$model",
              content: [
                {
                  type: "text",
                  text: "All planned tasks are complete; every test passes.",
                },
              ],
              stop_reason: null,
            },
            parent_tool_use_id: null,
          },
        },
      ],
      ordinary: [
        { toolUse: { id: "tu_fail", name: "Bash" } },
        {
          toolResult: {
            id: "tu_fail",
            isError: true,
            content: "test suite FAILED (contradicts the plan claim)",
          },
        },
      ],
      writeSrc: { path: "plan.txt", content: "p\n" },
    }),
  );
  try {
    assert.equal(plan.settlement.classification, "complete");
    assert.deepEqual(plan.receipt.stream.ordinaryFailures, [
      { toolUseId: "tu_fail", tool: "Bash" },
    ]);
  } finally {
    close(plan);
  }
});
