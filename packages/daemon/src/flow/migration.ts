import { parse } from '@babel/parser';
import {
  defaultFlowSettings,
  isFlowSource,
  parseFlow,
  type FlowSettings,
} from '@rocky/local-contracts';

/** Preserve literal legacy settings without executing user TypeScript. */
export function flowSettingsFromSource(source: string): FlowSettings {
  if (isFlowSource(source)) return parseFlow(source).settings;
  const blocks =
    source.match(
      /^\/\/ BEGIN ROCKY CONFIG\r?\n[\s\S]*?^\/\/ END ROCKY CONFIG[ \t]*\r?$/gm,
    ) ?? [];
  const markers =
    source.match(/^\/\/ (?:BEGIN|END) ROCKY CONFIG[ \t]*\r?$/gm) ?? [];
  if (markers.length && (markers.length !== 2 || blocks.length !== 1))
    throw new Error(
      'The workflow Config block is malformed. Repair its BEGIN/END ROCKY CONFIG markers before resetting.',
    );
  const settings = defaultFlowSettings();
  if (!blocks.length) return settings;
  const program = parse(blocks[0]!, {
    sourceType: 'module',
    plugins: ['typescript'],
  }).program;
  const declarations = program.body.flatMap((node) =>
    node.type === 'VariableDeclaration' ? node.declarations : [],
  );
  type Expression = NonNullable<(typeof declarations)[number]['init']>;
  const literal = (node: Expression): unknown => {
    if (
      node.type === 'TSAsExpression' ||
      node.type === 'TSSatisfiesExpression' ||
      node.type === 'TSTypeAssertion'
    )
      return literal(node.expression);
    if (
      node.type === 'StringLiteral' ||
      node.type === 'NumericLiteral' ||
      node.type === 'BooleanLiteral'
    )
      return node.value;
    if (node.type === 'NullLiteral') return null;
    if (node.type === 'ObjectExpression')
      return Object.fromEntries(
        node.properties.map((prop) => {
          if (prop.type !== 'ObjectProperty' || prop.computed || prop.shorthand)
            throw new Error(
              'Config settings must use literal values before migrating to a flow.',
            );
          const key =
            prop.key.type === 'Identifier'
              ? prop.key.name
              : prop.key.type === 'StringLiteral'
                ? prop.key.value
                : '';
          if (!key || ['__proto__', 'constructor', 'prototype'].includes(key))
            throw new Error('Invalid Config key.');
          return [key, literal(prop.value as Expression)];
        }),
      );
    throw new Error(
      'Config settings must use literal values before migrating to a flow.',
    );
  };
  const values = settings as unknown as Record<string, unknown>;
  for (const item of declarations) {
    if (item.id.type !== 'Identifier' || !Object.hasOwn(settings, item.id.name))
      continue;
    if (!item.init) throw new Error(`Missing Config value: ${item.id.name}.`);
    const value = literal(item.init);
    const previous = values[item.id.name];
    values[item.id.name] =
      value &&
      typeof value === 'object' &&
      previous &&
      typeof previous === 'object'
        ? { ...previous, ...value }
        : value;
  }
  return settings;
}
