import { isDeepStrictEqual } from 'node:util';
import type {
  Workflow,
  WorkflowContext,
  WorkflowInput,
  RunOutcome,
} from '@rocky/sdk';
import { z } from 'zod';
import {
  validateFlow,
  type WorkflowFlow,
  type FlowValue,
} from '@rocky/local-contracts';
import { createDeliveryOperations } from './delivery.js';

/** Data paths only: no JavaScript, function calls, prototype traversal or eval. */
export function resolveFlowValue(
  value: FlowValue,
  data: Record<string, unknown>,
): unknown {
  const lookup = (path: string) => {
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(path))
      throw new Error(`Invalid data reference: ${path}`);
    let result: unknown = data;
    for (const key of path.split('.')) {
      if (['__proto__', 'prototype', 'constructor'].includes(key))
        throw new Error(`Reserved reference key: ${key}`);
      if (
        result === null ||
        typeof result !== 'object' ||
        !Object.hasOwn(result, key)
      )
        throw new Error(
          `Data reference ${path} is unavailable. Connect the producing node before this node.`,
        );
      result = (result as Record<string, unknown>)[key];
    }
    return result;
  };
  if (typeof value === 'string')
    return value.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, path: string) => {
      const resolved = lookup(path.trim());
      return typeof resolved === 'string' ? resolved : JSON.stringify(resolved);
    });
  if (Array.isArray(value))
    return value.map((item) => resolveFlowValue(item, data));
  if (value && typeof value === 'object') {
    if (Object.hasOwn(value, '$ref')) {
      if (Object.keys(value).length !== 1 || typeof value.$ref !== 'string')
        throw new Error('A reference must contain only a string $ref.');
      return lookup(value.$ref);
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [key, resolveFlowValue(v, data)]),
    );
  }
  return value;
}

export function flowBindings(source: string, snapshotDir: string) {
  const flow = validateFlow(source);
  // Invalid output schemas must fail admission, before any effects run.
  for (const node of flow.nodes)
    if (node.type === 'agent' && node.parameters.schema)
      z.fromJSONSchema(node.parameters.schema as z.core.JSONSchema.JSONSchema);
  return flow.nodes
    .filter((node) => node.type === 'trigger')
    .map((node) => ({
      descriptor:
        node.parameters.kind === 'manual'
          ? { kind: 'manual' as const, name: String(node.parameters.name) }
          : { kind: 'linear.onDelegate' as const },
      workflow: ((ctx, input) =>
        executeFlow(flow, node.id, ctx, input, snapshotDir)) satisfies Workflow,
    }));
}

export async function executeFlow(
  flow: WorkflowFlow,
  triggerId: string,
  ctx: WorkflowContext,
  workspace: WorkflowInput,
  snapshotDir: string,
): Promise<RunOutcome> {
  // Validate at this boundary too: embedders cannot accidentally execute an invalid graph.
  validateFlow(JSON.stringify(flow));
  const nodes = new Map(flow.nodes.map((node) => [node.id, node]));
  if (nodes.get(triggerId)?.type !== 'trigger')
    throw new Error(`Unknown flow trigger: ${triggerId}`);
  // Delivery state and data are local to one boot, reconstructed by ctx replay.
  // Never wrap an entire node in ctx.step: nested steps must remain parkable.
  let delivery: ReturnType<typeof createDeliveryOperations> | undefined;
  const data: Record<string, unknown> = {
    issue: ctx.issue,
    workspace,
    input: null,
    nodes: {},
  };
  let current = triggerId;
  let merged = false;
  for (
    let transitions = 0;
    transitions < flow.settings.maxTransitions;
    transitions++
  ) {
    const node = nodes.get(current)!;
    ctx.stage(node.name);
    const p = node.parameters;
    const resolved = (key: string, fallback: FlowValue = '') =>
      resolveFlowValue(p[key] ?? fallback, data);
    const text = (key: string) => {
      const value = resolved(key);
      if (typeof value !== 'string')
        throw new Error(`${node.name}: ${key} must resolve to text.`);
      return value;
    };
    let port = 'next';
    let output: unknown = data.input;
    switch (node.type) {
      case 'trigger':
        output = ctx.issue;
        break;
      case 'agent': {
        const selection = ctx.models[String(p.model)];
        if (!selection)
          throw new Error(`${node.name}: configure model slot ${p.model}.`);
        const options = {
          ...selection,
          label: node.name,
          input: resolved('input', null),
          tools: p.tools as ('read' | 'edit' | 'bash')[],
          mcp: p.mcp as string[],
          timeout: p.timeout as number | undefined,
        };
        output = p.schema
          ? await ctx.agent(
              { prompt: text('prompt') },
              {
                ...options,
                schema: z.fromJSONSchema(
                  p.schema as z.core.JSONSchema.JSONSchema,
                ),
              },
            )
          : await ctx.agent({ prompt: text('prompt') }, options);
        break;
      }
      case 'command': {
        // Commands are literal configuration. Do not interpolate issue/agent text into a shell.
        const result = await ctx.exec(
          `cd -- "$ROCKY_LEAD_REPO" && ${String(p.command)}`,
          { label: node.name },
        );
        output = result;
        port = result.exitCode === 0 ? 'success' : 'failure';
        break;
      }
      case 'condition': {
        const left = resolved('value', null),
          right = resolved('compare', null);
        const condition =
          p.operator === 'truthy'
            ? !!left
            : p.operator === 'contains'
              ? typeof left === 'string'
                ? left.includes(String(right))
                : Array.isArray(left) &&
                  left.some((item) => isDeepStrictEqual(item, right))
              : p.operator === 'greaterThan'
                ? typeof left === 'number' &&
                  typeof right === 'number' &&
                  left > right
                : p.operator === 'notEquals'
                  ? !isDeepStrictEqual(left, right)
                  : isDeepStrictEqual(left, right);
        port = condition ? 'true' : 'false';
        break;
      }
      case 'question': {
        const result = await ctx.question({
          title: text('title'),
          body: text('body'),
        });
        output = result;
        port = 'cancelled' in result ? 'cancelled' : 'answered';
        break;
      }
      case 'checkpoint': {
        const result = await ctx.checkpoint({
          title: text('title'),
          body: text('body'),
        });
        output = result;
        port = result.decision;
        break;
      }
      case 'post':
        await ctx.post(text('body'));
        break;
      case 'setState':
        await ctx.linear.setState(text('state'));
        break;
      case 'finish':
        return merged ? 'merged' : (p.outcome as RunOutcome);
      default:
        if (!node.type.startsWith('delivery.'))
          throw new Error(`Unsupported node: ${node.type}`);
        delivery ??= createDeliveryOperations(
          ctx,
          workspace,
          flow.settings,
          snapshotDir,
        );
        port = await delivery(node.type.slice('delivery.'.length));
        // A merged result is an observed platform fact, never a configurable finish outcome.
        if (port === 'merged') merged = true;
        output = { status: port };
    }
    (data.nodes as Record<string, unknown>)[node.id] = output;
    data.input = output;
    const edge = flow.edges.find(
      (item) => item.source === current && item.sourceHandle === port,
    );
    if (!edge) throw new Error(`${node.name}: no connection for ${port}.`);
    current = edge.target;
  }
  throw new Error(
    `Flow stopped after ${flow.settings.maxTransitions} transitions. Check the loop connections or raise the limit in Flow settings.`,
  );
}
