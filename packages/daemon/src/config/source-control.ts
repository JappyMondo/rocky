import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import type { SourceControlSettings } from '@rocky/local-contracts';
import { expandVars } from './expand.js';

export { sourceControlSchema } from './source-control-schema.js';

/** Omitted leaves inherit; null deliberately cancels a Rocky-wide override. */
export function resolveSourceControl(
  defaults: SourceControlSettings = {},
  profile: SourceControlSettings = {},
): SourceControlSettings {
  return {
    git: { ...defaults.git, ...profile.git },
    github: { ...defaults.github, ...profile.github },
    gitlab: { ...defaults.gitlab, ...profile.gitlab },
  };
}

function path(value: string, env: NodeJS.ProcessEnv): string {
  const expanded = expandVars(value, env, 'sourceControl');
  const result = expanded.startsWith('~/')
    ? join(env.HOME ?? homedir(), expanded.slice(2))
    : expanded;
  if (!isAbsolute(result))
    throw new Error('sourceControl paths must be absolute or start with ~/');
  if (/[\r\n\0]/.test(result)) throw new Error('Invalid sourceControl path');
  return result;
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** No shell expansion or global/shared Git config writes. */
export function sourceControlGitConfig(
  settings: SourceControlSettings,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const git = settings.git ?? {};
  const config: Record<string, string> = {};
  if (git.name) config['user.name'] = git.name;
  if (git.email) config['user.email'] = git.email;
  if (git.signingFormat) config['gpg.format'] = git.signingFormat;
  if (git.signingKey) {
    const key = expandVars(git.signingKey, env, 'sourceControl.git.signingKey');
    config['user.signingkey'] = key.startsWith('~/') ? path(key, env) : key;
  }
  if (git.signingProgram) {
    if (!git.signingFormat)
      throw new Error(
        'Set sourceControl.git.signingFormat with signingProgram.',
      );
    config[`gpg.${git.signingFormat}.program`] = path(git.signingProgram, env);
  } else if (git.signingFormat === 'ssh' && git.signingProgram !== null) {
    // A personal signing helper (e.g. 1Password) must not bypass the chosen agent.
    config['gpg.ssh.program'] = 'ssh-keygen';
  }
  if (git.signCommits != null)
    config['commit.gpgsign'] = String(git.signCommits);
  if (git.signTags != null) config['tag.gpgsign'] = String(git.signTags);
  if (git.sshKey || git.sshAgent) {
    const args = ['ssh', '-o', 'BatchMode=yes'];
    if (git.sshKey)
      args.push('-o', 'IdentitiesOnly=yes', '-i', path(git.sshKey, env));
    // IdentityAgent in ~/.ssh/config otherwise wins over SSH_AUTH_SOCK.
    // Passing the variable name also handles socket paths containing spaces.
    if (git.sshAgent)
      args.push(
        '-o',
        `IdentityAgent="${path(git.sshAgent, env).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`,
      );
    config['core.sshCommand'] = args.map(quote).join(' ');
  }
  return config;
}

const tokenVariables = {
  github: [
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'GH_ENTERPRISE_TOKEN',
    'GITHUB_ENTERPRISE_TOKEN',
  ],
  gitlab: [
    'GITLAB_TOKEN',
    'GITLAB_ACCESS_TOKEN',
    'OAUTH_TOKEN',
    'CI_JOB_TOKEN',
  ],
};

/** A new environment per invocation; undefined explicitly removes inherited values. */
export function sourceControlEnv(
  settings: SourceControlSettings = {},
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...inherited };
  const config = sourceControlGitConfig(settings, inherited);
  if (settings.git?.sshAgent)
    env.SSH_AUTH_SOCK = path(settings.git.sshAgent, inherited);
  if (config['core.sshCommand']) {
    env.GIT_SSH_COMMAND = config['core.sshCommand'];
    env.GIT_SSH_VARIANT = 'ssh';
  }
  for (const [field, suffix] of [
    ['name', 'NAME'],
    ['email', 'EMAIL'],
  ] as const) {
    const value = settings.git?.[field];
    if (value) {
      env[`GIT_AUTHOR_${suffix}`] = value;
      env[`GIT_COMMITTER_${suffix}`] = value;
    }
  }
  // Environment config follows local/worktree config and is inherited by agent shells.
  const entries = Object.entries(config);
  if (entries.length) {
    const count = Number(env.GIT_CONFIG_COUNT ?? 0);
    if (!Number.isSafeInteger(count) || count < 0)
      throw new Error('GIT_CONFIG_COUNT must be a nonnegative integer.');
    for (const [index, [key, value]] of entries.entries()) {
      env[`GIT_CONFIG_KEY_${count + index}`] = key;
      env[`GIT_CONFIG_VALUE_${count + index}`] = value;
    }
    env.GIT_CONFIG_COUNT = String(count + entries.length);
  }
  for (const platform of ['github', 'gitlab'] as const) {
    const cli = settings[platform];
    if (!cli?.configDir && !cli?.tokenEnv) continue;
    for (const name of tokenVariables[platform]) env[name] = undefined;
    if (platform === 'github') {
      env.GH_HOST = undefined;
      env.GH_REPO = undefined;
    } else {
      env.GLAB_ENABLE_CI_AUTOLOGIN = 'false';
      env.GITLAB_HOST = undefined;
      env.GITLAB_REPO = undefined;
    }
    if (cli.configDir)
      env[platform === 'github' ? 'GH_CONFIG_DIR' : 'GLAB_CONFIG_DIR'] = path(
        cli.configDir,
        inherited,
      );
    if (cli.tokenEnv) {
      const token = inherited[cli.tokenEnv];
      if (!token?.trim())
        throw new Error(
          `sourceControl.${platform}.tokenEnv: ${cli.tokenEnv} is not set.`,
        );
      env[platform === 'github' ? 'GH_TOKEN' : 'GITLAB_TOKEN'] = token;
    }
  }
  return env;
}

const execute = promisify(execFile);

/** Native CLI credential lookup stays in memory and never enters a journal/error. */
export async function sourceControlToken(
  platform: 'github' | 'gitlab',
  env: NodeJS.ProcessEnv,
  options: { signal?: AbortSignal; cwd?: string; allowCli?: boolean } = {},
): Promise<string> {
  const token =
    platform === 'github'
      ? env.GH_TOKEN || env.GITHUB_TOKEN
      : env.GITLAB_TOKEN || env.GITLAB_ACCESS_TOKEN || env.OAUTH_TOKEN;
  if (token) return token;
  const command = platform === 'github' ? 'gh' : 'glab';
  const args =
    platform === 'github'
      ? ['auth', 'token', '--hostname', 'github.com']
      : ['config', 'get', 'token', '--host', 'gitlab.com'];
  try {
    const processOptions = {
      signal: options.signal,
      cwd: options.cwd,
      env,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    };
    if (options.allowCli === false) throw new Error('CLI lookup not selected');
    // Native glab refreshes OAuth credentials during an API call, not config get.
    if (platform === 'gitlab')
      await execute(
        command,
        ['api', 'user', '--hostname', 'gitlab.com', '--silent'],
        processOptions,
      );
    const { stdout } = await execute(command, args, processOptions);
    if (stdout.trim()) return stdout.trim();
  } catch {
    options.signal?.throwIfAborted();
    // CLI error objects can contain credential stdout/stderr. Never rethrow them.
  }
  throw new Error(
    `No ${platform} credential available. Sign in with ${command} using the configured CLI directory, or set sourceControl.${platform}.tokenEnv.`,
  );
}
