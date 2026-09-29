// Taskbot #97 launch-bundle tests: CC01-CC05 pre-spawn rules against the frozen
// rocky-claude-code-95-v1 contract, exercised with the owned fake CLI, real SQLite stores and
// real spawned processes where a spawn is admitted. F01/F02/F03/F04(rejections)/F13(pre-run).
import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  claudeFixture,
  baseConfig,
  baselinePass,
  schedule,
  finalProposal,
  successScript,
  dispatchClaude,
  settleClaude,
  fakeRecord,
  readReceipt,
  contractBinding,
  qualification,
  versions,
  localUsage,
  finish,
  receipt as registerReceipt,
  TEST_MODEL,
  sha,
} from "./claude-code-support.mjs";
import { coordinatorModule } from "./coordinator-support.mjs";
const {
  ClaudeCodeAdapter,
  validateClaudeCodeConfig,
  buildClaudeArgv,
  assertClaudeArgv,
  renderClaudeSettings,
  validateClaudeSettingsBytes,
  canonical,
  CLAUDE_ROLE_TOOLS,
  CLAUDE_DISALLOWED_TOOLS,
} = coordinatorModule;
const promptOf = (action) =>
  JSON.stringify({ script: [{ exit: 0 }], actionKey: action.key });

function implementAction(f) {
  baselinePass(f);
  return schedule(f, "implement");
}
function prepared(f, options = {}) {
  const action = implementAction(f);
  const plan = f.adapter.prepareLaunch(action, {
    prompt: promptOf(action),
    ...(options.stage ? { stage: options.stage } : {}),
  });
  return { action, plan };
}
function argvInput(f, plan, role = "implementer") {
  const settings = plan.bundle.argv.find((a) => a.startsWith("--settings="));
  const instructions = plan.bundle.argv.find((a) =>
    a.startsWith("--append-system-prompt-file="),
  );
  const schema = plan.bundle.argv.find((a) => a.startsWith("--json-schema="));
  return {
    role,
    model: TEST_MODEL,
    effort: "high",
    maxTurns: f.config.limits.maxTurns,
    settingsPath: settings.slice("--settings=".length),
    requestSchemaCanonical: schema.slice("--json-schema=".length),
    instructionsPath: instructions.slice("--append-system-prompt-file=".length),
    maxArgvBytes: f.config.limits.maxArgvBytes,
  };
}

test("X01 pinned-binary identity: symlink, drift, truncation and missing binaries refuse with zero spawn; version pin enforced (CC01/F01)", () => {
  const f = claudeFixture("X01");
  try {
    const action = implementAction(f);
    // A symlink spawn target is never admitted (the ~/.local/bin symlink moves on auto-update).
    const linkPath = join(f.artifactRoot, "claude-symlink");
    symlinkSync(f.binary.path, linkPath);
    const linkAdapter = new ClaudeCodeAdapter(
      f.store,
      f.lease,
      baseConfig(f, { binary: { ...f.binary, path: linkPath } }),
      { sourceEnv: f.sourceEnv },
    );
    assert.throws(
      () => linkAdapter.prepareLaunch(action, { prompt: promptOf(action) }),
      /binary-identity-drift/,
    );
    // A truncated/renamed copy of the pinned file has a different hash: refused, never substituted.
    const copyPath = join(f.artifactRoot, "claude-truncated-copy");
    writeFileSync(copyPath, readFileSync(f.binary.path).subarray(0, 4096));
    chmodSync(copyPath, 0o755);
    const copyAdapter = new ClaudeCodeAdapter(
      f.store,
      f.lease,
      baseConfig(f, { binary: { ...f.binary, path: copyPath } }),
      { sourceEnv: f.sourceEnv },
    );
    assert.throws(
      () => copyAdapter.prepareLaunch(action, { prompt: promptOf(action) }),
      /binary-identity-drift/,
    );
    // A missing binary makes the profile unavailable, never substituted.
    const missingAdapter = new ClaudeCodeAdapter(
      f.store,
      f.lease,
      baseConfig(f, {
        binary: { ...f.binary, path: join(f.artifactRoot, "absent") },
      }),
      { sourceEnv: f.sourceEnv },
    );
    assert.throws(
      () => missingAdapter.prepareLaunch(action, { prompt: promptOf(action) }),
      /binary-identity-missing/,
    );
    // One-byte drift of a same-named candidate file: hash mismatch refuses.
    const driftedPath = join(f.artifactRoot, "claude-drifted");
    writeFileSync(
      driftedPath,
      Buffer.concat([readFileSync(f.binary.path), Buffer.from("\n")]),
    );
    chmodSync(driftedPath, 0o755);
    const driftedAdapter = new ClaudeCodeAdapter(
      f.store,
      f.lease,
      baseConfig(f, { binary: { ...f.binary, path: driftedPath } }),
      { sourceEnv: f.sourceEnv },
    );
    assert.throws(
      () => driftedAdapter.prepareLaunch(action, { prompt: promptOf(action) }),
      /binary-identity-drift/,
    );
    // Version pin: any config claiming a different candidate version is refused outright.
    assert.throws(
      () =>
        validateClaudeCodeConfig(
          baseConfig(f, { binary: { ...f.binary, version: "2.1.236" } }),
        ),
      /claude-version-unavailable/,
    );
    // Off-table effort and mismatched qualification/contract identities fail config validation.
    assert.throws(
      () =>
        validateClaudeCodeConfig(
          baseConfig(f, {
            roles: {
              implementer: { model: TEST_MODEL, effort: "ultracode-x" },
              reviewer: { model: TEST_MODEL, effort: "high" },
            },
          }),
        ),
      /invalid-claude-effort/,
    );
    assert.throws(
      () =>
        validateClaudeCodeConfig(
          baseConfig(f, {
            qualification: { ...qualification, harness: "codex" },
          }),
        ),
      /invalid-claude-qualification/,
    );
    assert.throws(
      () =>
        validateClaudeCodeConfig(
          baseConfig(f, {
            contract: { ...contractBinding(), contractId: "other" },
          }),
        ),
      /invalid-claude-contract-id/,
    );
    // Zero spawn and zero per-action RUN trees for every refused prepare above.
    assert.deepEqual(readdirSync(f.runsRoot), []);
  } finally {
    f.store.close();
  }
});

