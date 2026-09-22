import { flowNodeDefinition } from './flow.js';
import type {
  FlowEdge,
  FlowNode,
  FlowNodeDefinition,
  WorkflowFlow,
} from './flow.js';

export type AttachmentKind = 'agent' | 'model' | 'prompt' | 'tools' | 'schema';
export interface AttachmentPort {
  id: string;
  name: string;
  kind: AttachmentKind;
  required?: boolean;
  multiple?: boolean;
}
const role = (id: string, name: string): AttachmentPort => ({
  id: `agent:${id}`,
  name,
  kind: 'agent',
  required: true,
});
const optionalRole = (id: string, name: string): AttachmentPort => ({
  id: `agent:${id}`,
  name,
  kind: 'agent',
});
const recap = [
  role('recap-inventory', 'Visual inventory'),
  role('recap-narrative', 'Recap writer'),
  role('recap-capture', 'Screenshot agent'),
  role('recap-audit', 'Evidence reviewer'),
];
const deliveryPorts: Record<string, AttachmentPort[]> = {
  clarify: [role('refiner', 'Scope agent')],
  deliverable: [
    role('deliverable-writer', 'Writer'),
    role('deliverable-reviewer', 'Reviewer'),
    ...recap,
  ],
  plan: [role('planner', 'Planning agent')],
  implement: [role('implementer', 'Implementation agent')],
  validate: [role('fixer', 'Repair agent')],
  compliance: [
    role('compliance-reviewer', 'Acceptance reviewer'),
    role('fixer', 'Repair agent'),
  ],
  ui: [
    role('ui-triage', 'UI triage'),
    role('ui-planner', 'Test planner'),
    role('ui-inspector', 'UI inspector'),
    role('ui-complaint-writer', 'Issue writer'),
    role('fixer', 'Repair agent'),
  ],
  review: [role('reviewer', 'Code reviewer'), role('fixer', 'Repair agent')],
  ci: [role('ci-fixer', 'CI repair agent')],
  recap: [...recap, optionalRole('fixer', 'Repair agent')],
  approval: [role('fixer', 'Steering agent')],
  merge: [role('merger', 'Merge agent')],
  conversations: [role('fixer', 'Reply agent'), ...recap],
};
export function attachmentPorts(type: string): AttachmentPort[] {
  if (type === 'agent')
    return [
      { id: 'model', name: 'Model', kind: 'model', required: true },
      { id: 'prompt', name: 'Prompt', kind: 'prompt', required: true },
      { id: 'tools', name: 'Tools', kind: 'tools', multiple: true },
      { id: 'schema', name: 'Output schema', kind: 'schema' },
    ];
  return deliveryPorts[type.replace(/^delivery\./, '')] ?? [];
}
export const isAttachment = (edge: FlowEdge) => edge.kind === 'attachment';
export const isResource = (node: FlowNode) => node.type.startsWith('ai.');
export function providerKind(type: string): AttachmentKind | undefined {
  return (
    {
      agent: 'agent',
      'ai.model': 'model',
      'ai.prompt': 'prompt',
      'ai.tool': 'tools',
      'ai.mcp': 'tools',
      'ai.schema': 'schema',
    } as Record<string, AttachmentKind>
  )[type];
}
export function attachedNodes(
  flow: WorkflowFlow,
  nodeId: string,
  port: string,
): FlowNode[] {
  const ids = new Set(
    flow.edges
      .filter(
        (e) =>
          isAttachment(e) && e.target === nodeId && e.targetHandle === port,
      )
      .map((e) => e.source),
  );
  return flow.nodes.filter((n) => ids.has(n.id));
}
export function isAttachedAgent(flow: WorkflowFlow, nodeId: string): boolean {
  return (
    flow.nodes.some((n) => n.id === nodeId && n.type === 'agent') &&
    flow.edges.some((e) => isAttachment(e) && e.source === nodeId)
  );
}
export function canConnect(
  flow: WorkflowFlow,
  connection: {
    source: string | null;
    target: string | null;
    sourceHandle?: string | null;
    targetHandle?: string | null;
  },
): boolean {
  const source = flow.nodes.find((n) => n.id === connection.source),
    target = flow.nodes.find((n) => n.id === connection.target);
  if (!source || !target) return false;
  if (connection.sourceHandle === 'provide') {
    const port = attachmentPorts(target.type).find(
      (p) => p.id === connection.targetHandle,
    );
    return (
      source.id !== target.id &&
      !!port &&
      !(port.id === 'schema' && isAttachedAgent(flow, target.id)) &&
      !(
        source.type === 'agent' &&
        flow.edges.some(
          (e) =>
            !isAttachment(e) &&
            (e.source === source.id || e.target === source.id),
        )
      ) &&
      port.kind === providerKind(source.type)
    );
  }
  return (
    !!connection.sourceHandle &&
    !!flowNodeDefinition(source.type)?.outputs.includes(
      connection.sourceHandle,
    ) &&
    !isResource(source) &&
    !isResource(target) &&
    !isAttachedAgent(flow, source.id) &&
    !isAttachedAgent(flow, target.id) &&
    target.type !== 'trigger' &&
    !connection.targetHandle
  );
}

