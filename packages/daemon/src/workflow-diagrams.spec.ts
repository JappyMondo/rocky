import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { rockyPaths } from './config/paths.js';
import {
  newRepositoryProfile,
  writeRepositoryProfile,
} from './config/profiles.js';
import { parseInstanceConfig } from './config/schema.js';
import type { ConfigStore } from './config/watcher.js';
import type { HarnessInvocation } from './harness/types.js';
import {
  agentDiagramGenerator,
  diagramSource,
  WorkflowDiagrams,
  workflowHash,
  type DiagramGenerator,
} from './workflow-diagrams.js';

const harness = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('./harness/adapter.js', async (original) => ({
  ...(await original<typeof import('./harness/adapter.js')>()),
  getHarnessAdapter: () => ({ run: harness.run }),
}));
const disposers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const dispose of disposers.reverse()) await dispose();
  disposers.length = 0;
  harness.run.mockReset();
  vi.unstubAllEnvs();
});

const chart = 'flowchart TB\n A["Start"] --> B["Done"]';
async function fixture(
  generate: DiagramGenerator = async () => chart,
  settleMs = 0,
) {
  const root = await mkdtemp(join(tmpdir(), 'rocky-diagrams-'));
  disposers.push(() => rm(root, { recursive: true, force: true }));
  const paths = rockyPaths(root);
  const profile = newRepositoryProfile({
    id: 'one',
    remote: 'https://github.com/acme/one',
    workflow: 'export default [];',
  });
  await writeRepositoryProfile(paths, profile);
  let now = 0;
  const worker = new WorkflowDiagrams({
    paths,
    generate,
    settleMs,
    now: () => now,
    pollMs: 10,
  });
  disposers.push(() => worker.close());
  return {
    paths,
    profile,
    worker,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
async function ready(worker: WorkflowDiagrams, id = 'one') {
  await expect.poll(async () => (await worker.read(id)).status).toBe('ready');
  return worker.read(id);
}

it('deduplicates identical profiles and persists the diagram across daemon restarts', async () => {
  const generate = vi.fn<DiagramGenerator>(async () => chart);
  const { worker, paths, profile } = await fixture(generate);
  await writeRepositoryProfile(paths, { ...profile, id: 'two' });
  await worker.scan();
  const result = await ready(worker);
  await worker.scan();
  expect(await worker.read('two')).toEqual(result);
  expect(generate).toHaveBeenCalledTimes(1);
  await worker.close();
  const restarted = new WorkflowDiagrams({ paths, generate, settleMs: 0 });
  disposers.push(() => restarted.close());
  await restarted.scan();
  expect(await restarted.read('one')).toEqual(result);
  expect(generate).toHaveBeenCalledTimes(1);
  expect(
    JSON.parse(
      await readFile(
        join(
          paths.root,
          'cache/workflow-diagrams',
          `${result.sourceHash}.json`,
        ),
        'utf8',
      ),
    ),
  ).toEqual(result);
});

it('debounces external file edits and ignores changes to unrelated profile fields', async () => {
  const generate = vi.fn<DiagramGenerator>(async () => chart);
  const { worker, paths, profile, advance } = await fixture(generate, 100);
  await worker.scan();
  advance(90);
  await writeFile(
    paths.profileWorkflow('one'),
    'export default [newWorkflow];',
  );
  await worker.scan();
  advance(90);
  await worker.scan();
  expect(generate).not.toHaveBeenCalled();
  advance(20);
  await worker.scan();
  await ready(worker);
  expect(generate.mock.calls[0]?.[0]).toMatchObject({
    workflow: { source: 'export default [newWorkflow];' },
  });
  expect(workflowHash({ ...profile, prompts: { added: 'prompt' } })).toBe(
    workflowHash(profile),
  );
  expect(
    workflowHash({
      ...profile,
      workflow: { ...profile.workflow, triggers: ['new-trigger'] },
    }),
  ).not.toBe(workflowHash(profile));
});

it('does not let a slow old generation replace the current source and skips superseded queued revisions', async () => {
  let finish!: (value: string) => void;
  const generate = vi
    .fn<DiagramGenerator>()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue(chart);
  const { worker, paths } = await fixture(generate);
  await worker.scan();
  const old = await worker.read('one');
  expect(old.status).toBe('generating');
  await writeFile(
    paths.profileWorkflow('one'),
    'export default [intermediate];',
  );
  await worker.scan();
  await writeFile(paths.profileWorkflow('one'), 'export default [latest];');
  await worker.scan();
  finish(chart);
  await expect
    .poll(
      async () =>
        (
          await readdir(join(paths.root, 'cache/workflow-diagrams')).catch(
            () => [],
          )
        ).length,
    )
    .toBe(1);
  const current = await worker.read('one');
  expect(current.sourceHash).not.toBe(old.sourceHash);
  expect(current.status).toBe('queued');
  await worker.scan();
  await ready(worker);
  expect(generate).toHaveBeenCalledTimes(2);
  expect(generate.mock.calls[1]?.[0].workflow.source).toContain('latest');
});

it('caches failures without exposing agent output and supports an explicit retry', async () => {
  const generate = vi
    .fn<DiagramGenerator>()
    .mockRejectedValueOnce(new Error('secret output'))
    .mockResolvedValue(chart);
  const { worker } = await fixture(generate);
  await worker.scan();
  await expect
    .poll(async () => (await worker.read('one')).status)
    .toBe('failed');
  expect(JSON.stringify(await worker.read('one'))).not.toContain(
    'secret output',
  );
  await worker.scan();
  expect(generate).toHaveBeenCalledTimes(1);
  expect((await worker.retry('one')).status).toBe('queued');
  expect((await worker.retry('one')).status).toBe('queued');
  await worker.scan();
  await ready(worker);
});

it('rebuilds corrupt cache files and skips malformed or deleted profiles', async () => {
  const generate = vi.fn<DiagramGenerator>(async () => chart);
  const { worker, paths, profile } = await fixture(generate);
  await worker.scan();
  await ready(worker);
  await worker.close();
  await writeFile(
    join(
      paths.root,
      'cache/workflow-diagrams',
      `${workflowHash(profile)}.json`,
    ),
    'broken JSON',
  );
  await writeFile(paths.profile('bad'), '{');
  const restarted = new WorkflowDiagrams({ paths, generate, settleMs: 0 });
  disposers.push(() => restarted.close());
  await restarted.read('one');
  await rm(paths.profile('one'));
  await restarted.scan();
  expect(generate).toHaveBeenCalledTimes(1);
  await writeRepositoryProfile(paths, profile);
  await restarted.scan();
  await ready(restarted);
  expect(generate).toHaveBeenCalledTimes(2);
});

it('owns the watcher and aborts its running agent on shutdown without persisting a failure', async () => {
  const generate = vi.fn<DiagramGenerator>(
    (_profile, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        });
      }),
  );
  const { worker, paths } = await fixture(generate);
  worker.start();
  worker.start();
  await expect.poll(() => generate.mock.calls.length).toBe(1);
  await worker.close();
  expect(generate.mock.calls[0]?.[1].aborted).toBe(true);
  await worker.scan();
  expect(
    await readdir(join(paths.root, 'cache/workflow-diagrams')).catch(() => []),
  ).toEqual([]);
});

