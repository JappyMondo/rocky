import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  defaultFlowSettings,
  commandRecipe,
  serviceRecipe,
  flowProblems,
  parseFlow,
  validateFlow,
  FLOW_NODES,
  type FlowNode,
  type FlowValue,
  type WorkflowFlow,
} from '@rocky/local-contracts';
import type { WorkflowContext } from '@rocky/sdk';
import { executeFlow, flowBindings, resolveFlowValue } from './runtime.js';
import { flowSettingsFromSource } from './migration.js';
import { validateSnapshotTriggers } from '../run/loading/validate.js';
import { createWorkflowContext } from '../run/context.js';
import { runBoot } from '../run/replay.js';
import { rockyPaths } from '../config/paths.js';
import {
  listRepositoryProfiles,
  newRepositoryProfile,
  profileWorkflowPath,
  readRepositoryProfile,
  writeRepositoryProfile,
} from '../config/profiles.js';
import { LocalProfiles } from '../local-api/profiles.js';

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

it.each([0, 1])(
  'runs named command prerequisites in order and routes an exit code of %s',
  async (exitCode) => {
    const dir = await directory();
    await mkdir(join(dir, 'workspace', 'web'), { recursive: true });
    const flow = graph(
      [
        node('start', 'trigger', { kind: 'manual', name: 'test' }),
        node('test', 'command', { recipe: 'web/test' }),
        node('pass', 'finish', { outcome: 'completed' }),
        node('fail', 'finish', { outcome: 'rejected' }),
      ],
      [
        ['start', 'next', 'test'],
        ['test', 'success', 'pass'],
        ['test', 'failure', 'fail'],
      ],
    );
    flow.settings.execution = [
      {
        id: 'web',
        name: 'web',
        url: 'https://example.test/web',
        baseBranch: 'main',
        services: [],
        commands: [
          commandRecipe('install', 'pnpm install'),
          { ...commandRecipe('test', 'pnpm test'), dependsOn: ['web/install'] },
        ],
      },
    ];
    const exec = vi
      .fn()
      .mockResolvedValue({ exitCode, stdout: 'result', stderr: '' });
    const workspace = { members: [{ name: 'web', path: 'web', lead: true }] };
    expect(
      await executeFlow(
        flow,
        'start',
        context({ exec }),
        workspace,
        join(dir, 'snapshot'),
      ),
    ).toBe(exitCode ? 'rejected' : 'completed');
    expect(exec.mock.calls[0][0]).toContain('pnpm install');
    expect(exec).toHaveBeenCalledTimes(exitCode ? 1 : 2);
    if (!exitCode) expect(exec.mock.calls[1][0]).toContain('pnpm test');
    delete flow.settings.execution;
    await expect(
      executeFlow(
        flow,
        'start',
        context({ exec }),
        workspace,
        join(dir, 'snapshot'),
      ),
    ).rejects.toThrow('unified profile');
  },
);

