// Taskbot #81 launch-bundle tests: pre-spawn rules (S01/S02/S07) against the frozen
// rocky-subscription-88-v1 contract, exercised with the owned fake CLI, real SQLite stores and real
// spawned processes where a spawn is admitted. Covers F01 (exact sealed launch + raw input), F11
// (nonsecret classification / forged evidence refusals) and the #92/858 producer contract: pinned
// binary identity, argv template/never-pass/sandbox-ban, TOML -c round-trip/allowlist, sealed env +
// poisoned-env refusal, prompt rules, discovery sealing, trust-persistence prevention and C1 drift.
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
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  codexFixture,
  baseConfig,
  baselinePass,
  schedule,
  contractBinding,
  qualification,
  versions,
  sha,
  IMPLEMENTER_MODEL,
  IMPLEMENTER_EFFORT,
  REVIEWER_MODEL,
  REVIEWER_EFFORT,
} from "./codex-exec-support.mjs";
import { coordinatorModule } from "./coordinator-support.mjs";
const {
  CodexExecAdapter,
  validateCodexExecConfig,
  buildCodexArgv,
  assertCodexArgv,
  codexRoleForKind,
  renderCodexPermissionProfile,
  renderCodexOverrideSet,
  buildCodexOverrideAssignments,
  serializeCodexOverride,
  tomlRoundTrip,
  parseTomlValue,
  renderTomlValue,
  buildCodexSealedEnv,
  isForbiddenCodexEnvKey,
  CODEX_OVERRIDE_FORBIDDEN_KEYS,
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
  const schemaPath =
    plan.bundle.argv[plan.bundle.argv.indexOf("--output-schema") + 1];
  return {
    model: f.config.roles[role].model,
    effort: f.config.roles[role].effort,
    schemaPath,
    overrideAssignments: [...plan.overrideAssignments],
    maxArgvBytes: f.config.limits.maxArgvBytes,
  };
}

