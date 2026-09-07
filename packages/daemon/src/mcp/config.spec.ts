import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  expandMcpConfig,
  parseMcpConfig,
  readMcpConfig,
  selectMcpServers,
} from './index.js';

describe('MCP declarations', () => {
  it('expands Run values before selecting only the Agent call grants', () => {
    const raw = {
      mcpServers: {
        playwright: {
          command: 'npx',
          args: ['@playwright/mcp', '--output-dir', '${ROCKY_SCREENSHOT_DIR}'],
          env: { PORT: '${ROCKY_PORT}', MODE: '${MODE:-headless}' },
        },
        remote: { type: 'sse', url: 'https://example.com/mcp' },
      },
    };
    const config = expandMcpConfig(parseMcpConfig(raw), {
      env: { ROCKY_PORT: '9999' },
      run: { runDir: '/run', screenshotDir: '/run/screenshots', port: 3000 },
    });

    expect(selectMcpServers(config, ['playwright'])).toEqual([
      {
        name: 'playwright',
        config: {
          type: 'stdio',
          command: 'npx',
          args: ['@playwright/mcp', '--output-dir', '/run/screenshots'],
          env: { PORT: '3000', MODE: 'headless' },
        },
      },
    ]);
    expect(selectMcpServers(config, [])).toEqual([]);
    expect(raw.mcpServers.playwright.args[2]).toBe('${ROCKY_SCREENSHOT_DIR}');
  });

  it('reads only JSON, with a missing file meaning no servers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rocky-mcp-config-'));
    const file = join(dir, 'mcp.json');
    try {
      expect(selectMcpServers(await readMcpConfig(file), [])).toEqual([]);
      await writeFile(
        file,
        '{"mcpServers":{"api":{"url":"https://example.com"}}}',
      );
      expect(
        selectMcpServers(await readMcpConfig(file), ['api'])[0].config,
      ).toEqual({ type: 'http', url: 'https://example.com' });
      await writeFile(file, 'secret-literal not JSON');
      await expect(readMcpConfig(file)).rejects.toThrow(/mcp.json.*valid JSON/);
      await expect(readMcpConfig(file)).rejects.not.toThrow('secret-literal');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each([
    { tools: ['bash'], mcpServers: {} },
    { mcpServers: { api: { url: 'https://example.com', oauth: {} } } },
    { mcpServers: { api: { url: 'https://example.com', command: 'sh' } } },
    { mcpServers: { api: { type: 'remote', url: 'https://example.com' } } },
    { mcpServers: { api: { command: 'sh', env: { A: 4 } } } },
    JSON.parse('{"mcpServers":{"__proto__":{"command":"sh"}}}'),
  ])(
    'rejects ambiguous declarations and policy extensions without echoing values',
    (raw) => {
      expect(() => parseMcpConfig(raw)).toThrow(/mcp.json/);
    },
  );

  it('names an unknown Step grant and every known server, including prototype names', () => {
    const config = parseMcpConfig({
      mcpServers: { a: { command: 'true' }, b: { command: 'true' } },
    });
    expect(() => selectMcpServers(config, ['a', 'toString'])).toThrow(
      /mcp.json.*toString.*a, b/,
    );
    expect(selectMcpServers(config, ['a', 'a'])).toHaveLength(1);
  });

  it('expands once, including defaults for empty values, and does not echo secret strings in errors', () => {
    const config = parseMcpConfig({
      mcpServers: {
        api: {
          url: '${URL}',
          headers: {
            Authorization: 'secret ${MISSING}',
            'X-Mode': '${EMPTY:-default}',
          },
        },
      },
    });
    const options = { env: { URL: 'https://example.com', EMPTY: '' } };
    expect(() => expandMcpConfig(config, options)).toThrow(/MISSING/);
    expect(() => expandMcpConfig(config, options)).not.toThrow('secret');
    const result = expandMcpConfig(config, {
      env: { ...options.env, MISSING: '${NOT_RECURSIVE}' },
    });
    expect(result.mcpServers.api).toMatchObject({
      headers: {
        Authorization: 'secret ${NOT_RECURSIVE}',
        'X-Mode': 'default',
      },
    });
  });

  it.each([
    { url: 'file:///etc/passwd' },
    { url: 'https://user:password@example.com' },
    { url: 'https://example.com/#fragment' },
    { url: 'not a url' },
    {
      url: 'https://example.com',
      headers: { Authorization: 'secret\r\nX-Bad: true' },
    },
    {
      url: 'https://example.com',
      headers: { Authorization: 'one', authorization: 'two' },
    },
  ])(
    'rejects invalid expanded URLs and ambiguous or unsafe headers',
    (server) => {
      expect(() =>
        expandMcpConfig(parseMcpConfig({ mcpServers: { api: server } }), {
          env: {},
        }),
      ).toThrow(/mcp.json.*api/);
    },
  );

  it('names unreadable files and commands that become empty after expansion', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rocky-mcp-unreadable-'));
    try {
      await expect(readMcpConfig(dir)).rejects.toThrow(
        /cannot read MCP declarations/,
      );
      const config = parseMcpConfig({
        mcpServers: { local: { command: '${COMMAND}' } },
      });
      expect(() => expandMcpConfig(config, { env: { COMMAND: '' } })).toThrow(
        /mcp.json.*local.*command/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not treat object-prototype members as environment values', () => {
    const config = parseMcpConfig({
      mcpServers: { local: { command: '${toString}' } },
    });
    expect(() => expandMcpConfig(config, { env: {} })).toThrow(
      /environment variable toString/,
    );
  });
});
