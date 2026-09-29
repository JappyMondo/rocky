// R1 native-probe driver library (Taskbot #108). Shared helpers for the zero-turn / zero-call batch.
// Reuses the SHIPPED adapter entry points from dist/ and the tests/*-support.mjs fixture scaffolding
// with the pinned REAL binaries swapped in for the fakes and a synthetic-unapproved qualification.
// Nothing here touches real ~/.claude, ~/.codex, keychains, auth bytes, target repos or the network
// of its own accord. Must be imported by drivers run with cwd = repo ROOT.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  lstatSync,
  realpathSync,
  rmSync,
  existsSync,
  appendFileSync,
  readlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

export const ROOT = "/Users/jappy/.t3/worktrees/rocky/rocky-next";
export const EVID = join(ROOT, ".qualification/native-probes-R1");
export const TEMP_BASE =
  "/var/folders/0s/94wd01s17jsdg_7jk3zfqsd40000gn/T/opencode";

export const dist = await import(join(ROOT, "dist/index.js"));
export const proc = await import(join(ROOT, "dist/runner/process.js"));
export const claudeSupport = await import(
  join(ROOT, "tests/claude-code-support.mjs")
);
export const codexSupport = await import(
  join(ROOT, "tests/codex-exec-support.mjs")
);
export const coordSupport = await import(
  join(ROOT, "tests/coordinator-support.mjs")
);

export const PINS = {
  claude: {
    path: "/Users/jappy/.local/share/claude/versions/2.1.283",
    sha256:
      "d8cb1e5c79684cc12a8bfc813e3a2073406921b6245744b3009be3ab5651d21e",
    bytes: 225036032,
    version: "2.1.283",
    buildTime: "2026-09-25T00:44:42Z",
  },
  codex: {
    path: "/opt/homebrew/Caskroom/codex/0.157.1/bin/codex",
    sha256:
      "27ceb5f9b957b43a519efe4eaa3816a0bffb0a531a2c89af18840c0a3c016a7d",
    bytes: 238223808,
    version: "0.157.1",
    buildTime: null,
    sourceCommit: "36650394c5b38c2990ccf2a3457165ca3e9d9726",
  },
};

export const sha = (b) => createHash("sha256").update(b).digest("hex");
export const fileSha = (p) => sha(readFileSync(p));
export const MiB = 1024 * 1024;

// ---- temp roots (fresh per probe, deleted after evidence copy) ----
export function freshTempRoot(probe) {
  mkdirSync(TEMP_BASE, { recursive: true });
  return realpathSync(
    mkdtempSync(join(TEMP_BASE, `native-probes-r1-${probe}-`))
  );
}
export function rmTemp(root) {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

// ---- non-throwing recursive inventory (names + bytes + sha256; symlinks recorded, never followed) ----
export function inventoryDir(root) {
  const out = [];
  if (!existsSync(root)) return { root, present: false, entries: out };
  const walk = (dir, rel) => {
    let names;
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const abs = join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      let st;
      try {
        st = lstatSync(abs);
      } catch {
        out.push({ path: r, kind: "unreadable" });
        continue;
      }
      if (st.isSymbolicLink()) {
        let target = null;
        try {
          target = readlinkSync(abs);
        } catch {}
        out.push({ path: r, kind: "link", target });
      } else if (st.isDirectory()) {
        out.push({ path: r, kind: "dir" });
        walk(abs, r);
      } else if (st.isFile()) {
        let h = null;
        try {
          h = fileSha(abs);
        } catch {}
        out.push({ path: r, kind: "file", bytes: st.size, sha256: h });
      } else out.push({ path: r, kind: "other", mode: st.mode });
    }
  };
  walk(root, "");
  return { root, present: true, entries: out };
}
export function inventoryDiff(pre, post) {
  const key = (e) => e.path;
  const preMap = new Map(pre.entries.map((e) => [key(e), e]));
  const postMap = new Map(post.entries.map((e) => [key(e), e]));
  const gained = [],
    changed = [],
    removed = [];
  for (const [k, e] of postMap) {
    const p = preMap.get(k);
    if (!p) gained.push(e);
    else if (JSON.stringify(p) !== JSON.stringify(e)) changed.push({ pre: p, post: e });
  }
  for (const [k, e] of preMap) if (!postMap.has(k)) removed.push(e);
  return { gained, changed, removed };
}

