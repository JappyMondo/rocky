// R1 phase 2 — zero-spawn adapter denials (NO CLI process at all): CC-P1, CC-P7(i), CX-P2(a), CX-P2(c).
// Drives the SHIPPED pure modules + ClaudeCodeAdapter.prepareLaunch (Tier-A). Every rejection here is
// pre-spawn; no real CLI process is created in this phase.
import {
  dist,
  PINS,
  freshTempRoot,
  rmTemp,
  probeDir,
  writeJSON,
  writeVerdict,
  errName,
  makeClaudeFixture,
  inventoryDir,
  makePhaseRunner,
  claudeSupport,
} from "./lib.mjs";
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";

const R = makePhaseRunner(2);
const {
  inventoryClaudeDiscovery,
  assertClaudeDiscoveryAdmissible,
  validateClaudeCodeConfig,
  serializeCodexOverride,
  buildCodexOverrideAssignments,
  assertCodexArgv,
  tomlRoundTrip,
} = dist;
const { baselinePass, schedule } = claudeSupport;
const promptOf = (a) => JSON.stringify({ script: [{ exit: 0 }], actionKey: a.key });

// ---------------- CC-P1 ----------------
await R.run("CC-P1", async () => {
  const dir = probeDir("CC-P1");
  const tempRoot = freshTempRoot("CC-P1");
  const obs = { subcases: [], sentinelUntouched: null, tierA: {} };
  try {
    // Hostile CFG: forbidden children incl settings.json(env ANTHROPIC_API_KEY+apiKeyHelper+SessionStart hook→sentinel).
    const sentinel = join(tempRoot, "sentinel-written");
    const cfgHostile = join(tempRoot, "cfg-hostile");
    mkdirSync(cfgHostile, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(cfgHostile, "settings.json"),
      JSON.stringify({
        env: { ANTHROPIC_API_KEY: "synthetic-poison-not-a-real-key" },
        apiKeyHelper: "/bin/echo synthetic",
        hooks: {
          SessionStart: [
            { hooks: [{ type: "command", command: `/usr/bin/touch ${sentinel}` }] },
          ],
        },
      })
    );
    writeFileSync(join(cfgHostile, "CLAUDE.md"), "hostile");
    for (const d of ["rules", "skills", "agents", "plugins"])
      mkdirSync(join(cfgHostile, d), { recursive: true });

    // Hostile SRC + ancestor instruction files.
    const runRoot = join(tempRoot, "run");
    const src = join(runRoot, "stage/source");
    mkdirSync(join(src, ".claude"), { recursive: true, mode: 0o700 });
    writeFileSync(join(src, ".claude/settings.json"), "{}");
    writeFileSync(join(src, ".mcp.json"), "{}");
    writeFileSync(join(src, "CLAUDE.md"), "hostile");
    writeFileSync(join(src, "AGENTS.md"), "hostile");
    writeFileSync(join(runRoot, "CLAUDE.md"), "hostile-ancestor");

    // Sub-case A: hostile CFG → claude-config-dir-forbidden.
    const invA = inventoryClaudeDiscovery({
      managed: [],
      managedDirs: [],
      mdm: [],
      configDir: cfgHostile,
      src,
      runRoot,
      maxTreeNodes: 2000,
    });
    let aErr = null;
    try {
      assertClaudeDiscoveryAdmissible(invA, { configDir: cfgHostile });
    } catch (e) {
      aErr = errName(e);
    }
    obs.subcases.push({
      case: "A-hostile-config-dir",
      forbiddenConfigDirChildren: invA.forbiddenConfigDirChildren,
      refusal: aErr,
    });

    // Sub-case B: clean CFG + hostile SRC/ancestor → claude-instruction-files-present.
    const cfgClean = join(tempRoot, "cfg-clean");
    mkdirSync(cfgClean, { recursive: true, mode: 0o700 });
    const invB = inventoryClaudeDiscovery({
      managed: [],
      managedDirs: [],
      mdm: [],
      configDir: cfgClean,
      src,
      runRoot,
      maxTreeNodes: 2000,
    });
    let bErr = null;
    try {
      assertClaudeDiscoveryAdmissible(invB, { configDir: cfgClean });
    } catch (e) {
      bErr = errName(e);
    }
    obs.subcases.push({
      case: "B-hostile-instruction-files",
      instructionFiles: invB.instructionFiles,
      refusal: bErr,
    });

    // Sub-case C: managed-layer present → claude-managed-layer-present (G-MANAGED analogue).
    const managedRoot = join(tempRoot, "managed");
    mkdirSync(managedRoot, { recursive: true });
    writeFileSync(join(managedRoot, "managed-settings.json"), "{}");
    const invC = inventoryClaudeDiscovery({
      managed: [join(managedRoot, "managed-settings.json")],
      managedDirs: [],
      mdm: [],
      configDir: cfgClean,
      src: join(tempRoot, "empty-src"),
      runRoot: join(tempRoot, "empty-run"),
      maxTreeNodes: 2000,
    });
    let cErr = null;
    try {
      assertClaudeDiscoveryAdmissible(invC, { configDir: cfgClean });
    } catch (e) {
      cErr = errName(e);
    }
    mkdirSync(join(tempRoot, "empty-src"), { recursive: true });
    obs.subcases.push({ case: "C-managed-layer-present", refusal: cErr });

    // Tier-A: drive the shipped adapter prepareLaunch; refusal must be pre-spawn (no INP rendered, no command).
    const f = makeClaudeFixture(join(tempRoot, "tierA"));
    try {
      // plant hostile CFG children into the fixture's dedicated configDir
      writeFileSync(join(f.configDir, "settings.json"), "{}");
      baselinePass(f);
      const action = schedule(f, "implement");
      let tierAErr = null;
      try {
        f.adapter.prepareLaunch(action, { prompt: promptOf(action) });
      } catch (e) {
        tierAErr = errName(e);
      }
      const runDirs = readdirSync(f.runsRoot);
      const renderedInp = runDirs.some((d) =>
        existsSync(join(f.runsRoot, d, "inputs", "settings.json"))
      );
      obs.tierA = {
        refusal: tierAErr,
        runTreeDirs: runDirs.length,
        inpSettingsRendered: renderedInp,
        commandRows: f.store.commands(f.lease.runId).length,
      };
      // hostile SRC via stage hook (clean CFG fixture)
      const f2 = makeClaudeFixture(join(tempRoot, "tierA2"));
      baselinePass(f2);
      const action2 = schedule(f2, "implement");
      let stageErr = null;
      try {
        f2.adapter.prepareLaunch(action2, {
          prompt: promptOf(action2),
          stage: (s) => writeFileSync(join(s, "CLAUDE.md"), "hostile"),
        });
      } catch (e) {
        stageErr = errName(e);
      }
      obs.tierA.stageInstructionRefusal = stageErr;
      obs.tierA.stageCommandRows = f2.store.commands(f2.lease.runId).length;
      f2.store.close();
    } finally {
      f.store.close();
    }

    obs.sentinelUntouched = !existsSync(sentinel);
    obs.cfgHostileInventory = inventoryDir(cfgHostile).entries.map((e) => e.path);
    writeJSON(dir + "/meta.json", { probeId: "CC-P1", pins: PINS.claude, obs });
    writeJSON(dir + "/inventories/cfg-hostile.json", inventoryDir(cfgHostile));

    const namedOk =
      /claude-config-dir-forbidden/.test(obs.subcases[0].refusal || "") &&
      /claude-instruction-files-present/.test(obs.subcases[1].refusal || "") &&
      /claude-managed-layer-present/.test(obs.subcases[2].refusal || "");
    const tierAOk =
      /claude-config-dir-forbidden/.test(obs.tierA.refusal || "") &&
      obs.tierA.inpSettingsRendered === false &&
      obs.tierA.commandRows === 0 &&
      /claude-instruction-files-present/.test(obs.tierA.stageInstructionRefusal || "") &&
      obs.tierA.stageCommandRows === 0;
    const sentinelOk = obs.sentinelUntouched === true;
    const verdict = namedOk && tierAOk && sentinelOk ? "PASS" : "REJECT";
    writeVerdict("CC-P1", {
      verdict,
      tier: "A (drove shipped inventoryClaudeDiscovery + assertClaudeDiscoveryAdmissible + ClaudeCodeAdapter.prepareLaunch)",
      gate: "N01 pre-spawn half / CC04 / G-MANAGED analogue",
      hypothesis:
        "Hostile CFG children, staged/ancestor instruction files and a present managed layer each yield a NAMED pre-spawn refusal, zero spawn, and the SessionStart-hook sentinel is never written.",
      criterion:
        "PART2 CC-P1: 'PASS: named refusals (claude-config-dir-forbidden:…, claude-instruction-files-present:…), zero spawn, sentinel untouched. REJECT: any admission.'",
      expected:
        "claude-config-dir-forbidden + claude-instruction-files-present (+ claude-managed-layer-present); prepareLaunch refuses pre-spawn (no INP settings rendered, no command row); sentinel absent.",
      observed: JSON.stringify({
        A: obs.subcases[0].refusal,
        B: obs.subcases[1].refusal,
        C: obs.subcases[2].refusal,
        tierA: obs.tierA,
        sentinelUntouched: obs.sentinelUntouched,
      }),
      class: verdict === "PASS" ? "named-pre-spawn-refusal" : "admission-or-side-effect",
      notes: `namedOk=${namedOk} tierAOk=${tierAOk} sentinelOk=${sentinelOk}. Zero CLI process spawned (pure modules + prepareLaunch only).`,
    });
    return verdict;
  } finally {
    rmTemp(tempRoot);
  }
});