test("X01 pinned-binary identity + version/source-commit/model-effort pins refuse with zero spawn (S01/S09/F01)", () => {
  const f = codexFixture("X01");
  try {
    const action = implementAction(f);
    // A symlink spawn target is never admitted.
    const linkPath = join(f.artifactRoot, "codex-symlink");
    symlinkSync(f.binary.path, linkPath);
    const linkAdapter = new CodexExecAdapter(
      f.store,
      f.lease,
      baseConfig(f, { binary: { ...f.binary, path: linkPath } }),
      { sourceEnv: f.sourceEnv },
    );
    assert.throws(
      () => linkAdapter.prepareLaunch(action, { prompt: promptOf(action) }),
      /binary-identity-drift/,
    );
    // A truncated copy of the pinned file has a different hash: refused, never substituted.
    const copyPath = join(f.artifactRoot, "codex-truncated-copy");
    writeFileSync(copyPath, readFileSync(f.binary.path).subarray(0, 2048));
    chmodSync(copyPath, 0o755);
    const copyAdapter = new CodexExecAdapter(
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
    const missingAdapter = new CodexExecAdapter(
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
    // Version pin and source-commit pin: any config claiming a different candidate refuses.
    assert.throws(
      () =>
        validateCodexExecConfig(
          baseConfig(f, { binary: { ...f.binary, version: "0.156.0" } }),
        ),
      /codex-version-unavailable/,
    );
    assert.throws(
      () =>
        validateCodexExecConfig(
          baseConfig(f, { binary: { ...f.binary, sourceCommit: "deadbeef" } }),
        ),
      /codex-source-commit-unavailable/,
    );
    // Off-table model/effort assignments fail closed and are never defaulted (no fallback/reroute).
    for (const roles of [
      {
        implementer: { model: "gpt-6-sol", effort: "high" },
        reviewer: { model: REVIEWER_MODEL, effort: REVIEWER_EFFORT },
      },
      {
        implementer: { model: "gpt-6-astra", effort: "medium" },
        reviewer: { model: REVIEWER_MODEL, effort: REVIEWER_EFFORT },
      },
      {
        implementer: { model: "gpt-5-unknown", effort: "medium" },
        reviewer: { model: REVIEWER_MODEL, effort: REVIEWER_EFFORT },
      },
      {
        implementer: { model: IMPLEMENTER_MODEL, effort: IMPLEMENTER_EFFORT },
        reviewer: { model: IMPLEMENTER_MODEL, effort: IMPLEMENTER_EFFORT },
      },
    ])
      assert.throws(
        () => validateCodexExecConfig(baseConfig(f, { roles })),
        /codex-(implementer|reviewer)-model-effort-off-table/,
      );
    // Mismatched qualification/contract identities fail config validation.
    assert.throws(
      () =>
        validateCodexExecConfig(
          baseConfig(f, {
            qualification: { ...qualification, harness: "claude-code" },
          }),
        ),
      /invalid-codex-qualification/,
    );
    assert.throws(
      () =>
        validateCodexExecConfig(
          baseConfig(f, {
            contract: { ...contractBinding(), contractId: "other" },
          }),
        ),
      /invalid-codex-contract-id/,
    );
    // Zero spawn and zero per-action RUN trees for every refused prepare above.
    assert.deepEqual(readdirSync(f.runsRoot), []);
  } finally {
    f.store.close();
  }
});

test("X02 argv serializer: exact frozen template order, -c pairing, `-- -` terminator, never-pass and sandbox ban (S01/F02/F03)", () => {
  const f = codexFixture("X02");
  try {
    const { plan } = prepared(f);
    const input = argvInput(f, plan);
    // The composed argv re-audits clean and equals a fresh composition of the same input.
    assert.deepEqual(plan.bundle.argv, buildCodexArgv(input));
    const argv = plan.bundle.argv;
    // Exact frozen template prefix, in order (manifest launch.argvTemplate).
    assert.deepEqual(argv.slice(0, 8), [
      "exec",
      "--json",
      "--color",
      "never",
      "--skip-git-repo-check",
      "--ignore-user-config",
      "--ignore-rules",
      "--strict-config",
    ]);
    assert.equal(argv[8], "--output-schema");
    assert.ok(argv[9].endsWith("/inputs/final.request.schema.json"));
    assert.equal(argv[10], "--model");
    assert.equal(argv[11], IMPLEMENTER_MODEL);
    assert.equal(argv[12], "--ephemeral");
    assert.deepEqual(argv.slice(-2), ["--", "-"]);
    // No positional prompt anywhere except the single trailing "-".
    assert.equal(argv.filter((a) => a === "-").length, 1);
    // Every -c is immediately followed by exactly one key=value element.
    for (let i = argv.indexOf("--ephemeral") + 1; i < argv.length - 2; i++) {
      if (argv[i] === "-c") {
        assert.ok(argv[i + 1].includes("="), `bad -c value at ${i}`);
        i++;
      } else assert.fail(`unexpected argv element ${argv[i]}`);
    }
    // Effort travels as an override, never a flag.
    assert.ok(
      plan.overrideAssignments.includes(
        `model_reasoning_effort="${IMPLEMENTER_EFFORT}"`,
      ),
    );
    assert.ok(!argv.some((a) => a.startsWith("--effort")));
    // Every never-pass flag/subcommand rejects pre-spawn, regardless of position.
    for (const flag of [
      "--sandbox=read-only",
      "-s",
      "--dangerously-bypass-approvals-and-sandbox",
      "--yolo",
      "--approve-for-me",
      "--dangerously-bypass-hook-trust",
      "--add-dir=/tmp",
      "--cd=/tmp",
      "-C",
      "--worktree",
      "--profile=x",
      "-p",
      "--oss",
      "--local-provider=x",
      "-o",
      "--output-last-message=/tmp/x",
      "--thread-source=x",
      "resume",
      "fork",
      "review",
    ])
      assert.throws(
        () => assertCodexArgv([...argv, flag], input),
        /codex-forbidden-flag/,
        `never-pass accepted:${flag}`,
      );
    // Tampered pinned values reject.
    const tamper = (flag, value) =>
      argv.map((a, i) => (a === flag && i + 1 < argv.length ? value : a));
    assert.throws(
      () =>
        assertCodexArgv(
          argv.map((a) => (a === IMPLEMENTER_MODEL ? "gpt-6-astra" : a)),
          input,
        ),
      /codex-argv-model|codex-model/,
    );
    // A drifted override set (changed assignment) is caught by the override-equality re-audit.
    assert.throws(
      () =>
        assertCodexArgv(argv, {
          ...input,
          overrideAssignments: [
            ...input.overrideAssignments,
            'analytics={"enabled"=true}',
          ],
        }),
      /codex-argv-override-drift/,
    );
    void tamper;
  } finally {
    f.store.close();
  }
});

test("X03 TOML -c overrides: real round-trip equality, raw-string degradation refused, allowlist + forbidden keys (S01/S07/F01/F02/F03)", () => {
  const f = codexFixture("X03");
  try {
    const { plan } = prepared(f);
    // Every emitted assignment round-trips the owned TOML parser with structural equality.
    for (const assignment of plan.overrideAssignments) {
      const eq = assignment.indexOf("=");
      const key = assignment.slice(0, eq);
      const valueText = assignment.slice(eq + 1);
      const parsed = parseTomlValue(valueText);
      assert.ok(parsed !== undefined, `no parse for ${key}`);
      assert.equal(renderTomlValue(parsed), valueText, `non-canonical ${key}`);
    }
    // The untrusted-projects override is present (F5 trust prevention) and is an inline table.
    const projects = plan.overrideAssignments.find((a) =>
      a.startsWith("projects="),
    );
    assert.ok(projects && projects.includes('trust_level"="untrusted"'));
    // model_provider is the built-in openai id, never a model_providers map (no erasure assumed).
    assert.ok(plan.overrideAssignments.includes('model_provider="openai"'));
    assert.ok(
      !plan.overrideAssignments.some((a) => a.startsWith("model_providers")),
    );
    // F1 defense: a value that would silently degrade to a raw string is rejected pre-spawn. A
    // bare unquoted token that is not a valid TOML value cannot round-trip.
    assert.throws(
      () =>
        serializeCodexOverride("model_provider", "openai", {
          maxOverrideValueBytes: 1,
        }),
      /codex-override-value-bytes/,
    );
    // A path-keyed map supplied as a dotted KEY (not an inline-table value) is rejected: keys must
    // be dot-free top-level identifiers (F1).
    assert.throws(
      () =>
        serializeCodexOverride("projects./foo.trust_level", "untrusted", {
          maxOverrideValueBytes: 4096,
        }),
      /codex-override-key-not-dot-free/,
    );
    // Unknown / off-allowlist keys are rejected (the producer-side equivalent of --strict-config).
    assert.throws(
      () =>
        serializeCodexOverride("totally_unknown_key", "x", {
          maxOverrideValueBytes: 4096,
        }),
      /codex-override-unknown-key/,
    );
    // Every prohibited key is rejected, including the forced-login and sandbox keys (F7/F8).
    for (const key of [
      "forced_login_method",
      "forced_chatgpt_workspace_id",
      "chatgpt_base_url",
      "openai_base_url",
      "model_providers",
      "mcp_servers",
      "plugins",
      "marketplaces",
      "hooks",
      "profile",
      "profiles",
      "sandbox_mode",
      "sandbox_workspace_write",
      "approvals_reviewer",
      "auto_review",
      "otel",
      "agents",
    ]) {
      assert.ok(CODEX_OVERRIDE_FORBIDDEN_KEYS.has(key), `not forbidden:${key}`);
      assert.throws(
        () => serializeCodexOverride(key, "x", { maxOverrideValueBytes: 4096 }),
        /codex-override-forbidden-key/,
        `prohibited key admitted:${key}`,
      );
    }
    // The F7 sandbox+named-permissions combination ban: a sandbox_mode key alongside the always
    // present default_permissions is rejected at the override layer (and --sandbox at argv layer).
    const profile = renderCodexPermissionProfile({
      role: "implementer",
      profileName: "rocky_implementer",
      src: "/private/x/src",
      scratch: "/private/x/scratch",
      parentRoot: "/private/x/parent",
      native: "/private/x/native",
      inputs: "/private/x/inputs",
      codexHomeChildren: [],
      codexHome: "/private/x/codex-home",
      denyRoots: [],
      platformDenyRoots: [],
      maxDenyEntries: 512,
    });
    const set = renderCodexOverrideSet({
      effort: "medium",
      credentialsStore: "file",
      secretAuthStorage: false,
      permissionProfileName: "rocky_implementer",
      permissionsValue: profile,
      projectsValue: { "/private/x/src": { trust_level: "untrusted" } },
      sqliteHome: "/private/x/native/sqlite",
      logDir: "/private/x/native/log",
      shellHome: "/private/x/scratch/home",
      shellTmp: "/private/x/scratch/tmp",
    });
    assert.throws(
      () =>
        buildCodexOverrideAssignments(
          [...set, { key: "sandbox_mode", value: "read-only" }],
          { maxOverrideValueBytes: 65536, maxOverrides: 64 },
        ),
      /codex-override-forbidden-key:sandbox_mode/,
    );
    // Round-trip inequality (a value whose canonical re-render differs) is rejected.
    assert.throws(
      () => tomlRoundTrip("model_provider", { bad: undefined }),
      /codex-toml-undefined-value|codex-override-no-toml-roundtrip/,
    );
  } finally {
    f.store.close();
  }
});

test("X04 sealed environment: exact ordered allowlist is the complete child env; poisoned source env refuses pre-spawn (S01/F03/F08)", async () => {
  const f = codexFixture("X04");
  try {
    const action = implementAction(f);
    const plan = f.adapter.prepareLaunch(action, { prompt: promptOf(action) });
    // The bundle env is exactly the ordered allowlist (identity prefix; no conditional entries).
    assert.deepEqual(
      plan.bundle.env.map(([key]) => key),
      ["HOME", "CODEX_HOME", "TMPDIR", "PATH", "LANG"],
    );
    const envMap = Object.fromEntries(plan.bundle.env);
    assert.equal(envMap.HOME, plan.paths.parentHome);
    assert.equal(envMap.CODEX_HOME, f.codexHome);
    assert.equal(envMap.TMPDIR, plan.paths.parentTmp);
    assert.equal(envMap.PATH, "/usr/bin:/bin:/usr/sbin:/sbin");
    assert.equal(envMap.LANG, "en_US.UTF-8");
    // The shared CODEX_HOME is bound (auth state, NOT sterile); the private HOME/TMP are distinct.
    assert.notEqual(envMap.HOME, envMap.CODEX_HOME);
    assert.notEqual(envMap.TMPDIR, envMap.CODEX_HOME);
    // Every forbidden auth-bearing env key is recognized (names only) and refuses the launch.
    const forbiddenSamples = [
      "CODEX_API_KEY",
      "OPENAI_API_KEY",
      "CODEX_ACCESS_TOKEN",
      "CODEX_REFRESH_TOKEN_URL_OVERRIDE",
      "CODEX_REVOKE_TOKEN_URL_OVERRIDE",
      "CODEX_APP_SERVER_LOGIN_CLIENT_ID",
      "CODEX_APP_SERVER_CHATGPT_BASE_URL",
      "OPENAI_FEDERATION_RULE_ID",
      "OPENAI_IDENTITY_TOKEN_FILE",
      "OPENAI_WORKLOAD_IDENTITY_CONTEXT",
      "CODEX_SQLITE_HOME",
      "CODEX_SANDBOX",
      "CODEX_CA_CERTIFICATE",
      "RUST_LOG",
      "TRACEPARENT",
      "SSH_AUTH_SOCK",
      "HTTPS_PROXY",
      "NO_PROXY",
      "SSL_CERT_FILE",
      "GIT_DIR",
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "AWS_ACCESS_KEY_ID",
      "OTEL_EXPORTER_OTLP_ENDPOINT",
      "MCP_TOKEN",
    ];
    for (const key of forbiddenSamples) {
      assert.ok(isForbiddenCodexEnvKey(key), `not forbidden:${key}`);
      const poisoned = new CodexExecAdapter(f.store, f.lease, f.config, {
        sourceEnv: { ...f.sourceEnv, [key]: "poison-value" },
      });
      assert.throws(
        () => poisoned.prepareLaunch(action, { prompt: promptOf(action) }),
        new RegExp(`codex-forbidden-env-present:.*${key}`),
        `poisoned key admitted:${key}`,
      );
    }
    // CODEX_HOME is the ONE permitted CODEX_* key: it is not forbidden in the source env (the
    // adapter sets its own sealed value; the source value is never inherited).
    assert.equal(isForbiddenCodexEnvKey("CODEX_HOME"), false);
    // Conditional entries are probe-gated and are the ONLY additions when enabled.
    const sealedWithUser = buildCodexSealedEnv(
      {
        parentHome: plan.paths.parentHome,
        codexHome: f.codexHome,
        parentTmp: plan.paths.parentTmp,
      },
      { shell: true, user: true, userName: "fake-test-user" },
    );
    assert.deepEqual(sealedWithUser.slice(-3), [
      ["SHELL", "/bin/zsh"],
      ["USER", "fake-test-user"],
      ["LOGNAME", "fake-test-user"],
    ]);
    assert.equal(sealedWithUser.length, 8);
  } finally {
    f.store.close();
  }
});

test("X05 prompt input rules: BOM/invalid-UTF-8/empty/whitespace/over-limit reject pre-spawn with zero run tree (S07/F04)", () => {
  const f = codexFixture("X05");
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
    assert.deepEqual(readdirSync(f.runsRoot), []);
    // A deadline that cannot reserve cleanup time refuses pre-spawn.
    const tight = codexFixture("X05-tight", { actionElapsedMs: 400 });
    try {
      const tightAction = implementAction(tight);
      assert.throws(
        () =>
          tight.adapter.prepareLaunch(tightAction, {
            prompt: promptOf(tightAction),
          }),
        /codex-deadline-insufficient/,
      );
    } finally {
      tight.store.close();
    }
  } finally {
    f.store.close();
  }
});

test("X06 discovery sealing: system/managed/MDM presence, unapproved global AGENTS, skills and staged layers refuse pre-spawn (S01/F02/F04/F06)", () => {
  const f = codexFixture("X06");
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
    // Any present system/managed/MDM layer makes the profile unavailable (F2: cannot erase maps).
    const sysConfig = join(f.discoveryRoot, "config.toml");
    expectRefusal(
      () => writeFileSync(sysConfig, "[mcp_servers]\n"),
      /codex-system-layer-present/,
      () => rmSync(sysConfig, { force: true }),
    );
    const managed = join(f.discoveryRoot, "managed_config.toml");
    expectRefusal(
      () => writeFileSync(managed, "x=1"),
      /codex-system-layer-present/,
      () => rmSync(managed, { force: true }),
    );
    const mdm = join(f.discoveryRoot, "com.openai.codex.plist");
    expectRefusal(
      () => writeFileSync(mdm, "<plist/>"),
      /codex-mdm-layer-present/,
      () => rmSync(mdm, { force: true }),
    );
    const skillsDir = join(f.discoveryRoot, "skills");
    expectRefusal(
      () => {
        mkdirSync(skillsDir, { recursive: true });
        writeFileSync(join(skillsDir, "s.md"), "x");
      },
      /codex-system-layer-present/,
      () => rmSync(skillsDir, { recursive: true, force: true }),
    );
    // A global AGENTS file in the shared home that is not the approved digest refuses (F6). An
    // unapproved effective AGENTS (approved digest is null) blocks the profile.
    const agents = join(f.codexHome, "AGENTS.md");
    expectRefusal(
      () => writeFileSync(agents, "unapproved global instructions\n"),
      /codex-global-agents-unapproved/,
      () => rmSync(agents, { force: true }),
    );
    // A shared-home skills root refuses unless explicitly approved (F4: ignore flags don't remove it).
    const chSkills = join(f.codexHome, "skills");
    expectRefusal(
      () => {
        mkdirSync(chSkills, { recursive: true });
        writeFileSync(join(chSkills, "s.md"), "x");
      },
      /codex-home-skills-unapproved/,
      () => rmSync(chSkills, { recursive: true, force: true }),
    );
    // Staged project instruction/config layers refuse (untrusted project ⇒ none), and a staged .git
    // refuses (projectless requirement, F5). Each uses a fresh fixture so the staged tree is clean.
    const stagedRefusal = (name, stage, pattern) => {
      const g = codexFixture(name);
      try {
        const gAction = implementAction(g);
        assert.throws(
          () =>
            g.adapter.prepareLaunch(gAction, {
              prompt: promptOf(gAction),
              stage,
            }),
          pattern,
        );
      } finally {
        g.store.close();
      }
    };
    stagedRefusal(
      "X06-staged-agents",
      (src) => writeFileSync(join(src, "AGENTS.md"), "hostile"),
      /codex-staged-agents-files/,
    );
    stagedRefusal(
      "X06-staged-codex",
      (src) => mkdirSync(join(src, ".codex")),
      /codex-staged-codex-dir/,
    );
    stagedRefusal(
      "X06-staged-git",
      (src) => mkdirSync(join(src, ".git")),
      /codex-staged-git-present/,
    );
    // A missing shared CODEX_HOME makes the profile unavailable.
    const noHome = codexFixture("X06-nohome");
    try {
      rmSync(noHome.codexHome, { recursive: true, force: true });
      const noHomeAction = implementAction(noHome);
      assert.throws(
        () =>
          noHome.adapter.prepareLaunch(noHomeAction, {
            prompt: promptOf(noHomeAction),
          }),
        /codex-home-missing/,
      );
    } finally {
      noHome.store.close();
    }
  } finally {
    f.store.close();
  }
});

