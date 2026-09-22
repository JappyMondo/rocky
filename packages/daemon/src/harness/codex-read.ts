import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { glob, open, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { ResolvedMcpServer } from './types.js';

// Codex reads files through shell tools. Keep Rocky's read grant usable without
// granting a shell: this private, per-attempt MCP server has no write operations.
export async function startCodexReadTools(cwd: string): Promise<{
  server: ResolvedMcpServer;
  dispose(): Promise<void>;
}> {
  const token = randomUUID();
  const connections = new Set<McpServer>();
  const http = createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end();
      return;
    }
    const server = new McpServer({ name: 'rocky-read', version: '1.0.0' });
    const text = (value: string) => ({
      content: [{ type: 'text' as const, text: value }],
    });
    const path = z.string().min(1);
    server.registerTool(
      'read_file',
      {
        description:
          'Read a UTF-8 file, with optional one-based starting line. Output is bounded.',
        inputSchema: {
          path,
          start_line: z.number().int().positive().default(1),
        },
      },
      async ({ path, start_line }) => {
        const content = await readText(resolve(cwd, path));
        const lines = content.split('\n');
        return text(
          lines
            .slice(start_line - 1, start_line + 999)
            .map((line, index) => `${start_line + index}: ${line}`)
            .join('\n'),
        );
      },
    );
    server.registerTool(
      'list_directory',
      {
        description:
          'List names in a directory, including dotfiles. At most 1000 entries.',
        inputSchema: { path },
      },
      async ({ path }) =>
        text(
          (await readdir(resolve(cwd, path), { withFileTypes: true }))
            .slice(0, 1000)
            .map((entry) => entry.name + (entry.isDirectory() ? '/' : ''))
            .join('\n'),
        ),
    );
    server.registerTool(
      'glob_files',
      {
        description:
          'Find paths matching a glob, relative to a directory. At most 1000 entries.',
        inputSchema: { pattern: path, directory: path.default('.') },
      },
      async ({ pattern, directory }) => {
        const paths: string[] = [];
        for await (const entry of glob(pattern, {
          cwd: resolve(cwd, directory),
        })) {
          paths.push(entry);
          if (paths.length === 1000) break;
        }
        return text(paths.join('\n'));
      },
    );
    server.registerTool(
      'search_files',
      {
        description:
          'Search for literal text in UTF-8 files matching a glob. At most 1000 files and 200 matching lines; skips binary and oversized files.',
        inputSchema: {
          text: path,
          pattern: path.default('**/*'),
          directory: path.default('.'),
        },
      },
      async ({ text: needle, pattern, directory }) => {
        const root = resolve(cwd, directory);
        const matches: string[] = [];
        let scanned = 0;
        for await (const file of glob(pattern, { cwd: root })) {
          if (++scanned > 1000 || matches.length >= 200) break;
          let content: string;
          try {
            content = await readText(resolve(root, file));
          } catch {
            continue;
          }
          for (const [index, line] of content.split('\n').entries()) {
            if (line.includes(needle))
              matches.push(`${file}:${index + 1}: ${line.slice(0, 1000)}`);
            if (matches.length >= 200) break;
          }
        }
        return text(matches.join('\n'));
      },
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    connections.add(server);
    response.on('close', () => {
      connections.delete(server);
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response);
    } catch {
      if (!response.headersSent) response.writeHead(500);
      response.end();
      connections.delete(server);
      await server.close();
    }
  });
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(0, '127.0.0.1', resolve);
  });
  const address = http.address();
  if (!address || typeof address === 'string')
    throw new Error('No Codex read tool port');
  return {
    server: {
      name: 'rocky_read',
      config: {
        type: 'http',
        url: `http://127.0.0.1:${address.port}/mcp`,
        headers: { Authorization: `Bearer ${token}` },
      },
    },
    async dispose() {
      await Promise.all([...connections].map((server) => server.close()));
      http.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        http.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

async function readText(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 1024 * 1024)
      throw new Error('Read requires a regular file of at most 1 MiB.');
    const buffer = Buffer.alloc(Math.min(stat.size + 1, 1024 * 1024 + 1));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 1024 * 1024 || buffer.subarray(0, bytesRead).includes(0))
      throw new Error('File is too large or binary.');
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await file.close();
  }
}
