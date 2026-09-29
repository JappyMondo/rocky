// R1 phase 4 — codex zero-call: CX-P1, CX-P2(b), CX-P3, CX-P4, CX-P5. ALL zero model calls by
// construction (synthetic unauth CODEX_HOME ⇒ every case terminates at config/auth refusal before any
// thread/model start). Pinned codex 0.157.1 only. Serial; one owned group per spawn; wall ≤30s; capture ≤4MiB.
import {
  dist,
  PINS,
  ROOT,
  freshTempRoot,
  rmTemp,
  probeDir,
  writeJSON,
  writeVerdict,
  writeCapture,
  errName,
  truncStr,
  spawnBounded,
  sealedCodexEnv,
  makeCodexFixture,
  inventoryDir,
  inventoryDiff,
  makePhaseRunner,
  codexSupport,
  MiB,
} from "./lib.mjs";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const R = makePhaseRunner(4);
const CODEX = PINS.codex.path;
const { baselinePass, schedule, dispatchCodex, settleCodex } = codexSupport;
const SCHEMA_SRC = join(ROOT, "acceptance/subscription/final.schema.json");

function writeSyntheticSchema(tempRoot) {
  const p = join(tempRoot, "final.request.schema.json");
  writeFileSync(p, readFileSync(SCHEMA_SRC, "utf8"));
  return p;
}

// ---------------- CX-P1 (argv-surface binding via `codex exec --help`) ----------------
await R.run("CX-P1", async () => {
  const dir = probeDir("CX-P1");
  const tempRoot = freshTempRoot("CX-P1");
  try {
    const sealed = sealedCodexEnv(tempRoot, {});
    const r = await spawnBounded({
      file: CODEX, args: ["exec", "--help"], envObj: sealed.envObj, cwd: tempRoot,
      stdin: { mode: "eof" }, wallMs: 30000, captureBytes: 1 * MiB,
    });
    const out = r.stdout.toString("utf8"), err = r.stderr.toString("utf8");
    const capOut = writeCapture(dir, "stdout.log", r.stdout);
    writeCapture(dir, "stderr.log", r.stderr);
    const text = out + "\n" + err;
    const required = ["--json", "--color", "--skip-git-repo-check", "--ignore-user-config",
      "--ignore-rules", "--strict-config", "--output-schema", "--model", "--ephemeral", "-c", "--image"];
    const present = Object.fromEntries(required.map((f) => [f, text.includes(f)]));
    const stdinForm = text.includes("-- -") || /--\s+-/.test(text); // `-- -` forced-stdin terminator
    const meta = {
      probeId: "CX-P1", exitCode: r.exitCode, signal: r.signal, wallMs: r.wallMs,
      stdoutBytes: r.stdoutBytes, stdoutTruncated: r.stdoutTruncated, present, stdinFormMentioned: stdinForm, capOut,
    };
    writeJSON(dir + "/meta.json", meta);
    const missing = required.filter((f) => !present[f]);
    const verdict = missing.length === 0 ? "PASS" : "PRODUCT_FAILURE_CANDIDATE";
    writeVerdict("CX-P1", {
      verdict,
      tier: "B (native `codex exec --help` presence evidence)",
      gate: "argv-surface binding (frozen launch.argvTemplate)",
      hypothesis: "Every frozen-template flag is present in `codex exec --help`: --json --color --skip-git-repo-check --ignore-user-config --ignore-rules --strict-config --output-schema --model --ephemeral -c --image (+ `-- -` stdin form).",
      criterion: "PART3 CX-P1: 'PASS: every frozen-template flag present; any absence/renaming ⇒ PRODUCT_FAILURE candidate (argv template drift). Help text is presence evidence, not runtime attestation.'",
      expected: "all required flags present.",
      observed: JSON.stringify({ exit: r.exitCode, present, missing, stdinFormMentioned: stdinForm }),
      class: verdict === "PASS" ? "argv-surface-present" : "argv-template-drift",
      notes: "Help text is PRESENCE evidence only, NOT runtime attestation (stated in verdict). Zero model call (--help starts no thread).",
    });
    return verdict;
  } finally { rmTemp(tempRoot); }
});