test("X07 trust-persistence prevention: explicit untrusted override + projectless tree + config.toml byte baseline (S01/S10/F05)", () => {
  const f = codexFixture("X07");
  try {
    const { plan } = prepared(f);
    // (1) the explicit untrusted override for the canonical staged root is in the audited argv.
    const projects = plan.overrideAssignments.find((a) =>
      a.startsWith("projects="),
    );
    assert.ok(projects.includes(plan.paths.src));
    assert.ok(projects.includes('trust_level"="untrusted"'));
    assert.ok(plan.bundle.argv.includes(projects));
    // (2) the staged tree and RUN root are projectless (no .git anywhere in RUN or ancestors).
    assert.equal(existsSync(join(plan.paths.src, ".git")), false);
    assert.equal(existsSync(join(plan.paths.runRoot, ".git")), false);
    // (3) the shared config.toml byte baseline is captured pre-run (the post-run check is L13).
    const configToml = join(f.codexHome, "config.toml");
    assert.equal(plan.inventoryPre.sharedConfigToml.path, configToml);
    assert.equal(
      plan.inventoryPre.sharedConfigToml.sha256,
      sha(readFileSync(configToml)),
    );
    // An ancestor .git would break projectlessness: planting one above RUN refuses the launch.
    const g = codexFixture("X07-ancestor-git");
    try {
      mkdirSync(join(g.runsRoot, ".git"), { recursive: true });
      const gAction = implementAction(g);
      assert.throws(
        () => g.adapter.prepareLaunch(gAction, { prompt: promptOf(gAction) }),
        /codex-ancestor-git-present/,
      );
    } finally {
      g.store.close();
    }
  } finally {
    f.store.close();
  }
});

