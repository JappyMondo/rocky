import { expect, it } from 'vitest';
import { defaultFlowSettings, type WorkflowFlow } from '@rocky/local-contracts';
import {
  componentOwner,
  componentTree,
  connectFlow,
  createFlowNode,
  removeFlowNodes,
  visibleComponents,
} from './flow-components.js';
import { connectedPath } from './flow-connections.js';
import { layoutFlow } from './flow-layout.js';

function fixture() {
  const nodes = [
    'delivery.implement',
    'delivery.implement',
    'agent',
    'ai.model',
    'ai.prompt',
    'ai.tool',
  ].map((type, i) => ({
    ...createFlowNode(type, { x: 0, y: 0 }),
    id: `n${i}`,
  }));
  let flow: WorkflowFlow = {
    version: 2,
    name: 'Shared components',
    models: {},
    settings: defaultFlowSettings(),
    nodes,
    edges: [],
  };
  for (const [source, target, port] of [
    ['n2', 'n0', 'agent:implementer'],
    ['n2', 'n1', 'agent:implementer'],
    ['n3', 'n2', 'model'],
    ['n4', 'n2', 'prompt'],
    ['n5', 'n2', 'tools'],
  ])
    flow = connectFlow(flow, {
      source,
      target,
      sourceHandle: 'provide',
      targetHandle: port,
    });
  return flow;
}
it('keeps reused providers when deleting one coordinator and removes an exclusively owned group', () => {
  const flow = fixture();
  const next = removeFlowNodes(flow, new Set(['n0']));
  expect(next.nodes.map((n) => n.id)).toEqual(['n1', 'n2', 'n3', 'n4', 'n5']);
  expect(removeFlowNodes(next, new Set(['n1'])).nodes).toEqual([]);
  expect(flow.nodes).toHaveLength(6);
});
it('shows a focused hierarchy plus unconnected components, and finds their owner', () => {
  const flow = fixture();
  expect(visibleComponents(flow, null)).toEqual(new Set(['n0', 'n1']));
  expect(componentTree(flow, 'n1')).toEqual(
    new Set(['n1', 'n2', 'n3', 'n4', 'n5']),
  );
  expect(componentOwner(flow, 'n3')).toBe('n0');
  expect(componentOwner(flow, 'n1')).toBe('n1');
  flow.nodes.push({
    ...createFlowNode('ai.mcp', { x: 3, y: 4 }),
    id: 'orphan',
  });
  expect(visibleComponents(flow, 'n0')).toEqual(
    new Set(['n0', 'n2', 'n3', 'n4', 'n5', 'orphan']),
  );
  const arranged = layoutFlow(flow);
  expect(arranged.nodes.find((n) => n.id === 'n3')!.position.x).toBeLessThan(
    arranged.nodes.find((n) => n.id === 'n4')!.position.x,
  );
  expect(arranged.nodes.find((n) => n.id === 'n4')!.position.x).toBeLessThan(
    arranged.nodes.find((n) => n.id === 'n5')!.position.x,
  );
});
it('accepts one model, multiple tools and shared components while rejecting incompatible ports', () => {
  const flow = fixture();
  const tool = { ...createFlowNode('ai.mcp', { x: 0, y: 0 }), id: 'mcp' };
  flow.nodes.push(tool);
  let next = connectFlow(flow, {
    source: 'mcp',
    target: 'n2',
    sourceHandle: 'provide',
    targetHandle: 'tools',
  });
  next = connectFlow(next, {
    source: 'mcp',
    target: 'n2',
    sourceHandle: 'provide',
    targetHandle: 'tools',
  });
  expect(next.edges.filter((e) => e.targetHandle === 'tools')).toHaveLength(2);
  expect(
    connectFlow(next, {
      source: 'mcp',
      target: 'n2',
      sourceHandle: 'provide',
      targetHandle: 'model',
    }),
  ).toBe(next);
  expect(
    connectFlow(next, { source: null, target: 'missing', sourceHandle: null }),
  ).toBe(next);
  const replacement = {
    ...createFlowNode('ai.model', { x: 0, y: 0 }),
    id: 'model2',
  };
  next.nodes.push(replacement);
  next = connectFlow(next, {
    source: 'model2',
    target: 'n2',
    sourceHandle: 'provide',
    targetHandle: 'model',
  });
  expect(next.nodes.some((n) => n.id === 'n3')).toBe(false);
  expect(next.edges.filter((e) => e.targetHandle === 'model')).toEqual([
    expect.objectContaining({ source: 'model2' }),
  ]);
});
it('highlights every component connected through a shared agent from nodes and edges', () => {
  const flow = fixture();
  expect(connectedPath(flow, { kind: 'node', id: 'n3' })?.nodes).toEqual(
    new Set(flow.nodes.map((n) => n.id)),
  );
  const hovered = flow.edges.find((e) => e.source === 'n3')!;
  const path = connectedPath(flow, { kind: 'edge', id: hovered.id });
  expect(path?.edges).toEqual(new Set(flow.edges.map((e) => e.id)));
});
