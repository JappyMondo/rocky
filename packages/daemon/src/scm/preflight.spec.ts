import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { createGitHubScm, createGitLabScm, runPreflight } from './index.js';
import { runBoot } from '../run/replay.js';
import { openJournal } from '../run/journal.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

it.each(['github', 'gitlab'])(
  'probes %s read-only and derives draft authority from write evidence',
  async (platform) => {
    const calls: string[] = [];
    const fetcher: typeof fetch = async (url, init) => {
      expect(init?.method).toBe('GET');
      const path = new URL(String(url)).pathname;
      calls.push(path);
      let value: unknown;
      if (path.endsWith('/user'))
        value = { id: 1, login: 'dev', username: 'dev' };
      else if (path.includes('/personal_access_tokens/'))
        value = { scopes: ['api'] };
      else if (path.includes('/rules/branches/')) value = [];
      else if (path.includes('/protected_branches'))
        value = [
          {
            name: 'main',
            merge_access_levels: [{ access_level: 30 }],
            push_access_levels: [{ access_level: 30 }],
            allow_force_push: false,
          },
        ];
      else if (path.includes('/branches/'))
        value = {
          name: path.endsWith('/main') ? 'main' : 'ng-524',
          protected: platform === 'gitlab' && path.endsWith('/main'),
          can_push: true,
        };
      else if (path.endsWith('/pulls') || path.endsWith('/merge_requests'))
        value = [];
      else if (path.endsWith('/version')) value = { version: '19.1.0-ee' };
      else
        value =
          platform === 'github'
            ? { permissions: { push: true } }
            : {
                id: 5,
                permissions: {
                  project_access: { access_level: 30 },
                  group_access: null,
                },
                merge_trains_enabled: false,
              };
      return Response.json(value, { headers: { 'x-oauth-scopes': 'repo' } });
    };
    const options = {
      repo: { id: 'member', project: 'team/repo', baseBranch: 'main' },
      branch: 'ng-524',
      token: 'fixture',
      fetch: fetcher,
    };
    const adapter =
      platform === 'github'
        ? createGitHubScm(options)
        : createGitLabScm(options);
    const result = await adapter.probe(new AbortController().signal);
    expect(result).toMatchObject({
      repo: 'member',
      platform,
      merge: { status: 'allowed' },
      sourcePush: { status: 'allowed' },
      draft: { status: 'allowed' },
    });
    expect(calls.length).toBeGreaterThan(3);
  },
);

it('journals all members and the MCP refresh callback once, with no re-probe on poll Boots', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rocky-preflight-'));
  dirs.push(dir);
  const journalPath = join(dir, 'journal.jsonl');
  let requests = 0;
  let refreshes = 0;
  const signal = new AbortController().signal;
  const fetcher: typeof fetch = async (url) => {
    requests++;
    const path = new URL(String(url)).pathname;
    const value = path.endsWith('/user')
      ? { login: 'dev' }
      : path.endsWith('/pulls')
        ? [{ draft: true }]
        : path.includes('/rules/')
          ? []
          : path.includes('/branches/')
            ? { protected: false }
            : { permissions: { push: true } };
    return Response.json(value, { headers: { 'x-oauth-scopes': 'repo' } });
  };
  const boot = (poll = false) =>
    runBoot({
      journalPath,
      poll,
      signal,
      workflow: async (steps) => {
        await runPreflight(steps, {
          signal,
          members: ['one', 'two'].map((id) =>
            createGitHubScm({
              repo: { id, project: `team/${id}`, baseBranch: 'main' },
              branch: 'issue',
              token: 'fixture',
              fetch: fetcher,
              signal,
            }),
          ),
          refreshMcp: async (refreshSignal) => {
            expect(refreshSignal.aborted).toBe(false);
            refreshes++;
            return ['calendar'];
          },
        });
        await steps.step('checkpoint', {}, async () => ({ status: 'waiting' }));
        return 'merged';
      },
    });
  expect(await boot()).toMatchObject({ status: 'parked' });
  const firstRequests = requests;
  expect(await boot(true)).toMatchObject({ status: 'parked' });
  expect(requests).toBe(firstRequests);
  expect(refreshes).toBe(1);
  expect((await openJournal(journalPath)).latest(0)).toMatchObject({
    step: 'preflight',
    status: 'done',
    result: {
      repos: [{ repo: 'one' }, { repo: 'two' }],
      refreshedMcp: ['calendar'],
    },
  });
});

it('fails unknown draft capability and does not wait past its budget for a non-cooperative probe', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rocky-preflight-budget-'));
  dirs.push(dir);
  const journalPath = join(dir, 'journal.jsonl');
  const signal = new AbortController().signal;
  const result = await runBoot({
    journalPath,
    signal,
    workflow: async (steps) => {
      await runPreflight(steps, {
        signal,
        timeoutMs: 20,
        members: [
          {
            repo: { id: 'one' },
            probe: async () => new Promise<never>(() => undefined),
          },
        ],
        refreshMcp: async () => [],
      });
      return 'merged';
    },
  });
  expect(result).toMatchObject({
    status: 'failed',
    error: {
      message: expect.stringContaining('probe exceeded the 20 ms budget'),
    },
  });
});

it('rejects a readable-but-unverified native draft state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rocky-preflight-draft-'));
  dirs.push(dir);
  const journalPath = join(dir, 'journal.jsonl');
  const signal = new AbortController().signal;
  const result = await runBoot({
    journalPath,
    signal,
    workflow: async (steps) => {
      await runPreflight(steps, {
        signal,
        members: [
          {
            repo: { id: 'one' },
            probe: async () => ({
              repo: 'one',
              platform: 'github' as const,
              merge: { status: 'allowed' as const, source: 'fixture', fix: '' },
              rebase: {
                status: 'allowed' as const,
                source: 'fixture',
                fix: '',
              },
              sourcePush: {
                status: 'allowed' as const,
                source: 'fixture',
                fix: '',
              },
              draft: {
                status: 'unknown' as const,
                source: 'fixture',
                fix: 'verify draft state',
              },
            }),
          },
        ],
        refreshMcp: async () => [],
      });
      return 'merged';
    },
  });
  expect(result).toMatchObject({
    status: 'failed',
    error: { message: expect.stringContaining('draft state unknown') },
  });
});

it('fails closed when a probe is returned for a different frozen member', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rocky-preflight-member-'));
  dirs.push(dir);
  const result = await runBoot({
    journalPath: join(dir, 'journal.jsonl'),
    signal: new AbortController().signal,
    workflow: async (steps) => {
      await runPreflight(steps, {
        signal: new AbortController().signal,
        members: [
          {
            repo: { id: 'one' },
            probe: async () => ({
              repo: 'two',
              platform: 'github' as const,
              merge: { status: 'allowed' as const, source: 'fixture', fix: '' },
              rebase: {
                status: 'allowed' as const,
                source: 'fixture',
                fix: '',
              },
              sourcePush: {
                status: 'allowed' as const,
                source: 'fixture',
                fix: '',
              },
              draft: { status: 'allowed' as const, source: 'fixture', fix: '' },
            }),
          },
        ],
        refreshMcp: async () => [],
      });
      return 'merged';
    },
  });
  expect(result).toMatchObject({
    status: 'failed',
    error: { message: expect.stringContaining('probe returned repo two') },
  });
  expect(
    (await openJournal(join(dir, 'journal.jsonl'))).latest(0),
  ).toMatchObject({
    result: { repos: [] },
  });
});
