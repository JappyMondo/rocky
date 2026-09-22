import { isFlowSource, parseFlow } from '@rocky/local-contracts';
import { parse } from '@babel/parser';
import { z } from 'zod';
import type {
  WorkflowModels,
  WorkflowModelSlots,
} from '@rocky/local-contracts';

const identifier = z.string().trim().min(1).max(300).regex(/^\S+$/);
export const agentModelSchema = z.strictObject({
  harness: z.enum(['opencode', 'claude-code', 'codex']),
  model: identifier.refine(
    (value) => !/^(default|auto)$/i.test(value),
    'Choose a model identifier.',
  ),
  effort: identifier.refine(
    (value) => !/^(default|auto)$/i.test(value),
    'Choose an explicit variant or effort.',
  ),
});
const legacyWorkflowModelsSchema = z.strictObject({
  agent: agentModelSchema,
  fastAgent: agentModelSchema,
});

function declarations(source: string) {
  return parse(source, { sourceType: 'module', plugins: ['typescript'] })
    .program.body.flatMap((node) =>
      node.type === 'VariableDeclaration' ? node.declarations : [],
    )
    .filter(
      (node) =>
        node.id.type === 'Identifier' &&
        ['agent', 'fastAgent'].includes(node.id.name),
    );
}

/** Inspect literal settings without importing or executing a user's workflow. */
export function readWorkflowModels(source: string): WorkflowModels | undefined {
  try {
    const entries = declarations(source).map((node) => {
      const values: Record<string, string> = {};
      if (node.init?.type === 'ObjectExpression') {
        for (const prop of node.init.properties) {
          if (prop.type !== 'ObjectProperty' || prop.computed)
            throw new Error('Model settings must be literal strings.');
          const name =
            prop.key.type === 'Identifier'
              ? prop.key.name
              : prop.key.type === 'StringLiteral'
                ? prop.key.value
                : '';
          if (['harness', 'model', 'effort'].includes(name)) {
            if (prop.value.type !== 'StringLiteral')
              throw new Error('Model settings must be literal strings.');
            values[name] = prop.value.value;
          }
        }
      }
      return [node.id.type === 'Identifier' ? node.id.name : '', values];
    });
    if (entries.length !== 2) return undefined;
    return legacyWorkflowModelsSchema.safeParse(Object.fromEntries(entries))
      .data;
  } catch {
    return undefined;
  }
}

/** Replace only the model declarations; preserve the rest of the Config block. */
export function configureWorkflowModels(
  source: string,
  input: WorkflowModels,
): string {
  const models = legacyWorkflowModelsSchema.parse(input);
  const nodes = declarations(source);
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const missing: string[] = [];
  for (const name of ['agent', 'fastAgent'] as const) {
    const matches = nodes.filter(
      (node) => node.id.type === 'Identifier' && node.id.name === name,
    );
    if (matches.length > 1)
      throw new Error(`Workflow contains multiple ${name} declarations.`);
    const node = matches[0];
    const value =
      '{\n' +
      Object.entries(models[name])
        .map(
          ([key, value]) =>
            `  ${key}: '${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}',`,
        )
        .join('\n') +
      '\n}';
    if (node?.init?.start != null && node.init.end != null)
      edits.push({ start: node.init.start, end: node.init.end, text: value });
    else if (node)
      throw new Error(`Workflow ${name} declaration needs an initializer.`);
    else missing.push(`const ${name} = ${value};`);
  }
  for (const edit of edits.sort((a, b) => b.start - a.start))
    source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  if (missing.length) {
    const end = source.indexOf('// END ROCKY CONFIG');
    const index = end < 0 ? 0 : end;
    source =
      source.slice(0, index) + missing.join('\n') + '\n' + source.slice(index);
  }
  return source;
}

const slotKey = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
  .refine(
    (key) => !['__proto__', 'constructor', 'prototype', 'then'].includes(key),
    'Reserved model slot identifier.',
  );
export const workflowModelsSchema = z
  .unknown()
  .superRefine((input, ctx) => {
    if (input && typeof input === 'object')
      for (const key of Object.keys(input)) {
        if (!slotKey.safeParse(key).success)
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: 'Invalid or reserved model slot identifier.',
          });
      }
  })
  .pipe(z.record(slotKey, agentModelSchema));
const slotSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(1000).optional(),
});
const slotsSchema = z
  .record(slotKey, slotSchema)
  .refine(
    (slots) => Object.keys(slots).length <= 64,
    'Declare at most 64 model slots.',
  );

/** Read metadata only. Never import/execute workflow code in the editor. */
export function readWorkflowModelSlots(source: string): WorkflowModelSlots {
  if (isFlowSource(source)) return slotsSchema.parse(parseFlow(source).models);
  const program = parse(source, {
    sourceType: 'module',
    plugins: ['typescript'],
  }).program;
  const exported = program.body
    .flatMap((node) =>
      node.type === 'ExportNamedDeclaration' &&
      node.declaration?.type === 'VariableDeclaration' &&
      node.declaration.kind === 'const'
        ? node.declaration.declarations
        : [],
    )
    .filter(
      (node) => node.id.type === 'Identifier' && node.id.name === 'models',
    );
  if (exported.length !== 1)
    throw new Error(
      'Export a literal models object, e.g. export const models = { review: { name: "Review" } }; Use {} for workflows without agents.',
    );
  type Expression = NonNullable<(typeof exported)[number]['init']>;
  const unwrap = (node: Expression): Expression => {
    while (
      node.type === 'TSAsExpression' ||
      node.type === 'TSSatisfiesExpression' ||
      node.type === 'TSTypeAssertion'
    )
      node = node.expression;
    return node;
  };
  const object = (node: Expression) => {
    const value = unwrap(node);
    if (value.type !== 'ObjectExpression')
      throw new Error('Model slots must be a literal object.');
    const seen = new Set<string>();
    return value.properties.map((prop): [string, Expression] => {
      if (
        prop.type !== 'ObjectProperty' ||
        prop.computed ||
        prop.shorthand ||
        prop.value.type === 'AssignmentPattern' ||
        prop.value.type === 'RestElement'
      )
        throw new Error(
          'Model slots cannot use spreads, computed keys or shorthand properties.',
        );
      const key =
        prop.key.type === 'Identifier'
          ? prop.key.name
          : prop.key.type === 'StringLiteral'
            ? prop.key.value
            : '';
      if (!key || seen.has(key))
        throw new Error('Model slot keys must be unique identifiers.');
      seen.add(key);
      return [key, prop.value as Expression];
    });
  };
  if (!exported[0].init)
    throw new Error('The models export needs a literal initializer.');
  return slotsSchema.parse(
    Object.fromEntries(
      object(exported[0].init).map(([key, value]) => [
        slotKey.parse(key),
        Object.fromEntries(
          object(value).map(([field, text]) => {
            if (!['name', 'description'].includes(field))
              throw new Error(
                'Model slots declare only a name and optional description. Configure selections in the profile.',
              );
            if (text.type !== 'StringLiteral')
              throw new Error(
                'Model slot names and descriptions must be literal strings.',
              );
            return [field, text.value];
          }),
        ),
      ]),
    ),
  );
}

/** Require every declared slot, and reject stale/misspelled selections. */
export function validateWorkflowModels(
  source: string,
  input: unknown,
): WorkflowModels {
  const slots = readWorkflowModelSlots(source);
  const models = workflowModelsSchema.parse(input ?? {});
  const missing = Object.keys(slots).filter(
    (key) => !Object.hasOwn(models, key),
  );
  const extra = Object.keys(models).filter((key) => !Object.hasOwn(slots, key));
  if (missing.length)
    throw new Error(
      `Choose a harness, model and variant/effort for: ${missing.join(', ')}.`,
    );
  if (extra.length)
    throw new Error(
      `Undeclared model slots: ${extra.join(', ')}. Reload the workflow's model choices.`,
    );
  return models;
}

/** Compatibility for the CLI's main/helper flags when creating the default. */
export function defaultWorkflowModels(input: WorkflowModels): WorkflowModels {
  if (Object.keys(input).length === 2 && input.agent && input.fastAgent)
    return {
      review: input.agent,
      implementation: input.agent,
      planner: input.fastAgent,
    };
  return input;
}