// ---------------- CX-P2(b) (unknown -c key under --strict-config; native shape) ----------------
await R.run("CX-P2b", async () => {
  const dir = probeDir("CX-P2b");
  const tempRoot = freshTempRoot("CX-P2b");
  try {
    const schemaPath = writeSyntheticSchema(tempRoot);
    const sealed = sealedCodexEnv(tempRoot, {}); // synthetic unauth CODEX_HOME (no credentials)
    const src = join(tempRoot, "src"); mkdirSync(src, { recursive: true, mode: 0o700 });
    const argv = ["exec", "--json", "--color", "never", "--skip-git-repo-check", "--ignore-user-config",
      "--ignore-rules", "--strict-config", "--output-schema", schemaPath, "--model", "gpt-6-sol", "--ephemeral",
      "-c", "rocky_unknown_probe_key=1", "-c", 'model_reasoning_effort="medium"', "--", "-"];
    const r = await spawnBounded({
      file: CODEX, args: argv, envObj: sealed.envObj, cwd: src,
      stdin: { mode: "write", data: "Do something." }, wallMs: 30000, captureBytes: 4 * MiB,
    });
    const out = r.stdout.toString("utf8"), err = r.stderr.toString("utf8");
    writeCapture(dir, "stdout.log", r.stdout);
    writeCapture(dir, "stderr.log", r.stderr);
    const meta = {
      probeId: "CX-P2b", argv, exitCode: r.exitCode, signal: r.signal, wallMs: r.wallMs, timedOut: r.timedOut,
      stdinNote: r.stdinNote, threadStarted: /thread\.started|"type"\s*:\s*"thread/.test(out),
      stdoutHead: truncStr(out, 1500), stderrHead: truncStr(err, 1500),
    };
    writeJSON(dir + "/meta.json", meta);
    const explicitError = r.exitCode !== 0 && (err.length > 0 || /error|unknown|unexpected|invalid/i.test(out));
    const noThread = !meta.threadStarted;
    const verdict = explicitError && noThread ? "PASS" : "REJECT";
    writeVerdict("CX-P2b", {
      verdict,
      tier: "B (native codex strict-config refusal) — see ambiguity note",
      gate: "N01 strict-config slice / F9 (stdin not read)",
      hypothesis: "An unknown -c key under --strict-config yields an explicit native error and nonzero exit before any thread starts; stdin is not consumed (F9 attempted-unknown shape).",
      criterion: "PART3 CX-P2(b): 'spawn with unknown -c key under --strict-config ⇒ explicit native error, nonzero exit; verify stdin NOT read (F9 ...; prompt digest unconsumed, no thread.started).'",
      expected: "nonzero exit + explicit config error; no thread.started; stdin write EPIPE/attempted-unknown.",
      observed: JSON.stringify({ exit: r.exitCode, signal: r.signal, explicitError, noThread, stdinNote: r.stdinNote, stderrHead: truncStr(err, 400) }),
      class: verdict === "PASS" ? "native-strict-config-refusal" : "silent-degradation-or-thread-start",
      notes: "PLAN AMBIGUITY (recorded honestly): the plan labels CX-P2(b) 'Tier-A prepareLaunch→begin', but the SHIPPED producer (buildCodexOverrideAssignments/assertCodexOverrideKey) rejects unknown -c keys PRE-SPAWN (proven in CX-P2a), so an unknown key can never reach begin through the adapter. The native strict-config refusal shape is therefore observed Tier-B (bare CLI), which is the only safe way to see it under the zero-call guarantee. Zero model call (config error precedes auth/thread).",
    });
    return verdict;
  } finally { rmTemp(tempRoot); }
});

