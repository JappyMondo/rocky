import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { codex, parseCodexStream } from './codex.js';
import { getHarnessAdapter } from './adapter.js';
import type { HarnessInvocation } from './types.js';

const sessionId = '0199a213-81c0-7800-8aa1-bbab2a035a53';
const start = { type: 'thread.started', thread_id: sessionId };
const message = {
  type: 'item.completed',
  item: {
    id: 'answer',
    type: 'agent_message',
    text: '<result>{"ok":true}</result>',
  },
};
const end = {
  type: 'turn.completed',
  usage: { input_tokens: 20, cached_input_tokens: 10, output_tokens: 3 },
};
const parse = (...records: unknown[]) =>
  parseCodexStream(records.map((record) => JSON.stringify(record)));
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it('extracts final text and native usage without inventing costs', () => {
  const result = parse(start, { type: 'turn.started' }, message, end);
  expect(result).toMatchObject({
    sessionId,
    text: message.item.text,
    usage: { inputTokens: 20, cacheReadTokens: 10, outputTokens: 3 },
  });
  expect(result.usage).not.toHaveProperty('usd');
  expect(parse(start, message, { type: 'turn.completed' })).not.toHaveProperty(
    'usage',
  );
});

it('tracks interleaved tool calls once and emits a boundary after all have settled', () => {
  const command = {
    id: 'shell',
    type: 'command_execution',
    command: 'ls',
    status: 'in_progress',
  };
  const mcp = {
    id: 'mcp',
    type: 'mcp_tool_call',
    server: 'api',
    tool: 'read',
    status: 'in_progress',
  };
  const result = parse(
    start,
    { type: 'item.started', item: command },
    { type: 'item.updated', item: command },
    { type: 'item.started', item: mcp },
    {
      type: 'item.completed',
      item: { ...command, status: 'completed', exit_code: 0 },
    },
    { type: 'item.completed', item: { ...mcp, status: 'completed' } },
    { type: 'item.completed', item: { ...mcp, status: 'completed' } },
    message,
    end,
  );
  expect(result.events).toEqual([
    { kind: 'tool-call', name: 'bash' },
    { kind: 'tool-call', name: 'mcp__api__read' },
    { kind: 'tool-result', name: 'bash' },
    { kind: 'tool-result', name: 'mcp__api__read' },
    { kind: 'turn-boundary' },
    { kind: 'text', text: message.item.text },
    { kind: 'turn-boundary' },
  ]);
});

it('accepts completed-only file changes and ignores reasoning and transient reconnect notices', () => {
  expect(
    parse(
      start,
      { type: 'error', message: 'Reconnecting 1/5' },
      {
        type: 'item.completed',
        item: { id: 'thinking', type: 'reasoning', text: 'thinking' },
      },
      {
        type: 'item.completed',
        item: {
          id: 'patch',
          type: 'file_change',
          changes: [],
          status: 'completed',
        },
      },
      message,
      end,
    ).events,
  ).toContainEqual({ kind: 'tool-result', name: 'apply_patch' });
});

it.each([
  [[], /no final result/],
  [[start, message], /no final result/],
  [[start, end], /no final result/],
  [
    [start, { type: 'thread.started', thread_id: 'different' }],
    /changed session/,
  ],
  [[null], /Invalid Codex/],
  [[{ type: 'new.event' }], /Unknown Codex/],
  [
    [start, { type: 'item.completed', item: { id: 'x', type: 'unsupported' } }],
    /Unknown Codex item/,
  ],
  [
    [
      start,
      { type: 'item.started', item: { id: 'x', type: 'command_execution' } },
      message,
      end,
    ],
    /unfinished tools/,
  ],
  [
    [start, message, { ...end, usage: { input_tokens: -1 } }],
    /Invalid Codex usage/,
  ],
  [[start, message, { ...end, usage: [] }], /Invalid Codex usage/],
] as const)(
  'rejects incomplete or malformed streams (%#)',
  (records, error) => {
    expect(() => parse(...records)).toThrow(error);
  },
);

it.each(['401 Unauthorized', 'model is not supported', 'Unknown model'])(
  'does not retry recognized native failures: %s',
  (error) => {
    expect(() =>
      parse(start, { type: 'turn.failed', error: { message: error } }),
    ).toThrow(expect.objectContaining({ retryable: false }));
  },
);

