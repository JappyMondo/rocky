import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  newRepositoryProfile,
  readInstanceConfig,
  rockyPaths,
  writeCredentials,
  writeInstanceConfig,
  writeRepositoryProfile,
} from '@rocky/daemon';
import { buildCli } from './cli.js';

const roots: string[] = [];
const originalExitCode = process.exitCode;
afterEach(async () => {
  process.exitCode = originalExitCode;
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'rocky-exec-'));
  roots.push(root);
  const paths = rockyPaths(root);
  const err = vi.fn();
  const run = (...args: string[]) =>
    buildCli({ out: vi.fn(), err }, { paths }).parseAsync(['exec', ...args], {
      from: 'user',
    });
  await writeInstanceConfig(paths, {
    sourceControl: { github: { configDir: join(root, 'gh') } },
  });
  return { root, paths, err, run };
}

it('passes command flags and arguments literally with an isolated GitHub CLI directory', async () => {
  const f = await fixture();
  vi.stubEnv('GH_TOKEN', 'personal-token');
  const output = join(f.root, 'output.json');
  await f.run(
    '--',
    process.execPath,
    '-e',
    'require("fs").writeFileSync(process.argv[1], JSON.stringify({ dir: process.env.GH_CONFIG_DIR, token: process.env.GH_TOKEN, name: process.env.GIT_AUTHOR_NAME, arg: process.argv[2] }))',
    output,
    'literal $(false)',
  );
  expect(f.err).not.toHaveBeenCalled();
  expect(JSON.parse(await readFile(output, 'utf8'))).toEqual({
    dir: join(f.root, 'gh'),
    name: 'Rocky',
    arg: 'literal $(false)',
  });
  expect(process.env.GH_TOKEN).toBe('personal-token');
  expect(process.exitCode).toBe(0);
});

it('resolves profile overrides and stored token references without altering saved defaults', async () => {
  const f = await fixture();
  const saved = await readInstanceConfig(f.paths);
  await writeRepositoryProfile(f.paths, {
    ...newRepositoryProfile({
      id: 'bot',
      repos: [
        {
          name: 'repo',
          url: 'git@github.com:org/repo.git',
          baseBranch: 'main',
        },
      ],
    }),
    sourceControl: {
      git: { name: 'Profile Bot' },
      github: { configDir: null, tokenEnv: 'BOT_TOKEN' },
    },
  });
  await writeCredentials(f.paths, {
    repos: { repo: { BOT_TOKEN: 'profile-token' } },
  });
  const output = join(f.root, 'profile.json');
  await f.run(
    '--profile',
    'bot',
    '--',
    process.execPath,
    '-e',
    'require("fs").writeFileSync(process.argv[1], JSON.stringify({ name: process.env.GIT_AUTHOR_NAME, token: process.env.GH_TOKEN }))',
    output,
  );
  expect(f.err).not.toHaveBeenCalled();
  expect(JSON.parse(await readFile(output, 'utf8'))).toEqual({
    name: 'Profile Bot',
    token: 'profile-token',
  });
  expect(await readInstanceConfig(f.paths)).toEqual(saved);
});

it('reports missing profiles, spawn failures, and preserves child exit status', async () => {
  const f = await fixture();
  await f.run('--profile', 'missing', '--', 'gh', 'auth', 'status');
  expect(f.err).toHaveBeenCalledWith(expect.stringContaining('does not exist'));
  expect(process.exitCode).toBe(1);
  await f.run('--', '/nonexistent/rocky-command');
  expect(f.err).toHaveBeenCalledWith(expect.stringContaining('ENOENT'));
  await f.run('--', process.execPath, '-e', 'process.exit(7)');
  expect(process.exitCode).toBe(7);
  await f.run(
    '--',
    process.execPath,
    '-e',
    'process.kill(process.pid, "SIGINT")',
  );
  expect(process.exitCode).toBe(130);
});
