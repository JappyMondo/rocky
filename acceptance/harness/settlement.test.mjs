import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, sha, guard, save } from "./common.mjs";
import { assess, checkAttempt } from "./check.mjs";
import { definition } from "./fixture.mjs";
import {
  NativeSettlement,
  DENIAL_VARIANT,
  requireTerminalDenial,
} from "./settlement.mjs";
import {
  settlementFixture,
  terminalOutput,
  refresh,
} from "./settlement-fixtures.mjs";

guard();
const dir = join(
  ROOT,
  ".qualification/harness-settlement-68",
  `selftest-${Date.now()}`,
);
mkdirSync(dir, { recursive: true, mode: 0o700 });
const results = [];
after(() =>
  save(join(dir, "results.json"), {
    kind: "synthetic-checker-mechanics-only",
    results,
  }),
);
save(join(dir, "positive-fixture.json"), settlementFixture());
const find = (f, type, n = 0) => f.journal.filter((r) => r.type === type)[n];
const output = (f, value) => {
  for (const r of f.requests.slice(2))
    r.body.input.find(
      (x) =>
        x.type === "function_call_output" && x.call_id === "native-probe-2",
    ).output = value;
};
for (const options of [
  {},
  { eventful: true },
  { reordered: true },
  { eventful: true, reordered: true },
])
  test(`actual-shaped operation mechanics ${JSON.stringify(options)}`, () => {
    const result = assess(settlementFixture(options));
    assert.equal(result.status, "pass", result.reason);
    assert.equal(result.capability, null);
    assert.equal(result.qualification, false);
    results.push({ options, result });
  });
