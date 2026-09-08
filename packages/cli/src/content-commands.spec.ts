import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AUTH_PROBES, rockyPaths } from '@rocky/daemon';
import { afterEach, expect, it, vi } from 'vitest';
import {
  initContent,
  launchInteractive,
  resolveInteractiveHarness,
  selectClaudeConsentMode,
  upgradeContent,
  type InteractiveRequest,
} from './content-commands.js';

const temporary: string[] = [];
const claudeHelp = (modes: string[]) =>
  [
    'Usage: claude [options]',
    '  --permission-mode <mode> Permission mode to use for the session',
    `    (choices: ${modes.map((mode) => JSON.stringify(mode)).join(', ')})`,
    '  --permission-prompts <target> Who answers permission prompts',
  ].join('\n');
const currentClaude = {
  version: '2.1.263 (Claude Code)',
  help: claudeHelp([
    'acceptEdits',
    'auto',
    'bypassPermissions',
    'manual',
    'dontAsk',
    'plan',
  ]),
};
const currentClaudeProbe = { probeClaude: async () => currentClaude };
afterEach(async () => {
  await Promise.all(
    temporary.map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const repo = await mkdtemp(join(tmpdir(), 'rocky-cli-content-'));
  temporary.push(repo);
  const shippedDir = join(repo, 'installed-default');
  await mkdir(shippedDir);
  await writeFile(join(shippedDir, 'workflow.ts'), '// shipped');
  await mkdir(join(repo, '.rocky'));
  await writeFile(join(repo, '.rocky/workflow.ts'), '// edited');
  return { repo, shippedDir };
}

async function nativeClaude(repo: string) {
  const command = join(repo, 'claude-fixture.mjs');
  await writeFile(
    command,
    [
      `#!${process.execPath}`,
      "import { appendFileSync, writeFileSync } from 'node:fs';",
      'const args = process.argv.slice(2);',
      'const trace = process.env.ROCKY_CLAUDE_TRACE;',
      "if (trace) appendFileSync(trace, JSON.stringify(args) + '\\n');",
      "if (args.includes('--version')) {",
      "  process.stdout.write(process.env.ROCKY_CLAUDE_VERSION ?? 'fixture');",
      "  process.exit(Number(process.env.ROCKY_CLAUDE_VERSION_EXIT ?? '0'));",
      '}',
      "if (args.includes('--help')) {",
      "  process.stdout.write(process.env.ROCKY_CLAUDE_HELP ?? '');",
      "  process.exit(Number(process.env.ROCKY_CLAUDE_HELP_EXIT ?? '0'));",
      '}',
      'if (process.env.ROCKY_CLAUDE_ACCEPTED_FILE)',
      '  writeFileSync(',
      '    process.env.ROCKY_CLAUDE_ACCEPTED_FILE,',
      "    process.env.ROCKY_CLAUDE_ACCEPTED_CONTENT ?? '',",
      '  );',
      "process.exit(Number(process.env.ROCKY_CLAUDE_EXIT ?? '0'));",
    ].join('\n'),
  );
  await chmod(command, 0o755);
  return command;
}

async function invocations(trace: string): Promise<string[][]> {
  return (await readFile(trace, 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

it('init delegates to foreground inspection/seeding and refuses existing content first', async () => {
  const { repo } = await fixture();
  const seed = vi.fn(async () => join(repo, '.rocky'));
  await expect(initContent({ repo, seed })).rejects.toThrow(
    'Already configured',
  );
  expect(seed).not.toHaveBeenCalled();
  await rm(join(repo, '.rocky'), { recursive: true });
  expect(await initContent({ repo, seed })).toBe(join(repo, '.rocky'));
  expect(seed).toHaveBeenCalledWith(repo);
});

it('selects only explicitly advertised Claude consent modes', () => {
  expect(selectClaudeConsentMode(currentClaude)).toBe('manual');
  expect(
    selectClaudeConsentMode({
      version: '2.0.0',
      help: claudeHelp(['default', 'acceptEdits']),
    }),
  ).toBe('default');
  expect(() =>
    selectClaudeConsentMode({
      version: '2.1.263 (Claude Code)',
      help: claudeHelp(['acceptEdits', 'auto', 'plan']),
    }),
  ).toThrow(/does not advertise manual or default/);
});

it('upgrade opens a native interactive Claude session with explicit edit consent and propagates exit', async () => {
  const { repo, shippedDir } = await fixture();
  const launch = vi.fn(async (_request: InteractiveRequest) => ({
    code: 7,
    signal: null,
  }));
  const result = await upgradeContent({
    repo,
    shippedDir,
    interactive: true,
    ...currentClaudeProbe,
    launch,
    resolveHarness: async () => ({
      command: 'my-claude',
      env: { CLAUDE_CONFIG_DIR: '/account' },
    }),
  });
  expect(result).toEqual({ code: 7, signal: null });
  const request = launch.mock.calls[0]?.[0];
  expect(request).toMatchObject({
    command: 'my-claude',
    cwd: repo,
    stdio: 'inherit',
    env: { CLAUDE_CONFIG_DIR: '/account' },
  });
  expect(request?.args).toContain('--permission-mode');
  expect(request?.args).toContain('manual');
  expect(request?.args.join(' ')).toContain(
    '"ask":["Edit","Write","Bash","NotebookEdit","mcp__*"]',
  );
  expect(request?.args.join(' ')).toContain(shippedDir);
  expect(request?.args).not.toContain('--print');
  expect(await readFile(join(repo, '.rocky/workflow.ts'), 'utf8')).toBe(
    '// edited',
  );
});

it('runs the real version/help probes, starts only the advertised manual flow, and preserves abort semantics', async () => {
  const { repo, shippedDir } = await fixture();
  const git = async (...args: string[]) =>
    promisify(execFile)('git', args, { cwd: repo });
  await git('init', '--quiet');
  await writeFile(join(repo, 'dirty.txt'), 'staged');
  await git('add', 'dirty.txt', '.rocky/workflow.ts');
  await writeFile(join(repo, 'dirty.txt'), 'unstaged');
  const index = await readFile(join(repo, '.git/index'));
  const command = await nativeClaude(repo);
  const trace = join(repo, 'claude-trace.jsonl');
  const env = {
    ROCKY_CLAUDE_TRACE: trace,
    ROCKY_CLAUDE_VERSION: currentClaude.version,
    ROCKY_CLAUDE_HELP: currentClaude.help,
    ROCKY_CLAUDE_EXIT: '130',
  };
  const common = {
    repo,
    shippedDir,
    interactive: true,
    resolveHarness: async () => ({ command, env }),
  };
  await expect(upgradeContent(common)).resolves.toEqual({
    code: 130,
    signal: null,
  });
  expect(await readFile(join(repo, '.git/index'))).toEqual(index);
  expect(await readFile(join(repo, 'dirty.txt'), 'utf8')).toBe('unstaged');
  expect(await readFile(join(repo, '.rocky/workflow.ts'), 'utf8')).toBe(
    '// edited',
  );
  const first = await invocations(trace);
  expect(first.slice(0, 2)).toEqual([['--version'], ['--help']]);
  const session = first[2];
  if (!session) throw new Error('Expected an interactive Claude invocation.');
  expect(session[session.indexOf('--permission-mode') + 1]).toBe('manual');
  expect(session[session.indexOf('--tools') + 1]).toBe(
    'Read,Glob,Grep,Edit,Write',
  );
  expect(session).toContain('--strict-mcp-config');
  expect(session).not.toContain('--print');
  expect(session).not.toContain('--dangerously-skip-permissions');
  const settings = JSON.parse(
    session[session.indexOf('--settings') + 1] ?? '{}',
  );
  expect(settings.permissions).toEqual({
    ask: ['Edit', 'Write', 'Bash', 'NotebookEdit', 'mcp__*'],
    deny: [`Edit(${shippedDir}/**)`, `Write(${shippedDir}/**)`],
  });

  await expect(
    upgradeContent({
      ...common,
      resolveHarness: async () => ({
        command,
        env: {
          ...env,
          ROCKY_CLAUDE_ACCEPTED_FILE: join(repo, '.rocky/workflow.ts'),
          ROCKY_CLAUDE_ACCEPTED_CONTENT: '// accepted',
        },
      }),
    }),
  ).resolves.toEqual({ code: 130, signal: null });
  expect(await readFile(join(repo, '.git/index'))).toEqual(index);
  expect(await readFile(join(repo, 'dirty.txt'), 'utf8')).toBe('unstaged');
  expect(await readFile(join(repo, '.rocky/workflow.ts'), 'utf8')).toBe(
    '// accepted',
  );
});

it('names a failed real Claude help probe without starting a session', async () => {
  const { repo, shippedDir } = await fixture();
  const command = await nativeClaude(repo);
  const trace = join(repo, 'claude-trace.jsonl');
  await expect(
    upgradeContent({
      repo,
      shippedDir,
      interactive: true,
      resolveHarness: async () => ({
        command,
        env: {
          ROCKY_CLAUDE_TRACE: trace,
          ROCKY_CLAUDE_VERSION: currentClaude.version,
          ROCKY_CLAUDE_HELP_EXIT: '9',
        },
      }),
    }),
  ).rejects.toThrow(/2\.1\.263.*--help failed/);
  expect(await invocations(trace)).toEqual([['--version'], ['--help']]);
});

it('names a failed real Claude version probe without reading help or starting a session', async () => {
  const { repo, shippedDir } = await fixture();
  const command = await nativeClaude(repo);
  const trace = join(repo, 'claude-trace.jsonl');
  await expect(
    upgradeContent({
      repo,
      shippedDir,
      interactive: true,
      resolveHarness: async () => ({
        command,
        env: {
          ROCKY_CLAUDE_TRACE: trace,
          ROCKY_CLAUDE_VERSION_EXIT: '9',
        },
      }),
    }),
  ).rejects.toThrow(/--version failed/);
  expect(await invocations(trace)).toEqual([['--version']]);
});

it('refuses unproved real Claude consent compatibility before launching', async () => {
  const { repo, shippedDir } = await fixture();
  const command = await nativeClaude(repo);
  const trace = join(repo, 'claude-trace.jsonl');
  await expect(
    upgradeContent({
      repo,
      shippedDir,
      interactive: true,
      resolveHarness: async () => ({
        command,
        env: {
          ROCKY_CLAUDE_TRACE: trace,
          ROCKY_CLAUDE_VERSION: currentClaude.version,
          ROCKY_CLAUDE_HELP: claudeHelp(['acceptEdits', 'auto', 'plan']),
        },
      }),
    }),
  ).rejects.toThrow(/did not start a session/);
  expect(await invocations(trace)).toEqual([['--version'], ['--help']]);
});

it('OpenCode uses its TUI, preserves account/storage config, and overrides automatic editing', async () => {
  const { repo, shippedDir } = await fixture();
  const launch = vi.fn(async (_request: InteractiveRequest) => ({
    code: null,
    signal: 'SIGINT' as const,
  }));
  expect(
    await upgradeContent({
      repo,
      shippedDir,
      harness: 'opencode',
      interactive: true,
      launch,
      resolveHarness: async () => ({
        command: '/custom/opencode',
        env: {
          OPENCODE_CONFIG_DIR: '/own/config',
          XDG_DATA_HOME: '/own/storage',
          OPENCODE_PERMISSION: '{"*":"allow"}',
          OPENCODE_CONFIG_CONTENT: '{"theme":"custom"}',
        },
      }),
    }),
  ).toEqual({ code: null, signal: 'SIGINT' });
  const request = launch.mock.calls[0][0];
  expect(request.args.slice(0, 4)).toEqual([
    '--pure',
    '--agent',
    'rocky-upgrade',
    '--prompt',
  ]);
  expect(request.env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('true');
  expect(request.args).not.toContain('run');
  expect(request.args).not.toContain('--auto');
  expect(request.env).toMatchObject({
    OPENCODE_CONFIG_DIR: '/own/config',
    XDG_DATA_HOME: '/own/storage',
  });
  const permission = JSON.parse(request.env.OPENCODE_PERMISSION ?? '{}');
  expect(permission.edit).toEqual({ '*': 'ask', [`${shippedDir}/**`]: 'deny' });
  expect(permission.bash).toBe('deny');
  expect(JSON.parse(request.env.OPENCODE_CONFIG_CONTENT ?? '{}').theme).toBe(
    'custom',
  );
  expect(
    JSON.parse(request.env.OPENCODE_CONFIG_CONTENT ?? '{}').agent[
      'rocky-upgrade'
    ].permission,
  ).toEqual(permission);
});

it('uses the configured native defaults without inheriting an OpenCode policy', async () => {
  const { repo, shippedDir } = await fixture();
  const paths = rockyPaths(join(repo, 'instance'));
  const requests: InteractiveRequest[] = [];
  const launch = vi.fn(async (request: InteractiveRequest) => {
    requests.push(request);
    return { code: 0, signal: null };
  });
  await upgradeContent({
    repo,
    shippedDir,
    interactive: true,
    paths,
    env: {},
    ...currentClaudeProbe,
    launch,
  });
  await upgradeContent({
    repo,
    shippedDir,
    harness: 'opencode',
    interactive: true,
    paths,
    env: {},
    launch,
  });
  const [claude, opencode] = requests;
  if (!claude || !opencode) throw new Error('Expected both native sessions.');
  expect(claude.command).toBe(AUTH_PROBES['claude-code'].command);
  expect(opencode.command).toBe(AUTH_PROBES.opencode.command);
  expect(JSON.parse(opencode.env.OPENCODE_CONFIG_CONTENT ?? '{}')).toEqual({
    agent: {
      'rocky-upgrade': {
        description: 'Negotiate Workflow changes with the human',
        mode: 'primary',
        permission: JSON.parse(opencode.env.OPENCODE_PERMISSION ?? '{}'),
      },
    },
  });
});

it('uses default storage and environment only after interactive consent', async () => {
  const { repo, shippedDir } = await fixture();
  const requests: InteractiveRequest[] = [];
  vi.stubEnv('ROCKY_HOME', join(repo, 'default-instance'));
  try {
    await upgradeContent({
      repo,
      shippedDir,
      interactive: true,
      ...currentClaudeProbe,
      launch: async (request) => {
        requests.push(request);
        return { code: 0, signal: null };
      },
    });
  } finally {
    vi.unstubAllEnvs();
  }
  expect(requests[0]?.command).toBe(AUTH_PROBES['claude-code'].command);
});

it('rejects an invalid Harness and an incomplete packaged default before launching', async () => {
  const { repo, shippedDir } = await fixture();
  const launch = vi.fn(async () => ({ code: 0, signal: null }));
  await expect(
    upgradeContent({
      repo,
      shippedDir,
      harness: JSON.parse('"not-a-harness"'),
      interactive: true,
      launch,
    }),
  ).rejects.toThrow('Use --harness claude-code or --harness opencode');
  await rm(join(shippedDir, 'workflow.ts'));
  await expect(
    upgradeContent({ repo, shippedDir, interactive: true, launch }),
  ).rejects.toThrow('packaging failure');
  expect(launch).not.toHaveBeenCalled();
});

it('preserves an unexpected native launch failure', async () => {
  const { repo, shippedDir } = await fixture();
  const failure = new Error('native session failed');
  await expect(
    upgradeContent({
      repo,
      shippedDir,
      interactive: true,
      ...currentClaudeProbe,
      resolveHarness: async () => ({ command: 'claude', env: {} }),
      launch: async () => {
        throw failure;
      },
    }),
  ).rejects.toBe(failure);
});

it('refuses missing terminal, local content, and packaged assets before launching', async () => {
  const { repo, shippedDir } = await fixture();
  const launch = vi.fn(async () => ({ code: 0, signal: null }));
  await expect(
    upgradeContent({ repo, shippedDir, interactive: false, launch }),
  ).rejects.toThrow('interactive terminal');
  await expect(upgradeContent({ repo, shippedDir, launch })).rejects.toThrow(
    'interactive terminal',
  );
  await expect(
    upgradeContent({
      repo,
      shippedDir: join(repo, 'missing'),
      interactive: true,
      launch,
    }),
  ).rejects.toThrow('packaging failure');
  await rm(join(repo, '.rocky'), { recursive: true });
  await expect(
    upgradeContent({ repo, shippedDir, interactive: true, launch }),
  ).rejects.toThrow('rocky init');
  expect(launch).not.toHaveBeenCalled();
});

it('resolves configured command and environment with shared expansion without reading credentials', async () => {
  const { repo } = await fixture();
  const paths = rockyPaths(join(repo, 'instance'));
  await mkdir(paths.root, { recursive: true });
  await writeFile(
    paths.configFile,
    JSON.stringify({
      harnesses: {
        opencode: {
          command: '${BIN}/opencode',
          env: { XDG_DATA_HOME: '${STORE}' },
        },
      },
    }),
  );
  expect(
    await resolveInteractiveHarness('opencode', paths, {
      BIN: '/native',
      STORE: '/storage',
    }),
  ).toEqual({
    command: '/native/opencode',
    env: { BIN: '/native', STORE: '/storage', XDG_DATA_HOME: '/storage' },
  });
});

it('launches a foreground child, reports exits/signals and removes signal listeners', async () => {
  const { repo } = await fixture();
  const request = {
    command: process.execPath,
    cwd: repo,
    env: process.env,
    stdio: 'inherit' as const,
  };
  const before = process.listenerCount('SIGINT');
  expect(
    await launchInteractive({ ...request, args: ['-e', 'process.exit(9)'] }),
  ).toEqual({ code: 9, signal: null });
  expect(
    await launchInteractive({
      ...request,
      args: ['-e', 'process.kill(process.pid, "SIGTERM")'],
    }),
  ).toEqual({ code: null, signal: 'SIGTERM' });
  await expect(
    launchInteractive({ ...request, command: join(repo, 'missing'), args: [] }),
  ).rejects.toMatchObject({ code: 'ENOENT' });
  expect(process.listenerCount('SIGINT')).toBe(before);
});

it('names the missing binary fix without falling back to another Harness', async () => {
  const { repo, shippedDir } = await fixture();
  await expect(
    upgradeContent({
      repo,
      shippedDir,
      interactive: true,
      resolveHarness: async () => ({ command: join(repo, 'missing'), env: {} }),
    }),
  ).rejects.toThrow('fix harnesses.claude-code.command');
});