// ---------------- CC-P7(i) ----------------
await R.run("CC-P7i", async () => {
  const dir = probeDir("CC-P7i");
  const tempRoot = freshTempRoot("CC-P7i");
  const obs = {};
  try {
    const f = makeClaudeFixture(tempRoot);
    try {
      baselinePass(f);
      const action = schedule(f, "implement");
      // (i-a) prompt over the configured maxPromptBytes (65536 < 10MB ceiling) → pre-spawn rejection.
      let overErr = null;
      try {
        f.adapter.prepareLaunch(action, { prompt: "x".repeat(70000) });
      } catch (e) {
        overErr = errName(e);
      }
      const runDirs = readdirSync(f.runsRoot);
      obs.overLimit = {
        configuredMaxPromptBytes: f.config.limits.maxPromptBytes,
        promptBytes: 70000,
        refusal: overErr,
        runTreeDirs: runDirs.length,
        commandRows: f.store.commands(f.lease.runId).length,
      };
      // (i-b) the adapter can never be CONFIGURED above the native 10MB ceiling.
      let cfgErr = null;
      try {
        validateClaudeCodeConfig({
          ...f.config,
          limits: { ...f.config.limits, maxPromptBytes: 11 * 1024 * 1024 },
        });
      } catch (e) {
        cfgErr = errName(e);
      }
      obs.ceiling = { attemptedMaxPromptBytes: 11 * 1024 * 1024, refusal: cfgErr };
    } finally {
      f.store.close();
    }
    writeJSON(dir + "/meta.json", { probeId: "CC-P7i", obs });
    const ok =
      /prompt-over-limit/.test(obs.overLimit.refusal || "") &&
      obs.overLimit.commandRows === 0 &&
      /invalid-claude-config:limits.maxPromptBytes/.test(obs.ceiling.refusal || "");
    const verdict = ok ? "PASS" : "REJECT";
    writeVerdict("CC-P7i", {
      verdict,
      tier: "A (ClaudeCodeAdapter.prepareLaunch + validateClaudeCodeConfig)",
      gate: "N05 10MB cap (adapter half)",
      hypothesis:
        "A prompt larger than the configured maxPromptBytes is rejected pre-spawn (zero spawn), and the config can never set maxPromptBytes above the native 10MB ceiling.",
      criterion:
        "PART2 CC-P7(i): 'Tier-A adapter maxPromptBytes<cap ⇒ pre-spawn rejection, zero spawn.'",
      expected: "prompt-over-limit; 0 command rows; invalid-claude-config:limits.maxPromptBytes for >10MB.",
      observed: JSON.stringify(obs),
      class: verdict === "PASS" ? "pre-spawn-prompt-cap-rejection" : "cap-not-enforced",
      notes: "Zero CLI process spawned.",
    });
    return verdict;
  } finally {
    rmTemp(tempRoot);
  }
});

