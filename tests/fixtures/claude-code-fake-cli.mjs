// Owned fake Claude Code CLI for Taskbot #97 adapter tests (evidence class owned-fake-cli).
// Test support wraps this module into an executable pinned-binary fixture (shebang + execPath);
// this file itself is never executed directly and is never the real pinned candidate.
// It is NOT the pinned candidate and grants nothing: it deterministically records its exact
// argv/env/cwd/stdin and replays scripted stream-json bytes, exits and signal behaviors so the
// adapter's protocol rules can be exercised against real spawned processes. Scenario source is
// either a marker file at ${TMPDIR}/fake-scenario.json (checked first; supports scenarios that
// must never read stdin) or the stdin prompt itself, which is then a JSON script document.
import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const tmp = process.env.TMPDIR ?? "/tmp";
const recordPath = join(tmp, "fake-record.json");
// Self-consistent defaults derived from the fake's OWN argv/cwd, so init/result frames always
// match the composed bundle unless a scenario explicitly injects a fault.
function argvValue(flag) {
  const prefix = `${flag}=`;
  for (const element of process.argv.slice(2))
    if (element.startsWith(prefix)) return element.slice(prefix.length);
  return null;
}
const fakeModel = argvValue("--model") ?? "unknown-model";
const fakeTools = (argvValue("--tools") ?? "").split(",").filter(Boolean);
function expandMacros(value) {
  if (value === "$model") return fakeModel;
  if (value === "$cwd") return process.cwd();
  if (Array.isArray(value)) return value.map(expandMacros);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value))
      out[key === "$model" ? fakeModel : key] = expandMacros(item);
    return out;
  }
  return value;
}
function defaultInit(overrides) {
  return {
    type: "system",
    subtype: "init",
    session_id: "fake-session-0001",
    apiKeySource: "none",
    claude_code_version: "2.1.283",
    cwd: process.cwd(),
    tools: fakeTools,
    mcp_servers: [],
    model: fakeModel,
    permissionMode: "dontAsk",
    slash_commands: [],
    skills: [],
    plugins: [],
    ...expandMacros(overrides ?? {}),
  };
}
function defaultResult(overrides) {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 3,
    duration_ms: 42,
    duration_api_ms: 30,
    total_cost_usd: 0.0123,
    permission_denials: [],
    modelUsage: {
      [fakeModel]: {
        inputTokens: 1200,
        outputTokens: 340,
        cacheReadInputTokens: 800,
        cacheCreationInputTokens: 100,
        thinkingTokens: 40,
        webSearchRequests: 0,
        costUSD: 0.0123,
        contextWindow: 200000,
        maxOutputTokens: 32000,
        provider: "firstParty",
      },
    },
    stop_reason: "end_turn",
    terminal_reason: "completed",
    result_index: 0,
    ...expandMacros(overrides ?? {}),
  };
}
const record = {
  pid: process.pid,
  argv: process.argv.slice(2),
  env: { ...process.env },
  cwd: process.cwd(),
  startedAt: Date.now(),
  stdin: { bytes: 0, sha256: null, eofCount: 0, chunks: 0 },
  scriptSource: null,
  finishedAt: null,
};
function saveRecord() {
  writeFileSync(recordPath, JSON.stringify(record, null, 1));
}
saveRecord();
const writeOut = (data) =>
  new Promise((resolve) => {
    if (!process.stdout.write(data)) process.stdout.once("drain", resolve);
    else resolve();
  });
