/**
 * The `checkAuth` pre-flight (NG-579), as much of it as NG-595 needs.
 *
 * ⚠️ This is a **seam, not the adapter interface**. NG-525 owns the Harness
 * adapter and will absorb this — see NG-628. What it has to preserve is the
 * property NG-579 actually asked for: "signed in" means signed in *as the
 * account Rocky will use*, so the probe runs under the harness's own
 * configured command and env, and a missing login names the exact fix.
 */
import { describe, expect, it } from 'vitest';

import {
  AUTH_PROBES,
  checkHarnessAuth,
  harnessAuthEnv,
  isShippedHarness,
  type ProbeRunner,
} from './check-auth.js';

/** A runner that records what it was asked and answers from a script. */
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
  opencode: '┌  Credentials\n│\n●  OpenAI oauth\n│\n└  1 credentials\n',
};

const ok = (stdout: string) => ({ code: 0, stdout, stderr: '' });

describe('the probes Rocky ships', () => {
  it('cover exactly the harnesses Rocky ships an adapter for', () => {
    expect(Object.keys(AUTH_PROBES).sort()).toEqual([
      'claude-code',
      'opencode',
    ]);
  });

  it('name the command a human types to fix a missing login', () => {
    expect(AUTH_PROBES['claude-code'].fix).toBe('claude login');
    expect(AUTH_PROBES.opencode.fix).toBe('opencode auth login');
  });

  it('ask each harness its own auth question rather than a model call', () => {
    // A probe that costs tokens is one nobody will run.
    expect(AUTH_PROBES['claude-code'].args).toEqual(['auth', 'status']);
    expect(AUTH_PROBES.opencode.args).toEqual(['auth', 'list']);
  });
});

describe('a harness that is signed in', () => {
  it('passes, and says which account it is', async () => {
    const { run } = runner(() => ok(SIGNED_IN['claude-code']));

    const result = await checkHarnessAuth('claude-code', {}, { run });

    expect(result.ok).toBe(true);
    expect(result.detail).toContain('dev@example.com');
  });

  it('passes for opencode when a credential is configured', async () => {
    const { run } = runner(() => ok(SIGNED_IN.opencode));

    const result = await checkHarnessAuth('opencode', {}, { run });

    expect(result.ok).toBe(true);
  });
});

describe('a harness that is not signed in', () => {
  it('fails naming the exact fix, per NG-579', async () => {
    const { run } = runner(() => ok(JSON.stringify({ loggedIn: false })));

    const result = await checkHarnessAuth('claude-code', {}, { run });

    expect(result.ok).toBe(false);
    expect(result.fix).toBe('claude login');
  });

  it('reads opencode holding no credentials as not signed in', async () => {
    const { run } = runner(() => ok('└  0 credentials\n'));

    const result = await checkHarnessAuth('opencode', {}, { run });

    expect(result.ok).toBe(false);
    expect(result.fix).toBe('opencode auth login');
  });

  it('treats a non-zero exit as not signed in', async () => {
    const { run } = runner(() => ({
      code: 1,
      stdout: '',
      stderr: 'not authenticated',
    }));

    const result = await checkHarnessAuth('claude-code', {}, { run });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('not authenticated');
  });
});

describe('a harness whose binary is not there', () => {
  it('says the binary is missing rather than that you are logged out', async () => {
    // Two different problems with two different fixes; conflating them sends
    // the developer to `claude login`, which will also fail.
    const { run } = runner(() => {
      const error: NodeJS.ErrnoException = new Error('spawn claude ENOENT');
      error.code = 'ENOENT';
      throw error;
    });

    const result = await checkHarnessAuth('claude-code', {}, { run });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('not on PATH');
    expect(result.fix).not.toBe('claude login');
  });
});

