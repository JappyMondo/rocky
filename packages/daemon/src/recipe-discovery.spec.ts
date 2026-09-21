import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  mkdtemp,
  mkdir,
  rm,
  realpath,
  writeFile,
  readFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { defaultFlowSettings, serviceRecipe } from '@rocky/local-contracts';
import {
  RecipeDiscovery,
  discoveryCheckout,
  agentRecipeGenerator,
  type RecipeGenerator,
} from './recipe-discovery.js';
import { rockyPaths } from './config/paths.js';
import { newRepositoryProfile } from './config/profiles.js';
import { getHarnessAdapter } from './harness/adapter.js';
import type { ConfigStore } from './config/watcher.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
it('gives the discovery harness ten minutes while preserving cancellation and read-only tools', async () => {
  const f = await fixture();
  f.profile.models = {
    planner: { harness: 'opencode', model: 'test/model', effort: 'high' },
  };
  const run = vi
    .spyOn(getHarnessAdapter('opencode')!, 'run')
    .mockResolvedValue({
      text: JSON.stringify(proposal),
      events: [],
      sessionId: 'discovery-test',
    });
  const config = {
    current: { harnesses: {} },
    readCredentials: async () => ({}),
  } as ConfigStore;
  const signal = new AbortController().signal;
  await agentRecipeGenerator(config)(
    f.profile,
    f.paths.repo('web'),
    join(f.paths.root, 'transcript.jsonl'),
    signal,
  );
  const input = run.mock.calls[0][0];
  expect(input.timeoutMs).toBe(600_000);
  expect(input.signal).toBe(signal);
  expect(input.capabilities).toEqual(['read']);
  expect(input.mcpServers).toEqual([]);
  expect(input.prompt).toContain('Prefer the simplest source-backed command');
  expect(input.prompt).toContain(
    'put the repository-relative working directory in cwd',
  );
  expect(input.prompt).toContain('do not copy its version into the command');
  expect(input.prompt).toContain('machine-wide changes');
  expect(input.prompt).not.toContain(
    'Include directory changes and required version-manager setup',
  );
});
it('reports timeout specifically without leaking harness error details', async () => {
  const f = await fixture();
  const jobs = new RecipeDiscovery(f.paths, async () => {
    throw new DOMException('secret-provider-details', 'TimeoutError');
  });
  await jobs.start(f.profile, f.repo);
  await vi.waitFor(async () =>
    expect((await jobs.read('app', 'web'))?.status).toBe('failed'),
  );
  const job = await jobs.read('app', 'web');
  expect(job?.error).toContain('timed out after 10 minutes');
  expect(job?.error).not.toContain('secret-provider-details');
  expect(job?.error).not.toContain('authentication');
  await jobs.close();
});
it('accepts a fixed-endpoint service without an injected port variable', async () => {
  const f = await fixture();
  const service = {
    ...serviceRecipe('preview'),
    start: 'npm run preview',
    portEnv: '',
    endpoints: [
      {
        name: 'web',
        locator: { kind: 'fixed' as const, url: 'http://localhost:4173' },
      },
    ],
  };
  const jobs = new RecipeDiscovery(f.paths, async () => ({
    ...proposal,
    catalog: { commands: [], services: [service] },
  }));
  await jobs.start(f.profile, f.repo);
  await vi.waitFor(async () =>
    expect((await jobs.read('app', 'web'))?.status).not.toBe('running'),
  );
  expect((await jobs.read('app', 'web'))?.status).toBe('ready');
  await jobs.close();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'rocky-discovery-test-'));
  roots.push(root);
  const paths = rockyPaths(root);
  const repo = {
    name: 'web',
    url: 'https://github.com/example/web.git',
    baseBranch: 'main',
  };
  await mkdir(paths.repo(repo.name), { recursive: true });
  const git = promisify(execFile);
  await git('git', ['init'], { cwd: paths.repo(repo.name) });
  await git('git', ['remote', 'add', 'origin', repo.url], {
    cwd: paths.repo(repo.name),
  });
  const profile = {
    ...newRepositoryProfile({ id: 'app', repos: [repo] }),
    workflow: {
      source: JSON.stringify({
        version: 2,
        name: 'test',
        models: {},
        settings: defaultFlowSettings(),
        nodes: [],
        edges: [],
      }),
      triggers: [],
    },
  };
  return { paths, repo, profile };
}
const proposal = {
  commands: { install: 'npm ci', test: 'npm test', lint: '', build: '' },
  ui: [
    {
      id: 'web',
      start: 'npm start',
      endpoint: { kind: 'output-regex', pattern: 'Listening (?<port>[0-9]+)' },
    },
  ],
  explanation:
    'package.json defines these scripts. Startup has not been tested.',
};
it('discovers source files from a bare repository without selecting an existing run worktree', async () => {
  const f = await fixture();
  const git = promisify(execFile);
  const seed = join(f.paths.root, 'seed');
  await mkdir(seed);
  await git('git', ['init', '--initial-branch=main', seed]);
  await writeFile(
    join(seed, 'package.json'),
    '{"scripts":{"test":"echo source"}}',
  );
  await git('git', ['add', 'package.json'], { cwd: seed });
  await git(
    'git',
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.test',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'seed',
    ],
    { cwd: seed },
  );
  await rm(f.paths.repo('web'), { recursive: true });
  await git('git', ['clone', '--bare', seed, f.paths.repo('web')]);
  await git('git', ['remote', 'set-url', 'origin', f.repo.url], {
    cwd: f.paths.repo('web'),
  });
  const existing = join(f.paths.root, 'existing-run');
  await git('git', ['worktree', 'add', '--detach', existing, 'main'], {
    cwd: f.paths.repo('web'),
  });
  await writeFile(join(existing, 'package.json'), 'uncommitted run work');
  // Rocky uses remote-tracking refs, with no local branch or resolvable HEAD.
  await git(
    'git',
    ['update-ref', 'refs/remotes/origin/main', 'refs/heads/main'],
    { cwd: f.paths.repo('web') },
  );
  await git('git', ['update-ref', '-d', 'refs/heads/main'], {
    cwd: f.paths.repo('web'),
  });
  let inspected = '';
  let checkoutPath = '';
  const generate = vi.fn<RecipeGenerator>(async (_profile, cwd) => {
    checkoutPath = cwd;
    inspected = await readFile(join(cwd, 'package.json'), 'utf8');
    return proposal;
  });
  const jobs = new RecipeDiscovery(f.paths, generate);
  await jobs.start(f.profile, f.repo);
  await vi.waitFor(async () =>
    expect((await jobs.read('app', 'web'))?.status).not.toBe('running'),
  );
  expect(inspected).toContain('echo source');
  expect((await jobs.read('app', 'web'))?.status).toBe('ready');
  await expect(realpath(checkoutPath)).rejects.toMatchObject({
    code: 'ENOENT',
  });
  expect(await readFile(join(existing, 'package.json'), 'utf8')).toBe(
    'uncommitted run work',
  );
  await expect(
    discoveryCheckout(
      f.paths.repo('web'),
      join(f.paths.root, 'missing-checkout'),
      'missing',
    ),
  ).rejects.toThrow('base branch is unavailable');
  await jobs.close();
});
it('coalesces jobs, persists validated proposals and survives reopening without executing commands', async () => {
  const f = await fixture();
  let finish!: (value: unknown) => void;
  const generate = vi.fn<RecipeGenerator>(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const jobs = new RecipeDiscovery(f.paths, generate);
  const [first, second] = await Promise.all([
    jobs.start(f.profile, f.repo),
    jobs.start(f.profile, f.repo),
  ]);
  expect(first.id).toBe(second.id);
  await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
  expect(generate.mock.calls[0]?.[1]).toBe(await realpath(f.paths.repo('web')));
  finish(proposal);
  await vi.waitFor(async () =>
    expect((await jobs.read('app', 'web'))?.status).toBe('ready'),
  );
  expect(
    (await new RecipeDiscovery(f.paths, generate).read('app', 'web'))?.proposal,
  ).toEqual(proposal);
  expect(
    JSON.parse(f.profile.workflow.source).settings.repositories,
  ).toBeUndefined();
  await jobs.close();
});
it('cancels an active agent and rejects a mismatched checkout before invoking it', async () => {
  const f = await fixture();
  const generate = vi.fn<RecipeGenerator>(
    async (_profile, _cwd, _transcript, signal: AbortSignal) =>
      new Promise((resolve) =>
        signal.addEventListener('abort', () => resolve(proposal), {
          once: true,
        }),
      ),
  );
  const jobs = new RecipeDiscovery(f.paths, generate);
  await jobs.start(f.profile, f.repo);
  await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
  expect((await jobs.cancel('app', 'web'))?.status).toBe('cancelled');
  await jobs.start(f.profile, {
    ...f.repo,
    url: 'https://github.com/example/other',
  });
  await vi.waitFor(async () =>
    expect((await jobs.read('app', 'web'))?.status).toBe('failed'),
  );
  expect(generate).toHaveBeenCalledOnce();
  await jobs.close();
});
it('rejects malformed model recipes instead of offering them for application', async () => {
  const f = await fixture();
  const jobs = new RecipeDiscovery(f.paths, async () => ({
    ...proposal,
    ui: [
      {
        ...proposal.ui[0],
        endpoint: { kind: 'json-file', path: '../secret', pointer: '/port' },
      },
    ],
  }));
  await jobs.start(f.profile, f.repo);
  await vi.waitFor(async () =>
    expect((await jobs.read('app', 'web'))?.status).toBe('failed'),
  );
  expect((await jobs.read('app', 'web'))?.proposal).toBeUndefined();
  await jobs.close();
});
