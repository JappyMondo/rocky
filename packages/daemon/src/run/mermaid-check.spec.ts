import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';

async function check(text: string, args: string[] = []) {
  const child = spawn(
    process.execPath,
    [new URL('./mermaid-check.ts', import.meta.url).pathname, ...args],
    { stdio: 'pipe' },
  );
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.stdin.end(text);
  const code = await new Promise((resolve) => child.on('close', resolve));
  return { code, stderr, data: stdout ? JSON.parse(stdout) : undefined };
}
it('checks actual Mermaid syntax, fingerprints the exact body, and distinguishes parsing from rendering', async () => {
  const body =
    '# Overview\n```mermaid\nflowchart LR\nA["API<br/>ingress"] --> B[(Store)]\n```\n~~~mermaid\nsequenceDiagram\nA->>B: Hello\n~~~';
  const valid = await check(body);
  expect(valid).toMatchObject({
    code: 0,
    data: {
      ok: true,
      rendered: false,
      sha256: createHash('sha256').update(body).digest('hex'),
      diagrams: [
        { index: 1, valid: true },
        { index: 2, valid: true },
      ],
    },
  });
  expect(await check('flowchart LR\nA[broken', ['--source'])).toMatchObject({
    code: 1,
    data: {
      ok: false,
      rendered: false,
      diagrams: [
        { valid: false, error: expect.stringContaining('Parse error') },
      ],
    },
  });
  expect(await check('No diagrams.')).toMatchObject({
    code: 0,
    data: { ok: true, diagrams: [] },
  });
});
it('rejects inputs beyond the bounded parser limits', async () => {
  expect(
    await check('flowchart LR\n' + 'A'.repeat(16001), ['--source']),
  ).toMatchObject({ code: 1, data: { ok: false } });
  expect(
    await check('```mermaid\nflowchart LR\nA-->B\n```\n'.repeat(31)),
  ).toMatchObject({ code: 2, stderr: expect.stringContaining('At most 30') });
  expect(await check('x'.repeat(1_000_001))).toMatchObject({
    code: 2,
    stderr: expect.stringContaining('1 MB'),
  });
});
