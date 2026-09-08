import { chmod, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { opencode } from './opencode.js';
import { claudeCode } from './claude-code.js';
import { SHIPPED_ADAPTERS } from './adapter.js';
import type { HarnessInvocation } from './types.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it.each(['malformed-config', 'malformed-agent', 'wide-agent'])(
  'fails closed for OpenCode %s probe',
  async (mode) => {
    const input = await invocation();
    await expect(
      opencode.run({ ...input, env: { ...input.env, FIXTURE_MODE: mode } }),
    ).rejects.toMatchObject({ retryable: false });
  },
);

it('preserves the native store override only in opencode storage mode', async () => {
  const input = await invocation();
  const env = { ...input.env, OPENCODE_DB: join(input.cwd, 'ordinary.db') };
  const result = await opencode.run({
    ...input,
    model: undefined,
    env,
    sessionStorage: 'opencode',
  });
  expect(JSON.parse(result.text).db).toBe(env.OPENCODE_DB);
  expect(JSON.parse(result.text).args).not.toContain('--model');
});

it('decodes split UTF-8 and an unterminated final JSONL record', async () => {
  const input = await invocation();
  expect(
    (
      await opencode.run({
        ...input,
        env: { ...input.env, FIXTURE_MODE: 'no-newline' },
      })
    ).text,
  ).toBe('caf\u00e9');
});

it('caps an oversized stream and tears down the child', async () => {
  const input = await invocation();
  await expect(
    opencode.run({ ...input, env: { ...input.env, FIXTURE_MODE: 'large' } }),
  ).rejects.toThrow(/32 MiB/);
});

it('names the requested model on a stderr-only OpenCode model failure', async () => {
  const input = await invocation();
  await expect(
    opencode.run({
      ...input,
      env: { ...input.env, FIXTURE_MODE: 'stderr-only' },
    }),
  ).rejects.toMatchObject({
    retryable: false,
    message: expect.stringMatching(
      /opencode.*custom\/unchanged.*Unknown model/,
    ),
  });
});

it('makes a stderr-only OpenCode account rejection permanent with its login fix', async () => {
  const input = await invocation();
  await expect(
    opencode.run({
      ...input,
      env: { ...input.env, FIXTURE_MODE: 'stderr-auth' },
    }),
  ).rejects.toMatchObject({ retryable: false, fix: 'opencode auth login' });
});

it('makes a source-correlated stderr MCP initialization rejection permanent', async () => {
  const input = await invocation();
  await expect(
    opencode.run({
      ...input,
      env: { ...input.env, FIXTURE_MODE: 'stderr-mcp-auth' },
      mcpServers: [
        {
          name: 'api',
          config: { type: 'http', url: 'https://example.test/mcp' },
        },
      ],
    }),
  ).rejects.toMatchObject({ retryable: false, fix: 'rocky mcp login api' });
});

it('requires the resumed Claude ID and a final result', async () => {
  const input = await invocation();
  const first = await claudeCode.run(input);
  await expect(
    claudeCode.resume({
      ...input,
      sessionId: first.sessionId,
      env: { ...input.env, FIXTURE_MODE: 'wrong-session' },
    }),
  ).rejects.toThrow(/different session/);
  await expect(
    claudeCode.run({
      ...input,
      env: { ...input.env, FIXTURE_MODE: 'missing-result' },
    }),
  ).rejects.toThrow(/final result/);
});

it('renders Claude stdio and SSE MCP declarations without widening built-in tools', async () => {
  const input = await invocation();
  const result = await claudeCode.run({
    ...input,
    model: undefined,
    capabilities: [],
    mcpServers: [
      {
        name: 'local',
        config: {
          type: 'stdio',
          command: 'node',
          args: ['server.mjs'],
          env: { ONLY: 'this' },
        },
      },
      {
        name: 'sse',
        config: {
          url: 'https://example.test',
          type: 'sse',
          headers: { Authorization: 'Bearer new', Other: 'kept' },
        },
      },
      {
        name: 'public',
        config: { type: 'http', url: 'https://public.test' },
      },
    ],
  });
  const value = JSON.parse(result.text);
  expect(value.config.mcpServers.local).toEqual({
    type: 'stdio',
    command: 'node',
    args: ['server.mjs'],
    env: { ONLY: 'this' },
  });
  expect(value.config.mcpServers.sse).toMatchObject({
    type: 'sse',
    headers: { Authorization: 'Bearer new', Other: 'kept' },
  });
});

