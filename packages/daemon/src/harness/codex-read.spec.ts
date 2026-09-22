import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { expect, it } from 'vitest';
import { startCodexReadTools } from './codex-read.js';

it('exposes only authenticated, bounded file inspection tools and closes the server', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'rocky-codex-read-'));
  const reader = await startCodexReadTools(cwd);
  const config = reader.server.config;
  if (config.type !== 'http') throw new Error('Expected HTTP reader');
  const client = new Client({ name: 'test', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: { headers: config.headers },
  });
  try {
    await mkdir(join(cwd, 'nested'));
    await writeFile(join(cwd, 'nested', 'note.txt'), 'first\ncranberry\nlast');
    await writeFile(join(cwd, '.hidden'), 'hidden');
    await writeFile(join(cwd, 'large.txt'), 'x'.repeat(1024 * 1024 + 1));
    await writeFile(join(cwd, 'binary'), Buffer.from([0, 1, 2]));
    expect((await fetch(config.url)).status).toBe(401);
    await client.connect(transport);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      'read_file',
      'list_directory',
      'glob_files',
      'search_files',
    ]);
    const read = await client.callTool({
      name: 'read_file',
      arguments: { path: 'nested/note.txt', start_line: 2 },
    });
    expect(read).toMatchObject({
      content: [{ type: 'text', text: '2: cranberry\n3: last' }],
    });
    expect(
      await client.callTool({
        name: 'glob_files',
        arguments: { pattern: '**/*.txt' },
      }),
    ).toMatchObject({
      content: [{ text: expect.stringContaining('nested/note.txt') }],
    });
    expect(
      await client.callTool({
        name: 'list_directory',
        arguments: { path: '.' },
      }),
    ).toMatchObject({
      content: [{ text: expect.stringContaining('.hidden') }],
    });
    expect(
      await client.callTool({
        name: 'search_files',
        arguments: { text: 'cranberry' },
      }),
    ).toMatchObject({ content: [{ text: 'nested/note.txt:2: cranberry' }] });
    for (const path of ['large.txt', 'binary', 'nested', 'missing'])
      expect(
        await client.callTool({ name: 'read_file', arguments: { path } }),
      ).toMatchObject({ isError: true });
    expect(
      await client.callTool({
        name: 'write_file',
        arguments: { path: 'forbidden' },
      }),
    ).toMatchObject({ isError: true });
  } finally {
    await client.close();
    await reader.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
  await expect(fetch(config.url)).rejects.toThrow();
});
