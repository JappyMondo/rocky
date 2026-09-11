import { createServer } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { inspectMcp } from './connection.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});

it('inspects a real local MCP process with profile environment and closes it', async () => {
  const script = `
    const readline = require('node:readline');
    readline.createInterface({ input: process.stdin }).on('line', (line) => {
      const request = JSON.parse(line);
      if (request.id === undefined) return;
      const result = request.method === 'initialize'
        ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
        : { tools: [{ name: process.env.FIXTURE_TOOL, inputSchema: { type: 'object' } }] };
      console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
    });
  `;
  expect(
    await inspectMcp(
      {
        name: 'local',
        config: {
          type: 'stdio',
          command: process.execPath,
          args: ['-e', script],
          env: { FIXTURE_TOOL: 'profile-tool' },
        },
      },
      AbortSignal.timeout(5000),
      { FIXTURE_TOOL: 'machine-tool', UNDEFINED: undefined },
    ),
  ).toEqual(['profile-tool']);
});

async function httpFixture(endless = false) {
  const calls: string[] = [];
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405).end();
      return;
    }
    if (request.headers.authorization !== 'Bearer fixture') {
      response.writeHead(401).end();
      return;
    }
    let body = '';
    for await (const chunk of request) body += chunk;
    const rpc = JSON.parse(body);
    calls.push(rpc.method);
    if (rpc.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    const result =
      rpc.method === 'initialize'
        ? {
            protocolVersion: '2025-03-26',
            capabilities: { tools: {} },
            serverInfo: { name: 'fixture', version: '1' },
          }
        : {
            tools: [
              {
                name: rpc.params?.cursor ? 'second' : 'first',
                inputSchema: { type: 'object' },
              },
            ],
            ...(!rpc.params?.cursor || endless ? { nextCursor: 'next' } : {}),
          };
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing fixture port');
  return { url: `http://127.0.0.1:${address.port}`, calls };
}

it('lists every tool page over authenticated HTTP without calling any tools', async () => {
  const f = await httpFixture();
  expect(
    await inspectMcp(
      {
        name: 'remote',
        config: {
          type: 'http',
          url: f.url,
          headers: { Authorization: 'Bearer fixture' },
        },
      },
      AbortSignal.timeout(5000),
      {},
    ),
  ).toEqual(['first', 'second']);
  expect(f.calls).not.toContain('tools/call');
  expect(f.calls.filter((call) => call === 'tools/list')).toHaveLength(2);
});

it('bounds unending inventories and fails unauthorized connections', async () => {
  const f = await httpFixture(true);
  await expect(
    inspectMcp(
      {
        name: 'remote',
        config: {
          type: 'http',
          url: f.url,
          headers: { Authorization: 'Bearer fixture' },
        },
      },
      AbortSignal.timeout(5000),
      {},
    ),
  ).rejects.toThrow('inspection limit');
  await expect(
    inspectMcp(
      { name: 'remote', config: { type: 'http', url: f.url } },
      AbortSignal.timeout(5000),
      {},
    ),
  ).rejects.toThrow();
});

it('cancels a stalled local handshake and rejects a missing executable', async () => {
  await expect(
    inspectMcp(
      {
        name: 'local',
        config: {
          type: 'stdio',
          command: process.execPath,
          args: ['-e', 'process.stdin.resume()'],
        },
      },
      AbortSignal.timeout(100),
      {},
    ),
  ).rejects.toThrow();
  await expect(
    inspectMcp(
      {
        name: 'missing',
        config: {
          type: 'stdio',
          command: '/nonexistent/rocky-test-executable',
        },
      },
      AbortSignal.timeout(5000),
      {},
    ),
  ).rejects.toThrow();
});
