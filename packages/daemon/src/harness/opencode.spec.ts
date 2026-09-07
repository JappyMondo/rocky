import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createScopedOpencodeConfig,
  parseOpencodeStream,
  renderOpencodeMcpServers,
  renderOpencodePermissions,
} from './opencode.js';

const toolCallFixture = readFileSync(
  new URL('./fixtures/opencode-1.17.7-tool-call.jsonl', import.meta.url),
  'utf8',
).split('\n');

describe('parseOpencodeStream', () => {
  it('preserves permanent native model authentication failure with the exact login fix', () => {
    try {
      parseOpencodeStream([
        JSON.stringify({
          type: 'error',
          error: {
            name: 'APIError',
            data: {
              statusCode: 401,
              isRetryable: false,
              message: 'Invalid API key',
              responseBody: 'not for the Journal',
            },
          },
        }),
      ]);
      expect.fail('expected an authentication failure');
    } catch (error) {
      expect(error).toMatchObject({
        retryable: false,
        fix: 'opencode auth login',
        message: expect.stringContaining('Invalid API key'),
      });
      expect((error as Error).message).not.toContain('not for the Journal');
    }
  });
  it('turns a named native MCP initialization rejection into its MCP login fix', () => {
    expect(() =>
      parseOpencodeStream(
        [
          JSON.stringify({
            type: 'error',
            error: {
              name: 'MCPError',
              data: {
                statusCode: 401,
                server: 'api',
                message: 'MCP authentication failed',
              },
            },
          }),
        ],
        [{ name: 'api', config: {} }],
      ),
    ).toThrow(/rocky mcp login api/);
  });
  it('pins a newly recorded live tool boundary and same-session continuation', () => {
    const lines = readFileSync(
      new URL('./fixtures/opencode-1.18.29-live.jsonl', import.meta.url),
      'utf8',
    ).split('\n');
    const first = parseOpencodeStream(lines.slice(0, 6));
    const resumed = parseOpencodeStream(lines.slice(6));
    expect(first.events).toEqual([
      { kind: 'tool-call', name: 'read' },
      { kind: 'tool-result', name: 'read' },
      { kind: 'turn-boundary' },
      { kind: 'text', text: 'cranberry' },
    ]);
    expect(first.usage).toEqual({
      inputTokens: 5907,
      outputTokens: 86,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      usd: 0,
    });
    expect(resumed.sessionId).toBe(first.sessionId);
    expect(resumed.text).toBe('cranberry');
  });
  it.each([
    ['null', /JSONL/],
    ['[]', /JSONL/],
    ['{}', /JSONL/],
    ['{"type":"tool_use"}', /tool_use/],
    ['{"type":"tool_use","part":{"type":"other"}}', /tool_use/],
    [
      '{"type":"tool_use","part":{"type":"tool","tool":"read","state":{"status":"running"}}}',
      /tool_use/,
    ],
    ['{"type":"step_finish","part":{}}', /step_finish/],
    ['{"type":"text","part":[]}', /text/],
    ['{"type":"text","part":{}}', /text/],
    [
      '{"type":"step_finish","part":{"type":"step-finish","reason":"stop","tokens":[]}}',
      /usage/,
    ],
  ])('rejects malformed record %s', (line, message) => {
    expect(() => parseOpencodeStream([line])).toThrow(message);
  });

  it('handles tool errors and reasoning without claiming a successful tool', () => {
    const parsed = parseOpencodeStream([
      '{"type":"reasoning","sessionID":"one"}',
      '{"type":"tool_use","part":{"type":"tool","tool":"read","state":{"status":"error"}}}',
    ]);
    expect(parsed.events).toEqual([
      { kind: 'tool-call', name: 'read' },
      { kind: 'tool-result', name: 'read' },
    ]);
    expect(() =>
      parseOpencodeStream([
        '{"type":"step_start","sessionID":"one"}',
        '{"type":"step_start","sessionID":"two"}',
      ]),
    ).toThrow(/changed session/);
  });
  it('parses the OpenCode 1.17.7 tool-call stream', () => {
    expect(parseOpencodeStream(toolCallFixture)).toEqual({
      sessionId: 'ses_opencode_1_17_7',
      text: 'pong',
      events: [
        { kind: 'tool-call', name: 'bash' },
        { kind: 'tool-result', name: 'bash' },
        { kind: 'turn-boundary' },
        { kind: 'text', text: 'pong' },
      ],
      usage: {
        inputTokens: 200,
        outputTokens: 60,
        cacheReadTokens: 35,
        cacheCreationTokens: 12,
        usd: 0.0042,
      },
    });
  });

  it('aggregates native cost from every finished step', () => {
    const result = parseOpencodeStream([
      '{"type":"step_start","sessionID":"ses_1"}',
      '{"type":"step_finish","part":{"type":"step-finish","reason":"tool-calls","cost":0.001}}',
      '{"type":"step_finish","part":{"type":"step-finish","reason":"stop","cost":0.0042}}',
    ]);

    expect(result.usage).toEqual({ usd: 0.0052 });
  });

  it('concatenates text parts in event order', () => {
    const result = parseOpencodeStream([
      '{"type":"step_start","sessionID":"ses_1"}',
      '{"type":"text","part":{"type":"text","text":"ping"}}',
      '{"type":"text","part":{"type":"text","text":" pong"}}',
    ]);

    expect(result.text).toBe('ping pong');
    expect(result.events).toEqual([
      { kind: 'text', text: 'ping' },
      { kind: 'text', text: ' pong' },
    ]);
  });

  it('omits usage when finished steps contain no token or cost fields', () => {
    const result = parseOpencodeStream([
      '{"type":"step_start","sessionID":"ses_1"}',
      '{"type":"step_finish","part":{"type":"step-finish","reason":"stop"}}',
    ]);

    expect(result.usage).toBeUndefined();
  });

  it('retains an empty usage object when tokens are supplied', () => {
    const result = parseOpencodeStream([
      '{"type":"step_start","sessionID":"ses_1"}',
      '{"type":"step_finish","part":{"type":"step-finish","reason":"stop","tokens":{}}}',
    ]);

    expect(result.usage).toEqual({});
  });

  it('accepts trailing blank records', () => {
    expect(
      parseOpencodeStream([
        '{"type":"step_start","sessionID":"ses_1"}',
        '{"type":"step_finish","part":{"type":"step-finish","reason":"stop"}}',
        '',
        '',
      ]),
    ).toMatchObject({ sessionId: 'ses_1' });
  });

  it('rejects blank records between JSON events', () => {
    expect(() =>
      parseOpencodeStream([
        '{"type":"step_start","sessionID":"ses_1"}',
        '',
        '{"type":"step_finish","part":{"type":"step-finish","reason":"stop"}}',
      ]),
    ).toThrow('Invalid OpenCode JSONL');
  });

  it('rejects malformed token values', () => {
    expect(() =>
      parseOpencodeStream([
        '{"type":"step_start","sessionID":"ses_1"}',
        '{"type":"step_finish","part":{"type":"step-finish","reason":"stop","tokens":{"input":-1}}}',
      ]),
    ).toThrow('Invalid OpenCode usage');
  });

  it('rejects non-finite native cost', () => {
    expect(() =>
      parseOpencodeStream([
        '{"type":"step_start","sessionID":"ses_1"}',
        '{"type":"step_finish","part":{"type":"step-finish","reason":"stop","cost":1e999}}',
      ]),
    ).toThrow('Invalid OpenCode usage');
  });

  it('rejects invalid JSON', () => {
    expect(() => parseOpencodeStream(['not json'])).toThrow(
      'Invalid OpenCode JSONL',
    );
  });

  it('rejects unknown events', () => {
    expect(() =>
      parseOpencodeStream(['{"type":"unknown","sessionID":"ses_1"}']),
    ).toThrow('Unknown OpenCode stream event');
  });

  it('rejects streams without a session ID', () => {
    expect(() => parseOpencodeStream(['{"type":"step_start"}'])).toThrow(
      'OpenCode stream did not include a session ID',
    );
  });
});

