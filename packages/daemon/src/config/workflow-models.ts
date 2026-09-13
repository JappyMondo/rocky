import { parse } from '@babel/parser';
import { z } from 'zod';
import type { WorkflowModels } from '@rocky/local-contracts';

const identifier = z.string().trim().min(1).max(300).regex(/^\S+$/);
export const agentModelSchema = z.strictObject({
  harness: z.enum(['opencode', 'claude-code']),
  model: identifier.refine(
    (value) => !/^(default|auto)$/i.test(value),
    'Choose a model identifier.',
  ),
  effort: identifier.refine(
    (value) => !/^(default|auto)$/i.test(value),
    'Choose an explicit variant or effort.',
  ),
});
export const workflowModelsSchema = z.strictObject({
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
    return workflowModelsSchema.safeParse(Object.fromEntries(entries)).data;
  } catch {
    return undefined;
  }
}

/** Replace only the model declarations; preserve the rest of the Config block. */
export function configureWorkflowModels(
  source: string,
  input: WorkflowModels,
): string {
  const models = workflowModelsSchema.parse(input);
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
