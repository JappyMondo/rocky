/** Standalone parser process: DOM globals never enter the daemon or Run worker. */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
// Keep DOM-only declarations out of the daemon's Node type environment.
const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (html: string) => { window: { document: unknown; close(): void } };
};
import { fromMarkdown } from 'mdast-util-from-markdown';

const digest = (text: string) =>
  createHash('sha256').update(text).digest('hex');
async function main() {
  let text = '';
  for await (const chunk of process.stdin) {
    text += chunk.toString();
    if (text.length > 1_000_000) throw new Error('Diagram input exceeds 1 MB.');
  }
  const sources: string[] = [];
  type Node = {
    type: string;
    lang?: string | null;
    value?: string;
    children?: Node[];
  };
  const visit = (node: Node) => {
    if (node.type === 'code' && node.lang?.toLowerCase() === 'mermaid')
      sources.push(node.value ?? '');
    for (const child of node.children ?? []) visit(child);
  };
  if (process.argv.includes('--source')) sources.push(text);
  else visit(fromMarkdown(text));
  if (sources.length > 30)
    throw new Error('At most 30 diagrams can be checked at once.');
  const dom = new JSDOM(''); // No scripts, resource loading, or network access.
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
  });
  try {
    const { default: mermaid } = await import('mermaid');
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      maxTextSize: 16000,
    });
    const diagrams = [];
    for (const [index, source] of sources.entries()) {
      try {
        if (source.length > 16000)
          throw new Error(
            'Diagram exceeds the 16,000-character display limit.',
          );
        const parsed = await mermaid.parse(source);
        diagrams.push({
          index: index + 1,
          sha256: digest(source),
          valid: true,
          type: parsed.diagramType,
        });
      } catch (error) {
        diagrams.push({
          index: index + 1,
          sha256: digest(source),
          valid: false,
          error: (error instanceof Error ? error.message : String(error)).slice(
            0,
            2000,
          ),
        });
      }
    }
    const ok = diagrams.every((item) => item.valid);
    process.stdout.write(
      JSON.stringify({
        ok,
        sha256: digest(text),
        validator: 'mermaid',
        rendered: false,
        diagrams,
      }) + '\n',
    );
    process.exitCode = ok ? 0 : 1;
  } finally {
    dom.window.close();
  }
}
void main().catch((error) => {
  process.stderr.write(
    `Mermaid validation unavailable: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 2;
});
