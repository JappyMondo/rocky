# CC-P1 — verdict PASS

- tier: A (drove shipped inventoryClaudeDiscovery + assertClaudeDiscoveryAdmissible + ClaudeCodeAdapter.prepareLaunch)
- gate/scenario fed: N01 pre-spawn half / CC04 / G-MANAGED analogue
- hypothesis: Hostile CFG children, staged/ancestor instruction files and a present managed layer each yield a NAMED pre-spawn refusal, zero spawn, and the SessionStart-hook sentinel is never written.
- criterion (plan, quoted): PART2 CC-P1: 'PASS: named refusals (claude-config-dir-forbidden:…, claude-instruction-files-present:…), zero spawn, sentinel untouched. REJECT: any admission.'
- expected: claude-config-dir-forbidden + claude-instruction-files-present (+ claude-managed-layer-present); prepareLaunch refuses pre-spawn (no INP settings rendered, no command row); sentinel absent.
- observed: {"A":"claude-config-dir-forbidden:CLAUDE.md,agents,plugins,rules,settings.json,skills","B":"claude-instruction-files-present:/private/var/folders/0s/94wd01s17jsdg_7jk3zfqsd40000gn/T/opencode/native-probes-r1-CC-P1-akW0Mq/run/stage/source/.claude,/private/var/folders/0s/94wd01s17jsdg_7jk3zfqsd40000gn/T/opencode/native-probes-r1-CC-P1-akW0Mq/run/stage/source/.mcp.json,/private/var/folders/0s/94wd01s17jsdg_7jk3zfqsd40000gn/T/opencode/native-probes-r1-CC-P1-akW0Mq/run/stage/source/AGENTS.md,/private/var/folders/0s/94wd01s17jsdg_7jk3zfqsd40000gn/T/opencode/native-probes-r1-CC-P1-akW0Mq/run/stage/source/CLAUDE.md","C":"claude-managed-layer-present:/private/var/folders/0s/94wd01s17jsdg_7jk3zfqsd40000gn/T/opencode/native-probes-r1-CC-P1-akW0Mq/managed/managed-settings.json","tierA":{"refusal":"claude-config-dir-forbidden:settings.json","runTreeDirs":1,"inpSettingsRendered":false,"commandRows":0,"stageInstructionRefusal":"claude-instruction-files-present:/private/var/folders/0s/94wd01s17jsdg_7jk3zfqsd40000gn/T/opencode/native-probes-r1-CC-P1-akW0Mq/tierA2/runs/run-e1cb98ce7d1d9a8458ed7da046492ea3/stage/source/CLAUDE.md","stageCommandRows":0},"sentinelUntouched":true}
- class: named-pre-spawn-refusal
- wallMs: n/a
- exit/signal: n/a

namedOk=true tierAOk=true sentinelOk=true. Zero CLI process spawned (pure modules + prepareLaunch only).
