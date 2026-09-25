import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  readdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { WorkflowContext, WorkflowInput } from '@rocky/sdk';
import {
  commandRecipe,
  defaultFlowSettings,
  automationSettings,
  type RepositoryCommand,
  type DevService,
  type EnvironmentRecipe,
  serviceRecipe,
  type WorkspaceRepository,
  type EnvironmentCapability,
} from '@rocky/local-contracts';
import { WorkspaceExecution } from '../flow/workspace-execution.js';
import { startCommand, type OwnedCommand } from '../run/process.js';
import { ensureEnvironment, interpretVerification } from './ensure.js';
import { EnvironmentOnboarding } from './onboarding.js';
import { rockyPaths } from '../config/paths.js';
import { newRepositoryProfile } from '../config/profiles.js';
import { runBoot } from '../run/replay.js';
import { createWorkflowContext } from '../run/context.js';
import { readJournal } from '../run/journal.js';

const roots: string[] = [];
const children: OwnedCommand[] = [];
afterEach(async () => {
  await Promise.allSettled(children.splice(0).map((child) => child.stop()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const node = quote(process.execPath);
const capability: EnvironmentCapability = {
  id: 'login',
  kind: 'login',
  baseline: true,
  sources: [{ path: 'README.md', section: 'Local login' }],
  setup: ['web/install'],
  services: ['web/ui'],
  verify: 'web/verify',
  checks: ['login', 'feature'],
  authentication: { kind: 'documented-local', reference: 'README.md' },
  fixture: 'simulated',
};
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'rocky-environment-'));
  roots.push(root);
  const repoDir = join(root, 'workspace/web');
  await mkdir(repoDir, { recursive: true });
  await writeFile(
    join(repoDir, 'README.md'),
    '# Local login\nuser: local-admin\npassword: local-development-only\n',
  );
  await writeFile(
    join(repoDir, 'server.cjs'),
    `
const http = require('node:http');
const fs = require('node:fs');
if (!fs.existsSync('.prepared')) process.exit(1);
http.createServer(async (req, res) => {
  if (req.url === '/') return res.end('ready');
  if (process.env.API_URL) {
    const upstream = await fetch(new URL(req.url, process.env.API_URL), {headers: req.headers});
    res.writeHead(upstream.status); return res.end(await upstream.text());
  }
  if (req.url === '/login') {
    let body = ''; for await (const part of req) body += part;
    if (body === 'local-admin:local-development-only') { res.setHeader('Set-Cookie', 'session=local'); return res.end('logged-in'); }
    res.writeHead(401); return res.end('unauthorized');
  }
  if (req.url === '/feature' && req.headers.cookie === 'session=local') return res.end('feature-reached');
  res.writeHead(401); res.end('unauthorized');
}).listen(Number(process.env.PORT), '127.0.0.1');
`,
  );
  await writeFile(
    join(repoDir, 'verify.cjs'),
    `
(async () => {
 const doc = require('node:fs').readFileSync('README.md', 'utf8');
 const user = doc.match(/user: (.+)/)[1], password = doc.match(/password: (.+)/)[1];
 const login = await fetch(new URL('/login', process.env.API_URL), { method: 'POST', body: user + ':' + password });
 const feature = await fetch(new URL('/feature', process.env.UI_URL), { headers: {cookie: login.headers.get('set-cookie')} });
 console.log(JSON.stringify({ status: 'passed', ignoredSecret: 'secret-must-not-be-retained', checks: [
   {id:'login', executed:true, passed:login.ok},
   {id:'feature', executed:true, passed:feature.ok && await feature.text() === 'feature-reached'}
 ]}));
})().catch(() => process.exit(1));
`,
  );
  const api = {
    ...serviceRecipe('api'),
    start: `${node} server.cjs`,
    readiness: { endpoint: 'web', attempts: 60, intervalMs: 50 },
  };
  const repo: WorkspaceRepository & {
    commands: RepositoryCommand[];
    services: DevService[];
    environment: EnvironmentRecipe;
  } = {
    id: 'web',
    name: 'web',
    url: 'https://example.org/web.git',
    baseBranch: 'main',
    commands: [
      {
        ...commandRecipe('install', 'touch .prepared'),
        policy: 'required',
        purpose: 'install',
      },
      {
        ...commandRecipe('verify', `${node} verify.cjs`),
        endpointEnv: {
          API_URL: { service: 'web/api', endpoint: 'web' },
          UI_URL: { service: 'web/ui', endpoint: 'web' },
        },
      },
    ],
    services: [
      api,
      {
        ...api,
        id: 'ui',
        dependsOn: ['web/api'],
        endpointEnv: { API_URL: { service: 'web/api', endpoint: 'web' } },
      },
    ],
    environment: { version: 1, capabilities: [structuredClone(capability)] },
  };
  const receipts: Array<{ label: string; result: unknown }> = [];
  const commands: string[] = [];
  const backgroundProcesses: Array<{ command: string; pid: number }> = [];
  const exec = async (
    command: string,
    background = false,
    timeoutMs?: number,
  ) => {
    commands.push(command);
    const child = startCommand(command, { cwd: root, background, timeoutMs });
    children.push(child);
    try {
      const result = await child.result;
      if ('pid' in result)
        backgroundProcesses.push({ command, pid: result.pid });
      return result;
    } catch {
      return { exitCode: 124, stdout: '', stderr: '' };
    } finally {
      if (!background) await child.stop();
    }
  };
  const ctx = {
    ports: [],
    replaying: false,
    stage: vi.fn(),
    exec: ((
      command: string,
      opts?: { background?: boolean; timeoutMs?: number },
    ) =>
      exec(
        command,
        opts?.background,
        opts?.timeoutMs,
      )) as WorkflowContext['exec'],
    step: async <T>(label: string, work: () => T | Promise<T>) => {
      const result = await work();
      receipts.push({ label, result });
      return result;
    },
  };
  const input = {
    members: [{ name: 'web', path: 'web', lead: true }],
  } as WorkflowInput;
  const execution = new WorkspaceExecution(ctx, input, [repo], root, true);
  return {
    root,
    repoDir,
    repo,
    ctx,
    input,
    execution,
    receipts,
    commands,
    exec,
    backgroundProcesses,
  };
}
it('verifies documented local login and feature reachability with real dependent services and concurrent dynamic ports', async () => {
  const fixtures = await Promise.all([fixture(), fixture()]);
  const results = await Promise.all(
    fixtures.map((f) =>
      ensureEnvironment(f.ctx, f.execution, {
        label: 'baseline',
        allowSetup: true,
      }),
    ),
  );
  expect(results.map((r) => r.status)).toEqual(['ready', 'ready']);
  const urls = results.flatMap((r) =>
    r.status === 'ready'
      ? Object.values(r.context.endpoints).flatMap(Object.values)
      : [],
  );
  expect(new Set(urls).size).toBe(4);
  expect(results[0]).toMatchObject({
    context: {
      capabilities: [
        {
          checks: ['login', 'feature'],
          fixture: 'simulated',
          authentication: { reference: 'README.md' },
        },
      ],
    },
  });
  for (const f of fixtures) {
    expect(JSON.stringify(f.receipts)).not.toContain(
      'secret-must-not-be-retained',
    );
    expect(JSON.stringify(f.receipts)).not.toContain('local-development-only');
    await f.execution.stop('done');
    expect(await readFile(join(f.repoDir, '.prepared'), 'utf8')).toBe('');
    expect(
      (await readdir(f.root)).some((name) =>
        name.startsWith('environment-probe-'),
      ),
    ).toBe(false);
  }
  await vi.waitFor(async () => {
    for (const url of urls) await expect(fetch(url)).rejects.toThrow();
  });
});
it.each([
  ['', 'verification'],
  [
    JSON.stringify({
      status: 'passed',
      checks: [{ id: 'login', passed: true }],
    }),
    'verification',
  ],
  [JSON.stringify({ status: 'blocked', reason: 'unsupported' }), 'unsupported'],
])('never accepts unsupported or unexecuted evidence %s', (stdout, code) => {
  expect(
    interpretVerification('web/login', capability, { exitCode: 0, stdout }),
  ).toMatchObject({ status: 'blocked', blocker: { code } });
});
it('identifies the failed configured assertion in a sanitized verifier receipt', () => {
  const result = interpretVerification('web/login', capability, {
    exitCode: 0,
    stdout: JSON.stringify({
      status: 'failed',
      checks: [
        { id: 'login', executed: true, passed: true },
        { id: 'feature', executed: true, passed: false },
      ],
    }),
  });
  expect(result).toMatchObject({
    status: 'blocked',
    blocker: { code: 'verification' },
  });
  if (result?.status !== 'blocked') throw new Error('Expected a blocker.');
  expect(result.blocker.action).toContain('feature');
});
it('does not provision without authorization and classifies human blockers without retrying', async () => {
  const f = await fixture();
  expect(
    await ensureEnvironment(f.ctx, f.execution, {
      label: 'baseline',
      allowSetup: false,
    }),
  ).toMatchObject({
    status: 'blocked',
    blocker: { kind: 'human', code: 'authorization' },
  });
  expect(f.commands).toEqual([]);
  f.repo.commands[1].command = `printf '%s' '${JSON.stringify({ status: 'blocked', reason: 'credentials', detail: 'never-log-this-secret' })}'`;
  const result = await ensureEnvironment(f.ctx, f.execution, {
    label: 'baseline',
    allowSetup: true,
  });
  expect(result, JSON.stringify(f.receipts)).toMatchObject({
    status: 'blocked',
    blocker: { kind: 'human', code: 'credentials' },
  });
  expect(f.receipts.filter((r) => r.label.endsWith(': evidence'))).toHaveLength(
    1,
  );
  expect(JSON.stringify(f.receipts)).not.toContain('never-log-this-secret');
});
it('bounds missing browser prerequisites independently of product iterations', async () => {
  const f = await fixture();
  f.repo.environment.capabilities = [
    { ...capability, id: 'browser', kind: 'browser', services: [], setup: [] },
  ];
  f.repo.commands[1] = {
    ...commandRecipe('verify', 'rocky-nonexistent-browser-tool'),
    timeoutMs: 1000,
  };
  const result = await ensureEnvironment(f.ctx, f.execution, {
    label: 'browser',
    allowSetup: true,
    maxRepairs: 100,
  });
  expect(result.status).toBe('blocked');
  expect(f.receipts.filter((r) => r.label.endsWith(': evidence'))).toHaveLength(
    2,
  );
  expect(f.ctx.stage).toHaveBeenCalledWith('Environment: repairing');
});
it('restarts crashed services with fresh endpoints and leaves unrelated data intact', async () => {
  const f = await fixture();
  const first = await ensureEnvironment(f.ctx, f.execution, {
    label: 'first',
    allowSetup: true,
  });
  expect(first.status, JSON.stringify(f.receipts)).toBe('ready');
  const crashed = f.backgroundProcesses.findLast((entry) =>
    entry.command.includes('server.cjs'),
  );
  if (!crashed) throw Error('Expected a started service.');
  process.kill(-crashed.pid, 'SIGTERM');
  await writeFile(join(f.root, 'persistent-data'), 'keep');
  const second = await ensureEnvironment(f.ctx, f.execution, {
    label: 'second',
    allowSetup: true,
  });
  expect(second.status).toBe('ready');
  if (first.status === 'ready' && second.status === 'ready')
    expect(second.context.endpoints).not.toEqual(first.context.endpoints);
  expect(await readFile(join(f.root, 'persistent-data'), 'utf8')).toBe('keep');
  await f.execution.stop('done');
});
it('uses the current setup budget when a replayed allowance is stale', async () => {
  const f = await fixture();
  f.repo.commands[0].timeoutMs = 1_800_000;
  const step = f.ctx.step;
  vi.spyOn(f.ctx, 'step').mockImplementation(async (label, work) =>
    label.includes('setup allowance') ? 1 : step(label, work),
  );
  const probe = f.execution.probe.bind(f.execution);
  const timeouts: number[] = [];
  vi.spyOn(f.execution, 'probe').mockImplementation(
    async (id, timeoutMs, checks, secretEnv) => {
      if (id === 'web/install') {
        timeouts.push(timeoutMs);
        await writeFile(join(f.repoDir, '.prepared'), '');
        return { exitCode: 0, stdout: '' };
      }
      return probe(id, timeoutMs, checks, secretEnv);
    },
  );
  const result = await ensureEnvironment(f.ctx, f.execution, {
    label: 'baseline',
    allowSetup: true,
  });
  expect(result.status).toBe('ready');
  expect(timeouts[0]).toBeGreaterThan(120_000);
  await f.execution.stop('done');
}, 15_000);
it('keeps a recorded zero setup allowance on the same replay path', async () => {
  const f = await fixture();
  const step = f.ctx.step;
  vi.spyOn(f.ctx, 'step').mockImplementation(async (label, work) =>
    label.includes('setup allowance') ? 0 : step(label, work),
  );
  const probe = vi.spyOn(f.execution, 'probe');
  const result = await ensureEnvironment(f.ctx, f.execution, {
    label: 'baseline',
    allowSetup: true,
    maxRepairs: 0,
  });
  expect(result).toMatchObject({
    status: 'blocked',
    blocker: { capability: 'web/install', code: 'budget' },
  });
  expect(probe).not.toHaveBeenCalled();
});
it.each([false, true])(
  'replays environment receipts on polls and checks live setup on working Boots (broken setup: %s)',
  async (breakSetup) => {
    const f = await fixture();
    // First verifier invocation fails; the environment recovery reruns it, succeeds,
    // and records both attempts. Replaying must consume those same receipts.
    f.repo.commands[1].command = `[ -f .probe-attempt ] && ${node} verify.cjs || { touch .probe-attempt; printf '{}'; }`;
    const journalPath = join(f.root, 'journal.jsonl');
    let done = false;
    let implementations = 0;
    const boot = (poll = false) =>
      runBoot({
        journalPath,
        poll,
        workflow: async (runner) => {
          const ctx = createWorkflowContext(
            runner,
            {
              issue: {
                identifier: 'TEST-1',
                title: '',
                description: '',
                labels: [],
                url: '',
              },
              branch: 'test',
              ports: [],
            },
            {
              exec: (cmd, background, timeoutMs) =>
                f.exec(cmd, background, timeoutMs),
              changedFiles: async () => [],
              external: () => ({
                checkpoint: async () =>
                  done
                    ? {
                        status: 'done' as const,
                        result: { decision: 'approve' as const },
                      }
                    : { status: 'waiting' as const },
              }),
            },
          );
          await ctx.step('implementation', () => ++implementations);
          const execution = new WorkspaceExecution(
            ctx,
            f.input,
            [f.repo],
            f.root,
            true,
          );
          try {
            expect(
              (
                await ensureEnvironment(ctx, execution, {
                  label: 'baseline',
                  allowSetup: true,
                })
              ).status,
            ).toBe('ready');
          } finally {
            await execution.stop('done');
          }
          await ctx.checkpoint({ title: 'review', body: '' });
          return 'completed';
        },
      });
    const firstBoot = await boot();
    expect(firstBoot.status, JSON.stringify(firstBoot)).toBe('parked');
    const commandsBeforePoll = f.commands.length;
    const kill = vi.spyOn(process, 'kill');
    const poll = await boot(true);
    expect(poll.status, JSON.stringify(poll)).toBe('parked');
    done = true;
    const ready = await boot(true);
    expect(ready.status, JSON.stringify(ready)).toBe('ready');
    expect(f.commands).toHaveLength(commandsBeforePoll);
    expect(kill).not.toHaveBeenCalled();
    kill.mockRestore();
    if (breakSetup) f.repo.commands[0].command = 'exit 23';
    const replay = await boot();
    if (breakSetup) {
      expect(replay).toMatchObject({
        status: 'failed',
        error: {
          name: 'EnvironmentBlocked',
          message: expect.stringContaining('Previously verified setup failed'),
        },
      });
    } else {
      expect(replay.status).toBe('finished');
      expect(f.commands.length).toBeGreaterThan(commandsBeforePoll);
    }
    expect(implementations).toBe(1);
    const journal = await readJournal(journalPath);
    expect(JSON.stringify(journal)).not.toContain(
      'secret-must-not-be-retained',
    );
  },
);
it('verifies onboarding in isolated clones and preserves the source checkout', async () => {
  const f = await fixture();
  const paths = rockyPaths(join(f.root, 'rocky'));
  await mkdir(paths.reposDir, { recursive: true });
  const git = (args: string[], cwd = f.repoDir) =>
    promisify(execFile)('git', args, { cwd });
  await git(['init', '-b', 'main']);
  await git(['add', '.']);
  await git([
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.org',
    'commit',
    '-m',
    'fixture',
  ]);
  await git(['clone', '--bare', f.repoDir, paths.repo('web')], f.root);
  await git(['remote', 'set-url', 'origin', f.repo.url], paths.repo('web'));
  const profile = newRepositoryProfile({ id: 'test', repos: [f.repo] });
  profile.configurationVersion = 1;
  profile.automation = { ...automationSettings(), workspaceSetup: true };
  const jobs = new EnvironmentOnboarding(paths);
  try {
    await jobs.start(profile);
    await vi.waitFor(
      async () => expect((await jobs.read('test'))?.status).toBe('ready'),
      { timeout: 10000 },
    );
    expect((await jobs.read('test'))?.result).toMatchObject({
      status: 'ready',
      context: { capabilities: [{ kind: 'login' }] },
    });
    expect(await readdir(f.repoDir)).not.toContain('.prepared');
  } finally {
    await jobs.close();
  }
});
it('rejects stale endpoint files even when an unrelated live server answers at the old URL', async () => {
  const f = await fixture();
  const original = await ensureEnvironment(f.ctx, f.execution, {
    label: 'original',
    allowSetup: true,
  });
  expect(original.status).toBe('ready');
  if (original.status !== 'ready') return;
  const other = await fixture();
  await writeFile(
    join(other.repoDir, 'endpoint.json'),
    JSON.stringify({ url: original.context.endpoints['web/api'].web }),
  );
  other.repo.services = [
    {
      ...serviceRecipe('stale'),
      start: 'sleep 10',
      portEnv: '',
      endpoints: [
        {
          name: 'web',
          locator: {
            kind: 'json-file',
            path: 'endpoint.json',
            pointer: '/url',
          },
        },
      ],
      readiness: { endpoint: 'web', attempts: 2, intervalMs: 20 },
    },
  ];
  other.repo.commands[1] = commandRecipe('verify', "printf '{}'");
  other.repo.environment.capabilities = [
    { ...capability, services: ['web/stale'], setup: [] },
  ];
  const result = await ensureEnvironment(other.ctx, other.execution, {
    label: 'stale',
    allowSetup: true,
  });
  expect(result, JSON.stringify(other.receipts)).toMatchObject({
    status: 'blocked',
    blocker: { code: 'service' },
  });
  expect((await fetch(original.context.endpoints['web/api'].web)).ok).toBe(
    true,
  );
  await f.execution.stop('done');
});
it('bounds slow setup and rejects missing dependencies without treating them as product defects', async () => {
  const f = await fixture();
  f.repo.commands[0].command = 'sleep 10';
  const started = Date.now();
  const result = await ensureEnvironment(f.ctx, f.execution, {
    label: 'slow',
    allowSetup: true,
    timeoutMs: 100,
    maxRepairs: 0,
  });
  expect(result).toMatchObject({
    status: 'blocked',
    blocker: { kind: 'environment' },
  });
  expect(Date.now() - started).toBeLessThan(2000);
});
it('allows a configured long install to use its own timeout during baseline provisioning', async () => {
  const f = await fixture();
  f.repo.commands[0].timeoutMs = 1_800_000;
  const result = await ensureEnvironment(f.ctx, f.execution, {
    label: 'baseline',
    allowSetup: true,
  });
  expect(result.status).toBe('ready');
  expect(
    f.receipts.find((receipt) =>
      receipt.label.endsWith('setup allowance web/install'),
    )?.result,
  ).toBeGreaterThanOrEqual(1_800_000 - 1000);
  await f.execution.stop('done');
});
it('accepts a versioned catalog repair after exhaustion and preserves implementation on journal replay', async () => {
  const { createDeliveryOperations } = await import('../flow/delivery.js');
  const { JournalWriter } = await import('../run/writer.js');
  const f = await fixture();
  f.repo.commands[0].purpose = 'other';
  f.repo.environment.capabilities.push({
    ...capability,
    id: 'browser',
    kind: 'browser',
  });
  const settings = {
    ...defaultFlowSettings(),
    recoveryVersion: undefined, // Pre-recovery snapshot keeps its continuation boundary.
    pullRequests: 'lead' as const,
    environmentVersion: 1 as const,
    workspaceSetup: true,
    execution: [f.repo],
  };
  const repaired = structuredClone(f.repo);
  repaired.environment.capabilities.push({
    ...capability,
    id: 'task-fixture',
    kind: 'fixture',
    baseline: false,
  });
  const counts = new Map<string, number>();
  const actors = {
    call: async (name: string) => {
      counts.set(name, (counts.get(name) ?? 0) + 1);
      if (name === 'refiner')
        return {
          status: 'clear',
          delivery: { kind: 'pull-request', stateChanges: false },
          scope: 'test',
          decisions: [],
          acceptanceCriteria: [],
          outOfScope: [],
          summary: 'clear',
        };
      if (name === 'planner') return { steps: [], summary: 'plan' };
      if (name === 'ui-triage')
        return {
          isFrontend: true,
          selected: ['web/ui'],
          capabilities: ['web/task-fixture'],
          reason: 'feature fixture',
        };
      if (name === 'ui-planner')
        return {
          checks: [
            { id: 'feature', url: '/', action: 'Open', expected: 'Visible' },
          ],
          summary: '',
        };
      if (name === 'ui-inspector')
        return {
          results: [
            {
              id: 'feature',
              verdict: 'ok',
              note: 'Executed',
              observations: [],
              screenshots: [],
            },
          ],
          summary: 'passed',
        };
      return { summary: 'implemented' };
    },
  } as unknown as import('../flow/agents.js').DeliveryAgents;
  const journalPath = join(f.root, 'journal.jsonl');
  let implemented = 0,
    reviewed = 0;
  const boot = () =>
    runBoot({
      journalPath,
      workflow: async (runner) => {
        const ctx = createWorkflowContext(
          runner,
          {
            issue: {
              identifier: 'TEST-1',
              title: 'test',
              description: '',
              labels: [],
              url: '',
            },
            branch: 'test',
            ports: [],
          },
          {
            exec: (cmd, bg, timeout) =>
              /\bgit (push|diff)/.test(cmd)
                ? Promise.resolve({ exitCode: 0, stdout: '', stderr: '' })
                : f.exec(cmd, bg, timeout),
            changedFiles: async () => ['web/a.ts'],
            external: () =>
              ({
                post: async () => undefined,
                comment: async () => undefined,
                scm: {
                  openPr: async () => ({
                    headSha: 'head',
                    number: 1,
                    url: 'https://example.org/pr/1',
                  }),
                },
              }) as never,
          },
        );
        const journal = await readJournal(journalPath);
        const delivery = createDeliveryOperations(
          ctx,
          f.input,
          settings,
          join(f.root, 'snapshot'),
          Number(journal.getControl('review:continuations') ?? 0),
          journal.getControl('flow:repairs') as
            import('@rocky/local-contracts').FlowRepairRevision[] | undefined,
        );
        const journaledActors = {
          call: (
            name: Parameters<typeof actors.call>[0],
            options: Parameters<typeof actors.call>[1],
          ) => ctx.step(`agent ${name}`, () => actors.call(name, options)),
        } as typeof actors;
        await delivery('clarify', journaledActors);
        await delivery('plan', journaledActors);
        await delivery('implement', journaledActors);
        await ctx.step('completed implementation', () => ++implemented);
        await ctx.step('completed review', () => ++reviewed);
        const result = await delivery('ui', journaledActors);
        return result === 'exhausted' ? 'exhausted' : 'completed';
      },
    });
  const firstBoot = await boot();
  expect(firstBoot, JSON.stringify(firstBoot)).toMatchObject({
    status: 'finished',
    outcome: 'exhausted',
  });
  const before = await readFile(journalPath, 'utf8');
  await (
    await JournalWriter.open(journalPath)
  ).retry(
    'repair-environment',
    String((await readJournal(journalPath)).end?.seq),
    [],
    undefined,
    true,
    { execution: [repaired] },
  );
  expect(await boot()).toMatchObject({
    status: 'finished',
    outcome: 'completed',
  });
  expect((await readFile(journalPath, 'utf8')).startsWith(before)).toBe(true);
  expect(implemented).toBe(1);
  expect(reviewed).toBe(1);
  expect(counts.get('implementer')).toBe(1);
  expect(counts.get('fixer')).toBeUndefined();
});
it('requires explicit execution evidence for versioned UI success and supports blocked coverage', async () => {
  const { CheckResultsFor } = await import('../flow/schemas.js');
  const schema = CheckResultsFor([{ id: 'login' }], '/unused', 1);
  const result = {
    id: 'login',
    verdict: 'ok',
    note: 'not executed',
    screenshots: [],
    observations: [],
  };
  expect(schema.safeParse({ results: [result] }).success).toBe(false);
  expect(
    schema.safeParse({
      results: [{ ...result, verdict: 'blocked', reason: 'credentials' }],
    }).success,
  ).toBe(true);
  expect(
    CheckResultsFor([{ id: 'login' }], '/unused').safeParse({
      results: [result],
    }).success,
  ).toBe(true);
});
it('classifies a missing secret reference before running the login script', async () => {
  const f = await fixture();
  f.repo.environment.capabilities[0].authentication = {
    kind: 'secret-env',
    reference: 'ROCKY_TEST_UNAVAILABLE_CREDENTIAL',
  };
  const result = await ensureEnvironment(f.ctx, f.execution, {
    label: 'auth',
    allowSetup: true,
  });
  expect(result).toMatchObject({
    status: 'blocked',
    blocker: { kind: 'human', code: 'credentials' },
  });
  expect(f.receipts.filter((r) => r.label.endsWith(': evidence'))).toHaveLength(
    1,
  );
});
it('reports a missing configured service as a structured configuration blocker', async () => {
  const f = await fixture();
  f.repo.services[1].dependsOn = ['web/missing'];
  const result = await ensureEnvironment(f.ctx, f.execution, {
    label: 'missing',
    allowSetup: true,
  });
  expect(result).toMatchObject({
    status: 'blocked',
    blocker: { kind: 'environment', code: 'configuration' },
  });
  expect(f.commands).toEqual([]);
});
it('resolves numeric startup output without persisting arbitrary service output', async () => {
  const f = await fixture();
  const server = await readFile(join(f.repoDir, 'server.cjs'), 'utf8');
  await writeFile(
    join(f.repoDir, 'server.cjs'),
    server.replace(
      "}).listen(Number(process.env.PORT), '127.0.0.1');",
      "}).listen(0, '127.0.0.1', function () { console.log('private-output-must-not-be-logged'); console.log('Listening ' + this.address().port); });",
    ),
  );
  f.repo.services = f.repo.services.map((service) => ({
    ...service,
    portEnv: '',
    endpoints: [
      {
        name: 'web',
        locator: { kind: 'output-regex', pattern: 'Listening (?<port>[0-9]+)' },
      },
    ],
  }));
  expect(
    (
      await ensureEnvironment(f.ctx, f.execution, {
        label: 'dynamic',
        allowSetup: true,
      })
    ).status,
  ).toBe('ready');
  expect(
    await readFile(join(f.root, 'service-web-api.log'), 'utf8'),
  ).not.toContain('private-output');
  await f.execution.stop('done');
});
it('starts setup service dependencies before running an authorized fixture recipe', async () => {
  const f = await fixture();
  f.repo.commands.push({
    ...commandRecipe(
      'seed',
      `${node} -e 'fetch(process.env.API_URL).then(r=>{if(!r.ok)process.exit(1)})'`,
    ),
    endpointEnv: { API_URL: { service: 'web/api', endpoint: 'web' } },
  });
  f.repo.environment.capabilities[0].setup.push('web/seed');
  expect(
    (
      await ensureEnvironment(f.ctx, f.execution, {
        label: 'fixture',
        allowSetup: true,
      })
    ).status,
  ).toBe('ready');
  expect(
    f.receipts.some((r) =>
      r.label.includes('prerequisites web/seed: endpoints web/api'),
    ),
  ).toBe(true);
  await f.execution.stop('done');
});

it.each([0, 1])(
  'waits for all capability checks without restarting an already listening service (exit %s)',
  async (failureExit) => {
    const f = await fixture();
    f.repo.commands[1].timeoutMs = 500;
    for (const service of f.repo.services)
      service.readiness = { endpoint: 'web', attempts: 4, intervalMs: 300 };
    f.repo.commands[1].command = `count=$(cat .verify-count 2>/dev/null || echo 0); count=$((count + 1)); echo "$count" > .verify-count; if [ "$count" -lt 3 ]; then printf '%s' '{"status":"failed","checks":[{"id":"login","executed":true,"passed":false}]}'; exit ${failureExit}; else ${node} verify.cjs; fi`;
    const result = await ensureEnvironment(f.ctx, f.execution, {
      label: 'slow-backend',
      allowSetup: true,
      maxRepairs: 0,
    });
    expect(result.status).toBe('ready');
    expect(
      f.receipts.filter((r) => r.label.includes('setup web/install')),
    ).toHaveLength(1);
    expect(await readFile(join(f.repoDir, '.verify-count'), 'utf8')).toBe(
      '3\n',
    );
    await f.execution.stop('done');
  },
);

it.each([true, false])(
  'repairs UI fixtures and provisions recap previews across journal replay (new snapshot=%s)',
  async (recapEnvironment) => {
    const { createDeliveryOperations } = await import('../flow/delivery.js');
    const f = await fixture();
    f.repo.environment.capabilities[0].kind = 'browser';
    f.repo.environment.capabilities[0].baseline = false;
    f.repo.commands.push({
      ...commandRecipe('seed', 'touch .fixture-ready'),
      policy: 'agent',
    });
    const calls: string[] = [];
    const agents = {
      call: async (role: string) => {
        calls.push(role);
        if (role === 'refiner')
          return {
            status: 'clear',
            scope: 'UI',
            decisions: [],
            acceptanceCriteria: [],
            outOfScope: [],
            delivery: { kind: 'pull-request', stateChanges: false },
          };
        if (role === 'planner') return { steps: [], summary: 'plan' };
        if (role === 'ui-triage')
          return { isFrontend: true, selected: ['web/ui'], reason: 'UI' };
        if (role === 'ui-planner')
          return {
            checks: [
              { id: 'feature', url: '/', action: 'Open', expected: 'Visible' },
            ],
            summary: 'check',
          };
        if (role === 'fixer')
          return {
            action: 'repaired',
            commands: ['web/seed'],
            summary: 'Use the documented local seed.',
          };
        if (role === 'ui-inspector') {
          const ready = await readFile(
            join(f.repoDir, '.fixture-ready'),
            'utf8',
          ).then(
            () => true,
            () => false,
          );
          return {
            results: [
              {
                id: 'feature',
                verdict: ready ? 'ok' : 'blocked',
                executed: ready,
                reason: 'environment',
                note: 'Missing local fixture',
                observations: [],
                screenshots: [],
              },
            ],
            summary: 'inspect',
          };
        }
        return { summary: 'done' };
      },
    } as unknown as import('../flow/agents.js').DeliveryAgents;
    f.repo.environment.capabilities.push({
      ...capability,
      id: 'runtime',
      kind: 'runtime',
      services: [],
      verify: 'web/runtime',
      setup: [],
      checks: ['runtime'],
    });
    f.repo.commands.push(
      commandRecipe(
        'runtime',
        `printf '%s' '{"status":"passed","checks":[{"id":"runtime","executed":true,"passed":true}]}'`,
      ),
    );
    let approved = false;
    let captures = 0;
    const journalPath = join(f.root, 'recovery-journal.jsonl');
    const boot = () =>
      runBoot({
        journalPath,
        workflow: async (runner) => {
          const ctx = createWorkflowContext(
            runner,
            {
              issue: {
                identifier: 'TEST-1',
                title: 'UI',
                description: '',
                labels: [],
                url: '',
              },
              branch: 'test',
              ports: [],
            },
            {
              exec: (cmd, background, timeout) =>
                /git (push|diff|rev-parse)/.test(cmd)
                  ? Promise.resolve({ exitCode: 0, stdout: 'head', stderr: '' })
                  : f.exec(cmd, background, timeout),
              changedFiles: async () => ['web/view.ts'],
              external: () =>
                ({
                  post: async () => undefined,
                  comment: async () => undefined,
                  scm: {
                    openPr: async () => ({ headSha: 'head', repo: 'web' }),
                  },
                  visualRecap: async (input: {
                    scope: {
                      environment?: {
                        endpoints: Record<string, Record<string, string>>;
                      };
                    };
                  }) =>
                    ctx.step('capture preview', async () => {
                      captures++;
                      const endpoints = input.scope.environment?.endpoints;
                      if (recapEnvironment) {
                        expect(endpoints?.['web/ui']?.web).toBeTruthy();
                        expect((await fetch(endpoints!['web/ui'].web)).ok).toBe(
                          true,
                        );
                      } else expect(endpoints).toBeUndefined();
                      return { id: 'recap', url: 'https://example.org/recap' };
                    }),
                  checkpoint: async () =>
                    approved
                      ? { status: 'done', result: { decision: 'approve' } }
                      : { status: 'waiting' },
                }) as never,
            },
          );
          const journaled = {
            recap: () => ({}),
            call: (role: string, options: Parameters<typeof agents.call>[1]) =>
              ctx.step(`agent ${role}`, () => agents.call(role, options)),
          } as typeof agents;
          const run = createDeliveryOperations(
            ctx,
            f.input,
            {
              ...defaultFlowSettings(),
              recoveryVersion: 1,
              ...(recapEnvironment
                ? { recapEnvironmentVersion: 1 as const }
                : { recapEnvironmentVersion: undefined }),
              environmentVersion: 1,
              workspaceSetup: true,
              pullRequests: 'lead',
              execution: [f.repo],
            },
            join(f.root, 'snapshot'),
          );
          await run('clarify', journaled);
          await run('plan', journaled);
          await run('implement', journaled);
          expect(await run('ui', journaled)).toBe('retry');
          expect(await run('ui', journaled)).toBe('next');
          expect(await run('recap', journaled)).toBe('next');
          await ctx.checkpoint({ title: 'review', body: '' });
          return 'completed';
        },
      });
    const first = await boot();
    expect(first, JSON.stringify(first)).toMatchObject({ status: 'parked' });
    expect(calls.filter((role) => role === 'fixer')).toHaveLength(1);
    expect(await readFile(join(f.repoDir, '.fixture-ready'), 'utf8')).toBe('');
    approved = true;
    const replay = await boot();
    expect(replay, JSON.stringify(replay)).toMatchObject({
      status: 'finished',
      outcome: 'completed',
    });
    expect(calls.filter((role) => role === 'fixer')).toHaveLength(1);
    expect(calls.filter((role) => role === 'ui-inspector')).toHaveLength(2);
    expect(captures).toBe(1);
  },
);

it.each(['repaired', 'blocked', 'manual', 'ineffective'] as const)(
  'diagnoses baseline setup with a bounded agent repair (%s)',
  async (mode) => {
    const { createDeliveryOperations } = await import('../flow/delivery.js');
    const f = await fixture();
    f.repo.commands[0].command = '[ -f .prerequisite ] && touch .prepared';
    f.repo.commands.push({
      ...commandRecipe('manual', 'touch .forbidden'),
      policy: 'manual',
    });
    let repairs = 0;
    const actors = {
      call: async (role: string, options?: { label?: string }) => {
        if (role === 'refiner')
          return {
            status: 'clear',
            scope: 'test',
            decisions: [],
            acceptanceCriteria: [],
            outOfScope: [],
            delivery: { kind: 'pull-request', stateChanges: false },
          };
        if (role === 'planner') return { steps: [], summary: 'plan' };
        if (options?.label?.startsWith('Environment diagnosis')) {
          repairs++;
          if (mode === 'repaired')
            await writeFile(join(f.repoDir, '.prerequisite'), '');
          return {
            action: mode === 'blocked' ? 'blocked' : 'repaired',
            commands: mode === 'manual' ? ['web/manual'] : [],
            summary: 'Diagnostic result',
          };
        }
        return { summary: 'implementation' };
      },
    } as unknown as import('../flow/agents.js').DeliveryAgents;
    const ctx = {
      ...f.ctx,
      issue: {
        identifier: 'TEST-1',
        title: 'test',
        description: '',
        url: '',
        labels: [],
      },
      post: async () => undefined,
      comment: async () => undefined,
      exec: ((cmd: string, opts?: { background?: boolean }) =>
        /git (push|diff|rev-parse)/.test(cmd)
          ? Promise.resolve({ exitCode: 0, stdout: 'head', stderr: '' })
          : f.exec(cmd, opts?.background)) as WorkflowContext['exec'],
      scm: { openPr: async () => ({ repo: 'web', headSha: 'head' }) },
    } as unknown as WorkflowContext;
    const run = createDeliveryOperations(
      ctx,
      f.input,
      {
        ...defaultFlowSettings(),
        recoveryVersion: 1,
        environmentVersion: 1,
        workspaceSetup: true,
        pullRequests: 'lead',
        execution: [f.repo],
      },
      join(f.root, 'snapshot'),
    );
    await run('clarify', actors);
    await run('plan', actors);
    if (mode === 'manual')
      await expect(run('implement', actors)).rejects.toThrow(
        'cannot execute manual commands',
      );
    else
      expect(await run('implement', actors)).toBe(
        mode === 'repaired' ? 'next' : 'exhausted',
      );
    expect(repairs).toBe(mode === 'ineffective' ? 2 : 1);
    expect(await readdir(f.repoDir)).not.toContain('.forbidden');
  },
);
