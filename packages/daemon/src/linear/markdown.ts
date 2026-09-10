import { fromMarkdown } from 'mdast-util-from-markdown';
import { isDeepStrictEqual } from 'node:util';

/** Linear normalizes Markdown when persisting it. Compare syntax, preserving code and link targets. */
export function sameMarkdown(left: string, right: string): boolean {
  const tree = (text: string) =>
    JSON.parse(
      JSON.stringify(fromMarkdown(text), (key, value) =>
        key === 'position' ? undefined : value,
      ),
    );
  return left === right || isDeepStrictEqual(tree(left), tree(right));
}

export function sameActivityContent(
  left: Record<string, unknown>,
  right: unknown,
): boolean {
  const a = { ...left };
  if (!right || typeof right !== 'object' || Array.isArray(right)) return false;
  const b: Record<string, unknown> = { ...right };
  for (const field of ['body', 'result']) {
    if (
      typeof a[field] === 'string' &&
      typeof b[field] === 'string' &&
      sameMarkdown(a[field], b[field])
    ) {
      delete a[field];
      delete b[field];
    }
  }
  return isDeepStrictEqual(a, b);
}
