import { expect, it } from 'vitest';
import {
  configureWorkflowModels,
  readWorkflowModels,
  readWorkflowModelSlots,
  validateWorkflowModels,
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
  expect(
    workflowModelsSchema.safeParse({ reviewer: models.agent }).success,
  ).toBe(true);
});

it('reads arbitrary named slots and TypeScript metadata without executing source', () => {
  const source = `throw new Error('never execute'); export const models = { REVIEW: { name: 'Review', description: 'Read only' }, coding: { name: 'Implement' } } as const satisfies WorkflowModelSlots;`;
  expect(readWorkflowModelSlots(source)).toEqual({
    REVIEW: { name: 'Review', description: 'Read only' },
    coding: { name: 'Implement' },
  });
  expect(
    validateWorkflowModels(source, {
      REVIEW: models.agent,
      coding: models.fastAgent,
    }),
  ).toEqual({ REVIEW: models.agent, coding: models.fastAgent });
  expect(() =>
    validateWorkflowModels(source, { REVIEW: models.agent }),
  ).toThrow(/coding/);
  expect(() =>
    validateWorkflowModels(source, {
      REVIEW: models.agent,
      coding: models.fastAgent,
      typo: models.agent,
    }),
  ).toThrow(/Undeclared.*typo/);
  expect(validateWorkflowModels('export const models = {};', {})).toEqual({});
});
it.each([
  'export default [];',
  'export let models = {};',
  'const slots = {}; export { slots as models };',
  'export const models = getModels();',
  'export const models = { ...slots };',
  'export const models = { [id]: { name: "Review" } };',
  'export const models = { review: { name: label } };',
  'export const models = { review: { name: "Review", model: "hardcoded" } };',
  'export const models = { review: { name: "" } };',
  'export const models = { review: { name: "A" }, review: { name: "B" } };',
  'export const models = { __proto__: { name: "Unsafe" } };',
  'export const models = { then: { name: "Reserved" } };',
  'export const models = { "bad-key": { name: "Invalid identifier" } };',
])('rejects invalid or dynamic declarations: %s', (source) => {
  expect(() => readWorkflowModelSlots(source)).toThrow();
});
