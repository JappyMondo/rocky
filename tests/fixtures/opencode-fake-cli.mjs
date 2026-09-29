// Owned fake OpenCode CLI for Taskbot #98 adapter tests (evidence class owned-fake-cli).
// Test support wraps this module into an executable pinned-binary fixture (shebang + execPath);
// this file itself is never executed directly and is NEVER the real pinned opencode binary (the
// installed binary is not executed at all in #98). It records its exact argv/env/cwd/stdin and
// replays scripted `opencode run --format=json` NDJSON frames plus a scripted `opencode export
// <sessionID>` mode, so the adapter's protocol rules can be exercised against real spawned
// processes. Frame shapes follow the pinned v1.18.32 source interpretation (#104 F19/F20/F25):
// {type, timestamp, sessionID, part|error}; export stdout is {info, messages} pretty JSON.
// Scenario source for run mode is either a marker file at ${TMPDIR}/fake-scenario.json (checked
// first; supports scenarios that must never read stdin) or the stdin prompt itself, which is then
// a JSON script document. Export mode reads ${TMPDIR}/fake-export.json.
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
// Run and export children keep SEPARATE records: the export spawn happens after the run and must
// not clobber the run's argv/env/stdin evidence.
const recordPath = join(
  tmp,
  process.argv[2] === "export" ? "fake-export-record.json" : "fake-record.json",
);
const DEFAULT_SESSION = "fake-session-0001";
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

// ---------- export mode: `opencode export <sessionID>` ----------
async function runExport() {
  const markerPath = join(tmp, "fake-export.json");
  if (!existsSync(markerPath)) {
    // Mirrors the pinned source: a missing session fails with stderr + nonzero exit, stdout empty.
    record.scriptSource = "export-missing-marker";
    record.finishedAt = Date.now();
    saveRecord();
    await writeErr(`Session not found: ${process.argv[3] ?? ""}\n`);
    process.exit(1);
  }
  let scenario;
  try {
    scenario = JSON.parse(readFileSync(markerPath, "utf8"));
  } catch (error) {
    record.error = `export-marker-parse:${error.message}`;
    record.finishedAt = Date.now();
    saveRecord();
    process.exit(2);
  }
  record.scriptSource = "export-marker";
  saveRecord();
  if (scenario.sleep !== undefined) await pause(scenario.sleep);
  if (scenario.raw !== undefined) await writeOut(scenario.raw);
  record.finishedAt = Date.now();
  saveRecord();
  process.exit(scenario.exit ?? 0);
}
if (process.argv[2] === "export") {
  void runExport();
} else {
  // ---------- run mode: `opencode run --format=json ...` ----------
  let partSeq = 0;
  function partBase(sessionID) {
    return {
      id: `fake-part-${String(++partSeq).padStart(4, "0")}`,
      sessionID,
      messageID: "fake-message-0001",
    };
  }
  function frame(type, sessionID, data) {
    return (
      JSON.stringify({
        type,
        timestamp: Date.now(),
        sessionID,
        ...data,
      }) + "\n"
    );
  }
  async function runStep(step, sessionID) {
    if (step.stepStart !== undefined)
      await writeOut(
        frame("step_start", sessionID, {
          part: { ...partBase(sessionID), type: "step-start" },
        }),
      );
    else if (step.toolUse !== undefined) {
      const spec = step.toolUse;
      const state =
        (spec.status ?? "completed") === "completed"
          ? {
              status: "completed",
              input: spec.input ?? {},
              output: spec.output ?? "ok",
              title: spec.title ?? spec.tool ?? "tool",
              metadata: {},
              time: { start: Date.now(), end: Date.now() },
            }
          : {
              status: "error",
              input: spec.input ?? {},
              error: spec.error ?? "tool failed",
              time: { start: Date.now(), end: Date.now() },
            };
      await writeOut(
        frame("tool_use", sessionID, {
          part: {
            ...partBase(sessionID),
            type: "tool",
            callID: spec.callID ?? `call-${partSeq}`,
            tool: spec.tool,
            state,
          },
        }),
      );
    } else if (step.stepFinish !== undefined) {
      const t = step.stepFinish;
      await writeOut(
        frame("step_finish", sessionID, {
          part: {
            ...partBase(sessionID),
            type: "step-finish",
            reason: t.reason ?? "stop",
            cost: t.cost ?? 0,
            tokens: {
              input: t.input ?? 0,
              output: t.output ?? 0,
              reasoning: t.reasoning ?? 0,
              cache: { read: t.cacheRead ?? 0, write: t.cacheWrite ?? 0 },
              ...(t.total !== undefined ? { total: t.total } : {}),
            },
          },
        }),
      );
    } else if (step.text !== undefined)
      await writeOut(
        frame("text", sessionID, {
          part: {
            ...partBase(sessionID),
            type: "text",
            text: typeof step.text === "string" ? step.text : step.text.text,
            time: { start: Date.now(), end: Date.now() },
          },
        }),
      );
    else if (step.reasoningEvent !== undefined)
      await writeOut(
        frame("reasoning", sessionID, {
          part: {
            ...partBase(sessionID),
            type: "reasoning",
            text: step.reasoningEvent.text ?? "thinking",
            time: { start: Date.now(), end: Date.now() },
          },
        }),
      );
    else if (step.errorEvent !== undefined)
      await writeOut(
        frame("error", sessionID, {
          error: {
            name: step.errorEvent.name ?? "ProviderAuthError",
            data: { message: step.errorEvent.message ?? "synthetic error" },
          },
        }),
      );
    else if (step.out !== undefined)
      await writeOut(JSON.stringify(step.out) + "\n");
    else if (step.outPad !== undefined)
      await writeOut(
        `{"type":"step_start","timestamp":1,"sessionID":"${sessionID}","pad":"${"x".repeat(step.outPad)}"}\n`,
      );
    else if (step.outText !== undefined) await writeOut(step.outText);
    else if (step.outRaw !== undefined)
      await writeOut(Buffer.from(step.outRaw, "base64"));
    else if (step.err !== undefined) await writeErr(step.err);
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
        const child = spawn(
          process.execPath,
          ["-e", "setInterval(()=>{},500)"],
          {
            stdio: "ignore",
          },
        );
        writeFileSync(join(tmp, "fake-descendant.pid"), String(child.pid));
        child.unref();
      } else if (step.spawn === "escaped-stderr") {
        const child = spawn(
          process.execPath,
          ["-e", "setInterval(()=>{},500)"],
          {
            detached: true,
            stdio: ["ignore", "ignore", process.stderr],
          },
        );
        writeFileSync(join(tmp, "fake-escaped.pid"), String(child.pid));
        child.unref();
      } else throw new Error("fake-unknown-spawn");
    } else if (step.ignoreSigterm === true) {
      process.on("SIGTERM", () => {});
    } else if (step.sigtermLate !== undefined) {
      const spec = step.sigtermLate;
      process.once("SIGTERM", () => {
        void (async () => {
          for (const text of spec.lines ?? []) await writeOut(text);
          record.finishedAt = Date.now();
          saveRecord();
          process.exit(spec.exitCode ?? 143);
        })();
      });
    } else if (step.exit !== undefined) {
      record.finishedAt = Date.now();
      saveRecord();
      process.exit(step.exit);
    } else throw new Error(`fake-unknown-step:${JSON.stringify(step)}`);
  }
  async function play(document) {
    const sessionID = document.sessionID ?? DEFAULT_SESSION;
    for (const step of document.script ?? []) await runStep(step, sessionID);
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
      // attempt must remain attempted-unknown with no resend (F23: no prompt-consumption event).
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
}
