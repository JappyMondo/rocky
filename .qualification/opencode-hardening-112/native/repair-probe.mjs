// #113 comment 1063: synthetic, unprovisioned, no billable model turns.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const out = resolve(fileURLToPath(new URL(".", import.meta.url)));
const bin = "/opt/homebrew/Cellar/opencode/1.18.33/bin/opencode";
const bytes = readFileSync(bin);
if (bytes.length !== 144800738 || createHash("sha256").update(bytes).digest("hex") !== "139ddeb6a46ba276827bb8f79c7b28208621746e4fd6914d9ae71cc1a0a57524") throw new Error("identity-drift: abort");
const root = mkdtempSync(join(out, "repair-synthetic-"));
for (const name of ["home", "config", "data", "cache", "state", "tmp", "source", "db"]) mkdirSync(join(root, name));
writeFileSync(join(root, "models.json"), "{}");
const config = {
  enabled_providers: [], disabled_providers: ["alibaba-token-plan"],
  agent: {
    "probe-read": { model: "invalid-probe/no-such-model", permission: { "*": "deny", read: "allow" } },
    "probe-write": { model: "invalid-probe/no-such-model", permission: { "*": "deny", read: "allow", write: "allow" } },
  },
};
const env = {
  HOME: join(root, "home"), TMPDIR: join(root, "tmp"), PWD: join(root, "source"),
  PATH: "/usr/bin:/bin", LANG: "C", XDG_CONFIG_HOME: join(root, "config"),
  XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"),
  XDG_STATE_HOME: join(root, "state"), OPENCODE_DB: join(root, "db", "run.db"),
  OPENCODE_MODELS_PATH: join(root, "models.json"), OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
  OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_MODELS_FETCH: "1",
  OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
  OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
  OPENCODE_DISABLE_PRUNE: "1", OPENCODE_PURE: "1",
};
const report = { identity: { path: bin, bytes: bytes.length }, root, config, envNames: Object.keys(env), probes: [] };
function save(name, entry) {
  report.probes.push({ name, ...entry });
  for (const field of ["stdout", "stderr", "body"]) if (entry[field] !== undefined) writeFileSync(join(out, `repair-${name}.${field}.txt`), entry[field]);
  writeFileSync(join(out, "repair-result.json"), JSON.stringify(report, null, 2) + "\n");
}
// The model identifier cannot resolve to a provider. The other provider is also disabled;
// any unexpected response suggesting a turn is a hard abort before a second run.
for (const [name, options] of [
  ["invalid-model", { ...env, OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...config, disabled_providers: [] }) }],
  ["disabled-provider", env],
]) {
  const argv = ["run", "--format=json", "--model=invalid-probe/no-such-model", "--agent=probe-read", `--dir=${join(root, "source")}`];
  const p = spawnSync(bin, argv, { cwd: join(root, "source"), env: options, input: "probe\n", encoding: "utf8", timeout: 8000, maxBuffer: 1024 * 1024 });
  save(name, { argv, exitCode: p.status, signal: p.signal, error: p.error?.message, stdout: p.stdout ?? "", stderr: p.stderr ?? "" });
  if (p.status === 0 || /step_finish|tool_use|"type":"text"/.test(p.stdout ?? "")) throw new Error(`unexpected-turn-signal:${name}; abort`);
}

// Registry endpoints do not create a session or message. Compare definitions under
// role-variant configs; do not infer an effective roster if they remain identical.
const server = spawn(bin, ["serve", "--hostname", "127.0.0.1", "--port", "0"], { env, cwd: join(root, "source"), stdio: ["ignore", "pipe", "pipe"] });
let stdout = "", stderr = "";
server.stdout.on("data", b => { stdout += b; });
server.stderr.on("data", b => { stderr += b; });
try {
  const start = Date.now();
  while (!/http:\/\/127\.0\.0\.1:\d+/.test(stdout) && Date.now() - start < 5000 && server.exitCode === null) await new Promise(r => setTimeout(r, 25));
  const base = stdout.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  if (!base) throw new Error("server-start-unavailable");
  for (const agent of ["probe-read", "probe-write"]) {
    const url = `${base}/experimental/tool?provider=invalid-probe&model=no-such-model&agent=${agent}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
    const body = await response.text();
    save(`registry-${agent}`, { path: new URL(url).pathname + new URL(url).search, status: response.status, body });
  }
} finally {
  server.kill("SIGTERM");
  await new Promise(r => server.once("exit", r));
  save("server", { signal: server.signalCode, exitCode: server.exitCode, stdout, stderr });
}
