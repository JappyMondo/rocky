import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  linear,
  manual,
  z,
  type AgentCallOpts,
  type RunOutcome,
  type Workflow,
  type WorkflowContext,
  type WorkflowInput,
} from './index.js';

describe('WorkflowContext', () => {
  it('passes readonly workspace members to a Workflow through public Triggers', () => {
    expectTypeOf<WorkflowInput>().toEqualTypeOf<{
      members: readonly { name: string; path: string; lead: boolean }[];
    }>();
    expectTypeOf<Parameters<Workflow>>().toEqualTypeOf<
      [WorkflowContext, WorkflowInput]
    >();
    const workflow: Workflow = async (ctx, input) => {
      expectTypeOf(ctx).toEqualTypeOf<WorkflowContext>();
      expectTypeOf(input).toEqualTypeOf<WorkflowInput>();
      // @ts-expect-error The Run's member list is readonly.
      input.members.push({ name: 'extra', path: '/extra', lead: false });
      return 'merged';
    };
    expectTypeOf<ReturnType<Workflow>>().toEqualTypeOf<Promise<RunOutcome>>();
    // @ts-expect-error Workflows must return a RunOutcome.
    const invalid: Workflow = async () => 'unknown';
    void invalid;
    expect(linear.onDelegate(workflow).workflow).toBe(workflow);
    expect(manual('retry', workflow).workflow).toBe(workflow);
  });

  it('types Agent tools, options, labels and injected summaries', () => {
    const useAgents = async (ctx: WorkflowContext) => {
      const schema = z.object({ count: z.number() });
      const opts: AgentCallOpts<typeof schema> = {
        schema,
        tools: ['read', 'edit', 'bash'],
        model: 'vendor/custom-model:verbatim',
        effort: 'vendor-specific-effort',
        timeout: 1_500,
      };
      expectTypeOf<AgentCallOpts['model']>().toEqualTypeOf<
        string | undefined
      >();
      expectTypeOf<AgentCallOpts['effort']>().toEqualTypeOf<
        string | undefined
      >();
      expectTypeOf<AgentCallOpts['timeout']>().toEqualTypeOf<
        number | undefined
      >();
      expectTypeOf<
        'capabilities' extends keyof AgentCallOpts ? true : false
      >().toEqualTypeOf<false>();
      const named = await ctx.agent('planner', { ...opts, schema });
      const inline = await ctx.agent(
        { prompt: 'Count changes' },
        {
          ...opts,
          schema,
          label: 'count changes',
        },
      );
      expectTypeOf(named).toEqualTypeOf<
        z.infer<typeof schema> & { summary: string }
      >();
      expectTypeOf(inline).toEqualTypeOf<
        z.infer<typeof schema> & { summary: string }
      >();
      expectTypeOf(await ctx.agent('planner')).toEqualTypeOf<{
        summary: string;
      }>();
      expectTypeOf(
        await ctx.agent('planner', { label: 'plan' }),
      ).toEqualTypeOf<{ summary: string }>();
      expectTypeOf(
        await ctx.agent({ prompt: 'Plan' }, { label: 'plan' }),
      ).toEqualTypeOf<{ summary: string }>();
      // @ts-expect-error Inline prompts require a label, even without options.
      ctx.agent({ prompt: 'Plan' });
      // @ts-expect-error Inline prompts require a label without a schema.
      ctx.agent({ prompt: 'Plan' }, {});
      // @ts-expect-error Inline prompts require a label with a schema.
      ctx.agent({ prompt: 'Plan' }, { schema });
      // @ts-expect-error The public option is tools, with no capabilities alias.
      ctx.agent('planner', { capabilities: ['read'] });
      // @ts-expect-error Only the three portable tools are supported.
      ctx.agent('planner', { tools: ['browser'] });
      // @ts-expect-error Effort is a string, not a numeric level.
      ctx.agent('planner', { effort: 3 });
      // @ts-expect-error Timeout is a number of milliseconds, not a duration string.
      ctx.agent('planner', { timeout: '1s' });
    };

    expect(useAgents).toBeTypeOf('function');
  });

  it('permits the Workflow authoring surface', () => {
    const useContext = async (ctx: WorkflowContext) => {
      const ports: number[] = ctx.ports;
      ctx.stage('Code review');
      const value = await ctx.step('derive title', () => ({ ports }));
      const results = await ctx.parallel([1, 2], async (item, index) =>
        ctx.exec(`printf ${item}-${index}`),
      );
      const backgroundOptions: { background: true; label: string } = {
        background: true,
        label: 'start dev server',
      };
      const background = await ctx.exec('pnpm dev', backgroundOptions);

      return { value, results, pid: background.pid };
    };

    expect(useContext).toBeTypeOf('function');
  });
});
