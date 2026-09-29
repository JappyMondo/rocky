# CX-P4 — verdict PASS

- tier: A (CodexExecAdapter.prepareLaunch→begin; captureSharedConfigToml pre/post)
- gate/scenario fed: F5 trust-persistence (refusal-path half) / N01
- hypothesis: Across a CX-P3-style pre-model refusal, the shared synthetic config.toml is byte-identical (sha256+bytes unchanged) and no projects.<path>.trust_level is written.
- criterion (plan, quoted): PART3 CX-P4: 'captureSharedConfigToml pre/post ⇒ sha256+bytes unchanged; assert no projects.<path>.trust_level written. PASS: byte-identical config.toml. Any mutation ⇒ PRODUCT_FAILURE (containment breach).'
- expected: pre.sha256==post.sha256 && pre.bytes==post.bytes && drift==null && no trust_level.
- observed: {"pre":{"path":"/private/var/folders/0s/94wd01s17jsdg_7jk3zfqsd40000gn/T/opencode/native-probes-r1-CX-P4-auB2ru/codex-home/config.toml","sha256":"e20e162652098c9fa14a48c248f5a91126ac4544ecaaf5f7a400b333403eacc1","bytes":88},"post":{"path":"/private/var/folders/0s/94wd01s17jsdg_7jk3zfqsd40000gn/T/opencode/native-probes-r1-CX-P4-auB2ru/codex-home/config.toml","sha256":"e20e162652098c9fa14a48c248f5a91126ac4544ecaaf5f7a400b333403eacc1","bytes":88},"drift":null,"trustWritten":false}
- class: config-toml-byte-identical
- wallMs: n/a
- exit/signal: n/a

Zero model call. Full F5 proof (thread/start with writable cwd persisting trust) REQUIRES a model turn ⇒ credit-blocked, stays open. A mutation here would be a containment breach ⇒ PRODUCT_FAILURE_CANDIDATE (and the agent would STOP).

## RE-RUN CONFIRMATION + STRENGTHENING (remediation re-run, run-remediate.mjs, zero-call)
The documented single remediation re-run (rerun-cx-p4.json) reproduced the result byte-for-byte: config.toml sha256
e20e162652098c9fa14a48c248f5a91126ac4544ecaaf5f7a400b333403eacc1 / 88 bytes BOTH pre and post, drift=null, no
trust_level/projects. written. IMPORTANT STRENGTHENING: the re-run's frame capture (see CX-P3) shows codex actually
EMITTED thread.started + turn.started during this refusal — i.e. a thread WAS started, which is precisely the condition
under which the pinned source would normally persist `projects."<cwd>".trust_level="trusted"` into the shared config.toml.
The explicit `projects.<canonical staged root>.trust_level="untrusted"` override (trust.ts) PREVENTED that mutation. So the
F5 refusal-path defense is confirmed under the real thread-start condition, not merely a no-op early exit. (Full F5 proof
under a successful writable-cwd model turn remains credit-blocked.) Verdict stands: PASS.
