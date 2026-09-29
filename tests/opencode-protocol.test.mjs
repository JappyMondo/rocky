// Taskbot #98 protocol tests: strict `opencode run --format=json` NDJSON classification and the
// MANDATORY post-run export-audit conjunct (#104 research F19–F27, PART 4 §2/§3/§5; FK5/FK6/FK8/
// FK9), driven by the owned fake CLI over REAL spawned processes and real SQLite stores. There is
// NO result/done event: completion is clean EOF + exit 0 + a parseable host-revalidated final text
// + the export audit. Every run is owned-fake-cli evidence: no real opencode binary, no
// credentials, no network, no model calls.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  opencodeFixture,
  closeFixture,
  baselinePass,
  implementChanged,
  schedule,
  finalProposal,
  successScript,
  dispatchOpencode,
  settleOpencode,
  readReceipt,
  deriveTreeHead,
  exportDoc,
  sha,
  DEFAULT_SESSION,
} from "./opencode-support.mjs";

const writeSrc = { path: "output.txt", content: "bounded change\n" };
async function runScenario(name, scriptFn, options = {}) {
  const f = opencodeFixture(name, options.fixture);
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
    const { plan, pending } = dispatchOpencode(f, action, script, options);
    const snapshot = await settleOpencode(f, action, pending);
    const command = f.store.commands(f.lease.runId).at(-1);
    Object.assign(ctx, {
      action,
      role,
      plan,
      proposal,
      script,
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
const close = (f) => closeFixture(f);
const detail = (ctx) => ctx.receipt.settlement.detail;

test("P01 complete positive control: EOF + exit 0 + final text + export audit yield a proposal only (F21/F25/F27)", async () => {
  const ctx = await runScenario("P01-success", ({ proposal }) =>
    successScript(proposal, { writeSrc }),
  );
  try {
    const { f, plan, snapshot, receipt, proposal } = ctx;
    assert.equal(receipt.settlement.classification, "complete");
    assert.equal(receipt.settlement.outcome, "changed");
    assert.equal(snapshot.blocker, null);
    assert.equal(snapshot.stage, "verifying");
    // The head is host-derived from the staged tree, never from the model's final message.
    assert.equal(snapshot.head, deriveTreeHead(plan.paths.src));
    assert.notEqual(snapshot.head, "head-1");
    assert.equal(receipt.head.pre, plan.headPre);
    assert.equal(receipt.head.post, snapshot.head);
    // The proposal is retained but establishes no authority: head adoption invalidated the
    // baseline receipt and the model final registered no checks/CI/review receipt of any kind.
    assert.deepEqual(receipt.result.final, proposal);
    assert.deepEqual(Object.keys(snapshot.receipts), []);
    assert.match(
      receipt.result.proposalAuthority,
      /proposal only; never authoritative/,
    );
    // Usage: reported from the EXPORT AUDIT aggregate (the stream has no aggregate frame);
    // receipt = sha256 of the retained raw export bytes; subsets never added twice.
    assert.equal(receipt.usage.status, "reported");
    assert.deepEqual(receipt.usage.components, {
      input: 1200,
      cachedInput: 800,
      cacheWriteInput: 100,
      output: 340,
      reasoningOutput: 40,
    });
    assert.equal(snapshot.budgets.harnessReportedTokens, 1540);
    const rawExport = readFileSync(receipt.exportAudit.rawRetainedAt);
    assert.equal(receipt.usage.receipt, sha(rawExport));
    assert.equal(receipt.exportAudit.ran, true);
    assert.equal(receipt.exportAudit.audit.ok, true);
    assert.equal(receipt.exportAudit.audit.divergence, null);
    assert.equal(receipt.exportAudit.audit.assistantMessages, 1);
    // Stream facts: exactly the 4 scripted frames; the raw log ends at EOF (no frames after).
    assert.equal(receipt.stream.framesObserved, 4);
    assert.equal(receipt.stream.sessionId, DEFAULT_SESSION);
    const rawStdout = readFileSync(receipt.stream.rawStdoutLog, "utf8");
    assert.equal(rawStdout.trim().split("\n").length, 4);
    assert.equal(receipt.stream.summedTokens.input, 1200);
    assert.equal(receipt.stream.summedTokens.output, 340);
    assert.equal(receipt.lifecycle.exitCode, 0);
    assert.equal(receipt.lifecycle.quiescent, true);
    // The cost field is never consumed (zero-priced catalog, informational only).
    assert.ok(!JSON.stringify(receipt.usage).includes("cost"));
    // Honest gaps are recorded, including the G-AUTHFILE user-decision gate and the fake-CLI
    // evidence class; prompt consumption is evidenced by the session (no gap entry).
    const gates = receipt.gaps.map((g) => g.gate);
    for (const gate of [
      "G-SIG",
      "G-USAGE-COMPONENTS",
      "G-NPM",
      "G-AUTHFILE",
      "G-DEFAULT-PROMPT",
      "G-ROSTER",
      "G-MANAGED",
      "G-EXPORT-AUTHORITY",
      "LIVE",
      "NP1-NP5",
    ])
      assert.ok(gates.includes(gate), `missing gap ${gate}`);
    assert.ok(!gates.includes("PROMPT-CONSUMPTION"));
    assert.match(
      receipt.gaps.find((g) => g.gate === "G-AUTHFILE").gap,
      /explicit user decision REQUIRED before any live run/i,
    );
  } finally {
    await close(ctx.f);
  }
});

test("P02 the export audit is a REQUIRED success conjunct: unavailable export ⇒ unresolved/unknown, never success (F25/FK9)", async () => {
  // (a) No export marker: the fake mirrors `Session not found` (stderr + exit 1, empty stdout).
  const a = await runScenario(
    "P02-missing",
    ({ proposal }) => successScript(proposal, { writeSrc }),
    { exportMarker: null },
  );
  try {
    assert.equal(a.receipt.settlement.classification, "unresolved");
    assert.equal(a.receipt.settlement.outcome, "failed");
    assert.match(detail(a), /export-audit:export-spawn-failed:1/);
    assert.equal(a.receipt.usage.status, "unknown");
    assert.equal(a.snapshot.head, "head-1");
    assert.equal(a.snapshot.blocker?.kind, "needs_engineering");
  } finally {
    await close(a.f);
  }
  // (b) Export produces malformed JSON: parse failure is unavailable evidence, never success.
  const b = await runScenario(
    "P02-malformed",
    ({ proposal }) => successScript(proposal, { writeSrc }),
    { exportMarker: () => ({ raw: "{not json at all\n", exit: 0 }) },
  );
  try {
    assert.equal(b.receipt.settlement.classification, "unresolved");
    assert.match(detail(b), /export-audit:export-malformed/);
    assert.equal(b.receipt.usage.status, "unknown");
    assert.equal(b.snapshot.head, "head-1");
  } finally {
    await close(b.f);
  }
  // (c) Export top-level shape drift (extra key) refuses: the pinned envelope is {info,messages}.
  const c = await runScenario(
    "P02-shape",
    ({ proposal }) => successScript(proposal, { writeSrc }),
    {
      exportMarker: (plan) => ({
        raw:
          JSON.stringify({
            ...exportDoc({ directory: plan.paths.src }),
            extra: 1,
          }) + "\n",
        exit: 0,
      }),
    },
  );
  try {
    assert.equal(c.receipt.settlement.classification, "unresolved");
    assert.match(detail(c), /export-audit:export-shape:top-keys/);
    assert.equal(c.receipt.usage.status, "unknown");
  } finally {
    await close(c.f);
  }
});

test("P03 export-audit served-identity mismatches are FATAL: model, provider, version, directory (PART 4 §3/FK8)", async () => {
  const cases = [
    [
      "model",
      { modelID: "qwen-other" },
      /export-(session|assistant)-model-mismatch/,
    ],
    [
      "provider",
      { providerID: "openai" },
      /export-(session|assistant)-model-mismatch/,
    ],
    ["version", { version: "1.18.99" }, /export-version-mismatch/],
    [
      "directory",
      { directory: "/somewhere/else" },
      /export-directory-mismatch/,
    ],
    [
      "assistant-error",
      { assistantError: { name: "ProviderAuthError" } },
      /export-assistant-error/,
    ],
  ];
  for (const [name, override, pattern] of cases) {
    const ctx = await runScenario(
      `P03-${name}`,
      ({ proposal }) => successScript(proposal, { writeSrc }),
      {
        exportMarker: (plan) => ({
          raw:
            JSON.stringify(
              exportDoc({ directory: plan.paths.src, ...override }),
              null,
              2,
            ) + "\n",
          exit: 0,
        }),
      },
    );
    try {
      assert.equal(
        ctx.receipt.settlement.classification,
        "fatal",
        `case ${name}`,
      );
      assert.equal(ctx.receipt.settlement.outcome, "failed");
      assert.match(detail(ctx), pattern);
      assert.equal(ctx.receipt.usage.status, "unknown");
      // A fatal served-identity mismatch never adopts a head.
      assert.equal(ctx.snapshot.head, "head-1");
    } finally {
      await close(ctx.f);
    }
  }
});

test("P04 stream faults: garbage and duplicate keys are fatal malformed-NDJSON, truncation and unknown types are unresolved (F22/FK5)", async () => {
  // (a) A non-JSON garbage line: malformed NDJSON is FATAL (PART 4 §3), never success.
  const a = await runScenario("P04-garbage", ({ proposal }) =>
    successScript(proposal, {
      writeSrc,
      afterStepStart: [{ outText: "not json at all\n" }],
    }),
  );
  try {
    assert.equal(a.receipt.settlement.classification, "fatal");
    assert.match(detail(a), /malformed-ndjson:strict-malformed-frame/);
    assert.equal(a.receipt.usage.status, "unknown");
    assert.equal(a.snapshot.head, "head-1");
  } finally {
    await close(a.f);
  }
  // (b) A duplicate JSON key inside a frame: the transport JSON.parse accepts it, the strict
  // settlement re-decode rejects (F22 duplicate-key rule) — fatal, never an aliased value.
  const b = await runScenario("P04-dupkey", ({ proposal }) =>
    successScript(proposal, {
      writeSrc,
      afterStepStart: [
        {
          outText: `{"type":"step_start","timestamp":1,"sessionID":"${DEFAULT_SESSION}","sessionID":"${DEFAULT_SESSION}","part":{"id":"p","sessionID":"${DEFAULT_SESSION}","messageID":"m","type":"step-start"}}\n`,
        },
      ],
    }),
  );
  try {
    assert.equal(b.receipt.settlement.classification, "fatal");
    assert.match(detail(b), /malformed-ndjson:strict-duplicate-key/);
    assert.equal(b.receipt.usage.status, "unknown");
  } finally {
    await close(b.f);
  }
  // (c) A truncated last line (no EOF newline): truncation is UNRESOLVED, never discarded.
  const c = await runScenario("P04-truncated", ({ proposal }) =>
    successScript(proposal, {
      writeSrc,
      post: [{ outText: '{"type":"text","timesta' }],
    }),
  );
  try {
    assert.equal(c.receipt.settlement.classification, "unresolved");
    assert.match(
      detail(c),
      /stream-truncated:strict-partial-line|transport-failure:duplex-partial-frame/,
    );
    assert.equal(c.receipt.usage.status, "unknown");
    assert.equal(c.snapshot.head, "head-1");
  } finally {
    await close(c.f);
  }
  // (d) An unknown event type: the closed set is a version-drift tripwire (F22) — unresolved.
  const d = await runScenario("P04-unknown-type", ({ proposal }) =>
    successScript(proposal, {
      writeSrc,
      afterStepStart: [
        {
          out: {
            type: "message.updated",
            timestamp: 1,
            sessionID: DEFAULT_SESSION,
            part: {},
          },
        },
      ],
    }),
  );
  try {
    assert.equal(d.receipt.settlement.classification, "unresolved");
    assert.match(detail(d), /unknown-frame-type:message\.updated/);
    assert.equal(d.receipt.usage.status, "unknown");
  } finally {
    await close(d.f);
  }
});

test("P05 completion semantics: no result event exists — exit 0 without text, zero stdout, startup refusal and error events classify fail-closed (F21/F23/FK5)", async () => {
  // (a) Exit 0 with well-formed events but NO text part: unresolved, never success.
  const a = await runScenario("P05-no-text", () => ({
    script: [
      { stepStart: {} },
      { toolUse: { tool: "bash" } },
      { stepFinish: { input: 10, output: 5 } },
      { writeSrc },
    ],
  }));
  try {
    assert.equal(a.receipt.settlement.classification, "unresolved");
    assert.match(detail(a), /no-text-part/);
    assert.equal(a.receipt.usage.status, "unknown");
    assert.equal(a.snapshot.head, "head-1");
  } finally {
    await close(a.f);
  }
  // (b) Exit 0 with ZERO stdout: indistinguishable from 'produced nothing' — unresolved.
  const b = await runScenario("P05-zero-stdout", () => ({ script: [] }));
  try {
    assert.equal(b.receipt.settlement.classification, "unresolved");
    assert.match(detail(b), /no-text-part/);
    assert.equal(b.receipt.stream.framesObserved, 0);
    assert.equal(b.receipt.usage.status, "unknown");
  } finally {
    await close(b.f);
  }
  // (c) Nonzero exit with zero events and stderr output: startup refusal is FATAL.
  const c = await runScenario("P05-startup-refusal", () => ({
    script: [{ err: "You must provide a message or a command\n" }, { exit: 1 }],
  }));
  try {
    assert.equal(c.receipt.settlement.classification, "fatal");
    assert.match(detail(c), /startup-refusal/);
    assert.equal(c.receipt.usage.status, "unknown");
  } finally {
    await close(c.f);
  }
  // (d) An 'error' event mid-stream + exit 1 (the F21 error path): FATAL, usage never reported.
  const d = await runScenario("P05-error-event", ({ proposal }) =>
    successScript(proposal, {
      writeSrc,
      afterStepStart: [
        { errorEvent: { name: "ProviderAuthError", message: "auth failed" } },
      ],
      exit: 1,
    }),
  );
  try {
    assert.equal(d.receipt.settlement.classification, "fatal");
    assert.match(detail(d), /error-event:ProviderAuthError/);
    assert.equal(d.receipt.usage.status, "unknown");
    assert.equal(d.receipt.stream.errorEvents.length, 1);
    assert.equal(d.snapshot.head, "head-1");
  } finally {
    await close(d.f);
  }
});

test("P06 tool classification: permission refusals and off-roster use are POLICY; ordinary failures stay settled-ordinary (PART 4 §3/F12/FK5)", async () => {
  // (a) A tool error carrying a permission-refusal shape (run auto-rejects every ask, F12).
  const a = await runScenario("P06-permission", ({ proposal }) =>
    successScript(proposal, {
      writeSrc,
      afterStepStart: [
        {
          toolUse: {
            tool: "read",
            status: "error",
            error:
              "PermissionRejectedError: rejected permission read for /Users/x/.local/share/opencode/auth.json",
          },
        },
      ],
    }),
  );
  try {
    assert.equal(a.receipt.settlement.classification, "policy-denied");
    assert.equal(a.receipt.settlement.outcome, "failed");
    assert.match(detail(a), /permission-denied:read/);
    assert.equal(a.receipt.usage.status, "unknown");
    assert.equal(a.snapshot.head, "head-1");
  } finally {
    await close(a.f);
  }
  // (b) An ORDINARY tool failure (test failure text) followed by a good final: settled-ordinary
  // preserves later-proposal acceptance — complete, not policy.
  const b = await runScenario("P06-ordinary", ({ proposal }) =>
    successScript(proposal, {
      writeSrc,
      afterStepStart: [
        {
          toolUse: {
            tool: "bash",
            status: "error",
            error: "npm test exited 1: 2 tests failed",
          },
        },
      ],
    }),
  );
  try {
    assert.equal(b.receipt.settlement.classification, "complete");
    assert.equal(b.receipt.settlement.outcome, "changed");
    assert.equal(b.receipt.stream.ordinaryFailures.length, 1);
    assert.equal(b.receipt.usage.status, "reported");
  } finally {
    await close(b.f);
  }
  // (c) Off-roster tool_use for the IMPLEMENTER (task is denied ⇒ absent): contract violation.
  const c = await runScenario("P06-off-roster-impl", ({ proposal }) =>
    successScript(proposal, {
      writeSrc,
      afterStepStart: [{ toolUse: { tool: "task" } }],
    }),
  );
  try {
    assert.equal(c.receipt.settlement.classification, "policy-denied");
    assert.match(detail(c), /off-roster-tool:task/);
    assert.deepEqual(c.receipt.stream.offRosterTools, ["task"]);
  } finally {
    await close(c.f);
  }
  // (d) Off-roster tool_use for the REVIEWER (bash is removed by tool absence): contract
  // violation even though the reviewer stream otherwise looks complete.
  const d = await runScenario(
    "P06-off-roster-rev",
    ({ proposal }) =>
      successScript(proposal, {
        afterStepStart: [{ toolUse: { tool: "bash" } }],
        sessionID: DEFAULT_SESSION,
      }),
    { review: true },
  );
  try {
    assert.equal(d.receipt.settlement.classification, "policy-denied");
    assert.match(detail(d), /off-roster-tool:bash/);
  } finally {
    await close(d.f);
  }
});

test("P07 final-text protocol: the LAST text part is the proposal carrier; unparsable, mis-bound or competing finals refuse (F27/FK5)", async () => {
  // (a) Final text is not JSON: success without a parseable final is failure.
  const a = await runScenario("P07-not-json", () => ({
    script: [
      { stepStart: {} },
      { stepFinish: { input: 10, output: 5 } },
      { text: { text: "all done, looks good!" } },
      { writeSrc },
    ],
  }));
  try {
    assert.equal(a.receipt.settlement.classification, "unresolved");
    assert.match(detail(a), /final-invalid/);
    assert.equal(a.receipt.usage.status, "unknown");
    assert.equal(a.snapshot.head, "head-1");
  } finally {
    await close(a.f);
  }
  // (b) A schema-valid but MIS-BOUND final (wrong actionKey) rejects.
  const b = await runScenario("P07-misbound", ({ proposal }) =>
    successScript(
      { ...proposal, actionKey: "some-other-action" },
      { writeSrc },
    ),
  );
  try {
    assert.equal(b.receipt.settlement.classification, "unresolved");
    assert.match(detail(b), /final-binding/);
  } finally {
    await close(b.f);
  }
  // (c) Two competing schema-shaped finals: ambiguous authority refuses.
  const c = await runScenario("P07-two-finals", ({ proposal }) =>
    successScript(proposal, {
      writeSrc,
      afterStepFinish: [{ text: { text: JSON.stringify(proposal) } }],
    }),
  );
  try {
    assert.equal(c.receipt.settlement.classification, "unresolved");
    assert.match(detail(c), /multiple-schema-shaped-finals/);
  } finally {
    await close(c.f);
  }
  // (d) Tool activity AFTER the final text: the run kept acting after the proposal.
  const d = await runScenario("P07-tool-after-final", ({ proposal }) =>
    successScript(proposal, {
      writeSrc,
      post: [{ toolUse: { tool: "bash" } }],
    }),
  );
  try {
    assert.equal(d.receipt.settlement.classification, "unresolved");
    assert.match(detail(d), /tool-after-final/);
  } finally {
    await close(d.f);
  }
});

test("P08 usage statuses: all-zero aggregate is ambiguous-zero (real reducer barrier), divergence and missing step_finish are unknown, cost is never a receipt (PART 4 §5/F25/FK6)", async () => {
  // (a) All-zero tokens on a complete, audited stream: ambiguous-zero, NEVER a known zero — and
  // the real reducer stops the successful run as recovery_required with the head unadopted.
  const zeroTokens = {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
  const a = await runScenario(
    "P08-zero",
    ({ proposal }) => successScript(proposal, { writeSrc, tokens: zeroTokens }),
    {
      exportMarker: (plan) => ({
        raw:
          JSON.stringify(
            exportDoc({ directory: plan.paths.src, tokens: zeroTokens }),
            null,
            2,
          ) + "\n",
        exit: 0,
      }),
    },
  );
  try {
    assert.equal(a.receipt.settlement.classification, "complete");
    assert.equal(a.receipt.settlement.outcome, "changed");
    assert.equal(a.receipt.usage.status, "ambiguous-zero");
    // Real-reducer integration: a successful result with unresolved usage keeps the
    // unknown-success barrier, stops the run as recovery_required and refuses every schedule.
    assert.equal(a.snapshot.stage, "recovery_required");
    assert.equal(
      a.snapshot.blocker?.detail,
      "successful-result-usage-ambiguous-zero",
    );
    assert.equal(a.snapshot.head, "head-1");
    assert.deepEqual(a.snapshot.unqualifiedResults, ["implement"]);
    assert.equal(a.snapshot.budgets.harnessAmbiguousZero, 1);
  } finally {
    await close(a.f);
  }
  // (b) Export aggregate diverges from the summed step_finish telemetry: usage unknown (the
  // settlement stays complete; the reducer barrier catches the unresolved usage).
  const b = await runScenario(
    "P08-divergent",
    ({ proposal }) => successScript(proposal, { writeSrc }),
    {
      exportMarker: (plan) => ({
        raw:
          JSON.stringify(
            exportDoc({
              directory: plan.paths.src,
              tokens: {
                input: 9999,
                output: 340,
                reasoning: 40,
                cacheRead: 800,
                cacheWrite: 100,
              },
            }),
            null,
            2,
          ) + "\n",
        exit: 0,
      }),
    },
  );
  try {
    assert.equal(b.receipt.settlement.classification, "complete");
    assert.equal(b.receipt.usage.status, "unknown");
    assert.match(
      b.receipt.usage.reason,
      /usage-divergent:step-finish-aggregate-divergent/,
    );
    assert.equal(b.snapshot.stage, "recovery_required");
    assert.equal(b.snapshot.blocker?.detail, "successful-result-usage-unknown");
    assert.equal(b.snapshot.head, "head-1");
  } finally {
    await close(b.f);
  }
  // (c) No step_finish in the stream at all: unknown even with a nonzero export aggregate (§5).
  const c = await runScenario("P08-no-step-finish", ({ proposal }) => ({
    script: [
      { stepStart: {} },
      { toolUse: { tool: "bash" } },
      { text: { text: JSON.stringify(proposal) } },
      { writeSrc },
    ],
  }));
  try {
    assert.equal(c.receipt.settlement.classification, "complete");
    assert.equal(c.receipt.usage.status, "unknown");
    assert.match(c.receipt.usage.reason, /no-step-finish/);
    assert.equal(c.snapshot.stage, "recovery_required");
  } finally {
    await close(c.f);
  }
  // (d) SessionInfo.tokens disagreeing with the assistant-message sum: divergence ⇒ unknown.
  const d = await runScenario(
    "P08-info-tokens",
    ({ proposal }) => successScript(proposal, { writeSrc }),
    {
      exportMarker: (plan) => ({
        raw:
          JSON.stringify(
            exportDoc({
              directory: plan.paths.src,
              infoTokens: { input: 1, output: 1 },
            }),
            null,
            2,
          ) + "\n",
        exit: 0,
      }),
    },
  );
  try {
    assert.equal(d.receipt.usage.status, "unknown");
    assert.match(
      d.receipt.usage.reason,
      /usage-divergent:session-tokens-divergent/,
    );
  } finally {
    await close(d.f);
  }
});

test("P09 session identity: the export must be the streamed session; a second sessionID in the stream is drift (F19/F25/FK9)", async () => {
  // (a) The run streamed a different sessionID than the export document carries: the audit
  // cannot bind evidence to THIS run — unresolved, never success.
  const a = await runScenario("P09-session-mismatch", ({ proposal }) =>
    successScript(proposal, { writeSrc, sessionID: "fake-session-9999" }),
  );
  try {
    assert.equal(a.receipt.settlement.classification, "unresolved");
    assert.match(detail(a), /export-audit:export-session-mismatch/);
    assert.equal(a.receipt.usage.status, "unknown");
    assert.equal(a.snapshot.head, "head-1");
  } finally {
    await close(a.f);
  }
  // (b) Two different sessionIDs inside one stream: subagent parts are skipped by the producer,
  // so a second ID is an anomaly — unresolved.
  const b = await runScenario("P09-two-sessions", ({ proposal }) =>
    successScript(proposal, {
      writeSrc,
      afterStepStart: [
        {
          out: {
            type: "step_start",
            timestamp: 1,
            sessionID: "fake-session-other",
            part: {
              id: "p-x",
              sessionID: "fake-session-other",
              messageID: "m-x",
              type: "step-start",
            },
          },
        },
      ],
    }),
  );
  try {
    assert.equal(b.receipt.settlement.classification, "unresolved");
    assert.match(detail(b), /session-id-mismatch/);
  } finally {
    await close(b.f);
  }
});