// ---- G-MANAGED real-host managed-layer presence (lstat/name only; contents NEVER read) ----
export function managedLayerInventory() {
  const home = homedir();
  const paths = [
    "/Library/Application Support/ClaudeCode/managed-settings.json",
    "/Library/Application Support/ClaudeCode/managed-mcp.json",
    "/Library/Application Support/ClaudeCode/CLAUDE.md",
    "/Library/Application Support/ClaudeCode/managed-settings.d",
    "/Library/Managed Preferences/com.anthropic.claudecode.plist",
    join(home, "Library/Managed Preferences/com.anthropic.claudecode.plist"),
    "/etc/codex/config.toml",
    "/etc/codex/requirements.toml",
    "/etc/codex/managed_config.toml",
    "/etc/codex/skills",
    "/Library/Managed Preferences/com.openai.codex.plist",
    join(home, "Library/Managed Preferences/com.openai.codex.plist"),
  ];
  return paths.map((p) => {
    let present = false,
      kind = "absent",
      names = null;
    try {
      const st = lstatSync(p);
      present = true;
      kind = st.isDirectory()
        ? "dir"
        : st.isSymbolicLink()
          ? "link"
          : st.isFile()
            ? "file"
            : "other";
      if (st.isDirectory()) {
        try {
          names = readdirSync(p).sort();
        } catch {
          names = ["<unreadable>"];
        }
      }
    } catch {}
    return { path: p, present, kind, names };
  });
}

