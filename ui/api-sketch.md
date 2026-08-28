# What the local API must expose (derived from the variants)

Not designed up front — this is the union of what A, B, C and D actually
reached for while being built. Where they disagreed, that is noted, because
the disagreement is the decision left to make.

## Read surface

```
GET  /api/runs                     → run list: id, issue, repo, status, stage,
                                     current label, elapsed, boots, waitingSince
GET  /api/runs/:id                 → the run + its full journal
GET  /api/runs/:id/diff            → unified hunks per file, base/head sha
GET  /api/runs/:id/screenshots     → id, caption, seq that produced it
GET  /api/runs/:id/ci              → jobs, conclusion, previous attempt
GET  /api/screenshots/:id          → the PNG itself, from ~/.rocky
GET  /api/runs/:id/steps/:seq/log  → the raw harness stream for one Step
POST /api/runs/:id/checkpoint      → { decision: approve | reject | steer, message? }
```

`/api/screenshots/:id` is **not optional**: NG-567 established that Linear's
asset URLs are auth-gated, so Rocky's own UI has to serve or proxy its
screenshots regardless. The web UI and the Linear posting path share it.

## Streaming or polling

**Both, split by cost, not by taste.**

- The **run list** and **run header** poll. B redraws the whole rail on any
  change and a Run parked at a Checkpoint changes nothing for hours; a
  socket buys nothing. 2 s while a Run is active, back off to 30 s when every
  Run is parked.
- The **raw agent stream** streams (SSE, one endpoint per Step). It is the
  only thing in the UI that produces output faster than a human reads, and
  the only place where "the log stopped" is information. D and B both want
  to tail it live; A and C hide it by default.
- The **diff and screenshots** are fetched, not pushed. They only change at
  Step boundaries, which the poll already reports.

So: one polling endpoint, one SSE endpoint, and ordinary fetches. No
websocket, no shared state protocol.

## The thing the API cannot currently answer

Three of four variants render **"replayed vs executed"** — the ⟲ boot
markers in A, `boot 3` in B and C, `boots:3` in D's status line. The NG-572
journal records neither: `BootReport` counts replayed/executed for the *boot*
but the entry itself does not say which boot wrote it, and nothing records
elapsed time or the stage a Step belongs to.

Either `JournalEntry` grows `{ stage, boot, startedAt, ms }`, or the UI
reconstructs them from a separate boot log. NG-574 owns that call; this
prototype's only claim is that the UI needs the information.
