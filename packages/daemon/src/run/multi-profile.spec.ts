import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Workflow } from '@rocky/sdk';
import { afterEach, expect, it, vi } from 'vitest';
import { rockyPaths } from '../config/paths.js';
import {
  newRepositoryProfile,
  writeRepositoryProfile,
} from '../config/profiles.js';
import { parseInstanceConfig } from '../config/schema.js';
import { createRepoContext } from '../repos/index.js';
import { createUpstream } from '../repos/upstream.fixtures.js';
import { git } from '../repos/git.js';
import {
  createExecutionRequestHandler,
  openExecution,
  type ExecutionIntegration,
} from './execution.js';
import { createProductionRuntime } from './production.js';
import { JournalWriter } from './writer.js';
import type { AgentHarnessInvocation } from './agent.js';

// The real snapshot compiler validates the stored source in its child process.
// Keep workflow import hooks out of Vitest and supply the same workflow behavior
// below. The simulated Harness reads and edits the real Git worktrees.
const { loadSnapshotWorkflow } = vi.hoisted(() => ({
  loadSnapshotWorkflow: vi.fn(),
}));
vi.mock('./loading/loader.js', async (original) => ({
  ...(await original<typeof import('./loading/loader.js')>()),
  loadSnapshotWorkflow,
}));
const roots: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