// ---- bounded native spawn: one owned process group, wall cap (kill group), capture cap ----
// stdin modes: "eof" (close immediately), "keepOpen" (no EOF), {write:data}, {writeAfterExit:data}
export function spawnBounded(opts) {
  const captureBytes = opts.captureBytes ?? 4 * MiB;
  const wallMs = opts.wallMs ?? 30000;
  const killGraceMs = opts.killGraceMs ?? 500;
  return new Promise((res) => {
    const start = Date.now();
    const signalsSent = [];
    let child;
    try {
      child = spawn(opts.file, opts.args, {
        cwd: opts.cwd,
        env: opts.envObj,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      return res({
        spawnError: String(e && e.message ? e.message : e),
        wallMs: 0,
        signalsSent,
      });
    }
    const pgid = child.pid;
    const killGroup = (sig) => {
      try {
        process.kill(-pgid, sig);
        signalsSent.push({ sig, atMs: Date.now() - start });
      } catch (e) {
        signalsSent.push({ sig, error: String(e.code || e.message) });
      }
    };
    const outChunks = [],
      errChunks = [];
    let outBytes = 0,
      errBytes = 0,
      outTrunc = false,
      errTrunc = false;
    const collect = (isOut) => (d) => {
      const arr = isOut ? outChunks : errChunks;
      let used = isOut ? outBytes : errBytes;
      const room = Math.max(0, captureBytes - used);
      const chunk = room >= d.length ? d : d.subarray(0, room);
      if (chunk.length) arr.push(chunk);
      if (isOut) {
        outBytes += chunk.length;
        outTrunc ||= chunk.length < d.length;
      } else {
        errBytes += chunk.length;
        errTrunc ||= chunk.length < d.length;
      }
    };
    child.stdout.on("data", collect(true));
    child.stderr.on("data", collect(false));
    let stdinNote = null;
    if (child.stdin) {
      child.stdin.on("error", (e) => {
        stdinNote = `stdin-error:${e.code || e.message}`;
      });
    }
    let settled = false;
    const timers = [];
    const finish = (extra = {}) => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      let code = child.exitCode,
        sig = child.signalCode;
      res({
        exitCode: code,
        signal: sig,
        stdout: Buffer.concat(outChunks),
        stderr: Buffer.concat(errChunks),
        stdoutBytes: outBytes,
        stderrBytes: errBytes,
        stdoutTruncated: outTrunc,
        stderrTruncated: errTrunc,
        wallMs: Date.now() - start,
        timedOut: !!extra.timedOut,
        spawnError: extra.spawnError || null,
        stdinNote,
        signalsSent,
        pgid,
      });
    };
    // wall cap: SIGTERM group, then SIGKILL after grace, then hard backstop finish.
    timers.push(
      setTimeout(() => {
        killGroup("SIGTERM");
        timers.push(
          setTimeout(() => {
            killGroup("SIGKILL");
            timers.push(setTimeout(() => finish({ timedOut: true }), 1000));
          }, killGraceMs)
        );
      }, wallMs)
    );
    for (const s of opts.signals || [])
      timers.push(setTimeout(() => killGroup(s.signal), s.atMs));
    child.on("error", (e) =>
      finish({ spawnError: String(e && e.message ? e.message : e) })
    );
    child.on("close", () => finish({ timedOut: settled ? undefined : false }));
    // stdin delivery
    const stdin = opts.stdin ?? { mode: "eof" };
    try {
      if (stdin.mode === "eof") child.stdin.end();
      else if (stdin.mode === "keepOpen") {
        /* no EOF; held open until wall cap / signal */
      } else if (stdin.mode === "write") {
        child.stdin.end(stdin.data);
      } else if (stdin.mode === "writeAfterExit") {
        child.once("exit", () => {
          try {
            child.stdin.write(stdin.data, () => {});
            child.stdin.end();
          } catch (e) {
            stdinNote = `write-after-exit-throw:${e.code || e.message}`;
          }
        });
      }
    } catch (e) {
      stdinNote = `stdin-setup-throw:${e.code || e.message}`;
    }
  });
}

// ---- sealed env via the SHIPPED serializers (binds Tier-B to shipped env bytes) ----
export function sealedClaudeEnv(tempRoot, opts = {}) {
  const parentHome = join(tempRoot, "ph");
  const parentTmp = join(tempRoot, "pt");
  const configDir = opts.configDir ?? join(tempRoot, "cfg");
  for (const p of [parentHome, parentTmp, configDir])
    mkdirSync(p, { recursive: true, mode: 0o700 });
  const envArray = dist.buildClaudeSealedEnv(
    { parentHome, configDir, parentTmp },
    {
      shell: opts.shell ?? false,
      user: opts.user ?? false,
      userName: opts.userName ?? "np-r1-synthetic",
    }
  );
  return {
    envArray,
    envObj: Object.fromEntries(envArray),
    paths: { parentHome, parentTmp, configDir },
  };
}
export function sealedCodexEnv(tempRoot, opts = {}) {
  const parentHome = join(tempRoot, "ph");
  const parentTmp = join(tempRoot, "pt");
  const codexHome = opts.codexHome ?? join(tempRoot, "codex-home");
  for (const p of [parentHome, parentTmp, codexHome])
    mkdirSync(p, { recursive: true, mode: 0o700 });
  const envArray = dist.buildCodexSealedEnv(
    { parentHome, codexHome, parentTmp },
    {
      shell: opts.shell ?? false,
      user: opts.user ?? false,
      userName: opts.userName ?? "np-r1-synthetic",
    }
  );
  return {
    envArray,
    envObj: Object.fromEntries(envArray),
    paths: { parentHome, parentTmp, codexHome },
  };
}
// Redacted env listing: key names + nonsecret values, but any value that is a path is shown; no secrets exist in sealed env.
export function redactedEnv(envArray) {
  return envArray.map(([k, v]) => [k, v]);
}

// ---- Tier-A fixtures: mirror tests/*-support fixtures but with the pinned REAL binary ----
export function makeClaudeFixture(tempRoot, opts = {}) {
  const { Store, Evidence, ClaudeCodeAdapter } = dist;
  const artifactRoot = join(tempRoot, "artifacts");
  mkdirSync(artifactRoot, { recursive: true });
  const store = new Store(join(artifactRoot, "state.sqlite"), Date.now);
  const syntheticHome = join(tempRoot, "synthetic-home");
  const syntheticTmp = join(tempRoot, "synthetic-tmp");
  const f = {
    dir: tempRoot,
    artifactRoot,
    store,
    binary: PINS.claude,
    configDir: join(tempRoot, "claude-config"),
    runsRoot: join(tempRoot, "runs"),
    discoveryRoot: join(tempRoot, "discovery"),
    denyRoot: join(tempRoot, "deny-root"),
    syntheticHome,
  };
  for (const p of [
    f.configDir,
    f.runsRoot,
    f.discoveryRoot,
    f.denyRoot,
    syntheticHome,
    syntheticTmp,
  ])
    mkdirSync(p, { recursive: true, mode: 0o700 });
  const admissionInput = {
    ...coordSupport.admission("run-1"),
    capability: null,
    budget: {
      mode: claudeSupport.MODE,
      reportedTokenThreshold: 100000,
    },
    qualification: claudeSupport.qualification,
    head: "head-1",
    limits: {
      totalTokens: 100000,
      totalElapsedMs: 600000,
      actionTokens: 100,
      actionElapsedMs: opts.actionElapsedMs ?? 28000,
    },
  };
  store.admitCoordinator(admissionInput);
  const lease = store.claim("run-1", "owner", claudeSupport.versions, 1000000);
  f.lease = lease;
  f.evidence = new Evidence(join(artifactRoot, "evidence"));
  f.sourceEnv = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: syntheticHome,
    TMPDIR: syntheticTmp,
    LANG: "en_US.UTF-8",
  };
  f.config = claudeSupport.baseConfig(f, {
    binary: PINS.claude,
    hostIdentity: { userHome: syntheticHome, userName: "np-r1-synthetic" },
    evidenceClass: "synthetic-native",
    ...(opts.config || {}),
  });
  f.adapter = new ClaudeCodeAdapter(store, lease, f.config, {
    sourceEnv: f.sourceEnv,
  });
  return f;
}
export function makeCodexFixture(tempRoot, opts = {}) {
  const { Store, Evidence, CodexExecAdapter, defaultCodexPlatformDenyRoots } =
    dist;
  const artifactRoot = join(tempRoot, "artifacts");
  mkdirSync(artifactRoot, { recursive: true });
  const store = new Store(join(artifactRoot, "state.sqlite"), Date.now);
  const syntheticHome = join(tempRoot, "synthetic-home");
  const syntheticTmp = join(tempRoot, "synthetic-tmp");
  const codexHome = join(tempRoot, "codex-home");
  const f = {
    dir: tempRoot,
    artifactRoot,
    store,
    binary: PINS.codex,
    codexHome,
    runsRoot: join(tempRoot, "runs"),
    discoveryRoot: join(tempRoot, "discovery"),
    denyRoot: join(tempRoot, "deny-root"),
    syntheticHome,
  };
  for (const p of [
    codexHome,
    f.runsRoot,
    f.discoveryRoot,
    f.denyRoot,
    syntheticHome,
    syntheticTmp,
  ])
    mkdirSync(p, { recursive: true, mode: 0o700 });
  // synthetic NONSECRET shared config.toml so the F5 trust-persistence byte check has a baseline.
  const configTomlBytes =
    opts.configToml ??
    "# synthetic shared codex home for Taskbot #108 R1 native probes (nonsecret)\n";
  writeFileSync(join(codexHome, "config.toml"), configTomlBytes);
  const admissionInput = {
    ...coordSupport.admission("run-1"),
    capability: null,
    budget: { mode: codexSupport.MODE, reportedTokenThreshold: 100000 },
    qualification: codexSupport.qualification,
    head: "head-1",
    limits: {
      totalTokens: 100000,
      totalElapsedMs: 600000,
      actionTokens: 100,
      actionElapsedMs: opts.actionElapsedMs ?? 28000,
    },
  };
  store.admitCoordinator(admissionInput);
  const lease = store.claim("run-1", "owner", codexSupport.versions, 1000000);
  f.lease = lease;
  f.evidence = new Evidence(join(artifactRoot, "evidence"));
  f.sourceEnv = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: syntheticHome,
    TMPDIR: syntheticTmp,
    LANG: "en_US.UTF-8",
  };
  f.config = codexSupport.baseConfig(f, {
    binary: PINS.codex,
    hostIdentity: { userHome: syntheticHome, userName: "np-r1-synthetic" },
    evidenceClass: "synthetic-native",
    ...(opts.config || {}),
  });
  f.adapter = new CodexExecAdapter(store, lease, f.config, {
    sourceEnv: f.sourceEnv,
  });
  return f;
}

