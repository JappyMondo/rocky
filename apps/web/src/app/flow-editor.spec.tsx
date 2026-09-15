import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defaultFlowSettings, type WorkflowFlow } from '@rocky/local-contracts';
import { FlowEditor } from './flow-editor.js';
import styles from './flow-editor.module.css';

const fitView = vi.hoisted(() => vi.fn());

// Test the editor's state at the canvas callback seam; real XYFlow is checked in the browser.
vi.mock('@xyflow/react', async () => {
  const React = await import('react');
  return {
    Handle: () => null,
    Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
    useUpdateNodeInternals: () => () => undefined,
    MarkerType: { ArrowClosed: 'arrow' },
    Background: () => null,
    Controls: () => null,
    MiniMap: () => null,
    useNodesState: (initial: unknown[]) => {
      const [nodes, setNodes] = React.useState(initial);
      return [nodes, setNodes, () => undefined];
    },
    ReactFlow: (p: {
      children: React.ReactNode;
      nodes: Array<{ id: string; data: unknown; className?: string }>;
      edges: Array<{
        id: string;
        source: string;
        target: string;
        className?: string;
        style: React.CSSProperties;
      }>;
      nodeTypes: { operation: React.ComponentType<{ data: unknown }> };
      onInit: (instance: {
        fitView: typeof fitView;
        getNodes: () => unknown[];
        getViewport: () => { x: number; y: number; zoom: number };
      }) => void;
      onNodeMouseEnter: (e: unknown, n: unknown) => void;
      onNodeMouseLeave: () => void;
      onEdgeMouseEnter: (e: unknown, n: unknown) => void;
      onEdgeMouseLeave: () => void;
      onPaneMouseEnter: () => void;
      onNodeClick: (e: unknown, n: unknown) => void;
      onEdgeClick: (e: unknown, n: unknown) => void;
      onPaneClick: () => void;
      onNodeDragStop: (e: unknown, n: unknown) => void;
      onNodesDelete: (n: unknown[]) => void;
      onEdgesDelete: (n: unknown[]) => void;
      onConnect: (c: unknown) => void;
    }) => {
      React.useEffect(() => {
        p.onInit({
          fitView,
          getNodes: () => p.nodes,
          getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
        });
      }, [p]);
      return (
        <div data-testid="canvas">
          {p.nodes.map((n) => (
            <button
              key={n.id}
              data-testid={`node-${n.id}`}
              className={n.className}
              onMouseEnter={(e) => p.onNodeMouseEnter(e, n)}
              onMouseLeave={p.onNodeMouseLeave}
              onClick={(e) => p.onNodeClick(e, n)}
            >
              <p.nodeTypes.operation data={n.data} />
            </button>
          ))}
          {p.edges.map((e) => (
            <button
              key={e.id}
              data-testid={`edge-${e.id}`}
              className={e.className}
              style={e.style}
              onMouseEnter={(event) => p.onEdgeMouseEnter(event, e)}
              onMouseLeave={p.onEdgeMouseLeave}
              onClick={(event) => p.onEdgeClick(event, e)}
            >
              {e.source} → {e.target}
            </button>
          ))}
          <button onClick={p.onPaneClick} onMouseEnter={p.onPaneMouseEnter}>
            Deselect canvas
          </button>
          <button
            onClick={() =>
              p.onNodeDragStop(null, {
                ...p.nodes[1],
                position: { x: 450, y: 200 },
              })
            }
          >
            Move second node
          </button>
          <button onClick={() => p.onNodesDelete([p.nodes[1]])}>
            Canvas delete node
          </button>
          <button onClick={() => p.onEdgesDelete([p.edges[0]])}>
            Canvas delete edge
          </button>
          <button
            onClick={() =>
              p.onConnect({
                source: p.nodes[0].id,
                sourceHandle: 'next',
                target: p.nodes[1].id,
              })
            }
          >
            Canvas connect
          </button>
          {p.children}
        </div>
      );
    },
  };
});
const initial = (): WorkflowFlow => ({
  version: 2,
  name: 'Example flow',
  models: { planner: { name: 'Planner' } },
  settings: defaultFlowSettings(),
  nodes: [
    {
      id: 'start',
      name: 'Manual request',
      type: 'trigger',
      parameters: { kind: 'manual', name: 'test' },
      position: { x: 0, y: 0 },
    },
    {
      id: 'finish',
      name: 'All done',
      type: 'finish',
      parameters: { outcome: 'completed' },
      position: { x: 250, y: 0 },
    },
  ],
  edges: [
    { id: 'edge1', source: 'start', sourceHandle: 'next', target: 'finish' },
  ],
});
let saved: WorkflowFlow;
const validity = vi.fn();
function Editor({
  disabled = false,
  source = JSON.stringify(initial()),
}: {
  disabled?: boolean;
  source?: string;
}) {
  const [workflow, setWorkflow] = useState(source);
  const [prompts, setPrompts] = useState<Record<string, string>>({
    shared: 'Original instructions',
  });
  return (
    <FlowEditor
      source={workflow}
      promptContents={prompts}
      onPromptContentsChange={setPrompts}
      disabled={disabled}
      unsaved={workflow !== source}
      onChange={(value) => {
        saved = JSON.parse(value.source);
        setWorkflow(value.source);
      }}
      onValidityChange={validity}
    />
  );
}
beforeEach(() => {
  saved = initial();
  validity.mockClear();
  fitView.mockClear();
});
afterEach(cleanup);
const click = (name: string) =>
  fireEvent.click(screen.getByRole('button', { name }));
