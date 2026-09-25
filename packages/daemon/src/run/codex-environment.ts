import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { startCommand, type OwnedCommand } from './process.js';

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

async function executable(path: string): Promise<boolean> {
  return access(path, constants.X_OK).then(
    () => true,
    () => false,
  );
}

async function commandOnPath(
  name: string,
  path: string,
): Promise<string | undefined> {
  for (const directory of path.split(':')) {
    if (!directory) continue;
    const candidate = join(directory, name);
    if (await executable(candidate)) return candidate;
  }
  return undefined;
}

async function chromeExecutable(
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  if (env.AGENT_BROWSER_EXECUTABLE_PATH) {
    return (await executable(env.AGENT_BROWSER_EXECUTABLE_PATH))
      ? env.AGENT_BROWSER_EXECUTABLE_PATH
      : undefined;
  }
  if (process.platform !== 'darwin') return undefined;
  const root = join(homedir(), '.agent-browser', 'browsers');
  const entries = await readdir(root).catch(() => []);
  for (const entry of entries
    .filter((name) => name.startsWith('chrome-'))
    .sort()
    .reverse()) {
    const candidate = join(
      root,
      entry,
      'Google Chrome for Testing.app',
      'Contents',
      'MacOS',
      'Google Chrome for Testing',
    );
    if (await executable(candidate)) return candidate;
  }
  const installed =
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  return (await executable(installed)) ? installed : undefined;
}

async function projectNodeBin(
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const members = await readdir(cwd, { withFileTypes: true }).catch(() => []);
  for (const root of [
    cwd,
    ...members
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(cwd, entry.name)),
  ]) {
    const requested = (
      await readFile(join(root, '.nvmrc'), 'utf8').catch(() => '')
    )
      .trim()
      .replace(/^v/, '');
    if (!/^\d+\.\d+\.\d+$/.test(requested)) continue;
    const bin = join(
      env.NVM_DIR ?? join(homedir(), '.nvm'),
      'versions',
      'node',
      `v${requested}`,
      'bin',
    );
    if (await executable(join(bin, 'node'))) return bin;
  }
  return undefined;
}

export interface PreparedCodexEnvironment {
  env: NodeJS.ProcessEnv;
  instructions: string;
  dispose(): Promise<void>;
}

/** Host-owned Chrome lets sandboxed Codex agents use agent-browser over CDP. */
export async function prepareCodexEnvironment(
  cwd: string,
  inherited: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<PreparedCodexEnvironment> {
  signal.throwIfAborted();
  // macOS Unix sockets have a short path limit. Keep this root under /private/tmp
  // so Rocky's per-agent session names still fit.
  const root = await mkdtemp(
    join(
      process.platform === 'darwin' ? '/private/tmp' : tmpdir(),
      `rb-${createHash('sha256').update(cwd).digest('hex').slice(0, 8)}-`,
    ),
  );
  const env: NodeJS.ProcessEnv = {
    CI: 'true',
    NX_DAEMON: 'false',
    NX_CACHE_DIRECTORY: join(root, 'nx-cache'),
    NX_WORKSPACE_DATA_DIRECTORY: join(root, 'nx-data'),
    ELECTRON_CACHE: join(root, 'electron'),
    electron_config_cache: join(root, 'electron'),
    npm_config_cache: join(root, 'npm'),
    npm_config_devdir: join(root, 'node-gyp'),
  };
  const zshDir = join(root, 'zsh');
  const setShellPath = async (path: string) => {
    await mkdir(zshDir, { recursive: true, mode: 0o700 });
    await writeFile(join(zshDir, '.zprofile'), `export PATH=${quote(path)}\n`, {
      mode: 0o600,
    });
    env.ZDOTDIR = zshDir;
  };
  let browser: OwnedCommand | undefined;
  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      signal.removeEventListener('abort', onAbort);
      await browser?.stop();
      await rm(root, { recursive: true, force: true });
    })());
  const onAbort = () => {
    void stop();
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    const currentPath = inherited.PATH ?? process.env.PATH ?? '';
    const nodeBin = await projectNodeBin(cwd, inherited);
    const path = nodeBin ? `${nodeBin}:${currentPath}` : currentPath;
    if (nodeBin) env.PATH = path;
    await setShellPath(path);
    const cli = await commandOnPath('agent-browser', path);
    const chrome = cli ? await chromeExecutable(inherited) : undefined;
    if (!cli || !chrome) {
      return {
        env,
        instructions:
          'Rocky isolated Nx and package caches for this agent and selected the installed Node version from .nvmrc when available. Use node and pnpm directly; this noninteractive shell need not run nvm use. If browser checks are required, install agent-browser and Chrome for Testing on the host.',
        dispose: stop,
      };
    }
    const profile = join(root, 'chrome-profile');
    const socketDir = join(root, 'sockets');
    const binDir = join(root, 'bin');
    await Promise.all([
      mkdir(profile, { recursive: true, mode: 0o700 }),
      mkdir(socketDir, { recursive: true, mode: 0o700 }),
      mkdir(binDir, { recursive: true, mode: 0o700 }),
    ]);
    browser = startCommand(
      `${quote(chrome)} --headless --no-first-run --no-default-browser-check --disable-background-networking --remote-debugging-address=127.0.0.1 --remote-debugging-port=0 --user-data-dir=${quote(profile)} about:blank`,
      { cwd: root, background: true, signal },
    );
    await browser.result;
    let port: number | undefined;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !signal.aborted) {
      const contents = await readFile(
        join(profile, 'DevToolsActivePort'),
        'utf8',
      ).catch(() => '');
      const found = Number.parseInt(contents.split('\n')[0] ?? '', 10);
      if (Number.isInteger(found) && found > 0 && found < 65536) {
        port = found;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!port) throw new Error('Chrome did not open a DevTools port.');
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal,
    });
    if (!response.ok)
      throw new Error('Chrome DevTools endpoint is unavailable.');
    const wrapper = join(binDir, 'agent-browser');
    await writeFile(
      wrapper,
      `#!/bin/sh\nexec ${quote(cli)} --cdp "$ROCKY_BROWSER_CDP_PORT" "$@"\n`,
      { mode: 0o700 },
    );
    env.PATH = `${binDir}:${path}`;
    await setShellPath(env.PATH);
    env.AGENT_BROWSER_SOCKET_DIR = socketDir;
    env.AGENT_BROWSER_IDLE_TIMEOUT_MS = '60000';
    env.ROCKY_BROWSER_CDP_PORT = String(port);
    return {
      env,
      instructions:
        'Rocky selected the installed Node version from .nvmrc when available and isolated Nx and package caches. Use node and pnpm directly; this noninteractive shell need not run nvm use. Rocky started an isolated host browser. Use agent-browser with $ROCKY_BROWSER_SESSION normally; Rocky connects it through CDP. Close only your session when done.',
      dispose: stop,
    };
  } catch (error) {
    await stop();
    throw new Error(
      `Rocky browser preparation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
