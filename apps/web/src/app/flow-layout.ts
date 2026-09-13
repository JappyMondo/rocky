import {
  Graph,
  layout,
  type GraphLabel,
  type NodeLabel,
  type EdgeLabel,
} from '@dagrejs/dagre';
import type { WorkflowFlow } from '@rocky/local-contracts';

type MeasuredNode = {
  id: string;
  measured?: { width?: number; height?: number };
};

/** Layout is presentation only: node configuration and connections stay intact. */
export function layoutFlow(
  flow: WorkflowFlow,
  measured: MeasuredNode[] = [],
): WorkflowFlow {
  const sizes = new Map(measured.map((node) => [node.id, node.measured]));
  const graph = new Graph<GraphLabel, NodeLabel, EdgeLabel>({
    multigraph: true,
  });
  graph.setGraph({
    rankdir: 'LR',
    ranksep: 100,
    nodesep: 70,
    edgesep: 24,
    marginx: 40,
    marginy: 40,
  });
  for (const node of flow.nodes) {
    const size = sizes.get(node.id);
    // Match the card's CSS dimensions until XYFlow has measured it.
    graph.setNode(node.id, {
      width: size?.width ?? 188,
      height: size?.height ?? 72,
    });
  }
  for (const edge of flow.edges) {
    // Draft graphs may still contain unresolved connections.
    if (graph.hasNode(edge.source) && graph.hasNode(edge.target)) {
      graph.setEdge(edge.source, edge.target, {}, edge.id);
    }
  }
  layout(graph);
  return {
    ...flow,
    nodes: flow.nodes.map((node) => {
      const placed = graph.node(node.id)!;
      return {
        ...node,
        direction: 'right',
        position: {
          x: placed.x! - placed.width / 2,
          y: placed.y! - placed.height / 2,
        },
      };
    }),
  };
}
