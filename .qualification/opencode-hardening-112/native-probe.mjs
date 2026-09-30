// #113 NP/NP2: zero-prompt, zero-run native probe. Only synthetic XDG/HOME/DB directories;
// never reads auth bytes or invokes a model/turn endpoint. Raw bounded responses retained.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const binary = "/opt/homebrew/Cellar/opencode/1.18.33/bin/opencode";
const expected = {
  sha256: "139ddeb6a46ba276827bb8f79c7b28208621746e4fd6914d9ae71cc1a0a57524",
  bytes: 144800738,
};
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const root = resolve(".qualification/opencode-hardening-112/native");
mkdirSync(root, { recursive: true });
const workspace = mkdtempSync(join(root, "synthetic-"));
const dirs = Object.fromEntries(
  ["home", "tmp", "config", "data", "cache", "state", "source", "db"].map(
    (name) => {
      const path = join(workspace, name);
      mkdirSync(path, { mode: 0o700 });
      return [name, path];
    },
  ),
);
const catalog = join(workspace, "models.json");
writeFileSync(catalog, "{}\n");
const config = JSON.stringify({
  enabled_providers: [],
  share: "disabled",
  autoupdate: false,
  snapshot: false,
  subagent_depth: 0,
  agent: {
    "rocky-implementer": {
      model: "alibaba-token-plan/qwen3.8-max",
      prompt: "Synthetic probe role; never run a turn.",
      steps: 1,
      permission: {
        edit: { "*": "allow" },
        bash: { "*": "allow" },
        read: { "*": "allow" },
        task: "deny",
        webfetch: "deny",
        websearch: "deny",
        skill: "deny",
        question: "deny",
        external_directory: { "*": "deny" },
      },
    },
    "rocky-reviewer": {
      model: "alibaba-token-plan/qwen3.8-max",
      prompt: "Synthetic probe role; never run a turn.",
      steps: 1,
      permission: {
        "*": "deny",
        read: "allow",
        glob: "allow",
        grep: "allow",
        list: "allow",
      },
    },
  },
});
const env = {
  HOME: dirs.home,
  TMPDIR: dirs.tmp,
  PWD: dirs.source,
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  LANG: "en_US.UTF-8",
  XDG_CONFIG_HOME: dirs.config,
  XDG_DATA_HOME: dirs.data,
  XDG_CACHE_HOME: dirs.cache,
  XDG_STATE_HOME: dirs.state,
  OPENCODE_DB: join(dirs.db, "run.db"),
  OPENCODE_MODELS_PATH: catalog,
  OPENCODE_CONFIG_CONTENT: config,
  OPENCODE_DISABLE_PROJECT_CONFIG: "1",
  OPENCODE_DISABLE_MODELS_FETCH: "1",
  OPENCODE_DISABLE_AUTOUPDATE: "1",
  OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
  OPENCODE_DISABLE_CLAUDE_CODE: "1",
  OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
  OPENCODE_DISABLE_PRUNE: "1",
  OPENCODE_PURE: "1",
};
const inventory = (dir, depth = 0) => {
  if (depth > 4) return ["depth-limit"];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory()
      ? [path, ...inventory(path, depth + 1)]
      : [path];
  });
};
const identity = { ...expected, path: binary };
const actual = { bytes: statSync(binary).size, sha256: hash(readFileSync(binary)) };
const report = {
  identity,
  actual,
  workspace,
  configSha256: hash(config),
  envNames: Object.keys(env),
  envSha256: hash(JSON.stringify(Object.entries(env))),
  pre: inventory(workspace),
  probes: [],
};
const persist = () =>
  writeFileSync(join(root, "result.json"), JSON.stringify(report, null, 2) + "\n");
persist();
if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256)
  throw new Error("binary-identity-drift:zero-spawn");

const capture = (child, name) => {
  const chunks = { stdout: [], stderr: [] };
  const count = { stdout: 0, stderr: 0 };
  for (const stream of ["stdout", "stderr"])
    child[stream].on("data", (bytes) => {
      count[stream] += bytes.length;
      if (count[stream] <= 4 * 1024 * 1024) chunks[stream].push(bytes);
      else child.kill("SIGKILL");
    });
  const save = (exitCode, signal, started, timedOut) => {
    const result = {
      name,
      argv: child.spawnargs,
      pid: child.pid,
      exitCode,
      signal,
      timedOut,
      elapsedMs: Date.now() - started,
      bytes: count,
    };
    for (const stream of ["stdout", "stderr"]) {
      const raw = Buffer.concat(chunks[stream]);
      result[stream] = raw.toString("utf8");
      result[`${stream}Sha256`] = hash(raw);
      writeFileSync(join(root, `${name}.${stream}.txt`), raw);
    }
    report.probes.push(result);
    persist();
    return result;
  };
  return { chunks, save };
};
const command = async (name, args) => {
  const started = Date.now();
  const child = spawn(binary, args, {
    env,
    cwd: dirs.source,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const cap = capture(child, name);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ }
  }, 30000);
  const result = await new Promise((done) =>
    child.once("close", (code, signal) => done(cap.save(code, signal, started, timedOut))),
  );
  clearTimeout(timer);
  return result;
};
const http = async (name, port, path, method = "GET", body) => {
  const url = `http://127.0.0.1:${port}${path}`;
  const response = await fetch(url, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(3000),
  });
  const text = await response.text();
  if (Buffer.byteLength(text) > 4 * 1024 * 1024)
    throw new Error(`oversized-http-response:${name}`);
  writeFileSync(join(root, `${name}.http.txt`), text);
  report.probes.push({ name, method, path, status: response.status, text, sha256: hash(text) });
  persist();
  return { response, text };
};

try {
  const help = await command("help", ["--help"]);
  const missing = await command("export-nonexistent", ["export", "ses_00000000000000000000000000"]);
  if (help.timedOut || missing.timedOut) throw new Error("probe-timeout-abort");
  // No run, prompt, message, provider or model endpoint is ever invoked.
  const started = Date.now();
  const child = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
    env,
    cwd: dirs.source,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const cap = capture(child, "serve");
  let closed = false;
  child.once("close", () => { closed = true; });
  try {
    let port;
    for (let i = 0; i < 100; i++) {
      const output = Buffer.concat(cap.chunks.stdout).toString("utf8");
      port = /127\.0\.0\.1:(\d+)/.exec(output)?.[1];
      if (port || closed) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!port) throw new Error("serve-no-loopback-port");
    const created = await http("create-empty-session", port, "/session", "POST", {});
    const id = JSON.parse(created.text).id;
    if (created.response.status !== 200 || !/^ses_/.test(id))
      throw new Error("empty-session-create-failed");
    const exported = await command("export-empty-session", ["export", id]);
    if (exported.timedOut) throw new Error("export-timeout-abort");
    await http("tool-ids", port, "/experimental/tool/ids");
    const modelQuery = "provider=alibaba-token-plan&model=qwen3.8-max";
    await http("tool-implementer", port, `/experimental/tool?${modelQuery}&agent=rocky-implementer`);
    await http("tool-reviewer", port, `/experimental/tool?${modelQuery}&agent=rocky-reviewer`);
  } finally {
    try { process.kill(-child.pid, "SIGTERM"); } catch { /* already exited */ }
    await new Promise((r) => setTimeout(r, 300));
    if (!closed) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ }
    }
    cap.save(child.exitCode, child.signalCode, started, Date.now() - started >= 30000);
  }
} catch (error) {
  report.error = String(error);
} finally {
  report.post = inventory(workspace);
  persist();
}
