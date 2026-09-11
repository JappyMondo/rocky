import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { withAbort } from '../abort.js';
import type { McpServer } from './config.js';

/** A short-lived inspection session; no tools are executed. */
export async function inspectMcp(
  server: McpServer,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  const client = new Client({
    name: 'rocky-connection-check',
    version: '1.0.0',
  });
  const config = server.config;
  const transport =
    config.type === 'stdio'
      ? new StdioClientTransport({
          command: config.command,
          args: config.args,
          env: Object.fromEntries(
            Object.entries({ ...env, ...config.env }).filter(
              (entry): entry is [string, string] => entry[1] !== undefined,
            ),
          ),
          stderr: 'pipe',
        })
      : config.type === 'sse'
        ? new SSEClientTransport(new URL(config.url), {
            requestInit: { headers: config.headers, signal },
          })
        : new StreamableHTTPClientTransport(new URL(config.url), {
            requestInit: { headers: config.headers, signal },
          });
  try {
    if (transport instanceof StdioClientTransport)
      transport.stderr?.on('data', () => undefined);
    await withAbort(signal, () => client.connect(transport));
    const tools: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = await withAbort(signal, () =>
        client.listTools({ cursor }),
      );
      tools.push(...result.tools.map((tool) => tool.name));
      cursor = result.nextCursor;
      if (!cursor) return tools;
    }
    throw new Error('Tool inventory exceeds the inspection limit');
  } finally {
    await client.close();
    await transport.close();
  }
}