const mutations = [
  [
    "zero-event denial with prior output delta",
    (f) => {
      const at = f.journal.indexOf(find(f, "upstream-request", 2));
      f.journal.splice(at, 0, {
        type: "ipc-receive",
        value: {
          method: "item/commandExecution/outputDelta",
          params: {
            threadId: "thread",
            turnId: "turn",
            itemId: "native-probe-2",
            delta: "observed",
          },
        },
      });
    },
  ],
  [
    "late output delta after provisional",
    (f) => {
      const at = f.journal.indexOf(find(f, "native-settlement", 1));
      f.journal.splice(at + 1, 0, {
        type: "ipc-receive",
        value: {
          method: "item/commandExecution/outputDelta",
          params: {
            threadId: "thread",
            turnId: "turn",
            itemId: "native-probe-2",
            delta: "observed",
          },
        },
      });
    },
  ],
  [
    "native call disguised as other item type",
    (f) => {
      const at = f.journal.indexOf(find(f, "native-settlement", 1));
      f.journal.splice(at + 1, 0, {
        type: "ipc-receive",
        value: {
          method: "item/started",
          params: {
            threadId: "thread",
            turnId: "turn",
            item: { id: "native-probe-2", type: "reasoning" },
          },
        },
      });
    },
  ],
  [
    "thread permission override",
    (f) => {
      f.journal[0].value.params.permissions = "other";
    },
  ],
  [
    "turn permission override",
    (f) => {
      f.journal[2].value.params.permissions = "other";
    },
  ],
  [
    "changed total limit",
    (f) => {
      f.admission.deadline++;
    },
  ],
  [
    "pending provider handler",
    (f) => {
      f.observations.cleanup.pendingUpstreams = 1;
    },
  ],
  [
    "wrong denied command",
    (f) => {
      find(f, "injected-native-call", 1).value.args.cmd =
        "printf 'Operation not permitted'";
    },
  ],
  [
    "wrong denied cwd",
    (f) => {
      find(f, "injected-native-call", 1).value.args.workdir += "/other";
    },
  ],
  [
    "wrong denied shell",
    (f) => {
      find(f, "injected-native-call", 1).value.args.shell = "/bin/zsh";
    },
  ],
  [
    "extra denied argument",
    (f) => {
      find(f, "injected-native-call", 1).value.args.yield_time_ms = 1000;
    },
  ],
  [
    "wrong denied invocation",
    (f) => {
      find(f, "injected-native-call", 1).value.invocation.turnId = "other";
    },
  ],
  [
    "missing native positive events",
    (f) => {
      f.journal = f.journal.filter(
        (r) => r.value.params?.item?.type !== "commandExecution",
      );
    },
  ],
  [
    "failed positive",
    (f) => {
      f.journal.find(
        (r) => r.value.method === "item/completed",
      ).value.params.item.exitCode = 1;
    },
  ],
  [
    "missing positive scratch effect",
    (f) => {
      f.after.scratchAllowedSha256 = null;
    },
  ],
  [
    "changed protected oracle",
    (f) => {
      f.after.protectedSha256 = sha("changed");
    },
  ],
  [
    "deleted protected oracle",
    (f) => {
      f.after.protectedSha256 = null;
    },
  ],
  [
    "wrong result call ID",
    (f) => {
      f.requests[2].body.input.at(-1).call_id = "other";
    },
  ],
  [
    "missing authentic outbound call",
    (f) => {
      f.requests[2].body.input.splice(-2, 1);
    },
  ],
  [
    "different authentic arguments",
    (f) => {
      f.requests[2].body.input.at(-2).arguments = "{}";
    },
  ],
  [
    "different authentic route",
    (f) => {
      f.requests[2].body.input.at(-2).name = "write_stdin";
    },
  ],
  [
    "duplicate result",
    (f) => {
      f.requests[2].body.input.push(f.requests[2].body.input.at(-1));
    },
  ],
  [
    "replayed earlier output",
    (f) => {
      f.requests[2].body.input.at(-1).id = "fco_fixture_1";
    },
  ],
  [
    "empty result ID",
    (f) => {
      f.requests[2].body.input.at(-1).id = "";
    },
  ],
  [
    "mutated historical output",
    (f) => {
      f.requests[3].body.input.find(
        (x) => x.type === "function_call_output",
      ).output += "x";
    },
  ],
  [
    "extra provider request",
    (f) => {
      f.requests.push(f.requests.at(-1));
    },
  ],
  [
    "wrong emitted native wire",
    (f) => {
      find(f, "upstream-response-event", 4).value.raw += "x";
    },
  ],
  [
    "missing response completion",
    (f) => {
      f.journal.splice(
        f.journal.indexOf(find(f, "upstream-response-event", 2)),
        1,
      );
    },
  ],
  [
    "late event after provisional",
    (f) => {
      const i = f.journal.indexOf(find(f, "native-settlement", 1));
      f.journal.splice(i + 1, 0, {
        type: "ipc-receive",
        value: {
          method: "item/started",
          params: {
            threadId: "thread",
            turnId: "turn",
            item: {
              id: "native-probe-2",
              type: "commandExecution",
              cwd: definition(f.admission.attempt).source,
              command: definition(f.admission.attempt).nativeCommands[1],
            },
          },
        },
      });
    },
  ],
  [
    "partial event before denial",
    (f) => {
      const i = f.journal.indexOf(find(f, "upstream-request", 2));
      f.journal.splice(i, 0, {
        type: "ipc-receive",
        value: {
          method: "item/started",
          params: {
            threadId: "thread",
            turnId: "turn",
            item: {
              id: "native-probe-2",
              type: "commandExecution",
              cwd: definition(f.admission.attempt).source,
              command: definition(f.admission.attempt).nativeCommands[1],
            },
          },
        },
      });
    },
  ],
  [
    "wrong settlement invocation",
    (f) => {
      find(f, "native-settlement", 1).value.invocation = {
        threadId: "thread",
        turnId: "wrong",
      };
    },
  ],
  [
    "missing write operation",
    (f) => {
      f.journal = f.journal.filter(
        (r) =>
          r.type !== "injected-native-call" ||
          r.value.callId !== "native-probe-3",
      );
    },
  ],
  [
    "pending RPC",
    (f) => {
      f.journal.splice(-3, 0, {
        type: "ipc-send",
        value: { id: "pending", method: "thread/read", params: {} },
      });
    },
  ],
  [
    "pending item",
    (f) => {
      f.journal.splice(-3, 0, {
        type: "ipc-receive",
        value: {
          method: "item/started",
          params: {
            threadId: "thread",
            turnId: "turn",
            item: { id: "pending", type: "agentMessage" },
          },
        },
      });
    },
  ],
  [
    "missing final",
    (f) => {
      f.journal = f.journal.filter(
        (r) => r.value.params?.item?.type !== "agentMessage",
      );
    },
  ],
  [
    "wrong final turn",
    (f) => {
      f.journal.find(
        (r) => r.value.params?.item?.type === "agentMessage",
      ).value.params.turnId = "wrong";
    },
  ],
  [
    "postterminal final",
    (f) => {
      const terminal = f.journal.find(
        (r) => r.value.method === "turn/completed",
      );
      f.journal.splice(f.journal.indexOf(terminal), 1);
      f.journal.splice(
        f.journal.findIndex(
          (r) => r.value.params?.item?.type === "agentMessage",
        ),
        0,
        terminal,
      );
    },
  ],
  [
    "failed final terminal",
    (f) => {
      f.journal.find(
        (r) => r.value.method === "turn/completed",
      ).value.params.turn.status = "failed";
    },
  ],
  [
    "missing EOF",
    (f) => {
      f.journal = f.journal.filter((r) => r.type !== "ipc-eof");
    },
  ],
  [
    "truncated EOF",
    (f) => {
      find(f, "ipc-eof").value.pendingBytes = 3;
    },
  ],
  [
    "signalled app",
    (f) => {
      find(f, "app-exit").value.signal = "SIGKILL";
    },
  ],
  [
    "unresolved owned process",
    (f) => {
      f.observations.cleanup.remaining = [{ pid: 123 }];
    },
  ],
  [
    "guardian recovery",
    (f) => {
      f.observations.cleanup.recoveryUsed = true;
    },
  ],
  [
    "cleanup outside deadline",
    (f) => {
      f.observations.cleanup.finished = 100001;
    },
  ],
  [
    "work deadline exhausted",
    (f) => {
      f.admission.workDeadline = 5;
    },
  ],
  [
    "missing work deadline",
    (f) => {
      delete f.admission.workDeadline;
    },
  ],
  [
    "unbound startup response",
    (f) => {
      f.journal[1].value.id = "wrong";
    },
  ],
  [
    "globally empty turn",
    (f) => {
      f.journal[3].value.result.turn.id = "";
    },
  ],
  [
    "recorded failure",
    (f) => {
      f.journal.push({ type: "failure", value: { message: "failed" } });
    },
  ],
];
for (const [label, mutate] of mutations)
  test(`reject ${label}`, () => {
    const f = settlementFixture();
    mutate(f);
    refresh(f);
    const result = assess(f);
    assert.equal(result.status, "fail", label);
    results.push({ label, result });
  });
