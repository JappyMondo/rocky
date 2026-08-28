# PROTOTYPE — NG-573: the local web UI

**Throwaway.** This branch answers one question: *what does it feel like to
watch a Run, and to be called into one?* Nothing here is the implementation.

## The answer (Jappy, 2026-08-28)

**A — Inbox wins**, with C's diff grafted in.

1. **A is the structure.** A Run is a thread; a Checkpoint is an unread
   message that wants a reply. The run list is a mail list, and "history"
   is just older mail.
2. **C's diff replaces A's.** Opening the diff attachment expands into a
   real viewer — file list, `j`/`k` between files, and every reviewing
   Agent's Complaint anchored at the line that raised it. A's flat inline
   block was the weakest thing in the winning variant; inline-anchored
   Complaints were the strongest single idea in any of them.
3. **Chatter stays folded per message**, as prototyped: conclusions by
   default, raw stream one click away per Step.
4. **The TUI question is closed.** D did not change the call — the web UI
   stands and a TUI stays out of scope for v1.

Everything below is the prototype as it was reacted to, kept as the primary
source. Nothing here gets promoted; the winning design gets rewritten
properly when it is built.

## Run it

Double-click **`rocky-ui-prototype.html`** — one self-contained file, no
server, no network, no dependencies.

Or serve it, if you would rather edit and reload:

```sh
bun run ui          # http://localhost:4173
bun run build       # regenerate rocky-ui-prototype.html after an edit
```

`←` / `→` cycles the variant. `` ` `` dumps the raw journal over whatever is
drawn — every variant is a *reading* of that one list, and the dump is there
so you can check the reading against the source.

## What you are reacting to

Four **structurally different** answers, on one route, switched by
`?variant=`. They disagree about what a Run fundamentally *is*:

| | Variant | The bet | Navigate with |
| --- | --- | --- | --- |
| **A** | **Inbox** | Rocky is a correspondent. A Run is a thread; a Checkpoint is an unread message that wants a reply. Chatter is quoted text, artifacts are attachments. | `j`/`k` runs, `o` chatter, `e`/`r`/`s` answer, `u` back |
| **B** | **Pipeline rail** | A Run is a build, and you learn a build by learning *where things are*. Fixed stage rail up top, artifact pane always populated on the right, chatter in a drawer. | `h`/`l` or `1`–`9` stages, `d`/`p`/`c` artifact tabs, `~` log, `a` approve |
| **C** | **Review desk** | Whatever else it did, what you are signing off is *code*. The diff is the page; the Run is a project tree; one persistent conversation carries commentary and the decision. | `cmd+k` palette, `j`/`k` files, `a` approve |
| **D** | **Terminal** | Not a style — the ticket's own TUI question, answered with evidence instead of assertion. Real TUI shape, screenshots at real terminal fidelity. | `j`/`k`, `z` noise, `:` commands, `a`/`x` |

The interesting reaction is usually **"the header from B with the diff from
C"** — that mix is the actual design, and it is what to say out loud.

## The data is not made up

`ui/data.js` carries the **exact `JournalEntry` shape** from the NG-572
runner, produced by the **exact default Workflow** on
`prototype/ng-572-workflow-authoring`: `changedFiles` before every reviewing
Agent, `agent:fixer` labelled `fixer 1/5`, `scm:waitForCi` twice with a
`ci-fixer 1/3` between them, and `#27 checkpoint` sitting at `waiting`.

The Run has been through **three daemon boots**, because a UI that cannot
render "this Step was replayed, not executed" is a UI that lies about the
thing NG-572 spent its whole prototype proving.

Fields marked ⓘ in `data.js` (`stage`, `ms`, `boot`, `chatter`, `tokens`) are
**not journaled today**. That gap is a finding, not an oversight — see below.

## What each variant is being asked to prove

1. **How is a loop on its third iteration shown?** A: `pass 3 of 5` badge in
   the message header. B: pips on the rail orb (`●●○○○`). C: siblings in a
   tree folder. D: a flat list you scroll.
2. **How much agent chatter by default, and how do you reach the raw
   stream?** A: folded quote per message. B: one drawer for the whole Run.
   C: `…` per turn plus the full result JSON in the centre pane. D: always
   inline, `z` toggles the bookkeeping Steps.
3. **Do screenshots and diffs earn a web UI?** Compare the split diff in B,
   the annotated diff in C, and then look at `iter1.png` in D.
4. **Does keyboard-first survive contact with a diff viewer?** C is the
   honest test: `cmd+k` + `j`/`k` over files, mouse never required.
5. **What is "history" locally?** A: a mail list. B: a strip of chips.
   C: an activity rail. D: tabs.

## Findings the prototype already forces

- The journal alone **cannot drive any of these**. Every variant needed
  `stage`, elapsed time, and boot number, and three of four needed a chatter
  stream. Either the journal grows those fields or the UI reads a second
  source. This is NG-574's to settle, and the UI is the reason it matters.
- **Complaints want a file and a line.** C anchors them inline in the diff,
  which is the single most useful thing any variant does — and it only works
  for the one Complaint in the fixture that carries `line`. NG-575 should
  treat `file`/`line` as close to required, not optional.
- **A Checkpoint is not one screen.** Every variant ended up rendering it
  twice: as an item in a list ("this one wants you") and as a decision
  surface. The list rendering is what makes three parked Runs legible.
- See `ui/api-sketch.md` for what the local API has to expose, and the
  streaming-versus-polling answer the variants converged on.

## What is deliberately fake

No backend, no persistence, no mutations: every decision button shows what
*would* be journaled and stops. `ui/serve.ts` is a static file server. The
screenshots are inline SVG. Read-only is the point — the question is what
this should look like, not whether it works.
