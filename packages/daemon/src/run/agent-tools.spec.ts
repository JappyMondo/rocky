import { expect, it } from 'vitest';
import { agentToolInstructions, checkAgentBlocker } from './agent-tools.js';

it('recognizes a final blocked envelope after ordinary streamed commentary', () => {
  expect(() =>
    checkAgentBlocker(
      'I will check the renderer.\n<blocked>{"reason":"No renderer","requiredTool":"agent-browser","fix":"Install and expose agent-browser"}</blocked>',
    ),
  ).toThrow(/agent-browser/);
});
it('does not interpret a quoted blocker inside a successful result as a failure', () => {
  expect(() =>
    checkAgentBlocker(
      '<result>{"summary":"The protocol example is <blocked>...</blocked>"}</result>',
    ),
  ).not.toThrow();
  expect(() => checkAgentBlocker('<blocked>{}</blocked>')).toThrow(
    /without valid reason/,
  );
});
it('only offers shell/browser instructions to Agents granted bash', () => {
  expect(agentToolInstructions({ tools: ['read'] })).not.toContain(
    'command -v agent-browser',
  );
  expect(
    agentToolInstructions({ tools: ['read', 'bash'], mcp: ['browser'] }),
  ).toContain('Enabled MCP servers: browser');
});

it('limits validation handoff to existing non-manual catalog checks without waiving evidence', () => {
  const instructions = agentToolInstructions({
    tools: ['read', 'edit', 'bash'],
  });
  expect(instructions).toContain(
    'matching non-manual checks are owned by host Workflow validation',
  );
  expect(instructions).toContain('report pending host validation');
  expect(instructions).toContain('Never invent a host command');
  expect(instructions).toContain('claim pending evidence passed');
});
