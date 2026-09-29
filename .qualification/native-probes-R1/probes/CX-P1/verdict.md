# CX-P1 — verdict PASS

- tier: B (native `codex exec --help` presence evidence)
- gate/scenario fed: argv-surface binding (frozen launch.argvTemplate)
- hypothesis: Every frozen-template flag is present in `codex exec --help`: --json --color --skip-git-repo-check --ignore-user-config --ignore-rules --strict-config --output-schema --model --ephemeral -c --image (+ `-- -` stdin form).
- criterion (plan, quoted): PART3 CX-P1: 'PASS: every frozen-template flag present; any absence/renaming ⇒ PRODUCT_FAILURE candidate (argv template drift). Help text is presence evidence, not runtime attestation.'
- expected: all required flags present.
- observed: {"exit":0,"present":{"--json":true,"--color":true,"--skip-git-repo-check":true,"--ignore-user-config":true,"--ignore-rules":true,"--strict-config":true,"--output-schema":true,"--model":true,"--ephemeral":true,"-c":true,"--image":true},"missing":[],"stdinFormMentioned":false}
- class: argv-surface-present
- wallMs: n/a
- exit/signal: n/a

Help text is PRESENCE evidence only, NOT runtime attestation (stated in verdict). Zero model call (--help starts no thread).
