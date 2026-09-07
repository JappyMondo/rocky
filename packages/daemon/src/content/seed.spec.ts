import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
  symlink,
  readdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { inspectAndSeed, seedContent, selectStates } from './seed.js';

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary.map((path) => rm(path, { recursive: true, force: true })),
  );
});

it('adds Playwright only for UI and distils only explicit agent docs', async () => {
  const { repo, shippedDir } = await fixture();
  await writeFile(join(repo, 'AGENTS.md'), 'Use strict TypeScript.');
  await writeFile(join(repo, 'code.ts'), '// invent a rule from me');
  const distill = vi.fn(async () => ({
    conventions: 'Use strict TypeScript.',
  }));
  const result = await seedContent({
    repo,
    shippedDir,
    inspection: {
      commands: { install: '', test: '', lint: '', build: '' },
      ui: { start: 'pnpm dev --port $PORT', url: 'http://127.0.0.1/app' },
    },
    teamStates: [
      { name: 'Working', type: 'started', position: 0 },
      { name: 'Finished', type: 'completed', position: 2 },
    ],
    distill,
    validate: async () => undefined,
  });
  expect(distill).toHaveBeenCalledWith([
    { name: 'AGENTS.md', text: 'Use strict TypeScript.' },
  ]);
  expect(await readFile(join(result, 'rules/conventions.md'), 'utf8')).toBe(
    'Use strict TypeScript.\n',
  );
  expect(JSON.parse(await readFile(join(result, 'mcp.json'), 'utf8'))).toEqual({
    mcpServers: {
      playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
    },
  });
});

it('selects actual states by type, position and review name, independent of API order', () => {
  expect(
    selectStates([
      { name: 'Shipped', type: 'completed', position: 4 },
      { name: 'Reviewing', type: 'started', position: 2 },
      { name: 'Doing', type: 'started', position: 1 },
      { name: 'Wrong review', type: 'unstarted', position: 0 },
    ]),
  ).toEqual({ started: 'Doing', review: 'Reviewing', done: 'Shipped' });
  expect(() => selectStates([])).toThrow('started and completed');
});

it('never distils code in a docs-less repo, preserves MCP bytes, and retries failed validation', async () => {
  const { repo, shippedDir } = await fixture();
  const distill = vi.fn(async () => ({ conventions: 'Invented rules' }));
  const options = {
    repo,
    shippedDir,
    distill,
    inspection: {
      commands: { install: '', test: '', lint: '', build: '' },
      ui: null,
    },
  };
  await expect(
    seedContent({
      ...options,
      validate: async () => {
        throw new Error('Invalid Trigger table');
      },
    }),
  ).rejects.toThrow('Invalid Trigger table');
  expect(await readdir(repo)).toEqual([]);
  await seedContent({ ...options, validate: async () => undefined });
  expect(distill).not.toHaveBeenCalled();
  expect(await readFile(join(repo, '.rocky/mcp.json'), 'utf8')).toBe(
    '{"mcpServers":{}}\n',
  );
});

it.each(['directory', 'file', 'symlink'])(
  'refuses an existing .rocky %s without touching it',
  async (kind) => {
    const { repo, shippedDir } = await fixture();
    const target = join(repo, '.rocky');
    if (kind === 'directory') await mkdir(target);
    else if (kind === 'file') await writeFile(target, 'user file');
    else await symlink(join(repo, 'missing'), target);
    await expect(
      seedContent({
        repo,
        shippedDir,
        inspection: {
          commands: { install: '', test: '', lint: '', build: '' },
          ui: null,
        },
        validate: async () => undefined,
      }),
    ).rejects.toThrow('Already configured');
    expect(await readdir(repo)).toEqual(['.rocky']);
  },
);

it('foreground init obtains validated inspection and routing team states before seeding', async () => {
  const { repo, shippedDir } = await fixture();
  const inspect = vi.fn(async () => ({
    commands: { install: '', test: 'npm test', lint: '', build: '' },
    ui: null,
  }));
  const resolveTeamStates = vi.fn(async () => [
    { name: 'Doing', type: 'started', position: 1 },
    { name: 'Review', type: 'started', position: 2 },
    { name: 'Finished', type: 'completed', position: 3 },
  ]);
  await inspectAndSeed({
    repo,
    shippedDir,
    inspect,
    resolveTeamStates,
    validate: async () => undefined,
  });
  expect(inspect).toHaveBeenCalledWith(repo);
  expect(resolveTeamStates).toHaveBeenCalledWith(repo);
  const source = await readFile(join(repo, '.rocky/workflow.ts'), 'utf8');
  expect(source).toContain('"review":"Review"');
  expect(source).not.toContain('Verify these Linear state names');
  await expect(
    inspectAndSeed({
      repo,
      shippedDir,
      inspect,
      validate: async () => undefined,
    }),
  ).rejects.toThrow('Already configured');
  expect(inspect).toHaveBeenCalledTimes(1);
});

