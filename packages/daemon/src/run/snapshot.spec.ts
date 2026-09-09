import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { rockyPaths } from '../config/paths.js';
import { newRepositoryProfile } from '../config/profiles.js';
import { createRepoContext } from '../repos/index.js';
import { prepareProfileSnapshot, prepareWorkflowSnapshot } from './snapshot.js';

const exec = promisify(execFile);
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function repository() {
  const root = await mkdtemp(join(tmpdir(), 'rocky-snapshot-'));
  directories.push(root);
  const repo = join(root, 'source');
  await mkdir(repo);
  const git = (...args: string[]) => exec('git', args, { cwd: repo });
  await git('init', '-b', 'main');
  await git('config', 'user.name', 'Snapshot Test');
  await git('config', 'user.email', 'snapshot@example.invalid');
  await git('config', 'commit.gpgsign', 'false');
  await mkdir(join(repo, '.rocky'));
  const context = createRepoContext({
    paths: rockyPaths(join(root, 'home')),
    identity: { name: 'Rocky', email: 'rocky@example.invalid' },
  });
  const lead = { name: 'lead', url: `file://${repo}`, baseBranch: 'main' };
  const commit = async () => {
    await git('add', '.');
    await git('commit', '-m', 'fixture');
    return (await git('rev-parse', 'HEAD')).stdout.trim();
  };
  return { root, repo, git, context, lead, commit };
}

/** NG-599 owns declaration semantics; this only proves the snapshot boundary. */
const mcp = {
  async readMcpConfig(file: string) {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    let declaration: unknown;
    try {
      declaration = JSON.parse(text);
    } catch {
      throw new Error('not valid JSON');
    }
    if (
      !declaration ||
      typeof declaration !== 'object' ||
      !('mcpServers' in declaration) ||
      !declaration.mcpServers ||
      typeof declaration.mcpServers !== 'object' ||
      Object.values(declaration.mcpServers).some(
        (server) =>
          !server ||
          typeof server !== 'object' ||
          typeof server.command !== 'string',
      )
    )
      throw new Error('expected ecosystem mcpServers declarations');
  },
};

function prepare(
  context: Parameters<typeof prepareWorkflowSnapshot>[0],
  lead: Parameters<typeof prepareWorkflowSnapshot>[1],
) {
  return prepareWorkflowSnapshot(context, lead, { mcp });
}

it('snapshots only the local profile when a repository tries to supply .rocky', async () => {
  const { repo, context, lead, commit } = await repository();
  await writeFile(
    join(repo, '.rocky/workflow.ts'),
    'throw new Error("repository-controlled workflow must not load");',
  );
  const sourceCommit = await commit();
  const profile = {
    ...newRepositoryProfile({ id: 'local', remote: lead.url }),
    workflow: {
      source:
        "import { linear } from '@rocky/sdk'; export default [linear.onDelegate(async () => ({ status: 'completed' }))];",
      triggers: [],
    },
    prompts: { worker: 'Local instructions only.' },
    mcp: { mcpServers: {} },
  };

  const snapshot = await prepareProfileSnapshot(context, lead, profile, {
    mcp,
  });

  expect(snapshot.sourceCommit).toBe(sourceCommit);
  expect(snapshot.triggers).toEqual([{ kind: 'linear.onDelegate' }]);
  expect(
    await readFile(join(snapshot.snapshotDir, 'workflow.ts'), 'utf8'),
  ).toBe(profile.workflow.source);
  expect(
    await readFile(join(snapshot.snapshotDir, 'agents/worker.md'), 'utf8'),
  ).toBe('Local instructions only.');
});

it('routes and snapshots one default-branch commit, preserving binary bytes and ignoring live edits', async () => {
  const { repo, context, lead, commit } = await repository();
  const workflow = `import { linear } from '@rocky/sdk';\nexport default [linear.onDelegate(async () => ({ status: 'completed' }))];\n`;
  await writeFile(join(repo, '.rocky/workflow.ts'), workflow);
  const binary = Buffer.from([0, 255, 128, 13, 10, 32, 0]);
  await writeFile(join(repo, '.rocky/picture.bin'), binary);
  const sourceCommit = await commit();
  await writeFile(join(repo, '.rocky/workflow.ts'), 'invalid live worktree');
  const snapshot = await prepare(context, lead);
  expect(snapshot.sourceCommit).toBe(sourceCommit);
  expect(snapshot.triggers).toEqual([{ kind: 'linear.onDelegate' }]);
  expect(await readFile(join(snapshot.snapshotDir, 'picture.bin'))).toEqual(
    binary,
  );
  expect(
    await readFile(join(snapshot.snapshotDir, 'workflow.ts'), 'utf8'),
  ).toBe(workflow);
  expect((await readdir(snapshot.snapshotDir)).sort()).toEqual([
    'picture.bin',
    'workflow.ts',
  ]);
});

