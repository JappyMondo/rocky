/**
 * AC3: "`rocky service install` produces a working unit on the current
 * platform and `uninstall` removes it."
 *
 * "Working" is asserted as far as a test honestly can: the unit lands where
 * the platform's service manager looks for it, and its contents are the shape
 * launchd and systemd actually accept. Whether launchd then boots it is not
 * something a unit test can claim.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { rockyPaths, type RockyPaths } from '@rocky/daemon';

import {
  SERVICE_LABEL,
  installService,
  serviceTarget,
  uninstallService,
  unitFor,
  UnsupportedPlatformError,
} from './service.js';

let home: string;
let root: string;
let paths: RockyPaths;

const MAC = () => ({
  platform: 'darwin' as const,
  home,
  entry: '/usr/local/lib/rocky/main.js',
  execPath: '/usr/local/bin/node',
});
const LINUX = () => ({ ...MAC(), platform: 'linux' as const });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'rocky-home-'));
  root = mkdtempSync(join(tmpdir(), 'rocky-svc-'));
  paths = rockyPaths(root);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe('where the unit goes', () => {
  it('is the per-user LaunchAgents directory on macOS', () => {
    expect(serviceTarget(MAC()).file).toBe(
      join(home, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`),
    );
  });

  it('is the per-user systemd directory on Linux', () => {
    expect(serviceTarget(LINUX()).file).toBe(
      join(home, '.config', 'systemd', 'user', 'rocky.service'),
    );
  });

  it('is never system-level on either', () => {
    // Rocky runs as you — it inherits your harness logins, your SSH agent and
    // your git credentials. A root unit would be a daemon that cannot work.
    for (const environment of [MAC(), LINUX()]) {
      expect(serviceTarget(environment).file.startsWith(home)).toBe(true);
    }
  });

  it('refuses a platform v1 does not serve, naming what to do instead', () => {
    expect(() => serviceTarget({ ...MAC(), platform: 'win32' })).toThrow(
      UnsupportedPlatformError,
    );
    expect(() => serviceTarget({ ...MAC(), platform: 'win32' })).toThrow(
      /rocky start -d/,
    );
  });
});

describe('the launchd unit', () => {
  it('is a plist launchd will parse', () => {
    const unit = unitFor(paths, MAC());

    expect(unit).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(unit).toContain('<!DOCTYPE plist PUBLIC');
    expect(unit).toContain(`<string>${SERVICE_LABEL}</string>`);
  });

  it('runs the daemon in the foreground, not with -d', () => {
    // launchd is the thing that backgrounds it. A unit whose process forks and
    // exits looks to launchd like a service that keeps crashing.
    const unit = unitFor(paths, MAC());

    expect(unit).toContain('<string>start</string>');
    // Asserted against the argument list rather than the whole file, which
    // carries paths a `-d` could appear inside by accident.
    expect(unit).not.toContain('<string>-d</string>');
    expect(unit).not.toContain('<string>--detach</string>');
  });

  it('names the node binary and the entry point it was installed with', () => {
    const unit = unitFor(paths, MAC());

    expect(unit).toContain('<string>/usr/local/bin/node</string>');
    expect(unit).toContain('<string>/usr/local/lib/rocky/main.js</string>');
  });

  it('comes back after a reboot and after a crash', () => {
    const unit = unitFor(paths, MAC());

    expect(unit).toContain('<key>RunAtLoad</key>');
    expect(unit).toContain('<key>KeepAlive</key>');
  });

  it('escapes a path that would otherwise break the XML', () => {
    const unit = unitFor(paths, {
      ...MAC(),
      entry: '/opt/rocky & co/main.js',
    });

    expect(unit).toContain('/opt/rocky &amp; co/main.js');
    expect(unit).not.toContain('/opt/rocky & co/main.js');
  });
});

describe('the systemd unit', () => {
  it('is a unit file systemd will parse', () => {
    const unit = unitFor(paths, LINUX());

    expect(unit).toContain('[Unit]');
    expect(unit).toContain('[Service]');
    expect(unit).toContain('[Install]');
  });

  it('runs the daemon in the foreground, which is what Type=simple means', () => {
    const unit = unitFor(paths, LINUX());

    expect(unit).toContain('Type=simple');
    expect(unit).toContain(
      'ExecStart=/usr/local/bin/node /usr/local/lib/rocky/main.js start',
    );
  });

  it('installs into the user target, not a system one', () => {
    expect(unitFor(paths, LINUX())).toContain('WantedBy=default.target');
  });

  it('comes back after a crash', () => {
    expect(unitFor(paths, LINUX())).toContain('Restart=on-failure');
  });
});

describe('installing', () => {
  it('writes the unit, creating the directory it belongs in', async () => {
    const { target, changed } = await installService(paths, MAC());

    expect(changed).toBe(true);
    expect(await readFile(target.file, 'utf8')).toBe(unitFor(paths, MAC()));
  });

  it('tells the developer how to load it without waiting for a reboot', async () => {
    const { target } = await installService(paths, MAC());

    expect(target.loadHint).toContain('launchctl load');
    expect(target.loadHint).toContain(target.file);
  });

  it('says so rather than rewriting when the unit is already right', async () => {
    await installService(paths, MAC());

    expect((await installService(paths, MAC())).changed).toBe(false);
  });

  it('overwrites a unit left by an older install', async () => {
    const { file } = serviceTarget(MAC());
    await mkdir(join(home, 'Library', 'LaunchAgents'), { recursive: true });
    await writeFile(file, '<plist>something older</plist>');

    const { changed } = await installService(paths, MAC());

    expect(changed).toBe(true);
    expect(await readFile(file, 'utf8')).toContain(SERVICE_LABEL);
  });

  it('refuses on a platform v1 does not serve', async () => {
    await expect(
      installService(paths, { ...MAC(), platform: 'win32' }),
    ).rejects.toThrow(UnsupportedPlatformError);
  });
});

describe('uninstalling', () => {
  it('removes the unit it finds', async () => {
    await installService(paths, MAC());

    const { target, removed } = await uninstallService(MAC());

    expect(removed).toBe(true);
    await expect(readFile(target.file, 'utf8')).rejects.toThrow();
  });

  it('is quiet, not an error, when there is nothing installed', async () => {
    expect((await uninstallService(MAC())).removed).toBe(false);
  });

  it('tells the developer how to unload one still running', async () => {
    await installService(paths, LINUX());

    expect((await uninstallService(LINUX())).target.unloadHint).toContain(
      'systemctl --user disable --now rocky',
    );
  });
});