it('starts and stops a configured service around the dependent workflow step', async () => {
  const dir = await directory();
  await mkdir(join(dir, 'workspace', 'web'), { recursive: true });
  const flow = graph(
    [
      node('start', 'trigger', { kind: 'manual', name: 'test' }),
      node('serve', 'service.start', { recipe: 'web/frontend' }),
      node('stop', 'service.stop'),
      node('end', 'finish', { outcome: 'completed' }),
    ],
    [
      ['start', 'next', 'serve'],
      ['serve', 'next', 'stop'],
      ['stop', 'next', 'end'],
    ],
  );
  flow.settings.execution = [
    {
      id: 'web',
      name: 'web',
      url: 'https://example.test/web',
      baseBranch: 'main',
      commands: [],
      services: [
        {
          ...serviceRecipe('frontend'),
          start: 'pnpm dev',
          portEnv: '',
          endpoints: [
            {
              name: 'web',
              locator: { kind: 'fixed', url: 'http://localhost:9000' },
            },
          ],
        },
      ],
    },
  ];
  const exec = vi.fn(
    async (_command: string, options?: { background?: boolean }) =>
      options?.background
        ? { pid: 123 }
        : { exitCode: 0, stdout: '', stderr: '' },
  );
  const step = vi.fn(async (_label, work) => work());
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('ready')),
  );
  const workspace = { members: [{ name: 'web', path: 'web', lead: true }] };
  expect(
    await executeFlow(
      flow,
      'start',
      context({ exec: exec as WorkflowContext['exec'], step, ports: [9000] }),
      workspace,
      join(dir, 'snapshot'),
    ),
  ).toBe('completed');
  expect(exec.mock.calls[0][0]).toContain('pnpm dev');
  expect(exec.mock.calls[1][0]).toContain('-123');
  expect(exec).toHaveBeenCalledTimes(2);
  delete flow.settings.execution;
  await expect(
    executeFlow(flow, 'start', context(), workspace, join(dir, 'snapshot')),
  ).rejects.toThrow('unified profile');
});
const directory = async () => {
  const d = await mkdtemp(join(tmpdir(), 'rocky-flow-test-'));
  dirs.push(d);
  return d;
};
const node = (
  id: string,
  type: string,
  parameters: FlowNode['parameters'] = {},
): FlowNode => ({ id, type, name: id, position: { x: 0, y: 0 }, parameters });
function graph(
  nodes: FlowNode[],
  links: [string, string, string][],
): WorkflowFlow {
  return {
    version: 2,
    name: 'Test flow',
    models: {},
    settings: defaultFlowSettings(),
    nodes,
    edges: links.map(([source, sourceHandle, target], i) => ({
      id: `e${i}`,
      source,
      sourceHandle,
      target,
    })),
  };
}
const simple = () =>
  graph(
    [
      node('start', 'trigger', { kind: 'manual', name: 'test' }),
      node('end', 'finish', { outcome: 'completed' }),
    ],
    [['start', 'next', 'end']],
  );
const context = (overrides: Partial<WorkflowContext> = {}) =>
  ({
    stage: vi.fn(),
    issue: {
      identifier: 'TEST-1',
      title: 'Example',
      description: '',
      url: '',
      labels: [],
    },
    models: {},
    linear: { setState: vi.fn() },
    ...overrides,
  }) as WorkflowContext;

it('executes a data-driven branch and passes structured output by reference', async () => {
  const flow = graph(
    [
      node('start', 'trigger', { kind: 'manual', name: 'test' }),
      node('inspect', 'agent', {
        input: { $ref: 'issue' },
      }),
      node('model', 'ai.model', { source: 'profile', slot: 'review' }),
      node('prompt', 'ai.prompt', {
        source: 'text',
        text: 'Inspect {{issue.title}}',
      }),
      node('read', 'ai.tool', { capability: 'read' }),
      node('schema', 'ai.schema', {
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
        },
      }),
      node('route', 'condition', {
        value: { $ref: 'nodes.inspect.ok' },
        operator: 'equals',
        compare: true,
      }),
      node('yes', 'post', {
        body: '{{issue.identifier}}: {{nodes.inspect.summary}}',
      }),
      node('done', 'finish', { outcome: 'completed' }),
      node('no', 'finish', { outcome: 'rejected' }),
    ],
    [
      ['start', 'next', 'inspect'],
      ['inspect', 'next', 'route'],
      ['route', 'true', 'yes'],
      ['route', 'false', 'no'],
      ['yes', 'next', 'done'],
    ],
  );
  for (const [source, targetHandle] of [
    ['model', 'model'],
    ['prompt', 'prompt'],
    ['read', 'tools'],
    ['schema', 'schema'],
  ])
    flow.edges.push({
      id: source,
      kind: 'attachment',
      source,
      target: 'inspect',
      sourceHandle: 'provide',
      targetHandle,
    });
  flow.models = { review: { name: 'Review' } };
  const agent = vi.fn().mockResolvedValue({ ok: true, summary: 'All good' }),
    post = vi.fn();
  const ctx = context({
    agent,
    post,
    models: {
      review: { harness: 'opencode', model: 'review-model', effort: 'high' },
    },
  });
  expect(
    await executeFlow(flow, 'start', ctx, { members: [] }, '/snapshot'),
  ).toBe('completed');
  expect(agent).toHaveBeenCalledWith(
    { prompt: 'Inspect Example' },
    expect.objectContaining({
      model: 'review-model',
      tools: ['read'],
      input: ctx.issue,
    }),
  );
  expect(post).toHaveBeenCalledWith('TEST-1: All good');
  agent.mockResolvedValue({ ok: false, summary: 'Problems' });
  post.mockClear();
  expect(
    await executeFlow(flow, 'start', ctx, { members: [] }, '/snapshot'),
  ).toBe('rejected');
  expect(post).not.toHaveBeenCalled();
});

