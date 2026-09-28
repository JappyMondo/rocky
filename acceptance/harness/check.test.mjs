import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { assess, verifyInventory } from "./check.mjs";
import { EVIDENCE, BINARY_SHA, sha, guard } from "./common.mjs";

// Generated unit fixtures test interpretation only; never native evidence.
function fixture() {
  const f = {
    admission: { classification: "synthetic_native", deadline: 100 },
    observations: {
      classification: "synthetic_native",
      capability: null,
      sourceFrozen: true,
      error: null,
      pending: [],
      threadId: "thread",
      turnId: "turn",
      cleanup: {
        remaining: [],
        guardianExited: true,
        serverClosed: true,
        withinDeadline: true,
        recoveryUsed: false,
        finished: 99,
      },
    },
    inputs: {
      binary: { sha256: BINARY_SHA },
      commands: ["allowed command", "protected read", "protected write"],
    },
    before: { allowedInitiallyAbsent: true, protectedSha256: sha("fake") },
    after: {
      allowedSha256: sha("allowed-native-control"),
      protectedSha256: sha("fake"),
    },
    thread: {
      activePermissionProfile: { id: "probe" },
      approvalPolicy: "never",
      modelProvider: "synthetic",
      instructionSources: [],
      cwd: "/synthetic/source",
    },
    roster: [{ name: "exec_command" }],
    journal: [],
    requests: [{ body: { input: [] } }],
  };
  const row = (type, value) =>
    f.journal.push({ seq: f.journal.length + 1, type, value });
  row("ipc-send", { id: 1, method: "turn/start" });
  row("ipc-receive", { id: 1, result: {} });
  for (let i = 0; i < 3; i++) {
    const id = `native-probe-${i + 1}`,
      exitCode = i ? 1 : 0;
    const item = {
      id,
      type: "commandExecution",
      cwd: f.thread.cwd,
      command: f.inputs.commands[i],
      exitCode,
    };
    row("injected-native-call", {
      callId: id,
      route: "exec_command",
      args: { cmd: f.inputs.commands[i] },
    });
    row("ipc-receive", {
      method: "item/started",
      params: { threadId: "thread", turnId: "turn", item },
    });
    row("ipc-receive", {
      method: "item/completed",
      params: { threadId: "thread", turnId: "turn", item },
    });
    f.requests.push({
      body: {
        input: [
          {
            type: "function_call_output",
            call_id: id,
            output: `Process exited with code ${exitCode}\n${i ? "Operation not permitted" : "allowed-native-control"}`,
          },
        ],
      },
    });
  }
  const item = {
    id: "final",
    type: "agentMessage",
    text: '{"status":"synthetic-complete"}',
  };
  row("ipc-receive", { method: "item/started", params: { item } });
  row("ipc-receive", { method: "item/completed", params: { item } });
  row("ipc-receive", {
    method: "turn/completed",
    params: { threadId: "thread", turn: { id: "turn", status: "completed" } },
  });
  return f;
}
function completed(f, n = 0) {
  return f.journal.filter(
    (x) =>
      x.value.method === "item/completed" &&
      x.value.params.item.type === "commandExecution",
  )[n].value.params.item;
}
test("consistent unit fixture can establish only minimal feasibility, never capability", () => {
  const r = assess(fixture());
  assert.equal(r.status, "pass");
  assert.equal(r.qualification, false);
  assert.equal(r.capability, null);
});
const negatives = [
  [
    "completed turn and unchanged canary do not hide actual native134",
    (f) => {
      completed(f).exitCode = 134;
      f.requests[1].body.input[0].output =
        "Process exited with code 134\nOutput:\n";
      f.after.allowedSha256 = null;
    },
    "allowed-native-control-failed",
  ],
  [
    "denial by native signal is not containment",
    (f) => {
      completed(f, 1).exitCode = 134;
      f.requests[2].body.input[0].output =
        "Process exited with code 134\nOperation not permitted";
    },
    "abnormal-exit-is-not-denial",
  ],
  [
    "permission-like prose with exit0 is not denial",
    (f) => {
      completed(f, 1).exitCode = 0;
      f.requests[2].body.input[0].output =
        "Process exited with code 0\nPermission denied";
    },
    "abnormal-exit-is-not-denial",
  ],
  [
    "missing real output roundtrip",
    (f) => {
      f.requests[2].body.input = [];
    },
    "missing-actual-native-roundtrip",
  ],
  [
    "claimed pass without journal",
    (f) => {
      f.observations.passed = true;
      f.journal = [];
    },
    null,
  ],
  [
    "missing terminal",
    (f) => {
      f.journal.pop();
    },
    "missing-or-duplicate-terminal",
  ],
  [
    "truncated journal sequence",
    (f) => {
      f.journal[3].seq++;
    },
    "journal-gap",
  ],
  [
    "missing native dispatch",
    (f) => {
      f.journal.find((x) => x.type === "injected-native-call").type = "other";
    },
    "missing-native-operation",
  ],
  [
    "pending IPC hidden by claimed empty observation",
    (f) => {
      f.journal[0].value.id = 99;
    },
    "unexpected-ipc-response-or-server-request",
  ],
  [
    "unfinished tool item before terminal",
    (f) => {
      f.journal.splice(-1, 0, {
        type: "ipc-receive",
        value: {
          method: "item/started",
          params: { item: { id: "unfinished" } },
        },
      });
      f.journal.forEach((r, i) => (r.seq = i + 1));
    },
    "terminal-with-pending-item",
  ],
  [
    "mismatched native thread",
    (f) => {
      f.journal.find(
        (x) => x.value.method === "item/completed",
      ).value.params.threadId = "other";
    },
    null,
  ],
  [
    "changed protected artifact",
    (f) => {
      f.after.protectedSha256 = sha("changed");
    },
    "protected-file-changed",
  ],
  [
    "no allowed file",
    (f) => {
      f.after.allowedSha256 = null;
    },
    "missing-allowed-file",
  ],
  [
    "guardian recovery is distinct from normal cleanup",
    (f) => {
      f.observations.cleanup.recoveryUsed = true;
    },
    "normal-cleanup-not-proven",
  ],
  [
    "pending owned child",
    (f) => {
      f.observations.cleanup.remaining = [{ pid: 42 }];
    },
    "remaining-process",
  ],
  [
    "late cleanup cannot pass claimed deadline flag",
    (f) => {
      f.observations.cleanup.finished = 101;
    },
    "deadline-timestamp-mismatch",
  ],
  [
    "wrong binary",
    (f) => {
      f.inputs.binary.sha256 = sha("other");
    },
    "wrong-binary",
  ],
  [
    "fake upstream cannot mint live capability",
    (f) => {
      f.observations.classification = "live_provider";
      f.observations.capability = "fake";
    },
    null,
  ],
];
for (const [name, mutate, reason] of negatives)
  test(name, () => {
    const f = fixture();
    mutate(f);
    const r = assess(f);
    assert.equal(r.status, "fail");
    if (reason) assert(r.reason.includes(reason), r.reason);
    assert.equal(r.capability, null);
  });
test("inventory rejects forged/missing/duplicate/path-escaping/symlink evidence", () => {
  guard();
  const dir = join(EVIDENCE, `selftest-${Date.now()}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "artifact"), "original", { mode: 0o600 });
  const entry = { path: "artifact", bytes: 8, sha256: sha("original") };
  verifyInventory(dir, [entry]);
  assert.throws(() => verifyInventory(dir, [entry, entry]), /duplicate/);
  assert.throws(
    () => verifyInventory(dir, [{ ...entry, path: "../artifact" }]),
    /unsafe/,
  );
  assert.throws(() => verifyInventory(dir, [{ ...entry, bytes: 9 }]), /size/);
  writeFileSync(join(dir, "artifact"), "modified");
  assert.throws(() => verifyInventory(dir, [entry]), /hash/);
  symlinkSync("artifact", join(dir, "link"));
  assert.throws(
    () => verifyInventory(dir, [{ ...entry, path: "link" }]),
    /symlink/,
  );
});
