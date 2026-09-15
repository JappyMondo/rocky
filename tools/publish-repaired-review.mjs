/** Finish a reviewed delivery repair without approving or merging.
 * Usage: rocky exec --profile PROFILE -- node tools/publish-repaired-review.mjs RUN REPORT ready|publish
 */
import { createJiti } from 'jiti';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
const jiti = createJiti(import.meta.url);
const source = (path) =>
  jiti.import(
    new URL(`../packages/daemon/src/${path}.ts`, import.meta.url).href,
  );
const [
  { rockyPaths },
  { readInstanceConfig },
  { runBoot },
  { readJournal },
  { LocalArtifacts },
  { PublicReviews },
  { createGitLabScm, createGitHubScm },
  { sourceControlToken },
  { reviewRevision },
  { createInstanceLinearClient },
] = await Promise.all([
  source('config/paths'),
  source('config/store'),
  source('run/replay'),
  source('run/journal'),
  source('local-api/artifacts'),
  source('review-report/public'),
  source('scm/index'),
  source('config/source-control'),
  source('review-report/workspace'),
  source('linear/instance-client'),
]);
const [runId, reportId, mode] = process.argv.slice(2);
if (!runId || !reportId || !['ready', 'publish'].includes(mode))
  throw new Error('Usage: RUN REPORT ready|publish');
const paths = rockyPaths(),
  p = paths.run(runId),
  dir = join(p.dir, 'delivery-repair');
const run = JSON.parse(await readFile(p.runJson, 'utf8'));
if (run.status !== 'parked')
  throw new Error('Run must remain parked for human approval.');
const config = await readInstanceConfig(paths);
if (!config.publicUrl) throw new Error('A public URL is required.');
const report = await new LocalArtifacts(paths).readReport(runId, reportId);
const prs = JSON.parse(await readFile(join(dir, 'pull-requests.json'), 'utf8'));
const repairJournal = await readJournal(join(dir, 'journal.jsonl'));
for (const pr of prs) {
  const receipt = repairJournal.entries.findLast(
    (entry) =>
      entry.status === 'done' &&
      entry.step.startsWith(`scm.waitForCi:${pr.repo}:`),
  )?.result;
  if (
    !receipt ||
    receipt.headSha !== pr.headSha ||
    !['passed', 'not-configured'].includes(receipt.status)
  )
    throw new Error(`${pr.repo}: delivery checks are incomplete.`);
}
const primary = prs.find((pr) => pr.repo === report.pr?.repo);
if (!primary || primary.headSha !== report.pr.headSha)
  throw new Error('Review does not match the delivery.');
const signal = AbortSignal.timeout(120000);
const adapters = new Map();
for (const pr of prs) {
  const member = run.execution.members.find((m) => m.name === pr.repo);
  await reviewRevision(
    join(p.workspaceDir, member.path),
    run.branch,
    member.baseBranch,
    pr.headSha,
    process.env,
  );
  const match = member.url.match(/(github|gitlab)\.com[/:](.+?)(?:\.git)?$/);
  const token = await sourceControlToken(match[1], process.env, {
    signal,
    allowCli: true,
  });
  const input = {
    repo: { id: member.name, project: match[2], baseBranch: member.baseBranch },
    branch: run.branch,
    token,
    signal,
  };
  adapters.set(
    pr.repo,
    match[1] === 'gitlab' ? createGitLabScm(input) : createGitHubScm(input),
  );
}
const result = await runBoot({
  journalPath: join(dir, `${mode}-${reportId}.journal.jsonl`),
  workflow: async (steps) => {
    if (mode === 'ready') {
      const ready = [];
      for (const pr of prs)
        ready.push(
          await steps.step(
            `scm.markDraft:${pr.repo}`,
            { label: `Ready for review: ${pr.repo}` },
            async () => {
              const next = await adapters.get(pr.repo).markDraft(pr, false);
              if (next.headSha !== pr.headSha || next.state !== 'open')
                throw new Error('PR changed during publication.');
              return { status: 'done', result: next };
            },
          ),
        );
      await writeFile(
        join(dir, 'ready-pull-requests.json'),
        JSON.stringify(ready, null, 2) + '\n',
        { mode: 0o600 },
      );
      console.log(
        'Both PRs are ready for review. Merge approval remains pending.',
      );
    } else {
      const url = await steps.step(
        'reviewReport.share',
        { label: 'Publish standalone review' },
        async () => ({
          status: 'done',
          result: await new PublicReviews(paths).publish(
            report,
            config.publicUrl,
          ),
        }),
      );
      const body = [
        `## ${run.issue.identifier}: review both PRs`,
        `[Open the guided review](${url})`,
        report.summary,
        ...prs.map((pr) => `- [${pr.repo} !${pr.number}](${pr.url})`),
        'Niotix CI passed. GitOps YAML and the 28-day setting were checked; that repository has no CI pipeline.',
        'Both PRs are ready for review. Nothing has been merged.',
      ].join('\n\n');
      for (const pr of prs)
        await steps.step(
          `reviewReport.publish:${pr.repo}`,
          { label: `Post shared review: ${pr.repo}` },
          async () => {
            await adapters
              .get(pr.repo)
              .postReviewReport(pr, body, `${runId}:${reportId}:public`);
            return {
              status: 'done',
              result: { repo: pr.repo, url: pr.url, reportUrl: url },
            };
          },
        );
      const commentId = await steps.step(
        'linear.commentIdentity',
        {},
        async () => ({ status: 'done', result: randomUUID() }),
      );
      await steps.step(
        'linear.publishReview',
        { label: 'Post shared review to ticket' },
        async () => ({
          status: 'done',
          result: await createInstanceLinearClient(paths, {
            signal,
          }).ensureComment({
            id: commentId,
            issueId: run.linear.issueId,
            body,
          }),
        }),
      );
      await writeFile(
        join(dir, 'published-review.json'),
        JSON.stringify({ url, reportId, commentId, prs }, null, 2) + '\n',
        { mode: 0o600 },
      );
      console.log(url);
    }
    return 'completed';
  },
});
console.log(JSON.stringify(result));
if (result.status !== 'finished') process.exitCode = 1;