// ---------------- CX-P2(a) ----------------
await R.run("CX-P2a", async () => {
  const dir = probeDir("CX-P2a");
  const limits = { maxOverrideValueBytes: 65536, maxOverrides: 64 };
  const obs = { cases: [] };
  const call = (label, fn) => {
    let out = null,
      err = null;
    try {
      out = fn();
    } catch (e) {
      err = errName(e);
    }
    obs.cases.push({ label, out, err });
    return { out, err };
  };
  // Dotted key (a path-keyed map under a dotted key) → dot-free key audit rejects pre-spawn (F1 defense).
  call("dotted-key-projects./some/path", () =>
    serializeCodexOverride(
      "projects./some/path",
      { "/some/path": { trust_level: "untrusted" } },
      limits
    )
  );
  // Forbidden key sandbox_mode → rejected.
  call("forbidden-key-sandbox_mode", () =>
    buildCodexOverrideAssignments([{ key: "sandbox_mode", value: "workspace-write" }], limits)
  );
  // Unknown key → rejected.
  call("unknown-key", () =>
    buildCodexOverrideAssignments([{ key: "totally_unknown_key", value: "x" }], limits)
  );
  // Legitimate dot-free path-keyed map → admitted (round-trips), proving the rejection is dot-specific.
  call("legit-dotfree-projects-map", () =>
    serializeCodexOverride("projects", { "/some/path": { trust_level: "untrusted" } }, limits)
  );
  // tomlRoundTrip on a rendered-degrading value: the conservative grammar renderer/parser are inverses,
  // so demonstrate the round-trip proof itself on a path-keyed inline table.
  call("tomlRoundTrip-proof", () =>
    tomlRoundTrip("projects", { "/some/path": { trust_level: "untrusted" } })
  );
  writeJSON(dir + "/meta.json", { probeId: "CX-P2a", obs });
  const dotted = obs.cases[0].err;
  const forbidden = obs.cases[1].err;
  const unknown = obs.cases[2].err;
  const legit = obs.cases[3].out;
  const ok =
    /codex-override-key-not-dot-free/.test(dotted || "") &&
    /codex-override-forbidden-key:sandbox_mode/.test(forbidden || "") &&
    /codex-override-unknown-key/.test(unknown || "") &&
    typeof legit === "string" && legit.startsWith("projects=");
  const verdict = ok ? "PASS" : "REJECT";
  writeVerdict("CX-P2a", {
    verdict,
    tier: "A (serializeCodexOverride / buildCodexOverrideAssignments / tomlRoundTrip pure modules)",
    gate: "N01 strict-config/discovery slice (F1 binding)",
    hypothesis:
      "A value that would silently degrade under codex's dot-splitting (path-keyed map under a dotted key), a forbidden sandbox_mode key and an unknown key are each rejected pre-spawn by the shipped producer; a dot-free path-keyed inline table round-trips and is admitted.",
    criterion:
      "PART3 CX-P2(a): 'Tier-A pure-module: serializeCodexOverride/buildCodexOverrideAssignments fed a value that would silently degrade to raw string (path-keyed map under dotted key) ⇒ tomlRoundTrip pre-spawn rejection, zero spawn (confirms F1 binding against shipped code).'",
    expected:
      "codex-override-key-not-dot-free (dotted), codex-override-forbidden-key:sandbox_mode, codex-override-unknown-key; dot-free map admitted.",
    observed: JSON.stringify({ dotted, forbidden, unknown, legit }),
    class: verdict === "PASS" ? "pre-spawn-override-rejection" : "override-degradation-admitted",
    notes:
      "HONEST NOTE: the shipped rejection for a dotted key fires in assertCodexOverrideKey (codex-override-key-not-dot-free) BEFORE tomlRoundTrip; the tomlRoundTrip inequality path is unreachable for the conservative grammar (renderer/parser are exact inverses), so the dot-free key audit + forbidden/unknown key audits are the effective F1 pre-spawn defense. Zero spawn.",
  });
  return verdict;
});

