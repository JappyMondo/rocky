import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { parseInstanceConfig } from './schema.js';
import { newRepositoryProfile, parseRepositoryProfile } from './profiles.js';
import {
  resolveSourceControl,
  sourceControlEnv,
  sourceControlGitConfig,
  sourceControlToken,
} from './source-control.js';
import { git } from '../repos/git.js';
import { createRepoContext, createWorkspace } from '../repos/index.js';
import { rockyPaths } from './paths.js';
import { createUpstream, isolatedGitEnv } from '../repos/upstream.fixtures.js';

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function temp() {
  const root = await mkdtemp(join(tmpdir(), 'rocky-source-control-'));
  roots.push(root);
  return root;
}

it('preserves legacy defaults and accepts the same references globally and per profile', () => {
  expect(parseInstanceConfig({}).sourceControl).toBeUndefined();
  const sourceControl = {
    git: {
      sshKey: '~/.ssh/robot.pub',
      signCommits: false,
      signingFormat: 'ssh',
      signingKey: 'key::ssh-ed25519 AAAA',
    },
    github: { configDir: '~/.rocky/gh', tokenEnv: 'BOT_TOKEN' },
    gitlab: { tokenEnv: null },
  };
  expect(parseInstanceConfig({ sourceControl }).sourceControl).toEqual(
    sourceControl,
  );
  expect(
    parseRepositoryProfile({
      ...newRepositoryProfile({ id: 'bot', remote: 'github.com/org/repo' }),
      sourceControl,
    }).sourceControl,
  ).toEqual(sourceControl);
  for (const sourceControl of [
    { github: { token: 'secret' } },
    { github: { tokenEnv: 'raw-token!' } },
    { git: { sshKey: 'private\nkey' } },
    { git: { signCommits: 'false' } },
    { git: { email: 'invalid' } },
    { git: { signingFormat: 'unknown' } },
  ])
    expect(() => parseInstanceConfig({ sourceControl })).toThrow();
});

it('merges individual fields and preserves explicit false and null overrides', () => {
  const defaults = {
    git: { sshKey: '/default', sshAgent: '/agent', signCommits: true },
    github: { configDir: '/gh', tokenEnv: 'DEFAULT' },
  };
  expect(
    resolveSourceControl(defaults, {
      git: { sshKey: '/profile', signCommits: false },
      github: { tokenEnv: null },
    }),
  ).toEqual({
    git: { sshKey: '/profile', sshAgent: '/agent', signCommits: false },
    github: { configDir: '/gh', tokenEnv: null },
    gitlab: {},
  });
  expect(defaults.git.sshKey).toBe('/default');
  expect(resolveSourceControl()).toEqual({ git: {}, github: {}, gitlab: {} });
});

it('keeps the ambient environment untouched unless an override is selected', () => {
  const inherited = {
    SSH_AUTH_SOCK: '/personal',
    GIT_SSH_COMMAND: 'custom ssh',
    GH_TOKEN: 'personal',
  };
  expect(sourceControlEnv({}, inherited)).toEqual(inherited);
  const env = sourceControlEnv(
    {
      github: { configDir: '~/robot-gh' },
      gitlab: { tokenEnv: 'BOT' },
      git: {
        sshAgent: '~/agent with spaces',
        name: 'Robot',
        email: 'robot@example.test',
      },
    },
    {
      ...inherited,
      HOME: '/test',
      BOT: 'robot',
      OAUTH_TOKEN: 'personal',
      GH_HOST: 'other',
      GH_REPO: 'other/repo',
      GITLAB_HOST: 'other',
      GITLAB_REPO: 'other/repo',
      CI_JOB_TOKEN: 'personal',
    },
  );
  expect(env).toMatchObject({
    GH_CONFIG_DIR: '/test/robot-gh',
    GH_TOKEN: undefined,
    GH_HOST: undefined,
    GH_REPO: undefined,
    GITLAB_TOKEN: 'robot',
    OAUTH_TOKEN: undefined,
    CI_JOB_TOKEN: undefined,
    GITLAB_HOST: undefined,
    GITLAB_REPO: undefined,
    GLAB_ENABLE_CI_AUTOLOGIN: 'false',
    SSH_AUTH_SOCK: '/test/agent with spaces',
    GIT_AUTHOR_NAME: 'Robot',
    GIT_COMMITTER_EMAIL: 'robot@example.test',
  });
  expect(env.GIT_SSH_COMMAND).toContain(
    'IdentityAgent="/test/agent with spaces"',
  );
  expect(inherited.SSH_AUTH_SOCK).toBe('/personal');
  const tokens = sourceControlEnv(
    { github: { tokenEnv: 'GH_TOKEN' } },
    inherited,
  );
  expect(tokens.GH_TOKEN).toBe('personal');
  expect(() =>
    sourceControlEnv({ github: { tokenEnv: 'MISSING' } }, {}),
  ).toThrow('MISSING is not set');
});

