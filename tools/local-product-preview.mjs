/** Local verification only: real Journal/config/artifact services, no control fakes. */
import {
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  createDaemon,
  LocalArtifacts,
  LocalSettings,
  newRunHeader,
  parseUnifiedDiff,
  readRunHeader,
  registerLocalApi,
  rockyPaths,
  runBoot,
  updateRunHeader,
  writeInstanceConfig,
  writeRunHeader,
} from '../packages/daemon/dist/index.js';

const root = await mkdtemp(join(tmpdir(), 'rocky-local-product-preview-'));
const paths = rockyPaths(root);
const artifacts = new LocalArtifacts(paths);
const runIds = ['NG-609-1', 'NG-612-1', 'NG-613-1', 'NG-544-1'];
await writeInstanceConfig(paths, {});
for (const [index, runId] of runIds.entries()) {
  const header = newRunHeader({
    runId,
    repo: 'rocky',
    branch: `local-product/${runId}`,
    trigger: 'linear.onDelegate',
    issue: {
      identifier: runId.slice(0, -2),
      title: [
        'A local API that survives a sleeping laptop',
        'A Run is a thread. A Checkpoint wants a reply.',
        'Keep each Complaint beside its source',
        'Stream the Agent, not the whole application',
      ][index],
      description: '',
      labels: [],
      url: `https://linear.app/digimondo/issue/${runId.slice(0, -2)}`,
    },
    now: new Date(Date.now() - index * 60000).toISOString(),
  });
  await writeRunHeader(paths, header);
  await mkdir(paths.run(runId).sessionsDir, { recursive: true });
  await writeFile(
    join(paths.run(runId).sessionsDir, 'planner.jsonl'),
    'Reading the issue and repository instructions.\nThe API and UI stay on this machine.\n',
  );
  await artifacts.registerTranscript(runId, '0', 'planner.jsonl');
  for (let boot = 1; boot <= 3; boot++) {
    await runBoot({
      journalPath: paths.run(runId).journal,
      workflow: async (ctx) => {
        ctx.stage('Plan');
        await ctx.step('agent', { label: 'planner' }, async () => ({
          status: 'done',
          result: {
            summary:
              'Keep the Run readable without opening the raw Transcript.',
            steps: [
              'Serve recorded Run state from the local API.',
              'Put the Step result first and fold the raw output.',
              'Keep every source annotation on its recorded revision.',
            ],
          },
        }));
        ctx.stage('Review');
        await ctx.parallel(
          '$parallel',
          ['compliance', 'review'],
          { label: 'independent checks' },
          (branch, name) =>
            branch.step('agent', { label: `${name} 1/5` }, async () => ({
              status: 'done',
              result: {
                summary: `${name === 'review' ? 'Reviewed the changed source' : 'Checked the ticket requirements'}. Source objections remain anchored in the diff.`,
              },
            })),
        );
        ctx.stage('Checkpoint');
        await ctx.step(
          'checkpoint',
          { label: 'Ready for your Answer' },
          async () => ({ status: 'waiting' }),
        );
        return 'merged';
      },
    });
  }
  await updateRunHeader(paths, runId, {
    status: 'parked',
    boots: 3,
    reason: 'checkpoint',
  });
}

const patch =
  'diff --git a/src/inbox.tsx b/src/inbox.tsx\nindex 123..456 100644\n--- a/src/inbox.tsx\n+++ b/src/inbox.tsx\n@@ -1,3 +1,4 @@\n export function Inbox() {\n-  return <Timeline />;\n+  const runs = useLocalRuns();\n+  return <RunList runs={runs} />;\n }\ndiff --git a/src/old.ts b/src/old.ts\ndeleted file mode 100644\n--- a/src/old.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-export const old = true;\n';