it('freezes profile membership, creates sibling worktrees and gives each Agent the shared parent across Runs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rocky-multi-profile-'));
  roots.push(root);
  const upstreams = await Promise.all([
    createUpstream(),
    createUpstream({ defaultBranch: 'develop' }),
  ]);
  roots.push(...upstreams.map((upstream) => dirname(upstream.dir)));
  const paths = rockyPaths(join(root, 'home'));
  const members = upstreams.map((upstream, index) => ({
    name: index === 0 ? 'app' : 'api',
    url: upstream.url,
    baseBranch: index === 0 ? 'main' : 'develop',
  }));
  const profile = await writeRepositoryProfile(paths, {
    ...newRepositoryProfile({ id: 'product', repos: members }),
    workflow: {
      source:
        "import { manual, linear } from '@rocky/sdk'; const work = async (ctx) => { await ctx.agent('worker', { harness: 'opencode', tools: ['read', 'edit'] }); await ctx.checkpoint({ title: 'Inspect', body: 'Keep workspace' }); return 'completed'; }; export default [manual('edit', work), linear.onDelegate(work)];",
      triggers: ['edit', 'linear.onDelegate'],
    },
    prompts: { worker: 'Edit every repository in the workspace.' },
  });
  // One old routing entry now selects a profile containing both repositories.
  const config = parseInstanceConfig({
    repos: [{ ...members[0], label: 'product', profile: 'product' }],
  });
  const repos = createRepoContext({ paths, identity: config.identity });
  let execution: ExecutionIntegration;
  const writers = new Map<string, Promise<JournalWriter>>();
  const request = createExecutionRequestHandler(
    { paths, repos },
    (runId) => execution.scheduler.get(runId),
    (path) => {
      if (!writers.has(path)) writers.set(path, JournalWriter.open(path));
      return writers.get(path) as Promise<JournalWriter>;
    },
  );
  let answered = false;
  const seen: string[] = [];
  const invoke = vi.fn(async (input: AgentHarnessInvocation) => {
    seen.push(input.cwd);
    expect(await readdir(input.cwd)).toEqual(['api', 'app']);
    for (const repo of members) {
      const dir = join(input.cwd, repo.name);
      expect(
        (await git(['branch', '--show-current'], { cwd: dir })).stdout,
      ).toMatch(/^ng-multi-/);
      await writeFile(join(dir, 'agent-edit.txt'), input.cwd);
    }
    return {
      text: '<result>{"summary":"edited both"}</result>',
      events: [],
      sessionId: 'session',
    };
  });
  const workflow: Workflow = async (ctx, input) => {
    expect(input.members).toEqual(
      members.map((repo, index) => ({
        name: repo.name,
        path: repo.name,
        lead: index === 0,
      })),
    );
    await ctx.agent('worker', { harness: 'opencode', tools: ['read', 'edit'] });
    await ctx.checkpoint({ title: 'Inspect', body: 'Keep workspace' });
    return 'completed';
  };
  loadSnapshotWorkflow.mockResolvedValue(workflow);
  const runtime = {
    boot: async (
      ...[run, kind, signal]: Parameters<
        ReturnType<typeof createProductionRuntime>['boot']
      >
    ) => {
      const boot = createProductionRuntime({
        paths,
        config: () => config,
        request: (message) => request(run.runId, message, signal),
        adapterFor: () => ({ run: invoke, resume: invoke }),
        external: () => ({
          checkpoint: async () =>
            answered
              ? { status: 'done', result: { decision: 'approve' } }
              : { status: 'waiting' },
        }),
      });
      try {
        return await boot.boot(run, kind, signal);
      } finally {
        await boot.close();
      }
    },
    kill: async () => undefined,
    close: async () => undefined,
  };
  const open = () =>
    openExecution({
      paths,
      config: () => config,
      repos,
      runtime,
      onRefusal: async () => undefined,
    });
  execution = await open();
  const issue = {
    identifier: 'NG-700',
    title: 'Both repos',
    description: '',
    labels: ['product'],
    url: 'https://linear.app/issue/NG-700',
  };
  try {
    const first = await execution.delegate({
      requestId: 'first',
      issue,
      branch: 'ng-multi-first',
    });
    expect(first).toMatchObject({
      kind: 'started',
      run: {
        profile: { id: 'product' },
        execution: {
          members: members.map((member, index) => ({
            ...member,
            path: member.name,
            lead: index === 0,
          })),
        },
      },
    });
    await vi.waitFor(async () =>
      expect((await execution.scheduler.get('NG-700-1'))?.status).toBe(
        'parked',
      ),
    );
    const firstDir = paths.run('NG-700-1').workspaceDir;
    expect(seen).toEqual([firstDir]);
    // Another issue creates new worktrees, even for the same profile and repos.
    const second = await execution.manual('edit', {
      requestId: 'second',
      issue: { ...issue, identifier: 'NG-701', labels: [] },
      branch: 'ng-multi-second',
      profileId: 'product',
    });
    expect(second.kind).toBe('started');
    await vi.waitFor(async () =>
      expect((await execution.scheduler.get('NG-701-1'))?.status).toBe(
        'parked',
      ),
    );
    expect(seen[1]).toBe(paths.run('NG-701-1').workspaceDir);
    for (const member of members) {
      expect(
        await readFile(join(firstDir, member.name, 'agent-edit.txt'), 'utf8'),
      ).toBe(firstDir);
      expect(
        await readFile(
          join(
            upstreams[members.indexOf(member)].workingCopy,
            'agent-edit.txt',
          ),
          'utf8',
        ).catch(() => 'absent'),
      ).toBe('absent');
    }
    await writeRepositoryProfile(paths, {
      ...profile,
      repos: [members[1]],
      workflow: { source: 'throw new Error("new workflow");', triggers: [] },
    });
    config.repos = [];
    await execution.close();
    execution = await open();
    answered = true;
    await execution.scheduler.poll('NG-700-1');
    await vi.waitFor(async () =>
      expect((await execution.scheduler.get('NG-700-1'))?.status).toBe(
        'finished',
      ),
    );
    expect(
      (await execution.scheduler.get('NG-700-1'))?.execution?.members.map(
        (member) => member.name,
      ),
    ).toEqual(['app', 'api']);
    expect(await readdir(firstDir)).toEqual(['api', 'app']);
    expect(invoke).toHaveBeenCalledTimes(2);
  } finally {
    await execution.close();
  }
});
