/**
 * PROTOTYPE (NG-572) — the same default Workflow as a declarative graph,
 * written to make sure the settled imperative choice is right. Verdict from
 * writing it: it is worse everywhere the pipeline is interesting.
 *
 *   - The review loop's data flow (fixer disagreements feeding the next
 *     reviewer pass) has no home: nodes only see "the last result", so state
 *     must move into a typeless `state` bag.
 *   - Loop caps become `maxVisits` annotations that the engine — not the
 *     author — enforces, and the exhaustion path becomes a magic `onExhausted`
 *     edge instead of three readable lines.
 *   - Conditions ("touchesUi && config.ui") become string-keyed guards: a
 *     config language growing inside what was supposed to be data.
 *   - Helpers, composition and types disappear: `complaintLoop` cannot be
 *     extracted, and nothing connects an agent's schema to the guard reading
 *     its output.
 *
 * The one thing the graph gives for free — a renderable picture and a
 * resume cursor — the imperative version already gets from the journal.
 */

// deliberately untyped: the typing story is exactly what a graph cannot do well
export const declarativeWorkflow = {
  start: "plan",
  nodes: {
    plan: { agent: "planner", then: "postPlan" },
    postPlan: { post: "{{plan.summary}}", then: "implement" },
    implement: { agent: "implementer", then: "compliance" },
    compliance: {
      agent: "compliance-reviewer",
      maxVisits: 5,
      onExhausted: "giveUp",
      then: [
        { when: "complaints.length == 0 && plan.touchesUi", goto: "uiInspect" },
        { when: "complaints.length == 0", goto: "review" },
        { goto: "complianceFix" },
      ],
    },
    complianceFix: { agent: "fixer", then: "compliance" },
    uiInspect: {
      agent: "ui-inspector",
      maxVisits: 5,
      onExhausted: "giveUp",
      then: [{ when: "complaints.length == 0", goto: "review" }, { goto: "uiFix" }],
    },
    uiFix: { agent: "fixer", then: "uiInspect" },
    review: {
      agent: "reviewer",
      maxVisits: 5,
      onExhausted: "giveUp",
      then: [{ when: "complaints.length == 0", goto: "push" }, { goto: "reviewFix" }],
    },
    reviewFix: { agent: "fixer", then: "review" },
    push: { exec: "git push -u origin {{run.branch}}", then: "openPr" },
    openPr: { scm: "openPr", then: "ci" },
    ci: {
      scm: "waitForCi",
      maxVisits: 3,
      onExhausted: "giveUp",
      then: [{ when: "ci.status == 'passed'", goto: "checkpoint" }, { goto: "ciFix" }],
    },
    ciFix: { agent: "ci-fixer", then: "ciPush" },
    ciPush: { exec: "git push", then: "ci" },
    checkpoint: {
      checkpoint: { title: "{{issue.identifier}} is green and mergeable" },
      then: [
        { when: "answer.decision == 'approve'", goto: "merge" },
        { when: "answer.decision == 'reject'", goto: "rejected" },
        { goto: "steerFix" }, // and how does answer.message reach the fixer? state bag.
      ],
    },
    steerFix: { agent: "fixer", then: "ciPush" },
    merge: { scm: "armAutoMerge", then: "done" },
    giveUp: { post: "Rocky is stuck…", scm: "markDraft", outcome: "exhausted" },
    rejected: { scm: "markDraft", outcome: "rejected" },
    done: { outcome: "merged" },
  },
};
