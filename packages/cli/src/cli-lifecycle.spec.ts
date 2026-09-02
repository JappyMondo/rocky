/**
 * The lifecycle commands as a developer types them (NG-595).
 *
 * `daemon-control.spec.ts` proves the machinery against real processes; these
 * assert the part a human actually meets — what is printed, and whether the
 * shell gets a non-zero exit code. AC4 in particular is about exit codes:
 * "exits non-zero when any check fails."
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  rockyPaths,
  runDaemon,
  writeInstanceConfig,
  writePidFile,
  type DaemonProcess,
  type RockyPaths,
} from '@rocky/daemon';

import { buildCli, type CliIo, type CliOptions } from './cli.js';
import { serviceTarget } from './service.js';

let root: string;
let home: string;
let paths: RockyPaths;
let originalExitCode: typeof process.exitCode;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'rocky-cmd-'));
  home = mkdtempSync(join(tmpdir(), 'rocky-cmd-home-'));
  paths = rockyPaths(root);
  // The daemon lays this out at boot; most of these tests never start one.
  mkdirSync(paths.logsDir, { recursive: true });
  // Nothing listens on the discard port. Pinned so that a command finding no
  // pidfile falls back to *this* rather than to the default 7625, where
  // another suite's daemon may well be answering.
  await writeInstanceConfig(paths, { server: { host: '127.0.0.1', port: 9 } });
  originalExitCode = process.exitCode;
});

afterEach(() => {
  process.exitCode = originalExitCode;
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      out: (line: string) => out.push(line),
      err: (line: string) => err.push(line),
    } satisfies CliIo,
  };
}

/** Never touches the network or a real harness binary. */
const HEALTHY_DOCTOR: CliOptions['doctor'] = {
  fetch: () => Promise.resolve(new Response('{}', { status: 200 })),
  checkHarness: (harness) =>
    Promise.resolve({ harness, ok: true, detail: 'signed in' }),
};

async function run(argv: string[], options: CliOptions = {}) {
  const lines = io();
  await buildCli(lines.io, { paths, ...options }).parseAsync([
    'node',
    'rocky',
    ...argv,
  ]);
  return lines;
}

const MAC = () => ({
  platform: 'darwin' as const,
  home,
  entry: '/usr/local/lib/rocky/main.js',
  execPath: '/usr/local/bin/node',
});

describe('`rocky doctor`', () => {
  it('exits zero and says so when every check passes', async () => {
    const lines = await run(['doctor'], { doctor: HEALTHY_DOCTOR });

    expect(lines.out.join('\n')).toContain('All checks passed.');
    expect(process.exitCode).toBeUndefined();
  });

  it('exits non-zero when a check fails', async () => {
    await writeFile(paths.configFile, '{ not json');

    await run(['doctor'], { doctor: HEALTHY_DOCTOR });

    expect(process.exitCode).toBe(1);
  });

  it('prints every check with its verdict', async () => {
    const lines = await run(['doctor'], { doctor: HEALTHY_DOCTOR });
    const printed = lines.out.join('\n');

    expect(printed).toContain('config.json');
    expect(printed).toContain('publicUrl');
    expect(printed).toContain('harness claude-code');
    expect(printed).toContain('harness opencode');
  });

  it('prints the fix under a check that failed', async () => {
    await writeInstanceConfig(paths, {
      publicUrl: 'https://rocky.example.com',
      harnesses: { 'claude-code': {} },
    });

    const lines = await run(['doctor'], {
      doctor: {
        ...HEALTHY_DOCTOR,
        checkHarness: (harness) =>
          Promise.resolve({
            harness,
            ok: false,
            detail: 'not signed in',
            fix: 'claude login',
          }),
      },
    });

    expect(lines.out.join('\n')).toContain('fix: claude login');
    expect(process.exitCode).toBe(1);
  });

  it('does not fail on a harness this machine never configured', async () => {
    // Which Harness a Run uses is content (NG-579), so an unconfigured one is
    // worth reporting and wrong to fail on.
    const lines = await run(['doctor'], {
      doctor: {
        ...HEALTHY_DOCTOR,
        checkHarness: (harness) =>
          Promise.resolve({ harness, ok: false, detail: 'not signed in' }),
      },
    });

    expect(lines.out.join('\n')).toContain('! harness claude-code');
    expect(process.exitCode).toBeUndefined();
  });
});

describe('`rocky stop`', () => {
  it('says plainly that nothing was running', async () => {
    const lines = await run(['stop']);

    expect(lines.out).toEqual(['No daemon is running.']);
    expect(process.exitCode).toBeUndefined();
  });

  it('clears a stale pidfile and says it did', async () => {
    await writePidFile(paths, {
      pid: 2 ** 22,
      host: '127.0.0.1',
      port: 7625,
      url: 'http://127.0.0.1:7625',
      version: '0.0.0',
      startedAt: new Date().toISOString(),
    });

    const lines = await run(['stop']);

    expect(lines.out.join('\n')).toContain('stale');
    expect(process.exitCode).toBeUndefined();
  });
});