it.each(['approve', 'reject', 'steer'] as const)(
  'routes checkpoint %s to its configured edge',
  async (decision) => {
    const flow = graph(
      [
        node('start', 'trigger', { kind: 'manual', name: 'test' }),
        node('gate', 'checkpoint', {
          title: 'Review',
          body: '{{issue.title}}',
        }),
        node('done', 'finish', { outcome: 'completed' }),
        node('no', 'finish', { outcome: 'rejected' }),
        node('again', 'finish', { outcome: 'exhausted' }),
      ],
      [
        ['start', 'next', 'gate'],
        ['gate', 'approve', 'done'],
        ['gate', 'reject', 'no'],
        ['gate', 'steer', 'again'],
      ],
    );
    expect(
      await executeFlow(
        flow,
        'start',
        context({ checkpoint: vi.fn().mockResolvedValue({ decision }) }),
        { members: [] },
        '/snapshot',
      ),
    ).toBe(
      { approve: 'completed', reject: 'rejected', steer: 'exhausted' }[
        decision
      ],
    );
  },
);

it('parks and replays a graph without repeating the completed command', async () => {
  const dir = await directory();
  const flow = graph(
    [
      node('start', 'trigger', { kind: 'manual', name: 'test' }),
      node('cmd', 'command', { command: 'echo ready' }),
      node('gate', 'checkpoint', { title: 'Review', body: '{{input.stdout}}' }),
      node('done', 'finish', { outcome: 'completed' }),
      node('no', 'finish', { outcome: 'rejected' }),
    ],
    [
      ['start', 'next', 'cmd'],
      ['cmd', 'success', 'gate'],
      ['cmd', 'failure', 'no'],
      ['gate', 'approve', 'done'],
      ['gate', 'reject', 'no'],
      ['gate', 'steer', 'cmd'],
    ],
  );
  const exec = vi
    .fn()
    .mockResolvedValue({ exitCode: 0, stdout: 'ready', stderr: '' });
  let approved = false;
  const boot = () =>
    runBoot({
      journalPath: join(dir, 'journal.jsonl'),
      workflow: async (runner) => {
        const ctx = createWorkflowContext(
          runner,
          { issue: context().issue, branch: 'test', ports: [] },
          {
            exec,
            changedFiles: async () => [],
            external: () => ({
              checkpoint: async () =>
                approved
                  ? {
                      status: 'done' as const,
                      result: { decision: 'approve' as const },
                    }
                  : { status: 'waiting' as const },
            }),
          },
        );
        return executeFlow(flow, 'start', ctx, { members: [] }, dir);
      },
    });
  expect(await boot()).toMatchObject({ status: 'parked' });
  approved = true;
  expect(await boot()).toMatchObject({
    status: 'finished',
    outcome: 'completed',
  });
  expect(exec).toHaveBeenCalledTimes(1);
});

it('bounds cycles and keeps shell commands literal', async () => {
  const flow = graph(
    [
      node('start', 'trigger', { kind: 'manual', name: 'test' }),
      node('cmd', 'command', { command: 'echo {{issue.title}}' }),
      node('end', 'finish', { outcome: 'completed' }),
    ],
    [
      ['start', 'next', 'cmd'],
      ['cmd', 'failure', 'cmd'],
      ['cmd', 'success', 'end'],
    ],
  );
  flow.settings.maxTransitions = 3;
  const exec = vi
    .fn()
    .mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'no' });
  await expect(
    executeFlow(flow, 'start', context({ exec }), { members: [] }, '/snapshot'),
  ).rejects.toThrow('after 3 transitions');
  expect(exec).toHaveBeenCalledTimes(2);
  expect(exec).toHaveBeenCalledWith(
    'cd -- "$ROCKY_LEAD_REPO" && echo {{issue.title}}',
    { label: 'cmd' },
  );
});

