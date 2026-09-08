// Migrated from NG-628's stable adapter.spec.ts; tests use the runnable adapter seam.
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
const ok = (stdout: string) => ({ code: 0, stdout, stderr: '' });
function adapter(name: 'claude-code' | 'opencode') {
  return SHIPPED_ADAPTERS[name];
}

describe('the shipped Harness adapters', () => {
  it('rejects a known account switch and reports the execution identity', async () => {
    let count = 0;
    const result = await adapter('claude-code').checkAuth(
      {},
      {
        env: {},
        run: async () =>
          ok(
            JSON.stringify({
              loggedIn: true,
              authMethod: 'oauth_token',
              email:
                ++count === 1
                  ? 'configured@example.test'
                  : 'different@example.test',
            }),
          ),
      },
    );
    expect(result).toMatchObject({
      ok: false,
      identity: { email: 'different@example.test' },
      detail: expect.stringContaining('different@example.test'),
      fix: expect.stringContaining('claude login'),
    });
  });

  it('does not present an unverified host identity when execution omits it', async () => {
    let count = 0;
    const result = await adapter('claude-code').checkAuth(
      {},
      {
        env: {},
        run: async () =>
          ok(
            JSON.stringify({
              loggedIn: true,
              ...(++count === 1 ? { email: 'host@example.test' } : {}),
            }),
          ),
      },
    );
    expect(result).toMatchObject({
      ok: false,
      detail: expect.stringContaining('identity'),
    });
    expect(result.detail).not.toContain('signed in as host@example.test');
  });

  it('reports the actual execution identity when the host probe has no identity', async () => {
    let count = 0;
    const result = await adapter('claude-code').checkAuth(
      {},
      {
        env: {},
        run: async () =>
          ok(
            JSON.stringify({
              loggedIn: true,
              ...(++count === 2
                ? { email: 'execution@example.test', orgId: 'org-1' }
                : {}),
            }),
          ),
      },
    );
    expect(result).toMatchObject({
      ok: true,
      identity: { email: 'execution@example.test', organizationId: 'org-1' },
      detail: expect.stringContaining('execution@example.test'),
    });
  });
  it('recognizes native environment-backed OpenCode auth without a stored credential', async () => {
    const result = await adapter('opencode').checkAuth(
      {},
      {
        run: async () =>
          ok('\u001b[32m0 credentials\u001b[0m\n1 environment variable'),
      },
    );
    expect(result).toMatchObject({
      ok: true,
      detail: expect.stringContaining('environment'),
    });
  });
  it('refuses a login that is unavailable under actual execution settings', async () => {
    let calls = 0;
    const result = await adapter('claude-code').checkAuth(
      {},
      { run: async () => ok(JSON.stringify({ loggedIn: ++calls === 1 })) },
    );
    expect(result).toMatchObject({
      ok: false,
      detail: expect.stringContaining('execution settings'),
      fix: 'claude login',
    });
  });
  it('fails if the isolated account probe throws', async () => {
    let calls = 0;
    const result = await adapter('claude-code').checkAuth(
      {},
      {
        run: async () => {
          if (++calls > 1) throw new Error('probe failed');
          return ok('{"loggedIn":true}');
        },
      },
    );
    expect(result).toMatchObject({ ok: false, fix: 'claude login' });
  });
  it('recognizes a failed OpenCode probe regardless of credential count', async () => {
    expect(
      await adapter('opencode').checkAuth(
        {},
        {
          run: async () => ({
            code: 1,
            stdout: '1 credentials',
            stderr: 'denied',
          }),
        },
      ),
    ).toMatchObject({ ok: false });
  });
  it('covers exactly two runnable adapters, not a configurable registry', () => {
    expect(Object.keys(SHIPPED_ADAPTERS).sort()).toEqual([
      'claude-code',
      'opencode',
    ]);
    expect(getHarnessAdapter('claude-code')).toBe(adapter('claude-code'));
    for (const entry of Object.values(SHIPPED_ADAPTERS)) {
      expect(typeof entry.run).toBe('function');
      expect(typeof entry.resume).toBe('function');
    }
    expect(getHarnessAdapter('cursor')).toBeUndefined();
    expect(getHarnessAdapter('toString')).toBeUndefined();
    expect(isShippedHarness('cursor')).toBe(false);
    expect(isShippedHarness('claude-code')).toBe(true);
    expect(isShippedHarness('opencode')).toBe(true);
  });
  it('uses native offline auth commands with named fixes', () => {
    expect(AUTH_PROBES['claude-code']).toMatchObject({
      args: ['auth', 'status'],
      fix: 'claude login',
    });
    expect(AUTH_PROBES.opencode).toMatchObject({
      args: ['auth', 'list'],
      fix: 'opencode auth login',
    });
  });
  it.each([
    [
      'claude-code',
      '{"loggedIn":true,"email":"dev@example.com"}',
      true,
      'dev@example.com',
    ],
    ['claude-code', '{"loggedIn":false}', false, 'not signed in'],
    ['opencode', '1 credentials', true, '1 credential configured'],
    ['opencode', '0 credentials', false, 'no credentials configured'],
  ] as const)(
    'reads %s native status %s',
    async (name, stdout, signedIn, detail) => {
      const result = await adapter(name).checkAuth(
        {},
        { run: async () => ok(stdout) },
      );
      expect(result.ok).toBe(signedIn);
      expect(result.detail).toContain(detail);
      if (!signedIn) expect(result.fix).toBe(AUTH_PROBES[name].fix);
    },
  );
  it('resolves command and expanded environment as the configured account', async () => {
    const { calls, run } = runner(() => ok('{"loggedIn":true}'));
    await adapter('claude-code').checkAuth(
      { command: '${BIN}', env: { CLAUDE_CONFIG_DIR: '${ACCOUNT}' } },
      {
        run,
        env: { BIN: '/opt/claude', ACCOUNT: '/work/claude', PATH: '/usr/bin' },
      },
    );
    expect(calls[0]).toEqual({
      command: '/opt/claude',
      args: ['auth', 'status'],
      env: {
        BIN: '/opt/claude',
        ACCOUNT: '/work/claude',
        PATH: '/usr/bin',
        CLAUDE_CONFIG_DIR: '/work/claude',
      },
    });
    expect(calls[1].env.CLAUDE_CONFIG_DIR).toBe('/work/claude');
    expect(calls[1].args).toEqual(['--setting-sources', '', 'auth', 'status']);
    expect(calls[1].command).toBe('/opt/claude');
  });
  it('uses the default binary and forwards its timeout', async () => {
    let seen: unknown;
    await adapter('opencode').checkAuth(
      {},
      {
        timeoutMs: 123,
        run: async (command, _args, options) => {
          seen = { command, timeoutMs: options.timeoutMs };
          return ok('1 credentials');
        },
      },
    );
    expect(seen).toEqual({ command: 'opencode', timeoutMs: 123 });
  });
  it('fails unset variable expansion without throwing out Doctor', async () => {
    expect(
      await adapter('claude-code').checkAuth(
        { env: { CLAUDE_CONFIG_DIR: '${MISSING}' } },
        { env: {} },
      ),
    ).toMatchObject({ ok: false, detail: expect.stringContaining('MISSING') });
  });
  it.each(['claude-code', 'opencode'] as const)(
    'fails closed for unrecognized %s output despite zero exit',
    async (name) => {
      expect(
        await adapter(name).checkAuth(
          {},
          { run: async () => ok('not a status') },
        ),
      ).toMatchObject({ ok: false, fix: AUTH_PROBES[name].fix });
    },
  );
  it('does not accept loggedIn with a failed probe', async () => {
    expect(
      await adapter('claude-code').checkAuth(
        {},
        {
          run: async () => ({
            code: 1,
            stdout: '{"loggedIn":true}',
            stderr: '',
          }),
        },
      ),
    ).toMatchObject({ ok: false });
  });

  it('keeps a native logged-out JSON answer readable when Claude exits nonzero', async () => {
    expect(
      await adapter('claude-code').checkAuth(
        {},
        {
          run: async () => ({
            code: 1,
            stdout: '{\n"loggedIn":false\n}',
            stderr: '',
          }),
        },
      ),
    ).toMatchObject({
      ok: false,
      detail: 'not signed in',
      fix: 'claude login',
    });
  });
  it('reports failed auth and silent exit codes', async () => {
    expect(
      await adapter('claude-code').checkAuth(
        {},
        {
          run: async () => ({
            code: 1,
            stdout: '',
            stderr: 'not authenticated',
          }),
        },
      ),
    ).toMatchObject({
      ok: false,
      detail: expect.stringContaining('not authenticated'),
    });
    expect(
      await adapter('claude-code').checkAuth(
        {},
        { run: async () => ({ code: 3, stdout: '', stderr: '' }) },
      ),
    ).toMatchObject({ ok: false, detail: 'exited 3' });
  });
  it('reports unavailable binaries distinctly with the real runner', async () => {
    const result = await adapter('claude-code').checkAuth({
      command: '/nonexistent/definitely-not-a-harness',
    });
    expect(result).toMatchObject({
      ok: false,
      detail: expect.stringContaining('not on PATH'),
    });
    expect(result.fix).not.toBe('claude login');
  });
  it('does not trust an arbitrary real zero exit', async () => {
    expect(
      await adapter('opencode').checkAuth({ command: '/bin/echo' }),
    ).toMatchObject({ ok: false });
    expect(
      await adapter('claude-code').checkAuth({ command: process.execPath }),
    ).toMatchObject({ ok: false });
  });
  it('reports thrown runner failures', async () => {
    expect(
      await adapter('opencode').checkAuth(
        {},
        {
          run: async () => {
            throw new Error('probe failed');
          },
        },
      ),
    ).toMatchObject({
      ok: false,
      detail: expect.stringContaining('probe failed'),
    });
  });
  it('layers config over the daemon environment', () => {
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