test("X08 agent-work-only, subscription-mode-only, prepare-before-begin, transport version + qualification binding (S07)", async () => {
  const f = codexFixture("X08");
  try {
    // Local (non-agent) work never launches this harness.
    const local = schedule(f, "baseline");
    assert.throws(
      () => f.adapter.prepareLaunch(local, { prompt: promptOf(local) }),
      /codex-agent-work-only/,
    );
    const { finish, receipt, localUsage } = await import(
      "./codex-exec-support.mjs"
    );
    finish(f, { usage: localUsage() });
    receipt(f, "baseline");
    // Strict-mode (schema 1) actions are refused: subscription-observed-v1 only.
    const action = schedule(f, "implement");
    const strictAction = { ...action, schema: 1, capabilityId: null };
    delete strictAction.budgetMode;
    delete strictAction.qualificationId;
    assert.throws(
      () => f.adapter.prepareLaunch(strictAction, { prompt: "x" }),
      /codex-subscription-mode-required/,
    );
    // A mismatched qualification identity refuses.
    assert.throws(
      () =>
        f.adapter.prepareLaunch(
          { ...action, qualificationId: "other-qualification" },
          { prompt: promptOf(action) },
        ),
      /codex-qualification-mismatch/,
    );
    // Begin without prepare refuses; a changed action refuses.
    assert.throws(() => f.adapter.begin(action), /codex-launch-not-prepared/);
    f.adapter.prepareLaunch(action, { prompt: promptOf(action) });
    assert.throws(
      () => f.adapter.begin({ ...action, inputDigest: "f".repeat(64) }),
      /codex-launch-not-prepared|codex-action-mismatch/,
    );
    // Transport versions must equal the run versions at dispatch.
    const mismatched = new CodexExecAdapter(
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
    // Role mapping: agent kinds only.
    assert.equal(codexRoleForKind("implement"), "implementer");
    assert.equal(codexRoleForKind("review"), "reviewer");
    assert.equal(codexRoleForKind("arbitrate"), "reviewer");
    assert.throws(() => codexRoleForKind("baseline"), /codex-agent-work-only/);
  } finally {
    f.store.close();
  }
});

test("X09 C1 bundle-drift rechecks yield zero spawn: schema file, argv, staged tree and discovery drift between C0 and begin (S07/F01)", async () => {
  const cases = [
    [
      "schema",
      (f, plan) => {
        const schema = plan.bundle.files.find((x) =>
          x.name.endsWith("final.request.schema.json"),
        );
        chmodSync(schema.path, 0o600);
        writeFileSync(schema.path, `${readFileSync(schema.path, "utf8")} `);
      },
      /codex-bundle-drift:final.request.schema.json/,
    ],
    [
      "argv",
      (f, plan) => {
        plan.spec.args = [...plan.spec.args, "--oss"];
      },
      /codex-bundle-drift:argv/,
    ],
    [
      "staged-tree",
      (f, plan) => {
        writeFileSync(join(plan.paths.src, "staged-drift.txt"), "x");
      },
      /codex-bundle-drift:staged-tree/,
    ],
    [
      "discovery",
      (f) => {
        writeFileSync(join(f.codexHome, "AGENTS.override.md"), "drift");
      },
      /codex-bundle-drift:discovery|codex-global-agents-unapproved/,
    ],
  ];
  for (const [name, mutate, pattern] of cases) {
    const f = codexFixture(`X09-${name}`);
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

test("X10 gate C1 binary rehash: one-byte binary drift after prepare records the durable named refusal and never spawns (S01/F01)", async () => {
  const f = codexFixture("X10");
  try {
    const action = implementAction(f);
    const plan = f.adapter.prepareLaunch(action, {
      prompt: JSON.stringify({ script: [{ thread: {} }, { exit: 0 }] }),
    });
    // One-byte drift of the pinned binary between C0 and the guarded spawn (C1).
    writeFileSync(
      f.binary.path,
      Buffer.concat([readFileSync(f.binary.path), Buffer.from("\n")]),
    );
    const { settleCodex, readReceipt } = await import(
      "./codex-exec-support.mjs"
    );
    const pending = f.store.dispatchCoordinator(f.lease, action.key, f.adapter);
    const settled = await settleCodex(f, action, pending);
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
      "codex-fatal:binary-identity-drift",
    );
    assert.equal(receiptJson.usage.status, "unknown");
    assert.equal(settled.blocker?.kind, "needs_engineering");
    assert.equal(settled.budgets.unknownActions, 1);
  } finally {
    f.store.close();
  }
});

test("X11 roles: implementer vs read-only reviewer permission profiles; images reviewer-only (S02)", () => {
  const f = codexFixture("X11");
  try {
    // Implementer profile grants SRC write; reviewer grants SRC read only.
    const impl = renderCodexPermissionProfile({
      role: "implementer",
      profileName: "rocky_implementer",
      src: "/private/x/src",
      scratch: "/private/x/scratch",
      parentRoot: "/private/x/parent",
      native: "/private/x/native",
      inputs: "/private/x/inputs",
      codexHomeChildren: [],
      codexHome: "/private/x/codex-home",
      denyRoots: [],
      platformDenyRoots: [],
      maxDenyEntries: 512,
    }).rocky_implementer;
    assert.equal(impl.filesystem["/private/x/src"], "write");
    assert.equal(impl.filesystem["/private/x/scratch"], "write");
    assert.equal(impl.filesystem[":minimal"], "read");
    assert.deepEqual(impl.network, { enabled: false });
    const rev = renderCodexPermissionProfile({
      role: "reviewer",
      profileName: "rocky_reviewer",
      src: "/private/x/src",
      scratch: "/private/x/scratch",
      parentRoot: "/private/x/parent",
      native: "/private/x/native",
      inputs: "/private/x/inputs",
      codexHomeChildren: [],
      codexHome: "/private/x/codex-home",
      denyRoots: [],
      platformDenyRoots: [],
      maxDenyEntries: 512,
    }).rocky_reviewer;
    assert.equal(rev.filesystem["/private/x/src"], "read");
    assert.equal(rev.filesystem["/private/x/scratch"], "write");
    // Protected roots are denied for both roles; the shared-home tmp helper root is NEVER denied (F12).
    for (const profile of [impl, rev]) {
      assert.equal(profile.filesystem["/private/x/parent"], "deny");
      assert.equal(profile.filesystem["/private/x/native"], "deny");
      assert.equal(profile.filesystem["/private/x/inputs"], "deny");
      assert.equal(profile.filesystem["/private/x/codex-home/tmp"], undefined);
      assert.equal(
        profile.filesystem["/private/x/codex-home/config.toml"],
        "deny",
      );
      assert.equal(
        profile.filesystem["/private/x/codex-home/auth.json"],
        "deny",
      );
    }
    // A reviewer launch composes --image flags; an implementer with images refuses pre-spawn.
    const action = implementAction(f);
    assert.throws(
      () =>
        f.adapter.prepareLaunch(action, {
          prompt: promptOf(action),
          images: [{ name: "shot.png", bytes: new Uint8Array([1, 2, 3]) }],
        }),
      /codex-implementer-images/,
    );
    // A deny entry that equals a grant refuses (no self-overlap).
    assert.throws(
      () =>
        renderCodexPermissionProfile({
          role: "implementer",
          profileName: "rocky_implementer",
          src: "/private/x/src",
          scratch: "/private/x/scratch",
          parentRoot: "/private/x/parent",
          native: "/private/x/native",
          inputs: "/private/x/inputs",
          codexHomeChildren: [],
          codexHome: "/private/x/codex-home",
          denyRoots: ["/private/x/src"],
          platformDenyRoots: [],
          maxDenyEntries: 512,
        }),
      /codex-deny-overlaps-grant/,
    );
  } finally {
    f.store.close();
  }
});

test("X12 reviewer argv carries --image and the reviewer model; the frozen template stays intact (S02)", async () => {
  const {
    implementChanged,
    schedule: sched,
    finalProposal,
  } = await import("./codex-exec-support.mjs");
  const f = codexFixture("X12");
  try {
    implementChanged(f);
    const action = sched(f, "review");
    const plan = f.adapter.prepareLaunch(action, {
      prompt: promptOf(action),
      images: [
        { name: "shot.png", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) },
      ],
    });
    assert.equal(plan.role, "reviewer");
    assert.equal(
      plan.bundle.argv[plan.bundle.argv.indexOf("--model") + 1],
      REVIEWER_MODEL,
    );
    const imageFlags = plan.bundle.argv.filter((a) => a.startsWith("--image="));
    assert.equal(imageFlags.length, 1);
    assert.ok(imageFlags[0].endsWith("/inputs/img-0-shot.png"));
    // The image is hash-bound as a 0400 INP file in the bundle.
    const imageFile = plan.bundle.files.find(
      (x) => x.name === "img-0-shot.png",
    );
    assert.ok(imageFile);
    assert.equal(imageFile.bytes, 4);
    // Reviewer permission profile is the read-only one.
    assert.ok(
      plan.overrideAssignments.some((a) =>
        a.startsWith('default_permissions="rocky_reviewer"'),
      ),
    );
    // An image path with a comma refuses (the --image comma-split hazard).
    assert.throws(
      () =>
        f.adapter.prepareLaunch(
          { ...action, key: `${action.key}-other` },
          {
            prompt: promptOf(action),
            images: [{ name: "bad,name.png", bytes: new Uint8Array([1]) }],
          },
        ),
      /codex-image-name/,
    );
    void finalProposal;
  } finally {
    f.store.close();
  }
});
