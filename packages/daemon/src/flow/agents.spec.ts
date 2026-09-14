import { readFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import {
  attachedNodes,
  canConnect,
  flowProblems,
  parseFlow,
  validateFlow,
  type WorkflowFlow,
} from '@rocky/local-contracts';
import type { WorkflowContext } from '@rocky/sdk';
import { configuredFlowAgent, deliveryAgents } from './agents.js';
import { flowBindings } from './runtime.js';

const fixture = async () =>
  parseFlow(
    await readFile(
      new URL('../../content/.rocky/workflow.json', import.meta.url),
      'utf8',
    ),
  );
const context = () =>
  ({
    agent: vi.fn().mockResolvedValue({ summary: 'Done' }),
    models: {
      implementation: {
        harness: 'opencode',
        model: 'default-model',
        effort: 'medium',
      },
      review: { harness: 'opencode', model: 'review-model', effort: 'high' },
    },
  }) as unknown as WorkflowContext;
const component = (flow: WorkflowFlow, agent: string, port: string) =>
  attachedNodes(flow, agent, port)[0];

it('executes the implementation role using its wired agent, custom model, prompt, input and tools', async () => {
  const flow = await fixture(),
    ctx = context();
  const agent = component(flow, 'implement', 'agent:implementer');
  agent.name = 'My coding agent';
  agent.parameters = {
    timeout: 12345,
    input: { task: { $ref: 'input.plan' }, ticket: { $ref: 'issue.title' } },
  };
  component(flow, agent.id, 'model').parameters = {
    source: 'custom',
    harness: 'claude-code',
    model: 'chosen-model',
    effort: 'max',
  };
  component(flow, agent.id, 'prompt').parameters = {
    source: 'text',
    text: 'Build {{issue.title}} using {{input.plan}}',
  };
  flow.edges = flow.edges.filter(
    (e) => !(e.target === agent.id && e.targetHandle === 'tools'),
  );
  const tool = flow.nodes.find((n) => n.type === 'ai.tool')!;
  tool.parameters.capability = 'read';
  const mcp = {
    id: 'docs',
    type: 'ai.mcp',
    name: 'Documentation',
    position: { x: 0, y: 0 },
    parameters: { server: 'docs' },
  };
  flow.nodes.push(mcp);
  for (const source of [tool.id, mcp.id])
    flow.edges.push({
      id: `link_${source}`,
      kind: 'attachment',
      source,
      sourceHandle: 'provide',
      target: agent.id,
      targetHandle: 'tools',
    });
  const actors = deliveryAgents(flow, 'implement', ctx, {
    issue: { title: 'Feature' },
  });
  await actors.call('implementer', { input: { plan: 'the plan' } });
  expect(ctx.agent).toHaveBeenCalledWith(
    { prompt: 'Build Feature using the plan' },
    {
      harness: 'claude-code',
      model: 'chosen-model',
      effort: 'max',
      label: 'My coding agent',
      tools: ['read'],
      mcp: ['docs'],
      timeout: 12345,
      input: { task: 'the plan', ticket: 'Feature' },
    },
  );
  flow.edges = flow.edges.filter(
    (e) => !(e.target === agent.id && e.targetHandle === 'tools'),
  );
  await actors.call('implementer', { input: { plan: 'without tools' } });
  expect(ctx.agent).toHaveBeenLastCalledWith(
    expect.anything(),
    expect.objectContaining({ tools: [], mcp: [] }),
  );
});

it('resolves profile prompts and models, keeps schema ownership with coordinators, and fails missing connections', async () => {
  const flow = await fixture(),
    ctx = context();
  const agent = component(flow, 'implement', 'agent:implementer');
  const config = configuredFlowAgent(flow, agent.id, ctx, {
    input: { plan: 'x' },
  });
  expect(config.prompt).toBe('implementer');
  expect(config.options).toMatchObject({
    model: 'default-model',
    input: { plan: 'x' },
    tools: ['read', 'edit', 'bash'],
  });
  expect(() => configuredFlowAgent(flow, 'missing', ctx, {})).toThrow(
    'Missing AI agent',
  );
  const model = component(flow, agent.id, 'model');
  model.parameters.slot = 'missing';
  expect(() => configuredFlowAgent(flow, agent.id, ctx, {})).toThrow(
    'configure model slot',
  );
  model.parameters.slot = 'implementation';
  flow.edges = flow.edges.filter(
    (e) => !(e.target === agent.id && e.targetHandle === 'model'),
  );
  expect(() => configuredFlowAgent(flow, agent.id, ctx, {})).toThrow(
    'exactly one model',
  );
  flow.edges = flow.edges.filter((e) => e.target !== 'implement');
  expect(() =>
    deliveryAgents(flow, 'implement', ctx, {}).call('implementer'),
  ).toThrow('exactly one implementer');
});

it('supplies each visual recap role from the graph', async () => {
  const flow = await fixture(),
    ctx = context();
  const agents = deliveryAgents(flow, 'recap', ctx, {}).recap();
  expect(Object.keys(agents)).toEqual([
    'inventory',
    'narrative',
    'capture',
    'audit',
  ]);
  expect(agents.inventory({}).options).toMatchObject({
    model: 'review-model',
    tools: ['read'],
    mcp: [],
  });
  expect(agents.capture({}).options.tools).toEqual(['read', 'bash']);
});

it('rejects the previous format instead of migrating it', async () => {
  const flow = await fixture();
  expect(() =>
    flowBindings(JSON.stringify({ ...flow, version: 1 }), '/snapshot'),
  ).toThrow('version 2');
});

it('validates typed sockets and their cardinality before running effects', async () => {
  const flow = await fixture();
  const agent = component(flow, 'implement', 'agent:implementer');
  const model = component(flow, agent.id, 'model');
  expect(
    canConnect(flow, {
      source: model.id,
      sourceHandle: 'provide',
      target: agent.id,
      targetHandle: 'prompt',
    }),
  ).toBe(false);
  expect(
    canConnect(flow, {
      source: model.id,
      sourceHandle: 'next',
      target: 'implement',
    }),
  ).toBe(false);
  expect(
    canConnect(flow, {
      source: 'implement',
      sourceHandle: 'bad',
      target: 'validate',
    }),
  ).toBe(false);
  const original = flow.edges.find((e) => e.source === model.id)!;
  flow.edges.push({ ...original, id: 'duplicate' });
  expect(
    flowProblems(flow)
      .map((p) => p.message)
      .join(' '),
  ).toMatch(/exactly one.*duplicate Model/s);
  flow.edges.pop();
  original.sourceHandle = 'next';
  expect(() => validateFlow(JSON.stringify(flow))).toThrow(
    'incompatible component ports',
  );
  original.sourceHandle = 'provide';
  flow.nodes.push({
    id: 'schema',
    type: 'ai.schema',
    name: 'Schema',
    position: { x: 0, y: 0 },
    parameters: { schema: { type: 'object' } },
  });
  flow.edges.push({
    id: 'schema_link',
    kind: 'attachment',
    source: 'schema',
    sourceHandle: 'provide',
    target: agent.id,
    targetHandle: 'schema',
  });
  expect(() => validateFlow(JSON.stringify(flow))).toThrow(
    'coordinator supplies',
  );
});
