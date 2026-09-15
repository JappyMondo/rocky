/** Resume only PR delivery for an existing parked run, in a separate durable journal.
 * Usage: rocky exec --profile PROFILE -- node tools/repair-delivery.mjs RUN_ID
 * Never runs implementers, changes the frozen workflow, approves or merges PRs.
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
  { runBoot },
  { readJournal },
  { createScm, createGitLabScm, createGitHubScm },
  { sourceControlToken },
  { DeliveryRepositories },
] = await Promise.all([
  source('config/paths'),
  source('run/replay'),
  source('run/journal'),
  source('scm/index'),
  source('config/source-control'),
  source('flow/repositories'),
]);
const [runId] = process.argv.slice(2);
if (!runId) throw new Error('Pass a parked run ID.');
const paths = rockyPaths();
const p = paths.run(runId);
const run = JSON.parse(await readFile(p.runJson, 'utf8'));
if (run.status !== 'parked')
  throw new Error('Delivery repair requires a parked run.');
const dir = join(p.dir, 'delivery-repair');
await mkdir(dir, { recursive: true });
const signal = AbortSignal.timeout(120000);
const members = run.execution?.members ?? [];
if (!members.length) throw new Error('No frozen repositories.');
const adapters = await Promise.all(
  members.map(async (member) => {
    const match = member.url.match(/(github|gitlab)\.com[/:](.+?)(?:\.git)?$/);
    if (!match) throw new Error('Unsupported remote.');
    const platform = match[1];
    const token = await sourceControlToken(platform, process.env, {
      signal,
      allowCli: true,
    });
    const input = {
      repo: {
        id: member.name,
        project: match[2],
        baseBranch: member.baseBranch,
      },
      branch: run.branch,
      token,
      signal,
    };
    const adapter =
      platform === 'gitlab' ? createGitLabScm(input) : createGitHubScm(input);
    const waitForCi = adapter.waitForCi.bind(adapter);
    adapter.waitForCi = async (pr, options) => {
      let evidence;
      try {
        evidence = JSON.parse(
          await readFile(
            join(dir, `ci-not-configured-${pr.repo}.json`),
            'utf8',
          ),
        );
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (evidence?.confirmed === true && evidence.headSha === pr.headSha)
        return {
          status: 'done',
          result: { status: 'not-configured', headSha: pr.headSha, evidence },
        };
      return waitForCi(pr, options);
    };
    return adapter;
  }),
);
const execute = promisify(execFile);
const result = await runBoot({
  journalPath: join(dir, 'journal.jsonl'),
  workflow: async (steps) => {
    const scm = createScm(steps, {
      runId,
      lead: run.repo,
      members: adapters,
      signal,
      approvals: () => false,
      onRefusal: async ({ refusal }) => {
        throw new Error(refusal.message);
      },
    });
    const ctx = {
      branch: run.branch,
      scm,
      exec: (command, options) =>
        steps.step('exec', options ?? {}, async () => {
          try {
            const { stdout, stderr } = await execute(
              '/bin/sh',
              ['-c', command],
              {
                cwd: p.workspaceDir,
                env: process.env,
                timeout: 60000,
                maxBuffer: 8_000_000,
              },
            );
            return { status: 'done', result: { exitCode: 0, stdout, stderr } };
          } catch (error) {
            return {
              status: 'done',
              result: {
                exitCode: typeof error.code === 'number' ? error.code : 1,
                stdout: error.stdout ?? '',
                stderr: error.stderr ?? error.message,
              },
            };
          }
        }),
    };
    const repositories = new DeliveryRepositories(ctx, { members });
    await repositories.sync(
      `${run.issue.identifier}: ${run.issue.title}`,
      `${run.issue.description}\n\nCompanion changes for ${run.issue.url}. Merge approval remains pending.`,
    );
    await writeFile(
      join(dir, 'pull-requests.json'),
      JSON.stringify(repositories.current, null, 2) + '\n',
      { mode: 0o600 },
    );
    console.log(repositories.links());
    // CI is a separate resumable step per PR. Existing primary CI is reused by the platform.
    for (const pr of repositories.current) {
      const ci = await scm.waitForCi(pr, { logTailLines: 200 });
      if (
        'refused' in ci ||
        !['passed', 'not-configured'].includes(ci.status) ||
        ci.headSha !== pr.headSha
      )
        throw new Error(`${pr.repo}: CI did not pass for the pushed revision.`);
    }
    return 'completed';
  },
});
const journal = await readJournal(join(dir, 'journal.jsonl'));
await writeFile(
  join(dir, 'receipts.json'),
  JSON.stringify(journal.entries, null, 2) + '\n',
  { mode: 0o600 },
);
console.log(JSON.stringify(result));
if (result.status === 'failed') process.exitCode = 1;