const label = (name: string) => screen.getByLabelText(name, { exact: true });
const fill = (name: string, value: string) =>
  fireEvent.change(label(name), { target: { value } });
const selectNode = (id: string) =>
  fireEvent.click(screen.getByTestId(`node-${id}`));

it('edits connected node settings, retains positions, and supports undo and redo', () => {
  render(<Editor />);
  selectNode('finish');
  fill('Name', 'Delivered');
  expect(saved.nodes[1].name).toBe('Delivered');
  click('Move second node');
  expect(saved.nodes[1].position).toEqual({ x: 450, y: 200 });
  click('↶');
  expect(saved.nodes[1].position).toEqual({ x: 250, y: 0 });
  click('↷');
  expect(saved.nodes[1].position).toEqual({ x: 450, y: 200 });
  fill('Outcome', 'rejected');
  expect(saved.nodes[1].parameters.outcome).toBe('rejected');
  fireEvent.click(screen.getByText('Notes & data references'));
  fill('Notes', 'Review this decision');
  fill('Flow direction', 'left');
  expect(saved.nodes[1]).toMatchObject({
    notes: 'Review this decision',
    direction: 'left',
  });
});

it('adds an agent, configures its input/model/tools, and connects it into a runnable flow', () => {
  render(<Editor />);
  click('+ Add node');
  fill('Search nodes', 'AI agent');
  fireEvent.click(
    screen.getByRole('button', { name: /AI agent Coordinate a connected/ }),
  );
  const added = saved.nodes[2].id;
  expect(validity).toHaveBeenLastCalledWith(false);
  fill('Input', '{"$ref":"issue"}');
  fill('Timeout (ms)', '9000');
  fill('Connect Model', 'new:ai.model');
  fill('Profile model', 'planner');
  const model = saved.nodes.at(-1)!;
  expect(model.type).toBe('ai.model');
  selectNode(added);
  fill('Connect Prompt', 'new:ai.prompt');
  fill('Instructions', 'Inspect the request');
  const prompt = saved.nodes.at(-1)!;
  selectNode(added);
  fill('Connect Tools', 'new:ai.tool');
  fill('Capability', 'bash');
  const tool = saved.nodes.at(-1)!;
  selectNode(added);
  fill('Connect Tools', 'new:ai.mcp');
  fill('MCP server name', 'docs');
  selectNode(added);
  fill('Connect Output schema', 'new:ai.schema');
  fill('Output JSON schema', '{"type":"object"}');
  selectNode(added);
  fill('next destination', 'finish');
  click('← Workflow');
  selectNode('start');
  fill('next destination', added);
  expect(validity).toHaveBeenLastCalledWith(true);
  expect(saved.nodes[2].parameters).toEqual({
    input: { $ref: 'issue' },
    timeout: 9000,
  });
  expect(saved.edges).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: 'attachment',
        source: model.id,
        target: added,
        targetHandle: 'model',
      }),
      expect.objectContaining({
        kind: 'attachment',
        source: prompt.id,
        target: added,
        targetHandle: 'prompt',
      }),
      expect.objectContaining({
        kind: 'attachment',
        source: tool.id,
        target: added,
        targetHandle: 'tools',
      }),
    ]),
  );
});