// ---------------- CX-P3 (auth-absence fail-closed; Tier-A begin) ----------------
await R.run("CX-P3", async () => {
  const dir = probeDir("CX-P3");
  const tempRoot = freshTempRoot("CX-P3");
  const f = makeCodexFixture(tempRoot, {}); // synthetic credential-less CODEX_HOME (config.toml only)
  try {
    baselinePass(f);
    const action = schedule(f, "implement");
    const homePre = inventoryDir(f.codexHome);
    const { plan, pending } = dispatchCodex(f, action, "Produce the structured output now.");
    let settled = null, dispatchErr = null;
    try { settled = await settleCodex(f, action, pending); } catch (e) { dispatchErr = errName(e); }
    const homePost = inventoryDir(f.codexHome);
    const cmd = f.store.commands(f.lease.runId).at(-1);
    let logDir = null;
    try { const ids = readdirSync(plan.paths.logs); if (ids.length) logDir = join(plan.paths.logs, ids[ids.length - 1]); } catch {}
    let out = "", err = "";
    if (logDir) {
      try { out = readFileSync(join(logDir, "stdout.log"), "utf8"); } catch {}
      try { err = readFileSync(join(logDir, "stderr.log"), "utf8"); } catch {}
      writeCapture(dir, "stdout.log", Buffer.from(out));
      writeCapture(dir, "stderr.log", Buffer.from(err));
    }
    const sealedKeyNames = (plan?.bundle?.env || []).map(([k]) => k);
    const homeDiff = inventoryDiff(homePre, homePost);
    const meta = {
      probeId: "CX-P3", binary: PINS.codex,
      settlement: settled ? { stage: settled.stage, blocker: settled.blocker?.kind ?? null } : null,
      dispatchErr,
      command: cmd ? { state: cmd.state, outcome: cmd.result?.outcome, exitCode: cmd.result?.exitCode, signal: cmd.result?.signal, duplexFailure: cmd.duplex?.failure } : null,
      sealedEnvKeyNames: sealedKeyNames,
      threadStarted: /thread\.started/.test(out),
      apiFallback: /api[_ -]?key|OPENAI_API_KEY|fallback/i.test(err + out),
      forcedLoginLogout: /login|logout|sign in|authenticate/i.test(err + out),
      codexHomeGains: homeDiff.gained.map((e) => e.path),
      codexHomeChanged: homeDiff.changed.map((e) => e.post.path),
      stdoutHead: truncStr(out, 1500), stderrHead: truncStr(err, 1500),
    };
    writeJSON(dir + "/meta.json", meta);
    writeJSON(dir + "/inventories/codex-home-pre.json", homePre);
    writeJSON(dir + "/inventories/codex-home-post.json", homePost);
    const preModelRefusal = (cmd?.result?.exitCode !== 0 || cmd?.result?.outcome === "failed" || cmd?.result?.outcome === "timeout") && !meta.threadStarted;
    const verdict = preModelRefusal ? "PASS" : "REJECT";
    writeVerdict("CX-P3", {
      verdict,
      tier: "A (CodexExecAdapter.prepareLaunch→begin via store dispatch; real pinned binary)",
      gate: "auth-absence fail-closed (S09/L01-adjacent honesty)",
      hypothesis: "A full valid bundle through the shipped adapter with a credential-less synthetic CODEX_HOME terminates at a pre-model auth/config refusal: nonzero exit, no thread.started, no API fallback, no forced login/logout side effect; sealed-env key names retained.",
      criterion: "PART3 CX-P3: 'PASS: fail-closed pre-model refusal with bounded nonsecret classification. This is NOT an L01 pass; it evidences that missing auth blocks before model work.'",
      expected: "nonzero exit / failed outcome; threadStarted=false; no API fallback; no forced login/logout.",
      observed: JSON.stringify({ command: meta.command, threadStarted: meta.threadStarted, apiFallback: meta.apiFallback, forcedLoginLogout: meta.forcedLoginLogout, sealedEnvKeyNames: sealedKeyNames, stderrHead: truncStr(err, 300) }),
      class: verdict === "PASS" ? "fail-closed-pre-model-refusal" : "thread-started-or-fallback",
      notes: "Zero model call (synthetic unauth CODEX_HOME). NOT an L01 pass. Sealed-env KEY NAMES only retained (no values are secrets; CODEX_HOME is a path).",
    });
    return verdict;
  } finally { f.store.close(); rmTemp(tempRoot); }
});

// ---------------- CX-P4 (F5 trust-persistence, refusal-path half; Tier-A begin) ----------------
await R.run("CX-P4", async () => {
  const dir = probeDir("CX-P4");
  const tempRoot = freshTempRoot("CX-P4");
  const syntheticToml = "# synthetic shared codex config for #108 R1 CX-P4 (nonsecret)\nmodel_provider = \"openai\"\n";
  const f = makeCodexFixture(tempRoot, { configToml: syntheticToml });
  try {
    const pre = dist.captureSharedConfigToml(f.codexHome);
    baselinePass(f);
    const action = schedule(f, "implement");
    const { plan, pending } = dispatchCodex(f, action, "Produce the structured output now.");
    let settled = null, dispatchErr = null;
    try { settled = await settleCodex(f, action, pending); } catch (e) { dispatchErr = errName(e); }
    const post = dist.captureSharedConfigToml(f.codexHome);
    const drift = dist.sharedConfigTomlDrift(pre, post);
    let postToml = "";
    try { postToml = readFileSync(join(f.codexHome, "config.toml"), "utf8"); } catch {}
    const trustWritten = /trust_level|projects\./.test(postToml);
    let logDir = null;
    try { const ids = readdirSync(plan.paths.logs); if (ids.length) logDir = join(plan.paths.logs, ids[ids.length - 1]); } catch {}
    if (logDir) {
      try { writeCapture(dir, "stdout.log", readFileSync(join(logDir, "stdout.log"))); } catch {}
      try { writeCapture(dir, "stderr.log", readFileSync(join(logDir, "stderr.log"))); } catch {}
    }
    const meta = {
      probeId: "CX-P4", pre, post, drift, trustWritten, postTomlBytes: postToml.length,
      settlement: settled ? { stage: settled.stage, blocker: settled.blocker?.kind ?? null } : null, dispatchErr,
    };
    writeJSON(dir + "/meta.json", meta);
    const byteIdentical = pre.sha256 === post.sha256 && pre.bytes === post.bytes && drift === null;
    const verdict = byteIdentical && !trustWritten ? "PASS" : "PRODUCT_FAILURE_CANDIDATE";
    writeVerdict("CX-P4", {
      verdict,
      tier: "A (CodexExecAdapter.prepareLaunch→begin; captureSharedConfigToml pre/post)",
      gate: "F5 trust-persistence (refusal-path half) / N01",
      hypothesis: "Across a CX-P3-style pre-model refusal, the shared synthetic config.toml is byte-identical (sha256+bytes unchanged) and no projects.<path>.trust_level is written.",
      criterion: "PART3 CX-P4: 'captureSharedConfigToml pre/post ⇒ sha256+bytes unchanged; assert no projects.<path>.trust_level written. PASS: byte-identical config.toml. Any mutation ⇒ PRODUCT_FAILURE (containment breach).'",
      expected: "pre.sha256==post.sha256 && pre.bytes==post.bytes && drift==null && no trust_level.",
      observed: JSON.stringify({ pre, post, drift, trustWritten }),
      class: verdict === "PASS" ? "config-toml-byte-identical" : "shared-config-mutated",
      notes: "Zero model call. Full F5 proof (thread/start with writable cwd persisting trust) REQUIRES a model turn ⇒ credit-blocked, stays open. A mutation here would be a containment breach ⇒ PRODUCT_FAILURE_CANDIDATE (and the agent would STOP).",
    });
    return verdict;
  } finally { f.store.close(); rmTemp(tempRoot); }
});