it('distinguishes MCP reauthentication and tool denials from recoverable command errors', () => {
  const item = {
    id: 'mcp',
    type: 'mcp_tool_call',
    server: 'api',
    tool: 'read',
    status: 'failed',
    error: { message: '401 Unauthorized' },
  };
  expect(() =>
    parseCodexStream(
      [start, { type: 'item.completed', item }].map((record) =>
        JSON.stringify(record),
      ),
      [{ name: 'api', config: { type: 'http', url: 'https://example.test' } }],
    ),
  ).toThrow(
    expect.objectContaining({ retryable: false, fix: 'rocky mcp login api' }),
  );
  expect(() =>
    parse(start, {
      type: 'item.completed',
      item: {
        id: 'x',
        type: 'command_execution',
        exit_code: 1,
        aggregated_output: 'permission denied',
      },
    }),
  ).toThrow(expect.objectContaining({ retryable: false }));
  expect(
    parse(
      start,
      {
        type: 'item.completed',
        item: {
          id: 'x',
          type: 'command_execution',
          exit_code: 1,
          aggregated_output: 'No such file or directory',
        },
      },
      message,
      end,
    ).text,
  ).toBe(message.item.text);
});

async function invocation(): Promise<HarnessInvocation> {
  const root = await mkdtemp(join(tmpdir(), 'rocky-codex-test-'));
  roots.push(root);
  const command = fileURLToPath(
    new URL('./fixtures/codex-cli.mjs', import.meta.url),
  );
  await chmod(command, 0o700);
  return {
    command,
    cwd: root,
    env: { PATH: process.env.PATH, HOME: root },
    prompt: '--a prompt with flags',
    model: 'model-verbatim',
    effort: 'high',
    sessionStorage: 'codex',
    capabilities: [],
    mcpServers: [],
    transcriptPath: join(root, 'sessions', 'step.jsonl'),
  };
}

it('runs and resumes only its own transcript and preserves model, effort and prompt arguments', async () => {
  const input = await invocation();
  const first = await codex.run(input);
  const args = JSON.parse(first.text).args as string[];
  expect(args.slice(-2)).toEqual(['--', input.prompt]);
  expect(args).toContain('model_reasoning_effort="high"');
  expect(args).toContain('model-verbatim');
  expect(args).toContain('--ignore-user-config');
  expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  const before = await readFile(input.transcriptPath, 'utf8');
  expect((await stat(input.transcriptPath)).mode & 0o777).toBe(0o600);
  const second = await codex.resume({
    ...input,
    sessionId: first.sessionId,
    prompt: 'steer',
  });
  expect(JSON.parse(second.text).args.slice(-4)).toEqual([
    'resume',
    sessionId,
    '--',
    'steer',
  ]);
  expect(
    (await readFile(input.transcriptPath, 'utf8')).startsWith(before),
  ).toBe(true);
  await expect(
    codex.resume({
      ...input,
      sessionId: '11111111-1111-4111-8111-111111111111',
    }),
  ).rejects.toMatchObject({ retryable: false });
  await expect(
    codex.resume({ ...input, sessionId: '--last' }),
  ).rejects.toMatchObject({ retryable: false });
});

it('grants Git metadata writes for an editable linked worktree', async () => {
  const input = await invocation();
  const source = join(input.cwd, 'source');
  const worktree = join(input.cwd, 'workspace');
  execFileSync('git', ['init', '-b', 'main', source]);
  execFileSync('git', ['-C', source, 'commit', '--allow-empty', '-m', 'base'], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
    },
  });
  execFileSync('git', [
    '-C',
    source,
    'worktree',
    'add',
    '-b',
    'issue',
    worktree,
  ]);
  const gitDir = execFileSync(
    'git',
    ['-C', worktree, 'rev-parse', '--absolute-git-dir'],
    {
      encoding: 'utf8',
    },
  ).trim();
  const commonDir = execFileSync(
    'git',
    ['-C', worktree, 'rev-parse', '--git-common-dir'],
    { encoding: 'utf8' },
  ).trim();
  const result = await codex.run({
    ...input,
    cwd: worktree,
    capabilities: ['edit', 'bash'],
    gitMetadataDirectories: [commonDir],
  });
  const args = JSON.parse(result.text).args as string[];
  expect(gitDir.startsWith(commonDir)).toBe(true);
  expect(args).toContainEqual(
    expect.stringContaining(`"${commonDir}"="write"`),
  );
  const readOnly = await codex.run({
    ...input,
    cwd: worktree,
    capabilities: ['read', 'bash'],
    gitMetadataDirectories: [commonDir],
    writableDirectories: ['/tmp/rocky-agent-runtime'],
  });
  const readOnlyArgs = (JSON.parse(readOnly.text).args as string[]).join(' ');
  expect(readOnlyArgs).not.toContain(`"${commonDir}"="write"`);
  expect(readOnlyArgs).toContain('"/tmp/rocky-agent-runtime"="write"');
});

