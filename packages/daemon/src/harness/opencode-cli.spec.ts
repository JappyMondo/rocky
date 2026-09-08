import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { opencode } from './opencode.js';
import type { HarnessInvocation } from './types.js';

// Real CLI, synthetic model HTTP server. This does not prove account eligibility.
it.runIf(process.env.ROCKY_OPENCODE_POLICY_TESTS === '1')(
  'enforces tool grants through the real OpenCode model request and native session store',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'rocky-cli-protocol-'));
    const requests: { tools?: { function: { name: string } }[] }[] = [];
    const authorizations: (string | undefined)[] = [];
    const server = createServer(async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405);
        res.end();
        return;
      }
      let source = '';
      for await (const chunk of req) source += chunk;
      const request = JSON.parse(source);
      if (req.url === '/mcp') {
        authorizations.push(req.headers.authorization);
        if (!('id' in request)) {
          res.writeHead(202);
          res.end();
          return;
        }
        const result =
          request.method === 'initialize'
            ? {
                protocolVersion: '2024-11-05',
                capabilities: { tools: {} },
                serverInfo: { name: 'fixture', version: '1' },
              }
            : request.method === 'tools/list'
              ? {
                  tools: [
                    {
                      name: 'ping',
                      description: 'Fixture ping',
                      inputSchema: { type: 'object', properties: {} },
                    },
                  ],
                }
              : { content: [{ type: 'text', text: 'pong' }] };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
        return;
      }
      requests.push(request);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const base = {
        id: 'fixture',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'fixture',
      };
      const tool = request.tools?.find(
        (tool: { function: { name: string } }) =>
          tool.function.name === 'api_ping',
      );
      const call =
        tool &&
        !request.messages.some(
          (message: { role: string }) => message.role === 'tool',
        );
      const delta = call
        ? {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'call_fixture',
                type: 'function',
                function: { name: 'api_ping', arguments: '{}' },
              },
            ],
          }
        : { role: 'assistant', content: 'fixture response' };
      res.write(
        `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\n`,
      );
      res.end('data: [DONE]\n\n');
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('No fixture port');
    try {
      await mkdir(join(root, '.git'));
      await mkdir(join(root, '.opencode', 'tools'), { recursive: true });
      const config = JSON.stringify({
        model: 'fixture/local',
        small_model: 'fixture/local',
        provider: {
          fixture: {
            npm: '@ai-sdk/openai-compatible',
            models: { local: {} },
            options: {
              baseURL: `http://127.0.0.1:${address.port}/v1`,
              apiKey: 'fixture-not-a-secret',
            },
          },
        },
        permission: { '*': 'allow' },
        tools: { bash: true },
        mcp: { ungranted: { type: 'local', command: ['must-not-launch'] } },
      });
      await writeFile(join(root, 'opencode.json'), config);
      await mkdir(join(root, '.rocky'));
      const declaration =
        '{"mcpServers":{"api":{"url":"https://declaration.invalid"}}}';
      await writeFile(join(root, '.rocky', 'mcp.json'), declaration);
      await writeFile(
        join(root, '.opencode', 'tools', 'escape.ts'),
        'throw new Error("must not execute")',
      );
      const input: HarnessInvocation = {
        command: 'opencode',
        cwd: root,
        prompt: 'reply',
        model: 'fixture/local',
        capabilities: ['read'],
        mcpServers: [
          {
            name: 'api',
            config: {
              type: 'http',
              url: `http://127.0.0.1:${address.port}/mcp`,
              headers: { Authorization: 'Bearer fixture-token' },
            },
          },
        ],
        sessionStorage: 'rocky',
        transcriptPath: join(root, 'sessions', 'one.jsonl'),
        timeoutMs: 45_000,
        env: {
          PATH: process.env.PATH,
          HOME: root,
          XDG_DATA_HOME: join(root, 'data'),
          XDG_CONFIG_HOME: join(root, 'config'),
          XDG_STATE_HOME: join(root, 'state'),
          XDG_CACHE_HOME: join(root, 'cache'),
          OPENCODE_AUTH_CONTENT: '{}',
          OPENCODE_DISABLE_MODELS_FETCH: 'true',
        },
      };
      const result = await opencode.run(input);
      expect(result.text).toBe('fixture response');
      expect(result.events).toContainEqual({
        kind: 'tool-result',
        name: 'api_ping',
      });
      expect(result.events).toContainEqual({ kind: 'turn-boundary' });
      const next = await opencode.resume({
        ...input,
        sessionId: result.sessionId,
      });
      expect(next.sessionId).toBe(result.sessionId);
      expect(requests.length).toBeGreaterThan(0);
      for (const request of requests) {
        const tools = request.tools?.map((tool) => tool.function.name) ?? [];
        expect(tools).not.toContain('bash');
        expect(tools).not.toContain('escape');
        expect(tools.some((tool) => tool.startsWith('ungranted'))).toBe(false);
      }
      expect(await readFile(join(root, 'opencode.json'), 'utf8')).toBe(config);
      expect(await readFile(join(root, '.rocky', 'mcp.json'), 'utf8')).toBe(
        declaration,
      );
      expect(authorizations.length).toBeGreaterThan(0);
      expect(
        authorizations.every((header) => header === 'Bearer fixture-token'),
      ).toBe(true);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (process.env.ROCKY_KEEP_PROBE === '1')
        console.info('Isolated protocol evidence:', root);
      else await rm(root, { recursive: true, force: true });
    }
  },
  120_000,
);
