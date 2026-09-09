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
import { execFile as execFileCallback } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { readInstanceConfig, type RockyPaths } from '@rocky/daemon';

export type ServicePlatform = 'darwin' | 'linux';

/** The reverse-DNS label launchd wants, and the name systemd gets too. */
export const SERVICE_LABEL = 'com.digimondo.rocky';
export const INGRESS_SERVICE_LABEL = 'com.digimondo.rocky.ingress';

export type ServiceKind = 'daemon' | 'ingress';

// A service unit must describe Rocky itself, not whichever test runner or
// package-manager wrapper happened to invoke the CLI. `process.argv[1]` is a
// Vitest worker during tests and previously produced permanently broken user
// launchd units when that context leaked into an install.
const serviceModule = fileURLToPath(import.meta.url);
const serviceDirectory = dirname(serviceModule);
const SHIPPED_ENTRY = join(
  existsSync(join(serviceDirectory, 'main.js'))
    ? serviceDirectory
    : existsSync(join(serviceDirectory, '../dist/main.js'))
      ? join(serviceDirectory, '../dist')
      : serviceDirectory,
  existsSync(join(serviceDirectory, 'main.js')) ||
    existsSync(join(serviceDirectory, '../dist/main.js'))
    ? 'main.js'
    : 'main.ts',
);

export interface ServiceTarget {
  platform: ServicePlatform;
  /** Where the unit file goes. */
  file: string;
  /** What to run to load it now, rather than at the next login. */
  loadHint: string;
  unloadHint: string;
  name: string;
  loadCommand: readonly [string, ...string[]][];
  unloadCommand: readonly [string, ...string[]][];
}