describe('`rocky status`', () => {
  it('reports the stale pidfile it refused to obey', async () => {
    await writePidFile(paths, {
      pid: 2 ** 22,
      host: '127.0.0.1',
      port: 7625,
      url: 'http://127.0.0.1:7625',
      version: '0.0.0',
      startedAt: new Date().toISOString(),
    });

    const lines = await run(['status']);

    expect(lines.err.join('\n')).toContain('is not running');
    expect(process.exitCode).toBe(1);
  });
});

describe('the commands that need a daemon to be there', () => {
  /**
   * A real daemon, in this process. `daemon-control.spec.ts` covers the
   * detached case; what is left to cover here is what each command *prints*
   * once one is actually answering.
   */
  let daemon: DaemonProcess | undefined;

  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
  });

  const start = async () => {
    daemon = await runDaemon({
      paths,
      port: 0,
      webRoot: false,
      handleSignals: false,
    });
    return daemon;
  };

  it('`status` reports the version, address, pid and uptime', async () => {
    const running = await start();

    const lines = await run(['status']);

    expect(lines.out[0]).toContain(`is running on ${running.url}`);
    expect(lines.out[1]).toContain(`pid ${String(process.pid)}`);
    expect(process.exitCode).toBeUndefined();
  });

  it('`status` mentions a daemon built without the web shell', async () => {
    await start();

    expect((await run(['status'])).out.join('\n')).toContain(
      'The web UI is not built into this daemon.',
    );
  });

  it('`stop` ends it and says which pid it ended', async () => {
    await start();

    const lines = await run(['stop']);

    expect(lines.out[0]).toContain(
      `Rocky stopped (pid ${String(process.pid)})`,
    );
    await daemon?.stopped;
    daemon = undefined;
  });

  it('`start -d` refuses over a daemon that is already up', async () => {
    const running = await start();

    const lines = await run(['start', '-d']);

    expect(lines.err.join('\n')).toContain(`already running on ${running.url}`);
    expect(process.exitCode).toBe(1);
  });

  it('`restart` stops the old daemon before starting the new one', async () => {
    await start();
    let spawned = 0;

    const lines = await run(['restart'], {
      // The daemon it would spawn is `daemon-control.spec.ts`'s subject; here
      // the point is that the stop half ran first, and that a child which
      // never comes up is reported rather than waited on forever.
      spawn: (() => {
        spawned += 1;
        return { unref: () => undefined };
      }) as never,
      timeoutMs: 300,
      intervalMs: 50,
    });

    expect(spawned).toBe(1);
    expect(lines.err.join('\n')).toContain('did not come up');
    expect(process.exitCode).toBe(1);
    await daemon?.stopped;
    daemon = undefined;
  });
});

describe('`rocky logs`', () => {
  it('prints the log', async () => {
    await writeFile(paths.daemonLog, 'one\ntwo\n');

    expect((await run(['logs'])).out).toEqual(['one', 'two']);
  });

  it('prints nothing, and does not fail, before the daemon has ever run', async () => {
    const lines = await run(['logs']);

    expect(lines.out).toEqual([]);
    expect(process.exitCode).toBeUndefined();
  });

  it('honours -n', async () => {
    await writeFile(paths.daemonLog, 'one\ntwo\nthree\n');

    expect((await run(['logs', '-n', '1'])).out).toEqual(['three']);
  });

  it('follows until it is told to stop', async () => {
    await writeFile(paths.daemonLog, 'before\n');
    const until = Promise.resolve();

    const lines = await run(['logs', '-f'], { until });

    expect(lines.out).toEqual(['before']);
  });
});

describe('`rocky service`', () => {
  it('writes the unit and says how to load it', async () => {
    const lines = await run(['service', 'install'], { service: MAC() });

    expect(lines.out[0]).toContain(serviceTarget(MAC()).file);
    expect(lines.out[1]).toContain('launchctl load');
  });

  it('removes the unit it wrote', async () => {
    await run(['service', 'install'], { service: MAC() });

    const lines = await run(['service', 'uninstall'], { service: MAC() });

    expect(lines.out[0]).toContain('Removed');
  });

  it('says there was nothing to remove', async () => {
    const lines = await run(['service', 'uninstall'], { service: MAC() });

    expect(lines.out[0]).toContain('No unit at');
  });

  it('refuses on a platform v1 does not serve, and fails', async () => {
    const lines = await run(['service', 'install'], {
      service: { ...MAC(), platform: 'win32' },
    });

    expect(lines.err.join('\n')).toContain('supports macOS and Linux');
    expect(process.exitCode).toBe(1);
  });
});