it.each([{ answer: 'Yes' }, { cancelled: true }])(
  'routes question resolution %j',
  async (answer) => {
    const flow = graph(
      [
        node('start', 'trigger', { kind: 'manual', name: 'test' }),
        node('ask', 'question', { title: 'Clarify', body: 'Tell me more' }),
        node('done', 'finish', { outcome: 'completed' }),
        node('no', 'finish', { outcome: 'rejected' }),
      ],
      [
        ['start', 'next', 'ask'],
        ['ask', 'answered', 'done'],
        ['ask', 'cancelled', 'no'],
      ],
    );
    expect(
      await executeFlow(
        flow,
        'start',
        context({ question: vi.fn().mockResolvedValue(answer) }),
        { members: [] },
        '/snapshot',
      ),
    ).toBe('cancelled' in answer ? 'rejected' : 'completed');
  },
);

it('rejects broken connections, unknown operations, ambiguous outputs and forged merged outcomes before effects', async () => {
  const flow = simple();
  flow.edges.push({ ...flow.edges[0], id: 'extra' });
  expect(() => validateFlow(JSON.stringify(flow))).toThrow('exactly one');
  flow.edges.pop();
  flow.edges[0].target = 'missing';
  expect(() => validateFlow(JSON.stringify(flow))).toThrow('missing node');
  flow.edges[0].target = 'start';
  expect(() => validateFlow(JSON.stringify(flow))).toThrow('invalid port');
  flow.nodes[1].parameters.outcome = 'merged';
  expect(
    flowProblems(flow).some((p) => p.message.includes('valid outcome')),
  ).toBe(true);
  flow.nodes[1].type = 'runJavascript';
  expect(() => parseFlow(JSON.stringify(flow))).toThrow('unsupported node');
});

it('defaults new flows to all changed repositories while preserving an omitted frozen setting', () => {
  const flow = simple();
  expect(flow.settings.workspaceSetup).toBe(true);
  expect(() =>
    parseFlow(
      JSON.stringify({
        ...flow,
        settings: { ...flow.settings, workspaceSetup: 'yes' },
      }),
    ),
  ).toThrow('workspaceSetup');
  delete flow.settings.workspaceSetup;
  expect(
    parseFlow(JSON.stringify(flow)).settings.workspaceSetup,
  ).toBeUndefined();
  expect(flow.settings.pullRequests).toBe('all-changed');
  expect(() =>
    parseFlow(
      JSON.stringify({
        ...flow,
        settings: { ...flow.settings, pullRequests: 'multiple' },
      }),
    ),
  ).toThrow('pullRequests');
  delete flow.settings.pullRequests;
  expect(parseFlow(JSON.stringify(flow)).settings.pullRequests).toBeUndefined();
});

it('validates identifiers, settings, triggers, model slots and tools', () => {
  const flow = simple();
  flow.nodes.push({ ...flow.nodes[0] });
  expect(() => parseFlow(JSON.stringify(flow))).toThrow('duplicate');
  flow.nodes.pop();
  flow.settings.reviewCap = 0;
  expect(() => parseFlow(JSON.stringify(flow))).toThrow('reviewCap');
  flow.settings.reviewCap = 5;
  flow.nodes[0].parameters.name = '';
  expect(() => validateFlow(JSON.stringify(flow))).toThrow(
    'manual trigger name',
  );
  flow.nodes[0].parameters.name = 'test';
  flow.nodes.push(
    node('agent', 'agent', { prompt: 'Inline magic', timeout: -1 }),
  );
  expect(
    flowProblems(flow)
      .map((p) => p.message)
      .join(' '),
  ).toMatch(/connect Model.*connect Prompt.*connected components.*timeout/s);
  flow.nodes.push(
    node('schema', 'ai.schema', {
      schema: { type: 'array', items: { type: 'string' } },
    }),
  );
  expect(
    flowProblems(flow).some((p) => p.message.includes('type: object')),
  ).toBe(true);
  flow.models = JSON.parse('{"__proto__":{"name":"bad"}}');
  expect(() => parseFlow(JSON.stringify(flow))).toThrow('model slot');
});

