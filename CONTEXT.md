# Rocky

Rocky runs a developer's AI workflows for Linear issues on their own machine.
The framework supplies durable execution and integrations; editable local content
defines the requested work and its review process.

## Language

**Profile**: A machine-local definition of a coding pipeline and its repository
membership, prompts, schemas, rules, tools and environment references. A run
captures the selected profile; repository files do not choose the pipeline.

**Workflow**: A configured flow bound to an event by a Trigger. Its nodes and
connections choose the work, decisions, validation, deliverable and human checkpoints.

**Flow settings**: The commands, state names and loop limits shared by a Workflow.
Model components choose an explicit model or a Profile model slot.

**Flow node**: A configured action, decision or outcome in a Workflow. A connection
selects the next node for each possible result.

**AI component**: A model, prompt, tool or output schema supplied to an Agent by a
typed attachment connection. It is configuration, not an execution step.

**Delivery coordinator**: A packaged operation that coordinates connected Agents,
integration actions and required result contracts. Its Agent connections select
prompts, models and tool grants; those choices do not belong to coordinator code.

**Model slot**: A named agent role declared by a Workflow. The Profile selects its harness, model and effort; a Run exposes the captured selection through `ctx.models`.

**Trigger**: A binding from Linear delegation or a named manual request to a
Workflow. _Avoid_: entry point.

**Run**: One execution of a Workflow for a Linear issue, using a frozen profile
and issue snapshot. An issue has at most one live Run; later work adopts existing
issue-branch work rather than resetting it.

**Repo group**: A routing destination containing several repositories. Explicit
Profile membership determines a Run's repositories when present.

**Lead repository**: The primary repository for default SCM operations in a Run.
It is the first member of a Profile with explicit repository membership.

**Journal**: The durable history of a Run's Steps and controls. Processes and
in-memory state can be rebuilt from that history.

**Boot**: One execution or poll pass through a Run's Workflow. Recorded outcomes
are replayed before new or unfinished work proceeds.

**Parked**: A live Run waiting for a human or external condition, without holding
an execution slot. Its work and recorded conversation state remain available.

**Step**: A journaled unit of work such as an Agent call, shell command, question
or Checkpoint. Effects are at-least-once; a display-only stage marker is not a Step.

**Agent**: A prompt invoked with a harness, model, tool policy, inputs and result
schema. Its conversation belongs to that Step, including any Steer continuation.

**Capability**: A portable native tool grant: read, edit or bash. Additional tool
sources are selected as MCP servers.

**MCP server**: A tool source declared in a Profile and selected for an Agent.
Authentication belongs to the machine and is separate from the declaration.

**Harness**: The native agent CLI driven by a Rocky adapter: OpenCode, Claude
Code or Codex CLI. _Avoid_: Provider.

**Preflight**: Journaled checks of the credentials and authority needed by a Run.
SCM checks are deferred until the Workflow first needs SCM operations.

**Refusal**: Declining an admission or operation with a reason and a concrete fix.
It does not imply that a Run was started.

**Onboarding**: The retained built-in content for inspecting a repository and
preparing a seed configuration PR. Current production setup creates local Profiles.

**Question**: A request for written clarification whose answer becomes workflow
input. It does not grant merge approval.

**Checkpoint**: A human decision Step that parks until answered. An approved
Checkpoint provides the authority a Workflow must pass when requesting merge.

**Answer**: The winning resolution of a Checkpoint: approve, reject or Steer.
A written Question answer is clarification rather than approval.

**Steer**: Human redirection delivered to an Agent conversation or returned as a
Checkpoint Answer. _Avoid_: Interruption.

**Plan**: The planner's ordered proposal consumed by implementation agents.

**Delivery contract**: The agreed result and destination, including whether work
should become a PR or Linear comment and whether merge or state changes are wanted.

**Check**: One behavior the UI inspector must verify in the running application.

**Check result**: The inspector's verdict and evidence for one Check.

**Observation**: A failed UI Check's URL, screenshots and explanation. It becomes
a Complaint when anchored to a source path.

**Complaint**: A blocking review objection with an identity and source anchor.
_Avoid_: Finding, the retired review-comment concept.

**Resolution**: A fixer's reply to a Complaint: fixed, or disagreed with a reason
for the next review pass to assess.

**Rule**: Plain-language review instructions that Workflow content supplies to
its Agents.

**Transcript**: The durable raw agent stream for a Step, distinct from its
structured result and native resumable session. _Avoid_: chatter.

**Visual recap**: A revision-bound review report explaining a PR, diff or text
deliverable with annotations, diagrams, verification and available screenshots.
