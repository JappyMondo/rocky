import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { prepareCodexEnvironment } from './codex-environment.js';

const exec = promisify(execFile);
const browserAvailable =
  process.platform === 'darwin' &&
  existsSync(join(homedir(), '.agent-browser', 'browsers')) &&
  existsSync('/opt/homebrew/bin/agent-browser');

it('prepares and disposes an isolated browser using available host tools', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'rocky-browser-test-'));
  const browser = await mkdtemp(join(tmpdir(), 'rocky-browser-bin-'));
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  const chrome = join(browser, 'chrome');
  await writeFile(
    chrome,
    `#!/bin/sh\nfor arg in "$@"; do\n  case "$arg" in\n    --user-data-dir=*) profile="\${arg#--user-data-dir=}" ;;\n  esac\ndone\nprintf '${address.port}\\n' > "$profile/DevToolsActivePort"\nsleep 60\n`,
    { mode: 0o700 },
  );
  await writeFile(join(browser, 'agent-browser'), '#!/bin/sh\nexit 0\n', {
    mode: 0o700,
  });
  let prepared: Awaited<ReturnType<typeof prepareCodexEnvironment>> | undefined;
  try {
    prepared = await prepareCodexEnvironment(
      workspace,
      {
        ...process.env,
        PATH: `${browser}:${process.env.PATH ?? ''}`,
        AGENT_BROWSER_EXECUTABLE_PATH: chrome,
      },
      new AbortController().signal,
    );
    expect(prepared.env.ROCKY_BROWSER_CDP_PORT).toBe(String(address.port));
    expect(prepared.env.PATH?.split(':')[0]).toMatch(/\/bin$/);
    expect(prepared.env.AGENT_BROWSER_SOCKET_DIR).toContain('sockets');
    expect(prepared.instructions).toContain('host browser');
    expect(prepared.writableDirectories).toEqual([
      prepared.env.NX_CACHE_DIRECTORY!.replace(/\/nx-cache$/, ''),
    ]);
    expect(
      existsSync(prepared.env.NX_CACHE_DIRECTORY!.replace(/\/nx-cache$/, '')),
    ).toBe(true);
  } finally {
    await prepared?.dispose();
    await prepared?.dispose();
    server.close();
    await Promise.all([
      rm(workspace, { recursive: true, force: true }),
      rm(browser, { recursive: true, force: true }),
    ]);
  }
  expect(
    existsSync(prepared!.env.NX_CACHE_DIRECTORY!.replace(/\/nx-cache$/, '')),
  ).toBe(false);
});

it('keeps isolated caches when browser tools are unavailable', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'rocky-no-browser-'));
  const prepared = await prepareCodexEnvironment(
    workspace,
    { PATH: '' },
    new AbortController().signal,
  );
  try {
    expect(prepared.env.ROCKY_BROWSER_CDP_PORT).toBeUndefined();
    expect(prepared.env.NX_DAEMON).toBe('false');
    expect(prepared.env.CI).toBe('true');
    expect(prepared.env.electron_config_cache).toBe(
      prepared.env.ELECTRON_CACHE,
    );
    expect(prepared.env.ZDOTDIR).toMatch(/\/zsh$/);
    expect(prepared.instructions).toContain('install agent-browser');
  } finally {
    await prepared.dispose();
    await rm(workspace, { recursive: true, force: true });
  }
});

it('uses the host PATH when the agent has no PATH override', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'rocky-browser-path-'));
  const prepared = await prepareCodexEnvironment(
    workspace,
    { AGENT_BROWSER_EXECUTABLE_PATH: join(workspace, 'missing-chrome') },
    new AbortController().signal,
  );
  try {
    expect(prepared.env.ROCKY_BROWSER_CDP_PORT).toBeUndefined();
  } finally {
    await prepared.dispose();
    await rm(workspace, { recursive: true, force: true });
  }
});

it('does not prepare an aborted agent', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    prepareCodexEnvironment(tmpdir(), process.env, controller.signal),
  ).rejects.toThrow();
});

it('selects the project Node version from NVM_DIR', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'rocky-node-version-'));
  const nvm = await mkdtemp(join(tmpdir(), 'rocky-nvm-'));
  const bin = join(nvm, 'versions', 'node', 'v20.19.0', 'bin');
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'node'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  await writeFile(join(workspace, '.nvmrc'), 'v20.19.0\n');
  const controller = new AbortController();
  try {
    const prepared = await prepareCodexEnvironment(
      workspace,
      { PATH: '', NVM_DIR: nvm },
      controller.signal,
    );
    expect(prepared.env.PATH).toBe(`${bin}:`);
    if (existsSync('/bin/zsh')) {
      const selected = await exec('/bin/zsh', ['-lc', 'command -v node'], {
        env: { ...process.env, ...prepared.env },
      });
      expect(selected.stdout.trim()).toBe(join(bin, 'node'));
    }
    controller.abort();
    await prepared.dispose();
  } finally {
    await Promise.all([
      rm(workspace, { recursive: true, force: true }),
      rm(nvm, { recursive: true, force: true }),
    ]);
  }
});