test("X02 argv serializer: exact one-element --opt=value template, role rosters, never-pass and variadic-swallow rejection (CC03/F02/F03)", () => {
  const f = claudeFixture("X02");
  try {
    const { plan } = prepared(f);
    const input = argvInput(f, plan);
    // The composed argv is exactly the pinned template output: every option is one element in
    // --opt=value form, in order, with no positional prompt anywhere.
    assert.deepEqual(plan.bundle.argv, buildClaudeArgv(input));
    const argv = plan.bundle.argv;
    assert.equal(argv[0], "-p");
    for (const element of [
      "--output-format=stream-json",
      "--verbose",
      "--input-format=text",
      "--no-session-persistence",
      "--setting-sources=",
      "--strict-mcp-config",
      "--disable-slash-commands",
      "--permission-mode=dontAsk",
      "--permission-prompts=none",
      `--model=${TEST_MODEL}`,
      "--effort=high",
      `--max-turns=${f.config.limits.maxTurns}`,
      `--tools=${CLAUDE_ROLE_TOOLS.implementer.join(",")}`,
      `--allowedTools=${CLAUDE_ROLE_TOOLS.implementer.join(",")}`,
      `--disallowedTools=${CLAUDE_DISALLOWED_TOOLS.join(",")}`,
    ])
      assert.ok(argv.includes(element), `missing element ${element}`);
    assert.equal(
      argv.indexOf("--setting-sources=") + 1,
      argv.findIndex((a) => a.startsWith("--settings=")),
    );
    for (const element of argv)
      assert.equal(
        element === "-p" || element === "--verbose" || element.startsWith("--"),
        true,
        `positional-or-bad-element:${element}`,
      );
    assert.ok(!argv.includes("--restricted"));
    // The inline --json-schema element is canonical minified JSON (the request schema).
    const schemaText = argv
      .find((a) => a.startsWith("--json-schema="))
      .slice("--json-schema=".length);
    assert.equal(canonical(JSON.parse(schemaText)), schemaText);
    assert.equal(schemaText, f.adapter.config.requestSchemaCanonical);
    // Variadic swallow: a would-be positional after --tools must never become a tool.
    const swallow = [...argv];
    swallow.splice(
      swallow.indexOf(`--tools=${CLAUDE_ROLE_TOOLS.implementer.join(",")}`) + 1,
      0,
      "EvilTool",
    );
    assert.throws(
      () => assertClaudeArgv(swallow, input),
      /claude-argv-positional/,
    );
    // Every never-pass flag rejects pre-spawn.
    for (const flag of [
      "--bare",
      "--safe-mode",
      "--dangerously-skip-permissions",
      "--allow-dangerously-skip-permissions",
      "--permission-prompt-tool=x",
      "--mcp-config=/tmp/x.json",
      "--plugin-dir=/tmp",
      "--plugin-dir-no-mcp=/tmp",
      "--plugin-url=http://x",
      "--agents=x",
      "--agent=x",
      "--add-dir=/tmp",
      "--continue",
      "--resume=x",
      "--fork-session",
      "--session-id=x",
      "--from-pr=1",
      "--fallback-model=x",
      "--max-budget-usd=5",
      "--managed-settings=/tmp/x",
      "--system-prompt=x",
      "--system-prompt-file=/tmp/x",
      "--debug",
      "-d",
      "--debug-file=/tmp/x",
      "--await-done",
      "--betas=x",
      "--include-partial-messages",
      "--include-hook-events",
      "--replay-user-messages",
      "--project-config-root=/tmp",
      "--client-data-url=x",
      "--worktree",
      "--tmux",
      "--ide",
      "--chrome",
    ])
      assert.throws(
        () => assertClaudeArgv([...argv, flag], input),
        /claude-forbidden-flag/,
        `never-pass accepted:${flag}`,
      );
    // Tampered pinned values reject.
    const tamper = (flag, value) =>
      argv.map((a) => (a.startsWith(`${flag}=`) ? `${flag}=${value}` : a));
    assert.throws(
      () =>
        assertClaudeArgv(
          tamper("--permission-mode", "bypassPermissions"),
          input,
        ),
      /claude-permission-mode/,
    );
    assert.throws(
      () => assertClaudeArgv(tamper("--permission-mode", "acceptEdits"), input),
      /claude-permission-mode/,
    );
    assert.throws(
      () => assertClaudeArgv(tamper("--effort", "ultra"), input),
      /claude-effort-off-table/,
    );
    assert.throws(
      () =>
        assertClaudeArgv(tamper("--setting-sources", "user,project"), input),
      /claude-setting-sources/,
    );
    assert.throws(
      () => assertClaudeArgv(tamper("--tools", "Bash,Read,Evil"), input),
      /claude-tools-roster/,
    );
    assert.throws(
      () => assertClaudeArgv(tamper("--model", "other-model"), input),
      /claude-model/,
    );
    assert.throws(
      () => assertClaudeArgv(tamper("--output-format", "json"), input),
      /claude-output-format/,
    );
    // An unknown flag is rejected as loudly as a forbidden one.
    assert.throws(
      () => assertClaudeArgv([...argv, "--surprise=1"], input),
      /claude-unknown-flag/,
    );
    // Reviewer role: read-only roster plus --restricted, never --add-dir, no shell-family tools.
    const reviewerArgv = buildClaudeArgv({ ...input, role: "reviewer" });
    assert.ok(reviewerArgv.includes("--restricted"));
    assert.ok(
      reviewerArgv.includes(`--tools=${CLAUDE_ROLE_TOOLS.reviewer.join(",")}`),
    );
    const reviewerTools = reviewerArgv
      .find((a) => a.startsWith("--tools="))
      .slice("--tools=".length)
      .split(",");
    for (const forbidden of ["Bash", "Edit", "Write"])
      assert.ok(!reviewerTools.includes(forbidden));
    assert.throws(
      () =>
        assertClaudeArgv([...reviewerArgv, "--add-dir=/tmp"], {
          ...input,
          role: "reviewer",
        }),
      /claude-forbidden-flag/,
    );
    assert.throws(
      () =>
        assertClaudeArgv(
          reviewerArgv.map((a) =>
            a.startsWith("--tools=") ? "--tools=Bash,Read,Glob,Grep" : a,
          ),
          { ...input, role: "reviewer" },
        ),
      /claude-tools-roster/,
    );
    // An implementer argv must never carry --restricted and vice versa.
    assert.throws(
      () => assertClaudeArgv([...argv, "--restricted"], input),
      /claude-implementer-restricted/,
    );
    assert.throws(
      () =>
        assertClaudeArgv(
          reviewerArgv.filter((a) => a !== "--restricted"),
          { ...input, role: "reviewer" },
        ),
      /claude-reviewer-restricted/,
    );
  } finally {
    f.store.close();
  }
});

