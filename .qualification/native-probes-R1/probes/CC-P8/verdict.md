# CC-P8 — verdict PASS

- tier: static (bundle strings; NOT runtime attestation)
- gate/scenario fed: G-MODEL (enumeration half; decision c)
- hypothesis: A bounded read-only grep of the pinned claude 2.1.283 bundle yields a finite candidate set of claude model IDs (opus/sonnet/haiku families + availableModels/alias context) for the host-frozen role table.
- criterion (plan, quoted): PART2 CC-P8 / PART4 G-MODEL step: 'bounded read-only strings extraction of model-ID tables from the pinned 2.1.283 bundle (output-capped, pattern-filtered, command+binary hashed), yielding a candidate ID list for the host-frozen role table; bundle strings explicitly NOT runtime attestation — actual resolvability comes only from CC-L1 modelUsage/assistant.message.model or stays open.'
- expected: a nonempty finite candidate ID set; command+binary hashed.
- observed: {"candidateCount":350,"sample":["claude-1.3","claude-1.3-100k","claude-2.0","claude-2.1","claude-3","claude-3-","claude-3-5-haiku","claude-3-5-haiku-20241022","claude-3-5-haiku-20241022-v1","claude-3-5-haiku-latest","claude-3-5-sonnet","claude-3-5-sonnet-20241022","claude-3-5-sonnet-20241022-v2","claude-3-5-sonnet-v2","claude-3-7-sonnet","claude-3-7-sonnet-20250219","claude-3-7-sonnet-20250219-v1","claude-3-7-sonnet-latest","claude-3-haiku","claude-3-opus","claude-3-opus-20240229","claude-3-sonnet","claude-3-sonnet-20240229","claude-4-opus-20250514","claude-agent-sdk","claude-ai","claude-ai-external-token","claude-ai-oauth","claude-ai.staging.ant.dev","claude-api","claude-apps-gateway","claude-artifact-preview-","claude-audio-","claude-channel-","claude-checkpoint-index.","claude-chrome-screenshots-","claude-cli","claude-cli-design-sync","claude-cli-design-tool","claude-cli-internal"],"binaryShaReverified":true,"extractionCmdSha":[{"label":"claude-family","cmdSha256":"4728b5da26bd25a7c35bbc53c1b363e06cb05775635579d50a7aa678684da07d","uniqueCount":309},{"label":"dated-names","cmdSha256":"6dae089e8ed8faa489a2fbb1f04576284494ea15f5b5d7c900a07c51959718c0","uniqueCount":41},{"label":"claude-opus-sonnet-haiku","cmdSha256":"8b691a343477288f79a5ed88453a1ffb20eae7ec6e77b992effedc23f4d82c06","uniqueCount":36},{"label":"available-models-context","cmdSha256":"4ee2a20b221718682ba4811956bf31ab35d001e28bbb9e3353e61a9a3ba83b8d","uniqueCount":0}]}
- class: candidate-id-set-enumerated
- wallMs: n/a
- exit/signal: n/a

FLAG: these are BUNDLE STRINGS, not runtime-attested model IDs. Resolvability of any candidate (incl. the host role-table models) is established ONLY by CC-L1 modelUsage (LIVE, NOT run in R1) or stays open. qwen3.8-max/OpenCode-chain resolvability is #104, out of scope. No spawn of the pinned binary (read-only grep).

## ADDENDUM — refined G-MODEL candidate set (post-hoc filter of the retained extraction data)
The broad `claude-*` pattern (350 raw tokens) includes non-model strings (claude-ai, claude-cli, claude-agent-sdk,
claude-apps-gateway, claude-ai-oauth, …). Filtering to genuine model-family tokens yields **99 refined candidates**
(persisted at probes/CC-P8/refined-model-candidates.json), by family: opus=37, sonnet=37, haiku=17, instant=3, legacy=5.
Representative IDs (BUNDLE STRINGS, not runtime-attested):
- opus: claude-opus-4, claude-opus-4-0, claude-opus-4-1(-20250805/-v1), claude-opus-4-20250514(-v1), claude-opus-4-5(-20251101/-v1), claude-opus-4-6(-v1), claude-opus-4-7, claude-opus-4-8, claude-opus-5, claude-opus-5-5, claude-3-opus(-20240229), claude-4-opus-20250514
- sonnet: claude-sonnet-4, claude-sonnet-4-0, claude-sonnet-4-20250514(-v1), claude-sonnet-4-5(-20250929/-v1), claude-sonnet-4-6, claude-sonnet-5, claude-3-5-sonnet(-20241022/-v2/latest), claude-3-7-sonnet(-20250219/-v1/latest), claude-3-sonnet(-20240229)
- haiku: claude-haiku-3-5, claude-haiku-4-5(-20251001/-v1), claude-3-5-haiku(-20241022/-v1/latest), claude-3-haiku
- instant/legacy: claude-instant-1.1(-100k), claude-instant-1.2, claude-1.3(-100k), claude-2.0, claude-2.1, claude-3
NOTE: the bundle references FORWARD/unreleased-looking IDs (claude-opus-4-6/4-7/4-8/5/5-5, claude-sonnet-4-6/5,
claude-haiku-4-5); these are registry/alias strings in the binary — their runtime resolvability is NOT attested (CC-L1, LIVE, not run).
The `availableModels` context pattern matched 0 lines (that literal is not present in a grep-matchable form in the bundle), so the
alias-table context could not be extracted by that pattern; the model-family IDs above come from the claude-* and dated-name patterns.
Verdict stands PASS (a finite, hashed, output-capped candidate ID set was enumerated for the host-frozen role table).