it.each(['missing-result', 'wrong-session', 'auth-error'])(
  'fails unsuccessful execution: %s',
  async (mode) => {
    const input = await invocation();
    const first = await codex.run(input);
    await expect(
      codex.resume({
        ...input,
        sessionId: first.sessionId,
        env: { ...input.env, FIXTURE_MODE: mode },
      }),
    ).rejects.toThrow();
  },
);

it('keeps credentials out of argv and removes private stdio configuration', async () => {
  const input = await invocation();
  const result = await codex.run({
    ...input,
    env: { ...input.env, FIXTURE_MODE: 'stdio' },
    mcpServers: [
      {
        name: 'remote',
        config: {
          type: 'http',
          url: 'https://example.test/mcp',
          headers: { Authorization: 'Bearer private-token' },
        },
      },
      {
        name: 'local',
        config: {
          type: 'stdio',
          command: process.execPath,
          args: [
            '-e',
            'process.stdout.write(JSON.stringify({token:process.env.TOKEN,args:process.argv.slice(1)}))',
            '--',
            '--key=private-token',
          ],
          env: { TOKEN: 'private-token' },
        },
      },
    ],
  });
  const info = JSON.parse(result.text);
  expect(info.args.join(' ')).not.toContain('private-token');
  expect(info.header).toBe('Bearer private-token');
  expect(info.proxyOutput).toEqual({
    token: 'private-token',
    args: ['--key=private-token'],
  });
  const config = info.args.find((arg: string) =>
    arg.startsWith('mcp_servers='),
  );
  const proxy = /"args"=\["([^"]+\.mjs)"\]/.exec(config)?.[1];
  if (!proxy) throw new Error('Missing private MCP proxy');
  await expect(stat(proxy)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('fails unsupported storage, transports and names before a conversation starts', async () => {
  const input = await invocation();
  await expect(
    codex.run({ ...input, sessionStorage: 'rocky' }),
  ).rejects.toMatchObject({ retryable: false });
  for (const name of ['bad.name', 'rocky_read'])
    await expect(
      codex.run({
        ...input,
        mcpServers: [
          { name, config: { type: 'http', url: 'https://example.test' } },
        ],
      }),
    ).rejects.toMatchObject({ retryable: false });
  await expect(
    codex.run({
      ...input,
      mcpServers: [
        { name: 'sse', config: { type: 'sse', url: 'https://example.test' } },
      ],
    }),
  ).rejects.toMatchObject({ retryable: false });
});

it('checks Codex login on stderr without leaking API-key status', async () => {
  const adapter = getHarnessAdapter('codex');
  if (!adapter) throw new Error('Missing Codex adapter');
  for (const method of ['ChatGPT', 'an API key - sk-private']) {
    const result = await adapter.checkAuth(
      {},
      {
        env: {},
        run: async () => ({
          code: 0,
          stdout: '',
          stderr: `Logged in using ${method}`,
        }),
      },
    );
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain('sk-private');
  }
  expect(
    await adapter.checkAuth(
      {},
      {
        env: {},
        run: async () => ({ code: 0, stdout: 'unknown', stderr: '' }),
      },
    ),
  ).toMatchObject({ ok: false, fix: 'codex login' });
  expect(
    await adapter.checkAuth(
      {},
      {
        env: { CODEX_API_KEY: 'private' },
        run: async () => ({ code: 1, stdout: '', stderr: 'Not logged in' }),
      },
    ),
  ).toMatchObject({
    ok: true,
    detail: expect.stringContaining('CODEX_API_KEY'),
  });
});
