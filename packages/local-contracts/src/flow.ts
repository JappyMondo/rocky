import {
  AI_NODES,
  attachedNodes,
  attachmentPorts,
  canConnect,
  isAttachment,
  isAttachedAgent,
  isResource,
} from './flow-components.js';
/** Versioned, JSON-only workflows shared by the editor and daemon. */
export type FlowValue =
  null | boolean | number | string | FlowValue[] | { [key: string]: FlowValue };
export interface FlowNode {
  id: string;
  type: string;
  name: string;
  position: { x: number; y: number };
  parameters: Record<string, FlowValue>;
  notes?: string;
  direction?: 'right' | 'left';
}
export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle: string;
  kind?: 'attachment';
  targetHandle?: string;
}
export interface FlowSettings {
  commands: { install: string; test: string; lint: string; build: string };
  ui: { start: string; url: string } | null;
  states: { started: string; review: string; done: string };
  reviewCap: number;
  ciCap: number;
  readiness: { attempts: number; intervalMs: number };
  ciLogLines: number;
  maxTransitions: number;
}
export interface WorkflowFlow {
  version: 2;
  name: string;
  models: Record<string, { name: string; description?: string }>;
  settings: FlowSettings;
  nodes: FlowNode[];
  edges: FlowEdge[];
}
export interface FlowField {
  key: string;
  label: string;
  kind: 'text' | 'textarea' | 'number' | 'select' | 'json' | 'model';
  options?: string[];
  required?: boolean;
  hint?: string;
  default?: FlowValue;
  visibleWhen?: { key: string; value: FlowValue };
}
export interface FlowNodeDefinition {
  type: string;
  name: string;
  group: 'Triggers' | 'Actions' | 'Logic' | 'Delivery' | 'AI components';
  description: string;
  icon: string;
  outputs: string[];
  fields: FlowField[];
}
const field = (
  key: string,
  label: string,
  kind: FlowField['kind'] = 'text',
  extra: Partial<FlowField> = {},
): FlowField => ({ key, label, kind, ...extra });
const action = (
  type: string,
  name: string,
  description: string,
  outputs = ['next'],
): FlowNodeDefinition => ({
  type: `delivery.${type}`,
  name,
  description,
  group: 'Delivery',
  icon: '◇',
  outputs,
  fields: [],
});
export const FLOW_NODES: FlowNodeDefinition[] = [
  ...AI_NODES,
  {
    type: 'trigger',
    name: 'Trigger',
    group: 'Triggers',
    icon: 'ϟ',
    description: 'Start on Linear delegation or a named manual request.',
    outputs: ['next'],
    fields: [
      field('kind', 'Event', 'select', {
        options: ['linear.onDelegate', 'manual'],
        default: 'manual',
        required: true,
      }),
      field('name', 'Manual trigger name', 'text', { default: 'custom-flow' }),
    ],
  },
  {
    type: 'agent',
    name: 'AI agent',
    group: 'Actions',
    icon: '✦',
    description:
      'Coordinate a connected model, prompt and tools. Use in the flow or attach to a delivery coordinator.',
    outputs: ['next'],
    fields: [
      field('input', 'Input', 'json', {
        default: { $ref: 'input' },
      }),
      field('timeout', 'Timeout (ms)', 'number', { default: 600000 }),
    ],
  },
  {
    type: 'command',
    name: 'Run command',
    group: 'Actions',
    icon: '>_',
    description:
      'Run a shell command in the lead repository; branch on the exit code.',
    outputs: ['success', 'failure'],
    fields: [
      field('command', 'Command', 'textarea', {
        required: true,
        default: 'git status --short',
      }),
    ],
  },
  {
    type: 'condition',
    name: 'Condition',
    group: 'Logic',
    icon: '⑂',
    description: 'Compare data from the issue or an earlier node.',
    outputs: ['true', 'false'],
    fields: [
      field('value', 'Value', 'json', { default: { $ref: 'input.summary' } }),
      field('operator', 'Comparison', 'select', {
        options: ['equals', 'notEquals', 'contains', 'truthy', 'greaterThan'],
        default: 'equals',
        required: true,
      }),
      field('compare', 'Compare with', 'json', { default: true }),
    ],
  },
  {
    type: 'question',
    name: 'Ask a question',
    group: 'Actions',
    icon: '?',
    description: 'Park the run until the human provides clarification.',
    outputs: ['answered', 'cancelled'],
    fields: [
      field('title', 'Title', 'text', {
        default: 'Clarify the request',
        required: true,
      }),
      field('body', 'Question', 'textarea', {
        default: 'What should Rocky focus on?',
        required: true,
      }),
    ],
  },
  {
    type: 'checkpoint',
    name: 'Approval',
    group: 'Logic',
    icon: '✓',
    description:
      'Wait for approval, rejection, or steering. Answers survive restarts.',
    outputs: ['approve', 'reject', 'steer'],
    fields: [
      field('title', 'Title', 'text', {
        default: 'Approve this result?',
        required: true,
      }),
      field('body', 'Details', 'textarea', {
        default: '{{input.summary}}',
        required: true,
      }),
    ],
  },
  {
    type: 'post',
    name: 'Post update',
    group: 'Actions',
    icon: '↗',
    description: 'Publish a durable update in the run’s Linear thread.',
    outputs: ['next'],
    fields: [
      field('body', 'Message', 'textarea', {
        default: '{{input.summary}}',
        required: true,
      }),
    ],
  },
  {
    type: 'setState',
    name: 'Linear state',
    group: 'Actions',
    icon: '◉',
    description: 'Move the issue to an exact team state name.',
    outputs: ['next'],
    fields: [
      field('state', 'State name', 'text', {
        default: 'In Progress',
        required: true,
      }),
    ],
  },
  {
    type: 'finish',
    name: 'Finish',
    group: 'Logic',
    icon: '■',
    description: 'End the run with an explicit outcome.',
    outputs: [],
    fields: [
      field('outcome', 'Outcome', 'select', {
        options: ['completed', 'rejected', 'exhausted'],
        default: 'completed',
        required: true,
      }),
    ],
  },
  action(
    'clarify',
    'Clarify scope',
    'Refine the request, ask questions, and record the delivery contract.',
    ['pr', 'comment', 'rejected'],
  ),
  action(
    'deliverable',
    'Review & deliver comment',
    'Draft, validate diagrams, review acceptance and accuracy, then publish with a visual recap.',
    ['completed', 'exhausted'],
  ),
  action(
    'plan',
    'Plan implementation',
    'Inspect the current diff and create an implementation plan.',
  ),
  action(
    'implement',
    'Implement & open draft',
    'Implement the plan, push the branch, and open a draft PR.',
  ),
  action(
    'validate',
    'Validate commands',
    'Run test, lint and build. Repair failures within the configured review limit.',
    ['next', 'retry', 'exhausted'],
  ),
  action(
    'compliance',
    'Check acceptance',
    'Review the delivery contract and repair blocking complaints.',
    ['next', 'retry', 'exhausted'],
  ),
  action(
    'ui',
    'Inspect UI',
    'Triage frontend changes, launch the app, collect screenshot evidence, and fix problems.',
    ['next', 'retry', 'exhausted'],
  ),
  action(
    'review',
    'Review changes',
    'Review the diff against repository rules and resolve complaints.',
    ['next', 'retry', 'exhausted'],
  ),
  action(
    'ci',
    'Check CI',
    'Wait for CI at the current head, repair failures, and revalidate changed code.',
    ['next', 'retry', 'exhausted'],
  ),
  action(
    'recap',
    'Visual recap',
    'Create an evidence-based visual recap of the validated PR.',
  ),
  action(
    'publish',
    'Ready for review',
    'Publish the review evidence and hand off the PR when merge is not requested.',
    ['next', 'completed'],
  ),
  action(
    'approval',
    'Approve merge',
    'Require a human checkpoint. Steering returns to validation.',
    ['approved', 'retry', 'rejected'],
  ),
  action(
    'merge',
    'Merge approved PR',
    'Update the branch and request platform merge using the approved checkpoint.',
    ['merged', 'retry'],
  ),
  action(
    'conversations',
    'Address PR conversations',
    'Resolve open review threads, push fixes, reply, and refresh the visual recap.',
    ['completed'],
  ),
];
export const flowNodeDefinition = (type: string) =>
  FLOW_NODES.find((item) => item.type === type);
