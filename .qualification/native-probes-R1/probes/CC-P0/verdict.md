# CC-P0 — verdict PASS

- tier: precondition
- gate/scenario fed: G-VERSION
- hypothesis: claude 2.1.283 pinned binary identity re-measures equal to the frozen pin (sha256+bytes+path).
- criterion (plan, quoted): PART4/PART2 CC-P0/CX-P0: 'binary identity re-measure vs pin. No spawn. Fail ⇒ ENVIRONMENT_FAILURE, stop all; never spawn symlink/Homebrew/other-version paths.'
- expected: sha256=d8cb1e5c79684cc12a8bfc813e3a2073406921b6245744b3009be3ab5651d21e bytes=225036032 at /Users/jappy/.local/share/claude/versions/2.1.283
- observed: measured sha256=d8cb1e5c79684cc12a8bfc813e3a2073406921b6245744b3009be3ab5651d21e bytes=225036032 path=/Users/jappy/.local/share/claude/versions/2.1.283
- class: identity-match
- wallMs: n/a
- exit/signal: n/a

No spawn. Read/hash only. Identity matches pin; batch may proceed.
