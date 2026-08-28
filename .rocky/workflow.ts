/**
 * PROTOTYPE (NG-572) — the default Workflow Rocky ships, as a file you would
 * actually find in your repo after onboarding.
 *
 * Everything here is ordinary TypeScript. Only `ctx.*` calls are journaled
 * Steps; the code between them (loops, ifs, helpers, template literals)
 * re-executes deterministically on resume. There is no ctx.loop combinator:
 * a plain `for` survives replay because every Step inside it returns its
 * journaled result.
 */
import {
  defineWorkflow,
  type Pr,
  type WorkflowContext,
} from "@rocky/sdk";
import { FixReport, Plan, Review, WorkReport, type Complaint } from "./schemas";
import config from "./config";

export default defineWorkflow(async (ctx) => {
  // ── Plan ──────────────────────────────────────────────────────────────
  const plan = await ctx.agent("planner", {
    input: { issue: ctx.issue },
    schema: Plan,
  });
  // Posted to Linear for the record; deliberately does not block (the
  // Checkpoint at the end is the one human gate).
  await ctx.post(
    `### Plan\n${plan.summary}\n\n${plan.steps.map((s) => `1. ${s}`).join("\n")}`,
  );

  // ── Implement ─────────────────────────────────────────────────────────
  await ctx.agent("implementer", {
    input: { issue: ctx.issue, plan },
    schema: WorkReport,
  });

  // ── Compliance: does the change do what the ticket asked? ─────────────
  const compliance = await complaintLoop(ctx, "compliance-reviewer");
  if (compliance.length > 0) return giveUp(ctx, "compliance review", compliance);

  // ── UI inspection, only when the change touches UI ────────────────────
  if (plan.touchesUi && config.ui) {
    const ui = await complaintLoop(ctx, "ui-inspector");
    if (ui.length > 0) return giveUp(ctx, "UI inspection", ui);
  }

  // ── Code review ───────────────────────────────────────────────────────
  const review = await complaintLoop(ctx, "reviewer");
  if (review.length > 0) return giveUp(ctx, "code review", review);

  // ── Open the PR ───────────────────────────────────────────────────────
  await ctx.exec(`git push -u origin ${ctx.branch}`);
  const pr = await ctx.scm.openPr({
    title: `${ctx.issue.identifier}: ${ctx.issue.title}`,
    body: `Closes ${ctx.issue.url}\n\n${plan.summary}`,
  });

  // ── CI: watch, fix, repeat ────────────────────────────────────────────
  if (!(await ciLoop(ctx, pr))) return giveUp(ctx, "CI", [], pr);

  // ── Checkpoint: the one human gate, after everything is green ─────────
  while (true) {
    const answer = await ctx.checkpoint({
      title: `${ctx.issue.identifier} is green and mergeable`,
      body: `${pr.url}\n\n${plan.summary}`,
    });
    if (answer.decision === "approve") break;
    if (answer.decision === "reject") {
      await ctx.scm.markDraft(pr);
      await ctx.post(`Checkpoint rejected — leaving ${pr.url} as a draft.`);
      return "rejected";
    }
    // Steer: the human's words go straight to the fixer, then back to green
    // and back to the Checkpoint. Steering never skips CI.
    await ctx.agent("fixer", {
      input: { instruction: answer.message },
      schema: FixReport,
    });
    await ctx.exec("git push");
    if (!(await ciLoop(ctx, pr))) return giveUp(ctx, "CI after steering", [], pr);
  }

  // ── Merge, through the platform's own controls ────────────────────────
  if ((await ctx.scm.updateBranch(pr)) === "conflict") {
    await ctx.agent("merger", {
      input: { pr, issue: ctx.issue },
      schema: WorkReport, // resolves conflicts in the worktree
    });
    await ctx.exec("git push --force-with-lease");
    if (!(await ciLoop(ctx, pr))) return giveUp(ctx, "CI after rebase", [], pr);
  }
  await ctx.scm.armAutoMerge(pr); // the platform (queue, train, button) merges
  return "merged";
});

// ── Helpers: plain functions, because a Workflow is just a module ─────────

/**
 * Review → fix → review until clean or the cap burns. Fixer disagreements go
 * back to the reviewer on the next pass; if the reviewer insists and the
 * fixer keeps disagreeing, the cap burns and the Complaints surface to the
 * human. A loop never "passes" what it did not satisfy.
 */
async function complaintLoop(
  ctx: WorkflowContext,
  reviewer: string,
): Promise<Complaint[]> {
  const cap = config.caps.review;
  let disagreed: FixReport["disagreed"] = [];
  for (let attempt = 1; attempt <= cap; attempt++) {
    const { complaints } = await ctx.agent(reviewer, {
      input: {
        issue: ctx.issue,
        changedFiles: await ctx.changedFiles(),
        fixerDisagreed: disagreed,
      },
      schema: Review,
      label: `${reviewer} ${attempt}/${cap}`,
    });
    if (complaints.length === 0) return [];
    if (attempt === cap) return complaints;
    const fix = await ctx.agent("fixer", {
      input: { complaints },
      schema: FixReport,
      label: `fixer ${attempt}/${cap}`,
    });
    disagreed = fix.disagreed;
  }
  return [];
}

/** Watch CI, hand failures to the ci-fixer, up to the cap. True = green. */
async function ciLoop(ctx: WorkflowContext, pr: Pr): Promise<boolean> {
  const cap = config.caps.ci;
  for (let attempt = 1; attempt <= cap; attempt++) {
    const ci = await ctx.scm.waitForCi(pr); // parks the Run; polling is the runner's business
    if (ci.status === "passed") return true;
    if (attempt === cap) return false;
    await ctx.agent("ci-fixer", {
      input: { failedJobs: ci.failedJobs },
      schema: FixReport,
      label: `ci-fixer ${attempt}/${cap}`,
    });
    await ctx.exec("git push");
  }
  return false;
}

/** The exhaustion path: draft PR, post the unresolved Complaints, stop. */
async function giveUp(
  ctx: WorkflowContext,
  stage: string,
  complaints: Complaint[],
  pr?: Pr,
): Promise<"exhausted"> {
  if (pr) await ctx.scm.markDraft(pr);
  await ctx.post(
    [
      `Rocky is stuck: **${stage}** did not converge within its cap.`,
      ...complaints.map((c) => `- ${c.file ?? ""}${c.line ? `:${c.line}` : ""} ${c.text}`),
      pr ? `The PR is parked as a draft: ${pr.url}` : `No PR was opened.`,
    ].join("\n"),
  );
  return "exhausted";
}
