# R1 native probe batch — approved plan copy (executed against)

Source of authority: Taskbot ticket rocky-next#105 comments 954, 955, 956, 957 (plan), and
comment 968 (ROOT ACCEPTANCE). Plan frozen at rocky-next HEAD 651b1481c0962be528744888eb010c65ecf5bf9c.
Dispatched as R1 (sole mutation lease) under ticket #108. This file quotes the parts executed.

## Pinned identities (host-measured, never `--version`)
- claude 2.1.283 — /Users/jappy/.local/share/claude/versions/2.1.283 — sha256
  d8cb1e5c79684cc12a8bfc813e3a2073406921b6245744b3009be3ab5651d21e — 225036032 bytes (#94/872 F1).
- codex 0.157.1 — /opt/homebrew/Caskroom/codex/0.157.1/bin/codex — sha256
  27ceb5f9b957b43a519efe4eaa3816a0bffb0a531a2c89af18840c0a3c016a7d — source @36650394 (#92).
- NEVER spawn: ~/.local/bin/claude symlink, Homebrew 2.1.236, versions/2.1.233, versions/2.1.238.

## Driver principle (PART 1)
Every spawning probe runs through an owned driver script (written+hashed BEFORE first spawn) that
exercises the SHIPPED adapter entry points: reuse tests/claude-code-support.mjs /
tests/codex-exec-support.mjs fixture scaffolding with the fake binary swapped for the pinned real
binary and a synthetic host-supplied qualification (marked synthetic-unapproved), driving
ClaudeCodeAdapter/CodexExecAdapter prepareLaunch→begin (Tier-A). Evidence thereby binds to shipped
serialization: buildClaudeArgv/buildCodexArgv, buildClaudeSealedEnv/buildCodexSealedEnv,
renderClaudeSettings, codex override serializer (tomlRoundTrip), inventoryClaudeDiscovery/
inventoryCodexDiscovery, trust.ts. Bare-CLI spawns only for pre-adapter observations (native refusal
shapes the adapter intentionally never produces), each marked Tier-B in its verdict.

## Zero-turn guarantee (PART 1)
All claude non-LIVE probes use a fresh synthetic dedicated CLAUDE_CONFIG_DIR with NO credentials and
HOME=<PH>; a billable model turn is impossible (no auth path). Any startup endpoint contact attempt
is recorded, never billed. Codex probes are zero-call by construction: every case exits at
config/auth refusal before any thread starts (credits exhausted). NEVER run any CC-L* LIVE-QUOTA probe.

## NEVER-TOUCH (every probe)
real ~/.claude, ~/.claude.json, ~/.config/anthropic, real ~/.codex / real CODEX_HOME config.toml (not
even read), login keychain and ANY keychain bytes, auth/credential file bytes, user global config,
target repos, network beyond the CLI's own subscription endpoint, pinned-binary paths other than
read/hash. Managed layers (/Library/Application Support/ClaudeCode/*, MDM plists): lstat presence
only, contents never read. Isolation per the adapters' own design: CLAUDE_CONFIG_DIR / CODEX_HOME
under the temp root, sealed positive-allowlist env, PATH=/usr/bin:/bin:/usr/sbin:/sbin, fixed disable
switches.

## Failure taxonomy (PART 1)
PRODUCT_FAILURE — adapter or CLI contradicts a frozen contract claim (candidate scenario
fail/amendment; root decides). ENVIRONMENT_FAILURE — identity mismatch, fixture/temp-root fault,
driver crash, host resource exhaustion (no scenario-status effect; stop+report). MISSING_ACCESS — no
subscription login for LIVE. EXTERNAL_WAIT — subscription endpoint slowness/rate-limit within wall
cap. A CLI-side timeout/abort inside the wall cap is an OBSERVATION (exit/signal recorded and
classified), not a driver failure.

## Bounded resources (PART 1)
Serial, one probe at a time. Zero-turn: wall ≤30s (signal probes ≤45s; 10MB-cap ≤60s); stdout/stderr
capture ≤4MiB each (truncate+flag); processes = driver + one owned CLI group. Temp disk <1GiB.
Rollback: rm -rf temp roots after evidence copy. Runner makes zero git mutations DURING probes.

## Claude probe table (PART 2) — executed zero-turn subset
- CC-P0 (precondition): binary identity re-measure vs pin. No spawn. Fail ⇒ ENVIRONMENT_FAILURE, stop all.
- CC-P1 → N01 pre-spawn half (CC04/G-MANAGED analogue). Tier-A, zero spawn. Hostile fixture
  CFG/{settings.json(env ANTHROPIC_API_KEY+apiKeyHelper+SessionStart hook→sentinel), CLAUDE.md, rules/,
  skills/, agents/, plugins}; staged SRC .claude/settings.json, .mcp.json, CLAUDE.md, AGENTS.md; ancestor
  CLAUDE.md. Drive shipped inventoryClaudeDiscovery+assertClaudeDiscoveryAdmissible. PASS: named refusals
  (claude-config-dir-forbidden:…, claude-instruction-files-present:…), zero spawn, sentinel untouched. REJECT: any admission.
- CC-P2 → N05 refusal shapes (F12/F14/F16). Tier-B, unauth CFG, empty SRC, ≤30s each: (a) empty stdin ⇒ exit 1
  'Input must be provided…'; (b) whitespace-only ⇒ exit 1; (c) stream-json WITHOUT --verbose ⇒ exit 1 + exact
  stderr (F14[B]); (d) --json-schema={invalid} ⇒ error exit; (e) --effort=bogus ⇒ warn-only-and-proceed-to-auth-failure
  (confirms producer-rejection duty, FK3). Record whether startup_failure_reason frames appear under
  CLAUDE_CODE_STARTUP_FAILURE_RESULTS=1 (F16(g)). PASS: matches claim or exact divergence retained
  (PRODUCT_FAILURE candidate ⇒ amendment). REJECT: silent acceptance of invalid input.
- CC-P3 → G-SET/N04 zero-turn half. Tier-B: baseline valid Rocky settings vs deliberately invalid --settings
  (unknown key; malformed JSON; ≤3 runs). Observable: native rejection vs silent-ignore (proceeds identically to
  baseline). Direction A: rejection ⇒ hazard reduced. Direction B: silent-ignore confirmed ⇒ fail-closed pre-spawn
  validation (shipped validateClaudeSettingsBytes) BOUND mandatory. 0 turns.
- CC-P5 → N06/G-WRITES (+G-HOME partial). Tier-A begin, fresh EMPTY synthetic CFG, HOME=PH≠real; two zero-turn
  startups (empty-input refusal; valid startup ⇒ auth failure); envOptions.user true/false pair for USER/LOGNAME
  dependence. Inventory CFG children names+sha256 pre/post; observe .claude.json/caches/statsig/file-history despite
  --no-session-persistence + DISABLE_FILE_CHECKPOINTING. No keychain call. PASS: write set inventoried+bounded, all
  inside CFG/PH/PT; drift classifier agrees. REJECT: write outside ⇒ PRODUCT_FAILURE/containment.
- CC-P6 → N05 signals + stdin ordering (+N01 hook sentinel). 3 runs ≤45s: (i) hold stdin open (no EOF), hostile
  SessionStart-hook fixture: does system/init arrive before EOF (init-means-prompt-accepted [P])? sentinel written ⇒
  sealing breach, no model needed; (ii) SIGTERM owned group at T+10s ⇒ frames/exit (expect 143, NO result — FK7),
  EOFs+quiescence recorded separately; (iii) SIGINT ⇒ exact frames/exit (closes G-SIGINT or keeps unknown WITH observation).
- CC-P7 → N05 10MB cap: (i) Tier-A adapter maxPromptBytes<cap ⇒ pre-spawn rejection, zero spawn; (ii) Tier-B native
  10MB+1 stdin ⇒ nonzero error, no hang, ≤60s.
- CC-P8 → G-MODEL enumeration (decision c; NO spawn). Read-only bounded strings scan of pinned binary (grep -a, ≤256KiB
  out, only model-ID pattern lines: claude-opus/sonnet/haiku families, availableModels/alias context); command+binary
  hashed ⇒ finite candidate ID set. Bundle strings NOT runtime attestation; resolvability only via CC-L1 modelUsage.

## Codex probe table (PART 3) — ALL zero model calls
- CX-P0 (precondition): binary identity re-measure vs pin. No spawn. Fail ⇒ ENVIRONMENT_FAILURE, stop.
- CX-P1 → argv-surface binding (Tier-B, zero call): `codex exec --help` bounded capture (≤1MiB). Confirm presence+grammar
  of: --json, --color, --skip-git-repo-check, --ignore-user-config, --ignore-rules, --strict-config, --output-schema,
  --model, --ephemeral, -c, --image, `-- -` stdin form. PASS: every frozen-template flag present; absence/renaming ⇒
  PRODUCT_FAILURE candidate (argv template drift). Help text is presence evidence, not runtime attestation.
- CX-P2 → N01 strict-config/discovery slice (zero call): (a) Tier-A pure-module: serializeCodexOverride/
  buildCodexOverrideAssignments fed a value that would silently degrade to raw string (path-keyed map under dotted key) ⇒
  tomlRoundTrip pre-spawn rejection, zero spawn; (b) Tier-A prepareLaunch→begin spawn with unknown -c key under
  --strict-config ⇒ explicit native error, nonzero exit; verify stdin NOT read (F9); (c) sandbox+named-permissions
  combination ⇒ assertCodexArgv rejects (codex-forbidden-sandbox-named-permissions, zero spawn) + Tier-B note of native
  shape if safely observable without a thread. PASS: named rejections / explicit native errors, no thread.started, no model call.
- CX-P3 → auth-absence fail-closed (zero call): full valid bundle via CodexExecAdapter.prepareLaunch→begin with
  credential-less synthetic CODEX_HOME. Observables: refusal shape (exact stderr/JSONL error event names/exit code), no API
  fallback, no forced login/logout side effects, no partial thread.started, sealed-env key list retained (names only).
- CX-P4 → F5 trust-persistence, refusal-path half (zero call): synthetic shared CODEX_HOME containing config.toml with known
  synthetic bytes; run CX-P3-style refusal; captureSharedConfigToml pre/post ⇒ sha256+bytes unchanged; assert no
  projects.<path>.trust_level written. PASS: byte-identical config.toml. Any mutation ⇒ PRODUCT_FAILURE (containment breach).
- CX-P5 → N06 partial, ephemeral stdin/ordering (zero call): folded observation from CX-P2(b): early config error exits without
  reading stdin; slow-reader/backpressure variant (delayed prompt write after exit) records the attempted-unknown duplex shape.

## Ordering + abort rules (PART 4)
Ordering (strictly serial): 1. CC-P0 + CX-P0 (any fail ⇒ ENVIRONMENT_FAILURE, FULL STOP). 2. Zero-spawn adapter denials:
CC-P1, CC-P7(i), CX-P2(a),(c). 3. Tier-B claude zero-turn refusals: CC-P2(a–e), CC-P3, CC-P7(ii), CC-P5, CC-P6.
4. Codex zero-call: CX-P1, CX-P2(b), CX-P3, CX-P4, CX-P5. 5. CC-P8 G-MODEL strings enumeration.
Abort rules: identity mismatch ⇒ stop everything; two consecutive ENVIRONMENT_FAILUREs ⇒ stop batch, report gaps; driver
crash ⇒ ENVIRONMENT_FAILURE, at most one re-run; CLI wall-cap timeout ⇒ recorded observation, classified, never auto-retried;
any sentinel/oracle containment breach ⇒ STOP everything, retain all evidence, root decides. A crash/timeout of the CLI itself
is evidence, not a reason to weaken a criterion (#68). Consumed-probe list recorded so no probe silently re-runs.

## Verdict taxonomy (ticket #108)
Tier-A = drove shipped adapter entry point; Tier-B = pre-adapter native shape. Verdicts: PASS / REJECT /
ENVIRONMENT_FAILURE / PRODUCT_FAILURE_CANDIDATE. A native behavior contradicting a frozen contract claim =
PRODUCT_FAILURE_CANDIDATE (evidence for R3/amendment; the runner does NOT edit the contract).

## ROOT ACCEPTANCE (#105 comment 968, verbatim key clauses)
"Probe plan APPROVED as posted (comments 954-957, frozen at HEAD 651b148). ... R1 = sole-lease runner for ALL
zero-turn/zero-call probes both CLIs, plan-frozen hashed drivers written+hashed before first spawn, evidence
.qualification/native-probes-R1/, one evidence-retention commit after probes complete (no git mutations DURING probes);
... R3 = root-owned scenario/gate status-amendment ticket consuming accepted probe evidence (runner NEVER edits acceptance/**)."
