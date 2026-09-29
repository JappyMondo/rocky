// Taskbot #111 (PFC-1) — THE single authorized zero-turn native probe.
// Confirms the projected draft-07 request schema passes pinned claude 2.1.283 startup
// validation: run the pinned binary once, unauth, with --json-schema=<projected schema> and a
// trivial stdin prompt; EXPECT no schema-rejection error — startup proceeds to system/init and
// then auth failure ("Not logged in" style). Mirrors the R1 CC-P5 diag driver approach
// (.qualification/native-probes-R1/drivers/diag-json-schema.mjs): Tier-B bare argv, sealed
// UNAUTH synthetic CLAUDE_CONFIG_DIR + private synthetic HOME, wall <=30s, byte-bounded capture,
// one owned process group. Zero model turns possible (unauth). Fail-closed on binary identity
// mismatch: ENVIRONMENT_FAILURE, no spawn.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  lstatSync,
  realpathSync,
  rmSync,
  existsSync,
  mkdtempSync,
} from "node:fs";
import { join } from "node:path";

const ROOT = "/Users/jappy/.t3/worktrees/rocky/rocky-next";
const EVID = join(
  ROOT,
  ".qualification/claude-code-contract-95-amend-pfc1-111/native-probe",
);
const TEMP_BASE = "/var/folders/0s/94wd01s17jsdg_7jk3zfqsd40000gn/T/opencode";
const PIN = {
  path: "/Users/jappy/.local/share/claude/versions/2.1.283",
  sha256:
    "d8cb1e5c79684cc12a8bfc813e3a2073406921b6245744b3009be3ab5651d21e",
  bytes: 225036032,
};
const MODEL = "claude-sonnet-4-5";
const MiB = 1024 * 1024;
const sha = (b) => createHash("sha256").update(b).digest("hex");

mkdirSync(EVID, { recursive: true });
const writeJSON = (name, value) =>
  writeFileSync(join(EVID, name), JSON.stringify(value, null, 2) + "\n");
const writeBounded = (name, buf) => {
  const full = buf.length;
  const stored = full > MiB ? buf.subarray(0, MiB) : buf;
  writeFileSync(join(EVID, name), stored);
  return { file: name, bytes: full, storedBytes: stored.length, sha256: sha(buf), truncated: full > MiB };
};
function inventoryDir(root) {
  const out = [];
  if (!existsSync(root)) return { root, present: false, entries: out };
  const walk = (dir, rel) => {
    let names;
    try { names = readdirSync(dir).sort(); } catch { return; }
    for (const name of names) {
      const abs = join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      let st;
      try { st = lstatSync(abs); } catch { out.push({ path: r, kind: "unreadable" }); continue; }
      if (st.isSymbolicLink()) out.push({ path: r, kind: "link" });
      else if (st.isDirectory()) { out.push({ path: r, kind: "dir" }); walk(abs, r); }
      else if (st.isFile()) {
        let h = null;
        try { h = sha(readFileSync(abs)); } catch {}
        out.push({ path: r, kind: "file", bytes: st.size, sha256: h });
      } else out.push({ path: r, kind: "other", mode: st.mode });
    }
  };
  walk(root, "");
  return { root, present: true, entries: out };
}

// ---- fail-closed binary identity gate (read/hash only, no spawn yet) ----
const measured = { path: PIN.path };
try {
  const st = lstatSync(PIN.path);
  measured.bytes = st.size;
  measured.sha256 = sha(readFileSync(PIN.path));
} catch (e) {
  measured.error = String(e.message ?? e);
}
if (measured.sha256 !== PIN.sha256 || measured.bytes !== PIN.bytes) {
  writeJSON("probe.json", {
    probeId: "PFC1-111-native-probe",
    verdict: "ENVIRONMENT_FAILURE",
    reason: "binary-identity-mismatch",
    expected: PIN,
    measured,
    spawned: false,
  });
  console.log("ENVIRONMENT_FAILURE: binary identity mismatch; NO spawn performed.");
  process.exit(1);
}

