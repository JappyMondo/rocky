import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';
import type { WorkflowContext } from '@rocky/sdk';
import { DeliveryRepositories } from './repositories.js';

it('uses each configured target branch, preserves remote fixer commits, and rejects uncommitted companion work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rocky-delivery-'));
  const execute = promisify(execFile);
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  const git = async (path: string, ...args: string[]) =>
    (await execute('git', args, { cwd: path, env })).stdout.trim();
  try {
    await git(root, 'init', '--bare', 'remote.git');
    await git(root, 'clone', 'remote.git', 'seed');
    const seed = join(root, 'seed');
    await git(seed, 'config', 'user.name', 'Fixture');
    await git(seed, 'config', 'user.email', 'fixture@example.invalid');
    await git(seed, 'checkout', '-b', 'main');
    await writeFile(join(seed, 'setting.txt'), '1\n');
    await git(seed, 'add', '.');
    await git(seed, 'commit', '-m', 'Baseline');
    await git(seed, 'push', 'origin', 'main');
    await git(
      root,
      '--git-dir=remote.git',
      'symbolic-ref',
      'HEAD',
      'refs/heads/main',
    );
    await git(seed, 'checkout', '-b', 'development');
    await writeFile(join(seed, 'setting.txt'), '14\n');
    await git(seed, 'commit', '-am', 'Development baseline');
    await git(seed, 'push', 'origin', 'development');
    const members = [
      { name: 'app', path: 'app', lead: true, baseBranch: 'development' },
      {
        name: 'settings',
        path: "settings team's copy",
        lead: false,
        baseBranch: 'main',
      },
    ];
    for (const member of members) {
      await git(root, 'clone', 'remote.git', member.path);
      await git(
        join(root, member.path),
        'checkout',
        '-b',
        'issue-1',
        `origin/${member.baseBranch}`,
      );
    }
    const settings = join(root, members[1].path);
    await git(settings, 'config', 'user.name', 'Fixture');
    await git(settings, 'config', 'user.email', 'fixture@example.invalid');
    await writeFile(join(settings, 'setting.txt'), '28\n');
    await git(settings, 'commit', '-am', 'Requested setting');
    const head = await git(settings, 'rev-parse', 'HEAD');
    const openPr = vi.fn(async ({ repo }: { repo: string }) => ({
      repo,
      id: repo,
      number: 1,
      url: `https://example.test/${repo}/pull/1`,
      headSha: head,
      sourceBranch: 'issue-1',
      baseBranch: 'main',
      state: 'open',
      draft: true,
    }));
    const recordedCommands: string[] = [];
    const ctx = {
      branch: 'issue-1',
      scm: { openPr },
      exec: async (command: string) => {
        recordedCommands.push(command);
        try {
          const { stdout, stderr } = await execute('/bin/sh', ['-c', command], {
            cwd: root,
            env,
          });
          return { exitCode: 0, stdout, stderr };
        } catch (error) {
          const failure = error as Error & {
            code?: number;
            stdout?: string;
            stderr?: string;
          };
          return {
            exitCode: failure.code ?? 1,
            stdout: failure.stdout ?? '',
            stderr: failure.stderr ?? failure.message,
          };
        }
      },
    } as unknown as WorkflowContext;
    const repositories = new DeliveryRepositories(ctx, { members });
    expect(await repositories.changedFiles()).toEqual(['settings/setting.txt']);
    const patch = await repositories.diff();
    expect(patch).toContain('b/settings/setting.txt');
    expect(patch).toContain('+28');
    expect(patch).not.toContain('b/app/setting.txt');
    await repositories.sync('Use 28 days', 'Requested change');
    // Completed pushes in older Boots recorded only the first HEAD read.
    // A new read here shifts every later journal Step and breaks replay.
    expect(
      recordedCommands.filter((command) =>
        command.includes('git rev-parse HEAD'),
      ),
    ).toHaveLength(1);
    expect(openPr).toHaveBeenCalledTimes(1);
    expect(openPr).toHaveBeenCalledWith({
      repo: 'settings',
      title: 'Use 28 days',
      body: 'Requested change',
      draft: true,
    });
    expect(
      await git(
        root,
        '--git-dir=remote.git',
        'rev-parse',
        'refs/heads/issue-1',
      ),
    ).toBe(head);
    expect(repositories.heads).toEqual({ settings: head });
    // Repeated validation does not create another PR; only later edits form a delta.
    expect(await repositories.diff(repositories.heads)).toBe('');
    await repositories.sync('Use 28 days', 'Requested change');
    expect(openPr).toHaveBeenCalledTimes(1);

    // A previous Boot pushed a fix, then the current Boot committed a newer
    // fix on the retained worktree before learning the remote had advanced.
    await git(root, 'clone', 'remote.git', 'previous-boot');
    const previous = join(root, 'previous-boot');
    await git(previous, 'config', 'user.name', 'Fixture');
    await git(previous, 'config', 'user.email', 'fixture@example.invalid');
    await git(previous, 'checkout', '-b', 'issue-1', 'origin/issue-1');
    await writeFile(join(previous, 'setting.txt'), '29\n');
    await git(previous, 'commit', '-am', 'Previous fixer');
    const previousHead = await git(previous, 'rev-parse', 'HEAD');
    await git(previous, 'push', 'origin', 'HEAD');
    await writeFile(join(settings, 'setting.txt'), '30\n');
    await git(settings, 'commit', '-am', 'Current fixer');
    await repositories.sync('Use 30 days', 'Current fix');
    const mergedHead = await git(settings, 'rev-parse', 'HEAD');
    expect(await git(settings, 'show', '-s', '--format=%s', 'HEAD')).toBe(
      'fix: reconcile concurrent branch updates',
    );
    expect(mergedHead).toBe(
      await git(
        root,
        '--git-dir=remote.git',
        'rev-parse',
        'refs/heads/issue-1',
      ),
    );
    expect(await git(settings, 'show', 'HEAD:setting.txt')).toBe('30');
    expect(
      await git(
        settings,
        'merge-base',
        '--is-ancestor',
        previousHead,
        mergedHead,
      ),
    ).toBe('');
    expect(repositories.heads).toEqual({ settings: mergedHead });

    await writeFile(join(settings, 'setting.txt'), '31\n');
    await expect(
      repositories.sync('Use 31 days', 'Uncommitted'),
    ).rejects.toThrow('settings has uncommitted work');
    expect(
      await git(
        root,
        '--git-dir=remote.git',
        'rev-parse',
        'refs/heads/issue-1',
      ),
    ).toBe(mergedHead);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