it('reports malformed JSON and disconnected outputs before saving', () => {
  render(<Editor />);
  click('+ Add node');
  fill('Search nodes', 'Condition');
  fireEvent.click(
    screen.getByRole('button', { name: /Condition Compare data/ }),
  );
  fill('Value', '{invalid');
  expect(screen.getByText('Enter valid JSON.')).toBeTruthy();
  expect(validity).toHaveBeenLastCalledWith(false);
  fill('Value', 'true');
  fill('true destination', 'finish');
  fill('false destination', 'finish');
  const id = saved.nodes[2].id;
  selectNode('start');
  fill('next destination', id);
  expect(validity).toHaveBeenLastCalledWith(true);
  fill('next destination', '');
  expect(validity).toHaveBeenLastCalledWith(false);
  fireEvent.click(screen.getByRole('button', { name: /things to fix/ }));
  expect(screen.getByText(/Manual request: connect next/)).toBeTruthy();
});

it('duplicates and deletes nodes with their connections, including canvas deletion', () => {
  render(<Editor />);
  selectNode('finish');
  click('Duplicate');
  expect(saved.nodes).toHaveLength(3);
  expect(validity).toHaveBeenLastCalledWith(false);
  click('Delete node');
  expect(saved.nodes).toHaveLength(2);
  expect(validity).toHaveBeenLastCalledWith(true);
  click('Canvas delete edge');
  expect(saved.edges).toHaveLength(0);
  click('Canvas connect');
  expect(saved.edges).toHaveLength(1);
  fireEvent.click(screen.getByTestId(`edge-${saved.edges[0].id}`));
  click('Delete connection');
  expect(saved.edges).toHaveLength(0);
  click('Canvas connect');
  click('Canvas delete node');
  expect(saved.nodes).toHaveLength(1);
  expect(saved.edges).toHaveLength(0);
});

it('configures commands, UI checks, review limits, states and portable model slots', () => {
  render(<Editor />);
  click('Flow settings');
  fill('Flow name', 'Delivery');
  expect((label('Pull requests') as HTMLSelectElement).value).toBe(
    'all-changed',
  );
  fill('Pull requests', 'lead');
  fill('Repositories without CI', 'settings, docs');
  fireEvent.blur(label('Repositories without CI'));
  for (const key of ['install', 'test', 'lint', 'build'])
    fill(key, `pnpm ${key}`);
  fireEvent.click(label('Start an app for UI checks'));
  fill('Start command (use $PORT)', 'pnpm dev --port $PORT');
  fill('App URL', 'http://localhost:4000');
  fill('Review & validation cycles', '8');
  fill('CI repair attempts', '4');
  fill('CI log lines', '250');
  fill('Maximum node transitions', '600');
  fill('started', 'Doing');
  fill('review', 'Review');
  fill('done', 'Complete');
  fireEvent.click(screen.getByText('Model slots & advanced settings'));
  fill(
    'Model slots',
    '{"planner":{"name":"Planner"},"writer":{"name":"Writer"}}',
  );
  fill('UI readiness', '{"attempts":20,"intervalMs":500}');
  expect(saved).toMatchObject({
    name: 'Delivery',
    models: { writer: { name: 'Writer' } },
    settings: {
      commands: { test: 'pnpm test' },
      pullRequests: 'lead',
      ciSkipRepositories: ['settings', 'docs'],
      reviewCap: 8,
      ciCap: 4,
      ciLogLines: 250,
      maxTransitions: 600,
      readiness: { attempts: 20, intervalMs: 500 },
      states: { started: 'Doing', review: 'Review', done: 'Complete' },
      ui: { start: 'pnpm dev --port $PORT', url: 'http://localhost:4000' },
    },
  });
  fireEvent.click(label('Start an app for UI checks'));
  expect(saved.settings.ui).toBeNull();
  fill('Review & validation cycles', '0');
  expect(validity).toHaveBeenLastCalledWith(false);
});