test("X03 settings serializer: canonical round-trip, duplicate-key rejection and every prohibited key refused (CC04/F02)", () => {
  const f = claudeFixture("X03");
  try {
    const { plan } = prepared(f);
    const settingsFile = plan.bundle.files.find(
      (x) => x.name === "settings.json",
    );
    const rendered = readFileSync(settingsFile.path, "utf8");
    // The rendered template passes the producer audit and is hash-bound in the bundle.
    validateClaudeSettingsBytes(Buffer.from(rendered, "utf8"), {
      maxSettingsBytes: f.config.limits.maxSettingsBytes,
    });
    assert.equal(sha(Buffer.from(rendered, "utf8")), settingsFile.sha256);
    assert.equal(rendered.length, settingsFile.bytes);
    const parsed = JSON.parse(rendered);
    assert.equal(parsed.disableAllHooks, true);
    assert.equal(parsed.autoMemoryEnabled, false);
    assert.equal(parsed.disableClaudeAiConnectors, true);
    assert.equal(parsed.enableAllProjectMcpServers, false);
    assert.equal(parsed.sandbox.enabled, true);
    assert.equal(parsed.sandbox.failIfUnavailable, true);
    assert.equal(parsed.sandbox.allowUnsandboxedCommands, false);
    assert.equal(parsed.sandbox.autoAllowBashIfSandboxed, true);
    assert.equal(parsed.sandbox.network.strictAllowlist, true);
    assert.deepEqual(parsed.sandbox.network.allowedDomains, []);
    assert.deepEqual(parsed.permissions.allow, []);
    assert.deepEqual(parsed.permissions.additionalDirectories, []);
    assert.equal(parsed.permissions.defaultMode, "dontAsk");
    assert.equal(parsed.permissions.disableBypassPermissionsMode, "disable");
    assert.equal(parsed.permissions.blockReadsOutsideWorkingDirectories, true);
    assert.deepEqual(parsed.sandbox.credentials.files, [
      { path: f.configDir, mode: "deny" },
    ]);
    assert.deepEqual(parsed.sandbox.filesystem.allowWrite, [
      plan.paths.scratch,
    ]);
    for (const denied of [
      f.configDir,
      plan.paths.parentHome,
      plan.paths.parentTmp,
      plan.paths.inputs,
      join(f.config.hostIdentity.userHome, ".claude"),
      "/Library/Keychains",
      f.denyRoot,
    ])
      assert.ok(
        parsed.sandbox.filesystem.denyRead.includes(denied),
        `missing denyRead ${denied}`,
      );
    // The INP file is 0400 and its bytes are exactly the audited canonical rendering.
    assert.equal(
      readFileSync(settingsFile.path, "utf8"),
      renderClaudeSettings({
        configDir: f.configDir,
        parentHome: plan.paths.parentHome,
        parentTmp: plan.paths.parentTmp,
        inputs: plan.paths.inputs,
        scratch: plan.paths.scratch,
        userHome: f.config.hostIdentity.userHome,
        denyRoots: f.config.denyRoots,
      }),
    );
    const audit = (text, pattern = /claude-settings/) =>
      assert.throws(
        () =>
          validateClaudeSettingsBytes(Buffer.from(text, "utf8"), {
            maxSettingsBytes: 65536,
          }),
        pattern,
      );
    // Duplicate keys reject through the strict parser.
    audit('{"disableAllHooks":true,"disableAllHooks":false}');
    // Non-canonical bytes reject (whitespace injection into the rendered template).
    audit(rendered.replace(':"', ': "'), /claude-settings-not-canonical/);
    // Every prohibited key rejects, at top level and nested.
    const prohibited = [
      { env: { ANTHROPIC_API_KEY: "x" } },
      { apiKeyHelper: "/bin/echo" },
      { awsAuthRefresh: "/bin/echo" },
      { otelHeadersHelper: "/bin/echo" },
      { hooks: {} },
      { enabledPlugins: {} },
      { extraKnownMarketplaces: [] },
      { mcpServers: {} },
      { allowedMcpServers: [] },
      { forceLoginMethod: "claudeai" },
      { model: "other" },
      { availableModels: [] },
      { modelOverrides: {} },
      { fallbackModel: "other" },
      { pluginConfigs: {} },
      { statusLine: {} },
      { outputStyle: "x" },
      { allowAppleEvents: true },
      { allowUnixSockets: true },
      { enableWeakerNestedSandbox: true },
    ];
    for (const extra of prohibited) {
      const text = canonical({ ...JSON.parse(rendered), ...extra });
      audit(text, /claude-settings-prohibited/);
    }
    const nested = (mutate) => {
      const value = JSON.parse(rendered);
      mutate(value);
      return canonical(value);
    };
    audit(
      nested((v) => {
        v.sandbox.filesystem.disabled = true;
      }),
      /claude-settings-prohibited/,
    );
    audit(
      nested((v) => {
        v.sandbox.network.tlsTerminate = true;
      }),
      /claude-settings-prohibited/,
    );
    // permissions.allow beyond the (empty) role table rejects; weakened sandbox switches reject.
    audit(
      nested((v) => {
        v.permissions.allow = ["Bash(ls:*)"];
      }),
      /claude-settings-permissions/,
    );
    audit(
      nested((v) => {
        v.sandbox.failIfUnavailable = false;
      }),
      /claude-settings-sandbox/,
    );
    audit(
      nested((v) => {
        v.permissions.defaultMode = "bypassPermissions";
      }),
      /claude-settings-permissions/,
    );
    audit(
      nested((v) => {
        v.disableAllHooks = false;
      }),
      /claude-settings-switches/,
    );
    // Renderer path rules: relative, ~, glob-metachar and comma paths reject.
    for (const bad of [
      "relative/path",
      "~/home",
      "/glob/*/path",
      "/comma,path",
    ])
      assert.throws(
        () =>
          renderClaudeSettings({
            configDir: bad,
            parentHome: join(f.dir, "ph"),
            parentTmp: join(f.dir, "pt"),
            inputs: join(f.dir, "inp"),
            scratch: join(f.dir, "scr"),
            userHome: f.config.hostIdentity.userHome,
            denyRoots: [],
          }),
        /claude-settings-path/,
        `path admitted:${bad}`,
      );
    // Oversize settings bytes reject.
    assert.throws(
      () =>
        validateClaudeSettingsBytes(Buffer.from(rendered, "utf8"), {
          maxSettingsBytes: 128,
        }),
      /claude-settings-size/,
    );
  } finally {
    f.store.close();
  }
});