describe('renderOpencodePermissions', () => {
  it('renders a closed capability mapping', () => {
    expect(renderOpencodePermissions(['read', 'edit', 'bash'])).toEqual({
      '*': 'deny',
      read: 'allow',
      glob: 'allow',
      grep: 'allow',
      edit: 'allow',
      bash: 'allow',
    });
  });

  it('does not grant native tools for omitted capabilities', () => {
    expect(renderOpencodePermissions(['read'])).toEqual({
      '*': 'deny',
      read: 'allow',
      glob: 'allow',
      grep: 'allow',
    });
  });
});

describe('renderOpencodeMcpServers', () => {
  it('keeps ordinary remote headers and disables native OAuth even without a token', () => {
    expect(
      renderOpencodeMcpServers([
        {
          name: 'api',
          config: {
            url: 'https://example.test',
            headers: { Accept: 'application/json' },
          },
        },
      ]),
    ).toEqual({
      api: {
        type: 'remote',
        url: 'https://example.test',
        headers: { Accept: 'application/json' },
        enabled: true,
        oauth: false,
      },
    });
    expect(() =>
      renderOpencodeMcpServers([{ name: 'invalid', config: {} }]),
    ).toThrow(/invalid/);
  });
  it('translates ecosystem local servers to native command/environment without unsupported keys', () => {
    expect(
      renderOpencodeMcpServers([
        {
          name: 'local-tools',
          config: {
            command: 'node',
            args: ['server.mjs'],
            cwd: '/workspace',
            env: { TOKEN: 'test-token' },
          },
        },
      ]),
    ).toEqual({
      'local-tools': {
        type: 'local',
        command: ['node', 'server.mjs'],
        environment: { TOKEN: 'test-token' },
        enabled: true,
      },
    });
  });

  it('renders remote servers with supplied authorization without OAuth', () => {
    expect(
      renderOpencodeMcpServers([
        {
          name: 'remote-tools',
          config: { url: 'https://mcp.example.test' },
          authorization: 'Bearer static-token',
        },
      ]),
    ).toEqual({
      'remote-tools': {
        type: 'remote',
        url: 'https://mcp.example.test',
        enabled: true,
        headers: { Authorization: 'Bearer static-token' },
        oauth: false,
      },
    });
  });
});

