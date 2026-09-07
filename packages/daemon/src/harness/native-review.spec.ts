// Actual installed CLIs against local protocols, not authenticated inference.
// Adapted from the independent PR16 native reproducer, which remains untouched.
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getHarnessAdapter } from './adapter.js';
import type { HarnessInvocation } from './types.js';

describe.runIf(process.env.ROCKY_NATIVE_HARNESS_TESTS === '1')(
  'native review regressions',
  () => {
    for (const harness of ['claude-code', 'opencode'] as const) {
      for (const mode of [
        'parallel',
        'mcp401',
        'tool401',
        ...(harness === 'opencode' ? ['model401'] : ['host-auth']),
      ]) {
        it(`${harness}: ${mode}`, async () => {
          const root = await mkdtemp(join(tmpdir(), 'rocky-native-review-'));
          const abort = new AbortController();
          let slowFinished = false;
          let modelRequests = 0;
          let mcpRequests = 0;
          let sessionId = '';
          let modelAuthorization: string | undefined;
          const boundaries: boolean[] = [];
          const timers: ReturnType<typeof setTimeout>[] = [];
          const server = createServer(async (req, res) => {
            let body = '';
            for await (const chunk of req) body += chunk;
            const request = JSON.parse(body || '{}');
            if (req.url?.startsWith('/mcp')) {
              mcpRequests++;
              if (req.headers.authorization !== 'Bearer fixture-token') {
                res.writeHead(403);
                res.end();
                return;
              }
              if (
                mode === 'mcp401' ||
                (mode === 'tool401' && request.method === 'tools/call')
              ) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end('{"error":"unauthorized"}');
                return;
              }
              if (req.method !== 'POST') {
                res.writeHead(405);
                res.end();
                return;
              }
              if (!('id' in request)) {
                res.writeHead(202);
                res.end();
                return;
              }
              let result;
              if (request.method === 'initialize')
                result = {
                  protocolVersion: '2024-11-05',
                  capabilities: { tools: {} },
                  serverInfo: { name: 'fixture', version: '1' },
                };
              else if (request.method === 'tools/list')
                result = {
                  tools: ['fast', 'slow'].map((name) => ({
                    name,
                    description: name,
                    inputSchema: { type: 'object', properties: {} },
                    annotations: { readOnlyHint: true },
                  })),
                };
              else {
                if (request.params?.name === 'slow') {
                  await new Promise((resolve) =>
                    timers.push(setTimeout(resolve, 1_000)),
                  );
                  slowFinished = true;
                }
                result = {
                  content: [{ type: 'text', text: 'fixture tool result' }],
                };
              }
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({ jsonrpc: '2.0', id: request.id, result }),
              );
              return;
            }
            if (req.url?.includes('count_tokens')) {
              res.setHeader('Content-Type', 'application/json');
              res.end('{"input_tokens":1}');
              return;
            }
            if (
              !req.url?.includes('messages') &&
              !req.url?.includes('chat/completions')
            ) {
              res.end('{}');
              return;
            }
            modelRequests++;
            modelAuthorization = req.headers.authorization;
            if (mode === 'model401') {
              res.writeHead(401, { 'Content-Type': 'application/json' });
              res.end(
                '{"type":"error","error":{"type":"authentication_error","message":"Invalid API key (fixture)"}}',
              );
              return;
            }
            const previousResults = request.messages?.some(
              (m: { role: string; content?: unknown }) =>
                m.role === 'tool' ||
                (Array.isArray(m.content) &&
                  m.content.some((p) => p.type === 'tool_result')),
            );
            const names: string[] = (request.tools ?? [])
              .map(
                (t: { name?: string; function?: { name: string } }) =>
                  t.name ?? t.function?.name,
              )
              .filter(
                (name: string) =>
                  name?.endsWith('fast') || name?.endsWith('slow'),
              );
            const call =
              ['parallel', 'tool401'].includes(mode) &&
              !previousResults &&
              names.length > 0;
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            if (harness === 'claude-code') {
              const emit = (type: string, data: object) =>
                res.write(
                  `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`,
                );
              emit('message_start', {
                message: {
                  id: `msg_${modelRequests}`,
                  type: 'message',
                  role: 'assistant',
                  content: [],
                  model: request.model,
                  stop_reason: null,
                  stop_sequence: null,
                  usage: { input_tokens: 10, output_tokens: 0 },
                },
              });
              if (call)
                for (const [index, name] of names.entries()) {
                  emit('content_block_start', {
                    index,
                    content_block: {
                      type: 'tool_use',
                      id: `tool_${index}`,
                      name,
                      input: {},
                    },
                  });
                  emit('content_block_delta', {
                    index,
                    delta: { type: 'input_json_delta', partial_json: '{}' },
                  });
                  emit('content_block_stop', { index });
                }
              else {
                emit('content_block_start', {
                  index: 0,
                  content_block: { type: 'text', text: '' },
                });
                emit('content_block_delta', {
                  index: 0,
                  delta: {
                    type: 'text_delta',
                    text: '<result>fixture response</result>',
                  },
                });
                emit('content_block_stop', { index: 0 });
              }
              emit('message_delta', {
                delta: {
                  stop_reason: call ? 'tool_use' : 'end_turn',
                  stop_sequence: null,
                },
                usage: { output_tokens: 10 },
              });
              emit('message_stop', {});
              res.end();
            } else {
              const base = {
                id: 'fixture',
                object: 'chat.completion.chunk',
                created: 1,
                model: 'local',
              };
              const delta = call
                ? {
                    role: 'assistant',
                    tool_calls: names.map((name, index) => ({
                      index,
                      id: `tool_${index}`,
                      type: 'function',
                      function: { name, arguments: '{}' },
                    })),
                  }
                : {
                    role: 'assistant',
                    content: '<result>fixture response</result>',
                  };
              res.write(
                `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
              );
              res.write(
                `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\n`,
              );
              res.end('data: [DONE]\n\n');
            }
          });
          await new Promise<void>((resolve) =>
            server.listen(0, '127.0.0.1', resolve),
          );
          const address = server.address();
          if (!address || typeof address === 'string')
            throw new Error('No fixture port');
          const url = `http://127.0.0.1:${address.port}`;
          try {
            await mkdir(join(root, '.git'));
            const hostConfig = join(root, 'host-claude');
            await mkdir(hostConfig);
            const hostCredentials = JSON.stringify({
              claudeAiOauth: {
                accessToken: 'fixture-host-token',
                refreshToken: 'fixture-refresh',
                expiresAt: Date.now() + 3600_000,
                scopes: ['user:inference', 'user:profile'],
                subscriptionType: 'max',
                rateLimitTier: 'default',
              },
            });
            if (mode === 'host-auth')
              await writeFile(
                join(hostConfig, '.credentials.json'),
                hostCredentials,
                { mode: 0o600 },
              );
            await writeFile(
              join(root, 'opencode.json'),
              JSON.stringify({
                model: 'fixture/local',
                small_model: 'fixture/local',
                provider: {
                  fixture: {
                    npm: '@ai-sdk/openai-compatible',
                    options: { baseURL: `${url}/v1`, apiKey: 'placeholder' },
                    models: { local: {} },
                  },
                },
              }),
            );
            const input: HarnessInvocation = {
              cwd: root,
              command: harness === 'opencode' ? 'opencode' : 'claude',
              prompt: 'Use the fixture tools, then return the result.',
              model:
                harness === 'opencode' ? 'fixture/local' : 'claude-sonnet-4-6',
              capabilities: [],
              sessionStorage: 'rocky',
              transcriptPath: join(root, 'sessions', 'step.jsonl'),
              timeoutMs: 45_000,
              mcpServers:
                mode === 'model401'
                  ? []
                  : [
                      {
                        name: 'api',
                        config: {
                          type: 'http',
                          url: `${url}/mcp`,
                          headers: { Authorization: 'Bearer fixture-token' },
                        },
                      },
                    ],
              env: {
                PATH: process.env.PATH,
                HOME: root,
                CLAUDE_CONFIG_DIR: hostConfig,
                XDG_CONFIG_HOME: join(root, 'config'),
                XDG_DATA_HOME: join(root, 'data'),
                XDG_CACHE_HOME: join(root, 'cache'),
                XDG_STATE_HOME: join(root, 'state'),
                OPENCODE_AUTH_CONTENT: '{}',
                OPENCODE_DISABLE_MODELS_FETCH: 'true',
                ...(mode === 'host-auth'
                  ? {}
                  : { ANTHROPIC_API_KEY: 'placeholder' }),
                ANTHROPIC_BASE_URL: url,
              },
              signal: abort.signal,
              onEvent(event, id) {
                sessionId = id;
                if (event.kind === 'turn-boundary') {
                  boundaries.push(slowFinished);
                  if (mode === 'parallel') abort.abort();
                }
              },
            };
            const adapter = getHarnessAdapter(harness);
            if (!adapter) throw new Error('Missing adapter');
            if (mode === 'parallel') {
              await expect(adapter.run(input)).rejects.toMatchObject({
                name: 'AbortError',
              });
              expect(boundaries).toEqual([true]);
              const before = await readFile(input.transcriptPath, 'utf8');
              const resumed = await adapter.resume({
                ...input,
                signal: undefined,
                onEvent: undefined,
                sessionId,
                prompt: 'Continue using the completed tool results.',
              });
              expect(resumed).toMatchObject({
                sessionId,
                text: '<result>fixture response</result>',
              });
              expect(
                (await readFile(input.transcriptPath, 'utf8')).startsWith(
                  before,
                ),
              ).toBe(true);
            } else if (mode === 'host-auth') {
              const result = await adapter.run(input);
              expect(result.text).toBe('<result>fixture response</result>');
              expect(modelAuthorization).toBe('Bearer fixture-host-token');
              expect(
                await readFile(join(hostConfig, '.credentials.json'), 'utf8'),
              ).toBe(hostCredentials);
            } else {
              await expect(adapter.run(input)).rejects.toMatchObject({
                retryable: false,
                fix:
                  mode === 'model401'
                    ? 'opencode auth login'
                    : 'rocky mcp login api',
              });
              if (mode !== 'model401') expect(mcpRequests).toBeGreaterThan(0);
            }
          } finally {
            for (const timer of timers) clearTimeout(timer);
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            if (process.env.ROCKY_KEEP_PROBE === '1')
              console.info('Native fixture evidence:', root);
            else await rm(root, { recursive: true, force: true });
          }
        }, 120_000);
      }
    }
  },
);