const recipe = definition(settlementFixture().admission.attempt);
const valid = terminalOutput(
  `cat: ${recipe.protectedFile}: Operation not permitted\n`,
);
const malformed = [
  ["printed header after stdout", "stdout\n" + valid],
  ["header embedded after Output", terminalOutput(valid, 0)],
  [
    "wrong path",
    valid.replace(recipe.protectedFile, recipe.protectedFile + "-other"),
  ],
  ["unrelated denial", terminalOutput("unrelated: Operation not permitted\n")],
  [
    "parser rejection",
    terminalOutput("Error parsing function call: Operation not permitted\n"),
  ],
  ["signal", valid.replace("code 1", "code 137")],
  ["zero exit", valid.replace("code 1", "code 0")],
  [
    "running session",
    valid.replace(
      "Process exited with code 1",
      "Process running with session ID 55",
    ),
  ],
  ["missing chunk", valid.replace("Chunk ID: 87798b\n", "")],
  ["missing token count", valid.replace("Original token count: 43\n", "")],
  [
    "reordered headers",
    valid.replace(
      "Wall time: 0.0000 seconds\nProcess exited with code 1",
      "Process exited with code 1\nWall time: 0.0000 seconds",
    ),
  ],
  [
    "duplicated header",
    valid.replace("Output:\n", "Process exited with code 1\nOutput:\n"),
  ],
  ["unknown metadata", valid.replace("Output:\n", "Unknown: x\nOutput:\n")],
  ["negative wall time", valid.replace("0.0000", "-0.1000")],
  ["truncated stdout", valid + "\nWarning: output truncated"],
  ["omitted stdout", valid + "[10 lines omitted]"],
  ["extra body", valid + "extra"],
];
for (const [label, value] of malformed)
  test(`strict formatter rejects ${label}`, () => {
    assert.throws(() => requireTerminalDenial(value, 1, recipe.protectedFile));
    const f = settlementFixture();
    output(f, value);
    refresh(f);
    const result = assess(f);
    assert.equal(result.status, "fail");
    results.push({ label, result });
  });