await artifacts.saveDiff(runIds[0], {
  id: 'review-1',
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
  availability: 'available',
  files: [
    ...parseUnifiedDiff(patch),
    { path: 'src', kind: 'directory', status: 'unavailable', hunks: [] },
    {
      path: 'src/missing.ts',
      kind: 'missing',
      status: 'unavailable',
      hunks: [],
    },
  ],
  annotations: [
    {
      id: 'review.1.focus',
      stepKey: '1/1/0',
      revision: 'review-1',
      file: 'src/inbox.tsx',
      line: 3,
      side: 'head',
      text: 'Restore keyboard focus after closing the diff.',
      state: 'fixed',
      resolution: { stepKey: '3', label: 'fixer 1/5' },
    },
    {
      id: 'review.1.poll',
      stepKey: '1/1/0',
      revision: 'review-1',
      file: 'src/inbox.tsx',
      line: 2,
      side: 'head',
      text: 'Poll Run state while an Agent is working.',
      state: 'open',
    },
    {
      id: 'review.1.dir',
      stepKey: '1/1/0',
      revision: 'review-1',
      file: 'src',
      text: 'Keep local-only handlers outside public ingress.',
      state: 'disagreed',
      resolution: {
        stepKey: '3',
        label: 'fixer 1/5',
        reason:
          'The registration module already has a separate local-only boundary.',
      },
    },
    {
      id: 'review.1.missing',
      stepKey: '1/1/0',
      revision: 'review-1',
      file: 'src/missing.ts',
      text: 'Do not invent source context for a missing file.',
      state: 'withdrawn',
      resolution: {
        stepKey: '4',
        label: 'reviewer 2/5',
        reason: 'This file is not part of the recorded change.',
      },
    },
  ],
});
let screenshot;
if (process.env.ROCKY_PREVIEW_SCREENSHOT) {
  await mkdir(paths.run(runIds[0]).screenshotsDir, { recursive: true });
  await copyFile(
    process.env.ROCKY_PREVIEW_SCREENSHOT,
    join(paths.run(runIds[0]).screenshotsDir, 'browser.png'),
  );
  screenshot = await artifacts.registerScreenshot(
    runIds[0],
    'browser.png',
    'Browser verification of the local Inbox',
  );
}

let releaseAgent;
const liveId = runIds[3];
// A fresh real Step after the preview's parked history supplies durable raw
// bytes; it is not a Harness/Steer acceptance substitute.
await updateRunHeader(paths, liveId, { status: 'running', boots: 4 });
await writeFile(
  join(paths.run(liveId).sessionsDir, 'live.jsonl'),
  'Inspecting local-product behavior.\n',
);
await artifacts.registerTranscript(liveId, '3', 'live.jsonl');
const live = runBoot({
  journalPath: paths.run(liveId).journal,
  workflow: async (ctx) => {
    await ctx.step('agent', { label: 'planner' }, async () => ({
      status: 'done',
      result: {},
    }));
    await ctx.parallel(
      '$parallel',
      ['compliance', 'review'],
      { label: 'independent checks' },
      (branch) =>
        branch.step('agent', {}, async () => ({ status: 'done', result: {} })),
    );
    await ctx.step('checkpoint', {}, async () => ({
      status: 'done',
      result: { decision: 'approve' },
    }));
    ctx.stage('Verify');
    await ctx.step('agent', { label: 'local verification' }, async () => {
      await new Promise((resolve) => {
        releaseAgent = resolve;
      });
      return {
        status: 'done',
        result: { summary: 'Local verification completed.' },
      };
    });
    return 'merged';
  },
});
const timer = setInterval(() => {
  void appendFile(
    join(paths.run(liveId).sessionsDir, 'live.jsonl'),
    `Observed local API at ${new Date().toISOString()}.\n`,
  );
}, 2500);

const { app } = await createDaemon({
  webRoot: resolve('apps/web/dist'),
  selfPing: false,
});
await registerLocalApi(app, {
  artifacts,
  settings: new LocalSettings({
    paths,
    boundServer: { host: '127.0.0.1', port: 7625 },
  }),
  runs: {
    list: () => Promise.all(runIds.map((id) => readRunHeader(paths, id))),
    get: (id) =>
      runIds.includes(id)
        ? readRunHeader(paths, id)
        : Promise.resolve(undefined),
    journal: async (id) =>
      (await readFile(paths.run(id).journal, 'utf8'))
        .split('\n')
        .slice(0, -1)
        .map((line) => JSON.parse(line)),
  },
  currentCheckpoint: async (id) =>
    id !== liveId
      ? {
          stepKey: '2',
          generation: 'preview-unconnected',
          title: 'Review the retained evidence',
          body: 'Real Journal and artifact services are connected. Answer/Steer services are not composed in this verification fixture, so mutation controls are unavailable.',
        }
      : undefined,
  presentStep: async (id, key) => ({
    ...(key === '0' ? { usage: { inputTokens: 1400, outputTokens: 230 } } : {}),
    screenshots:
      id === runIds[0] && key === '0' && screenshot ? [screenshot] : [],
  }),
});
const url = await app.listen({
  host: '127.0.0.1',
  port: Number(process.env.ROCKY_PREVIEW_PORT ?? 0),
});
console.log(JSON.stringify({ url, root }));
async function stop() {
  clearInterval(timer);
  releaseAgent?.();
  await live;
  await app.close();
  process.exit(0);
}
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