// ---------------- CX-P2(c) ----------------
await R.run("CX-P2c", async () => {
  const dir = probeDir("CX-P2c");
  const obs = {};
  const input = {
    model: "gpt-6-sol",
    effort: "medium",
    schemaPath: "/synthetic/schema.json",
    overrideAssignments: [
      'default_permissions="rocky_implementer"',
      'model_reasoning_effort="medium"',
    ],
    maxArgvBytes: 65536,
  };
  const argv = [
    "exec", "--json", "--color", "never", "--skip-git-repo-check",
    "--ignore-user-config", "--ignore-rules", "--strict-config",
    "--output-schema", "/synthetic/schema.json", "--model", "gpt-6-sol",
    "--ephemeral",
    "-c", 'default_permissions="rocky_implementer"',
    "-c", 'model_reasoning_effort="medium"',
    "--sandbox", "workspace-write",
    "--", "-",
  ];
  let argvErr = null;
  try {
    assertCodexArgv(argv, input);
  } catch (e) {
    argvErr = errName(e);
  }
  obs.argvWithSandbox = argvErr;
  // Producer-level: sandbox_mode + default_permissions combination can never be emitted.
  let prodErr = null;
  try {
    buildCodexOverrideAssignments(
      [
        { key: "default_permissions", value: "rocky_implementer" },
        { key: "sandbox_mode", value: "workspace-write" },
      ],
      { maxOverrideValueBytes: 65536, maxOverrides: 64 }
    );
  } catch (e) {
    prodErr = errName(e);
  }
  obs.producerSandboxMode = prodErr;
  writeJSON(dir + "/meta.json", { probeId: "CX-P2c", obs });
  const ok =
    /codex-forbidden-flag:--sandbox/.test(argvErr || "") &&
    /codex-override-forbidden-key:sandbox_mode/.test(prodErr || "");
  const verdict = ok ? "PASS" : "REJECT";
  writeVerdict("CX-P2c", {
    verdict,
    tier: "A (assertCodexArgv + buildCodexOverrideAssignments pure modules)",
    gate: "N01 / F7 sandbox+named-permissions combination ban",
    hypothesis:
      "The sandbox+named-permissions combination can never be admitted: a --sandbox flag is rejected pre-spawn and the producer rejects sandbox_mode as a forbidden key, so a named-permission profile is always selected without a legacy sandbox switch.",
    criterion:
      "PART3 CX-P2(c): 'sandbox+named-permissions combination ⇒ assertCodexArgv rejects (codex-forbidden-sandbox-named-permissions, zero spawn) + Tier-B note of native shape if safely observable without a thread.'",
    expected:
      "codex-forbidden-flag:--sandbox (never-pass fires first) and codex-override-forbidden-key:sandbox_mode; zero spawn.",
    observed: JSON.stringify(obs),
    class: verdict === "PASS" ? "pre-spawn-combination-rejection" : "combination-admitted",
    notes:
      "HONEST NOTE: the specific codex-forbidden-sandbox-named-permissions error is a REDUNDANT defense shadowed by the never-pass --sandbox rejection (--sandbox/-s are both in CODEX_NEVER_PASS, so sawSandboxFlag is never set). The combination is still never admitted. Tier-B native shape NOT observed: spawning real codex with --sandbox risks a thread/model start, which the zero-call guarantee forbids, so per the plan's 'if safely observable without a thread' it is SKIPPED and recorded. Zero spawn.",
  });
  return verdict;
});

console.log(JSON.stringify(R.summary(), null, 2));
process.exit(R.state.stopped ? 2 : 0);
