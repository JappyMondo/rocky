import { createServer } from 'node:http';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { opencode } from './opencode.js';

it.runIf(process.env.ROCKY_OPENCODE_POLICY_TESTS === '1')(
  'reads a captured image outside the workspace through the real CLI with a scoped evidence grant',
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'rocky-evidence-cli-')),
    );
    const cwd = join(root, 'workspace');
    const evidence = join(root, 'screenshots');
    const file = join(evidence, 'report', 'capture.png');
    const server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      const request = JSON.parse(body);
      const call =
        request.tools?.some(
          (tool: { function: { name: string } }) =>
            tool.function.name === 'read',
        ) &&
        !request.messages.some(
          (message: { role: string }) => message.role === 'tool',
        );
      const delta = call
        ? {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'read-capture',
                type: 'function',
                function: {
                  name: 'read',
                  arguments: JSON.stringify({ filePath: file }),
                },
              },
            ],
          }
        : { role: 'assistant', content: 'capture inspected' };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const [part, reason] of [
        [delta, null],
        [{}, call ? 'tool_calls' : 'stop'],
      ])
        res.write(
          `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: part, finish_reason: reason }] })}\n\n`,
        );
      res.end('data: [DONE]\n\n');
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('No server address');
    try {
      await mkdir(join(cwd, '.git'), { recursive: true });
      await mkdir(join(evidence, 'report'), { recursive: true });
      await writeFile(
        file,
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFioAAAAASUVORK5CYII=',
          'base64',
        ),
      );
      await writeFile(
        join(cwd, 'opencode.json'),
        JSON.stringify({
          model: 'fixture/local',
          small_model: 'fixture/local',
          provider: {
            fixture: {
              npm: '@ai-sdk/openai-compatible',
              models: {
                local: {
                  modalities: { input: ['text', 'image'], output: ['text'] },
                },
              },
              options: {
                baseURL: `http://127.0.0.1:${address.port}/v1`,
                apiKey: 'fixture',
              },
            },
          },
        }),
      );
      const transcriptPath = join(root, 'sessions', 'capture.jsonl');
      const result = await opencode.run({
        cwd,
        command: 'opencode',
        prompt: 'Read the capture.',
        model: 'fixture/local',
        capabilities: ['read'],
        evidenceDirectories: [evidence],
        mcpServers: [],
        sessionStorage: 'rocky',
        transcriptPath,
        timeoutMs: 45000,
        env: {
          PATH: process.env.PATH,
          HOME: root,
          XDG_CONFIG_HOME: join(root, 'config'),
          XDG_DATA_HOME: join(root, 'data'),
          XDG_STATE_HOME: join(root, 'state'),
          XDG_CACHE_HOME: join(root, 'cache'),
          OPENCODE_AUTH_CONTENT: '{}',
          OPENCODE_DISABLE_MODELS_FETCH: 'true',
        },
      });
      expect(result.text).toBe('capture inspected');
      const events = (await readFile(transcriptPath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const tool = events.find(
        (event) => event.type === 'tool_use' && event.part.tool === 'read',
      );
      expect(tool?.part.state.status).toBe('completed');
      expect(tool?.part.state.output).toContain('Image read successfully');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      await rm(root, { recursive: true, force: true });
    }
  },
);