const writeErr = (data) =>
  new Promise((resolve) => {
    if (!process.stderr.write(data)) process.stderr.once("drain", resolve);
    else resolve();
  });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function runStep(step) {
  if (step.init !== undefined)
    await writeOut(JSON.stringify(defaultInit(step.init)) + "\n");
  else if (step.result !== undefined)
    await writeOut(JSON.stringify(defaultResult(step.result)) + "\n");
  else if (step.toolUse !== undefined) {
    const toolUse = expandMacros(step.toolUse);
    await writeOut(
      JSON.stringify({
        type: "assistant",
        message: {
          id: `msg_${toolUse.id}`,
          model: fakeModel,
          content: [
            {
              type: "tool_use",
              id: toolUse.id,
              name: toolUse.name,
              input: toolUse.input ?? {},
            },
          ],
          stop_reason: "tool_use",
        },
        parent_tool_use_id: null,
      }) + "\n",
    );
  } else if (step.toolResult !== undefined) {
    const toolResult = expandMacros(step.toolResult);
    await writeOut(
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: toolResult.id,
              content: toolResult.content ?? "ok",
              ...(toolResult.isError === undefined
                ? {}
                : { is_error: toolResult.isError }),
            },
          ],
        },
        tool_use_result: { synthetic: true },
      }) + "\n",
    );
  } else if (step.assistantError !== undefined) {
    const spec = expandMacros(step.assistantError);
    await writeOut(
      JSON.stringify({
        type: "assistant",
        message: {
          id: `msg_err_${spec.error}`,
          model: fakeModel,
          content: [],
          stop_reason: null,
        },
        parent_tool_use_id: null,
        error: spec.error,
        ...(spec.aborted === undefined ? {} : { aborted: spec.aborted }),
      }) + "\n",
    );
  } else if (step.aborted !== undefined)
    await writeOut(
      JSON.stringify({
        type: "assistant",
        message: { id: "msg_aborted", model: fakeModel, content: [] },
        parent_tool_use_id: null,
        aborted: step.aborted,
      }) + "\n",
    );
  else if (step.initFrag !== undefined) {
    const bytes = Buffer.from(
      JSON.stringify(defaultInit(step.initFrag.init ?? {})) + "\n",
      "utf8",
    );
    const size = Math.max(1, step.initFrag.size ?? 1);
    for (let at = 0; at < bytes.length; at += size)
      await writeOut(bytes.subarray(at, at + size));
  } else if (step.resultFrag !== undefined) {
    const bytes = Buffer.from(
      JSON.stringify(defaultResult(step.resultFrag.result ?? {})) + "\n",
      "utf8",
    );
    const size = Math.max(1, step.resultFrag.size ?? 1);
    for (let at = 0; at < bytes.length; at += size)
      await writeOut(bytes.subarray(at, at + size));
  } else if (step.outPad !== undefined)
    await writeOut(
      `{"type":"system","subtype":"api_retry","pad":"${"x".repeat(step.outPad)}"}\n`,
    );
  else if (step.out !== undefined)
    await writeOut(JSON.stringify(expandMacros(step.out)) + "\n");
  else if (step.outText !== undefined) await writeOut(step.outText);
  else if (step.outRaw !== undefined)
    await writeOut(Buffer.from(step.outRaw, "base64"));
  else if (step.outFrag !== undefined) {
    const bytes = Buffer.from(
      JSON.stringify(expandMacros(step.outFrag)) + "\n",
      "utf8",
    );
    const size = Math.max(1, step.size ?? 1);
    for (let at = 0; at < bytes.length; at += size)
      await writeOut(bytes.subarray(at, at + size));
  } else if (step.err !== undefined) await writeErr(step.err);
  else if (step.errRaw !== undefined)
    await writeErr(Buffer.from(step.errRaw, "base64"));
  else if (step.sleep !== undefined) await pause(step.sleep);
  else if (step.marker !== undefined)
    writeFileSync(join(tmp, step.marker), String(Date.now()));
  else if (step.waitFile !== undefined) {
    const deadline = Date.now() + (step.timeoutMs ?? 10000);
    while (!existsSync(join(tmp, step.waitFile))) {
      if (Date.now() > deadline) throw new Error("fake-wait-timeout");
      await pause(10);
    }
  } else if (step.writeSrc !== undefined) {
    const target = join(process.cwd(), step.writeSrc.path);
    writeFileSync(target, step.writeSrc.content ?? "written-by-fake\n");
  } else if (step.spawn !== undefined) {
    if (step.spawn === "group") {
      const child = spawn(process.execPath, ["-e", "setInterval(()=>{},500)"], {
        stdio: "ignore",
      });
      writeFileSync(join(tmp, "fake-descendant.pid"), String(child.pid));
      child.unref();
    } else if (step.spawn === "escaped-stderr") {
      // Detached (own group) descendant that keeps the inherited stderr pipe open: the owned
      // group dies but the carrier stderr EOF never arrives, so quiescence stays unproven.
      const child = spawn(process.execPath, ["-e", "setInterval(()=>{},500)"], {
        detached: true,
        stdio: ["ignore", "ignore", process.stderr],
      });
      writeFileSync(join(tmp, "fake-escaped.pid"), String(child.pid));
      child.unref();
    } else if (step.spawn === "escaped") {
      const child = spawn(process.execPath, ["-e", "setInterval(()=>{},500)"], {
        detached: true,
        stdio: "ignore",
      });
      writeFileSync(join(tmp, "fake-escaped.pid"), String(child.pid));
      child.unref();
    } else throw new Error("fake-unknown-spawn");
  } else if (step.ignoreSigterm === true) {
    process.on("SIGTERM", () => {});
  } else if (step.sigtermLate !== undefined) {
    const spec = step.sigtermLate;
    process.once("SIGTERM", () => {
      void (async () => {
        for (const frame of spec.frames ?? [])
          await writeOut(
            JSON.stringify(
              frame === "$result" ? defaultResult({}) : expandMacros(frame),
            ) + "\n",
          );
        record.finishedAt = Date.now();
        saveRecord();
        process.exit(spec.exitCode ?? 143);
      })();
    });
  } else if (step.endOut === true) process.stdout.end();
  else if (step.endErr === true) process.stderr.end();
  else if (step.exit !== undefined) {
    record.finishedAt = Date.now();
    saveRecord();
    process.exit(step.exit);
  } else throw new Error(`fake-unknown-step:${JSON.stringify(step)}`);
}
async function play(document) {
  for (const step of document.script ?? []) await runStep(step);
  record.finishedAt = Date.now();
  saveRecord();
  if (document.exit !== undefined) process.exit(document.exit);
  process.exitCode = 0;
}
function fail(message) {
  record.error = message;
  record.finishedAt = Date.now();
  saveRecord();
  process.stderr.write(`fake-cli: ${message}\n`);
  process.exit(2);
}
const markerPath = join(tmp, "fake-scenario.json");
if (existsSync(markerPath)) {
  record.scriptSource = "marker";
  saveRecord();
  let document;
  try {
    document = JSON.parse(readFileSync(markerPath, "utf8"));
  } catch (error) {
    fail(`marker-parse:${error.message}`);
  }
  if (document.readStdin === false) {
    // Never attaches a stdin reader: the parent's write stays pipe-buffered or EPIPEs, and the
    // attempt must remain attempted-unknown with no resend.
    void play(document);
  } else {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => {
      const bytes = Buffer.concat(chunks);
      record.stdin.bytes = bytes.length;
      record.stdin.sha256 = createHash("sha256").update(bytes).digest("hex");
      record.stdin.eofCount = 1;
      saveRecord();
      let promptDocument;
      try {
        promptDocument = JSON.parse(bytes.toString("utf8"));
      } catch {
        promptDocument = null;
      }
      void play(promptDocument ?? document);
    });
  }
} else {
  record.scriptSource = "stdin";
  saveRecord();
  const chunks = [];
  process.stdin.on("data", (chunk) => {
    chunks.push(chunk);
    record.stdin.chunks++;
    appendFileSync(join(tmp, "fake-stdin.log"), chunk);
  });
  process.stdin.on("end", () => {
    const bytes = Buffer.concat(chunks);
    record.stdin.bytes = bytes.length;
    record.stdin.sha256 = createHash("sha256").update(bytes).digest("hex");
    record.stdin.eofCount = 1;
    saveRecord();
    let document;
    try {
      document = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      fail(`prompt-parse:${error.message}`);
    }
    void play(document);
  });
  process.stdin.on("error", () => {
    // Parent closed early; nothing to read.
  });
}
