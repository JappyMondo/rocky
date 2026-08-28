/**
 * PROTOTYPE (NG-572) — run it: `bun runner/demo.ts`
 *
 * Drives the real `.rocky/workflow.ts` through a full Run against a scripted
 * world, killing the "daemon" three times along the way (once while CI runs,
 * twice at the Checkpoint) and rebooting from the JSON-serialised journal.
 * What it proves:
 *   - plain TypeScript between Steps (for-loops, ifs, helpers) replays fine;
 *   - every Agent runs exactly once no matter how many boots happen;
 *   - a Checkpoint parks the Run with nothing held open, and a later boot
 *     resumes it with the human's answer.
 */
import workflow from "../.rocky/workflow.ts";
import { type Issue } from "@rocky/sdk";
import { boot, PENDING, type BootReport, type JournalEntry } from "./journal.ts";
import { FakeWorld } from "./world.ts";

const issue: Issue = {
  identifier: "NG-999",
  title: "Add pagination to the device list API",
  description: "The device list must paginate: page + pageSize params, default 50.",
  url: "https://linear.app/digimondo/issue/NG-999",
  labels: ["rocky"],
};

const world = new FakeWorld();
world.scriptAgent("planner", {
  summary: "Add page/pageSize to GET /devices, default 50, update the table's pager.",
  steps: ["extend the query layer", "wire params through the controller", "update the UI pager"],
  touchesUi: true,
});
world.scriptAgent("implementer", { summary: "Implemented pagination end to end." });
world.scriptAgent(
  "compliance-reviewer",
  { complaints: [{ file: "src/api.ts", line: 42, text: "ticket demands default pageSize 50; code defaults to 20" }] },
  { complaints: [] },
);
world.scriptAgent("ui-inspector", { complaints: [] });
world.scriptAgent(
  "reviewer",
  { complaints: [{ file: "src/api.ts", text: "page fetch issues one query per row (N+1)" }] },
  { complaints: [] },
);
world.scriptAgent(
  "fixer",
  { fixed: ["default is 50 now"], disagreed: [] },
  { fixed: ["joined the query"], disagreed: [] },
  { fixed: ["CHANGELOG.md updated"], disagreed: [] }, // the steering fix
);
world.scriptAgent("ci-fixer", { fixed: ["lint: unused import dropped"], disagreed: [] });
world.scriptCi(
  { status: "failed", failedJobs: [{ name: "lint", excerpt: "src/api.ts:3 unused import" }] },
  PENDING, // second waitForCi finds the pipeline still running -> the Run parks
  { status: "passed", failedJobs: [] }, // ...and it has passed by the next boot
  { status: "passed", failedJobs: [] }, // CI after the steering fix
);

// ── the demo harness ────────────────────────────────────────────────────────

let journal: JournalEntry[] = [];
let boots = 0;

async function bootOnce(event: string): Promise<BootReport> {
  boots++;
  // a real daemon death: only what survives JSON serialisation survives
  journal = JSON.parse(JSON.stringify(journal));
  const report = await boot(workflow, world, issue, journal);
  const end = report.outcome
    ? `finished: ${report.outcome}`
    : `parked at #${report.parkedAt!.seq} ${report.parkedAt!.label ?? report.parkedAt!.step}`;
  console.log(
    `boot #${boots} (${event}) — replayed ${report.replayed}, executed ${report.executed}, ${end}`,
  );
  return report;
}

console.log(`Run for ${issue.identifier}: ${issue.title}\n`);

await bootOnce("fresh delegation");
// parked waiting on CI; the laptop lid closes, the pipeline finishes overnight
await bootOnce("daemon restart, CI finished meanwhile");
// parked at the Checkpoint; the human reads the PR and steers
world.answerCheckpoint({ decision: "steer", message: "Please also update CHANGELOG.md" });
await bootOnce("human steered via web UI");
// parked at the Checkpoint again after the fix went green; the human approves
world.answerCheckpoint({ decision: "approve" });
const final = await bootOnce("human approved");

console.log("\n── journal ──");
for (const e of journal) {
  const flag = e.status === "done" ? "✓" : "…";
  console.log(`  ${String(e.seq).padStart(2)} ${flag} ${e.label ?? e.step}`);
}

console.log("\n── proof ──");
console.log(`  outcome: ${final.outcome}`);
console.log(`  boots: ${boots}, journal length: ${journal.length}`);
console.log(
  `  agent invocations (each ran exactly once despite ${boots} boots):`,
  world.agentCalls,
);
if (final.outcome !== "merged") throw new Error("demo expected a merge");
