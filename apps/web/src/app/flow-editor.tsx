import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  MarkerType,
  useNodesState,
  useUpdateNodeInternals,
  type NodeProps,
  type Node,
  type Connection,
  type ReactFlowInstance,
} from '@xyflow/react';
import {
  FLOW_NODES,
  attachmentPorts,
  isAttachment,
  isResource,
  isAttachedAgent,
  canConnect,
  flowNodeDefinition,
  flowProblems,
  flowTriggerNames,
  parseFlow,
  type FlowField,
  type FlowNode,
  type FlowSettings,
  type FlowValue,
  type WorkflowFlow,
  type FlowProblem,
} from '@rocky/local-contracts';
import '@xyflow/react/dist/style.css';
import { layoutFlow } from './flow-layout.js';
import { connectedPath, type FlowHover } from './flow-connections.js';
import styles from './flow-editor.module.css';
import {
  componentOwner,
  visibleComponents,
  connectFlow,
  createFlowNode,
  removeFlowNodes,
  flowId,
} from './flow-components.js';
import { ComponentSettings } from './flow-component-settings.js';

type CanvasNode = Node<
  { node: FlowNode; invalid: boolean; attached: boolean; components: boolean },
  'operation'
>;
function OperationNode({ data, selected }: NodeProps<CanvasNode>) {
  const definition = flowNodeDefinition(data.node.type)!;
  const updateInternals = useUpdateNodeInternals();
  const ports = attachmentPorts(data.node.type).filter(
    (p) => p.id !== 'schema' || !data.attached,
  );
  const resource = isResource(data.node);
  useEffect(() => {
    updateInternals(data.node.id);
  }, [updateInternals, data.node.id, data.attached, data.components]);
  return (
    <div
      className={`${styles.node} ${resource ? styles.resourceNode : ''} ${ports.length ? styles.hasComponents : ''} ${selected ? styles.selected : ''} ${data.invalid ? styles.invalid : ''}`}
      style={
        data.components
          ? { width: Math.max(188, ports.length * 100) }
          : undefined
      }
    >
      {data.node.type !== 'trigger' && !resource && !data.attached && (
        <Handle
          type="target"
          position={
            data.node.direction === 'left' ? Position.Right : Position.Left
          }
        />
      )}
      <span
        className={`${styles.nodeIcon} ${styles[definition.group.toLowerCase()]}`}
      >
        {definition.icon}
      </span>
      <div className={styles.nodeTitle}>
        <strong>{data.node.name}</strong>
        <small>{definition.name}</small>
      </div>
      {(resource || data.attached ? [] : definition.outputs).map(
        (port, index) => (
          <Handle
            key={port}
            id={port}
            type="source"
            position={
              data.node.direction === 'left' ? Position.Left : Position.Right
            }
            style={{
              top: `${(100 * (index + 1)) / (definition.outputs.length + 1)}%`,
            }}
            title={port}
            aria-label={`${data.node.name}: ${port}`}
          />
        ),
      )}
      {(resource || data.node.type === 'agent') && (
        <Handle
          id="provide"
          type="source"
          position={Position.Top}
          title="Provide component"
        />
      )}
      {!!ports.length && (
        <div className={styles.nodePorts}>
          {data.components ? (
            ports.map((port, index) => (
              <span key={port.id}>
                {port.name}
                <Handle
                  id={port.id}
                  type="target"
                  position={Position.Bottom}
                  title={port.name}
                  aria-label={`${data.node.name}: ${port.name}`}
                  style={{ left: `${(100 * (index + 0.5)) / ports.length}%` }}
                />
              </span>
            ))
          ) : (
            <span>
              {ports.filter((p) => p.required).length} required components ·
              double-click to open
            </span>
          )}
        </div>
      )}
      {data.node.notes && (
        <span className={styles.noteDot} title={data.node.notes}>
          •
        </span>
      )}
    </div>
  );
}
const nodeTypes = { operation: OperationNode };
const toCanvas = (flow: WorkflowFlow): CanvasNode[] => {
  const errors = flowProblems(flow);
  return flow.nodes.map((node) => ({
    id: node.id,
    type: 'operation',
    position: node.position,
    sourcePosition: node.direction === 'left' ? Position.Left : Position.Right,
    targetPosition: node.direction === 'left' ? Position.Right : Position.Left,
    data: {
      node,
      invalid: errors.some((e) => e.nodeId === node.id),
      attached: isAttachedAgent(flow, node.id),
      components: false,
    },
  }));
};
function ParameterField(p: {
  field: FlowField;
  value: FlowValue | undefined;
  models: WorkflowFlow['models'];
  disabled?: boolean;
  onChange: (value: FlowValue) => void;
  onError: (key: string, error: string | null) => void;
}) {
  const { field, value } = p;
  const [raw, setRaw] = useState(JSON.stringify(value ?? null, null, 2));
  const [error, setError] = useState('');
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused && !error) setRaw(JSON.stringify(value ?? null, null, 2));
  }, [value, focused, error]);
  return (
    <label className={styles.field}>
      <span>
        {field.label}
        {field.required && <span className={styles.required}> *</span>}
      </span>
      {field.kind === 'json' ? (
        <textarea
          aria-label={field.label}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          className={styles.code}
          rows={Math.min(9, Math.max(3, raw.split('\n').length))}
          spellCheck={false}
          disabled={p.disabled}
          value={raw}
          onChange={(e) => {
            setRaw(e.target.value);
            try {
              const parsed = JSON.parse(e.target.value);
              p.onChange(parsed);
              setError('');
              p.onError(field.key, null);
            } catch (caught) {
              const message =
                caught instanceof SyntaxError
                  ? 'Enter valid JSON.'
                  : caught instanceof Error
                    ? caught.message
                    : 'Invalid field value.';
              setError(message);
              p.onError(field.key, `${field.label}: ${message}`);
            }
          }}
        />
      ) : field.kind === 'select' || field.kind === 'model' ? (
        <select
          aria-label={field.label}
          value={String(value ?? '')}
          disabled={p.disabled}
          onChange={(e) => p.onChange(e.target.value)}
        >
          <option value="">Choose…</option>
          {(field.kind === 'model'
            ? Object.keys(p.models)
            : (field.options ?? [])
          ).map((option) => (
            <option key={option} value={option}>
              {field.kind === 'model' ? p.models[option].name : option}
            </option>
          ))}
        </select>
      ) : field.kind === 'textarea' ? (
        <textarea
          rows={4}
          disabled={p.disabled}
          aria-label={field.label}
          value={String(value ?? '')}
          onChange={(e) => p.onChange(e.target.value)}
        />
      ) : (
        <input
          type={field.kind === 'number' ? 'number' : 'text'}
          min={1}
          disabled={p.disabled}
          aria-label={field.label}
          value={String(value ?? '')}
          onChange={(e) =>
            p.onChange(
              field.kind === 'number' ? Number(e.target.value) : e.target.value,
            )
          }
        />
      )}
      {error && (
        <small role="alert" className={styles.error}>
          {error}
        </small>
      )}
      {field.hint && <small>{field.hint}</small>}
    </label>
  );
}

