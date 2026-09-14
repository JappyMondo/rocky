import {
  isAttachment,
  type FlowEdge,
  type WorkflowFlow,
} from '@rocky/local-contracts';

export type FlowHover = { kind: 'node' | 'edge'; id: string };

/** Trace upstream and downstream separately so sibling branches stay distinct. */
export function connectedPath(flow: WorkflowFlow, hover: FlowHover | null) {
  if (!hover) return null;
  const edge =
    hover.kind === 'edge'
      ? flow.edges.find((e) => e.id === hover.id)
      : undefined;
  if (
    hover.kind === 'edge' ? !edge : !flow.nodes.some((n) => n.id === hover.id)
  )
    return null;
  const nodes = new Set<string>();
  const edges = new Set<string>(edge ? [edge.id] : []);
  const incoming = new Map<string, FlowEdge[]>();
  const outgoing = new Map<string, FlowEdge[]>();
  for (const connection of flow.edges.filter((e) => !isAttachment(e))) {
    incoming.set(connection.target, [
      ...(incoming.get(connection.target) ?? []),
      connection,
    ]);
    outgoing.set(connection.source, [
      ...(outgoing.get(connection.source) ?? []),
      connection,
    ]);
  }
  const trace = (
    start: string,
    adjacency: Map<string, FlowEdge[]>,
    destination: 'source' | 'target',
  ) => {
    const visited = new Set<string>();
    const pending = [start];
    for (const id of pending) {
      if (visited.has(id)) continue;
      visited.add(id);
      nodes.add(id);
      for (const connection of adjacency.get(id) ?? []) {
        edges.add(connection.id);
        pending.push(connection[destination]);
      }
    }
  };
  const owners = (id: string) => {
    const roots = new Set<string>(),
      visited = new Set<string>(),
      pending = [id];
    for (const current of pending) {
      if (visited.has(current)) continue;
      visited.add(current);
      nodes.add(current);
      const parents = flow.edges.filter(
        (e) => isAttachment(e) && e.source === current,
      );
      if (!parents.length) roots.add(current);
      for (const parent of parents) {
        edges.add(parent.id);
        pending.push(parent.target);
      }
    }
    return roots;
  };
  for (const start of owners(edge?.source ?? hover.id))
    trace(start, incoming, 'source');
  for (const start of owners(edge?.target ?? hover.id))
    trace(start, outgoing, 'target');
  for (const id of nodes)
    for (const connection of flow.edges)
      if (isAttachment(connection) && connection.target === id) {
        edges.add(connection.id);
        nodes.add(connection.source);
      }
  return { nodes, edges };
}