// ---------------- CX-P5 (ephemeral stdin/ordering; backpressure variant) ----------------
await R.run("CX-P5", async () => {
  const dir = probeDir("CX-P5");
  const tempRoot = freshTempRoot("CX-P5");
  try {
    const schemaPath = writeSyntheticSchema(tempRoot);
    const sealed = sealedCodexEnv(tempRoot, {});
    const src = join(tempRoot, "src"); mkdirSync(src, { recursive: true, mode: 0o700 });
    const argv = ["exec", "--json", "--color", "never", "--skip-git-repo-check", "--ignore-user-config",
      "--ignore-rules", "--strict-config", "--output-schema", schemaPath, "--model", "gpt-6-sol", "--ephemeral",
      "-c", "rocky_unknown_probe_key=1", "-c", 'model_reasoning_effort="medium"', "--", "-"];
    // Backpressure variant: delay the prompt write until AFTER the process has exited (config error),
    // recording the attempted-unknown duplex shape (EPIPE) against the real binary.
    const r = await spawnBounded({
      file: CODEX, args: argv, envObj: sealed.envObj, cwd: src,
      stdin: { mode: "writeAfterExit", data: "Late prompt after exit." }, wallMs: 30000, captureBytes: 4 * MiB,
    });
    const out = r.stdout.toString("utf8"), err = r.stderr.toString("utf8");
    writeCapture(dir, "stdout.log", r.stdout);
    writeCapture(dir, "stderr.log", r.stderr);
    const meta = {
      probeId: "CX-P5", exitCode: r.exitCode, signal: r.signal, wallMs: r.wallMs,
      stdinNote: r.stdinNote, threadStarted: /thread\.started/.test(out),
      stdoutHead: truncStr(out, 1000), stderrHead: truncStr(err, 1000),
    };
    writeJSON(dir + "/meta.json", meta);
    const earlyExitNoStdin = r.exitCode !== 0 && !meta.threadStarted;
    const verdict = earlyExitNoStdin ? "PASS" : "REJECT";
    writeVerdict("CX-P5", {
      verdict,
      tier: "B (native codex ephemeral stdin/ordering)",
      gate: "N06 partial (ephemeral stdin/ordering) / F9 duplex shape",
      hypothesis: "An early config error exits without reading stdin; a prompt written after exit records the attempted-unknown duplex shape (EPIPE) against the real binary. No lifecycle claims beyond this.",
      criterion: "PART3 CX-P5: 'early config error exits without reading stdin; slow-reader/backpressure variant (delayed prompt write after exit) records the attempted-unknown duplex shape against the real binary. No lifecycle claims beyond this.'",
      expected: "nonzero exit, no thread.started, late stdin write fails (EPIPE) = attempted-unknown.",
      observed: JSON.stringify({ exit: r.exitCode, threadStarted: meta.threadStarted, stdinNote: r.stdinNote }),
      class: verdict === "PASS" ? "early-exit-stdin-unread" : "stdin-consumed-or-thread",
      notes: "Zero model call. Folded observation from CX-P2(b). No lifecycle claims beyond the duplex-ordering shape.",
    });
    return verdict;
  } finally { rmTemp(tempRoot); }
});

console.log(JSON.stringify(R.summary(), null, 2));
process.exit(R.state.stopped ? 2 : 0);
