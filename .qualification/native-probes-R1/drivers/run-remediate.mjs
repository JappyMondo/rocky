// R1 REMEDIATION — documented single re-run of the three Tier-A spawn probes (CC-P5, CX-P3, CX-P4)
// to remediate an evidence-capture defect in run-phase3/run-phase4: the driver read native stdout/stderr
// from plan.paths.logs/<last>/{stdout,stderr}.log and got 0 bytes. The authoritative native frames are
// retained by the shipped gate in command.duplex.frames; this re-run captures those + the receipt + a full
// run-tree walk + a recursive log read + (codex) native/log, so the exact native refusal shape is retained.
// Zero-turn / zero-call (synthetic unauth CFG/CODEX_HOME), bounded, one owned group per spawn. Original
// (defective-capture) evidence is PRESERVED; remediation writes probes/<id>/rerun-* alongside it.
// This is the plan's "at most one re-run" for a driver fault, documented in consumed.md (NOT silent).
import {
  dist,
  PINS,
  freshTempRoot,
  rmTemp,
  probeDir,
  writeJSON,
  writeCapture,
  truncStr,
  makeClaudeFixture,
  makeCodexFixture,
  inventoryDir,
  inventoryDiff,
  claudeSupport,
  codexSupport,
} from "./lib.mjs";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const { baselinePass, schedule, dispatchClaude, settleClaude } = claudeSupport;
const { dispatchCodex, settleCodex } = codexSupport;

// Recursively find every file under root whose basename matches; return [{path, bytes}].
function findFiles(root, predicate) {
  const out = [];
  const walk = (d) => {
    let names;
    try { names = readdirSync(d); } catch { return; }
    for (const n of names.sort()) {
      const p = join(d, n);
      let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p);
      else if (predicate(n, p)) out.push({ path: p, bytes: st.size });
    }
  };
  walk(root);
  return out;
}
function captureTierA(dir, tag, plan, f, cmd, extra = {}) {
  const out = { tag, command: null, frames: null, receipt: null, runTree: null, logs: {}, nativeLog: null, ...extra };
  try {
    const full = f.store.command(cmd.id);
    out.command = {
      id: full.id, state: full.state,
      result: full.result ? { outcome: full.result.outcome, exitCode: full.result.exitCode, signal: full.result.signal, stdoutTruncated: full.result.stdoutTruncated, stderrTruncated: full.result.stderrTruncated } : null,
      duplex: full.duplex ? { failure: full.duplex.failure, stdoutEof: full.duplex.stdoutEof, stderrEof: full.duplex.stderrEof, childStdoutEof: full.duplex.childStdoutEof, childStderrEof: full.duplex.childStderrEof, decoderComplete: full.duplex.decoderComplete, revoked: full.duplex.revoked, frameCount: (full.duplex.frames || []).length } : null,
    };
    out.frames = (full.duplex && full.duplex.frames) ? full.duplex.frames : [];
  } catch (e) { out.commandError = String(e.message || e); }
  // receipt
  try {
    const rp = (extra.harness === "codex" ? dist.codexReceiptPath : dist.claudeReceiptPath)(plan.paths, cmd.id);
    if (existsSync(rp)) out.receipt = JSON.parse(readFileSync(rp, "utf8"));
    out.receiptPath = rp;
  } catch (e) { out.receiptError = String(e.message || e); }
  // full run-tree walk (locate where output landed)
  try { out.runTree = inventoryDir(plan.paths.runRoot).entries.map((e) => ({ path: e.path, kind: e.kind, bytes: e.bytes })); } catch {}
  // recursive read of every stdout.log/stderr.log under the run tree
  for (const f2 of findFiles(plan.paths.runRoot, (n) => n === "stdout.log" || n === "stderr.log")) {
    try {
      const rel = f2.path.slice(plan.paths.runRoot.length + 1);
      const content = readFileSync(f2.log ?? f2.path, "utf8");
      out.logs[rel] = { bytes: f2.bytes, content: truncStr(content, 8000) };
    } catch {}
  }
  // codex native/log dir
  if (extra.harness === "codex" && plan.paths.nativeLog) {
    try {
      const files = findFiles(plan.paths.nativeLog, () => true);
      out.nativeLog = files.map((fl) => {
        let c = ""; try { c = truncStr(readFileSync(fl.path, "utf8"), 4000); } catch {}
        return { path: fl.path.slice(plan.paths.runRoot.length + 1), bytes: fl.bytes, content: c };
      });
    } catch {}
  }
  writeJSON(join(dir, `rerun-${tag}.json`), out);
  // also write the first stdout.log/stderr.log content found as the remediated raw captures
  const stdoutEntry = Object.entries(out.logs).find(([k]) => k.endsWith("stdout.log"));
  const stderrEntry = Object.entries(out.logs).find(([k]) => k.endsWith("stderr.log"));
  if (stdoutEntry) writeCapture(dir, `rerun-${tag}-stdout.log`, Buffer.from(stdoutEntry[1].content));
  if (stderrEntry) writeCapture(dir, `rerun-${tag}-stderr.log`, Buffer.from(stderrEntry[1].content));
  return out;
}

const summary = { phase: "remediate-tierA", probes: [] };