describe('the account the probe runs as', () => {
  it('is the one the instance config points the harness at', async () => {
    // NG-579: the pre-flight runs under the same env, so "signed in" means
    // signed in as the account Rocky will actually use.
    const { calls, run } = runner(() => ok(SIGNED_IN['claude-code']));

    await checkHarnessAuth(
      'claude-code',
      { env: { CLAUDE_CONFIG_DIR: '/work/claude' } },
      { run, env: { PATH: '/usr/bin' } },
    );

    expect(calls[0].env).toMatchObject({
      PATH: '/usr/bin',
      CLAUDE_CONFIG_DIR: '/work/claude',
    });
  });

  it('runs the pinned binary when the config names one', async () => {
    const { calls, run } = runner(() => ok(SIGNED_IN['claude-code']));

    await checkHarnessAuth(
      'claude-code',
      { command: '/opt/claude/claude' },
      { run },
    );

    expect(calls[0].command).toBe('/opt/claude/claude');
  });

  it("falls back to the harness's own name on PATH", async () => {
    const { calls, run } = runner(() => ok(SIGNED_IN['claude-code']));

    await checkHarnessAuth('claude-code', {}, { run });

    expect(calls[0].command).toBe('claude');
  });

  it('expands ${VAR} in the configured env, as NG-579 requires', async () => {
    const { calls, run } = runner(() => ok(SIGNED_IN['claude-code']));

    await checkHarnessAuth(
      'claude-code',
      { env: { CLAUDE_CONFIG_DIR: '${ROCKY_WORK_CLAUDE}' } },
      { run, env: { ROCKY_WORK_CLAUDE: '/work/claude' } },
    );

    expect(calls[0].env.CLAUDE_CONFIG_DIR).toBe('/work/claude');
  });

  it('fails the check, rather than the daemon, when a variable is unset', async () => {
    const { run } = runner(() => ok(SIGNED_IN['claude-code']));

    const result = await checkHarnessAuth(
      'claude-code',
      { env: { CLAUDE_CONFIG_DIR: '${NOWHERE_SET}' } },
      { run, env: {} },
    );

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('NOWHERE_SET');
  });
});

describe('reading an answer the probe did not expect', () => {
  it('falls back to the exit code when the JSON is not what it should be', async () => {
    const { run } = runner(() => ok('not json at all'));

    expect((await checkHarnessAuth('claude-code', {}, { run })).ok).toBe(true);
  });

  it('falls back to the exit code when opencode counts nothing', async () => {
    const { run } = runner(() => ok('a banner and no count'));

    expect((await checkHarnessAuth('opencode', {}, { run })).ok).toBe(true);
  });

  it('reads a single credential without pluralising it', async () => {
    const { run } = runner(() => ok('└  1 credentials\n'));

    expect((await checkHarnessAuth('opencode', {}, { run })).detail).toBe(
      '1 credential configured',
    );
  });

  it('says how it exited when the harness said nothing at all', async () => {
    const { run } = runner(() => ({ code: 3, stdout: '', stderr: '' }));

    expect((await checkHarnessAuth('claude-code', {}, { run })).detail).toBe(
      'exited 3',
    );
  });
});

describe('running the probe for real', () => {
  // The default runner, rather than an injected one — otherwise the code that
  // actually spawns the harness is the one line never exercised.
  it('reports a binary that is not there', async () => {
    const result = await checkHarnessAuth('claude-code', {
      command: '/nonexistent/definitely-not-a-harness',
    });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('not on PATH');
  });

  it('reads a real non-zero exit as not signed in', async () => {
    // node, handed `auth status` as filenames, exits non-zero — and it is the
    // one binary this suite is guaranteed to have on any platform.
    const result = await checkHarnessAuth('claude-code', {
      command: process.execPath,
    });

    expect(result.ok).toBe(false);
  });

  it('reads a real zero exit as signed in', async () => {
    const result = await checkHarnessAuth('opencode', {
      command: '/bin/echo',
    });

    expect(result.ok).toBe(true);
  });
});

describe('which harnesses Rocky knows', () => {
  it('is the shipped two, and nothing a config could add', () => {
    expect(isShippedHarness('claude-code')).toBe(true);
    expect(isShippedHarness('opencode')).toBe(true);
    expect(isShippedHarness('cursor')).toBe(false);
  });
});

describe('the env a harness probe runs under', () => {
  it("layers the configured env over the daemon's own", () => {
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
  });

  it("is the daemon's own when the config says nothing", () => {
    expect(harnessAuthEnv({}, { PATH: '/usr/bin' })).toEqual({
      PATH: '/usr/bin',
    });
  });
});