it('retains old snapshot bytes after the remote default branch moves and captures new bytes next time', async () => {
  const { repo, context, lead, commit } = await repository();
  const source = (name: string) =>
    `import { manual } from '@rocky/sdk'; export default [manual('${name}', async () => {})];`;
  await writeFile(join(repo, '.rocky/workflow.ts'), source('before'));
  const oldCommit = await commit();
  const old = await prepare(context, lead);
  await writeFile(join(repo, '.rocky/workflow.ts'), source('after'));
  const nextCommit = await commit();
  const next = await prepare(context, lead);
  expect([old.sourceCommit, next.sourceCommit]).toEqual([
    oldCommit,
    nextCommit,
  ]);
  expect(old.triggers).toEqual([{ kind: 'manual', name: 'before' }]);
  expect(next.triggers).toEqual([{ kind: 'manual', name: 'after' }]);
  expect(await readFile(join(old.snapshotDir, 'workflow.ts'), 'utf8')).toBe(
    source('before'),
  );
});

it('loads the remote default branch rather than a configured issue base branch', async () => {
  const { repo, git, context, lead, commit } = await repository();
  await writeFile(
    join(repo, '.rocky/workflow.ts'),
    `import { manual } from '@rocky/sdk'; export default [manual('default', async () => {})];`,
  );
  const sourceCommit = await commit();
  await git('checkout', '-b', 'release');
  await writeFile(join(repo, '.rocky/workflow.ts'), 'invalid issue base');
  await commit();
  await git('checkout', 'main');
  expect(
    (await prepare(context, { ...lead, baseBranch: 'release' })).sourceCommit,
  ).toBe(sourceCommit);
});

it('distinguishes missing .rocky as Onboarding and removes refused staging directories', async () => {
  const { repo, context, lead, commit } = await repository();
  await writeFile(join(repo, 'README.md'), 'No workflow yet');
  await commit();
  await expect(prepare(context, lead)).rejects.toMatchObject({
    kind: 'onboarding-required',
    fix: expect.stringContaining('Onboarding'),
  });
  expect(await readdir(join(context.paths.root, 'snapshots'))).toEqual([]);
});

it.each(['{', '{"mcpServers":{"broken":{"command":42}}}'])(
  'refuses malformed MCP declarations with their exact fix: %s',
  async (mcp) => {
    const { repo, context, lead, commit } = await repository();
    await writeFile(
      join(repo, '.rocky/workflow.ts'),
      `import { linear } from '@rocky/sdk'; export default [linear.onDelegate(async () => {})];`,
    );
    await writeFile(join(repo, '.rocky/mcp.json'), mcp);
    await commit();
    await expect(prepare(context, lead)).rejects.toMatchObject({
      kind: 'invalid-workflow',
      file: '.rocky/mcp.json',
      fix: expect.stringContaining('mcpServers'),
    });
    expect(await readdir(join(context.paths.root, 'snapshots'))).toEqual([]);
  },
);

it('rejects committed symlinks rather than copying content from outside .rocky', async () => {
  const { repo, context, lead, commit } = await repository();
  await writeFile(join(repo, 'outside.ts'), 'export default [];');
  await symlink('../outside.ts', join(repo, '.rocky/workflow.ts'));
  await commit();
  await expect(prepare(context, lead)).rejects.toThrow(
    /workflow.ts.*symlinks.*Replace/s,
  );
  expect(await readdir(join(context.paths.root, 'snapshots'))).toEqual([]);
});

it('keeps top-level validation writes and generated files out of the published snapshot', async () => {
  const { repo, context, lead, commit } = await repository();
  await writeFile(
    join(repo, '.rocky/workflow.ts'),
    `
    import { writeFileSync } from 'node:fs';
    import { linear } from '@rocky/sdk';
    writeFileSync(new URL('./generated.txt', import.meta.url), 'generated');
    export default [linear.onDelegate(async () => {})];
  `,
  );
  await commit();
  const snapshot = await prepare(context, lead);
  expect(await readdir(snapshot.snapshotDir)).toEqual(['workflow.ts']);
  expect(await readdir(join(context.paths.root, 'snapshots'))).toEqual([
    snapshot.snapshotDir.split('/').at(-1),
  ]);
});