test("read and predeclared write bodies are operation-specific", () => {
  requireTerminalDenial(valid, 1, recipe.protectedFile);
  for (const body of [
    `/bin/sh: ${recipe.protectedFile}: Operation not permitted\n`,
    `/bin/sh: line 1: ${recipe.protectedFile}: Operation not permitted\n`,
  ])
    requireTerminalDenial(terminalOutput(body), 2, recipe.protectedFile);
  assert.throws(() => requireTerminalDenial(valid, 2, recipe.protectedFile));
  assert.throws(() => requireTerminalDenial(valid, 0, recipe.protectedFile));
});
test("same-call wait joins result-before-events without silence timer", async () => {
  const f = settlementFixture(),
    state = new NativeSettlement(recipe, {
      threadId: "thread",
      turnId: "turn",
    });
  state.provider(f.requests[0].body, 1);
  state.inject(find(f, "injected-native-call").value, 2);
  let settled = false;
  const waiting = state.wait("native-probe-1", Date.now() + 1000).then(() => {
    settled = true;
  });
  state.provider(f.requests[1].body, 3);
  await Promise.resolve();
  assert.equal(settled, false);
  for (const [i, method] of ["item/started", "item/completed"].entries())
    state.event({
      seq: 4 + i,
      value: {
        method,
        params: {
          threadId: "thread",
          turnId: "turn",
          item: {
            id: "native-probe-1",
            type: "commandExecution",
            cwd: recipe.source,
            command: recipe.nativeCommands[0],
            exitCode: 0,
          },
        },
      },
    });
  await waiting;
  assert.equal(settled, true);
  assert.equal(state.listenerCount("changed"), 0);
});
test("pending same-call wait abort and deadline reject with no leaked listeners", async () => {
  const state = new NativeSettlement(recipe, {
    threadId: "thread",
    turnId: null,
  });
  const controller = new AbortController();
  const result = assert.rejects(
    state.wait(null, Date.now() + 1000, controller.signal),
    /cancelled/,
  );
  controller.abort(Error("cancelled"));
  await result;
  await assert.rejects(state.wait(null, Date.now() - 1), /deadline/);
  assert.equal(state.listenerCount("changed"), 0);
});
test("historical complete 8930 bundle remains failed, never retrofitted", () => {
  const path = join(
    ROOT,
    ".qualification/harness-native-64/attempt-2026-09-28T02-35-51.938Z",
  );
  const result = checkAttempt(path, "8930b4849eb9ae5bb2176fda9e8712826c69244c");
  assert.equal(result.status, "fail");
  assert.equal(result.reason, "recorded-attempt-error");
  save(join(dir, "historical-8930-current-assessment.json"), { path, result });
});