it.each([
  'not a chart',
  'flowchart TB\n%%{init: {securityLevel: loose}}%%\nA --> B',
  'flowchart TB\nclick A "javascript:alert(1)"',
  'flowchart TB\nA["<img src=x>"]',
  `flowchart TB\n${'x'.repeat(16001)}`,
])('rejects unsupported or unsafe model output', (source) => {
  expect(() => diagramSource(source)).toThrow('unsupported diagram');
});

it('extracts the Mermaid block without including agent commentary', () => {
  expect(
    diagramSource(`Here is the diagram:\n\`\`\`mermaid\n${chart}\n\`\`\``),
  ).toBe(chart);
});

it('uses the configured harness, redacts known secrets, grants no tools, and removes temporary agent data', async () => {
  const { paths, profile } = await fixture();
  vi.stubEnv('DIAGRAM_TEST_TOKEN', 'secret-sentinel');
  const config = {
    current: parseInstanceConfig({
      workflowDefaults: { harness: 'opencode', model: 'test/model' },
      harnesses: {
        opencode: {
          command: '/custom/opencode',
          env: { TEST: '${DIAGRAM_TEST_TOKEN}' },
        },
      },
    }),
    readCredentials: async () => ({
      linear: { accessToken: 'credential-sentinel' },
    }),
  } as unknown as ConfigStore;
  harness.run.mockImplementation(async (input: HarnessInvocation) => {
    expect(input).toMatchObject({
      command: '/custom/opencode',
      model: 'test/model',
      capabilities: [],
      mcpServers: [],
      sessionStorage: 'rocky',
      timeoutMs: 120000,
    });
    expect(input.env.TEST).toBe('secret-sentinel');
    expect(input.prompt).not.toContain('secret-sentinel');
    expect(input.prompt).not.toContain('credential-sentinel');
    await writeFile(input.transcriptPath, 'temporary transcript');
    return { text: chart };
  });
  const generate = agentDiagramGenerator(paths, config);
  expect(
    await generate(
      {
        ...profile,
        grants: { ...profile.grants, harness: 'opencode' },
        workflow: {
          source: 'secret-sentinel credential-sentinel',
          triggers: [],
        },
      },
      new AbortController().signal,
    ),
  ).toBe(chart);
  expect(
    await readdir(join(paths.root, 'cache/workflow-diagram-jobs')),
  ).toEqual([]);
  harness.run.mockRejectedValueOnce(new Error('agent failed'));
  await expect(generate(profile, new AbortController().signal)).rejects.toThrow(
    'agent failed',
  );
  expect(
    await readdir(join(paths.root, 'cache/workflow-diagram-jobs')),
  ).toEqual([]);
});
