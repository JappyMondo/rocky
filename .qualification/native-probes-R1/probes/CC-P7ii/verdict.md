# CC-P7ii — verdict PASS

- tier: B (pre-adapter native 10MB stdin cap)
- gate/scenario fed: N05 10MB cap (native half)
- hypothesis: Native claude given 10MB+1 bytes on stdin exits nonzero without hanging, within ≤60s.
- criterion (plan, quoted): PART2 CC-P7(ii): 'Tier-B native 10MB+1 stdin ⇒ nonzero error, no hang, ≤60s.'
- expected: nonzero exit/signal; wall < 60s; not timedOut.
- observed: {"exit":1,"signal":null,"wallMs":182,"timedOut":false,"stdinNote":null}
- class: native-cap-rejection
- wallMs: n/a
- exit/signal: n/a

Zero turn (unauth). If it hit the wall cap that is a recorded observation (timedOut), classified, never auto-retried.
