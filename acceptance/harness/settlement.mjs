import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { sha } from "./common.mjs";

export const DENIAL_VARIANT = "source-bound-terminal-denial-v1";
const validId = (v) =>
  typeof v === "string" && v.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(v);

// Pinned ExecCommandToolOutput::response_header/response_text. Parse metadata
// only at byte zero; command stdout cannot masquerade as terminal metadata.
export function parseTerminalOutput(text) {
  assert.equal(typeof text, "string", "nontext-native-output");
  const m =
    /^Chunk ID: ([a-f0-9]{1,64})\nWall time: ([0-9]+\.[0-9]{4}) seconds\nProcess exited with code (-?(?:0|[1-9][0-9]*))\nOriginal token count: (0|[1-9][0-9]*)\nOutput:\n([\s\S]*)$/.exec(
      text,
    );
  assert(m, "unsupported-native-terminal-envelope");
  const exitCode = Number(m[3]),
    seconds = Number(m[2]),
    tokens = Number(m[4]);
  assert(
    Number.isSafeInteger(exitCode) &&
      Number.isFinite(seconds) &&
      seconds >= 0 &&
      Number.isSafeInteger(tokens),
    "invalid-native-terminal-metadata",
  );
  assert(
    !/truncated|omitted|omission|Process running with session ID/i.test(m[5]),
    "incomplete-native-output",
  );
  return { chunkId: m[1], seconds, exitCode, tokens, body: m[5] };
}

export function requireTerminalDenial(text, operation, protectedFile) {
  assert(operation === 1 || operation === 2, "alternate-not-for-positive");
  const result = parseTerminalOutput(text);
  assert(
    result.exitCode > 0 && result.exitCode < 128,
    "non-denial-or-signal-exit",
  );
  // The read diagnostic was observed. These two exact sh redirection forms are
  // predeclared prospective write forms, not a claim of observed native write.
  const bodies =
    operation === 1
      ? [`cat: ${protectedFile}: Operation not permitted\n`]
      : [
          `/bin/sh: ${protectedFile}: Operation not permitted\n`,
          `/bin/sh: line 1: ${protectedFile}: Operation not permitted\n`,
        ];
  assert(bodies.includes(result.body), "wrong-operation-denial-body");
  return result;
}

