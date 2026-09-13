import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { parseFlow, type WorkflowFlow } from '@rocky/local-contracts';
import { componentTree, visibleComponents } from './flow-components.js';
import { layoutFlow } from './flow-layout.js';

const defaultFlow = () =>
  parseFlow(
    readFileSync(
      resolve(
        import.meta.dirname,
        '../../../../packages/daemon/content/.rocky/workflow.json',
      ),
      'utf8',
    ),
  );

function expectSeparated(flow: WorkflowFlow, width = 188, height = 72) {
  for (const [index, node] of flow.nodes.entries()) {
    expect(
      Number.isFinite(node.position.x) && Number.isFinite(node.position.y),
    ).toBe(true);
    for (const other of flow.nodes.slice(index + 1)) {
      expect(
        Math.abs(node.position.x - other.position.x) >= width ||
          Math.abs(node.position.y - other.position.y) >= height,
      ).toBe(true);
    }
  }
}

it('lays out the default flow with branches and retry loops without overlapping nodes or changing execution', () => {
  const original = defaultFlow();
  const before = structuredClone(original);
  const arranged = layoutFlow(original);
  const roots = visibleComponents(arranged, null);
  expectSeparated({
    ...arranged,
    nodes: arranged.nodes.filter((n) => roots.has(n.id)),
  });
  for (const root of roots) {
    const group = componentTree(arranged, root);
    expectSeparated({
      ...arranged,
      nodes: arranged.nodes.filter((n) => group.has(n.id)),
    });
  }
  expect(arranged.nodes).toHaveLength(167);
  expect({
    ...arranged,
    nodes: arranged.nodes.map((node, index) => ({
      ...node,
      position: before.nodes[index].position,
      direction: before.nodes[index].direction,
    })),
  }).toEqual({
    ...before,
    nodes: before.nodes.map((node) => ({ ...node, direction: node.direction })),
  });
  expect(original).toEqual(before);
  expect(layoutFlow(arranged)).toEqual(arranged);
});

it('includes disconnected nodes and self loops, respects measured sizes, and tolerates draft connections', () => {
  const flow = defaultFlow();
  flow.nodes.push({
    ...flow.nodes[0],
    id: 'disconnected',
    position: { x: 0, y: 0 },
  });
  flow.edges.push(
    {
      id: 'self',
      source: 'disconnected',
      target: 'disconnected',
      sourceHandle: 'next',
    },
    {
      id: 'draft',
      source: 'missing',
      target: 'disconnected',
      sourceHandle: 'next',
    },
  );
  const arranged = layoutFlow(
    flow,
    flow.nodes.map((node) => ({
      id: node.id,
      measured: { width: 260, height: 140 },
    })),
  );
  for (const root of visibleComponents(arranged, null)) {
    const group = componentTree(arranged, root);
    expectSeparated(
      { ...arranged, nodes: arranged.nodes.filter((n) => group.has(n.id)) },
      260,
      140,
    );
  }
  expect(arranged.nodes.map((node) => node.id)).toEqual(
    flow.nodes.map((node) => node.id),
  );
  expect(arranged.edges).toEqual(flow.edges);
});

it('handles an empty canvas', () => {
  const flow = { ...defaultFlow(), nodes: [], edges: [] };
  expect(layoutFlow(flow)).toEqual(flow);
});
