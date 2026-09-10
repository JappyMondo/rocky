# Clarification and visual review

The default workflow starts with a small, read-only refiner. It checks the ticket against the repository context and asks for missing scope, behavior, constraints, or acceptance criteria before any implementation agent runs. Questions and written answers survive a daemon restart. The refiner can ask another round when an answer exposes another unresolved decision.

Once the scope is clear, Rocky posts a scope decision record to the ticket: agreed scope, decisions and rationale, acceptance criteria, exclusions, and the full clarification conversation. The augmented ticket is passed to the remaining agents. Configure the refiner through `fastAgent` in the profile's workflow and the `refiner` prompt in the profile.

Custom workflows can use the same durable building blocks:

```ts
const answer = await ctx.question({
  title: 'How should existing records behave?',
  body: 'Choose whether existing records retain their current value.',
  options: ['Preserve existing records', 'Migrate existing records'],
});
if ('cancelled' in answer) return 'rejected';
await ctx.comment(`Agreed behavior: ${answer.answer}`);
```

A question accepts a written answer through Linear or the run view. It never grants merge approval. `ctx.checkpoint` remains the separate approval gate; pass its approved answer to `ctx.scm.armAutoMerge(pr, answer)`.

## Automatic reports

For newly admitted runs, the runtime hooks `ctx.scm.openPr` and `ctx.scm.markDraft`. A ready PR/MR receives a visual review report; a draft receives one before it is marked ready. Work must be committed in the intended repository, on the issue branch, nonempty against the base, and pushed to the remote. Rocky checks Git state directly and validates the PR head instead of trusting an agent's summary.

The report agent receives the actual diff and immutable revision, ticket, refined scope, repository membership, and workflow configuration (including preview commands). It uses the profile's harness and configured MCP grants plus read and shell tools. It explains solved problems and behavior changes, with Mermaid processing diagrams and verification evidence. For visual changes it inventories affected surfaces and all available variants—states, themes, sizes, roles, feature variants, and locales—and captures real screenshots grouped by surface. When access or a preview dependency prevents a capture, that variant and its reason remain visible in the report. Configure preview commands and browser MCP grants in the profile when required by the application.

Reports and screenshot copies are stored as run artifacts, keyed by repository, PR number, and head SHA. A new revision gets a new report. Replays reuse the existing report and idempotent comment markers. Screenshot copies keep evidence for one revision independent of later captures. The runtime checks the revision again before publication so a changed branch cannot be marked ready using stale evidence.

Rocky posts the report text, diagrams, screenshot links, and a report link to both Linear and the PR/MR. The run view lists the reports and opens a grouped gallery. Rocky report URLs are machine-local, like the rest of the web UI; the public ingress continues to expose only Linear webhook and OAuth endpoints. Artifact retention applies to screenshot availability.

## Run diagnostics

Each step shows its start, duration, finish or park time, boot, and attempts. Agent steps additionally record harness, effective model when the harness reports it, variant/effort, tools, MCP servers, and timeout. Historical steps display “Not recorded” for metadata they did not save.

A failed run displays its error above the step list, including failures outside a workflow step. A reporting error is appended to the original failure instead of replacing it. Existing terminal mirror records can recover the original error for older runs without rewriting their journals. Linear's harmless Markdown normalization no longer causes an otherwise identical activity or comment to be rejected.

Runs retain their frozen workflow and feature settings. Updating a profile affects new runs; it does not insert new steps into an already-started workflow's replay history.
