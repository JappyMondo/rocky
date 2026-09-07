import { describe, expect, it } from 'vitest';

import type { WorkflowContext } from './ctx.js';

describe('WorkflowContext', () => {
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
