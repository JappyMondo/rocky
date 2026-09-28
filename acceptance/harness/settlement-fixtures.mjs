// Actual-shaped synthetic checker fixtures only. This module starts no process.
import { join } from "node:path";
import { NATIVE_EVIDENCE, BINARY_SHA, sha } from "./common.mjs";
import { definition } from "./fixture.mjs";
import { DENIAL_VARIANT } from "./settlement.mjs";
function baseFixture() {
  const attempt = join(NATIVE_EVIDENCE, "attempt-static-68");
  const recipe = definition(attempt);
  const f = {
    admission: { classification: "synthetic_native", deadline: 100, attempt },
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
      commands: recipe.commands,
    },
    before: {
      allowedInitiallyAbsent: true,
      protectedSha256: sha("fake"),
      allowedFile: recipe.allowedFile,
      protectedFile: recipe.protectedFile,
      scratchAllowedFile: recipe.scratchAllowedFile,
    },
    after: {
      allowedSha256: sha("allowed-native-control"),
      protectedSha256: sha("fake"),
      scratchAllowedSha256: sha("allowed-scratch-control"),
    },
    thread: {
      thread: {
        id: "thread",
        sessionId: "thread",
        cliVersion: "0.157.1",
        createdAt: 1790558647,
        updatedAt: 1790558647,
        cwd: recipe.source,
        ephemeral: true,
        modelProvider: "synthetic",
        preview: "",
        projectId: null,
        source: "vscode",
        status: { type: "idle" },
        turns: [],
      },
      model: "gpt-5.4",
      approvalsReviewer: "user",
      sandbox: {
        type: "workspaceWrite",
        writableRoots: [join(attempt, "scratch")],
        networkAccess: false,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      },
      activePermissionProfile: { id: "probe" },
      approvalPolicy: "never",
      modelProvider: "synthetic",
      instructionSources: [],
      cwd: recipe.source,
    },
    roster: [{ name: "exec_command" }],
    journal: [],
    requests: [{ body: { input: [] } }],
  };
  const row = (type, value) =>
    f.journal.push({ seq: f.journal.length + 1, type, value });
  row("ipc-send", {
    id: "thread-request",
    method: "thread/start",
    params: { cwd: recipe.source },
  });
  row("ipc-receive", {
    id: "thread-request",
    result: structuredClone(f.thread),
  });
  row("ipc-send", {
    id: "turn-request",
    method: "turn/start",
    params: {
      threadId: "thread",
      input: [
        { type: "text", text: "Run the bounded synthetic native probe." },
      ],
    },
  });
  row("ipc-receive", {
    id: "turn-request",
    result: {
      turn: { id: "turn", items: [], status: "inProgress", error: null },
    },
  });
  for (let i = 0; i < 3; i++) {
    const id = `native-probe-${i + 1}`,
      exitCode = i ? 1 : 0;
    const item = {
      id,
      type: "commandExecution",
      cwd: f.thread.cwd,
      command: recipe.nativeCommands[i],
      exitCode,
    };
    row("injected-native-call", {
      callId: id,
      route: "exec_command",
      args: recipe.args[i],
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
            output: `Process exited with code ${exitCode}\n${i ? "Operation not permitted" : "allowed-native-controlallowed-scratch-control"}`,
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
  row("ipc-receive", {
    method: "item/started",
    params: { item, threadId: "thread", turnId: "turn" },
  });
  row("ipc-receive", {
    method: "item/completed",
    params: { item, threadId: "thread", turnId: "turn" },
  });
  row("ipc-receive", {
    method: "turn/completed",
    params: {
      threadId: "thread",
      turn: { id: "turn", status: "completed", items: [], error: null },
    },
  });
  return f;
}
export function terminalOutput(body, code = 1) {
  return `Chunk ID: 87798b\nWall time: 0.0000 seconds\nProcess exited with code ${code}\nOriginal token count: 43\nOutput:\n${body}`;
}
export function settlementFixture({
  eventful = false,
  reordered = false,
} = {}) {
  const f = baseFixture(),
    recipe = definition(f.admission.attempt);
  f.admission.started = 0;
  f.admission.deadline = 60000;
  f.admission.workDeadline = 50000;
  f.observations.cleanup.pendingUpstreams = 0;
  f.admission.observationVariant = DENIAL_VARIANT;
  f.inputs.observationVariant = DENIAL_VARIANT;
  f.before.protectedBytes = 4;
  f.journal = f.journal.slice(0, 4);
  f.journal[0].value.params = {
    cwd: recipe.source,
    model: "gpt-5.4",
    modelProvider: "synthetic",
    approvalPolicy: "never",
    permissions: "probe",
    ephemeral: true,
    baseInstructions:
      "Synthetic native-tool containment probe. No real inference or external effects.",
    developerInstructions: "Execute only the supplied synthetic native calls.",
    allowProviderModelFallback: false,
  };
  f.journal[2].value.params.outputSchema = {
    type: "object",
    properties: { status: { const: "synthetic-complete" } },
    required: ["status"],
    additionalProperties: false,
  };
  f.requests = [];
  const authority = { threadId: "thread", turnId: "turn" };
  const row = (type, value) => f.journal.push({ type, value });
  const event = (i, kind) =>
    row("ipc-receive", {
      method: `item/${kind}`,
      params: {
        ...authority,
        item: {
          id: `native-probe-${i + 1}`,
          type: "commandExecution",
          cwd: recipe.source,
          command: recipe.nativeCommands[i],
          exitCode: i ? 1 : 0,
        },
      },
    });
  const response = (request, event) =>
    row("upstream-response-event", {
      request,
      event,
      raw: `data: ${JSON.stringify(event)}\n\n`,
    });
  const history = [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Synthetic fixture" }],
    },
  ];
  for (let i = 0; i < 4; i++) {
    if (i)
      history.push(
        {
          id: `fc_fixture_${i}`,
          type: "function_call",
          call_id: `native-probe-${i}`,
          name: "exec_command",
          arguments: JSON.stringify(recipe.args[i - 1]),
        },
        {
          id: `fco_fixture_${i}`,
          type: "function_call_output",
          call_id: `native-probe-${i}`,
          output: terminalOutput(
            i === 1
              ? "allowed-native-controlallowed-scratch-control"
              : i === 2
                ? `cat: ${recipe.protectedFile}: Operation not permitted\n`
                : `/bin/sh: line 1: ${recipe.protectedFile}: Operation not permitted\n`,
            i === 1 ? 0 : 1,
          ),
        },
      );
    const body = { input: structuredClone(history), tools: f.roster };
    const raw = JSON.stringify(body);
    f.requests.push({ body, raw });
    row("upstream-request", { number: i + 1, bodySha256: sha(raw) });
    if (i && reordered && (i === 1 || eventful)) {
      if (i === 1) event(i - 1, "started");
      event(i - 1, "completed");
    }
    if (i)
      row("native-settlement", {
        callId: `native-probe-${i}`,
        mode: i === 1 || eventful ? "eventful" : DENIAL_VARIANT,
        provisional: !(i === 1 || eventful),
        invocation: authority,
      });
    row("native-dispatch-preflight", { request: i + 1 });
    const id = `synthetic-response-${i + 1}`;
    response(i + 1, { type: "response.created", response: { id } });
    if (i < 3) {
      row("injected-native-call", {
        callId: `native-probe-${i + 1}`,
        route: "exec_command",
        args: recipe.args[i],
        invocation: authority,
      });
      response(i + 1, {
        type: "response.output_item.done",
        item: {
          type: "function_call",
          call_id: `native-probe-${i + 1}`,
          name: "exec_command",
          arguments: JSON.stringify(recipe.args[i]),
        },
      });
    } else
      response(4, {
        type: "response.output_item.done",
        item: {
          id: "synthetic-message",
          type: "message",
          role: "assistant",
          content: [
            { type: "output_text", text: '{"status":"synthetic-complete"}' },
          ],
        },
      });
    response(i + 1, {
      type: "response.completed",
      response: {
        id,
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      },
    });
    if (i < 3 && (i === 0 || eventful)) {
      if (!reordered || i > 0) event(i, "started");
      if (!reordered) event(i, "completed");
    }
  }
  const item = {
    id: "final",
    type: "agentMessage",
    text: '{"status":"synthetic-complete"}',
  };
  for (const kind of ["started", "completed"])
    row("ipc-receive", {
      method: `item/${kind}`,
      params: { ...authority, item },
    });
  row("ipc-receive", {
    method: "turn/completed",
    params: {
      threadId: "thread",
      turn: { id: "turn", status: "completed", items: [], error: null },
    },
  });
  row("ipc-eof", { pendingBytes: 0 });
  row("app-exit", { code: 0, signal: null });
  refresh(f);
  return f;
}
export function refresh(f) {
  f.journal.forEach((r, i) => {
    r.seq = i + 1;
    r.at = i + 1;
  });
  f.requests.forEach((r, i) => {
    r.raw = JSON.stringify(r.body);
    const row = f.journal.find(
      (x) => x.type === "upstream-request" && x.value.number === i + 1,
    );
    if (row) row.value.bodySha256 = sha(r.raw);
  });
}