it('resolves JSON references without evaluation or prototype access', () => {
  const data = {
    issue: { title: 'Hello' },
    nodes: { first: { summary: 'Good' } },
  };
  expect(
    resolveFlowValue(
      { a: { $ref: 'issue' }, b: ['{{nodes.first.summary}}'] },
      data,
    ),
  ).toEqual({ a: { title: 'Hello' }, b: ['Good'] });
  expect(() => resolveFlowValue({ $ref: 'issue.constructor' }, data)).toThrow(
    'Reserved',
  );
  expect(() => resolveFlowValue({ $ref: 'process.env' }, data)).toThrow(
    'unavailable',
  );
  expect(() => resolveFlowValue({ $ref: 'issue.title()' }, data)).toThrow(
    'Invalid',
  );
  expect(() => resolveFlowValue({ $ref: 'issue', extra: true }, data)).toThrow(
    'only a string',
  );
});

it('discovers JSON triggers in the validation child and ignores a legacy file beside the flow', async () => {
  const dir = await directory();
  await writeFile(join(dir, 'workflow.json'), JSON.stringify(simple()));
  await writeFile(
    join(dir, 'workflow.ts'),
    'throw new Error("legacy must not execute");',
  );
  expect(await validateSnapshotTriggers(dir)).toEqual([
    { kind: 'manual', name: 'test' },
  ]);
  expect(flowBindings(JSON.stringify(simple()), dir)).toHaveLength(1);
});

it('saves and reloads graph edits with revision checks and an authoritative JSON file', async () => {
  const paths = rockyPaths(await directory());
  const profile = {
    ...newRepositoryProfile({ id: 'app', remote: 'github.com/test/app' }),
    workflow: { source: JSON.stringify(simple()), triggers: [] },
    models: {},
  };
  await writeRepositoryProfile(paths, profile);
  const file = profileWorkflowPath(paths, profile);
  expect(file).toMatch(/flows\/app.json$/);
  await writeFile(
    paths.profileWorkflow('app'),
    'throw new Error("old override")',
  );
  expect(await listRepositoryProfiles(paths)).toHaveLength(1);
  const api = new LocalProfiles(paths),
    current = await api.read('app');
  const next = simple();
  next.nodes[1].name = 'All done';
  next.nodes[1].position = { x: 540, y: 230 };
  const saved = await api.save({
    id: 'app',
    revision: current.revision,
    workflow: { source: JSON.stringify(next), triggers: ['stale'] },
    models: {},
  });
  expect(saved.workflow.triggers).toEqual(['test']);
  expect(
    JSON.parse((await readRepositoryProfile(paths, 'app')).workflow.source),
  ).toEqual(next);
  await expect(
    api.save({ id: 'app', revision: current.revision, models: {} }),
  ).rejects.toMatchObject({ statusCode: 409 });
  const broken = structuredClone(next);
  broken.edges = [];
  await expect(
    api.save({
      id: 'app',
      revision: saved.revision,
      workflow: { source: JSON.stringify(broken), triggers: [] },
      models: {},
    }),
  ).rejects.toMatchObject({ code: 'invalid-flow' });
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(next);
});

it('preserves literal legacy settings when resetting and refuses executable configuration', () => {
  const settings = flowSettingsFromSource(
    '// BEGIN ROCKY CONFIG\nconst commands = { test: "pnpm test" };\nconst reviewCap = 9;\nconst ui = {start:"pnpm dev",url:"http://localhost:3000"};\n// END ROCKY CONFIG',
  );
  expect(settings.commands).toEqual({
    install: '',
    test: 'pnpm test',
    lint: '',
    build: '',
  });
  expect(settings.reviewCap).toBe(9);
  expect(() =>
    flowSettingsFromSource(
      '// BEGIN ROCKY CONFIG\nconst commands = loadSecrets();\n// END ROCKY CONFIG',
    ),
  ).toThrow('literal');
  expect(() => flowSettingsFromSource('// BEGIN ROCKY CONFIG')).toThrow(
    'malformed',
  );
  expect(flowSettingsFromSource(JSON.stringify(simple()))).toEqual(
    defaultFlowSettings(),
  );
});

