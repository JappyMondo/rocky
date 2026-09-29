# CX-P2c — verdict PASS

- tier: A (assertCodexArgv + buildCodexOverrideAssignments pure modules)
- gate/scenario fed: N01 / F7 sandbox+named-permissions combination ban
- hypothesis: The sandbox+named-permissions combination can never be admitted: a --sandbox flag is rejected pre-spawn and the producer rejects sandbox_mode as a forbidden key, so a named-permission profile is always selected without a legacy sandbox switch.
- criterion (plan, quoted): PART3 CX-P2(c): 'sandbox+named-permissions combination ⇒ assertCodexArgv rejects (codex-forbidden-sandbox-named-permissions, zero spawn) + Tier-B note of native shape if safely observable without a thread.'
- expected: codex-forbidden-flag:--sandbox (never-pass fires first) and codex-override-forbidden-key:sandbox_mode; zero spawn.
- observed: {"argvWithSandbox":"codex-forbidden-flag:--sandbox","producerSandboxMode":"codex-override-forbidden-key:sandbox_mode"}
- class: pre-spawn-combination-rejection
- wallMs: n/a
- exit/signal: n/a

HONEST NOTE: the specific codex-forbidden-sandbox-named-permissions error is a REDUNDANT defense shadowed by the never-pass --sandbox rejection (--sandbox/-s are both in CODEX_NEVER_PASS, so sawSandboxFlag is never set). The combination is still never admitted. Tier-B native shape NOT observed: spawning real codex with --sandbox risks a thread/model start, which the zero-call guarantee forbids, so per the plan's 'if safely observable without a thread' it is SKIPPED and recorded. Zero spawn.
