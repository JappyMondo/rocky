import {
  attachedNodes,
  attachmentPorts,
  canConnect,
  isAttachedAgent,
  isAttachment,
  type FlowNode,
  type WorkflowFlow,
} from '@rocky/local-contracts';
import styles from './flow-editor.module.css';
import { componentOwner } from './flow-components.js';

export function ComponentSettings(p: {
  flow: WorkflowFlow;
  node: FlowNode;
  disabled: boolean;
  open: (id: string) => void;
  add: (type: string, target: string, port: string) => void;
  connect: (source: string, target: string, port: string) => void;
  disconnect: (edge: string) => void;
}) {
  const ports = attachmentPorts(p.node.type).filter(
    (port) => port.id !== 'schema' || !isAttachedAgent(p.flow, p.node.id),
  );
  if (!ports.length) return null;
  return (
    <div className={styles.componentSettings}>
      <h3>Connected components</h3>
      {p.node.type === 'agent' && (
        <p className={styles.description}>
          The agent uses the connected model and instructions, and can call only
          the connected tools.
        </p>
      )}
      {ports.map((port) => {
        const connected = attachedNodes(p.flow, p.node.id, port.id);
        const candidates = p.flow.nodes.filter(
          (n) =>
            canConnect(p.flow, {
              source: n.id,
              target: p.node.id,
              sourceHandle: 'provide',
              targetHandle: port.id,
            }) && !connected.some((c) => c.id === n.id),
        );
        const types =
          port.kind === 'tools'
            ? ['ai.tool', 'ai.mcp']
            : [port.kind === 'agent' ? 'agent' : `ai.${port.kind}`];
        return (
          <div key={port.id} className={styles.componentPort}>
            <strong>
              {port.name}
              {port.required ? ' *' : ''}
            </strong>
            {connected.map((node) => (
              <div key={node.id} className={styles.componentLink}>
                <button onClick={() => p.open(node.id)}>{node.name} ↗</button>
                <button
                  disabled={p.disabled}
                  title={`Disconnect ${node.name}`}
                  onClick={() => {
                    const edge = p.flow.edges.find(
                      (e) =>
                        isAttachment(e) &&
                        e.source === node.id &&
                        e.target === p.node.id &&
                        e.targetHandle === port.id,
                    )!;
                    p.disconnect(edge.id);
                  }}
                >
                  ×
                </button>
              </div>
            ))}
            <select
              aria-label={`Connect ${port.name}`}
              disabled={p.disabled}
              value=""
              onChange={(e) => {
                const value = e.target.value;
                if (value.startsWith('new:'))
                  p.add(value.slice(4), p.node.id, port.id);
                else if (value) p.connect(value, p.node.id, port.id);
              }}
            >
              <option value="">
                {connected.length && !port.multiple
                  ? 'Replace component…'
                  : 'Connect component…'}
              </option>
              <optgroup label="Create new">
                {types.map((type) => (
                  <option key={type} value={`new:${type}`}>
                    +{' '}
                    {type === 'ai.mcp'
                      ? 'MCP tools'
                      : type === 'ai.tool'
                        ? 'Workspace tool'
                        : port.name}
                  </option>
                ))}
              </optgroup>
              {!!candidates.length && (
                <optgroup label="Existing components">
                  {candidates.map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.name} ·{' '}
                      {
                        p.flow.nodes.find(
                          (owner) => owner.id === componentOwner(p.flow, n.id),
                        )?.name
                      }
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </div>
        );
      })}
    </div>
  );
}
