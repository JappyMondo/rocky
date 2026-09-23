import {
  Graph,
  layout,
  type GraphLabel,
  type NodeLabel,
  type EdgeLabel,
} from '@dagrejs/dagre';
import {
  attachedNodes,
  attachmentPorts,
  isAttachment,
  isAttachedAgent,
  type WorkflowFlow,
} from '@rocky/local-contracts';
import { componentTree, visibleComponents } from './flow-components.js';

type MeasuredNode = {
  id: string;
  measured?: { width?: number; height?: number };
};

/** Arrange the workflow and every component workspace, preserving configuration. */
export function layoutFlow(
  flow: WorkflowFlow,
  measured: MeasuredNode[] = [],
): WorkflowFlow {
  const sizes = new Map(measured.map((node) => [node.id, node.measured]));
  const positions = new Map<string, { x: number; y: number }>();
  const nodes = new Map(flow.nodes.map((n) => [n.id, n]));
  const ports = (id: string) =>
    attachmentPorts(nodes.get(id)!.type).filter(
      (p) => p.id !== 'schema' || !isAttachedAgent(flow, id),
    );
  const size = (id: string, components = false) => ({
    width: components
      ? Math.max(188, ports(id).length * 100, sizes.get(id)?.width ?? 0)
      : (sizes.get(id)?.width ?? 188),
    height: Math.max(sizes.get(id)?.height ?? 72, ports(id).length ? 108 : 72),
  });
  const roots = visibleComponents(flow, null);
  const workspaces = [...roots].map((root) => componentTree(flow, root));
  const graph = new Graph<GraphLabel, NodeLabel, EdgeLabel>({
    multigraph: true,
  });
  graph.setGraph({
    rankdir: 'LR',
    ranksep: 100,
    nodesep: 100,
    edgesep: 24,
    marginx: 40,
    marginy: 40,
  });
  for (const id of roots) graph.setNode(id, size(id));
  for (const edge of flow.edges)
    if (
      !isAttachment(edge) &&
      graph.hasNode(edge.source) &&
      graph.hasNode(edge.target)
    )
      graph.setEdge(edge.source, edge.target, {}, edge.id);
  layout(graph);
  for (const id of graph.nodes()) {
    const node = graph.node(id)!;
    positions.set(id, {
      x: node.x! - node.width / 2,
      y: node.y! - node.height / 2,
    });
  }
  // Keep providers ordered by their consumer's sockets: model, prompt, tools.
  const children = (id: string) => [
    ...new Set(
      ports(id).flatMap((port) =>
        attachedNodes(flow, id, port.id).map((n) => n.id),
      ),
    ),
  ];
  const widths = new Map<string, number>();
  const measure = (id: string): number => {
    const cached = widths.get(id);
    if (cached !== undefined) return cached;
    widths.set(id, size(id, true).width);
    const nested = children(id);
    const width = Math.max(
      size(id, true).width,
      nested.reduce((sum, child) => sum + measure(child), 0) +
        Math.max(0, nested.length - 1) * 45,
    );
    widths.set(id, width);
    return width;
  };
  const placed = new Set<string>();
  const arrange = (id: string, center: number, y: number) => {
    if (placed.has(id)) return;
    placed.add(id);
    const dimensions = size(id, true);
    if (!roots.has(id)) {
      const x = center - dimensions.width / 2;
      // Shared providers have one position across several workspaces. Reserve
      // space for every co-visible consumer and provider, including later roots.
      const neighbours = [...positions]
        .filter(([other]) =>
          workspaces.some((group) => group.has(id) && group.has(other)),
        )
        .sort(([, a], [, b]) => a.y - b.y);
      for (const [other, position] of neighbours) {
        const occupied = size(other, true);
        if (
          x < position.x + occupied.width + 45 &&
          x + dimensions.width + 45 > position.x &&
          y < position.y + occupied.height + 100 &&
          y + dimensions.height + 100 > position.y
        )
          y = position.y + occupied.height + 100;
      }
      positions.set(id, { x, y });
    }
    const nested = children(id);
    const width =
      nested.reduce((sum, child) => sum + measure(child), 0) +
      Math.max(0, nested.length - 1) * 45;
    let x = center - width / 2;
    for (const child of nested) {
      const childWidth = measure(child);
      arrange(child, x + childWidth / 2, y + dimensions.height + 100);
      x += childWidth + 45;
    }
  };
  for (const root of roots) {
    const position = positions.get(root)!;
    arrange(root, position.x + size(root, true).width / 2, position.y);
  }
  return {
    ...flow,
    nodes: flow.nodes.map((node) => ({
      ...node,
      direction: 'right',
      position: positions.get(node.id) ?? node.position,
    })),
  };
}