// ---- CC-P5 re-run (both valid startups; empty-input refusal already captured pre-spawn) ----
{
  const dir = probeDir("CC-P5");
  const obs = { pairs: {} };
  for (const user of [true, false]) {
    const tempRoot = freshTempRoot(`CC-P5-rerun-user-${user}`);
    const f = makeClaudeFixture(tempRoot, { config: { envOptions: { shell: false, user } } });
    try {
      baselinePass(f);
      const action = schedule(f, "implement");
      const cfgPre = inventoryDir(f.configDir);
      const { plan, pending } = dispatchClaude(f, action, "Respond with the structured output now.");
      let settled = null, dispatchErr = null;
      try { settled = await settleClaude(f, action, pending); } catch (e) { dispatchErr = String(e.message || e); }
      const cfgPost = inventoryDir(f.configDir);
      const cmd = f.store.commands(f.lease.runId).at(-1);
      const cap = captureTierA(dir, `user-${user}`, plan, f, cmd, { harness: "claude" });
      obs.pairs[user ? "userTrue" : "userFalse"] = {
        settlement: settled ? { stage: settled.stage, blocker: settled.blocker?.kind ?? null } : null,
        dispatchErr,
        commandOutcome: cap.command?.result?.outcome, exitCode: cap.command?.result?.exitCode,
        frameCount: cap.frames?.length,
        cfgGains: inventoryDiff(cfgPre, cfgPost).gained.map((e) => e.path),
        sealedEnvHasUSER: (plan.bundle.env || []).some(([k]) => k === "USER"),
      };
    } finally { f.store.close(); rmTemp(tempRoot); }
  }
  writeJSON(join(dir, "rerun-meta.json"), { probeId: "CC-P5", rerun: true, obs });
  summary.probes.push({ probeId: "CC-P5", rerun: true, obs });
}

// ---- CX-P3 re-run ----
{
  const dir = probeDir("CX-P3");
  const tempRoot = freshTempRoot("CX-P3-rerun");
  const f = makeCodexFixture(tempRoot, {});
  try {
    baselinePass(f);
    const action = schedule(f, "implement");
    const homePre = inventoryDir(f.codexHome);
    const { plan, pending } = dispatchCodex(f, action, "Produce the structured output now.");
    let settled = null, dispatchErr = null;
    try { settled = await settleCodex(f, action, pending); } catch (e) { dispatchErr = String(e.message || e); }
    const homePost = inventoryDir(f.codexHome);
    const cmd = f.store.commands(f.lease.runId).at(-1);
    const cap = captureTierA(dir, "cx-p3", plan, f, cmd, { harness: "codex" });
    const obs = {
      settlement: settled ? { stage: settled.stage, blocker: settled.blocker?.kind ?? null } : null,
      dispatchErr,
      commandOutcome: cap.command?.result?.outcome, exitCode: cap.command?.result?.exitCode,
      frameCount: cap.frames?.length,
      threadStarted: (cap.frames || []).some((fr) => fr && (fr.type === "thread.started" || fr.msg === "thread.started")),
      codexHomeGains: inventoryDiff(homePre, homePost).gained.map((e) => e.path),
      sealedEnvKeyNames: (plan.bundle.env || []).map(([k]) => k),
    };
    writeJSON(join(dir, "rerun-meta.json"), { probeId: "CX-P3", rerun: true, obs });
    summary.probes.push({ probeId: "CX-P3", rerun: true, obs, framesSample: (cap.frames || []).slice(0, 6) });
  } finally { f.store.close(); rmTemp(tempRoot); }
}

// ---- CX-P4 re-run ----
{
  const dir = probeDir("CX-P4");
  const tempRoot = freshTempRoot("CX-P4-rerun");
  const syntheticToml = "# synthetic shared codex config for #108 R1 CX-P4 (nonsecret)\nmodel_provider = \"openai\"\n";
  const f = makeCodexFixture(tempRoot, { configToml: syntheticToml });
  try {
    const pre = dist.captureSharedConfigToml(f.codexHome);
    baselinePass(f);
    const action = schedule(f, "implement");
    const { plan, pending } = dispatchCodex(f, action, "Produce the structured output now.");
    let settled = null, dispatchErr = null;
    try { settled = await settleCodex(f, action, pending); } catch (e) { dispatchErr = String(e.message || e); }
    const post = dist.captureSharedConfigToml(f.codexHome);
    const cmd = f.store.commands(f.lease.runId).at(-1);
    const cap = captureTierA(dir, "cx-p4", plan, f, cmd, { harness: "codex" });
    let postToml = ""; try { postToml = readFileSync(join(f.codexHome, "config.toml"), "utf8"); } catch {}
    const obs = {
      pre, post, drift: dist.sharedConfigTomlDrift(pre, post), trustWritten: /trust_level|projects\./.test(postToml),
      settlement: settled ? { stage: settled.stage, blocker: settled.blocker?.kind ?? null } : null,
      commandOutcome: cap.command?.result?.outcome, exitCode: cap.command?.result?.exitCode, frameCount: cap.frames?.length,
    };
    writeJSON(join(dir, "rerun-meta.json"), { probeId: "CX-P4", rerun: true, obs });
    summary.probes.push({ probeId: "CX-P4", rerun: true, obs });
  } finally { f.store.close(); rmTemp(tempRoot); }
}

console.log(JSON.stringify(summary, null, 2));