it.each(['directory', 'file', 'symlink'])(
  'does not clobber a .rocky %s created during validation',
  async (kind) => {
    const { repo, shippedDir } = await fixture();
    const target = join(repo, '.rocky');
    await expect(
      seedContent({
        repo,
        shippedDir,
        inspection: {
          commands: { install: '', test: '', lint: '', build: '' },
          ui: null,
        },
        validate: async () => {
          if (kind === 'directory') await mkdir(target);
          else if (kind === 'file')
            await writeFile(target, 'concurrent user file');
          else await symlink(join(repo, 'missing'), target);
        },
      }),
    ).rejects.toThrow('Already configured');
    if (kind === 'directory') expect(await readdir(target)).toEqual([]);
    if (kind === 'file')
      expect(await readFile(target, 'utf8')).toBe('concurrent user file');
    expect(await readdir(repo)).toEqual(['.rocky']);
  },
);

it('seeds installed assets byte-identically outside Config and preserves the dirty git index', async () => {
  const { repo } = await fixture();
  const shippedDir = fileURLToPath(
    new URL('../../content/.rocky/', import.meta.url),
  );
  const git = async (...args: string[]) =>
    promisify(execFile)('git', args, { cwd: repo });
  await git('init', '--quiet');
  await writeFile(join(repo, 'existing.txt'), 'staged');
  await git('add', 'existing.txt');
  await writeFile(join(repo, 'existing.txt'), 'dirty');
  const index = await readFile(join(repo, '.git/index'));
  const result = await seedContent({
    repo,
    shippedDir,
    inspection: {
      commands: { install: 'pnpm install', test: '', lint: '', build: '' },
      ui: null,
    },
    validate: async () => undefined,
  });
  const files = await readdir(shippedDir, {
    recursive: true,
    withFileTypes: true,
  });
  for (const entry of files) {
    if (!entry.isFile()) continue;
    const file = relative(shippedDir, join(entry.parentPath, entry.name));
    const original = await readFile(join(shippedDir, file));
    const seeded = await readFile(join(result, file));
    if (file === 'workflow.ts') {
      expect(seeded.toString().split('// BEGIN ROCKY CONFIG')[0]).toBe(
        original.toString().split('// BEGIN ROCKY CONFIG')[0],
      );
      expect(seeded.toString().split('// END ROCKY CONFIG')[1]).toBe(
        original.toString().split('// END ROCKY CONFIG')[1],
      );
    } else expect(seeded).toEqual(original);
  }
  expect(await readFile(join(repo, '.git/index'))).toEqual(index);
  expect(await readFile(join(repo, 'existing.txt'), 'utf8')).toBe('dirty');
});

it('leaves no installation after malformed Config or failed rule distillation', async () => {
  const { repo, shippedDir } = await fixture();
  const options = {
    repo,
    shippedDir,
    inspection: {
      commands: { install: '', test: '', lint: '', build: '' },
      ui: null,
    },
    validate: async () => undefined,
  };
  await writeFile(join(repo, 'CONTRIBUTING.md'), 'Explicit rules');
  await expect(
    seedContent({
      ...options,
      distill: async () => {
        throw new Error('distillation failed');
      },
    }),
  ).rejects.toThrow('distillation failed');
  expect(await readdir(repo)).toEqual(['CONTRIBUTING.md']);
  await writeFile(join(shippedDir, 'workflow.ts'), '// no Config markers');
  await expect(seedContent(options)).rejects.toThrow('packaging failure');
  expect(await readdir(repo)).toEqual(['CONTRIBUTING.md']);
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'rocky-seed-test-'));
  temporary.push(root);
  const repo = join(root, 'repo');
  const shippedDir = join(root, 'shipped');
  await mkdir(repo);
  await mkdir(shippedDir);
  await writeFile(
    join(shippedDir, 'workflow.ts'),
    '// before\n// BEGIN ROCKY CONFIG\nold\n// END ROCKY CONFIG\n// after\n',
  );
  await writeFile(join(shippedDir, 'schemas.ts'), '// exact schema bytes\n');
  await writeFile(join(shippedDir, 'mcp.json'), '{"mcpServers":{}}\n');
  return { repo, shippedDir };
}

it('validates the staged tree before installing and changes only the Config block', async () => {
  const { repo, shippedDir } = await fixture();
  let validated = false;
  const result = await seedContent({
    repo,
    shippedDir,
    inspection: {
      commands: {
        install: 'pnpm install',
        test: 'pnpm test',
        lint: '',
        build: '',
      },
      ui: null,
    },
    validate: async (directory) => {
      await expect(
        readFile(join(repo, '.rocky', 'workflow.ts')),
      ).rejects.toThrow();
      expect(await readFile(join(directory, 'workflow.ts'), 'utf8')).toContain(
        'pnpm install',
      );
      validated = true;
    },
  });
  expect(validated).toBe(true);
  expect(result).toBe(join(repo, '.rocky'));
  const source = await readFile(join(result, 'workflow.ts'), 'utf8');
  expect(source.split('// BEGIN ROCKY CONFIG')[0]).toBe('// before\n');
  expect(source.split('// END ROCKY CONFIG')[1]).toBe('\n// after\n');
  expect(source).toContain('Verify these Linear state names');
  expect(source).toContain('const reviewCap = 5;');
  expect(await readFile(join(result, 'schemas.ts'), 'utf8')).toBe(
    '// exact schema bytes\n',
  );
  await expect(
    readFile(join(result, 'rules', 'conventions.md')),
  ).rejects.toThrow();
});