test("X04 sealed environment: exact ordered allowlist is the complete child env; poisoned source env refuses pre-spawn (CC02/F03)", async () => {
  const f = claudeFixture("X04");
  try {
    const action = implementAction(f);
    const proposal = finalProposal(action, "implementer");
    const { plan, pending } = dispatchClaude(
      f,
      action,
      successScript(proposal, {
        writeSrc: { path: "sealed.txt", content: "x\n" },
      }),
    );
    // The bundle env is the exact ordered allowlist: identity prefix then the fixed switches.
    assert.deepEqual(
      plan.bundle.env.slice(0, 6).map(([key]) => key),
      [
        "HOME",
        "CLAUDE_CONFIG_DIR",
        "PATH",
        "LANG",
        "TMPDIR",
        "CLAUDE_CODE_TMPDIR",
      ],
    );
    const envMap = Object.fromEntries(plan.bundle.env);
    assert.equal(envMap.HOME, plan.paths.parentHome);
    assert.equal(envMap.CLAUDE_CONFIG_DIR, f.configDir);
    assert.equal(envMap.PATH, "/usr/bin:/bin:/usr/sbin:/sbin");
    assert.equal(envMap.LANG, "en_US.UTF-8");
    assert.equal(envMap.TMPDIR, plan.paths.parentTmp);
    assert.equal(envMap.CLAUDE_CODE_TMPDIR, plan.paths.parentTmp);
    for (const [key, value] of [
      ["DISABLE_AUTOUPDATER", "1"],
      ["DISABLE_UPDATES", "1"],
      ["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1"],
      ["DISABLE_TELEMETRY", "1"],
      ["DISABLE_ERROR_REPORTING", "1"],
      ["CLAUDE_CODE_DISABLE_AUTO_MEMORY", "1"],
      ["CLAUDE_CODE_DISABLE_CLAUDE_MDS", "1"],
      ["CLAUDE_CODE_DISABLE_BUNDLED_SKILLS", "1"],
      ["CLAUDE_CODE_DISABLE_POLICY_SKILLS", "1"],
      ["CLAUDE_CODE_DISABLE_BACKGROUND_TASKS", "1"],
      ["CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING", "1"],
      ["CLAUDE_CODE_SKIP_PROMPT_HISTORY", "1"],
      ["CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS", "1"],
      ["CLAUDE_CODE_STARTUP_FAILURE_RESULTS", "1"],
    ])
      assert.equal(envMap[key], value, `switch ${key}`);
    assert.equal(plan.bundle.env.length, 20);
    const s = await settleClaude(f, action, pending);
    assert.equal(s.blocker, null);
    assert.equal(s.stage, "verifying");
    // The REAL child observed exactly the sealed allowlist at exec: same key/value set, nothing
    // inherited — no ambient SSH_AUTH_SOCK/ANTHROPIC_*/GIT_* from the actual test process env.
    // The only tolerated extra is darwin's __CF_USER_TEXT_ENCODING, which CoreFoundation derives
    // from the uid INSIDE the child after exec; it is a child-runtime artifact, never a parent
    // leak, and is recorded honestly here instead of being silently accepted.
    const record = fakeRecord(plan);
    const sealedKeys = plan.bundle.env.map(([key]) => key);
    const extraKeys = Object.keys(record.env).filter(
      (key) => !sealedKeys.includes(key),
    );
    assert.ok(
      extraKeys.every(
        (key) =>
          key === "__CF_USER_TEXT_ENCODING" && process.platform === "darwin",
      ),
      `unexpected child env keys: ${extraKeys.join(",")}`,
    );
    assert.equal(
      JSON.stringify(
        Object.entries(record.env)
          .filter(([key]) => sealedKeys.includes(key))
          .sort(),
      ),
      JSON.stringify([...plan.bundle.env].map(([k, v]) => [k, v]).sort()),
    );
    assert.equal(record.env.SSH_AUTH_SOCK, undefined);
    assert.equal(record.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(record.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.equal(record.env.GIT_DIR, undefined);
    assert.equal(record.cwd, plan.bundle.cwd);
    // Poisoned source env: every forbidden key family refuses the launch pre-spawn, zero spawn.
    const forbiddenSamples = [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_PROFILE",
      "CLAUDE_SECURESTORAGE_CONFIG_DIR",
      "CLAUDE_CODE_MANAGED_SETTINGS_PATH",
      "CLAUDE_CODE_SIMPLE",
      "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB",
      "CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR",
      "CLAUDE_CODE_SESSION_ACCESS_TOKEN",
      "SSH_AUTH_SOCK",
      "GIT_AUTHOR_NAME",
      "GITHUB_TOKEN",
      "HTTPS_PROXY",
      "NO_PROXY",
      "OPENAI_API_KEY",
      "CODEX_HOME",
      "MCP_TOKEN",
      "OTEL_EXPORTER_OTLP_ENDPOINT",
      "NODE_EXTRA_CA_CERTS",
      "AWS_ACCESS_KEY_ID",
      "SSL_CERT_FILE",
      "AZURE_TENANT_ID",
    ];
    for (const key of forbiddenSamples) {
      const poisoned = new ClaudeCodeAdapter(f.store, f.lease, f.config, {
        sourceEnv: { ...f.sourceEnv, [key]: "poison-value" },
      });
      assert.throws(
        () => poisoned.prepareLaunch(action, { prompt: promptOf(action) }),
        new RegExp(`claude-forbidden-env-present:.*${key}`),
        `poisoned key admitted:${key}`,
      );
    }
    // Conditional entries stay probe-gated and are the ONLY additions when enabled.
    const sealedWithUser = coordinatorModule.buildClaudeSealedEnv(
      {
        parentHome: plan.paths.parentHome,
        configDir: f.configDir,
        parentTmp: plan.paths.parentTmp,
      },
      { shell: true, user: true, userName: "fake-test-user" },
    );
    assert.deepEqual(sealedWithUser.slice(-3), [
      ["SHELL", "/bin/zsh"],
      ["USER", "fake-test-user"],
      ["LOGNAME", "fake-test-user"],
    ]);
    assert.equal(sealedWithUser.length, 23);
  } finally {
    f.store.close();
  }
});

test("X05 prompt input rules: BOM/invalid-UTF-8/empty/whitespace/over-limit reject pre-spawn with zero run tree (CC05/F04)", () => {
  const f = claudeFixture("X05");
  try {
    const action = implementAction(f);
    const attempts = [
      ["", /prompt-empty/],
      ["   \n\t ", /prompt-whitespace-only/],
      ["\uFEFF{} script", /prompt-bom/],
      [Buffer.from([0xff, 0xfe, 0x41]), /prompt-invalid-utf8/],
      ["\uD800 lone surrogate", /prompt-invalid-utf8/],
      ["x".repeat(70000), /prompt-over-limit/],
    ];
    for (const [prompt, pattern] of attempts)
      assert.throws(() => f.adapter.prepareLaunch(action, { prompt }), pattern);
    // Zero spawn and zero per-action run trees for every rejection.
    assert.deepEqual(readdirSync(f.runsRoot), []);
    // A deadline that cannot reserve cleanup time refuses pre-spawn.
    const tight = claudeFixture("X05-tight", { actionElapsedMs: 400 });
    try {
      const tightAction = implementAction(tight);
      assert.throws(
        () =>
          tight.adapter.prepareLaunch(tightAction, {
            prompt: promptOf(tightAction),
          }),
        /claude-deadline-insufficient/,
      );
    } finally {
      tight.store.close();
    }
  } finally {
    f.store.close();
  }
});

test("X06 discovery sealing: managed/MDM/server-managed presence, configDir children and instruction files refuse pre-spawn (CC04/F13-pre)", () => {
  const f = claudeFixture("X06");
  try {
    const action = implementAction(f);
    const expectRefusal = (mutate, pattern, cleanup) => {
      mutate();
      assert.throws(
        () => f.adapter.prepareLaunch(action, { prompt: promptOf(action) }),
        pattern,
      );
      cleanup();
    };
    const managedFile = join(f.discoveryRoot, "managed-settings.json");
    expectRefusal(
      () => writeFileSync(managedFile, "{}"),
      /claude-managed-layer-present/,
      () => unlinkSync(managedFile),
    );
    const managedDir = join(f.discoveryRoot, "managed-settings.d");
    expectRefusal(
      () => {
        mkdirSync(managedDir);
        writeFileSync(join(managedDir, "a.json"), "{}");
      },
      /claude-managed-layer-present/,
      () => rmSync(managedDir, { recursive: true, force: true }),
    );
    const mdm = join(f.discoveryRoot, "com.anthropic.claudecode.plist");
    expectRefusal(
      () => writeFileSync(mdm, "<plist/>"),
      /claude-mdm-layer-present/,
      () => unlinkSync(mdm),
    );
    const remote = join(f.configDir, "remote-settings.json");
    expectRefusal(
      () => writeFileSync(remote, "{}"),
      /claude-server-managed-present/,
      () => unlinkSync(remote),
    );
    const cfgSettings = join(f.configDir, "settings.json");
    expectRefusal(
      () => writeFileSync(cfgSettings, "{}"),
      /claude-config-dir-forbidden/,
      () => unlinkSync(cfgSettings),
    );
    // Instruction files in the staged tree refuse (planted through the host staging hook).
    assert.throws(
      () =>
        f.adapter.prepareLaunch(action, {
          prompt: promptOf(action),
          stage: (src) => writeFileSync(join(src, "CLAUDE.md"), "hostile"),
        }),
      /claude-instruction-files-present/,
    );
    assert.throws(
      () =>
        f.adapter.prepareLaunch(action, {
          prompt: promptOf(action),
          stage: (src) => mkdirSync(join(src, ".claude")),
        }),
      /claude-instruction-files-present/,
    );
    assert.throws(
      () =>
        f.adapter.prepareLaunch(action, {
          prompt: promptOf(action),
          stage: (src) => writeFileSync(join(src, ".mcp.json"), "{}"),
        }),
      /claude-instruction-files-present/,
    );
    // Ancestor instruction files and .git refuse.
    const ancestor = join(f.runsRoot, "AGENTS.md");
    expectRefusal(
      () => writeFileSync(ancestor, "hostile"),
      /claude-instruction-files-present/,
      () => unlinkSync(ancestor),
    );
    const gitDir = join(f.runsRoot, ".git");
    expectRefusal(
      () => mkdirSync(gitDir),
      /claude-instruction-files-present/,
      () => rmSync(gitDir, { recursive: true, force: true }),
    );
    // A missing dedicated config dir makes the profile unavailable (dedicated mode H1 only).
    const noCfg = claudeFixture("X06-nocfg");
    try {
      rmSync(noCfg.configDir, { recursive: true, force: true });
      const noCfgAction = implementAction(noCfg);
      assert.throws(
        () =>
          noCfg.adapter.prepareLaunch(noCfgAction, {
            prompt: promptOf(noCfgAction),
          }),
        /claude-config-dir/,
      );
    } finally {
      noCfg.store.close();
    }
    // Zero spawn everywhere: refused prepares never rendered INP files.
    for (const entry of readdirSync(f.runsRoot))
      assert.equal(
        existsSync(join(f.runsRoot, entry, "inputs", "settings.json")),
        false,
      );
  } finally {
    f.store.close();
  }
});

test("X07 agent-work-only, subscription-mode-only, prepare-before-begin and transport version binding (CC12)", async () => {
  const f = claudeFixture("X07");
  try {
    // Local (non-agent) work never launches this harness.
    const local = schedule(f, "baseline");
    assert.throws(
      () => f.adapter.prepareLaunch(local, { prompt: promptOf(local) }),
      /claude-agent-work-only/,
    );
    finish(f, { usage: localUsage() });
    registerReceipt(f, "baseline");
    // Strict-mode (schema 1) actions are refused: subscription-observed-v1 only.
    const action = schedule(f, "implement");
    const strictAction = { ...action, schema: 1, capabilityId: null };
    delete strictAction.budgetMode;
    delete strictAction.qualificationId;
    assert.throws(
      () => f.adapter.prepareLaunch(strictAction, { prompt: "x" }),
      /claude-subscription-mode-required/,
    );
    // A mismatched qualification identity refuses.
    assert.throws(
      () =>
        f.adapter.prepareLaunch(
          { ...action, qualificationId: "other-qualification" },
          { prompt: promptOf(action) },
        ),
      /claude-qualification-mismatch/,
    );
    // Begin without prepare refuses; a changed action refuses.
    assert.throws(() => f.adapter.begin(action), /claude-launch-not-prepared/);
    f.adapter.prepareLaunch(action, { prompt: promptOf(action) });
    assert.throws(
      () => f.adapter.begin({ ...action, inputDigest: "f".repeat(64) }),
      /claude-launch-not-prepared|claude-action-mismatch/,
    );
    // Transport versions must equal the run versions at dispatch.
    const mismatched = new ClaudeCodeAdapter(
      f.store,
      f.lease,
      baseConfig(f, { versions: { ...versions, build: "other-build" } }),
      { sourceEnv: f.sourceEnv },
    );
    await assert.rejects(
      f.store.dispatchCoordinator(f.lease, action.key, mismatched),
      /incompatible-transport-versions/,
    );
    assert.equal(f.store.commands(f.lease.runId).length, 0);
  } finally {
    f.store.close();
  }
});

test("X08 C1 bundle-drift rechecks yield zero spawn: settings, instructions, argv, staged tree and discovery drift between C0 and begin (CC12/F01)", async () => {
  const cases = [
    [
      "settings",
      (f, plan) => {
        const settings = plan.bundle.files.find(
          (x) => x.name === "settings.json",
        );
        chmodSync(settings.path, 0o600);
        writeFileSync(settings.path, `${readFileSync(settings.path, "utf8")} `);
      },
      /claude-bundle-drift:settings.json/,
    ],
    [
      "instructions",
      (f, plan) => {
        const instructions = plan.bundle.files.find(
          (x) => x.name === "instructions.md",
        );
        chmodSync(instructions.path, 0o600);
        writeFileSync(instructions.path, "drifted instructions");
      },
      /claude-bundle-drift:instructions.md/,
    ],
    [
      "argv",
      (f, plan) => {
        plan.spec.args = [...plan.spec.args, "--bare"];
      },
      /claude-bundle-drift:argv/,
    ],
    [
      "staged-tree",
      (f, plan) => {
        writeFileSync(join(plan.paths.src, "staged-drift.txt"), "x");
      },
      /claude-bundle-drift:staged-tree/,
    ],
    [
      "discovery",
      (f) => {
        writeFileSync(join(f.configDir, "drift-note.txt"), "x");
      },
      /claude-bundle-drift:discovery/,
    ],
  ];
  for (const [name, mutate, pattern] of cases) {
    const f = claudeFixture(`X08-${name}`);
    try {
      const action = implementAction(f);
      const plan = f.adapter.prepareLaunch(action, {
        prompt: promptOf(action),
      });
      mutate(f, plan);
      await assert.rejects(
        f.store.dispatchCoordinator(f.lease, action.key, f.adapter),
        pattern,
      );
      // Zero spawn: the fake never recorded a launch and no command row exists.
      assert.equal(
        existsSync(join(plan.paths.parentTmp, "fake-record.json")),
        false,
      );
      assert.equal(f.store.commands(f.lease.runId).length, 0);
      // The effect stays in sending (no blind retry) and the slot stays fenced.
      assert.equal(f.store.effect(action.key).state, "sending");
      assert.ok(f.store.implementationSlot());
    } finally {
      f.store.close();
    }
  }
});

test("X09 gate C1 binary rehash: one-byte binary drift after prepare records the durable named refusal and never spawns (CC01/F01)", async () => {
  const f = claudeFixture("X09");
  try {
    const action = implementAction(f);
    const proposal = finalProposal(action, "implementer");
    const plan = f.adapter.prepareLaunch(action, {
      prompt: JSON.stringify(successScript(proposal)),
    });
    // One-byte drift of the pinned binary between C0 and the guarded spawn (C1).
    writeFileSync(
      f.binary.path,
      Buffer.concat([readFileSync(f.binary.path), Buffer.from("\n")]),
    );
    const pending = f.store.dispatchCoordinator(f.lease, action.key, f.adapter);
    const settled = await settleClaude(f, action, pending);
    // Zero spawn: the fake never ran.
    assert.equal(
      existsSync(join(plan.paths.parentTmp, "fake-record.json")),
      false,
    );
    const command = f.store.commands(f.lease.runId).at(-1);
    assert.equal(command.duplex.failure, "binary-identity-drift");
    assert.equal(command.result.outcome, "failed");
    const receiptJson = readReceipt(plan, command.id);
    assert.equal(receiptJson.settlement.classification, "fatal");
    assert.equal(
      receiptJson.settlement.detail,
      "claude-fatal:binary-identity-drift",
    );
    assert.equal(receiptJson.usage.status, "unknown");
    assert.equal(settled.blocker?.kind, "needs_engineering");
    assert.equal(settled.budgets.unknownActions, 1);
  } finally {
    f.store.close();
  }
});
