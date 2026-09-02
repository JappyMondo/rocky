/**
 * `rocky repo add|list|remove` (NG-521).
 *
 * The behaviour worth protecting is the ordering: **the clone happens before
 * anything is written**. Eager cloning exists so a bad url or a missing SSH
 * key fails at the terminal with a human present, and an entry written for a
 * repo Rocky cannot reach would turn that into a Run failure an hour later
 * instead.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'; // prettier-ignore

import {
  readInstanceConfig,
  rockyPaths,
  writeInstanceConfig,
} from '@rocky/daemon';

import { buildCli, type CliIo } from './cli.js';
import { repoNameFromUrl, repoSummary } from './repo.js';

const exec = promisify(execFile);
const savedEnv = { ...process.env };

beforeAll(() => {
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_SYSTEM = '/dev/null';
  process.env.GIT_AUTHOR_NAME = 'Fixture';
  process.env.GIT_AUTHOR_EMAIL = 'fixture@example.test';
  process.env.GIT_COMMITTER_NAME = 'Fixture';
  process.env.GIT_COMMITTER_EMAIL = 'fixture@example.test';
});

afterAll(() => {
  process.env = savedEnv;
});

let home: string;
let upstreamRoot: string;
let upstreamUrl: string;
let originalExitCode: typeof process.exitCode;

/** A bare upstream on disk, reached over `file://` like any other remote. */
async function createUpstream(
  name = 'niotix',
  defaultBranch = 'main',
): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'rocky-cli-upstream-'));
  const bare = join(root, `${name}.git`);
  const copy = join(root, 'working-copy');
  const branch = `--initial-branch=${defaultBranch}`;

  await exec('git', ['init', '--quiet', '--bare', branch, bare]);
  await mkdir(copy, { recursive: true });
  const inCopy = (args: string[]) => exec('git', args, { cwd: copy });
  await inCopy(['init', '--quiet', branch]);
  await inCopy(['remote', 'add', 'origin', bare]);
  await inCopy(['commit', '--quiet', '--allow-empty', '-m', 'Initial commit']);
  await inCopy(['push', '--quiet', '--set-upstream', 'origin', defaultBranch]);

  upstreamRoot = root;
  return `file://${bare}`;
}

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    lines: { out, err },
    io: {
      out: (line: string) => void out.push(line),
      err: (line: string) => void err.push(line),
    } satisfies CliIo,
  };
}

async function run(...argv: string[]) {
  const { lines, io: cliIo } = io();
  await buildCli(cliIo).parseAsync(['node', 'rocky', ...argv]);
  return { out: lines.out.join('\n'), err: lines.err.join('\n') };
}

beforeEach(async () => {
  originalExitCode = process.exitCode;
  home = mkdtempSync(join(tmpdir(), 'rocky-cli-home-'));
  process.env.ROCKY_HOME = home;
  upstreamUrl = await createUpstream();
});

