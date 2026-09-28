import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, guard, sha, save } from "./common.mjs";
import { assess } from "./check.mjs";

guard();
const rejectedCommit = "f90eee32b6dc9d1246c554cf4927463af6dbdadf";
const root = join(
  ROOT,
  ".qualification/harness-settlement-68-repair",
  `completion-${Date.now()}`,
);
const snapshot = join(root, "exact-rejected-source");
mkdirSync(snapshot, { recursive: true, mode: 0o700 });
const files = execFileSync(
  "git",
  ["ls-tree", "-r", "--name-only", rejectedCommit, "acceptance/harness"],
  { encoding: "utf8" },
)
  .trim()
  .split("\n");
const source = [];
for (const path of files) {
  const bytes = execFileSync("git", ["show", `${rejectedCommit}:${path}`]);
  const name = path.slice("acceptance/harness/".length);
  assert(!name.includes("/"));
  writeFileSync(join(snapshot, name), bytes, { flag: "wx", mode: 0o400 });
  assert.equal(sha(readFileSync(join(snapshot, name))), sha(bytes));
  source.push({ path: name, bytes: bytes.length, sha256: sha(bytes) });
}
save(join(root, "rejected-source.json"), { commit: rejectedCommit, source });
// Import only the unchanged checker and pure synthetic fixture, never a driver.
const old = await import(pathToFileURL(join(snapshot, "check.mjs")));
const { settlementFixture, refresh } = await import(
  pathToFileURL(join(snapshot, "settlement-fixtures.mjs"))
);
const results = [];
after(() =>
  save(join(root, "results.json"), {
    kind: "actual-shaped-full-assess-regressions",
    rejectedCommit,
    qualification: false,
    capability: null,
    results,
  }),
);
const notify = (method, params) => ({
  type: "ipc-receive",
  value: { method, params },
});
const terminal = (f) =>
  f.journal.find((r) => r.value.method === "turn/completed");
const eof = (f) => f.journal.findIndex((r) => r.type === "ipc-eof");
const typedError = {
  message: "Synthetic retained failure",
  codexErrorInfo: "internalServerError",
  additionalDetails: null,
  misalignment: null,
};
const turn = (status = "inProgress", error = null) => ({
  id: "turn",
  status,
  items: [],
  error,
});
const addBeforeTerminal = (f, row) =>
  f.journal.splice(f.journal.indexOf(terminal(f)), 0, row);
const afterTerminal = (f, ...rows) => f.journal.splice(eof(f), 0, ...rows);
const extractFinal = (f) => {
  const rows = f.journal.filter(
    (r) => r.value.params?.item?.type === "agentMessage",
  );
  f.journal = f.journal.filter((r) => !rows.includes(r));
  return rows;
};
const freshThread = (f) => structuredClone(f.thread.thread);
const cases = [
  [
    "SPEC65-02 terminal typed TurnError despite completed status",
    (f) => {
      terminal(f).value.params.turn.error = typedError;
    },
  ],
  [
    "SPEC65-02 terminal error absent",
    (f) => {
      delete terminal(f).value.params.turn.error;
    },
  ],
  [
    "SPEC65-02 initial turn response typed TurnError",
    (f) => {
      f.journal.find(
        (r) => r.value.id === "turn-request" && r.type === "ipc-receive",
      ).value.result.turn.error = typedError;
    },
  ],
  [
    "SPEC65-02 initial turn response error absent",
    (f) => {
      delete f.journal.find(
        (r) => r.value.id === "turn-request" && r.type === "ipc-receive",
      ).value.result.turn.error;
    },
  ],
  [
    "SPEC65-02 started turn typed TurnError",
    (f) => {
      f.journal.splice(
        4,
        0,
        notify("turn/started", {
          threadId: "thread",
          turn: turn("inProgress", typedError),
        }),
      );
    },
  ],
  [
    "SPEC65-02 started turn already failed",
    (f) => {
      f.journal.splice(
        4,
        0,
        notify("turn/started", {
          threadId: "thread",
          turn: turn("failed", typedError),
        }),
      );
    },
  ],
  [
    "SPEC65-02 started turn completed without error",
    (f) => {
      f.journal.splice(
        4,
        0,
        notify("turn/started", { threadId: "thread", turn: turn("completed") }),
      );
    },
  ],
  [
    "SPEC65-02 started turn interrupted without error",
    (f) => {
      f.journal.splice(
        4,
        0,
        notify("turn/started", {
          threadId: "thread",
          turn: turn("interrupted"),
        }),
      );
    },
  ],
  [
    "SPEC65-02 systemError before terminal",
    (f) => {
      addBeforeTerminal(
        f,
        notify("thread/status/changed", {
          threadId: "thread",
          status: { type: "systemError" },
        }),
      );
    },
  ],
  [
    "SPEC65-02 systemError after terminal",
    (f) => {
      afterTerminal(
        f,
        notify("thread/status/changed", {
          threadId: "thread",
          status: { type: "systemError" },
        }),
      );
    },
  ],
  [
    "SPEC65-02 thread-start event systemError",
    (f) => {
      const t = freshThread(f);
      t.status = { type: "systemError" };
      f.journal.splice(1, 0, notify("thread/started", { thread: t }));
    },
  ],
  [
    "SPEC65-02 thread-start event contains failed prior turn",
    (f) => {
      const t = freshThread(f);
      t.turns = [turn("failed", typedError)];
      f.journal.splice(1, 0, notify("thread/started", { thread: t }));
    },
  ],
  [
    "SPEC65-03 final before every native operation",
    (f) => {
      const rows = extractFinal(f);
      f.journal.splice(4, 0, ...rows);
    },
  ],
  [
    "SPEC65-03 final after receipts but before emitted final",
    (f) => {
      const rows = extractFinal(f);
      const at = f.journal.findIndex(
        (r) =>
          r.type === "upstream-response-event" &&
          r.value.request === 4 &&
          r.value.event.type === "response.output_item.done",
      );
      f.journal.splice(at, 0, ...rows);
    },
  ],
  [
    "SPEC65-03 final before last receipt",
    (f) => {
      const rows = extractFinal(f);
      const at = f.journal.findIndex(
        (r) =>
          r.type === "native-settlement" && r.value.callId === "native-probe-3",
      );
      f.journal.splice(at, 0, ...rows);
    },
  ],
  [
    "SPEC65-03 emitted final before last receipt",
    (f) => {
      const receipt = f.journal.find(
        (r) =>
          r.type === "native-settlement" && r.value.callId === "native-probe-3",
      );
      f.journal.splice(f.journal.indexOf(receipt), 1);
      const at = f.journal.findIndex(
        (r) =>
          r.type === "upstream-response-event" &&
          r.value.request === 4 &&
          r.value.event.type === "response.output_item.done",
      );
      f.journal.splice(at + 1, 0, receipt);
    },
  ],
  [
    "SPEC65-03 resolved reasoning items after terminal",
    (f) => {
      const params = {
        threadId: "thread",
        turnId: "turn",
        item: {
          id: "late-reasoning",
          type: "reasoning",
          summary: [],
          content: [],
        },
      };
      afterTerminal(
        f,
        notify("item/started", params),
        notify("item/completed", structuredClone(params)),
      );
    },
  ],
  [
    "SPEC65-03 new same-ID turn after terminal",
    (f) => {
      afterTerminal(
        f,
        notify("turn/started", { threadId: "thread", turn: turn() }),
      );
    },
  ],
  [
    "SPEC65-03 new thread lifecycle after terminal",
    (f) => {
      afterTerminal(f, notify("thread/started", { thread: freshThread(f) }));
    },
  ],
  [
    "SPEC65-03 item delta after terminal",
    (f) => {
      afterTerminal(
        f,
        notify("item/agentMessage/delta", {
          threadId: "thread",
          turnId: "turn",
          itemId: "final",
          delta: "late",
        }),
      );
    },
  ],
];
let sequence = 0;
for (const [label, mutate] of cases)
  test(`exact f90 pass / repaired reject: ${label}`, () => {
    const f = settlementFixture();
    mutate(f);
    refresh(f);
    const path = `case-${++sequence}.json`;
    save(join(root, path), f);
    // The SAME serialized artifact is assessed end-to-end by both revisions.
    const bytes = readFileSync(join(root, path));
    const before = old.assess(JSON.parse(bytes));
    const current = assess(JSON.parse(bytes));
    results.push({ label, path, sha256: sha(bytes), before, current });
    assert.equal(before.status, "pass", `${label}: ${before.reason}`);
    assert.equal(current.status, "fail", label);
  });
