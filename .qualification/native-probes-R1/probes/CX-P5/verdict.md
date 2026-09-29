# CX-P5 — verdict PASS

- tier: B (native codex ephemeral stdin/ordering)
- gate/scenario fed: N06 partial (ephemeral stdin/ordering) / F9 duplex shape
- hypothesis: An early config error exits without reading stdin; a prompt written after exit records the attempted-unknown duplex shape (EPIPE) against the real binary. No lifecycle claims beyond this.
- criterion (plan, quoted): PART3 CX-P5: 'early config error exits without reading stdin; slow-reader/backpressure variant (delayed prompt write after exit) records the attempted-unknown duplex shape against the real binary. No lifecycle claims beyond this.'
- expected: nonzero exit, no thread.started, late stdin write fails (EPIPE) = attempted-unknown.
- observed: {"exit":1,"threadStarted":false,"stdinNote":null}
- class: early-exit-stdin-unread
- wallMs: n/a
- exit/signal: n/a

Zero model call. Folded observation from CX-P2(b). No lifecycle claims beyond the duplex-ordering shape.
