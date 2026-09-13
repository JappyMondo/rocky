import { expect, it, vi } from 'vitest';
import { chooseWorkflowModels } from './workflow-models.js';

function prompt(answers: string[]) {
  const value = {
    ask: vi.fn(async () => {
      if (!answers.length) throw new Error('Missing scripted answer');
      return answers.shift()!;
    }),
    say: vi.fn(),
    waitFor: vi.fn(),
    askSecret: vi.fn(),
    close: vi.fn(),
  };
  return { value, create: () => value };
}
it('asks even with saved suggestions and preserves distinct helper choices', async () => {
  const p = prompt([
    '',
    '',
    '',
    'n',
    'claude-code',
    'claude-fixed-model',
    'low',
  ]);
  expect(
    await chooseWorkflowModels(
      {},
      { harness: 'opencode', model: 'openai/fixed-model', effort: 'high' },
      p.create,
    ),
  ).toEqual({
    agent: { harness: 'opencode', model: 'openai/fixed-model', effort: 'high' },
    fastAgent: {
      harness: 'claude-code',
      model: 'claude-fixed-model',
      effort: 'low',
    },
  });
  expect(p.value.ask).toHaveBeenCalledTimes(7);
  expect(p.value.close).toHaveBeenCalledOnce();
});
it('rejects incomplete flags and validates interactive omissions instead of taking defaults', async () => {
  await expect(
    chooseWorkflowModels({ model: 'openai/model' }, { harness: 'opencode' }),
  ).rejects.toThrow('--harness, --model and --variant');
  const p = prompt(['opencode', '', 'openai/selected', '', 'high', 'yes']);
  const result = await chooseWorkflowModels(
    {},
    { harness: 'opencode' },
    p.create,
  );
  expect(result.agent.model).toBe('openai/selected');
  expect(result.fastAgent).toEqual(result.agent);
  expect(p.value.say).toHaveBeenCalledWith(
    expect.stringContaining('harness defaults are not used'),
  );
});
it('uses explicit automation flags without prompting or inheriting saved defaults', async () => {
  const p = prompt([]);
  const result = await chooseWorkflowModels(
    { harness: 'opencode', model: 'openai/fixed', variant: 'high' },
    { harness: 'claude-code', model: 'different' },
    p.create,
  );
  expect(result.agent).toEqual({
    harness: 'opencode',
    model: 'openai/fixed',
    effort: 'high',
  });
  expect(result.fastAgent).toEqual(result.agent);
  expect(p.value.ask).not.toHaveBeenCalled();
});
