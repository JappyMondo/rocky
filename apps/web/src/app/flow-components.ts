import {
  attachmentPorts,
  canConnect,
  flowNodeDefinition,
  isAttachment,
  type FlowNode,
  type WorkflowFlow,
} from '@rocky/local-contracts';

export const flowId = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;

/** A component can be shared; walking a group must visit each provider once. */
export function componentTree(flow: WorkflowFlow, root: string): Set<string> {
  const ids = new Set([root]);
  for (const id of ids)
    for (const edge of flow.edges)
      if (isAttachment(edge) && edge.target === id) ids.add(edge.source);
  return ids;
}

export function componentOwner(flow: WorkflowFlow, id: string): string {
  const visited = new Set<string>();
  while (!visited.has(id)) {
    visited.add(id);
    const parent = flow.edges.find((e) => isAttachment(e) && e.source === id);
    if (!parent) return id;
    id = parent.target;
  }
  return id;
}

export function visibleComponents(flow: WorkflowFlow, focus: string | null) {
  const attached = new Set(
    flow.edges.filter(isAttachment).map((e) => e.source),
  );
  if (!focus)
    return new Set(
      flow.nodes.filter((n) => !attached.has(n.id)).map((n) => n.id),
    );
  const visible = componentTree(flow, focus);
  // Keep unconnected components accessible while a group is being assembled.
  for (const node of flow.nodes)
    if (
      !attached.has(node.id) &&
      (node.type.startsWith('ai.') ||
        (node.type === 'agent' &&
          !flow.edges.some(
            (e) =>
              !isAttachment(e) &&
              (e.source === node.id || e.target === node.id),
          )))
    )
      visible.add(node.id);
  return visible;
}

export function createFlowNode(
  type: string,
  position: FlowNode['position'],
): FlowNode {
  const definition = flowNodeDefinition(type)!;
  return {
    id: flowId('node'),
    type,
    name: definition.name,
    position,
    parameters: Object.fromEntries(
      definition.fields
        .filter((f) => f.default !== undefined)
        .map((f) => [f.key, f.default!]),
    ),
  };
}

export function connectFlow(
  flow: WorkflowFlow,
  connection: {
    source: string | null;
    target: string | null;
    sourceHandle: string | null;
    targetHandle?: string | null;
  },
): WorkflowFlow {
  if (
    !canConnect(flow, connection) ||
    !connection.source ||
    !connection.target ||
    !connection.sourceHandle
  )
    return flow;
  const { source, target, sourceHandle, targetHandle } = connection;
  const attachment = sourceHandle === 'provide';
  const multiple = attachmentPorts(
    flow.nodes.find((n) => n.id === target)!.type,
  ).find((p) => p.id === targetHandle)?.multiple;
  const next: WorkflowFlow = {
    ...flow,
    edges: [
      ...flow.edges.filter((e) =>
        attachment
          ? !(
              isAttachment(e) &&
              e.target === target &&
              e.targetHandle === targetHandle &&
              (!multiple || e.source === source)
            )
          : !(
              !isAttachment(e) &&
              e.source === source &&
              e.sourceHandle === sourceHandle
            ),
      ),
      {
        id: flowId('edge'),
        source,
        target,
        sourceHandle,
        ...(attachment
          ? { kind: 'attachment' as const, targetHandle: targetHandle! }
          : {}),
      },
    ],
  };
  const replaced = flow.edges.filter(
    (edge) =>
      attachment &&
      !multiple &&
      isAttachment(edge) &&
      edge.target === target &&
      edge.targetHandle === targetHandle &&
      edge.source !== source,
  );
  const unused = new Set(
    replaced
      .filter((edge) => !next.edges.some((e) => e.source === edge.source))
      .map((e) => e.source),
  );
  return unused.size ? removeFlowNodes(next, unused) : next;
}

/** Deleting a coordinator also removes its exclusively owned components. */
export function removeFlowNodes(
  flow: WorkflowFlow,
  removed: Set<string>,
): WorkflowFlow {
  const ids = new Set(removed);
  for (const id of ids)
    for (const edge of flow.edges)
      if (
        isAttachment(edge) &&
        edge.target === id &&
        flow.edges
          .filter((e) => e.source === edge.source)
          .every((e) => isAttachment(e) && ids.has(e.target))
      )
        ids.add(edge.source);
  return {
    ...flow,
    nodes: flow.nodes.filter((n) => !ids.has(n.id)),
    edges: flow.edges.filter((e) => !ids.has(e.source) && !ids.has(e.target)),
  };
}