export interface ServiceEnvironment {
  platform?: NodeJS.Platform;
  home?: string;
  /** The `rocky` entry point the unit runs. */
  entry?: string;
  /** The `rocky-ingress` entry point the ingress unit runs. */
  ingressEntry?: string;
  /** The node binary the unit runs it with. */
  execPath?: string;
  /**
   * SSH agent socket to make available to the user service. This must be
   * copied from the interactive installer environment: launchd's default
   * socket is often different (for example when Bitwarden owns the agent).
   */
  sshAuthSock?: string;
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
  kind: ServiceKind = 'daemon',
): ServiceTarget {
  const platform = environment.platform ?? process.platform;
  const home = environment.home ?? homedir();

  if (platform === 'darwin') {
    const label = kind === 'daemon' ? SERVICE_LABEL : INGRESS_SERVICE_LABEL;
    const file = join(home, 'Library', 'LaunchAgents', `${label}.plist`);
    return {
      platform: 'darwin',
      file,
      loadHint: `launchctl load -w ${file}`,
      unloadHint: `launchctl unload -w ${file}`,
      name: label,
      loadCommand: [['launchctl', 'load', '-w', file]],
      unloadCommand: [['launchctl', 'unload', '-w', file]],
    };
  }

  if (platform === 'linux') {
    const name = kind === 'daemon' ? 'rocky' : 'rocky-ingress';
    const file = join(home, '.config', 'systemd', 'user', `${name}.service`);
    return {
      platform: 'linux',
      file,
      loadHint: `systemctl --user daemon-reload && systemctl --user enable --now ${name}`,
      unloadHint: `systemctl --user disable --now ${name}`,
      name,
      loadCommand: [
        ['systemctl', '--user', 'daemon-reload'],
        ['systemctl', '--user', 'enable', '--now', name],
      ],
      unloadCommand: [['systemctl', '--user', 'disable', '--now', name]],
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
  kind: ServiceKind = 'daemon',
  daemonPort = 7625,
): string {
  const target = serviceTarget(environment, kind);
  const execPath = environment.execPath ?? process.execPath;
  const entry = environment.entry ?? SHIPPED_ENTRY;
  const ingressEntry =
    environment.ingressEntry ??
    join(
      dirname(entry),
      basename(entry) === 'rocky' ? 'rocky-ingress' : 'ingress-main.js',
    );
  const command =
    kind === 'daemon'
      ? [execPath, entry, 'start']
      : [execPath, ingressEntry, '--daemon-port', String(daemonPort)];
  const sshAuthSock = environment.sshAuthSock ?? process.env.SSH_AUTH_SOCK;

  if (target.platform === 'darwin') {
    const args = command
      .map((value) => `    <string>${escapeXml(value)}</string>`)
      .join('\n');
    const environmentVariables =
      sshAuthSock === undefined
        ? ''
        : `  <key>EnvironmentVariables</key>
  <dict>
    <key>SSH_AUTH_SOCK</key>
    <string>${escapeXml(sshAuthSock)}</string>
  </dict>
`;

    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${target.name}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
${environmentVariables}
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

  const after =
    kind === 'daemon'
      ? 'network-online.target'
      : 'rocky.service network-online.target';
  const requires = kind === 'daemon' ? '' : 'Requires=rocky.service\n';
  const description =
    kind === 'daemon'
      ? 'Rocky — the per-developer local daemon'
      : 'Rocky — the public Linear ingress filter';
  const serviceEnvironment =
    sshAuthSock === undefined
      ? ''
      : `Environment=SSH_AUTH_SOCK=${JSON.stringify(sshAuthSock)}\n`;
  return `[Unit]
Description=${description}
Documentation=https://github.com/JappyMondo/rocky
After=${after}
${requires}

[Service]
Type=simple
ExecStart=${command.join(' ')}
${serviceEnvironment}Restart=on-failure
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
  kind: ServiceKind = 'daemon',
  daemonPort = 7625,
): Promise<InstallResult> {
  const target = serviceTarget(environment, kind);
  const unit = unitFor(paths, environment, kind, daemonPort);

  const existing = await readFile(target.file, 'utf8').catch(() => undefined);
  if (existing === unit) {
    return { target, changed: false };
  }

  await mkdir(dirname(target.file), { recursive: true });
  await writeFile(target.file, unit);

  return { target, changed: true };
}

export interface ManagedServicesResult {
  daemon: InstallResult;
  ingress: InstallResult;
}

/** Write the two cooperating user services. The ingress is deliberately a
 * separate process: it is the only thing a tunnel may reach. */
export async function installManagedServices(
  paths: RockyPaths,
  environment: ServiceEnvironment = {},
): Promise<ManagedServicesResult> {
  const config = await readInstanceConfig(paths);
  const daemonPort = config.server.port;
  const [daemon, ingress] = await Promise.all([
    installService(paths, environment, 'daemon', daemonPort),
    installService(paths, environment, 'ingress', daemonPort),
  ]);
  return { daemon, ingress };
}

const execFile = promisify(execFileCallback);

/** Load (or unload) a user unit now. This is intentionally part of Rocky, so
 * setup never leaves a person with a command to paste into a second terminal. */
export async function runServiceCommands(
  commands: readonly (readonly [string, ...string[]])[],
): Promise<void> {
  for (const [command, ...args] of commands) {
    await execFile(command, args);
  }
}

export async function loadManagedServices(
  services: ManagedServicesResult,
  run = runServiceCommands,
): Promise<void> {
  // launchd remembers the old ProgramArguments even after its plist changes.
  // Unloading first makes `rocky service install` an actual update, not merely
  // a file write. Missing jobs are normal on a first install.
  for (const service of [services.daemon, services.ingress]) {
    if (service.target.platform === 'darwin') {
      await run(service.target.unloadCommand).catch(() => undefined);
    }
    // The daemon must be present before the ingress begins forwarding requests.
    await run(service.target.loadCommand);
  }
}

export interface UninstallResult {
  target: ServiceTarget;
  /** False when there was no unit to remove. */
  removed: boolean;
}

export async function serviceIsInstalled(
  environment: ServiceEnvironment = {},
  kind: ServiceKind = 'daemon',
): Promise<boolean> {
  const target = serviceTarget(environment, kind);
  return (
    (await readFile(target.file, 'utf8').catch(() => undefined)) !== undefined
  );
}

export async function uninstallService(
  environment: ServiceEnvironment = {},
  kind: ServiceKind = 'daemon',
): Promise<UninstallResult> {
  const target = serviceTarget(environment, kind);
  const existed =
    (await readFile(target.file, 'utf8').catch(() => undefined)) !== undefined;

  await rm(target.file, { force: true });

  return { target, removed: existed };
}