// One active invocation, one outstanding native call. Both live dispatch and
// offline journal replay use this state machine; it creates no OS resources.
export class NativeSettlement extends EventEmitter {
  constructor(recipe, authority) {
    super();
    this.recipe = recipe;
    this.authority = authority;
    this.calls = [];
    this.history = [];
    this.fullHistory = [];
    this.requests = 0;
    this.envelopeIds = new Set();
  }
  bindTurn(turnId) {
    assert(
      !this.authority.turnId && validId(turnId),
      "duplicate-or-invalid-turn-binding",
    );
    this.authority.turnId = turnId;
    this.emit("changed");
  }
  inject(call, seq) {
    const i = this.calls.length;
    assert(
      i < 3 &&
        validId(this.authority.threadId) &&
        validId(this.authority.turnId),
      "unbound-native-invocation",
    );
    if (i)
      assert(
        this.calls[i - 1].settlement,
        "dispatch-before-previous-settlement",
      );
    assert.equal(
      call.callId,
      `native-probe-${i + 1}`,
      "unexpected-native-call-id",
    );
    assert.equal(call.route, "exec_command", "unexpected-native-route");
    assert.deepEqual(
      call.args,
      this.recipe.args[i],
      "native-arguments-mismatch",
    );
    assert.deepEqual(
      call.invocation,
      this.authority,
      "native-invocation-mismatch",
    );
    assert.equal(this.requests, i + 1, "dispatch-without-own-provider-request");
    this.calls.push({ index: i, call, injectedSeq: seq });
  }
  event(row) {
    const m = row.value;
    const p = m.params;
    const delta = m.method === "item/commandExecution/outputDelta";
    const lifecycle = ["item/started", "item/completed"].includes(m.method);
    const c = this.calls.find(
      (x) => x.call.callId === (delta ? p?.itemId : p?.item?.id),
    );
    if (!delta && (!lifecycle || (!c && p?.item?.type !== "commandExecution")))
      return;
    assert(c, "unbound-native-event");
    assert(
      c.settlement?.mode !== DENIAL_VARIANT,
      "late-event-after-provisional-denial",
    );
    assert.equal(p.threadId, this.authority.threadId, "native-thread-mismatch");
    assert.equal(p.turnId, this.authority.turnId, "native-turn-mismatch");
    assert(row.seq > c.injectedSeq, "native-event-before-injection");
    if (delta) {
      assert(
        typeof p.delta === "string" && !c.end,
        "invalid-or-postcompletion-output-delta",
      );
      c.activity = row;
      return; // Any observed native output prevents a zero-event alternative.
    }
    assert.equal(
      p.item.type,
      "commandExecution",
      "conflicting-native-item-type",
    );
    assert.equal(p.item.cwd, this.recipe.source, "wrong-native-workdir");
    assert.equal(
      p.item.command,
      this.recipe.nativeCommands[c.index],
      "native-command-mismatch",
    );
    assert(row.seq > c.injectedSeq, "native-event-before-injection");
    const key = m.method === "item/started" ? "start" : "end";
    assert(!c[key], "duplicate-native-event");
    if (key === "end")
      assert(
        c.start && c.start.seq < row.seq,
        "native-completion-without-start",
      );
    c[key] = row;
    this.update(c);
    this.emit("changed");
  }
  provider(body, seq) {
    assert(Array.isArray(body.input), "missing-provider-input");
    assert.equal(
      this.requests,
      this.calls.length,
      "replayed-or-unexpected-provider-request",
    );
    const items = body.input.filter((x) =>
      ["function_call", "function_call_output"].includes(x.type),
    );
    if (this.requests) {
      assert.deepEqual(
        body.input.slice(0, this.fullHistory.length),
        this.fullHistory,
        "mutated-cumulative-provider-history",
      );
      assert.equal(
        body.input.length,
        this.fullHistory.length + 2,
        "replayed-or-extra-provider-history",
      );
    }
    assert(
      !body.input.some(
        (x) => /tool_call/.test(x.type ?? "") || x.type === "custom_tool_call",
      ),
      "unsupported-provider-envelope",
    );
    assert.equal(
      items.length,
      this.calls.length * 2,
      "missing-or-duplicate-call-output",
    );
    assert.deepEqual(
      items.slice(0, this.history.length),
      this.history,
      "mutated-provider-history",
    );
    if (this.calls.length) {
      const c = this.calls.at(-1),
        [call, output] = items.slice(-2);
      assert(!c.output, "replayed-native-result");
      assert.equal(
        call.type,
        "function_call",
        "missing-authentic-function-call",
      );
      assert.equal(
        output.type,
        "function_call_output",
        "missing-authentic-function-result",
      );
      for (const item of [call, output]) {
        assert(
          validId(item.id) && !this.envelopeIds.has(item.id),
          "invalid-or-reused-provider-id",
        );
        this.envelopeIds.add(item.id);
        assert.equal(item.call_id, c.call.callId, "provider-call-id-mismatch");
      }
      assert.equal(call.name, "exec_command", "provider-route-mismatch");
      assert.equal(
        call.arguments,
        JSON.stringify(this.recipe.args[c.index]),
        "provider-arguments-mismatch",
      );
      c.output = structuredClone(output);
      c.outputSeq = seq;
      c.terminal = parseTerminalOutput(output.output);
      this.update(c);
    }
    this.history = structuredClone(items);
    this.fullHistory = structuredClone(body.input);
    this.requests++;
    this.emit("changed");
  }
  update(c) {
    if (!c.output || c.settlement) return;
    if (c.start || c.end || c.activity) {
      if (!c.start || !c.end) return;
      assert.equal(
        c.terminal.exitCode,
        c.end.value.params.item.exitCode,
        "ipc-provider-exit-mismatch",
      );
      if (c.index === 0) {
        assert.equal(c.terminal.exitCode, 0, "allowed-native-control-failed");
        assert.equal(
          c.terminal.body,
          "allowed-native-controlallowed-scratch-control",
          "wrong-positive-output-body",
        );
      }
      c.settlement = {
        mode: "eventful",
        seq: Math.max(c.end.seq, c.outputSeq),
        exitCode: c.terminal.exitCode,
      };
    } else if (c.index > 0) {
      requireTerminalDenial(
        c.output.output,
        c.index,
        this.recipe.protectedFile,
      );
      c.settlement = {
        mode: DENIAL_VARIANT,
        seq: c.outputSeq,
        exitCode: c.terminal.exitCode,
        provisional: true,
      };
    }
  }
  wait(callId, deadline, signal) {
    const ready = () =>
      callId === null
        ? Boolean(this.authority.turnId)
        : Boolean(this.calls.find((x) => x.call.callId === callId)?.settlement);
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.off("changed", changed);
        signal?.removeEventListener("abort", aborted);
      };
      const changed = () => {
        if (Date.now() >= deadline) {
          cleanup();
          reject(Error("settlement-deadline"));
        } else if (ready()) {
          cleanup();
          resolve();
        }
      };
      const aborted = () => {
        cleanup();
        reject(signal.reason ?? Error("settlement-cancelled"));
      };
      const timer = setTimeout(
        () => {
          cleanup();
          reject(Error("settlement-deadline"));
        },
        Math.max(0, deadline - Date.now()),
      );
      this.on("changed", changed);
      signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) aborted();
      else changed();
    });
  }
}

