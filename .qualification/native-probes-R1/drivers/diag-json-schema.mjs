// R1 DIAGNOSTIC (post-freeze, hashed in drivers.sha256 addendum) — characterize the CC-P5 finding that
// native claude 2.1.283 rejects the contract's inline --json-schema (draft 2020-12 $schema) with
// "no schema with key or ref". This isolates whether the rejection is specific to the 2020-12 meta-schema
// reference (fixable by draft choice) or broader. Tier-B bare argv, sealed UNAUTH synthetic CFG + private
// HOME ⇒ zero billable turn; bounded ≤30s each; one owned group per spawn. NOT a contract amendment; it is
// divergence characterization for R3.
import {
  PINS, ROOT, freshTempRoot, rmTemp, probeDir, writeJSON, writeCapture,
  truncStr, spawnBounded, sealedClaudeEnv, MiB,
} from "./lib.mjs";
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const dir = probeDir("CC-P5"); // diagnostic filed alongside the CC-P5 finding
const CLAUDE = PINS.claude.path;
const MODEL = "claude-sonnet-4-5";
const base = JSON.parse(readFileSync(join(ROOT, "acceptance/subscription/final.schema.json"), "utf8"));

const variants = [];
// 1. contract schema as-is (draft 2020-12 $schema) — reproduce the rejection
variants.push(["contract-2020-12", JSON.stringify(base)]);
// 2. same schema, $schema → draft-07
variants.push(["draft-07", JSON.stringify({ ...base, $schema: "http://json-schema.org/draft-07/schema#" })]);
// 3. same schema, $schema removed (keep $id)
{ const { $schema, ...rest } = base; variants.push(["no-schema-key", JSON.stringify(rest)]); }
// 4. same schema, $schema AND $id removed
{ const { $schema, $id, ...rest } = base; variants.push(["no-schema-no-id", JSON.stringify(rest)]); }
// 5. minimal object schema, no $schema/$id
variants.push(["minimal-no-meta", JSON.stringify({ type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } })]);

const results = [];
for (const [name, schemaJson] of variants) {
  const tempRoot = freshTempRoot(`CC-P5-diag-${name}`);
  const sealed = sealedClaudeEnv(tempRoot, {});
  const src = join(tempRoot, "src");
  mkdirSync(src, { recursive: true, mode: 0o700 });
  const r = await spawnBounded({
    file: CLAUDE,
    args: ["-p", "--output-format=stream-json", "--verbose", "--input-format=text", `--json-schema=${schemaJson}`, `--model=${MODEL}`],
    envObj: sealed.envObj, cwd: src, stdin: { mode: "write", data: "hi" },
    wallMs: 30000, captureBytes: 4 * MiB,
  });
  const out = r.stdout.toString("utf8"), err = r.stderr.toString("utf8");
  const schemaRejected = /is not a valid JSON Schema|no schema with key or ref|JSON Schema/i.test(err);
  const reachedAuthOrInit = /"subtype":"init"/.test(out) || /Not logged in|authentication_failed/i.test(out);
  results.push({
    name, schemaBytes: Buffer.byteLength(schemaJson), exitCode: r.exitCode, signal: r.signal, wallMs: r.wallMs,
    spawnError: r.spawnError, stdinNote: r.stdinNote, timedOut: r.timedOut,
    schemaRejected, reachedAuthOrInit, stderrHead: truncStr(err, 400), stdoutHead: truncStr(out, 300),
  });
  writeCapture(dir, `diag-${name}-stderr.log`, r.stderr);
  writeCapture(dir, `diag-${name}-stdout.log`, r.stdout);
  rmTemp(tempRoot);
}
writeJSON(join(dir, "diag-json-schema.json"), { probeId: "CC-P5", diagnostic: "json-schema-draft-isolation", binary: PINS.claude, results });
console.log(JSON.stringify({ diagnostic: "json-schema-draft-isolation", results: results.map((r) => ({ name: r.name, exit: r.exitCode, signal: r.signal, wallMs: r.wallMs, spawnError: r.spawnError, schemaRejected: r.schemaRejected, reachedAuthOrInit: r.reachedAuthOrInit, stderr: r.stderrHead.slice(0, 160), stdout: r.stdoutHead.slice(0, 80) })) }, null, 2));