it('the default graph exposes every packaged delivery operation and both entry points', async () => {
  const source = await readFile(
    new URL('../../content/.rocky/workflow.json', import.meta.url),
    'utf8',
  );
  const flow = validateFlow(source);
  expect(
    flow.nodes
      .filter((n) => n.type.startsWith('delivery.'))
      .map((n) => n.type)
      .sort(),
  ).toEqual(
    FLOW_NODES.filter((n) => n.group === 'Delivery')
      .map((n) => n.type)
      .sort(),
  );
  expect(flow.edges).toContainEqual({
    id: 'e_14_repair',
    source: 'recap',
    sourceHandle: 'retry',
    target: 'validate',
  });
  expect(flow.edges).toContainEqual({
    id: 'e_14_exhausted',
    source: 'recap',
    sourceHandle: 'exhausted',
    target: 'exhausted',
  });
  expect(flowBindings(source, '/snapshot').map((b) => b.descriptor)).toEqual([
    { kind: 'linear.onDelegate' },
    { kind: 'manual', name: 'address-pr-conversations' },
  ]);
});

it.each<{
  operator: string;
  value: FlowValue;
  compare: FlowValue;
  matches: boolean;
}>([
  {
    operator: 'equals',
    value: { a: 1, b: 2 },
    compare: { b: 2, a: 1 },
    matches: true,
  },
  { operator: 'truthy', value: '', compare: null, matches: false },
  { operator: 'truthy', value: 'ready', compare: null, matches: true },
  {
    operator: 'contains',
    value: 'ready to ship',
    compare: 'ship',
    matches: true,
  },
  {
    operator: 'contains',
    value: ['test', 'build'],
    compare: 'lint',
    matches: false,
  },
  {
    operator: 'contains',
    value: [{ ok: true }],
    compare: { ok: true },
    matches: true,
  },
  { operator: 'contains', value: 5, compare: '5', matches: false },
  { operator: 'greaterThan', value: 3, compare: 2, matches: true },
  { operator: 'greaterThan', value: 2, compare: 3, matches: false },
  { operator: 'greaterThan', value: '3', compare: 2, matches: false },
  {
    operator: 'notEquals',
    value: 'draft',
    compare: 'published',
    matches: true,
  },
  {
    operator: 'notEquals',
    value: { ok: true },
    compare: { ok: true },
    matches: false,
  },
])(
  'routes $operator with typed values ($matches)',
  async ({ operator, value, compare, matches }) => {
    const flow = graph(
      [
        node('start', 'trigger', { kind: 'manual', name: 'test' }),
        node('condition', 'condition', { operator, value, compare }),
        node('yes', 'finish', { outcome: 'completed' }),
        node('no', 'finish', { outcome: 'rejected' }),
      ],
      [
        ['start', 'next', 'condition'],
        ['condition', 'true', 'yes'],
        ['condition', 'false', 'no'],
      ],
    );
    expect(
      await executeFlow(flow, 'start', context(), { members: [] }, '/snapshot'),
    ).toBe(matches ? 'completed' : 'rejected');
  },
);

it('uses an agent summary to set the configured issue state', async () => {
  const flow = graph(
    [
      node('start', 'trigger', { kind: 'manual', name: 'test' }),
      node('agent', 'agent'),
      node('model', 'ai.model', { source: 'profile', slot: 'review' }),
      node('prompt', 'ai.prompt', { source: 'text', text: 'Select a state' }),
      node('state', 'setState', { state: '{{nodes.agent.summary}}' }),
      node('end', 'finish', { outcome: 'completed' }),
    ],
    [
      ['start', 'next', 'agent'],
      ['agent', 'next', 'state'],
      ['state', 'next', 'end'],
    ],
  );
  for (const source of ['model', 'prompt'])
    flow.edges.push({
      id: source,
      kind: 'attachment',
      source,
      target: 'agent',
      sourceHandle: 'provide',
      targetHandle: source,
    });
  flow.models = { review: { name: 'Review' } };
  const setState = vi.fn();
  const ctx = context({
    agent: vi.fn().mockResolvedValue({ summary: 'In Review' }),
    models: {
      review: { harness: 'opencode', model: 'review', effort: 'high' },
    },
  });
  ctx.linear.setState = setState;
  expect(
    await executeFlow(flow, 'start', ctx, { members: [] }, '/snapshot'),
  ).toBe('completed');
  expect(setState).toHaveBeenCalledWith('In Review');
});