for (const adapter of [opencode, claudeCode]) {
  it('rejects invalid MCP names before spawning', async () => {
    const input = await invocation();
    await expect(
      adapter.run({
        ...input,
        mcpServers: [
          {
            name: 'invalid!',
            config: { type: 'http', url: 'https://api.test' },
          },
        ],
      }),
    ).rejects.toThrow(/Invalid MCP name/);
  });
}

it('spawns Claude with a closed built-in tool set and strict ephemeral MCP config', async () => {
  const input = await invocation();
  input.mcpServers = [
    {
      name: 'api',
      config: {
        type: 'http',
        url: 'https://example.test/mcp',
        headers: {
          Authorization: 'Bearer fixture-token',
          Other: 'preserved',
        },
      },
    },
  ];
  const result = await claudeCode.run(input);
  const info = JSON.parse(result.text);
  expect(info.args).toContain('--strict-mcp-config');
  expect(info.args[info.args.indexOf('--tools') + 1]).toBe('Read,Glob,Grep');
  expect(info.args).not.toContain('--dangerously-skip-permissions');
  expect(info.config.mcpServers.api.headers).toEqual({
    Other: 'preserved',
    Authorization: 'Bearer fixture-token',
  });
  expect(info.native).toContain('/sessions/');
  await expect(stat(info.configPath)).rejects.toMatchObject({ code: 'ENOENT' });
  const before = await readFile(input.transcriptPath, 'utf8');
  const next = await claudeCode.resume({
    ...input,
    sessionId: result.sessionId,
    prompt: 'steer',
  });
  expect(JSON.parse(next.text).args).toContain('--resume');
  expect(JSON.parse(next.text).args).not.toContain('--fork-session');
  expect(
    (await readFile(input.transcriptPath, 'utf8')).startsWith(before),
  ).toBe(true);
});

async function invocation(): Promise<HarnessInvocation> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rocky-harness-')));
  roots.push(root);
  const command = fileURLToPath(
    new URL('./fixtures/harness-cli.mjs', import.meta.url),
  );
  await chmod(command, 0o700);
  return {
    cwd: root,
    prompt: 'hello',
    model: 'custom/unchanged',
    command,
    capabilities: ['read'],
    mcpServers: [],
    sessionStorage: 'rocky',
    env: { PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: root },
    transcriptPath: join(root, 'sessions', 'step-1.jsonl'),
  };
}

it('spawns OpenCode headlessly and persists a private raw Transcript', async () => {
  const input = await invocation();
  const result = await opencode.run(input);
  expect(result.sessionId).toBe('ses_fixture');
  expect(JSON.parse(result.text)).toMatchObject({
    args: [
      'run',
      '--format',
      'json',
      '--agent',
      'rocky',
      '--model',
      'custom/unchanged',
      '--',
      'hello',
    ],
    cwd: input.cwd,
  });
  expect(await readFile(input.transcriptPath, 'utf8')).toContain(
    '"type":"text"',
  );
  expect((await stat(input.transcriptPath)).mode & 0o777).toBe(0o600);
});

it('resumes only the session owned by this Step, appending the Transcript', async () => {
  const input = await invocation();
  const first = await opencode.run(input);
  const before = await readFile(input.transcriptPath, 'utf8');
  const resumed = await opencode.resume({
    ...input,
    prompt: 'steer',
    sessionId: first.sessionId,
  });
  expect(JSON.parse(resumed.text).args).toContain('--session');
  expect(JSON.parse(resumed.text).args).not.toContain('--fork');
  expect(await readFile(input.transcriptPath, 'utf8')).toMatch(before);
  await expect(
    opencode.resume({
      ...input,
      transcriptPath: join(input.cwd, 'other.jsonl'),
      sessionId: first.sessionId,
    }),
  ).rejects.toThrow(/does not belong to this Step/);
});

