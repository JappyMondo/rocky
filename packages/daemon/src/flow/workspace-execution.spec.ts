import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { WorkflowContext, WorkflowInput } from '@rocky/sdk';
import {
  commandRecipe,
  serviceRecipe,
  type WorkspaceRepository,
} from '@rocky/local-contracts';
import { dependencyOrder, WorkspaceExecution } from './workspace-execution.js';
import { createDeliveryOperations } from './delivery.js';
import { defaultFlowSettings } from '@rocky/local-contracts';
import type { DeliveryAgents } from './agents.js';
import { startCommand } from '../run/process.js';

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
it('orders cross-repository prerequisites once and rejects missing/cyclic dependencies', () => {
  const entries = [
    { id: 'a/install', deps: [] },
    { id: 'b/test', deps: ['a/install'] },
  ];
  expect(
    dependencyOrder(
      entries,
      ['b/test', 'a/install'],
      (entry) => entry.deps,
    ).map((entry) => entry.id),
  ).toEqual(['a/install', 'b/test']);
  expect(() =>
    dependencyOrder(entries, ['missing'], (entry) => entry.deps),
  ).toThrow('Missing');
  entries[0].deps.push('b/test');
  expect(() =>
    dependencyOrder(entries, ['b/test'], (entry) => entry.deps),
  ).toThrow('cyclic');
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'rocky-catalog-'));
  dirs.push(root);
  await mkdir(join(root, 'workspace', 'web', 'frontend'), { recursive: true });
  vi.stubEnv('ROCKY_RUN_DIR', root);
  vi.stubEnv('ROCKY_NODE', process.execPath);
  const repo: WorkspaceRepository = {
    id: 'web-id',
    name: 'web',
    url: 'https://example.org/web',
    baseBranch: 'main',
    commands: [
      {
        ...commandRecipe('test', 'printf "%s" "$EXAMPLE"'),
        cwd: 'frontend',
        env: { EXAMPLE: '${CATALOG_TEST_VALUE}' },
      },
    ],
    services: [],
  };
  const input: WorkflowInput = {
    members: [{ name: 'web', path: 'web', lead: true }],
  } as WorkflowInput;
  return { root, repo, input };
}
it('executes from the selected repo cwd, expands only explicit environment references and enforces timeout', async () => {
  const f = await fixture();
  vi.stubEnv('ROCKY_RUN_DIR', undefined);
  vi.stubEnv('CATALOG_TEST_VALUE', 'expected');
  const exec = vi.fn(
    async (command: string, options?: { timeoutMs: number }) => {
      const child = startCommand(command, {
        cwd: f.root,
        background: false,
        timeoutMs: options?.timeoutMs,
      });
      try {
        return await child.result;
      } catch (error) {
        if (String(error).includes('timed out'))
          return { stdout: '', stderr: String(error), exitCode: 124 };
        throw error;
      } finally {
        await child.stop();
      }
    },
  );
  const runtime = new WorkspaceExecution(
    { exec } as unknown as WorkflowContext,
    f.input,
    [f.repo],
    f.root,
  );
  expect((await runtime.command('web-id/test', 'test')).stdout).toBe(
    'expected',
  );
  expect(exec.mock.calls[0][0]).toContain('/frontend');
  f.repo.commands![0].command = 'sleep 1';
  f.repo.commands![0].timeoutMs = 20;
  expect((await runtime.command('web-id/test', 'timeout')).exitCode).toBe(124);
  await symlink(f.root, join(f.root, 'workspace', 'web', 'escape'));
  f.repo.commands![0].cwd = 'escape';
  await expect(runtime.command('web-id/test', 'escape')).rejects.toThrow(
    'escapes',
  );
});
it('loads nvm lazily once, honors cwd and NVM_DIR, and fails without installing missing tools', async () => {
  const f = await fixture();
  const nvmDir = join(f.root, 'custom nvm');
  await mkdir(nvmDir);
  await writeFile(
    join(nvmDir, 'nvm.sh'),
    `printf 'loaded:'; nvm() { if [ "$1" = use ]; then read -r version < .nvmrc; printf '%s:' "$version"; else return 1; fi; }\n`,
  );
  await writeFile(join(f.root, 'workspace/web/frontend/.nvmrc'), 'v22.16.0\n');
  const command = f.repo.commands![0];
  command.env = { NVM_DIR: nvmDir };
  command.command = 'nvm use && nvm use && printf done';
  const exec = async (shell: string) => {
    const child = startCommand(shell, { cwd: f.root, background: false });
    try {
      return await child.result;
    } finally {
      await child.stop();
    }
  };
  const runtime = new WorkspaceExecution(
    { exec } as unknown as WorkflowContext,
    f.input,
    [f.repo],
    f.root,
  );
  expect((await runtime.command('web-id/test', 'nvm')).stdout).toBe(
    'loaded:v22.16.0:v22.16.0:done',
  );
  command.env.NVM_DIR = join(f.root, 'not-installed');
  const missing = await runtime.command('web-id/test', 'missing');
  expect(missing.exitCode).toBe(127);
  expect(missing.stderr).toContain('nvm is unavailable');
  expect(missing.stdout).not.toContain('done');
  command.command = 'printf no-node-needed';
  expect((await runtime.command('web-id/test', 'plain')).stdout).toBe(
    'no-node-needed',
  );
});
it('starts dependency services and records endpoints, then stops in reverse order', async () => {
  const f = await fixture();
  const base = {
    ...serviceRecipe('api'),
    portEnv: '',
    start: 'start-api',
    endpoints: [
      {
        name: 'web',
        locator: { kind: 'fixed' as const, url: 'http://localhost:4000/' },
      },
    ],
  };
  f.repo.services = [
    base,
    { ...base, id: 'web', start: 'start-web', dependsOn: ['web-id/api'] },
  ];
  const exec = vi.fn(
    async (_command: string, options?: { background?: boolean }) =>
      options?.background
        ? { pid: 100 + exec.mock.calls.length }
        : { exitCode: 0, stdout: '', stderr: '' },
  );
  const step = vi.fn(async (_label, work) => work());
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('ready')),
  );
  const runtime = new WorkspaceExecution(
    { exec, step, ports: [4300, 4301] } as unknown as WorkflowContext,
    f.input,
    [f.repo],
  );
  expect(await runtime.start(['web-id/web'], 'ui')).toEqual({
    'web-id/api': { web: 'http://localhost:4000/' },
    'web-id/web': { web: 'http://localhost:4000/' },
  });
  await runtime.stop('ui');
  expect(exec.mock.calls[0][0]).toContain('start-api');
  expect(exec.mock.calls[0][0]).not.toContain('export =');
  expect(exec.mock.calls[1][0]).toContain('start-web');
  expect(exec.mock.calls[2][0]).toContain('-102');
  expect(exec.mock.calls[3][0]).toContain('-101');
});
it('runs required validation even when the planner selects nothing, and records skipped optional checks', async () => {
  const f = await fixture();
  f.repo.commands = [
    {
      ...commandRecipe('required', 'echo required'),
      purpose: 'test',
      policy: 'required',
    },
    {
      ...commandRecipe('optional', 'echo optional'),
      purpose: 'test',
      policy: 'agent',
    },
    {
      ...commandRecipe('manual', 'echo manual'),
      purpose: 'test',
      policy: 'manual',
    },
  ];
  const exec = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
  const receipts: unknown[] = [];
  const ctx = {
    exec,
    issue: { identifier: 'TEST-1' },
    post: vi.fn(),
    scm: { openPr: async () => ({ headSha: 'head' }) },
    stage: vi.fn(),
    changedFiles: async () => ['web/a.ts'],
    step: async (_label: string, work: () => Promise<unknown>) => {
      const value = await work();
      receipts.push(value);
      return value;
    },
  } as unknown as WorkflowContext;
  const agents = {
    selectCommands: async () => ({
      selected: [],
      reason: 'No optional checks needed.',
    }),
    call: vi.fn(async (role: string) =>
      role === 'refiner'
        ? {
            status: 'clear',
            delivery: { kind: 'pull-request', stateChanges: false },
            scope: 'test',
            decisions: [],
            acceptanceCriteria: [],
            outOfScope: [],
          }
        : { summary: '', steps: [] },
    ),
  } as unknown as DeliveryAgents;
  const delivery = createDeliveryOperations(
    ctx,
    f.input,
    { ...defaultFlowSettings(), pullRequests: 'lead', execution: [f.repo] },
    join(f.root, 'snapshot'),
  );
  await delivery('clarify', agents);
  await delivery('plan', agents);
  await delivery('implement', agents);
  exec.mockClear();
  expect(await delivery('validate', agents)).toBe('next');
  expect(exec).toHaveBeenCalledOnce();
  expect(exec.mock.calls[0]).toEqual(
    expect.arrayContaining([expect.stringContaining('echo required')]),
  );
  expect(receipts).toContainEqual({
    selected: ['web-id/required'],
    skipped: ['web-id/optional'],
    reason: 'No optional checks needed.',
  });
});
