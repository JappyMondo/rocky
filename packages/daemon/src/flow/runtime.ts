import { isDeepStrictEqual } from 'node:util';
import { dirname } from 'node:path';
import type {
  Workflow,
  WorkflowContext,
  WorkflowInput,
  RunOutcome,
} from '@rocky/sdk';
import { z } from 'zod';
import {
  validateFlow,
  isAttachment,
  type WorkflowFlow,
  type FlowValue,
} from '@rocky/local-contracts';
import { createDeliveryOperations } from './delivery.js';
import {
  WorkspaceExecution,
  catalogEntries,
  dependencyOrder,
} from './workspace-execution.js';

import { resolveFlowValue } from './values.js';
export { resolveFlowValue } from './values.js';
import { configuredFlowAgent, invokeAgent, deliveryAgents } from './agents.js';

export function flowBindings(
  source: string,
  snapshotDir: string,
  continuations = 0,
) {
  const flow = validateFlow(source);
  // Invalid output schemas must fail admission, before any effects run.
  for (const node of flow.nodes)
    if (node.type === 'ai.schema' && node.parameters.schema)
      z.fromJSONSchema(node.parameters.schema as z.core.JSONSchema.JSONSchema);
  return flow.nodes
    .filter((node) => node.type === 'trigger')
    .map((node) => ({
      descriptor:
        node.parameters.kind === 'manual'
          ? { kind: 'manual' as const, name: String(node.parameters.name) }
          : { kind: 'linear.onDelegate' as const },
      workflow: ((ctx, input) =>
        executeFlow(
          flow,
          node.id,
          ctx,
          input,
          snapshotDir,
          continuations,
        )) satisfies Workflow,
    }));
}

export async function executeFlow(
  flow: WorkflowFlow,
  triggerId: string,
  ctx: WorkflowContext,
  workspace: WorkflowInput,
  snapshotDir: string,
  continuations = 0,
): Promise<RunOutcome> {
  // Validate at this boundary too: embedders cannot accidentally execute an invalid graph.
  flow = validateFlow(JSON.stringify(flow));
  const nodes = new Map(flow.nodes.map((node) => [node.id, node]));
  if (nodes.get(triggerId)?.type !== 'trigger')
    throw new Error(`Unknown flow trigger: ${triggerId}`);
  // Delivery state and data are local to one boot, reconstructed by ctx replay.
  // Never wrap an entire node in ctx.step: nested steps must remain parkable.
  let delivery: ReturnType<typeof createDeliveryOperations> | undefined;
  const services = flow.settings.execution
    ? new WorkspaceExecution(
        ctx,
        workspace,
        flow.settings.execution,
        dirname(snapshotDir),
      )
    : undefined;
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
    transitions < flow.settings.maxTransitions * (continuations + 1);
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
        const config = configuredFlowAgent(flow, node.id, ctx, data);
        output = await invokeAgent(ctx.agent, config);
        break;
      }
      case 'command': {
        if (p.recipe) {
          if (!flow.settings.execution)
            throw Error(
              'This command references repository configuration. Start it from a unified profile.',
            );
          const execution = new WorkspaceExecution(
            ctx,
            workspace,
            flow.settings.execution,
            dirname(snapshotDir),
          );
          const ordered = dependencyOrder(
            catalogEntries(flow.settings.execution),
            [String(p.recipe)],
            (entry) => entry.command.dependsOn,
          );
          for (const entry of ordered) {
            const result = await execution.command(
              entry.id,
              `${node.name}: ${entry.id}`,
            );
            output = result;
            port = result.exitCode === 0 ? 'success' : 'failure';
            if (result.exitCode !== 0) break;
          }
          break;
        }
        // Commands are literal configuration. Do not interpolate issue/agent text into a shell.
        const result = await ctx.exec(
          `cd -- "$ROCKY_LEAD_REPO" && ${String(p.command)}`,
          { label: node.name },
        );
        output = result;
        port = result.exitCode === 0 ? 'success' : 'failure';
        break;
      }
      case 'service.start':
        if (!services)
          throw Error('Dev service nodes require a unified profile.');
        output = await services.start([String(p.recipe)], node.id);
        break;
      case 'service.stop':
        await services?.stop(node.id);
        output = { stopped: true };
        break;
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
        await services?.stop('Workflow service cleanup');
        return merged ? 'merged' : (p.outcome as RunOutcome);
      default:
        if (!node.type.startsWith('delivery.'))
          throw new Error(`Unsupported node: ${node.type}`);
        delivery ??= createDeliveryOperations(
          ctx,
          workspace,
          flow.settings,
          snapshotDir,
          continuations,
        );
        port = await delivery(
          node.type.slice('delivery.'.length),
          deliveryAgents(flow, node.id, ctx, data),
        );
        // A merged result is an observed platform fact, never a configurable finish outcome.
        if (port === 'merged') merged = true;
        output = { status: port };
    }
    (data.nodes as Record<string, unknown>)[node.id] = output;
    data.input = output;
    const edge = flow.edges.find(
      (item) =>
        !isAttachment(item) &&
        item.source === current &&
        item.sourceHandle === port,
    );
    if (!edge) throw new Error(`${node.name}: no connection for ${port}.`);
    current = edge.target;
  }
  throw new Error(
    `Flow stopped after ${flow.settings.maxTransitions} transitions. Check the loop connections or raise the limit in Flow settings.`,
  );
}
