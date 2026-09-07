# Stream Provenance

- `opencode-1.18.29-live.jsonl`: captured 2026-09-07 by `live.spec.ts` with the installed OpenCode 1.18.29 CLI, inherited authentication and native default model. Lines 1-6 are the original call, including a real `read`; lines 7-9 are `--session` continuation remembering the read word. Only the temporary marker path/title are normalized. Event IDs, timestamps, text, native usage and zero reported cost are unchanged. The model was not pinned by Rocky; this is not evidence for every model slug.
- `opencode-1.17.7-tool-call.jsonl`: inherited from NG-530 commit `8a1dc4c` and subsequent usage corrections through `0d21903`. Kept as prior parser evidence, not a new capture.
- `claude-synthetic.jsonl`: hand-authored stream contract, **not** an authenticated Claude capture. NG-643's recorded-stream/live-continuation gate remains open.
- `harness-cli.mjs`: synthetic executable for deterministic process, policy-error, timeout and cancellation tests. It never contacts a model.

`opencode-cli.spec.ts` additionally exercises the actual OpenCode CLI against local model-protocol and MCP fixtures. This proves native request/tool/config behavior without claiming external model or OAuth eligibility. No fixture contains an actual credential.
