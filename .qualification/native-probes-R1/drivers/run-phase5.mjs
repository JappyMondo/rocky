// R1 phase 5 — CC-P8 G-MODEL enumeration (decision c). NO spawn of the pinned binary: a bounded,
// read-only `grep -a` strings extraction of model-ID tables from the pinned claude 2.1.283 bundle,
// pattern-filtered + output-capped (≤256KiB), command+binary hashed ⇒ a finite candidate ID set for the
// host-frozen role table. Bundle strings are explicitly NOT runtime attestation (resolvability only via CC-L1).
import {
  PINS,
  probeDir,
  writeJSON,
  writeVerdict,
  writeCapture,
  truncStr,
  spawnBounded,
  sha,
  fileSha,
  MiB,
} from "./lib.mjs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const dir = probeDir("CC-P8");
const BIN = PINS.claude.path;
const binSha = PINS.claude.sha256;
const CAP = 256 * 1024; // 256KiB output cap per extraction

async function grep(pattern, label) {
  const argv = ["-a", "-o", "-E", pattern, BIN];
  const cmd = `grep ${argv.map((a) => (a === BIN ? "<PINNED_CLAUDE_BINARY>" : JSON.stringify(a))).join(" ")}`;
  const r = await spawnBounded({
    file: "/usr/bin/grep",
    args: argv,
    envObj: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    cwd: "/usr/bin",
    stdin: { mode: "eof" },
    wallMs: 60000,
    captureBytes: CAP,
  });
  const out = r.stdout.toString("utf8");
  const matches = out.split("\n").map((s) => s.trim()).filter(Boolean);
  const unique = [...new Set(matches)].sort();
  writeCapture(dir, `strings-${label}.log`, r.stdout);
  return {
    label, pattern, cmd, cmdSha256: sha(cmd), exitCode: r.exitCode,
    stdoutBytes: r.stdoutBytes, stdoutTruncated: r.stdoutTruncated, wallMs: r.wallMs,
    matchCount: matches.length, uniqueCount: unique.length, unique: unique.slice(0, 500),
  };
}

const extractions = [];
// claude-* model-id family tokens
extractions.push(await grep("claude-[a-z0-9][a-z0-9._-]{0,48}", "claude-family"));
// date-stamped opus/sonnet/haiku names
extractions.push(await grep("(opus|sonnet|haiku)-[0-9][a-z0-9.-]{0,24}", "dated-names"));
// explicit claude-(opus|sonnet|haiku|instant) families
extractions.push(await grep("claude-(opus|sonnet|haiku|instant)[a-z0-9._-]{0,40}", "claude-opus-sonnet-haiku"));
// availableModels / alias context (bounded surrounding bytes)
extractions.push(await grep(".{0,16}availableModels.{0,80}", "available-models-context"));

// Build the finite candidate model-ID set (claude-* + dated names that look like model ids).
const candidateSet = new Set();
for (const e of extractions) {
  if (e.label === "available-models-context") continue;
  for (const u of e.unique) {
    const t = u.replace(/[^a-z0-9._-].*$/i, "");
    if (/^(claude-|(opus|sonnet|haiku)-)/i.test(t) && t.length >= 6 && t.length <= 64) candidateSet.add(t);
  }
}
const candidates = [...candidateSet].sort();
const meta = {
  probeId: "CC-P8", binary: BIN, binarySha256: binSha, binaryBytes: PINS.claude.bytes,
  binaryShaReverified: (() => { try { return fileSha(BIN) === binSha; } catch { return null; } })(),
  outputCapBytes: CAP, extractions, candidateModelIds: candidates, candidateCount: candidates.length,
};
writeJSON(dir + "/meta.json", meta);

const verdict = candidates.length > 0 ? "PASS" : "REJECT";
writeVerdict("CC-P8", {
  verdict,
  tier: "static (bundle strings; NOT runtime attestation)",
  gate: "G-MODEL (enumeration half; decision c)",
  hypothesis: "A bounded read-only grep of the pinned claude 2.1.283 bundle yields a finite candidate set of claude model IDs (opus/sonnet/haiku families + availableModels/alias context) for the host-frozen role table.",
  criterion: "PART2 CC-P8 / PART4 G-MODEL step: 'bounded read-only strings extraction of model-ID tables from the pinned 2.1.283 bundle (output-capped, pattern-filtered, command+binary hashed), yielding a candidate ID list for the host-frozen role table; bundle strings explicitly NOT runtime attestation — actual resolvability comes only from CC-L1 modelUsage/assistant.message.model or stays open.'",
  expected: "a nonempty finite candidate ID set; command+binary hashed.",
  observed: JSON.stringify({ candidateCount: candidates.length, sample: candidates.slice(0, 40), binaryShaReverified: meta.binaryShaReverified, extractionCmdSha: extractions.map((e) => ({ label: e.label, cmdSha256: e.cmdSha256, uniqueCount: e.uniqueCount })) }),
  class: verdict === "PASS" ? "candidate-id-set-enumerated" : "no-candidates-extracted",
  notes: "FLAG: these are BUNDLE STRINGS, not runtime-attested model IDs. Resolvability of any candidate (incl. the host role-table models) is established ONLY by CC-L1 modelUsage (LIVE, NOT run in R1) or stays open. qwen3.8-max/OpenCode-chain resolvability is #104, out of scope. No spawn of the pinned binary (read-only grep).",
});
console.log(JSON.stringify({ phase: 5, results: [{ probeId: "CC-P8", verdict }], candidateCount: candidates.length, sample: candidates.slice(0, 40) }, null, 2));