// ---- evidence layout ----
export function probeDir(probeId) {
  const d = join(EVID, "probes", probeId);
  mkdirSync(join(d, "inventories"), { recursive: true });
  return d;
}
export function writeCapture(dir, name, buf, note = {}) {
  // byte-bounded raw capture; >1MB truncated-with-hash + noted
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf ?? "");
  const full = b.length;
  const fullSha = sha(b);
  let stored = b;
  let truncated = false;
  if (full > 1 * MiB) {
    stored = b.subarray(0, 1 * MiB);
    truncated = true;
  }
  writeFileSync(join(dir, name), stored);
  return {
    file: name,
    bytes: full,
    storedBytes: stored.length,
    sha256: fullSha,
    truncated,
    ...note,
  };
}
export function writeJSON(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}
export function writeVerdict(probeId, v) {
  const dir = probeDir(probeId);
  const md = `# ${probeId} — verdict ${v.verdict}

- tier: ${v.tier}
- gate/scenario fed: ${v.gate}
- hypothesis: ${v.hypothesis}
- criterion (plan, quoted): ${v.criterion}
- expected: ${v.expected}
- observed: ${v.observed}
- class: ${v.class}
- wallMs: ${v.wallMs ?? "n/a"}
- exit/signal: ${v.exit ?? "n/a"}

${v.notes || ""}
`;
  writeFileSync(join(dir, "verdict.md"), md);
  writeJSON(join(dir, "verdict.json"), v);
}
const CONSUMED = join(EVID, "consumed.md");
export function isConsumed(probeId) {
  try {
    return readFileSync(CONSUMED, "utf8")
      .split("\n")
      .some((l) => l.trim().startsWith(`- ${probeId} `));
  } catch {
    return false;
  }
}
export function consume(probeId, verdict) {
  if (!existsSync(CONSUMED))
    writeFileSync(CONSUMED, "# R1 consumed-probe list (no silent re-runs)\n\n");
  appendFileSync(
    CONSUMED,
    `- ${probeId} ${new Date().toISOString()} verdict=${verdict}\n`
  );
}