it('overrides Git config through real subprocesses and preserves unrelated environment config', async () => {
  const env = sourceControlEnv(
    {
      git: {
        signingFormat: 'ssh',
        signingKey: '~/robot.pub',
        signCommits: false,
        signTags: true,
      },
    },
    {
      ...isolatedGitEnv(),
      HOME: '/test',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'custom.keep',
      GIT_CONFIG_VALUE_0: 'yes',
    },
  );
  for (const [key, expected] of Object.entries({
    'custom.keep': 'yes',
    'gpg.format': 'ssh',
    'gpg.ssh.program': 'ssh-keygen',
    'user.signingkey': '/test/robot.pub',
    'commit.gpgsign': 'false',
    'tag.gpgsign': 'true',
  }))
    expect((await git(['config', '--get', key], { env })).stdout).toBe(
      expected,
    );
  expect(() =>
    sourceControlEnv({ git: { name: 'Bot' } }, { GIT_CONFIG_COUNT: '-1' }),
  ).toThrow('GIT_CONFIG_COUNT');
});

it('quotes SSH key paths literally and selects the agent even over personal SSH config', async () => {
  const root = await temp();
  const file = join(root, "key ' $(touch injected).pub");
  await writeFile(file, 'fixture');
  const sshConfig = join(root, 'ssh_config');
  await writeFile(sshConfig, 'Host *\n IdentityAgent /personal/socket\n');
  const env = sourceControlEnv(
    { git: { sshKey: file, sshAgent: join(root, 'agent socket') } },
    process.env,
  );
  const { stdout } = await exec(
    '/bin/sh',
    [
      '-c',
      `${env.GIT_SSH_COMMAND} -G -F "$1" example.test`,
      'ssh-test',
      sshConfig,
    ],
    { env, cwd: root },
  );
  expect(stdout).toContain(`identityfile ${file}`);
  expect(stdout).toContain('identitiesonly yes');
  expect(stdout).toContain(`identityagent ${join(root, 'agent socket')}`);
  await expect(readFile(join(root, 'injected'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  expect(() => sourceControlEnv({ git: { sshKey: 'relative/key' } })).toThrow(
    'absolute',
  );
  expect(() =>
    sourceControlEnv({ git: { sshAgent: '${MISSING}/socket' } }, {}),
  ).toThrow('MISSING');
  expect(() =>
    sourceControlEnv({ git: { sshAgent: '${SOCK}' } }, { SOCK: '/bad\npath' }),
  ).toThrow('Invalid');
});

it('supports GPG program overrides and refuses a program without a format', () => {
  expect(
    sourceControlGitConfig({
      git: {
        signingFormat: 'openpgp',
        signingKey: 'ABCD',
        signingProgram: '/usr/bin/gpg',
      },
    }),
  ).toEqual({
    'gpg.format': 'openpgp',
    'user.signingkey': 'ABCD',
    'gpg.openpgp.program': '/usr/bin/gpg',
  });
  expect(() =>
    sourceControlGitConfig({ git: { signingProgram: '/gpg' } }),
  ).toThrow('signingFormat');
});

it('signs a real commit with a public key held only in a dedicated SSH agent', async () => {
  const root = await temp();
  const key = join(root, 'signing-key');
  const socket = join(root, 'agent.sock');
  await exec('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]);
  const { stdout } = await exec('ssh-agent', ['-s', '-a', socket]);
  const pid = Number(/SSH_AGENT_PID=(\d+)/.exec(stdout)?.[1]);
  expect(pid).toBeGreaterThan(0);
  try {
    await exec('ssh-add', [key], {
      env: { ...process.env, SSH_AUTH_SOCK: socket },
    });
    await rm(key);
    const env = sourceControlEnv(
      {
        git: {
          name: 'Signing Bot',
          email: 'bot@example.test',
          sshAgent: socket,
          signingFormat: 'ssh',
          signingKey: `${key}.pub`,
          signCommits: true,
        },
      },
      isolatedGitEnv(),
    );
    await git(['init', '-q', root], { env });
    await git(['commit', '--allow-empty', '-m', 'agent-signed'], {
      cwd: root,
      env,
    });
    const commit = (await git(['cat-file', '-p', 'HEAD'], { cwd: root, env }))
      .stdout;
    expect(commit).toContain('author Signing Bot <bot@example.test>');
    expect(commit).toContain('gpgsig -----BEGIN SSH SIGNATURE-----');
    await writeFile(
      join(root, 'allowed'),
      `bot@example.test ${await readFile(`${key}.pub`, 'utf8')}`,
    );
    await expect(
      git(
        [
          '-c',
          `gpg.ssh.allowedSignersFile=${join(root, 'allowed')}`,
          'verify-commit',
          'HEAD',
        ],
        { cwd: root, env },
      ),
    ).resolves.toMatchObject({
      stderr: expect.stringContaining('Good "git" signature'),
    });
  } finally {
    process.kill(pid, 'SIGTERM');
  }
});

it('isolates simultaneous profiles sharing one clone without changing shared Git config', async () => {
  const root = await temp();
  const upstream = await createUpstream();
  roots.push(upstream.dir, upstream.workingCopy);
  const context = createRepoContext({
    paths: rockyPaths(root),
    identity: { name: 'Default', email: 'default@example.test' },
  });
  const workspaces = await Promise.all(
    ['alpha', 'beta'].map((name) => {
      const settings = {
        git: {
          name,
          email: `${name}@example.test`,
          signingKey: `/${name}.pub`,
          signCommits: false,
        },
      };
      return createWorkspace(
        {
          ...context,
          sourceControl: settings,
          env: sourceControlEnv(settings, isolatedGitEnv()),
        },
        {
          runId: name,
          branch: name,
          lead: 'repo',
          members: [{ name: 'repo', url: upstream.url, baseBranch: 'main' }],
        },
      );
    }),
  );
  for (const [index, name] of ['alpha', 'beta'].entries()) {
    const cwd = workspaces[index].lead.dir;
    expect(
      (await git(['config', '--worktree', 'user.name'], { cwd })).stdout,
    ).toBe(name);
    expect(
      (await git(['config', '--worktree', 'user.signingkey'], { cwd })).stdout,
    ).toBe(`/${name}.pub`);
  }
  await expect(
    git(['config', '--local', '--get', 'user.signingkey'], {
      cwd: context.paths.repo('repo'),
    }),
  ).rejects.toThrow();
});

it('uses native token precedence and supports both CLI credential stores without logging tokens', async () => {
  expect(
    await sourceControlToken('github', {
      GH_TOKEN: 'gh',
      GITHUB_TOKEN: 'github',
    }),
  ).toBe('gh');
  expect(await sourceControlToken('github', { GITHUB_TOKEN: 'github' })).toBe(
    'github',
  );
  expect(
    await sourceControlToken('gitlab', { GITLAB_ACCESS_TOKEN: 'gitlab' }),
  ).toBe('gitlab');
  expect(await sourceControlToken('gitlab', { OAUTH_TOKEN: 'oauth' })).toBe(
    'oauth',
  );
  const root = await temp();
  for (const command of ['gh', 'glab'])
    await writeFile(
      join(root, command),
      '#!/bin/sh\n[ "$1" = "auth" ] && printf "%s" "$GH_CONFIG_DIR"\n[ "$1" = "config" ] && printf "%s" "$GLAB_CONFIG_DIR"\nexit 0\n',
      { mode: 0o755 },
    );
  expect(
    await sourceControlToken('github', {
      PATH: root,
      GH_CONFIG_DIR: 'github-store',
    }),
  ).toBe('github-store');
  expect(
    await sourceControlToken('gitlab', {
      PATH: root,
      GLAB_CONFIG_DIR: 'gitlab-store',
    }),
  ).toBe('gitlab-store');
  await expect(sourceControlToken('github', { PATH: root })).rejects.toThrow(
    'No github credential',
  );
  await writeFile(
    join(root, 'gh'),
    '#!/bin/sh\necho SECRET_TOKEN\necho SECRET_TOKEN >&2\nexit 1\n',
    { mode: 0o755 },
  );
  await expect(sourceControlToken('github', { PATH: root })).rejects.toThrow(
    /^No github credential/,
  );
  await expect(
    sourceControlToken('gitlab', { PATH: '/missing' }),
  ).rejects.toThrow('No gitlab credential');
  await expect(
    sourceControlToken('github', { PATH: root }, { allowCli: false }),
  ).rejects.toThrow('No github credential');
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  await expect(
    sourceControlToken('github', { PATH: root }, { signal: controller.signal }),
  ).rejects.toThrow('cancelled');
});

it('expands signing key references and allows an explicit ambient signing helper', () => {
  expect(
    sourceControlGitConfig(
      {
        git: {
          signingKey: '${SIGNING_KEY}',
          signingFormat: 'ssh',
          signingProgram: null,
        },
      },
      { SIGNING_KEY: '~/key.pub', HOME: '/robot' },
    ),
  ).toEqual({
    'gpg.format': 'ssh',
    'user.signingkey': '/robot/key.pub',
  });
});