export const AI_NODES: FlowNodeDefinition[] = [
  {
    type: 'ai.model',
    name: 'AI model',
    group: 'AI components',
    icon: '◈',
    description:
      'Choose a profile model or configure a harness, model and effort here.',
    outputs: [],
    fields: [
      {
        key: 'source',
        label: 'Model source',
        kind: 'select',
        options: ['profile', 'custom'],
        default: 'profile',
        required: true,
      },
      {
        key: 'slot',
        label: 'Profile model',
        kind: 'model',
        default: 'implementation',
        visibleWhen: { key: 'source', value: 'profile' },
      },
      {
        key: 'harness',
        label: 'Harness',
        kind: 'select',
        options: ['opencode', 'claude-code', 'codex'],
        default: 'opencode',
        visibleWhen: { key: 'source', value: 'custom' },
      },
      {
        key: 'model',
        label: 'Model ID',
        kind: 'text',
        default: '',
        visibleWhen: { key: 'source', value: 'custom' },
      },
      {
        key: 'effort',
        label: 'Variant / effort',
        kind: 'text',
        default: '',
        visibleWhen: { key: 'source', value: 'custom' },
      },
    ],
  },
  {
    type: 'ai.prompt',
    name: 'Prompt',
    group: 'AI components',
    icon: '≡',
    description:
      'Supply editable instructions or reuse a snapshotted profile prompt.',
    outputs: [],
    fields: [
      {
        key: 'source',
        label: 'Prompt source',
        kind: 'select',
        options: ['text', 'profile'],
        default: 'text',
        required: true,
      },
      {
        key: 'text',
        label: 'Instructions',
        kind: 'textarea',
        default: 'Complete the requested task and report the result.',
        visibleWhen: { key: 'source', value: 'text' },
      },
      {
        key: 'file',
        label: 'Profile prompt name',
        kind: 'text',
        default: '',
        hint: 'The name in Agent & tools, without .md. Captured with the run.',
        visibleWhen: { key: 'source', value: 'profile' },
      },
    ],
  },
  {
    type: 'ai.tool',
    name: 'Workspace tool',
    group: 'AI components',
    icon: '>_',
    description:
      'Give an agent a native capability. The profile tool policy still applies.',
    outputs: [],
    fields: [
      {
        key: 'capability',
        label: 'Capability',
        kind: 'select',
        options: ['read', 'edit', 'bash'],
        default: 'read',
        required: true,
      },
    ],
  },
  {
    type: 'ai.mcp',
    name: 'MCP tools',
    group: 'AI components',
    icon: '⌘',
    description: 'Give an agent tools from a configured MCP server.',
    outputs: [],
    fields: [
      {
        key: 'server',
        label: 'MCP server name',
        kind: 'text',
        default: '',
        required: true,
        hint: 'Use a server declared in this profile’s MCP configuration.',
      },
    ],
  },
  {
    type: 'ai.schema',
    name: 'Output schema',
    group: 'AI components',
    icon: '{}',
    description:
      'Validate structured output from a general AI agent. Delivery coordinators own their required result contracts.',
    outputs: [],
    fields: [
      {
        key: 'schema',
        label: 'Output JSON schema',
        kind: 'json',
        default: { type: 'object', properties: {} },
      },
    ],
  },
];
