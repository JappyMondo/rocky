import { describe, expect, it } from 'vitest';

import {
  AUTH_PROBES,
  getHarnessAdapter,
  harnessAuthEnv,
  isShippedHarness,
  SHIPPED_ADAPTERS,
  type ProbeRunner,
} from './adapter.js';

function runner(
  answer: (command: string, args: string[]) => Awaited<ReturnType<ProbeRunner>>,
) {
  const calls: { command: string; args: string[]; env: NodeJS.ProcessEnv }[] =
    [];
  const run: ProbeRunner = async (command, args, options) => {
    calls.push({ command, args, env: options.env });
    return answer(command, args);
  };
  return { calls, run };
}

const SIGNED_IN = {
  'claude-code': JSON.stringify({ loggedIn: true, email: 'dev@example.com' }),
  opencode: '\u2514  1 credentials\n',
};

const ok = (stdout: string) => ({ code: 0, stdout, stderr: '' });

function adapter(harness: 'claude-code' | 'opencode') {
  const result = getHarnessAdapter(harness);
  if (result === undefined) {
    throw new Error(`Missing shipped adapter: ${harness}`);
  }
  return result;
}

describe('the shipped Harness adapters', () => {
  it('cover exactly the harnesses Rocky ships an adapter for', () => {
    expect(Object.keys(SHIPPED_ADAPTERS).sort()).toEqual([
      'claude-code',
      'opencode',
    ]);
    expect(getHarnessAdapter('claude-code')).toBe(
      SHIPPED_ADAPTERS['claude-code'],
    );
  });

  it('name the command a human types to fix a missing login', () => {
    expect(AUTH_PROBES['claude-code'].fix).toBe('claude login');
    expect(AUTH_PROBES.opencode.fix).toBe('opencode auth login');
  });

  it('ask each harness its own auth question rather than a model call', () => {
    expect(AUTH_PROBES['claude-code'].args).toEqual(['auth', 'status']);
    expect(AUTH_PROBES.opencode.args).toEqual(['auth', 'list']);
  });

  it('passes for Claude and says which account it is', async () => {
    const { run } = runner(() => ok(SIGNED_IN['claude-code']));

    const result = await adapter('claude-code').checkAuth({}, { run });

    expect(result.ok).toBe(true);
    expect(result.detail).toContain('dev@example.com');
  });

  it('passes for OpenCode when a credential is configured', async () => {
    const { run } = runner(() => ok(SIGNED_IN.opencode));

    expect((await adapter('opencode').checkAuth({}, { run })).ok).toBe(true);
  });

  it.each([
    ['claude-code', JSON.stringify({ loggedIn: false }), 'claude login'],
    ['opencode', '\u2514  0 credentials\n', 'opencode auth login'],
  ] as const)(
    'returns %s login fix through its adapter when unsigned',
    async (harness, stdout, fix) => {
      const result = await adapter(harness).checkAuth(
        {},
        { run: async () => ({ code: 0, stdout, stderr: '' }) },
      );

      expect(result).toMatchObject({ harness, ok: false, fix });
    },
  );

  it('treats a non-zero exit as unsigned', async () => {
    const { run } = runner(() => ({
      code: 1,
      stdout: '',
      stderr: 'not authenticated',
    }));

    const result = await adapter('claude-code').checkAuth({}, { run });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('not authenticated');
  });

  it('reports an unavailable binary rather than a missing login', async () => {
    const { run } = runner(() => {
      const error: NodeJS.ErrnoException = new Error('spawn claude ENOENT');
      error.code = 'ENOENT';
      throw error;
    });

    const result = await adapter('claude-code').checkAuth({}, { run });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('not on PATH');
    expect(result.fix).not.toBe('claude login');
  });

  it('runs the selected adapter under configured command and expanded env', async () => {
    const { calls, run } = runner(() => ok(SIGNED_IN['claude-code']));

    await adapter('claude-code').checkAuth(
      {
        command: '${CLAUDE_BIN}',
        env: { CLAUDE_CONFIG_DIR: '${ROCKY_WORK_CLAUDE}' },
      },
      {
        run,
        env: {
          CLAUDE_BIN: '/opt/claude/claude',
          ROCKY_WORK_CLAUDE: '/work/claude',
          PATH: '/usr/bin',
        },
      },
    );

    expect(calls).toEqual([
      {
        command: '/opt/claude/claude',
        args: ['auth', 'status'],
        env: {
          CLAUDE_BIN: '/opt/claude/claude',
          ROCKY_WORK_CLAUDE: '/work/claude',
          PATH: '/usr/bin',
          CLAUDE_CONFIG_DIR: '/work/claude',
        },
      },
    ]);
  });

  it("falls back to the harness's own binary on PATH", async () => {
    const { calls, run } = runner(() => ok(SIGNED_IN['claude-code']));

    await adapter('claude-code').checkAuth({}, { run });

    expect(calls[0].command).toBe('claude');
  });

  it('fails a check when configured environment expansion is unset', async () => {
    const { run } = runner(() => ok(SIGNED_IN['claude-code']));

    const result = await adapter('claude-code').checkAuth(
      { env: { CLAUDE_CONFIG_DIR: '${NOWHERE_SET}' } },
      { run, env: {} },
    );

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('NOWHERE_SET');
  });

  it('passes its configured timeout to the auth runner', async () => {
    let timeoutMs: number | undefined;

    await adapter('claude-code').checkAuth(
      {},
      {
        timeoutMs: 123,
        run: async (_command, _args, options) => {
          timeoutMs = options.timeoutMs;
          return ok(SIGNED_IN['claude-code']);
        },
      },
    );

    expect(timeoutMs).toBe(123);
  });

  it('falls back to the exit code for malformed Claude output', async () => {
    const { run } = runner(() => ok('not json at all'));

    expect((await adapter('claude-code').checkAuth({}, { run })).ok).toBe(true);
  });

  it('falls back to the exit code when OpenCode reports no credential count', async () => {
    const { run } = runner(() => ok('a banner and no count'));

    expect((await adapter('opencode').checkAuth({}, { run })).ok).toBe(true);
  });

  it('uses the singular credential detail', async () => {
    const { run } = runner(() => ok('\u2514  1 credentials\n'));

    expect((await adapter('opencode').checkAuth({}, { run })).detail).toBe(
      '1 credential configured',
    );
  });

  it('reports an otherwise silent exit code', async () => {
    const { run } = runner(() => ({ code: 3, stdout: '', stderr: '' }));

    expect((await adapter('claude-code').checkAuth({}, { run })).detail).toBe(
      'exited 3',
    );
  });

  it('uses the default runner to report a missing binary', async () => {
    const result = await adapter('claude-code').checkAuth({
      command: '/nonexistent/definitely-not-a-harness',
    });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('not on PATH');
  });

  it('uses the default runner to read a real non-zero exit', async () => {
    const result = await adapter('claude-code').checkAuth({
      command: process.execPath,
    });

    expect(result.ok).toBe(false);
  });

  it('uses the default runner to read a real zero exit', async () => {
    const result = await adapter('opencode').checkAuth({ command: '/bin/echo' });

    expect(result.ok).toBe(true);
  });

  it('does not resolve unknown adapters', () => {
    expect(getHarnessAdapter('cursor')).toBeUndefined();
    expect(getHarnessAdapter('toString')).toBeUndefined();
    expect(isShippedHarness('claude-code')).toBe(true);
    expect(isShippedHarness('opencode')).toBe(true);
    expect(isShippedHarness('cursor')).toBe(false);
  });

  it("layers configured environment over the daemon's environment", () => {
    expect(
      harnessAuthEnv(
        { env: { CLAUDE_CONFIG_DIR: '/work' } },
        { PATH: '/usr/bin', HOME: '/home/dev' },
      ),
    ).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/dev',
      CLAUDE_CONFIG_DIR: '/work',
    });
    expect(harnessAuthEnv({}, { PATH: '/usr/bin' })).toEqual({
      PATH: '/usr/bin',
    });
  });
});
