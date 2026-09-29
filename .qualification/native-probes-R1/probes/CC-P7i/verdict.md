# CC-P7i — verdict PASS

- tier: A (ClaudeCodeAdapter.prepareLaunch + validateClaudeCodeConfig)
- gate/scenario fed: N05 10MB cap (adapter half)
- hypothesis: A prompt larger than the configured maxPromptBytes is rejected pre-spawn (zero spawn), and the config can never set maxPromptBytes above the native 10MB ceiling.
- criterion (plan, quoted): PART2 CC-P7(i): 'Tier-A adapter maxPromptBytes<cap ⇒ pre-spawn rejection, zero spawn.'
- expected: prompt-over-limit; 0 command rows; invalid-claude-config:limits.maxPromptBytes for >10MB.
- observed: {"overLimit":{"configuredMaxPromptBytes":65536,"promptBytes":70000,"refusal":"prompt-over-limit","runTreeDirs":0,"commandRows":0},"ceiling":{"attemptedMaxPromptBytes":11534336,"refusal":"invalid-claude-config:limits.maxPromptBytes"}}
- class: pre-spawn-prompt-cap-rejection
- wallMs: n/a
- exit/signal: n/a

Zero CLI process spawned.
