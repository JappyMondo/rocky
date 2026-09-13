import { expect, it } from 'vitest';
import { defaultFlowSettings, type WorkflowFlow } from '@rocky/local-contracts';
import { connectedPath } from './flow-connections.js';

function branchingFlow(): WorkflowFlow {
  return {
    version: 2,
    name: 'Branches',
    models: {},
    settings: defaultFlowSettings(),
    nodes: ['start', 'left', 'right', 'finish', 'other'].map((id) => ({
      id,
      type: 'finish',
      name: id,
      parameters: {},
      position: { x: 0, y: 0 },
    })),
    edges: [
      ['start', 'left'],
      ['start', 'right'],
      ['left', 'finish'],
      ['right', 'finish'],
    ].map(([source, target]) => ({
      id: `${source}-${target}`,
      source,
      target,
      sourceHandle: 'next',
    })),
  };
}

it('traces all ancestors and descendants without crossing into sibling branches', () => {
  const path = connectedPath(branchingFlow(), { kind: 'node', id: 'left' });
  expect(path?.nodes).toEqual(new Set(['start', 'left', 'finish']));
  expect(path?.edges).toEqual(new Set(['start-left', 'left-finish']));
});

it('traces the hovered edge and its complete upstream and downstream path', () => {
  const flow = branchingFlow();
  const before = structuredClone(flow);
  const path = connectedPath(flow, { kind: 'edge', id: 'start-left' });
  expect(path?.nodes).toEqual(new Set(['start', 'left', 'finish']));
  expect(path?.edges).toEqual(new Set(['start-left', 'left-finish']));
  expect(connectedPath(flow, { kind: 'edge', id: 'left-finish' })).toEqual(
    path,
  );
  expect(flow).toEqual(before);
});

it('includes every reachable branch and terminates for retry cycles and self loops', () => {
  const flow = branchingFlow();
  flow.edges.push(
    { id: 'retry', source: 'finish', target: 'start', sourceHandle: 'retry' },
    { id: 'self', source: 'left', target: 'left', sourceHandle: 'retry' },
  );
  const path = connectedPath(flow, { kind: 'node', id: 'left' });
  expect(path?.nodes).toEqual(new Set(['start', 'left', 'right', 'finish']));
  expect(path?.edges).toEqual(new Set(flow.edges.map((e) => e.id)));
});

it('highlights an isolated node and clears missing or inactive targets', () => {
  const flow = branchingFlow();
  expect(connectedPath(flow, { kind: 'node', id: 'other' })).toEqual({
    nodes: new Set(['other']),
    edges: new Set(),
  });
  expect(connectedPath(flow, null)).toBeNull();
  expect(connectedPath(flow, { kind: 'node', id: 'missing' })).toBeNull();
  expect(connectedPath(flow, { kind: 'edge', id: 'missing' })).toBeNull();
});