// ---- helpers ----
export function errName(e) {
  return (e && e.message ? e.message : String(e)).split("\n")[0];
}
export function truncStr(s, n = 4000) {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, n) + `…[+${s.length - n}B]` : s;
}

// ---- phase runner: serial, consumed-guard, crash⇒ENVIRONMENT_FAILURE, two-consecutive stop ----
export function makePhaseRunner(phaseName) {
  const state = { consecutiveEnvFailures: 0, stopped: false, results: [] };
  async function run(probeId, fn) {
    if (state.stopped) {
      state.results.push({ probeId, verdict: "SKIPPED-BATCH-STOPPED" });
      return "SKIPPED-BATCH-STOPPED";
    }
    if (isConsumed(probeId)) {
      state.results.push({ probeId, verdict: "ALREADY-CONSUMED" });
      return "ALREADY-CONSUMED";
    }
    let verdict;
    try {
      verdict = await fn();
    } catch (e) {
      // Driver crash ⇒ ENVIRONMENT_FAILURE (at most one re-run handled by the agent, not here).
      verdict = "ENVIRONMENT_FAILURE";
      try {
        const dir = probeDir(probeId);
        writeJSON(dir + "/meta.json", {
          probeId,
          driverCrash: errName(e),
          stack: truncStr(e && e.stack ? e.stack : String(e), 8000),
        });
        writeVerdict(probeId, {
          verdict,
          tier: "driver",
          gate: "n/a",
          hypothesis: `${probeId} driver completed without crashing.`,
          criterion:
            "PART4: 'driver crash ⇒ ENVIRONMENT_FAILURE, at most one re-run'.",
          expected: "driver runs to completion",
          observed: `driver crashed: ${errName(e)}`,
          class: "driver-crash",
          notes: "No CLI verdict produced; probe may be re-run at most once by the agent.",
        });
      } catch {}
    }
    consume(probeId, verdict);
    if (verdict === "ENVIRONMENT_FAILURE") state.consecutiveEnvFailures++;
    else state.consecutiveEnvFailures = 0;
    if (state.consecutiveEnvFailures >= 2) state.stopped = true;
    state.results.push({ probeId, verdict });
    return verdict;
  }
  function summary() {
    return {
      phase: phaseName,
      results: state.results,
      stoppedTwoConsecutiveEnvFailures: state.stopped,
    };
  }
  return { run, summary, state };
}
