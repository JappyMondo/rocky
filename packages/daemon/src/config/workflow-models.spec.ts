import { expect, it } from 'vitest';
import {
  configureWorkflowModels,
  readWorkflowModels,
  workflowModelsSchema,
} from './workflow-models.js';
import type { WorkflowModels } from '@rocky/local-contracts';

const models: WorkflowModels = {
  agent: { harness: 'opencode', model: 'openai/main-model', effort: 'xhigh' },
  fastAgent: {
    harness: 'claude-code',
    model: 'claude-helper-model',
    effort: 'low',
  },
};
it('pins separate models in multiline or typed declarations while preserving other configuration and code', () => {
  const source = `// BEGIN ROCKY CONFIG\nconst commands = { test: 'custom' };\nconst agent: Record<string, string> = {\n harness: 'opencode'\n};\nconst fastAgent = { harness: 'opencode', model: 'old' };\n// END ROCKY CONFIG\nthrow new Error('must not execute');`;
  const configured = configureWorkflowModels(source, models);
  expect(readWorkflowModels(configured)).toEqual(models);
  expect(configured).toContain("const commands = { test: 'custom' };");
  expect(configured).toContain("throw new Error('must not execute');");
  expect(configured).not.toContain("model: 'old'");
});
it('inserts missing declarations into a legacy Config block and safely encodes identifiers', () => {
  const special = {
    ...models,
    agent: { ...models.agent, model: "provider/model'\\name" },
  };
  const configured = configureWorkflowModels(
    '// BEGIN ROCKY CONFIG\nconst cap = 7;\n// END ROCKY CONFIG\nexport default [];',
    special,
  );
  expect(readWorkflowModels(configured)).toEqual(special);
  expect(configured).toContain('const cap = 7;');
  expect(configured.indexOf('const agent')).toBeLessThan(
    configured.indexOf('// END ROCKY CONFIG'),
  );
});
it('never presents implicit, dynamic or malformed settings as a pinned model choice', () => {
  for (const source of [
    'const agent = {harness: "opencode"};',
    'not TypeScript!',
    configureWorkflowModels('', models).replace(
      "effort: 'xhigh',",
      "effort: 'xhigh', ...defaults,",
    ),
  ])
    expect(readWorkflowModels(source)).toBeUndefined();
  for (const effort of ['', ' ', 'auto', 'default'])
    expect(
      workflowModelsSchema.safeParse({
        ...models,
        agent: { ...models.agent, effort },
      }).success,
    ).toBe(false);
  expect(workflowModelsSchema.safeParse({ agent: models.agent }).success).toBe(
    false,
  );
});
