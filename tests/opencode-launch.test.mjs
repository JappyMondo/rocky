// Taskbot #98 launch-bundle tests: pre-spawn rules against the #104 research bundle, exercised
// with the owned fake CLI, real SQLite stores and real spawned processes where a spawn is
// admitted. Covers FK1 (pinned identity, zero-spawn refusals), FK2 (argv/config-content
// serializer audit), FK3 (forbidden env/flags/roles), spawn-binding equality and the isolation
// fail-closed rules (shared-user-data-dir unrepresentable, managed layers, pinned catalog,
// staged-tree purity). The real opencode binary is NEVER executed; evidence class owned-fake-cli.
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
import { homedir } from "node:os";
import { join } from "node:path";
import {
  opencodeFixture,
  baseConfig,
  baselinePass,
  schedule,
  dispatchOpencode,
  settleOpencode,
  closeFixture,
  fakeRecord,
  fakeExportRecord,
  readReceipt,
  finalProposal,
  successScript,
  qualification,
  sha,
  PINNED_MODEL,
} from "./opencode-support.mjs";
import { coordinatorModule } from "./coordinator-support.mjs";
const {
  OpencodeAdapter,
  validateOpencodeConfig,
  buildOpencodeArgv,
  assertOpencodeArgv,
  opencodeRoleForKind,
  renderOpencodeConfigContent,
  assertOpencodeConfigContent,
  buildOpencodeSealedEnv,
  OPENCODE_PINNED_VERSION,
  OPENCODE_PINNED_BINARY_PATH,
  OPENCODE_PINNED_SHA256,
  OPENCODE_PINNED_BYTES,
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
function adapterWith(f, config, sourceEnv) {
  return new OpencodeAdapter(f.store, f.lease, config, {
    sourceEnv: sourceEnv ?? f.sourceEnv,
  });
}

test("X01 pinned-binary identity + version/model pins refuse with zero spawn (FK1/F1/F2)", () => {
  const f = opencodeFixture("X01");
  try {
    const action = implementAction(f);
    // A symlink spawn target is never admitted (the /opt/homebrew/bin symlink moves on upgrade;
    // only the absolute pinned path with a matching host-measured hash may spawn).
    const linkPath = join(f.artifactRoot, "opencode-symlink");
    symlinkSync(f.binary.path, linkPath);
    const linkAdapter = adapterWith(
      f,
      baseConfig(f, { binary: { ...f.binary, path: linkPath } }),
    );
    assert.throws(
      () => linkAdapter.prepareLaunch(action, { prompt: promptOf(action) }),
      /binary-identity-drift/,
    );
    // A truncated copy of the pinned file has a different hash: refused, never substituted.
    const copyPath = join(f.artifactRoot, "opencode-truncated-copy");
    writeFileSync(copyPath, readFileSync(f.binary.path).subarray(0, 2048));
    chmodSync(copyPath, 0o755);
    const copyAdapter = adapterWith(
      f,
      baseConfig(f, { binary: { ...f.binary, path: copyPath } }),
    );
    assert.throws(
      () => copyAdapter.prepareLaunch(action, { prompt: promptOf(action) }),
      /binary-identity-drift/,
    );
    // A missing binary makes the profile unavailable, never substituted.
    const missingAdapter = adapterWith(
      f,
      baseConfig(f, {
        binary: { ...f.binary, path: join(f.artifactRoot, "absent") },
      }),
    );
    assert.throws(
      () => missingAdapter.prepareLaunch(action, { prompt: promptOf(action) }),
      /binary-identity-missing/,
    );
    // Version pin: a config claiming a different candidate refuses.
    assert.throws(
      () =>
        validateOpencodeConfig(
          baseConfig(f, { binary: { ...f.binary, version: "1.18.32" } }),
        ),
      /opencode-version-unavailable/,
    );
    // Synthetic identities remain legal for fake-CLI evidence. A live claim must bind ALL
    // three measured binary fields, even when its declared version is correct.
    assert.doesNotThrow(() => validateOpencodeConfig(baseConfig(f)));
    const pinned = {
      path: OPENCODE_PINNED_BINARY_PATH,
      sha256: OPENCODE_PINNED_SHA256,
      bytes: OPENCODE_PINNED_BYTES,
      version: OPENCODE_PINNED_VERSION,
    };
    assert.doesNotThrow(() =>
      validateOpencodeConfig(
        baseConfig(f, { evidenceClass: "live-subscription", binary: pinned }),
      ),
    );
    for (const binary of [
      { ...pinned, path: f.binary.path },
      { ...pinned, sha256: f.binary.sha256 },
      { ...pinned, bytes: f.binary.bytes },
    ])
      assert.throws(
        () =>
          validateOpencodeConfig(
            baseConfig(f, { evidenceClass: "live-subscription", binary }),
          ),
        /opencode-live-binary-unavailable/,
      );
    // Off-table model assignments fail closed and are never defaulted (no fallback/reroute; F26).
    assert.throws(
      () =>
        validateOpencodeConfig(
          baseConfig(f, {
            roles: {
              implementer: {
                model: "alibaba-token-plan/qwen-other",
                steps: 8,
                prompt: "x",
              },
            },
          }),
        ),
      /opencode-implementer-model-off-table/,
    );
    // Mismatched qualification identity fails config validation.
    assert.throws(
      () =>
        validateOpencodeConfig(
          baseConfig(f, {
            qualification: { ...qualification, harness: "codex-exec" },
          }),
        ),
      /invalid-opencode-qualification/,
    );
    // Zero spawn and zero per-action RUN trees for every refused prepare above.
    assert.deepEqual(readdirSync(f.runsRoot), []);
  } finally {
    f.store.close();
  }
});

test("X02 argv serializer: exact pinned 5-element shape, role agents, never-pass and no positional prompt (FK2/FK3/F9)", () => {
  const f = opencodeFixture("X02");
  try {
    const { plan } = prepared(f);
    const input = {
      role: "implementer",
      model: PINNED_MODEL,
      dir: plan.paths.src,
      maxArgvBytes: f.config.limits.maxArgvBytes,
    };
    // The composed argv re-audits clean and equals a fresh composition of the same input.
    assert.deepEqual(plan.bundle.argv, buildOpencodeArgv(input));
    assert.deepEqual(plan.bundle.argv, [
      "run",
      "--format=json",
      `--model=${PINNED_MODEL}`,
      "--agent=rocky-implementer",
      `--dir=${plan.paths.src}`,
    ]);
    // Role → agent mapping (reviewer included); non-agent kinds refuse.
    assert.deepEqual(
      buildOpencodeArgv({ ...input, role: "reviewer" })[3],
      "--agent=rocky-reviewer",
    );
    assert.equal(opencodeRoleForKind("implement"), "implementer");
    assert.equal(opencodeRoleForKind("repair_ci"), "implementer");
    assert.equal(opencodeRoleForKind("review"), "reviewer");
    assert.equal(opencodeRoleForKind("arbitrate"), "reviewer");
    assert.throws(() => opencodeRoleForKind("baseline"), /agent-work-only/);
    // Every never-pass flag rejects pre-spawn, regardless of position (representative subset of
    // the FK3 list: approval bypasses, continuity, share/attach, server creds, hidden modes).
    for (const flag of [
      "--auto",
      "--yolo",
      "--dangerously-skip-permissions",
      "--continue",
      "--session=x",
      "--fork",
      "--share",
      "--attach=http://x",
      "--password=p",
      "--username=u",
      "--port=1",
      "--interactive",
      "--mini",
      "--demo",
      "--command=c",
      "--file=x",
      "--variant=high",
      "--thinking",
      "--print-logs",
      "--pure",
    ]) {
      const tampered = [
        ...plan.bundle.argv.slice(0, 1),
        flag,
        ...plan.bundle.argv.slice(1, 4),
      ];
      assert.throws(
        () => assertOpencodeArgv(tampered, input),
        /opencode-(forbidden-flag|argv-shape|argv-element-mismatch)/,
        `flag ${flag} must refuse`,
      );
    }
    // A positional prompt is impossible in the pinned shape: any extra/positional element refuses.
    assert.throws(
      () => assertOpencodeArgv([...plan.bundle.argv, "do evil things"], input),
      /opencode-argv-shape/,
    );
    assert.throws(
      () =>
        assertOpencodeArgv(
          [
            "run",
            "do evil things",
            "--format=json",
            `--model=${PINNED_MODEL}`,
            `--dir=${plan.paths.src}`,
          ],
          input,
        ),
      /opencode-argv-element-mismatch/,
    );
    // Off-table model in argv composition refuses.
    assert.throws(
      () => buildOpencodeArgv({ ...input, model: "openai/gpt-x" }),
      /opencode-model-off-table/,
    );
  } finally {
    f.store.close();
  }
});

test("X03 sealed env: exact positive allowlist equality + poisoned source env refuses pre-spawn (FK3/F5/F6)", () => {
  const f = opencodeFixture("X03");
  try {
    const { action, plan } = prepared(f);
    // The sealed env is EXACTLY the pinned allowlist, in order, with exact bindings.
    const envMap = Object.fromEntries(plan.bundle.env);
    assert.deepEqual(
      plan.bundle.env.map(([k]) => k),
      [
        "HOME",
        "TMPDIR",
        "PWD",
        "PATH",
        "LANG",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_CACHE_HOME",
        "XDG_STATE_HOME",
        "OPENCODE_DB",
        "OPENCODE_MODELS_PATH",
        "OPENCODE_CONFIG_CONTENT",
        "OPENCODE_DISABLE_PROJECT_CONFIG",
        "OPENCODE_DISABLE_MODELS_FETCH",
        "OPENCODE_DISABLE_AUTOUPDATE",
        "OPENCODE_DISABLE_DEFAULT_PLUGINS",
        "OPENCODE_DISABLE_CLAUDE_CODE",
        "OPENCODE_DISABLE_EXTERNAL_SKILLS",
        "OPENCODE_DISABLE_PRUNE",
        "OPENCODE_PURE",
      ],
    );
    assert.equal(envMap.HOME, plan.paths.parentHome);
    assert.equal(envMap.TMPDIR, plan.paths.parentTmp);
    assert.equal(envMap.PWD, plan.paths.src);
    assert.equal(envMap.PATH, "/usr/bin:/bin:/usr/sbin:/sbin");
    assert.equal(envMap.XDG_CONFIG_HOME, plan.paths.configHome);
    assert.equal(envMap.XDG_DATA_HOME, f.dataHome);
    assert.equal(envMap.XDG_CACHE_HOME, plan.paths.cacheHome);
    assert.equal(envMap.XDG_STATE_HOME, plan.paths.stateHome);
    assert.equal(envMap.OPENCODE_DB, plan.paths.db);
    assert.equal(envMap.OPENCODE_MODELS_PATH, f.modelsCatalog.path);
    assert.equal(envMap.OPENCODE_CONFIG_CONTENT, plan.configContent);
    for (const key of [
      "OPENCODE_DISABLE_PROJECT_CONFIG",
      "OPENCODE_DISABLE_MODELS_FETCH",
      "OPENCODE_DISABLE_AUTOUPDATE",
      "OPENCODE_DISABLE_DEFAULT_PLUGINS",
      "OPENCODE_DISABLE_CLAUDE_CODE",
      "OPENCODE_DISABLE_EXTERNAL_SKILLS",
      "OPENCODE_DISABLE_PRUNE",
      "OPENCODE_PURE",
    ])
      assert.equal(envMap[key], "1");
    // Rebuilding from the same values is byte-equal (serializer determinism).
    assert.deepEqual(
      buildOpencodeSealedEnv({
        home: plan.paths.parentHome,
        tmpdir: plan.paths.parentTmp,
        pwd: plan.paths.src,
        configHome: plan.paths.configHome,
        dataHome: f.dataHome,
        cacheHome: plan.paths.cacheHome,
        stateHome: plan.paths.stateHome,
        db: plan.paths.db,
        modelsPath: f.modelsCatalog.path,
        configContent: plan.configContent,
      }),
      plan.bundle.env,
    );
    // Poisoned source env: representative forbidden keys (not the full 26) each refuse pre-spawn
    // with zero spawn and zero RUN trees. Values are never logged or compared — names only. The
    // action was already scheduled above (the execution slot is occupied), so the same action is
    // reused: every poisoned adapter must refuse it before any side effect.
    const before = readdirSync(f.runsRoot);
    for (const key of [
      "ALIBABA_TOKEN_PLAN_API_KEY",
      "OPENCODE_AUTH_CONTENT",
      "OPENCODE_MODELS_URL",
      "OPENCODE_CONFIG",
      "OPENCODE_CONFIG_DIR",
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "DEEPSEEK_API_KEY",
      "HTTPS_PROXY",
      "NODE_EXTRA_CA_CERTS",
      "XDG_DATA_HOME",
      "OTEL_EXPORTER_OTLP_ENDPOINT",
      "http_proxy",
      "no_proxy",
      "openai_api_key",
      "opencode_auth_content",
      "xdg_data_home",
      "node_extra_ca_certs",
      "ssh_auth_sock",
    ]) {
      const poisoned = adapterWith(f, f.config, { ...f.sourceEnv, [key]: "x" });
      assert.throws(
        () => poisoned.prepareLaunch(action, { prompt: promptOf(action) }),
        /opencode-forbidden-env-present/,
        `poisoned key ${key} must refuse`,
      );
    }
    assert.deepEqual(readdirSync(f.runsRoot), before);
  } finally {
    f.store.close();
  }
});

test("X04 sealed config content: canonical strict JSON, required pins, prohibited keys, no substitution vectors (FK2/F13/F14)", () => {
  const f = opencodeFixture("X04");
  try {
    const { plan } = prepared(f);
    const parsed = JSON.parse(plan.configContent);
    // REQUIRED keys with exact pinned values (PART 4 §1 sealed-config-content).
    assert.deepEqual(parsed.enabled_providers, ["alibaba-token-plan"]);
    assert.equal(parsed.share, "disabled");
    assert.equal(parsed.autoupdate, false);
    assert.equal(parsed.snapshot, false);
    assert.equal(parsed.subagent_depth, 0);
    assert.equal(parsed.small_model, PINNED_MODEL);
    // Both role agents carry model/prompt/steps/permission exactly per the role table.
    assert.equal(parsed.agent["rocky-implementer"].model, PINNED_MODEL);
    assert.equal(
      parsed.agent["rocky-implementer"].prompt,
      f.config.roles.implementer.prompt,
    );
    assert.equal(parsed.agent["rocky-implementer"].steps, 8);
    assert.equal(parsed.agent["rocky-reviewer"].steps, 4);
    // The rendered content re-audits clean against the same role table.
    const rolesInput = {
      implementer: {
        role: "implementer",
        model: PINNED_MODEL,
        steps: 8,
        prompt: f.config.roles.implementer.prompt,
      },
      reviewer: {
        role: "reviewer",
        model: PINNED_MODEL,
        steps: 4,
        prompt: f.config.roles.reviewer.prompt,
      },
    };
    assert.equal(renderOpencodeConfigContent(rolesInput), plan.configContent);
    assert.doesNotThrow(() =>
      assertOpencodeConfigContent(plan.configContent, rolesInput),
    );
    // Prohibited keys reject (MCP servers, plugins, instruction fetches, provider overrides,
    // default-agent redirection): a hostile config source can never ride the sealed content.
    for (const injected of [
      { mcp: { evil: { type: "local", command: ["x"] } } },
      { plugin: ["evil@1.0.0"] },
      { instructions: ["http://evil/x.md"] },
      { provider: { "alibaba-token-plan": { options: { apiKey: "x" } } } },
      { default_agent: "build" },
    ]) {
      const hostile = JSON.stringify({
        ...JSON.parse(plan.configContent),
        ...injected,
      });
      assert.throws(
        () => assertOpencodeConfigContent(hostile, rolesInput),
        /opencode-config-forbidden-key/,
      );
    }
    // Duplicate keys and {env:}/{file:} substitution vectors reject.
    assert.throws(
      () =>
        assertOpencodeConfigContent(
          '{"share":"disabled","share":"disabled"}',
          rolesInput,
        ),
      /opencode-config-malformed/,
    );
    assert.throws(
      () =>
        renderOpencodeConfigContent({
          ...rolesInput,
          implementer: {
            ...rolesInput.implementer,
            prompt: "leak {env:ALIBABA_TOKEN_PLAN_API_KEY} now",
          },
        }),
      /opencode-config-substitution/,
    );
    assert.throws(
      () =>
        renderOpencodeConfigContent({
          ...rolesInput,
          reviewer: {
            ...rolesInput.reviewer,
            prompt: "steal {file:/etc/passwd}",
          },
        }),
      /opencode-config-substitution/,
    );
    // Tampered pinned values reject on re-audit.
    const noProviders = JSON.parse(plan.configContent);
    noProviders.enabled_providers = ["alibaba-token-plan", "openai"];
    assert.throws(
      () =>
        assertOpencodeConfigContent(JSON.stringify(noProviders), rolesInput),
      /opencode-config-enabled-providers/,
    );
    for (const agentName of ["rocky-implementer", "rocky-reviewer"]) {
      const extra = JSON.parse(plan.configContent);
      extra.agent[agentName].tools = { bash: true };
      assert.throws(
        () => assertOpencodeConfigContent(JSON.stringify(extra), rolesInput),
        /opencode-config-agent-forbidden-key/,
      );
    }
  } finally {
    f.store.close();
  }
});

test("X05 isolation fail-closed: shared user data dir unrepresentable, managed layers, pinned catalog, staged-tree purity (F7/F8/F13)", () => {
  const f = opencodeFixture("X05");
  try {
    const action = implementAction(f);
    const realUserData = join(homedir(), ".local/share/opencode");
    // The user's real data dir (equal / inside / containing) is the unrepresentable
    // shared-user-data-dir mode: refuse with zero spawn. Pure path comparison — the directory is
    // never listed or read.
    for (const dataHome of [
      realUserData,
      join(realUserData, "sub"),
      homedir(),
    ]) {
      const adapter = adapterWith(f, baseConfig(f, { dataHome }));
      assert.throws(
        () => adapter.prepareLaunch(action, { prompt: promptOf(action) }),
        /opencode-shared-user-data-dir/,
      );
    }
    // The user's real path is a symlinked ~/.local/share alias into an existing canonical
    // directory. Comparing only the spelled-out ~/.local path would admit that directory.
    const aliasHome = join(f.dir, "alias-home");
    const aliasLocal = join(aliasHome, ".local");
    const actualShare = join(f.dir, "actual-share");
    const actualUserData = join(actualShare, "opencode");
    mkdirSync(aliasLocal, { recursive: true });
    mkdirSync(actualUserData, { recursive: true });
    symlinkSync(actualShare, join(aliasLocal, "share"));
    const aliased = adapterWith(
      f,
      baseConfig(f, {
        dataHome: actualUserData,
        hostIdentity: { userHome: aliasHome },
      }),
    );
    assert.throws(
      () => aliased.prepareLaunch(action, { prompt: promptOf(action) }),
      /opencode-shared-user-data-dir/,
    );
    // A missing (unprovisioned) Rocky-owned data dir refuses: provisioning is a documented
    // one-time USER procedure, never performed or faked by the adapter.
    const missingAdapter = adapterWith(
      f,
      baseConfig(f, { dataHome: join(f.dir, "never-provisioned") }),
    );
    assert.throws(
      () => missingAdapter.prepareLaunch(action, { prompt: promptOf(action) }),
      /opencode-data-home-missing/,
    );
    const emptyData = join(f.dir, "empty-data");
    mkdirSync(emptyData);
    const unprovisioned = adapterWith(
      f,
      baseConfig(f, { dataHome: emptyData }),
    );
    assert.throws(
      () => unprovisioned.prepareLaunch(action, { prompt: promptOf(action) }),
      /opencode-auth-unprovisioned/,
    );
    assert.deepEqual(readdirSync(f.runsRoot), []);
    // A managed layer (F13 7/8 — cannot be overridden by any config) makes the profile
    // unavailable until reviewed.
    mkdirSync(join(f.dir, "managed"), { recursive: true });
    writeFileSync(join(f.dir, "managed", "opencode.json"), "{}");
    assert.throws(
      () => f.adapter.prepareLaunch(action, { prompt: promptOf(action) }),
      /opencode-managed-layer-present/,
    );
    rmSync(join(f.dir, "managed", "opencode.json"));
    // Catalog drift and catalog absence refuse (the pinned catalog decouples models.dev drift).
    const originalCatalog = readFileSync(f.modelsCatalog.path);
    writeFileSync(f.modelsCatalog.path, '{"synthetic":"mutated"}');
    assert.throws(
      () => f.adapter.prepareLaunch(action, { prompt: promptOf(action) }),
      /opencode-catalog-drift/,
    );
    writeFileSync(f.modelsCatalog.path, originalCatalog);
    const absentAdapter = adapterWith(
      f,
      baseConfig(f, {
        modelsCatalog: {
          path: join(f.dir, "absent-catalog.json"),
          sha256: f.modelsCatalog.sha256,
        },
      }),
    );
    assert.throws(
      () => absentAdapter.prepareLaunch(action, { prompt: promptOf(action) }),
      /opencode-catalog-missing/,
    );
    // Staged-tree purity: instruction files and .git in SRC refuse (staged tree rule), even
    // though OPENCODE_DISABLE_PROJECT_CONFIG would skip discovery. The run root is deterministic
    // per action, so each sub-case cleans its staged file before the next one.
    const runRoot = join(f.runsRoot, `run-${sha(action.key).slice(0, 32)}`);
    const src = join(runRoot, "stage/source");
    assert.throws(
      () =>
        f.adapter.prepareLaunch(action, {
          prompt: promptOf(action),
          stage: (s) => writeFileSync(join(s, "AGENTS.md"), "hostile\n"),
        }),
      /opencode-staged-instruction-files/,
    );
    rmSync(join(src, "AGENTS.md"));
    assert.throws(
      () =>
        f.adapter.prepareLaunch(action, {
          prompt: promptOf(action),
          stage: (s) => {
            mkdirSync(join(s, ".git"));
            writeFileSync(join(s, ".git", "HEAD"), "ref\n");
          },
        }),
      /opencode-staged-git/,
    );
    rmSync(join(src, ".git"), { recursive: true, force: true });
    assert.throws(
      () =>
        f.adapter.prepareLaunch(action, {
          prompt: promptOf(action),
          stage: (s) => mkdirSync(join(s, ".opencode")),
        }),
      /opencode-staged-opencode-dir/,
    );
  } finally {
    f.store.close();
  }
});

test("X06 role permission tables in the emitted sealed config: reviewer read-only by tool absence, implementer cwd-contained (F17/F18)", () => {
  const f = opencodeFixture("X06");
  try {
    const { plan } = prepared(f);
    const parsed = JSON.parse(plan.configContent);
    // REVIEWER: '*':deny removes bash/edit/write/apply_patch/task/webfetch from the roster
    // ENTIRELY (tool absence, stronger than runtime blocking); only read/glob/grep/list allowed.
    assert.deepEqual(parsed.agent["rocky-reviewer"].permission, {
      "*": "deny",
      read: "allow",
      glob: "allow",
      grep: "allow",
      list: "allow",
    });
    // IMPLEMENTER: edit/bash/read allowed; task/webfetch/websearch/skill/question denied;
    // external_directory DENY (not ask) makes cwd-containment explicit and observable.
    assert.deepEqual(parsed.agent["rocky-implementer"].permission, {
      edit: { "*": "allow" },
      bash: { "*": "allow" },
      read: { "*": "allow" },
      task: "deny",
      webfetch: "deny",
      websearch: "deny",
      skill: "deny",
      question: "deny",
      external_directory: { "*": "deny" },
    });
    // subagent_depth 0 globally prevents ALL subagent launches.
    assert.equal(parsed.subagent_depth, 0);
  } finally {
    f.store.close();
  }
});

test("X07 spawn binding equality: the fake's recorded argv/env/cwd/stdin equal the audited bundle exactly (FK1/FK4)", async () => {
  const f = opencodeFixture("X07");
  try {
    baselinePass(f);
    const action = schedule(f, "implement");
    const proposal = finalProposal(action, "implementer");
    const script = successScript(proposal, {
      writeSrc: { path: "output.txt", content: "bounded change\n" },
    });
    // Hostile-looking prompt bytes: exact delivery, no shell interpretation.
    script.note = `new\nlines 'quotes' "dq" $(touch /tmp/should-not-exist) ü 世界 {json:1}`;
    const { plan, pending } = dispatchOpencode(f, action, script);
    const snapshot = await settleOpencode(f, action, pending);
    assert.equal(snapshot.blocker, null);
    const record = fakeRecord(plan);
    // argv: exact element-for-element equality with the audited bundle.
    assert.deepEqual(record.argv, [...plan.bundle.argv]);
    // env: EXACTLY the sealed allowlist — no inheritance, no extra keys. The only tolerated extra
    // is darwin's __CF_USER_TEXT_ENCODING, which CoreFoundation derives from the uid INSIDE the
    // child after exec; it is a child-runtime artifact, never a parent leak, and is recorded
    // honestly here instead of being silently accepted.
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
    assert.equal(record.env.ALIBABA_TOKEN_PLAN_API_KEY, undefined);
    assert.equal(record.env.OPENCODE_AUTH_CONTENT, undefined);
    assert.equal(record.env.SSH_AUTH_SOCK, undefined);
    assert.equal(record.cwd, plan.paths.src);
    // stdin: exact bytes once + one EOF (F10/F23: read-to-EOF, single EOF, no resend).
    const promptBytes = Buffer.from(JSON.stringify(script), "utf8");
    assert.equal(record.stdin.bytes, promptBytes.length);
    assert.equal(record.stdin.sha256, plan.bundle.input.sha256);
    assert.equal(record.stdin.eofCount, 1);
    assert.deepEqual(
      readFileSync(join(plan.paths.parentTmp, "fake-stdin.log")),
      promptBytes,
    );
    assert.equal(existsSync("/tmp/should-not-exist"), false);
    // The receipt binds argv/env/config-content/prompt digests to the bundle.
    const command = f.store.commands(f.lease.runId).at(-1);
    const receipt = readReceipt(plan, command.id);
    // The export-audit child was spawned with the SAME sealed env and the pinned argv shape.
    const exportRecord = fakeExportRecord(plan);
    assert.deepEqual(exportRecord.argv, ["export", receipt.stream.sessionId]);
    assert.equal(
      JSON.stringify(
        Object.entries(exportRecord.env)
          .filter(([key]) => sealedKeys.includes(key))
          .sort(),
      ),
      JSON.stringify([...plan.bundle.env].map(([k, v]) => [k, v]).sort()),
    );
    assert.equal(exportRecord.cwd, plan.paths.src);
    assert.equal(receipt.bundleDigest, plan.bundle.bundleDigest);
    assert.equal(
      receipt.bundle.argvSha256,
      sha(coordinatorModule.canonical(plan.bundle.argv)),
    );
    assert.equal(receipt.bundle.configContentSha256, sha(plan.configContent));
    assert.equal(receipt.bundle.inputSha256, plan.bundle.input.sha256);
    assert.equal(receipt.isolation.dataHome, f.dataHome);
    assert.equal(receipt.isolation.authProvisioned, true);
    assert.equal(receipt.isolation.credentialReadCopySymlinkProxy, false);
  } finally {
    await closeFixture(f);
  }
});
