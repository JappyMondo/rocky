/** Regenerate only a retained recap using current prompts; never resume its delivery workflow.
 * Usage: node tools/refresh-recap.mjs RUN_ID REPORT_ID
 * Writes a separate journal under the run and a new immutable local report. No publication.
 */
import { createJiti } from 'jiti';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const jiti = createJiti(import.meta.url);
const source = (path) =>
  jiti.import(
    new URL(`../packages/daemon/src/${path}.ts`, import.meta.url).href,
  );
const [
  { rockyPaths },
  { LocalArtifacts },
  { readJournal },
  { runBoot },
  { createAgent },
  { getHarnessAdapter },
  { generateReport, recapId },
  { recapWorkflowEvidence, recapRepositoryEvidence },
  { readInstanceConfig },
] = await Promise.all([
  source('config/paths'),
  source('local-api/artifacts'),
  source('run/journal'),
  source('run/replay'),
  source('run/agent'),
  source('harness/adapter'),
  source('review-report/reporter'),
  source('review-report/evidence'),
  source('config/store'),
]);
const [runId, reportId, refreshKey] = process.argv.slice(2);
if (!runId || !reportId)
  throw new Error('Usage: node tools/refresh-recap.mjs RUN_ID REPORT_ID');
const paths = rockyPaths();
const p = paths.run(runId);
const artifacts = new LocalArtifacts(paths);
const old = await artifacts.readReport(runId, reportId);
const run = JSON.parse(await readFile(p.runJson, 'utf8'));
const journal = await readJournal(p.journal);
const config = await readInstanceConfig(paths);
const shell = promisify(execFile);
const git = async (cwd, ...args) =>
  (
    await shell('git', args, { cwd, timeout: 30000, maxBuffer: 8_000_000 })
  ).stdout.trim();
const members = run.execution?.members ?? [];
const lead = members.find((member) => member.name === old.pr?.repo);
const leadDir = lead && join(p.workspaceDir, lead.path);
if (!leadDir || !old.pr)
  throw new Error(
    'This refresh command requires a retained PR recap and its workspace.',
  );
const head = await git(leadDir, 'rev-parse', 'HEAD');
if (head !== old.pr.headSha || (await git(leadDir, 'status', '--porcelain')))
  throw new Error('The reviewed workspace revision changed or is dirty.');
const remoteHead = await git(
  leadDir,
  'ls-remote',
  'origin',
  `refs/heads/${run.branch}`,
);
if (!remoteHead.startsWith(head + '\t'))
  throw new Error('Remote branch no longer matches the retained report.');
const diff = await git(leadDir, 'diff', `${old.pr.baseSha}...${head}`);
const workflowEvidence = recapWorkflowEvidence(journal.entries, head);
workflowEvidence.repositories = await recapRepositoryEvidence({
  workspaceDir: p.workspaceDir,
  branch: run.branch,
  members,
  primaryRepo: old.pr.repo,
});
// Delivery repairs have their own journal, so evidence keeps its source and step identity.
try {
  const repair = await readJournal(
    join(p.dir, 'delivery-repair', 'journal.jsonl'),
  );
  const evidence = recapWorkflowEvidence(repair.entries, head);
  workflowEvidence.receipts.push(
    ...evidence.receipts.map((receipt) => ({
      ...receipt,
      stepKey: `delivery-repair/${receipt.stepKey}`,
      source: 'delivery-repair/journal.jsonl',
    })),
  );
  workflowEvidence.deliveryRepair = JSON.parse(
    await readFile(
      join(p.dir, 'delivery-repair', 'pull-requests.json'),
      'utf8',
    ),
  );
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
// Reuse earlier analysis as a writing reference, while keeping execution evidence separate.
// The writer and auditor must still check claims against the diff and current evidence.
workflowEvidence.previousRecap = {
  source: 'Earlier AI-written recap; not execution evidence',
  goal: old.goal,
  summary: old.summary,
  requirements: old.requirements,
  behavior: old.behavior,
  reviewFocus: old.reviewFocus,
};
const id = recapId({ pr: old.pr, enhanced: true, version: 2, refreshKey });
const refreshDir = join(p.dir, 'recap-refresh', id);
await mkdir(join(refreshDir, 'sessions'), { recursive: true });
await writeFile(
  join(refreshDir, 'evidence.json'),
  JSON.stringify(workflowEvidence, null, 2) + '\n',
  { mode: 0o600 },
);
const selection = run.profile?.models?.review;
if (!selection?.model || !selection?.harness)
  throw new Error('The run has no explicit review model.');
const harness = selection.harness;
const settings = config.harnesses[harness] ?? {};
const result = await runBoot({
  journalPath: join(refreshDir, 'journal.jsonl'),
  workflow: async (steps) => {
    const agent = createAgent(steps, {
      screenshotDir: p.screenshotsDir,
      snapshotDir: p.snapshotDir,
      cwd: p.workspaceDir,
      sessionDir: join(refreshDir, 'sessions'),
      harness,
      harnesses: {
        [harness]: {
          command: settings.command ?? harness,
          env: { ...process.env, ...settings.env },
          sessionStorage: 'rocky',
        },
      },
      adapterFor: getHarnessAdapter,
      onEvent: (stepKey, event) => {
        if (event.kind === 'tool-call')
          console.log(`Step ${stepKey}: ${event.name}`);
      },
    });
    const report = await generateReport({
      steps,
      agent,
      agentOptions: { ...selection, tools: ['read'], mcp: [], timeout: 900000 },
      artifacts,
      runId,
      pr: old.pr,
      pullRequests: workflowEvidence.deliveryRepair ?? old.pullRequests,
      baseSha: old.pr.baseSha,
      diff,
      enhanced: true,
      version: 2,
      refreshKey,
      issue: run.issue,
      scope: workflowEvidence.scopeDecision,
      workflowEvidence,
      screenshotDir: p.screenshotsDir,
      workspace: members,
      port: run.ports?.[0],
    });
    if (
      (await git(leadDir, 'rev-parse', 'HEAD')) !== head ||
      (await git(leadDir, 'status', '--porcelain'))
    )
      throw new Error('Workspace changed during recap generation.');
    await writeFile(
      join(refreshDir, 'report.json'),
      JSON.stringify(report, null, 2) + '\n',
      { mode: 0o600 },
    );
    console.log(
      `Report: http://localhost:${config.server.port}/runs/${runId}?report=${report.id}`,
    );
    return 'completed';
  },
});
console.log(JSON.stringify(result));
if (result.status !== 'finished') process.exitCode = 1;