// ---- shipped projection (binds the probe to the shipped derivation) ----
const dist = await import(join(ROOT, "dist/index.js"));
const frozenSource = readFileSync(
  join(ROOT, "acceptance/subscription/final.schema.json"),
  "utf8",
);
const projection = dist.projectClaudeWireRequestSchema(frozenSource);

// ---- sealed unauth environment via the SHIPPED serializer ----
const tempRoot = realpathSync(mkdtempSync(join(TEMP_BASE, `pfc1-probe-${Date.now()}-`)));
const parentHome = join(tempRoot, "ph");
const parentTmp = join(tempRoot, "pt");
const configDir = join(tempRoot, "cfg");
const src = join(tempRoot, "src");
for (const p of [parentHome, parentTmp, configDir, src])
  mkdirSync(p, { recursive: true, mode: 0o700 });
const envArray = dist.buildClaudeSealedEnv(
  { parentHome, configDir, parentTmp },
  { shell: false, user: false, userName: "pfc1-111-synthetic" },
);
const envObj = Object.fromEntries(envArray);
const cfgPre = inventoryDir(configDir);
const homePre = inventoryDir(parentHome);

// ---- bounded spawn: one owned group, wall cap 30s, capture cap 4 MiB ----
const args = [
  "-p",
  "--output-format=stream-json",
  "--verbose",
  "--input-format=text",
  `--json-schema=${projection.canonical}`,
  `--model=${MODEL}`,
];
const captureBytes = 4 * MiB;
const wallMs = 30000;
const startedAt = new Date().toISOString();
const r = await new Promise((res) => {
  const start = Date.now();
  const signalsSent = [];
  let child;
  try {
    child = spawn(PIN.path, args, {
      cwd: src, env: envObj, detached: true, stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (e) {
    return res({ spawnError: String(e.message ?? e), wallMs: 0, signalsSent });
  }
  const pgid = child.pid;
  const killGroup = (sig) => {
    try { process.kill(-pgid, sig); signalsSent.push({ sig, atMs: Date.now() - start }); }
    catch (e) { signalsSent.push({ sig, error: String(e.code || e.message) }); }
  };
  const outChunks = [], errChunks = [];
  let outBytes = 0, errBytes = 0, outTrunc = false, errTrunc = false;
  const collect = (isOut) => (d) => {
    const arr = isOut ? outChunks : errChunks;
    const used = isOut ? outBytes : errBytes;
    const room = Math.max(0, captureBytes - used);
    const chunk = room >= d.length ? d : d.subarray(0, room);
    if (chunk.length) arr.push(chunk);
    if (isOut) { outBytes += chunk.length; outTrunc ||= chunk.length < d.length; }
    else { errBytes += chunk.length; errTrunc ||= chunk.length < d.length; }
  };
  child.stdout.on("data", collect(true));
  child.stderr.on("data", collect(false));
  let stdinNote = null;
  child.stdin.on("error", (e) => { stdinNote = `stdin-error:${e.code || e.message}`; });
  let settled = false;
  const timers = [];
  const finish = (extra = {}) => {
    if (settled) return;
    settled = true;
    for (const t of timers) clearTimeout(t);
    res({
      exitCode: child.exitCode, signal: child.signalCode,
      stdout: Buffer.concat(outChunks), stderr: Buffer.concat(errChunks),
      stdoutBytes: outBytes, stderrBytes: errBytes,
      stdoutTruncated: outTrunc, stderrTruncated: errTrunc,
      wallMs: Date.now() - start, timedOut: !!extra.timedOut,
      spawnError: extra.spawnError || null, stdinNote, signalsSent, pgid,
    });
  };
  timers.push(setTimeout(() => {
    killGroup("SIGTERM");
    timers.push(setTimeout(() => {
      killGroup("SIGKILL");
      timers.push(setTimeout(() => finish({ timedOut: true }), 1000));
    }, 500));
  }, wallMs));
  child.on("error", (e) => finish({ spawnError: String(e.message ?? e) }));
  child.on("close", () => finish());
  try { child.stdin.end("hi\n"); } catch (e) { stdinNote = `stdin-throw:${e.code || e.message}`; }
});

const cfgPost = inventoryDir(configDir);
const homePost = inventoryDir(parentHome);
const out = r.stdout.toString("utf8");
const err = r.stderr.toString("utf8");
const prePaths = new Set(cfgPre.entries.map((e) => e.path));
const cfgGains = cfgPost.entries.filter((e) => !prePaths.has(e.path));
const homePrePaths = new Set(homePre.entries.map((e) => e.path));
const homeGains = homePost.entries.filter((e) => !homePrePaths.has(e.path));

const schemaRejected = /is not a valid JSON Schema|no schema with key or ref/i.test(err);
const initObserved = /"subtype":"init"/.test(out);
const authFailureObserved = /Not logged in|authentication|oauth|Invalid API key|login/i.test(out + err);
let resultFrame = null;
for (const line of out.split("\n")) {
  if (!line.trim()) continue;
  try { const f = JSON.parse(line); if (f.type === "result") resultFrame = f; } catch {}
}
const zeroTurn =
  resultFrame !== null &&
  resultFrame.is_error === true &&
  (resultFrame.total_cost_usd === 0 || resultFrame.total_cost_usd === undefined) &&
  (resultFrame.modelUsage === undefined ||
    Object.keys(resultFrame.modelUsage).length === 0);
const verdict =
  r.spawnError ? "ENVIRONMENT_FAILURE" :
  schemaRejected ? "FAIL" :
  (initObserved || authFailureObserved) ? "PASS" : "INCONCLUSIVE";

const stdoutCap = writeBounded("probe-stdout.log", r.stdout ?? Buffer.alloc(0));
const stderrCap = writeBounded("probe-stderr.log", r.stderr ?? Buffer.alloc(0));
writeJSON("probe.json", {
  probeId: "PFC1-111-native-probe",
  ticket: "#111 (PFC-1)",
  purpose:
    "Confirm the projected draft-07 request schema passes pinned claude 2.1.283 --json-schema startup validation (zero-turn, unauth); the frozen 2020-12 IRI is rejected (R1 #108 CC-P5).",
  startedAt,
  finishedAt: new Date().toISOString(),
  binary: { pinned: PIN, measured, identityMatch: true },
  projection: {
    sourceFile: "acceptance/subscription/final.schema.json",
    sourceFileSha256: sha(frozenSource),
    dialectReplacement: {
      from: "https://json-schema.org/draft/2020-12/schema",
      to: "http://json-schema.org/draft-07/schema#",
    },
    canonicalBytes: Buffer.byteLength(projection.canonical),
    projectionSha256: projection.sha256,
    derivedBy: "dist.projectClaudeWireRequestSchema (shipped implementation)",
  },
  argvFlags: args.map((a) => (a.startsWith("--json-schema=") ? `--json-schema=<${Buffer.byteLength(a) - 14}B projected schema, sha256 ${projection.sha256}>` : a)),
  env: envArray,
  cwd: src,
  stdin: "hi\\n (single write + EOF)",
  result: {
    exitCode: r.exitCode, signal: r.signal, wallMs: r.wallMs, timedOut: r.timedOut,
    spawnError: r.spawnError, stdinNote: r.stdinNote, signalsSent: r.signalsSent,
    stdout: stdoutCap, stderr: stderrCap,
  },
  observations: {
    schemaRejected, initObserved, authFailureObserved, zeroTurn,
    resultFrame: resultFrame
      ? {
          subtype: resultFrame.subtype, is_error: resultFrame.is_error,
          num_turns: resultFrame.num_turns, total_cost_usd: resultFrame.total_cost_usd,
          modelUsage: resultFrame.modelUsage, terminal_reason: resultFrame.terminal_reason,
          errors: resultFrame.errors,
        }
      : null,
  },
  containment: {
    configDirGains: cfgGains,
    parentHomeGains: homeGains,
    note: "all gains inside the synthetic temp root; temp root deleted after evidence copy",
  },
  verdict,
});
writeJSON("cfg-inventory-pre.json", cfgPre);
writeJSON("cfg-inventory-post.json", cfgPost);
rmSync(tempRoot, { recursive: true, force: true });
console.log(JSON.stringify({ verdict, exitCode: r.exitCode, wallMs: r.wallMs, schemaRejected, initObserved, authFailureObserved, zeroTurn }, null, 2));
