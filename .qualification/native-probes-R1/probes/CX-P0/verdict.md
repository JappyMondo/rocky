# CX-P0 — verdict PASS

- tier: precondition
- gate/scenario fed: G-VERSION
- hypothesis: codex 0.157.1 pinned binary identity re-measures equal to the frozen pin (sha256+bytes+path).
- criterion (plan, quoted): PART4/PART2 CC-P0/CX-P0: 'binary identity re-measure vs pin. No spawn. Fail ⇒ ENVIRONMENT_FAILURE, stop all; never spawn symlink/Homebrew/other-version paths.'
- expected: sha256=27ceb5f9b957b43a519efe4eaa3816a0bffb0a531a2c89af18840c0a3c016a7d bytes=238223808 at /opt/homebrew/Caskroom/codex/0.157.1/bin/codex
- observed: measured sha256=27ceb5f9b957b43a519efe4eaa3816a0bffb0a531a2c89af18840c0a3c016a7d bytes=238223808 path=/opt/homebrew/Caskroom/codex/0.157.1/bin/codex
- class: identity-match
- wallMs: n/a
- exit/signal: n/a

No spawn. Read/hash only. Identity matches pin; batch may proceed.