it('falls back when Chrome is unavailable and discovers project Node versions safely', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'rocky-browser-fallback-'));
  const bin = join(workspace, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'agent-browser'), '#!/bin/sh\nexit 0\n', {
    mode: 0o700,
  });
  await writeFile(join(workspace, '.nvmrc'), 'invalid\n');
  const nested = join(workspace, 'project');
  await mkdir(nested);
  await writeFile(join(nested, '.nvmrc'), 'v99.99.99\n');
  const prepared = await prepareCodexEnvironment(
    workspace,
    {
      PATH: `:${bin}:/missing`,
      AGENT_BROWSER_EXECUTABLE_PATH: join(workspace, 'missing-chrome'),
    },
    new AbortController().signal,
  );
  try {
    expect(prepared.env.ROCKY_BROWSER_CDP_PORT).toBeUndefined();
    expect(prepared.instructions).toContain('install agent-browser');
  } finally {
    await prepared.dispose();
    await rm(workspace, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === 'darwin')(
  'falls back when Chrome auto-discovery is unsupported',
  async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'rocky-browser-auto-'));
    await writeFile(join(workspace, 'agent-browser'), '#!/bin/sh\nexit 0\n', {
      mode: 0o700,
    });
    try {
      const prepared = await prepareCodexEnvironment(
        join(workspace, 'missing-workspace'),
        { PATH: workspace },
        new AbortController().signal,
      );
      expect(prepared.env.ROCKY_BROWSER_CDP_PORT).toBeUndefined();
      await prepared.dispose();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  },
);

it('stops browser preparation when an agent is cancelled before DevTools opens', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'rocky-browser-cancel-'));
  const chrome = join(workspace, 'chrome');
  await writeFile(chrome, '#!/bin/sh\nsleep 60\n', { mode: 0o700 });
  await writeFile(join(workspace, 'agent-browser'), '#!/bin/sh\nexit 0\n', {
    mode: 0o700,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 200);
  try {
    await expect(
      prepareCodexEnvironment(
        workspace,
        {
          PATH: `${workspace}:${process.env.PATH ?? ''}`,
          AGENT_BROWSER_EXECUTABLE_PATH: chrome,
        },
        controller.signal,
      ),
    ).rejects.toThrow('Chrome did not open a DevTools port');
  } finally {
    clearTimeout(timer);
    await rm(workspace, { recursive: true, force: true });
  }
});

it('reports an unavailable DevTools endpoint and removes temporary browser state', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'rocky-browser-error-'));
  const bin = join(workspace, 'bin');
  await mkdir(bin);
  const server = createServer((_request, response) => {
    response.writeHead(503);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  const chrome = join(bin, 'chrome');
  await writeFile(
    chrome,
    `#!/bin/sh\nfor arg in "$@"; do\n  case "$arg" in\n    --user-data-dir=*) profile="\${arg#--user-data-dir=}" ;;\n  esac\ndone\nprintf '${address.port}\\n' > "$profile/DevToolsActivePort"\nsleep 60\n`,
    { mode: 0o700 },
  );
  await writeFile(join(bin, 'agent-browser'), '#!/bin/sh\nexit 0\n', {
    mode: 0o700,
  });
  try {
    await expect(
      prepareCodexEnvironment(
        workspace,
        {
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          AGENT_BROWSER_EXECUTABLE_PATH: chrome,
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow('Chrome DevTools endpoint is unavailable');
  } finally {
    server.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

it.skipIf(!browserAvailable)(
  'connects sandboxed agent-browser to an isolated host Chrome',
  async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'rocky-browser-test-'));
    const controller = new AbortController();
    const prepared = await prepareCodexEnvironment(
      workspace,
      process.env,
      controller.signal,
    );
    try {
      expect(prepared.env.ROCKY_BROWSER_CDP_PORT).toMatch(/^\d+$/);
      expect(prepared.env.NX_CACHE_DIRECTORY).toContain('rb-');
      const env = { ...process.env, ...prepared.env };
      const session = `rocky-browser-test-${process.pid}`;
      const opened = await exec(
        'agent-browser',
        ['--session', session, 'open', 'about:blank'],
        { env },
      );
      expect(opened.stdout).toContain('about:blank');
      const url = await exec(
        'agent-browser',
        ['--session', session, 'get', 'url'],
        { env },
      );
      expect(url.stdout).toContain('about:blank');
      await exec('agent-browser', ['--session', session, 'close'], { env });
    } finally {
      await prepared.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  },
  30_000,
);