class FlowBoundary extends Component<
  {
    source: string;
    children: ReactNode;
    onValidityChange: (valid: boolean) => void;
  },
  { error: string | null }
> {
  override state = { error: null as string | null };
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  override componentDidCatch() {
    this.props.onValidityChange(false);
  }
  override componentDidUpdate(previous: Readonly<{ source: string }>) {
    if (this.state.error && previous.source !== this.props.source)
      this.setState({ error: null });
  }
  override render() {
    return this.state.error ? (
      <p role="alert">
        Cannot open this flow: {this.state.error} Replace workflow.json with a
        supported flow.
      </p>
    ) : (
      this.props.children
    );
  }
}
export function FlowEditor(p: Parameters<typeof FlowCanvas>[0]) {
  return (
    <FlowBoundary source={p.source} onValidityChange={p.onValidityChange}>
      <FlowCanvas {...p} />
    </FlowBoundary>
  );
}

function FlowCanvas(p: {
  source: string;
  disabled: boolean;
  unsaved: boolean;
  onChange: (workflow: { source: string; triggers: string[] }) => void;
  onValidityChange: (valid: boolean) => void;
  onSave?: () => void;
  saveDisabled?: boolean;
}) {
  const [flow, setFlow] = useState(() => parseFlow(p.source));
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>(
    toCanvas(flow),
  );
  const [componentFocus, setComponentFocus] = useState<string | null>(null);
  const visible = useMemo(
    () => visibleComponents(flow, componentFocus),
    [flow, componentFocus],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [hover, setHover] = useState<FlowHover | null>(null);
  const highlighted = useMemo(() => connectedPath(flow, hover), [flow, hover]);
  const hoverNode = useCallback(
    (_: unknown, node: { id: string }) =>
      setHover({ kind: 'node', id: node.id }),
    [],
  );
  const hoverEdge = useCallback(
    (_: unknown, edge: { id: string }) =>
      setHover({ kind: 'edge', id: edge.id }),
    [],
  );
  const clearHover = useCallback(() => setHover(null), []);
  const [panel, setPanel] = useState<
    'node' | 'add' | 'settings' | 'issues' | null
  >(null);
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [layoutRevision, setLayoutRevision] = useState(0);
  const [importError, setImportError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [history, setHistory] = useState<WorkflowFlow[]>([]);
  const [future, setFuture] = useState<WorkflowFlow[]>([]);
  const instance = useRef<ReactFlowInstance<CanvasNode> | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const lastSource = useRef(p.source);
  const problems = useMemo<FlowProblem[]>(() => {
    try {
      parseFlow(JSON.stringify(flow));
      return flowProblems(flow);
    } catch (error) {
      return [
        { message: error instanceof Error ? error.message : String(error) },
      ];
    }
  }, [flow]);
  const selected = flow.nodes.find((n) => n.id === selectedId);
  const definition = selected ? flowNodeDefinition(selected.type) : undefined;
  useEffect(() => {
    if (p.source !== lastSource.current) {
      const next = parseFlow(p.source);
      setFlow(next);
      setNodes(toCanvas(next));
      setHistory([]);
      setFuture([]);
      setSelectedId(null);
      setComponentFocus(null);
      setHover(null);
      setFieldErrors({});
      lastSource.current = p.source;
    }
  }, [p.source, setNodes]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      void instance.current?.fitView({
        padding: 0.12,
        maxZoom: 0.9,
        duration: 200,
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [expanded, layoutRevision, componentFocus]);
  const valid = problems.length === 0 && Object.keys(fieldErrors).length === 0;
  const onValidityChange = p.onValidityChange;
  useEffect(() => {
    onValidityChange(valid);
  }, [valid, onValidityChange]);
  const publish = (next: WorkflowFlow) => {
    setFlow(next);
    setNodes(toCanvas(next));
    const source = JSON.stringify(next, null, 2) + '\n';
    lastSource.current = source;
    p.onChange({ source, triggers: flowTriggerNames(next) });
  };
  const change = (next: WorkflowFlow) => {
    if (p.disabled) return;
    setHistory((h) => [...h.slice(-49), flow]);
    setFuture([]);
    publish(next);
  };
  const updateNode = (patch: Partial<FlowNode>) => {
    if (selected)
      change({
        ...flow,
        nodes: flow.nodes.map((n) =>
          n.id === selected.id ? { ...n, ...patch } : n,
        ),
      });
  };
  const autoLayout = () => {
    change(layoutFlow(flow, instance.current?.getNodes()));
    setLayoutRevision((revision) => revision + 1);
  };
  const updateSettings = (patch: Partial<FlowSettings>) =>
    change({ ...flow, settings: { ...flow.settings, ...patch } });
  const removeNode = (id: string) => {
    change(removeFlowNodes(flow, new Set([id])));
    if (componentFocus === id) setComponentFocus(null);
    setSelectedId(null);
    setFieldErrors({});
  };
  const undo = () => {
    const previous = history.at(-1);
    if (!previous || p.disabled) return;
    setHistory(history.slice(0, -1));
    setFuture([flow, ...future]);
    publish(previous);
    setFieldErrors({});
  };
  const redo = () => {
    if (!future[0] || p.disabled) return;
    setHistory([...history, flow]);
    publish(future[0]);
    setFuture(future.slice(1));
    setFieldErrors({});
  };
  const addNode = (type: string, target?: string, port?: string) => {
    const viewport = instance.current?.getViewport() ?? { x: 0, y: 0, zoom: 1 };
    const owner = flow.nodes.find((n) => n.id === target);
    const node = createFlowNode(
      type,
      owner
        ? { x: owner.position.x, y: owner.position.y + 180 }
        : {
            x: (300 - viewport.x) / viewport.zoom,
            y: (200 - viewport.y) / viewport.zoom,
          },
    );
    let next = { ...flow, nodes: [...flow.nodes, node] };
    if (target && port) {
      next = connectFlow(next, {
        source: node.id,
        target,
        sourceHandle: 'provide',
        targetHandle: port,
      });
      next = layoutFlow(next, instance.current?.getNodes());
      setComponentFocus(componentFocus ?? componentOwner(flow, target));
      setLayoutRevision((r) => r + 1);
    }
    change(next);
    setSelectedId(node.id);
    setPanel('node');
    setFieldErrors({});
  };
  const connect = (connection: Connection) => {
    const next = connectFlow(flow, connection);
    if (next !== flow) change(next);
  };
  const fieldError = useCallback(
    (key: string, error: string | null) =>
      setFieldErrors((prev) => {
        const next = { ...prev };
        if (error) next[key] = error;
        else delete next[key];
        return next;
      }),
    [],
  );
  const exportFlow = () => {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(flow, null, 2) + '\n'], {
        type: 'application/json',
      }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = 'workflow.json';
    a.click();
    URL.revokeObjectURL(url);
  };
  const focusNode = (id: string) => {
    setSelectedId(id);
    setPanel('node');
    if (!visible.has(id)) setComponentFocus(componentOwner(flow, id));
    void instance.current?.fitView({
      nodes: [{ id }],
      maxZoom: 1,
      duration: 250,
    });
  };
  return (
    <section
      className={`${styles.editor} ${expanded ? styles.expanded : ''}`}
      aria-label="Workflow flow editor"
    >
      <header className={styles.toolbar}>
        <div className={styles.flowIdentity}>
          <span className={styles.flowMark}>⑂</span>
          <div>
            <strong>{flow.name}</strong>
            <small>
              {flow.nodes.length} nodes ·{' '}
              {p.unsaved ? 'Unsaved changes' : 'Saved locally'}
            </small>
          </div>
        </div>
        <div className={styles.toolbarActions}>
          <button
            type="button"
            disabled={p.disabled || !history.length}
            onClick={undo}
            title="Undo"
          >
            ↶
          </button>
          <button
            type="button"
            disabled={p.disabled || !future.length}
            onClick={redo}
            title="Redo"
          >
            ↷
          </button>
          <button
            type="button"
            disabled={p.disabled || !flow.nodes.length}
            onClick={autoLayout}
            title="Arrange all nodes and fit the flow into view"
          >
            Auto layout
          </button>
          <button
            type="button"
            onClick={() => setPanel(panel === 'settings' ? null : 'settings')}
          >
            Flow settings
          </button>
          <button type="button" onClick={() => setExpanded(!expanded)}>
            {expanded ? 'Exit full screen' : 'Full screen'}
          </button>
          {p.onSave && (
            <button
              type="button"
              disabled={p.saveDisabled || !valid || !p.unsaved}
              onClick={p.onSave}
            >
              Save profile
            </button>
          )}
          <button
            type="button"
            className={styles.addButton}
            disabled={p.disabled}
            onClick={() => {
              setPanel('add');
              setSearch('');
            }}
          >
            + Add node
          </button>
        </div>
      </header>
      <div className={styles.workspace}>
        <div className={styles.canvas}>
          <ReactFlow<CanvasNode>
            nodes={nodes
              .filter((node) => visible.has(node.id))
              .map((node) => ({
                ...node,
                data: { ...node.data, components: componentFocus !== null },
                selected: node.id === selectedId,
                className: highlighted
                  ? highlighted.nodes.has(node.id)
                    ? styles.connected
                    : styles.unrelated
                  : undefined,
              }))}
            edges={flow.edges
              .filter(
                (edge) => visible.has(edge.source) && visible.has(edge.target),
              )
              .map((edge) => {
                const connected = highlighted?.edges.has(edge.id);
                const stroke = connected
                  ? '#365c42'
                  : edge.sourceHandle === 'retry'
                    ? '#b6ad96'
                    : '#8b9b82';
                return {
                  ...edge,
                  className:
                    highlighted && !connected ? styles.unrelated : undefined,
                  type: isAttachment(edge) ? 'default' : 'smoothstep',
                  label:
                    isAttachment(edge) || edge.sourceHandle === 'next'
                      ? undefined
                      : edge.sourceHandle,
                  selected: edge.id === selectedEdge,
                  style: {
                    stroke,
                    strokeWidth: connected ? 2.8 : 1.4,
                    strokeDasharray:
                      isAttachment(edge) || edge.sourceHandle === 'retry'
                        ? '5 4'
                        : undefined,
                  },
                  markerEnd: isAttachment(edge)
                    ? undefined
                    : { type: MarkerType.ArrowClosed, color: stroke },
                  labelStyle: {
                    fontSize: 11,
                    fill: connected ? '#365c42' : '#687461',
                    fontWeight: connected ? 600 : 400,
                  },
                  labelBgStyle: { fill: '#fafbf8' },
                };
              })}
            nodeTypes={nodeTypes}
            onNodeMouseEnter={hoverNode}
            onNodeMouseLeave={clearHover}
            onEdgeMouseEnter={hoverEdge}
            onEdgeMouseLeave={clearHover}
            onPaneMouseEnter={clearHover}
            onInit={(rf) => {
              instance.current = rf;
            }}
            onNodesChange={(changes) => {
              onNodesChange(changes);
              if (changes.some((change) => change.type === 'dimensions'))
                setLayoutRevision((r) => r + 1);
            }}
            onNodeDragStop={(_, node) =>
              change({
                ...flow,
                nodes: flow.nodes.map((n) =>
                  n.id === node.id ? { ...n, position: node.position } : n,
                ),
              })
            }
            onNodesDelete={(removed) => {
              const ids = new Set(removed.map((n) => n.id));
              change(removeFlowNodes(flow, ids));
              if (componentFocus && ids.has(componentFocus))
                setComponentFocus(null);
              setSelectedId(null);
              setFieldErrors({});
            }}
            onEdgesDelete={(removed) =>
              change({
                ...flow,
                edges: flow.edges.filter(
                  (e) => !removed.some((r) => r.id === e.id),
                ),
              })
            }
            onConnect={connect}
            isValidConnection={(c) => canConnect(flow, c)}
            onNodeDoubleClick={(_, node) => {
              if (attachmentPorts(node.data.node.type).length) {
                setComponentFocus(componentOwner(flow, node.id));
                setSelectedId(node.id);
                setPanel('node');
              }
            }}
            onNodeClick={(_, node) => {
              setSelectedId(node.id);
              setSelectedEdge(null);
              setPanel('node');
              setFieldErrors({});
            }}
            onEdgeClick={(_, edge) => {
              setSelectedEdge(edge.id);
              setSelectedId(null);
              setPanel(null);
            }}
            onPaneClick={() => {
              setSelectedId(null);
              setSelectedEdge(null);
              setPanel(null);
              setFieldErrors({});
            }}
            nodesDraggable={!p.disabled}
            nodesConnectable={!p.disabled}
            edgesReconnectable={false}
            deleteKeyCode={p.disabled ? null : ['Backspace', 'Delete']}
            fitView
            fitViewOptions={{ padding: 0.16, maxZoom: 0.9 }}
            minZoom={0.01}
            maxZoom={1.5}
            defaultEdgeOptions={{ type: 'smoothstep' }}
          >
            <Background gap={20} size={1} color="#cbd3c4" />
            <Controls showInteractive={false} />
            <MiniMap
              nodeColor={(n) =>
                (n.data.node as FlowNode).type === 'trigger'
                  ? '#88a479'
                  : '#dce5d5'
              }
              maskColor="rgba(240,243,235,.6)"
              pannable
              zoomable
            />
          </ReactFlow>
          {componentFocus && (
            <div className={styles.breadcrumb}>
              <button
                onClick={() => {
                  setComponentFocus(null);
                  setSelectedId(null);
                  setPanel(null);
                  setSelectedEdge(null);
                }}
              >
                ← Workflow
              </button>
              <span>
                / {flow.nodes.find((n) => n.id === componentFocus)?.name}{' '}
                components
              </span>
            </div>
          )}
          {flow.nodes.length === 0 && (
            <div className={styles.empty}>
              <strong>Start with a trigger</strong>
              <p>Add nodes, connect their outputs, then configure each step.</p>
              <button onClick={() => addNode('trigger')}>
                Add first trigger
              </button>
            </div>
          )}
          {selectedEdge && (
            <div className={styles.edgeActions}>
              <span>
                {flow.edges.find((e) => e.id === selectedEdge)?.sourceHandle}{' '}
                connection
              </span>
              <button
                disabled={p.disabled}
                onClick={() => {
                  change({
                    ...flow,
                    edges: flow.edges.filter((e) => e.id !== selectedEdge),
                  });
                  setSelectedEdge(null);
                }}
              >
                Delete connection
              </button>
            </div>
          )}
        </div>
        {panel && (
          <aside
            className={styles.panel}
            aria-label={
              panel === 'node'
                ? 'Node settings'
                : panel === 'add'
                  ? 'Node picker'
                  : panel === 'settings'
                    ? 'Flow settings'
                    : 'Flow issues'
            }
          >
            <div className={styles.panelHeader}>
              <strong>
                {panel === 'node'
                  ? (selected?.name ?? 'Node settings')
                  : panel === 'add'
                    ? 'Add a node'
                    : panel === 'settings'
                      ? 'Flow settings'
                      : 'Check your flow'}
              </strong>
              <button title="Close panel" onClick={() => setPanel(null)}>
                ×
              </button>
            </div>
            <div className={styles.panelBody}>
              {panel === 'add' && (
                <>
                  <input
                    aria-label="Search nodes"
                    placeholder="Search nodes…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    autoFocus
                  />
                  {(
                    [
                      'Triggers',
                      'Actions',
                      'AI components',
                      'Logic',
                      'Delivery',
                    ] as const
                  ).map((group) => {
                    const list = FLOW_NODES.filter(
                      (d) =>
                        d.group === group &&
                        `${d.name} ${d.description}`
                          .toLowerCase()
                          .includes(search.toLowerCase()),
                    );
                    return (
                      list.length > 0 && (
                        <div key={group}>
                          <h3>{group}</h3>
                          {list.map((def) => (
                            <button
                              key={def.type}
                              className={styles.paletteItem}
                              disabled={p.disabled}
                              onClick={() => addNode(def.type)}
                            >
                              <span className={styles.nodeIcon}>
                                {def.icon}
                              </span>
                              <span>
                                <strong>{def.name}</strong>
                                <small>{def.description}</small>
                              </span>
                            </button>
                          ))}
                        </div>
                      )
                    );
                  })}
                  {!FLOW_NODES.some((d) =>
                    `${d.name} ${d.description}`
                      .toLowerCase()
                      .includes(search.toLowerCase()),
                  ) && <p>No matching nodes.</p>}
                </>
              )}
              {panel === 'node' && selected && definition && (
                <>
                  <span className={styles.typeBadge}>
                    {definition.group} / {definition.name}
                  </span>
                  <p className={styles.description}>{definition.description}</p>
                  <label className={styles.field}>
                    Name
                    <input
                      value={selected.name}
                      disabled={p.disabled}
                      onChange={(e) => updateNode({ name: e.target.value })}
                    />
                  </label>
                  {!!attachmentPorts(selected.type).length && (
                    <button
                      onClick={() => {
                        setComponentFocus(componentOwner(flow, selected.id));
                        setLayoutRevision((r) => r + 1);
                      }}
                    >
                      Open components
                    </button>
                  )}
                  {definition.fields
                    .filter(
                      (f) =>
                        !f.visibleWhen ||
                        selected.parameters[f.visibleWhen.key] ===
                          f.visibleWhen.value,
                    )
                    .map((field) => (
                      <ParameterField
                        key={`${selected.id}:${field.key}`}
                        field={field}
                        value={selected.parameters[field.key]}
                        models={flow.models}
                        disabled={p.disabled}
                        onChange={(value) =>
                          updateNode({
                            parameters: {
                              ...selected.parameters,
                              [field.key]: value,
                            },
                          })
                        }
                        onError={fieldError}
                      />
                    ))}
                  {selected.type.startsWith('delivery.') && (
                    <div className={styles.callout}>
                      Connected agents handle the AI work. This coordinator
                      supplies task input and the required result format.
                      Commands and limits live in{' '}
                      <button onClick={() => setPanel('settings')}>
                        Flow settings
                      </button>
                      .
                    </div>
                  )}
                  <ComponentSettings
                    flow={flow}
                    node={selected}
                    disabled={p.disabled}
                    open={(id) => {
                      setFieldErrors({});
                      focusNode(id);
                    }}
                    add={addNode}
                    connect={(source, target, port) =>
                      change(
                        connectFlow(flow, {
                          source,
                          target,
                          sourceHandle: 'provide',
                          targetHandle: port,
                        }),
                      )
                    }
                    disconnect={(id) =>
                      change({
                        ...flow,
                        edges: flow.edges.filter((e) => e.id !== id),
                      })
                    }
                  />
                  {!isResource(selected) &&
                    !isAttachedAgent(flow, selected.id) && (
                      <div className={styles.outputs}>
                        <h3>Connections</h3>
                        {definition.outputs.length === 0 ? (
                          <p>This node ends the run.</p>
                        ) : (
                          definition.outputs.map((port) => {
                            const edge = flow.edges.find(
                              (e) =>
                                e.source === selected.id &&
                                e.sourceHandle === port,
                            );
                            return (
                              <label key={port} className={styles.field}>
                                <span>{port}</span>
                                <select
                                  aria-label={`${port} destination`}
                                  value={edge?.target ?? ''}
                                  disabled={p.disabled}
                                  onChange={(e) => {
                                    const rest = flow.edges.filter(
                                      (v) =>
                                        !(
                                          v.source === selected.id &&
                                          v.sourceHandle === port
                                        ),
                                    );
                                    change({
                                      ...flow,
                                      edges: e.target.value
                                        ? [
                                            ...rest,
                                            {
                                              id: edge?.id ?? flowId('edge'),
                                              source: selected.id,
                                              sourceHandle: port,
                                              target: e.target.value,
                                            },
                                          ]
                                        : rest,
                                    });
                                  }}
                                >
                                  <option value="">Not connected</option>
                                  {flow.nodes
                                    .filter((n) =>
                                      canConnect(flow, {
                                        source: selected.id,
                                        sourceHandle: port,
                                        target: n.id,
                                      }),
                                    )
                                    .map((n) => (
                                      <option key={n.id} value={n.id}>
                                        {n.name}
                                      </option>
                                    ))}
                                </select>
                              </label>
                            );
                          })
                        )}
                      </div>
                    )}
                  <details>
                    <summary>Notes & data references</summary>
                    <label className={styles.field}>
                      Flow direction
                      <select
                        value={selected.direction ?? 'right'}
                        disabled={p.disabled}
                        onChange={(event) =>
                          updateNode({
                            direction: event.target.value as 'right' | 'left',
                          })
                        }
                      >
                        <option value="right">Left to right</option>
                        <option value="left">Right to left</option>
                      </select>
                    </label>
                    <label className={styles.field}>
                      Notes
                      <textarea
                        rows={3}
                        value={selected.notes ?? ''}
                        disabled={p.disabled}
                        onChange={(e) => updateNode({ notes: e.target.value })}
                      />
                    </label>
                    <p>
                      Use <code>{'{{issue.title}}'}</code> in text. JSON inputs
                      can use <code>{'{"$ref":"nodes.NODE_ID.summary"}'}</code>.
                      Commands run exactly as entered.
                    </p>
                    <small>
                      Node ID: <code>{selected.id}</code>
                    </small>
                  </details>
                  {problems
                    .filter((e) => e.nodeId === selected.id)
                    .map((e, i) => (
                      <p key={i} className={styles.error}>
                        {e.message}
                      </p>
                    ))}
                  <div className={styles.nodeActions}>
                    <button
                      disabled={p.disabled}
                      onClick={() => {
                        const id = flowId('node');
                        change({
                          ...flow,
                          nodes: [
                            ...flow.nodes,
                            {
                              ...structuredClone(selected),
                              id,
                              name: `${selected.name} copy`,
                              position: {
                                x: selected.position.x + 40,
                                y: selected.position.y + 100,
                              },
                            },
                          ],
                        });
                        setSelectedId(id);
                      }}
                    >
                      Duplicate
                    </button>
                    <button
                      disabled={p.disabled}
                      className={styles.danger}
                      onClick={() => removeNode(selected.id)}
                    >
                      Delete node
                    </button>
                  </div>
                </>
              )}
              {panel === 'settings' && (
                <>
                  <label className={styles.field}>
                    Flow name
                    <input
                      value={flow.name}
                      disabled={p.disabled}
                      onChange={(e) =>
                        change({ ...flow, name: e.target.value })
                      }
                    />
                  </label>
                  <h3>Repository commands</h3>
                  <p className={styles.description}>
                    Run in the lead repository. Leave unavailable commands
                    empty.
                  </p>
                  {(['install', 'test', 'lint', 'build'] as const).map(
                    (key) => (
                      <label key={key} className={styles.field}>
                        {key}
                        <input
                          value={flow.settings.commands[key]}
                          disabled={p.disabled}
                          placeholder={`e.g. pnpm ${key}`}
                          onChange={(e) =>
                            updateSettings({
                              commands: {
                                ...flow.settings.commands,
                                [key]: e.target.value,
                              },
                            })
                          }
                        />
                      </label>
                    ),
                  )}
                  <h3>UI inspection</h3>
                  <label className={styles.checkbox}>
                    <input
                      type="checkbox"
                      checked={flow.settings.ui !== null}
                      disabled={p.disabled}
                      onChange={(e) =>
                        updateSettings({
                          ui: e.target.checked
                            ? {
                                start: 'pnpm dev',
                                url: 'http://localhost:3000',
                              }
                            : null,
                        })
                      }
                    />
                    Start an app for UI checks
                  </label>
                  {flow.settings.ui && (
                    <>
                      {(['start', 'url'] as const).map((key) => (
                        <label key={key} className={styles.field}>
                          {key === 'start'
                            ? 'Start command (use $PORT)'
                            : 'App URL'}
                          <input
                            value={flow.settings.ui![key]}
                            disabled={p.disabled}
                            onChange={(e) =>
                              updateSettings({
                                ui: {
                                  ...flow.settings.ui!,
                                  [key]: e.target.value,
                                },
                              })
                            }
                          />
                        </label>
                      ))}
                      <p className={styles.description}>
                        UI inspection uses the profile’s Playwright MCP server.
                      </p>
                    </>
                  )}
                  <h3>Limits</h3>
                  {(
                    [
                      'reviewCap',
                      'ciCap',
                      'ciLogLines',
                      'maxTransitions',
                    ] as const
                  ).map((key) => (
                    <label key={key} className={styles.field}>
                      {
                        {
                          reviewCap: 'Review & validation cycles',
                          ciCap: 'CI repair attempts',
                          ciLogLines: 'CI log lines',
                          maxTransitions: 'Maximum node transitions',
                        }[key]
                      }
                      <input
                        type="number"
                        min={1}
                        value={flow.settings[key]}
                        disabled={p.disabled}
                        onChange={(e) =>
                          updateSettings({ [key]: Number(e.target.value) })
                        }
                      />
                    </label>
                  ))}
                  <h3>Linear states</h3>
                  {(['started', 'review', 'done'] as const).map((key) => (
                    <label key={key} className={styles.field}>
                      {key}
                      <input
                        value={flow.settings.states[key]}
                        disabled={p.disabled}
                        onChange={(e) =>
                          updateSettings({
                            states: {
                              ...flow.settings.states,
                              [key]: e.target.value,
                            },
                          })
                        }
                      />
                    </label>
                  ))}
                  <details>
                    <summary>Model slots & advanced settings</summary>
                    <p>
                      Choose each slot’s harness and model on the profile’s
                      General tab.
                    </p>
                    <ParameterField
                      field={{
                        key: 'models',
                        label: 'Model slots',
                        kind: 'json',
                      }}
                      value={flow.models}
                      models={flow.models}
                      disabled={p.disabled}
                      onChange={(value) =>
                        change(
                          parseFlow(JSON.stringify({ ...flow, models: value })),
                        )
                      }
                      onError={fieldError}
                    />
                    <ParameterField
                      field={{
                        key: 'readiness',
                        label: 'UI readiness',
                        kind: 'json',
                      }}
                      value={flow.settings.readiness}
                      models={flow.models}
                      disabled={p.disabled}
                      onChange={(value) =>
                        change(
                          parseFlow(
                            JSON.stringify({
                              ...flow,
                              settings: { ...flow.settings, readiness: value },
                            }),
                          ),
                        )
                      }
                      onError={fieldError}
                    />
                  </details>
                  <h3>Portable flow</h3>
                  <p className={styles.description}>
                    Export the graph and its settings as JSON. Model selections
                    and credentials stay in the profile.
                  </p>
                  <div className={styles.nodeActions}>
                    <button onClick={exportFlow}>Export JSON</button>
                    <button
                      disabled={p.disabled}
                      onClick={() => fileInput.current?.click()}
                    >
                      Import JSON
                    </button>
                  </div>
                  <input
                    hidden
                    ref={fileInput}
                    type="file"
                    accept="application/json,.json"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      try {
                        if (file.size > 2000000)
                          throw new Error(
                            'Flow file must be smaller than 2 MB.',
                          );
                        change(parseFlow(await file.text()));
                        setImportError('');
                        setFieldErrors({});
                        setSelectedId(null);
                      } catch (e) {
                        setImportError(
                          e instanceof Error ? e.message : String(e),
                        );
                      } finally {
                        e.target.value = '';
                      }
                    }}
                  />
                  {importError && (
                    <p role="alert" className={styles.error}>
                      {importError}
                    </p>
                  )}
                </>
              )}
              {panel === 'issues' && (
                <>
                  <p>
                    Connect each output and complete the node settings before
                    saving.
                  </p>
                  {problems.map((problem, index) => (
                    <button
                      className={styles.problem}
                      key={index}
                      onClick={() =>
                        problem.nodeId && focusNode(problem.nodeId)
                      }
                    >
                      {problem.message}
                    </button>
                  ))}
                  {Object.values(fieldErrors).map((error) => (
                    <p key={error} className={styles.error}>
                      {error}
                    </p>
                  ))}
                  {valid && <p>All nodes are connected and configured.</p>}
                </>
              )}
            </div>
          </aside>
        )}
      </div>
      <footer className={styles.footer}>
        <button
          className={valid ? styles.valid : styles.error}
          onClick={() => setPanel('issues')}
        >
          {valid
            ? '✓ Flow is valid'
            : `○ ${problems.length + Object.keys(fieldErrors).length} things to fix`}
        </button>
        <span>
          Drag to arrange · Connect the dots · Select a node to configure
        </span>
        <span>Changes apply to new runs</span>
      </footer>
    </section>
  );
}
