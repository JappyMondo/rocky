import { fromMarkdown } from 'mdast-util-from-markdown';
import { isDeepStrictEqual } from 'node:util';

function plainUrl(node: {
  type: string;
  url?: string;
  title?: string | null;
  children?: { type: string; value?: string }[];
}) {
  const text = node.children?.[0];
  const label = text?.value ?? '';
  const destination = node.url ?? '';
  return node.type === 'link' &&
    /^https?:\/\//i.test(destination) &&
    !node.title &&
    node.children?.length === 1 &&
    text?.type === 'text' &&
    (label === destination ||
      (/^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(label) &&
        (destination === `http://${label}` ||
          destination === `https://${label}`)))
    ? { type: 'text', value: label }
    : node;
}

/** Linear normalizes Markdown when persisting it. Compare syntax, preserving code and link targets. */
export function sameMarkdown(left: string, right: string): boolean {
  const tree = (text: string) =>
    JSON.parse(
      JSON.stringify(fromMarkdown(text), (key, value) => {
        if (key === 'position') return undefined;
        if (key !== 'children' || !Array.isArray(value)) return value;
        // Linear autolinks plain URLs. Flatten only links whose visible text
        // exactly equals their destination; retain named links and code nodes.
        const children = value.map(plainUrl);
        return children.reduce<typeof children>((result, child) => {
          const previous = result.at(-1);
          if (
            child.type === 'text' &&
            previous?.type === 'text' &&
            'value' in child &&
            'value' in previous
          )
            previous.value = String(previous.value) + String(child.value);
          else result.push(child);
          return result;
        }, []);
      }),
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
