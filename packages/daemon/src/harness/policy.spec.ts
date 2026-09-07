import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createScopedOpencodeConfig } from './opencode.js';
import { runProcess } from './process.js';
import { getHarnessAdapter } from './adapter.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});

it('merges compatible explicit/global config and anchors native file substitutions without executing customizations', async () => {
  const input = await setup();
  const custom = join(input.cwd, 'custom.jsonc');
  await writeFile(
    custom,
    '{"provider":{"extra":{"options":{"apiKey":"{file:key.txt}"}}},"instructions":["first"],"plugin":["do-not-run"]}',
  );
  const directory = join(input.cwd, 'custom-dir');
  await mkdir(directory);
  await writeFile(
    join(directory, 'opencode.json'),
    '{"provider":{"extra":{"options":{"baseURL":"https://extra.test"}}}}',
  );
  const scoped = await createScopedOpencodeConfig({
    ...input,
    capabilities: [],
    mcpServers: [
      {
        name: 'api',
        config: {
          type: 'http',
          url: 'https://example.test',
          headers: { Authorization: 'Bearer new', Other: 'kept' },
        },
      },
    ],
    env: {
      ...input.env,
      OPENCODE_CONFIG: custom,
      OPENCODE_CONFIG_DIR: directory,
      OPENCODE_CONFIG_CONTENT:
        '{"small_model":"private/small","permission":{"*":"allow"}}',
    },
  });
  try {
    const config = JSON.parse(
      await readFile(scoped.env.OPENCODE_CONFIG, 'utf8'),
    );
    expect(config.provider.extra.options).toEqual({
      apiKey: `{file:${join(input.cwd, 'key.txt')}}`,
      baseURL: 'https://extra.test',
    });
    expect(config.small_model).toBe('private/small');
    expect(config.permission).toEqual({ '*': 'deny', 'api_*': 'allow' });
    expect(config.mcp.api.headers).toEqual({
      Other: 'kept',
      Authorization: 'Bearer new',
    });
  } finally {
    await scoped.dispose();
  }
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'rocky-policy-'));
  roots.push(root);
  const cwd = join(root, 'repo');
  await mkdir(join(cwd, '.git'), { recursive: true });
  await mkdir(join(cwd, '.opencode', 'tools'), { recursive: true });
  const source = JSON.stringify({
    provider: {
      private: {
        npm: '@ai-sdk/openai-compatible',
        options: { baseURL: 'https://example.test/v1' },
        models: { local: {} },
      },
    },
    tools: { bash: true, custom: true },
    permission: { '*': 'allow', bash: 'allow' },
    agent: { rocky: { permission: { '*': 'allow' } } },
    mcp: { personal: { type: 'local', command: ['never-launch-this'] } },
    plugin: ['./never-load-this.mjs'],
  });
  await writeFile(join(cwd, 'opencode.json'), source);
  await writeFile(
    join(cwd, '.opencode', 'opencode.jsonc'),
    '{ "model": "private/local" }',
  );
  await writeFile(
    join(cwd, '.opencode', 'tools', 'custom.ts'),
    'throw new Error("must not load")',
  );
  return {
    cwd,
    source,
    env: {
      PATH: process.env.PATH,
      HOME: root,
      XDG_CONFIG_HOME: join(root, 'global'),
      XDG_DATA_HOME: join(root, 'data'),
      XDG_CACHE_HOME: join(root, 'cache'),
      XDG_STATE_HOME: join(root, 'state'),
      OPENCODE_AUTH_CONTENT: '{}',
    },
  };
}

it.runIf(process.env.ROCKY_OPENCODE_POLICY_TESTS === '1')(
  'recognizes the real CLI environment-auth status without reading a credential store',
  async () => {
    const input = await setup();
    const adapter = getHarnessAdapter('opencode');
    expect(
      await adapter?.checkAuth(
        {},
        { env: { ...input.env, OPENAI_API_KEY: 'fixture-not-a-credential' } },
      ),
    ).toMatchObject({
      ok: true,
      detail: expect.stringContaining('environment'),
    });
  },
);

it('supports checkout provider/model configuration without widening Step grants or changing files', async () => {
  const input = await setup();
  const scoped = await createScopedOpencodeConfig({
    ...input,
    capabilities: ['read'],
    mcpServers: [],
  });
  try {
    const config = JSON.parse(
      await readFile(scoped.env.OPENCODE_CONFIG, 'utf8'),
    );
    expect(config.provider.private.options.baseURL).toBe(
      'https://example.test/v1',
    );
    expect(config.model).toBe('private/local');
    expect(config.permission).toEqual({
      '*': 'deny',
      read: 'allow',
      glob: 'allow',
      grep: 'allow',
    });
    expect(config.mcp).toEqual({});
    expect(config.plugin).toBeUndefined();
    expect(scoped.env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('true');
    expect(await readFile(join(input.cwd, 'opencode.json'), 'utf8')).toBe(
      input.source,
    );
  } finally {
    await scoped.dispose();
  }
});

it.runIf(process.env.ROCKY_OPENCODE_POLICY_TESTS === '1')(
  'checks the real OpenCode effective merged configuration without a model call',
  async () => {
    const input = await setup();
    const scoped = await createScopedOpencodeConfig({
      ...input,
      capabilities: ['read'],
      mcpServers: [],
    });
    try {
      const result = await runProcess({
        command: 'opencode',
        args: ['debug', 'config'],
        cwd: input.cwd,
        env: scoped.env,
        timeoutMs: 30_000,
      });
      expect(result.code, result.stderr).toBe(0);
      const effective = JSON.parse(result.stdout);
      expect(effective.permission).toEqual({
        '*': 'deny',
        read: 'allow',
        glob: 'allow',
        grep: 'allow',
      });
      expect(effective.mcp).toEqual({});
      expect(effective.plugin).toEqual([]);
      expect(effective.model).toBe('private/local');
      expect(effective.provider.private.options.baseURL).toBe(
        'https://example.test/v1',
      );
      expect(await readFile(join(input.cwd, 'opencode.json'), 'utf8')).toBe(
        input.source,
      );
    } finally {
      await scoped.dispose();
    }
  },
);