for (const adapter of Object.values(SHIPPED_ADAPTERS)) {
  it(`${adapter.name}: emits live turn boundaries and cancels only its child process group`, async () => {
    const input = await invocation();
    const abort = new AbortController();
    let pid = 0;
    const events: string[] = [];
    await expect(
      adapter.run({
        ...input,
        env: { ...input.env, FIXTURE_MODE: 'hang' },
        signal: abort.signal,
        onEvent(event, sessionId) {
          expect(sessionId).not.toBe('');
          events.push(event.kind);
          if (event.kind === 'text') pid = JSON.parse(event.text).pid;
          if (event.kind === 'turn-boundary') abort.abort();
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(events.slice(-3)).toEqual([
      'tool-call',
      'tool-result',
      'turn-boundary',
    ]);
    expect(await readFile(input.transcriptPath, 'utf8')).toContain('tool');
    expect(pid).toBeGreaterThan(0);
    await expect
      .poll(() => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      })
      .toBe(true);
  });
  it(`${adapter.name}: times out a stuck child and preserves its Transcript`, async () => {
    const input = await invocation();
    await expect(
      adapter.run({
        ...input,
        env: { ...input.env, FIXTURE_MODE: 'hang' },
        timeoutMs: 500,
      }),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(await readFile(input.transcriptPath, 'utf8')).toContain('tool');
  });
  it(`${adapter.name}: a nonzero exit does not erase a valid result or invent usage`, async () => {
    const input = await invocation();
    const result = await adapter.run({
      ...input,
      env: { ...input.env, FIXTURE_MODE: 'nonzero' },
    });
    expect(result.text).not.toBe('');
    expect(result.usage).toBeUndefined();
  });
  it(`${adapter.name}: a new Step starts a fresh conversation, never implicit continue`, async () => {
    const input = await invocation();
    await adapter.run(input);
    const next = await adapter.run({
      ...input,
      transcriptPath: join(input.cwd, 'sessions', 'step-2.jsonl'),
    });
    const args: string[] = JSON.parse(next.text).args;
    expect(args).not.toContain('--resume');
    expect(args).not.toContain('--session');
    expect(args).not.toContain('--continue');
    await expect(
      adapter.resume({
        ...input,
        transcriptPath: join(input.cwd, 'other.jsonl'),
        sessionId: next.sessionId,
      }),
    ).rejects.toThrow(/does not belong to this Step/);
  });
  it(`${adapter.name}: rejects pre-cancelled invocations without launching a child`, async () => {
    const input = await invocation();
    await expect(
      adapter.run({ ...input, signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await expect(stat(input.transcriptPath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
}

it('refuses effective policy widening before launching the OpenCode conversation', async () => {
  const input = await invocation();
  await expect(
    opencode.run({
      ...input,
      env: { ...input.env, FIXTURE_MODE: 'wide-policy' },
    }),
  ).rejects.toMatchObject({
    retryable: false,
    message: expect.stringContaining('Step policy'),
  });
  await expect(stat(input.transcriptPath)).rejects.toMatchObject({
    code: 'ENOENT',
  });
});
it('classifies model rejection without trusting a zero exit', async () => {
  const input = await invocation();
  await expect(
    opencode.run({
      ...input,
      model: 'custom/not-a-model',
      env: { ...input.env, FIXTURE_MODE: 'model-error' },
    }),
  ).rejects.toMatchObject({
    retryable: false,
    message: expect.stringMatching(/opencode.*custom\/not-a-model/),
  });
});
it('reports the Claude organization restriction with a named fix, never successful text', async () => {
  const input = await invocation();
  await expect(
    claudeCode.run({
      ...input,
      env: { ...input.env, FIXTURE_MODE: 'auth-error' },
    }),
  ).rejects.toMatchObject({
    retryable: false,
    message: expect.stringContaining('oauth_org_not_allowed'),
    fix: expect.stringContaining('claude login'),
  });
});