for (const options of [
  {},
  { eventful: true },
  { reordered: true },
  { eventful: true, reordered: true },
])
  test(`normal and alternate causality preserved ${JSON.stringify(options)}`, () => {
    const f = settlementFixture(options);
    const rows = extractFinal(f);
    const at = f.journal.findIndex(
      (r) =>
        r.type === "upstream-response-event" &&
        r.value.request === 4 &&
        r.value.event.type === "response.completed",
    );
    // Legitimate cross-channel order: final IPC after emitted item but before the
    // separate provider response.completed frame. Neither requires a sleep.
    f.journal.splice(at, 0, ...rows);
    const started = notify("turn/started", {
      threadId: "thread",
      turn: turn(),
    });
    f.journal.splice(3, 0, started); // turn notification before turn/start response
    const initial = notify("thread/started", { thread: freshThread(f) });
    f.journal.splice(1, 0, initial); // thread notification before thread/start response
    afterTerminal(
      f,
      notify("thread/status/changed", {
        threadId: "thread",
        status: { type: "idle" },
      }),
      notify("thread/tokenUsage/updated", {
        threadId: "thread",
        turnId: "turn",
        tokenUsage: {
          total: {
            totalTokens: 0,
            inputTokens: 0,
            cachedInputTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0,
          },
          last: {
            totalTokens: 0,
            inputTokens: 0,
            cachedInputTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0,
          },
          modelContextWindow: null,
        },
      }),
      notify("thread/status/changed", {
        threadId: "thread",
        status: { type: "notLoaded" },
      }),
    );
    refresh(f);
    const before = old.assess(f),
      current = assess(f);
    save(join(root, `positive-${++sequence}.json`), f);
    results.push({ options, before, current });
    assert.equal(before.status, "pass", before.reason);
    assert.equal(current.status, "pass", current.reason);
    assert.equal(current.qualification, false);
    assert.equal(current.capability, null);
  });
for (const [label, mutate] of [
  [
    "already rejected initial systemError",
    (f) => {
      f.thread.thread.status = { type: "systemError" };
      f.journal[1].value.result = structuredClone(f.thread);
    },
  ],
  [
    "already rejected top-level error notification",
    (f) => {
      addBeforeTerminal(
        f,
        notify("error", {
          threadId: "thread",
          turnId: "turn",
          error: typedError,
          willRetry: false,
        }),
      );
    },
  ],
  [
    "already rejected new different turn",
    (f) => {
      afterTerminal(
        f,
        notify("turn/started", {
          threadId: "thread",
          turn: { ...turn(), id: "different" },
        }),
      );
    },
  ],
])
  test(label, () => {
    const f = settlementFixture();
    mutate(f);
    refresh(f);
    assert.equal(old.assess(f).status, "fail");
    assert.equal(assess(f).status, "fail");
    results.push({ label, unchangedRejection: true });
  });
