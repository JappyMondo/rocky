import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
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
