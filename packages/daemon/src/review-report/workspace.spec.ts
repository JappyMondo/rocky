import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { git } from '../repos/git.js';
import { reviewRevision } from './workspace.js';

it('refuses empty, dirty, unpushed and mismatched PR heads, then accepts the real pushed diff', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rocky-review-git-'));
  const cwd = join(root, 'work');
  const remote = join(root, 'remote.git');
  try {
    await git(['init', '--bare', remote]);
    await git(['clone', remote, cwd]);
    const run = (...args: string[]) => git(args, { cwd });
    await run('config', 'user.name', 'Fixture');
    await run('config', 'user.email', 'fixture@example.test');
    await run('config', 'commit.gpgsign', 'false');
    await run('checkout', '-b', 'main');
    await writeFile(join(cwd, 'a.txt'), 'before\n');
    await run('add', '.');
    await run('commit', '-m', 'base');
    await run('push', 'origin', 'main');
    await expect(reviewRevision(cwd, 'issue', 'main')).rejects.toThrow(
      'Expected issue branch',
    );
    await run('checkout', '-b', 'issue');
    await expect(reviewRevision(cwd, 'issue', 'main')).rejects.toThrow(
      'No committed changes',
    );
    await writeFile(join(cwd, 'a.txt'), 'after\n');
    await expect(reviewRevision(cwd, 'issue', 'main')).rejects.toThrow(
      'uncommitted',
    );
    await run('add', '.');
    await run('commit', '-m', 'change');
    await expect(reviewRevision(cwd, 'issue', 'main')).rejects.toThrow(
      'remote issue branch',
    );
    await run('push', 'origin', 'issue');
    await expect(
      reviewRevision(cwd, 'issue', 'main', '0'.repeat(40)),
    ).rejects.toThrow('PR head');
    expect((await reviewRevision(cwd, 'issue', 'main')).diff).toContain(
      '+after',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