describe('createScopedOpencodeConfig', () => {
  it('isolates personal MCP configuration while preserving JSONC global settings', async () => {
    const globalConfigHome = mkdtempSync(
      join(tmpdir(), 'rocky-opencode-global-'),
    );
    const globalConfigPath = join(globalConfigHome, 'opencode');
    const cwd = '/workspace/checkout';

    try {
      mkdirSync(globalConfigPath);
      writeFileSync(
        join(globalConfigPath, 'opencode.jsonc'),
        '{\n  // retain provider configuration\n  "provider": { "anthropic": {} },\n  "permission": { "bash": "allow" },\n  "mcp": { "personal": { "type": "remote" } }\n}',
      );

      const scoped = await createScopedOpencodeConfig({
        cwd,
        capabilities: ['read'],
        mcpServers: [],
        env: {
          XDG_CONFIG_HOME: globalConfigHome,
          OPENCODE_CONFIG_CONTENT: '{"permission":{"bash":"allow"}}',
        },
      });

      try {
        expect(scoped.cwd).toBe(cwd);
        expect(scoped.env.OPENCODE_CONFIG).toBeDefined();
        expect(scoped.env.XDG_CONFIG_HOME).not.toBe(globalConfigHome);
        expect(scoped.env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
        expect(
          JSON.parse(readFileSync(scoped.env.OPENCODE_CONFIG, 'utf8')),
        ).toMatchObject({
          permission: {
            '*': 'deny',
            read: 'allow',
            glob: 'allow',
            grep: 'allow',
          },
          mcp: {},
        });
        expect(
          JSON.parse(
            readFileSync(
              join(scoped.env.XDG_CONFIG_HOME, 'opencode', 'opencode.json'),
              'utf8',
            ),
          ),
        ).toMatchObject({ provider: { anthropic: {} } });
      } finally {
        await scoped.dispose();
      }
    } finally {
      rmSync(globalConfigHome, { recursive: true, force: true });
    }
  });

  it('removes the per-call and scoped global configuration on disposal', async () => {
    const globalConfigHome = mkdtempSync(
      join(tmpdir(), 'rocky-opencode-global-'),
    );
    const scoped = await createScopedOpencodeConfig({
      cwd: '/workspace/checkout',
      capabilities: [],
      mcpServers: [],
      env: { XDG_CONFIG_HOME: globalConfigHome },
    });

    try {
      const configPath = scoped.env.OPENCODE_CONFIG;
      const configHome = scoped.env.XDG_CONFIG_HOME;
      expect(existsSync(configPath)).toBe(true);
      expect(existsSync(configHome)).toBe(true);

      await scoped.dispose();

      expect(existsSync(configPath)).toBe(false);
      expect(existsSync(configHome)).toBe(false);
    } finally {
      await scoped.dispose();
      rmSync(globalConfigHome, { recursive: true, force: true });
    }
  });

  it('rejects invalid JSONC global configuration', async () => {
    const globalConfigHome = mkdtempSync(
      join(tmpdir(), 'rocky-opencode-global-'),
    );
    const opencodeDir = join(globalConfigHome, 'opencode');
    mkdirSync(opencodeDir);
    writeFileSync(join(opencodeDir, 'opencode.json'), '{ invalid');

    try {
      await expect(
        createScopedOpencodeConfig({
          cwd: '/workspace/checkout',
          capabilities: [],
          mcpServers: [],
          env: { XDG_CONFIG_HOME: globalConfigHome },
        }),
      ).rejects.toThrow('Invalid OpenCode global configuration');
    } finally {
      rmSync(globalConfigHome, { recursive: true, force: true });
    }
  });
});
