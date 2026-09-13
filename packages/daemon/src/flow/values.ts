import type { FlowValue } from '@rocky/local-contracts';

/** Data paths only: no JavaScript, function calls, prototype traversal or eval. */
export function resolveFlowValue(
  value: FlowValue,
  data: Record<string, unknown>,
): unknown {
  const lookup = (path: string) => {
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(path))
      throw new Error(`Invalid data reference: ${path}`);
    let result: unknown = data;
    for (const key of path.split('.')) {
      if (['__proto__', 'prototype', 'constructor'].includes(key))
        throw new Error(`Reserved reference key: ${key}`);
      if (
        result === null ||
        typeof result !== 'object' ||
        !Object.hasOwn(result, key)
      )
        throw new Error(
          `Data reference ${path} is unavailable. Connect the producing node before this node.`,
        );
      result = (result as Record<string, unknown>)[key];
    }
    return result;
  };
  if (typeof value === 'string')
    return value.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, path: string) => {
      const resolved = lookup(path.trim());
      return typeof resolved === 'string' ? resolved : JSON.stringify(resolved);
    });
  if (Array.isArray(value))
    return value.map((item) => resolveFlowValue(item, data));
  if (value && typeof value === 'object') {
    if (Object.hasOwn(value, '$ref')) {
      if (Object.keys(value).length !== 1 || typeof value.$ref !== 'string')
        throw new Error('A reference must contain only a string $ref.');
      return lookup(value.$ref);
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [key, resolveFlowValue(v, data)]),
    );
  }
  return value;
}
