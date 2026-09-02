/**
 * `rocky service install|uninstall` (NG-595): a launchd or systemd **user**
 * unit, so the daemon survives a reboot.
 *
 * User-level on both platforms, never system-level. Rocky runs *as you* — it
 * inherits your harness logins, your SSH agent and your git credentials — so a
 * root unit would be a daemon that could not do the job. It also means no
 * `sudo` in the install path.
 *
 * NG-578 ruled out pm2, and Windows is explicitly not v1.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type { RockyPaths } from '@rocky/daemon';

export type ServicePlatform = 'darwin' | 'linux';

/** The reverse-DNS label launchd wants, and the name systemd gets too. */
export const SERVICE_LABEL = 'com.digimondo.rocky';

export interface ServiceTarget {
  platform: ServicePlatform;
  /** Where the unit file goes. */
  file: string;
  /** What to run to load it now, rather than at the next login. */
  loadHint: string;
  unloadHint: string;
}

export interface ServiceEnvironment {
  platform?: NodeJS.Platform;
  home?: string;
  /** The `rocky` entry point the unit runs. */
  entry?: string;
  /** The node binary the unit runs it with. */
  execPath?: string;
}

export class UnsupportedPlatformError extends Error {
  constructor(readonly platform: NodeJS.Platform) {
    super(
      `\`rocky service\` supports macOS and Linux; this is ${platform}. Run \`rocky start -d\` at login instead — NG-578 left a Windows service out of v1 deliberately.`,
    );
    this.name = 'UnsupportedPlatformError';
  }
}

export function serviceTarget(
  environment: ServiceEnvironment = {},
): ServiceTarget {
  const platform = environment.platform ?? process.platform;
  const home = environment.home ?? homedir();

  if (platform === 'darwin') {
    const file = join(
      home,
      'Library',
      'LaunchAgents',
      `${SERVICE_LABEL}.plist`,
    );
    return {
      platform: 'darwin',
      file,
      loadHint: `launchctl load -w ${file}`,
      unloadHint: `launchctl unload -w ${file}`,
    };
  }

  if (platform === 'linux') {
    const file = join(home, '.config', 'systemd', 'user', 'rocky.service');
    return {
      platform: 'linux',
      file,
      loadHint:
        'systemctl --user daemon-reload && systemctl --user enable --now rocky',
      unloadHint: 'systemctl --user disable --now rocky',
    };
  }

  throw new UnsupportedPlatformError(platform);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * `rocky start` in the foreground, not `-d`: the service manager *is* the
 * thing that backgrounds it, and a unit whose process forks and exits looks
 * to launchd and systemd like a service that keeps crashing.
 */
export function unitFor(
  paths: RockyPaths,
  environment: ServiceEnvironment = {},
): string {
  const target = serviceTarget(environment);
  const execPath = environment.execPath ?? process.execPath;
  const entry = environment.entry ?? process.argv[1];

  if (target.platform === 'darwin') {
    const args = [execPath, entry, 'start']
      .map((value) => `    <string>${escapeXml(value)}</string>`)
      .join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <!-- The daemon writes its own rotated log; these catch anything that dies
       before logging is up. -->
  <key>StandardOutPath</key>
  <string>${escapeXml(join(paths.logsDir, 'launchd.out.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(join(paths.logsDir, 'launchd.err.log'))}</string>
</dict>
</plist>
`;
  }

  return `[Unit]
Description=Rocky — the per-developer local daemon
Documentation=https://github.com/JappyMondo/rocky
After=network-online.target

[Service]
Type=simple
ExecStart=${execPath} ${entry} start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

export interface InstallResult {
  target: ServiceTarget;
  /** False when the file on disk already said exactly this. */
  changed: boolean;
}

export async function installService(
  paths: RockyPaths,
  environment: ServiceEnvironment = {},
): Promise<InstallResult> {
  const target = serviceTarget(environment);
  const unit = unitFor(paths, environment);

  const existing = await readFile(target.file, 'utf8').catch(() => undefined);
  if (existing === unit) {
    return { target, changed: false };
  }

  await mkdir(dirname(target.file), { recursive: true });
  await writeFile(target.file, unit);

  return { target, changed: true };
}

export interface UninstallResult {
  target: ServiceTarget;
  /** False when there was no unit to remove. */
  removed: boolean;
}

export async function uninstallService(
  environment: ServiceEnvironment = {},
): Promise<UninstallResult> {
  const target = serviceTarget(environment);
  const existed =
    (await readFile(target.file, 'utf8').catch(() => undefined)) !== undefined;

  await rm(target.file, { force: true });

  return { target, removed: existed };
}