afterEach(() => {
  process.exitCode = originalExitCode;
  delete process.env.ROCKY_HOME;
  for (const dir of [home, upstreamRoot]) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('`rocky repo add`', () => {
  it('clones eagerly and writes the entry', async () => {
    const { out } = await run('repo', 'add', upstreamUrl);

    expect(process.exitCode).not.toBe(1);
    expect(existsSync(rockyPaths(home).repo('niotix'))).toBe(true);

    const config = await readInstanceConfig(rockyPaths(home));
    expect(config.repos).toEqual([
      { name: 'niotix', url: upstreamUrl, baseBranch: 'main', label: 'niotix' },
    ]);
    expect(out).toContain('Added "niotix"');
  });

  it("takes baseBranch from the upstream's own default branch", async () => {
    // Discovering it is what eager cloning buys: the human does not have to
    // know, and a wrong guess would only surface when a Run branched off it.
    rmSync(upstreamRoot, { recursive: true, force: true });
    upstreamUrl = await createUpstream('trunky', 'develop');

    await run('repo', 'add', upstreamUrl);

    const config = await readInstanceConfig(rockyPaths(home));
    expect(config.repos[0].baseBranch).toBe('develop');
  });

  it('takes --name, --label and --base-branch when told', async () => {
    await run(
      'repo',
      'add',
      upstreamUrl,
      '--name',
      'niota-api',
      '--label',
      'rocky-api',
      '--base-branch',
      'main',
    );

    const config = await readInstanceConfig(rockyPaths(home));
    expect(config.repos[0]).toMatchObject({
      name: 'niota-api',
      label: 'rocky-api',
      baseBranch: 'main',
    });
    expect(existsSync(rockyPaths(home).repo('niota-api'))).toBe(true);
  });

  it('writes nothing when the clone fails, and says what to check', async () => {
    const gone = join(mkdtempSync(join(tmpdir(), 'rocky-gone-')), 'nope.git');

    const { err } = await run('repo', 'add', gone);

    expect(process.exitCode).toBe(1);
    // The whole point of cloning eagerly: no entry for a repo Rocky cannot
    // reach, so no Run ever fails on it.
    expect((await readInstanceConfig(rockyPaths(home))).repos).toEqual([]);
    expect(err).toContain('ls-remote');
    expect(existsSync(rockyPaths(home).repo('nope'))).toBe(false);
  });

  it('asks for --base-branch when the upstream is empty', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rocky-empty-'));
    const bare = join(root, 'blank.git');
    await exec('git', ['init', '--quiet', '--bare', bare]);

    const { err } = await run('repo', 'add', `file://${bare}`);

    // Cloned fine, but there is no `origin/HEAD` to read a base branch from,
    // and guessing `main` into config.json would only surface when a Run
    // tried to branch off it.
    expect(process.exitCode).toBe(1);
    expect(err).toContain('--base-branch');
    rmSync(root, { recursive: true, force: true });
  });

  it('refuses a name that is already taken', async () => {
    await run('repo', 'add', upstreamUrl);

    const { err } = await run('repo', 'add', upstreamUrl);

    expect(process.exitCode).toBe(1);
    expect(err).toContain('already a repo entry called "niotix"');
    expect((await readInstanceConfig(rockyPaths(home))).repos).toHaveLength(1);
  });

  it('refuses a label that already routes somewhere, since one label means one destination', async () => {
    await run('repo', 'add', upstreamUrl, '--label', 'rocky');

    const { err } = await run(
      'repo',
      'add',
      upstreamUrl,
      '--name',
      'niota-api',
      '--label',
      'Rocky',
    );

    // Case-insensitively, as routing compares them (NG-578).
    expect(process.exitCode).toBe(1);
    expect(err).toContain('already routes to "niotix"');
  });

  it('asks for --name when the url yields nothing usable', async () => {
    const { err } = await run('repo', 'add', 'git@github.com:digimondo/..git');

    expect(process.exitCode).toBe(1);
    expect(err).toContain('--name');
  });
});

describe('deriving a repo name from a url', () => {
  it.each([
    ['git@github.com:digimondo/niotix.git', 'niotix'],
    ['https://github.com/digimondo/niotix.git', 'niotix'],
    ['https://github.com/digimondo/niotix', 'niotix'],
    ['file:///srv/git/niotix.git/', 'niotix'],
    ['/srv/git/niota-api.git', 'niota-api'],
  ])('reads %s as %s', (url, expected) => {
    expect(repoNameFromUrl(url)).toBe(expected);
  });

  it.each(['git@github.com:digimondo/..git', 'git@github.com:d/my repo.git'])(
    'refuses %s rather than mangling it into a directory name',
    (url) => {
      expect(repoNameFromUrl(url)).toBeUndefined();
    },
  );
});

describe('`rocky repo list`', () => {
  it('points at `repo add` on a machine with nothing configured', async () => {
    const { out } = await run('repo', 'list');

    expect(out).toContain('rocky repo add <url>');
  });

  it('shows the label, the base branch and whether the clone is there', async () => {
    await run('repo', 'add', upstreamUrl, '--label', 'rocky');

    const { out } = await run('repo', 'list');

    expect(out).toMatch(/REPO\s+LABEL\s+BASE\s+CLONE\s+URL/);
    expect(out).toMatch(/niotix\s+rocky\s+main\s+cloned/);
  });

  it('says so for an entry a hand-edit added that has not been cloned', async () => {
    const paths = rockyPaths(home);
    await writeInstanceConfig(paths, {
      repos: [
        {
          name: 'niota-api',
          url: 'git@github.com:digimondo/niota-api.git',
          baseBranch: 'main',
          label: 'rocky-api',
        },
      ],
    });

    const { out } = await run('repo', 'list');

    expect(out).toContain('not cloned yet');
  });

  it('lists repo groups with the lead marked', async () => {
    await run('repo', 'add', upstreamUrl, '--label', 'rocky');
    await run('repo', 'add', upstreamUrl, '--name', 'niota-api', '--label', 'rocky-api'); // prettier-ignore

    const paths = rockyPaths(home);
    const config = await readInstanceConfig(paths);
    await writeInstanceConfig(paths, {
      ...config,
      groups: [
        {
          name: 'platform',
          label: 'rocky-platform',
          repos: ['niotix', 'niota-api'],
          workflow: 'niotix',
        },
      ],
    });

    const { out } = await run('repo', 'list');

    expect(out).toMatch(/GROUP\s+LABEL\s+MEMBERS/);
    expect(out).toContain('niotix (lead), niota-api');
  });
});

describe('what `rocky status` says about repos', () => {
  it('points at `repo add` when there are none', async () => {
    await expect(repoSummary()).resolves.toContain('rocky repo add <url>');
  });

  it('says all cloned when Rocky has every one of them', async () => {
    await run('repo', 'add', upstreamUrl);

    await expect(repoSummary()).resolves.toBe('1 repo configured, all cloned.');
  });

  it('names the ones it has not managed to clone', async () => {
    // The case this line exists for: an entry that arrived through a hand-edit
    // of config.json, which the daemon then failed to clone with nobody at a
    // terminal to see it.
    await writeInstanceConfig(rockyPaths(home), {
      repos: [
        {
          name: 'niota-api',
          url: 'git@github.com:digimondo/niota-api.git',
          baseBranch: 'main',
          label: 'rocky-api',
        },
      ],
    });

    await expect(repoSummary()).resolves.toBe(
      '1 repo configured, 1 not cloned yet: niota-api.',
    );
  });
});

describe('`rocky repo remove`', () => {
  it('drops the entry but leaves the clone, because Rocky never destroys work', async () => {
    await run('repo', 'add', upstreamUrl);

    const { out } = await run('repo', 'remove', 'niotix');

    expect((await readInstanceConfig(rockyPaths(home))).repos).toEqual([]);
    // The clone can hold the only copy of a parked Run's branch (NG-574 §3).
    expect(existsSync(rockyPaths(home).repo('niotix'))).toBe(true);
    expect(out).toContain(rockyPaths(home).repo('niotix'));
  });

  it('names the repos it does know when asked for one it does not', async () => {
    await run('repo', 'add', upstreamUrl);

    const { err } = await run('repo', 'remove', 'nope');

    expect(process.exitCode).toBe(1);
    expect(err).toContain('"niotix"');
  });

  it('refuses to leave a repo group with a missing member', async () => {
    await run('repo', 'add', upstreamUrl, '--label', 'rocky');
    const paths = rockyPaths(home);
    const config = await readInstanceConfig(paths);
    await writeInstanceConfig(paths, {
      ...config,
      groups: [
        {
          name: 'platform',
          label: 'rocky-platform',
          repos: ['niotix'],
          workflow: 'niotix',
        },
      ],
    });

    const { err } = await run('repo', 'remove', 'niotix');

    expect(process.exitCode).toBe(1);
    expect(err).toContain('platform');
    expect((await readInstanceConfig(paths)).repos).toHaveLength(1);
  });
});