it('imports and exports a portable flow and rejects unsupported formats', async () => {
  vi.stubGlobal(
    'URL',
    class extends URL {
      static override createObjectURL = vi.fn().mockReturnValue('blob:flow');
      static override revokeObjectURL = vi.fn();
    },
  );
  const anchor = vi
    .spyOn(HTMLAnchorElement.prototype, 'click')
    .mockImplementation(() => undefined);
  const { container } = render(<Editor />);
  click('Flow settings');
  click('Export JSON');
  expect(anchor).toHaveBeenCalled();
  const input = container.querySelector('input[type=file]')!;
  await act(async () => {
    fireEvent.change(input, {
      target: { files: [{ size: 50, text: async () => '{"version":99}' }] },
    });
  });
  expect(screen.getByRole('alert').textContent).toContain('version 2');
  const replacement = initial();
  replacement.name = 'Imported';
  replacement.nodes[1].name = 'Imported result';
  await act(async () => {
    fireEvent.change(input, {
      target: {
        files: [{ size: 100, text: async () => JSON.stringify(replacement) }],
      },
    });
  });
  expect(saved.name).toBe('Imported');
  expect(saved.nodes[1].name).toBe('Imported result');
  anchor.mockRestore();
  vi.unstubAllGlobals();
});

it('supports an empty canvas, node search, and a full-screen editing workspace', () => {
  const empty = initial();
  empty.nodes = [];
  empty.edges = [];
  render(<Editor source={JSON.stringify(empty)} />);
  expect(
    (screen.getByRole('button', { name: 'Auto layout' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  click('Add first trigger');
  expect(saved.nodes[0].type).toBe('trigger');
  click('+ Add node');
  fill('Search nodes', 'does-not-exist');
  expect(screen.getByText('No matching nodes.')).toBeTruthy();
  click('Full screen');
  expect(screen.getByRole('button', { name: 'Exit full screen' })).toBeTruthy();
  click('Exit full screen');
  click('Deselect canvas');
  expect(screen.queryByLabelText('Node picker')).toBeNull();
});

it('shows node-specific delivery guidance and validation issues', () => {
  const flow = initial();
  flow.nodes[1].type = 'delivery.plan';
  flow.nodes[1].parameters = {};
  render(<Editor source={JSON.stringify(flow)} />);
  selectNode('finish');
  const panel = screen.getByLabelText('Node settings');
  expect(within(panel).getByText(/Connected agents handle/)).toBeTruthy();
  fireEvent.click(within(panel).getByRole('button', { name: 'Flow settings' }));
  expect(screen.getByLabelText('Flow name')).toBeTruthy();
});

it('keeps mutations disabled when the editor is read-only', () => {
  render(<Editor disabled />);
  expect(
    (screen.getByRole('button', { name: 'Auto layout' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  click('Auto layout');
  expect(saved).toEqual(initial());
  expect(
    (screen.getByRole('button', { name: '+ Add node' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  selectNode('finish');
  expect((label('Name') as HTMLInputElement).disabled).toBe(true);
  expect(
    (screen.getByRole('button', { name: 'Delete node' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

it('saves through the toolbar and accepts a refreshed profile without retaining stale node selections', () => {
  const onSave = vi.fn(),
    onChange = vi.fn();
  const { rerender } = render(
    <FlowEditor
      source={JSON.stringify(initial())}
      disabled={false}
      unsaved
      onChange={onChange}
      onValidityChange={validity}
      onSave={onSave}
    />,
  );
  click('Save profile');
  expect(onSave).toHaveBeenCalledOnce();
  selectNode('finish');
  const updated = initial();
  updated.name = 'Freshly loaded';
  rerender(
    <FlowEditor
      source={JSON.stringify(updated)}
      disabled={false}
      unsaved={false}
      onChange={onChange}
      onValidityChange={validity}
      onSave={onSave}
    />,
  );
  expect(screen.getByText('Freshly loaded')).toBeTruthy();
  expect(screen.queryByLabelText('Name')).toBeNull();
  expect(
    (screen.getByRole('button', { name: 'Save profile' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  click('✓ Flow is valid');
  expect(
    screen.getByText('All nodes are connected and configured.'),
  ).toBeTruthy();
  click('×');
  expect(screen.queryByLabelText('Flow issues')).toBeNull();
});

it('auto layouts the draft, fits all nodes, and restores the arrangement with one undo', async () => {
  const original = initial();
  original.nodes[1].direction = 'left';
  original.nodes[1].position = { x: -400, y: -200 };
  render(<Editor source={JSON.stringify(original)} />);
  await waitFor(() => expect(fitView).toHaveBeenCalled());
  fitView.mockClear();
  click('Auto layout');
  expect(saved.nodes[1].position.x).toBeGreaterThan(saved.nodes[0].position.x);
  expect(saved.nodes[1].direction).toBe('right');
  expect(saved.edges).toEqual(original.edges);
  expect(screen.getByText(/Unsaved changes/)).toBeTruthy();
  await waitFor(() =>
    expect(fitView).toHaveBeenCalledWith({
      padding: 0.12,
      maxZoom: 0.9,
      duration: 200,
    }),
  );
  const arranged = saved;
  click('↶');
  expect(saved).toEqual(original);
  click('↷');
  expect(saved).toEqual(arranged);
});

it('highlights node and edge paths on hover, clears on exit, and leaves read-only flows unchanged', () => {
  const original = initial();
  original.nodes.push({ ...original.nodes[1], id: 'unrelated' });
  original.edges.push({
    id: 'sibling',
    source: 'start',
    target: 'unrelated',
    sourceHandle: 'other',
  });
  const onChange = vi.fn();
  render(
    <FlowEditor
      source={JSON.stringify(original)}
      disabled
      unsaved={false}
      onChange={onChange}
      onValidityChange={validity}
    />,
  );
  const start = screen.getByTestId('node-start');
  const finish = screen.getByTestId('node-finish');
  const unrelated = screen.getByTestId('node-unrelated');
  const edge = screen.getByTestId('edge-edge1');
  const sibling = screen.getByTestId('edge-sibling');
  fireEvent.mouseEnter(finish);
  expect(start.classList.contains(styles.connected)).toBe(true);
  expect(finish.classList.contains(styles.connected)).toBe(true);
  expect(unrelated.classList.contains(styles.unrelated)).toBe(true);
  expect(sibling.classList.contains(styles.unrelated)).toBe(true);
  expect(edge.style.strokeWidth).toBe('2.8');
  fireEvent.mouseLeave(finish);
  expect(start.className).toBe('');
  expect(unrelated.className).toBe('');
  expect(edge.style.strokeWidth).toBe('1.4');
  fireEvent.mouseEnter(edge);
  expect(finish.classList.contains(styles.connected)).toBe(true);
  expect(unrelated.classList.contains(styles.unrelated)).toBe(true);
  fireEvent.mouseLeave(edge);
  expect(finish.className).toBe('');
  fireEvent.mouseEnter(finish);
  fireEvent.mouseEnter(screen.getByRole('button', { name: 'Deselect canvas' }));
  expect(finish.className).toBe('');
  expect(onChange).not.toHaveBeenCalled();
  expect((screen.getByTitle('Undo') as HTMLButtonElement).disabled).toBe(true);
});

it('opens a coordinator group, replaces its connected agent, edits custom models and disconnects tools with undo', () => {
  const flow = initial();
  flow.nodes[1].type = 'delivery.implement';
  flow.nodes[1].parameters = {};
  render(<Editor source={JSON.stringify(flow)} />);
  selectNode('finish');
  click('Open components');
  fill('Connect Implementation agent', 'new:agent');
  const agent = saved.nodes.at(-1)!.id;
  expect(screen.queryByLabelText('next destination')).toBeNull();
  fill('Connect Model', 'new:ai.model');
  fill('Model source', 'custom');
  expect(screen.queryByLabelText('Profile model')).toBeNull();
  fill('Harness', 'claude-code');
  fill('Model ID', 'my-model');
  fill('Variant / effort', 'high');
  expect(saved.nodes.at(-1)!.parameters).toMatchObject({
    source: 'custom',
    harness: 'claude-code',
    model: 'my-model',
    effort: 'high',
  });
  selectNode(agent);
  fill('Connect Prompt', 'new:ai.prompt');
  fill('Prompt source', 'profile');
  fill('Profile prompt name', 'my-prompt');
  expect(screen.queryByLabelText('Instructions')).toBeNull();
  selectNode(agent);
  fill('Connect Tools', 'new:ai.tool');
  const tool = saved.nodes.at(-1)!.id;
  selectNode(agent);
  const disconnect = screen.getByTitle('Disconnect Workspace tool');
  fireEvent.click(disconnect);
  expect(saved.edges.some((e) => e.source === tool)).toBe(false);
  click('↶');
  expect(saved.edges.some((e) => e.source === tool)).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Workspace tool ↗' }));
  expect((label('Capability') as HTMLSelectElement).value).toBe('read');
  selectNode(agent);
  fill('Connect Tools', 'new:ai.tool');
  const second = saved.nodes.at(-1)!.id;
  selectNode(agent);
  expect(saved.edges.filter((e) => e.targetHandle === 'tools')).toHaveLength(2);
  fireEvent.click(screen.getAllByTitle('Disconnect Workspace tool')[1]);
  fill('Connect Tools', second);
  expect(saved.edges.filter((e) => e.targetHandle === 'tools')).toHaveLength(2);
  click('← Workflow');
  selectNode('finish');
  click('Delete node');
  expect(saved.nodes).toHaveLength(1);
  click('↶');
  expect(saved.nodes.some((n) => n.id === agent)).toBe(true);
});

it('reports an unsupported flow without crashing the profile screen', () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const { rerender } = render(
    <FlowEditor
      source='{"version":1}'
      disabled={false}
      unsaved={false}
      onChange={vi.fn()}
      onValidityChange={validity}
    />,
  );
  expect(screen.getByRole('alert').textContent).toContain('version 2');
  expect(validity).toHaveBeenLastCalledWith(false);
  rerender(
    <FlowEditor
      source={JSON.stringify(initial())}
      disabled={false}
      unsaved={false}
      onChange={vi.fn()}
      onValidityChange={validity}
    />,
  );
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByText('Example flow')).toBeTruthy();
  log.mockRestore();
});

it('edits referenced profile prompts and makes an independent inline copy with undo', () => {
  render(<Editor />);
  click('+ Add node');
  fill('Search nodes', 'AI agent');
  fireEvent.click(
    screen.getByRole('button', { name: /AI agent Coordinate a connected/ }),
  );
  fill('Connect Prompt', 'new:ai.prompt');
  fill('Prompt source', 'profile');
  fill('Profile prompt name', 'shared');
  expect(
    (label('Profile prompt instructions') as HTMLTextAreaElement).value,
  ).toBe('Original instructions');
  fill('Profile prompt instructions', 'Updated instructions\n');
  click('Use inline copy');
  expect((label('Instructions') as HTMLTextAreaElement).value).toBe(
    'Updated instructions\n',
  );
  fill('Instructions', 'Independent copy');
  click('↶');
  click('↶');
  expect(
    (label('Profile prompt instructions') as HTMLTextAreaElement).value,
  ).toBe('Updated instructions\n');
  fill('Profile prompt name', '../bad');
  expect(
    (
      screen.getByRole('button', {
        name: 'Create profile prompt',
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  fill('Profile prompt name', 'new-prompt');
  click('Create profile prompt');
  fill('Profile prompt instructions', 'New instructions');
  expect(
    (label('Profile prompt instructions') as HTMLTextAreaElement).value,
  ).toBe('New instructions');
});