export function replaySettlement(
  recipe,
  authority,
  journal,
  requests,
  workDeadline,
) {
  assert(Number.isSafeInteger(workDeadline), "invalid-work-deadline");
  const state = new NativeSettlement(recipe, { ...authority });
  const responseFrames = [],
    receipts = new Map();
  let requestIndex = 0;
  for (const row of journal) {
    if (row.type === "injected-native-call") {
      assert(row.at <= workDeadline, "native-dispatch-after-deadline");
      state.inject(row.value, row.seq);
    } else if (row.type === "ipc-receive") state.event(row);
    else if (row.type === "upstream-request") {
      const request = requests[requestIndex++];
      assert(request, "unbound-provider-request");
      assert.equal(
        row.value.number,
        requestIndex,
        "provider-request-order-mismatch",
      );
      assert.equal(
        row.value.bodySha256,
        sha(request.raw),
        "provider-request-byte-mismatch",
      );
      assert.deepEqual(
        JSON.parse(request.raw),
        request.body,
        "provider-raw-body-mismatch",
      );
      state.provider(request.body, row.seq);
    } else if (row.type === "upstream-response-event") responseFrames.push(row);
    else if (row.type === "native-settlement") {
      const c = state.calls.find((c) => c.call.callId === row.value.callId);
      assert(
        c?.settlement && !receipts.has(c.call.callId),
        "invalid-settlement-receipt",
      );
      assert.equal(
        row.value.mode,
        c.settlement.mode,
        "settlement-mode-mismatch",
      );
      assert.deepEqual(
        row.value.invocation,
        authority,
        "settlement-invocation-mismatch",
      );
      assert.equal(
        row.value.provisional,
        c.settlement.mode === DENIAL_VARIANT,
        "settlement-provisional-mismatch",
      );
      assert(
        row.seq > c.settlement.seq && row.at <= workDeadline,
        "invalid-settlement-order-or-deadline",
      );
      receipts.set(c.call.callId, row.seq);
    }
  }
  assert.equal(requestIndex, 4, "incomplete-provider-transcript");
  assert.equal(requests.length, requestIndex, "unbound-extra-provider-request");
  assert.equal(
    responseFrames.length,
    12,
    "incomplete-or-extra-provider-response",
  );
  for (let i = 0; i < 4; i++) {
    const frames = responseFrames.filter((r) => r.value.request === i + 1);
    assert.equal(frames.length, 3, "incomplete-provider-response");
    const id = `synthetic-response-${i + 1}`;
    assert.deepEqual(
      frames[0].value.event,
      { type: "response.created", response: { id } },
      "wrong-provider-response-start",
    );
    assert.deepEqual(
      frames[2].value.event,
      {
        type: "response.completed",
        response: {
          id,
          usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        },
      },
      "wrong-provider-response-terminal",
    );
    if (i === 3)
      assert.deepEqual(
        frames[1].value.event,
        {
          type: "response.output_item.done",
          item: {
            id: "synthetic-message",
            type: "message",
            role: "assistant",
            content: [
              { type: "output_text", text: '{"status":"synthetic-complete"}' },
            ],
          },
        },
        "wrong-provider-final-message",
      );
    for (const frame of frames) {
      assert.equal(
        frame.value.raw,
        `data: ${JSON.stringify(frame.value.event)}\n\n`,
        "provider-response-wire-mismatch",
      );
      const req = journal.find(
        (r) => r.type === "upstream-request" && r.value.number === i + 1,
      );
      const next = journal.find(
        (r) => r.type === "upstream-request" && r.value.number === i + 2,
      );
      assert(
        frame.seq > req.seq &&
          (!next || frame.seq < next.seq) &&
          frame.at <= workDeadline,
        "provider-response-order-or-deadline",
      );
    }
  }
  assert.equal(state.calls.length, 3, "missing-native-operation");
  assert.equal(
    responseFrames.filter((r) => r.value.event?.item?.type === "function_call")
      .length,
    3,
    "unbound-emitted-native-call",
  );
  for (const c of state.calls) {
    assert(
      c.settlement && receipts.has(c.call.callId),
      "unsettled-native-call",
    );
    if (c.index)
      assert(
        receipts.get(state.calls[c.index - 1].call.callId) < c.injectedSeq,
        "next-dispatch-before-settlement-receipt",
      );
    const frames = responseFrames.filter(
      (r) => r.value.event?.item?.call_id === c.call.callId,
    );
    assert.equal(frames.length, 1, "missing-or-duplicate-emitted-call");
    const f = frames[0];
    assert.equal(f.value.request, c.index + 1, "emitted-call-request-mismatch");
    assert.equal(
      f.value.event.type,
      "response.output_item.done",
      "wrong-emitted-call-event",
    );
    assert.deepEqual(
      f.value.event.item,
      {
        type: "function_call",
        call_id: c.call.callId,
        name: "exec_command",
        arguments: JSON.stringify(recipe.args[c.index]),
      },
      "emitted-call-mismatch",
    );
    assert.equal(
      f.value.raw,
      `data: ${JSON.stringify(f.value.event)}\n\n`,
      "emitted-call-wire-mismatch",
    );
    assert(
      f.seq > c.injectedSeq && f.seq < c.outputSeq,
      "emitted-call-order-mismatch",
    );
  }
  const eof = journal.filter((r) => r.type === "ipc-eof");
  assert.equal(eof.length, 1, "missing-or-duplicate-ipc-eof");
  assert.equal(eof[0].value.pendingBytes, 0, "truncated-ipc-at-eof");
  assert(
    !journal.some((r) => r.type === "ipc-receive" && r.seq > eof[0].seq),
    "ipc-after-eof",
  );
  assert(
    !journal.some(
      (r) =>
        ["failure", "upstream-error", "boundary-failed"].includes(r.type) ||
        (r.type === "ipc-receive" && r.value.method === "error"),
    ),
    "contradictory-error-evidence",
  );
  const terminal = journal.filter(
    (r) => r.type === "ipc-receive" && r.value.method === "turn/completed",
  );
  assert.equal(terminal.length, 1, "missing-or-duplicate-terminal");
  assert(terminal[0].at <= workDeadline, "terminal-after-work-deadline");
  assert(
    terminal[0].seq < eof[0].seq &&
      receipts.get("native-probe-3") < terminal[0].seq,
    "terminal-before-settlement-or-after-eof",
  );
  const exits = journal.filter((r) => r.type === "app-exit");
  assert.equal(exits.length, 1, "missing-or-duplicate-app-exit");
  assert.equal(exits[0].value.code, 0, "abnormal-app-exit");
  assert.equal(exits[0].value.signal, null, "signalled-app-exit");
  assert(exits[0].seq > terminal[0].seq, "app-exit-before-terminal");
  return state.calls;
}