export const defaultFlowSettings = (): FlowSettings => ({
  commands: { install: '', test: '', lint: '', build: '' },
  ui: null,
  states: { started: 'In Progress', review: 'In Review', done: 'Done' },
  reviewCap: 5,
  ciCap: 3,
  readiness: { attempts: 30, intervalMs: 1000 },
  ciLogLines: 200,
  maxTransitions: 500,
});
export const isFlowSource = (source: string): boolean =>
  source.trimStart().startsWith('{');
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const safeId = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[A-Za-z_][A-Za-z0-9_-]{0,99}$/.test(v) &&
  !['__proto__', 'prototype', 'constructor', 'then'].includes(v);
/** Structural validation is deliberately independent from graph completeness, for draft editing. */
export function parseFlow(source: string): WorkflowFlow {
  const value: unknown = JSON.parse(source);
  if (
    !record(value) ||
    value.version !== 2 ||
    typeof value.name !== 'string' ||
    !value.name.trim() ||
    !record(value.models) ||
    !record(value.settings) ||
    !Array.isArray(value.nodes) ||
    !Array.isArray(value.edges)
  )
    throw new Error(
      'Expected a version 2 flow with name, models, settings, nodes and edges.',
    );
  if (
    value.nodes.length > 250 ||
    value.edges.length > 1000 ||
    Object.keys(value.models).length > 64
  )
    throw new Error(
      'A flow supports up to 250 nodes, 1000 connections and 64 model slots.',
    );
  for (const [key, slot] of Object.entries(value.models))
    if (
      !safeId(key) ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
      !record(slot) ||
      typeof slot.name !== 'string' ||
      !slot.name.trim() ||
      (slot.description !== undefined && typeof slot.description !== 'string')
    )
      throw new Error(`Invalid model slot: ${key}.`);
  const ids = new Set<string>();
  for (const node of value.nodes) {
    if (
      !record(node) ||
      !safeId(node.id) ||
      ids.has(node.id) ||
      typeof node.type !== 'string' ||
      !flowNodeDefinition(node.type) ||
      typeof node.name !== 'string' ||
      !node.name.trim() ||
      !record(node.position) ||
      !Number.isFinite(node.position.x) ||
      !Number.isFinite(node.position.y) ||
      !record(node.parameters) ||
      (node.notes !== undefined && typeof node.notes !== 'string') ||
      (node.direction !== undefined &&
        !['right', 'left'].includes(String(node.direction)))
    )
      throw new Error(
        `Invalid, duplicate or unsupported node: ${record(node) ? node.id : '?'}.`,
      );
    ids.add(node.id);
  }
  const edgeIds = new Set<string>();
  for (const edge of value.edges) {
    if (
      !record(edge) ||
      !safeId(edge.id) ||
      edgeIds.has(edge.id) ||
      typeof edge.source !== 'string' ||
      typeof edge.target !== 'string' ||
      typeof edge.sourceHandle !== 'string' ||
      (edge.kind !== undefined && edge.kind !== 'attachment') ||
      (edge.targetHandle !== undefined && typeof edge.targetHandle !== 'string')
    )
      throw new Error('Invalid or duplicate connection.');
    edgeIds.add(edge.id);
  }
  const s = value.settings;
  for (const [key, max] of [
    ['reviewCap', 100],
    ['ciCap', 100],
    ['ciLogLines', 10000],
    ['maxTransitions', 10000],
  ] as const)
    if (!Number.isInteger(s[key]) || Number(s[key]) < 1 || Number(s[key]) > max)
      throw new Error(`${key} must be an integer between 1 and ${max}.`);
  for (const [key, fields] of [
    ['commands', ['install', 'test', 'lint', 'build']],
    ['states', ['started', 'review', 'done']],
  ] as const) {
    const item = s[key];
    if (
      !record(item) ||
      fields.some(
        (k) =>
          typeof item[k] !== 'string' ||
          (key === 'states' && !String(item[k]).trim()),
      )
    )
      throw new Error(`Invalid ${key} settings.`);
  }
  if (
    !record(s.readiness) ||
    !Number.isInteger(s.readiness.attempts) ||
    Number(s.readiness.attempts) < 1 ||
    Number(s.readiness.attempts) > 300 ||
    !Number.isInteger(s.readiness.intervalMs) ||
    Number(s.readiness.intervalMs) < 1 ||
    Number(s.readiness.intervalMs) > 60000
  )
    throw new Error('Invalid UI readiness settings.');
  if (s.ui !== null) {
    if (
      !record(s.ui) ||
      typeof s.ui.start !== 'string' ||
      !s.ui.start.trim() ||
      typeof s.ui.url !== 'string' ||
      !/^https?:\/\//.test(s.ui.url)
    )
      throw new Error(
        'UI needs a start command and HTTP(S) URL, or must be disabled.',
      );
  }
  return value as unknown as WorkflowFlow;
}
export interface FlowProblem {
  nodeId?: string;
  message: string;
}
export function flowProblems(flow: WorkflowFlow): FlowProblem[] {
  const errors: FlowProblem[] = [];
  const add = (message: string, nodeId?: string) =>
    errors.push({ message, nodeId });
  const nodes = new Map(flow.nodes.map((n) => [n.id, n]));
  const triggers = flow.nodes.filter((n) => n.type === 'trigger');
  if (!triggers.length) add('Add a trigger to start this flow.');
  const triggerNames = new Set<string>();
  for (const node of flow.nodes) {
    const def = flowNodeDefinition(node.type)!;
    for (const f of def.fields) {
      if (
        f.visibleWhen &&
        node.parameters[f.visibleWhen.key] !== f.visibleWhen.value
      )
        continue;
      const v = node.parameters[f.key];
      if (
        f.required &&
        (v === undefined || v === null || typeof v !== 'string' || !v.trim())
      )
        add(`${node.name}: ${f.label} is required.`, node.id);
      if (f.options && !f.options.includes(String(v)))
        add(`${node.name}: choose a valid ${f.label.toLowerCase()}.`, node.id);
      if (
        f.kind === 'model' &&
        typeof v === 'string' &&
        !Object.hasOwn(flow.models, v)
      )
        add(`${node.name}: model slot ${v} is not declared.`, node.id);
    }
    if (node.type === 'trigger') {
      const name =
        node.parameters.kind === 'manual'
          ? `manual:${node.parameters.name}`
          : 'linear.onDelegate';
      if (
        node.parameters.kind === 'manual' &&
        (typeof node.parameters.name !== 'string' ||
          !node.parameters.name.trim())
      )
        add(`${node.name}: enter a manual trigger name.`, node.id);
      if (triggerNames.has(name))
        add(`${node.name}: duplicate trigger ${name}.`, node.id);
      triggerNames.add(name);
    }
    {
      const p = node.parameters;
      for (const port of attachmentPorts(node.type)) {
        const links = flow.edges.filter(
          (e) =>
            isAttachment(e) &&
            e.target === node.id &&
            e.targetHandle === port.id,
        );
        if (
          (port.required && !links.length) ||
          (!port.multiple && links.length > 1)
        )
          add(
            `${node.name}: connect ${port.name} to ${port.multiple ? 'at least' : 'exactly'} one component.`,
            node.id,
          );
        if (new Set(links.map((e) => e.source)).size !== links.length)
          add(`${node.name}: duplicate ${port.name} connection.`, node.id);
      }
      if (node.type === 'agent') {
        if (
          ['prompt', 'model', 'tools', 'mcp', 'schema'].some(
            (key) => p[key] !== undefined,
          )
        )
          add(
            `${node.name}: configure model, prompt, tools and schema through connected components.`,
            node.id,
          );
        if (
          p.timeout !== undefined &&
          (!Number.isInteger(p.timeout) ||
            Number(p.timeout) < 1 ||
            Number(p.timeout) > 86400000)
        )
          add(`${node.name}: timeout must be 1–86400000 ms.`, node.id);
        if (
          isAttachedAgent(flow, node.id) &&
          flow.edges.some(
            (e) =>
              !isAttachment(e) &&
              (e.source === node.id || e.target === node.id),
          )
        )
          add(
            `${node.name}: an attached agent cannot also be a step in the flow.`,
            node.id,
          );
        if (
          isAttachedAgent(flow, node.id) &&
          attachedNodes(flow, node.id, 'schema').length
        )
          add(
            `${node.name}: the delivery coordinator supplies the required output schema.`,
            node.id,
          );
      }
      if (node.type === 'ai.model') {
        if (
          p.source === 'profile' &&
          (typeof p.slot !== 'string' || !Object.hasOwn(flow.models, p.slot))
        )
          add(`${node.name}: choose a declared profile model.`, node.id);
        if (
          p.source === 'custom' &&
          (typeof p.model !== 'string' ||
            !p.model.trim() ||
            typeof p.effort !== 'string' ||
            !p.effort.trim())
        )
          add(`${node.name}: enter a model ID and variant / effort.`, node.id);
      }
      if (node.type === 'ai.prompt') {
        if (
          p.source === 'text' &&
          (typeof p.text !== 'string' || !p.text.trim())
        )
          add(`${node.name}: instructions are required.`, node.id);
        if (
          p.source === 'profile' &&
          (typeof p.file !== 'string' || !/^[A-Za-z0-9_-]+$/.test(p.file))
        )
          add(
            `${node.name}: choose a safe profile prompt name without .md.`,
            node.id,
          );
      }
      if (
        node.type === 'ai.schema' &&
        (!record(p.schema) || p.schema.type !== 'object')
      )
        add(
          `${node.name}: output schema must describe a JSON object (type: object).`,
          node.id,
        );
    }
    for (const port of isAttachedAgent(flow, node.id) ? [] : def.outputs) {
      const edges = flow.edges.filter(
        (e) =>
          !isAttachment(e) && e.source === node.id && e.sourceHandle === port,
      );
      if (edges.length !== 1)
        add(`${node.name}: connect ${port} to exactly one node.`, node.id);
    }
  }
  for (const edge of flow.edges) {
    const from = nodes.get(edge.source),
      to = nodes.get(edge.target);
    if (!from || !to) add(`Connection ${edge.id} points to a missing node.`);
    else if (isAttachment(edge)) {
      if (edge.sourceHandle !== 'provide' || !canConnect(flow, edge))
        add(`Connection ${edge.id} uses incompatible component ports.`, to.id);
    } else if (
      !!edge.targetHandle ||
      isResource(from) ||
      isResource(to) ||
      to.type === 'trigger' ||
      !flowNodeDefinition(from.type)!.outputs.includes(edge.sourceHandle)
    )
      add(`Connection ${edge.id} uses an invalid port.`, from.id);
  }
  const reachable = new Set<string>();
  const visit = (id: string) => {
    if (reachable.has(id)) return;
    reachable.add(id);
    flow.edges
      .filter((e) => !isAttachment(e) && e.source === id)
      .forEach((e) => visit(e.target));
    flow.edges
      .filter((e) => isAttachment(e) && e.target === id)
      .forEach((e) => visit(e.source));
  };
  triggers.forEach((t) => visit(t.id));
  flow.nodes.forEach((n) => {
    if (!reachable.has(n.id))
      add(`${n.name}: this node is not connected to a trigger.`, n.id);
  });
  return errors;
}
export function validateFlow(source: string): WorkflowFlow {
  const flow = parseFlow(source);
  const errors = flowProblems(flow);
  if (errors.length) throw new Error(errors.map((e) => e.message).join('\n'));
  return flow;
}
export const flowTriggerNames = (flow: WorkflowFlow): string[] =>
  flow.nodes
    .filter((n) => n.type === 'trigger')
    .map((n) =>
      n.parameters.kind === 'manual'
        ? String(n.parameters.name)
        : 'linear.onDelegate',
    );
