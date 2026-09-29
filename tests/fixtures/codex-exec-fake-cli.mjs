// Owned fake Codex exec CLI for Taskbot #81 adapter tests (evidence class owned-fake-cli).
// Test support wraps this module into an executable pinned-binary fixture (shebang + execPath);
// this file itself is never executed directly and is never the real pinned candidate. It records its
// exact argv/env/cwd/stdin and replays scripted `codex exec --json` JSONL bytes, exits and signal
// behaviors so the adapter's protocol rules can be exercised against real spawned processes. It emits
// the owned source-consistent interpretation of the pinned exec event taxonomy (thread.started,
// turn.started, item.started/updated/completed, turn.completed, turn.failed, error); the exact native
// serde frame shape is a synthetic-native gate (N06), never claimed here. Scenario source is either a
// marker file at ${TMPDIR}/fake-scenario.json (checked first; supports scenarios that must never read
// stdin) or the stdin prompt itself, which is then a JSON script document.
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
function argvValue(flag) {
  for (let i = 2; i < process.argv.length; i++) {
    const element = process.argv[i];
    if (element === flag) return process.argv[i + 1] ?? null;
    if (element.startsWith(`${flag}=`)) return element.slice(flag.length + 1);
  }
  return null;
}
const fakeModel = argvValue("--model") ?? "unknown-model";
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
function defaultUsage(overrides) {
  return {
    input_tokens: 1200,
    cached_input_tokens: 800,
    cache_write_input_tokens: 100,
    output_tokens: 340,
    reasoning_output_tokens: 40,
    ...expandMacros(overrides ?? {}),
  };
}
function itemFrame(phase, spec) {
  const { id, itemType, ...rest } = spec;
  return {
    type: `item.${phase}`,
    id,
    item: { type: itemType, ...expandMacros(rest) },
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
  if (step.thread !== undefined)
    await writeOut(
      JSON.stringify(
        expandMacros({
          type: "thread.started",
          thread_id: "fake-thread-0001",
          ...step.thread,
        }),
      ) + "\n",
    );
  else if (step.turnStarted !== undefined)
    await writeOut(
      JSON.stringify(
        expandMacros({ type: "turn.started", ...step.turnStarted }),
      ) + "\n",
    );
  else if (step.itemStarted !== undefined)
    await writeOut(
      JSON.stringify(itemFrame("started", step.itemStarted)) + "\n",
    );
  else if (step.itemUpdated !== undefined)
    await writeOut(
      JSON.stringify(itemFrame("updated", step.itemUpdated)) + "\n",
    );
  else if (step.itemCompleted !== undefined)
    await writeOut(
      JSON.stringify(itemFrame("completed", step.itemCompleted)) + "\n",
    );
  else if (step.turnCompleted !== undefined)
    await writeOut(
      JSON.stringify(
        expandMacros({
          type: "turn.completed",
          usage: defaultUsage(step.turnCompleted?.usage),
          ...(step.turnCompleted?.extra ?? {}),
        }),
      ) + "\n",
    );
  else if (step.turnFailed !== undefined)
    await writeOut(
      JSON.stringify(
        expandMacros({ type: "turn.failed", ...step.turnFailed }),
      ) + "\n",
    );
  else if (step.errorEvent !== undefined)
    await writeOut(
      JSON.stringify(expandMacros({ type: "error", ...step.errorEvent })) +
        "\n",
    );
  else if (step.out !== undefined)
    await writeOut(JSON.stringify(expandMacros(step.out)) + "\n");
  else if (step.outPad !== undefined)
    // Runtime-generated oversize line so the PROMPT stays small while the frame exceeds the bound.
    await writeOut(
      `{"type":"turn.started","pad":"${"x".repeat(step.outPad)}"}\n`,
    );
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
              frame === "$turnCompleted"
                ? { type: "turn.completed", usage: defaultUsage({}) }
                : expandMacros(frame),
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
    // attempt must remain attempted-unknown with no resend. Prompt consumption is evidenced only by
    // a subsequent thread.started (F9).
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
