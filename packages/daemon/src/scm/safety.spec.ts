import { expect, it } from 'vitest';
import { createGitHubScm, createGitLabScm } from './index.js';
import { githubOptions, githubPull, scriptedFetch } from './scm.fixtures.js';

const pr = {
  repo: 'lead',
  id: 'PR_one',
  number: 7,
  url: githubPull.html_url,
  sourceBranch: 'ng-524',
  baseBranch: 'main',
  headSha: 'abc',
  state: 'open' as const,
  draft: true,
};

it('uses conditional REST reads across recreated Boot adapters and preserves 304 CI results', async () => {
  const values = new Map<string, unknown>([
    ['/repos/team/repo/pulls/7', githubPull],
    [
      '/repos/team/repo/commits/abc/check-runs',
      {
        check_runs: [
          {
            id: 1,
            name: 'test',
            head_sha: 'abc',
            status: 'completed',
            conclusion: 'success',
            details_url: null,
          },
        ],
      },
    ],
    ['/repos/team/repo/commits/abc/statuses', []],
    ['/repos/team/repo/actions/runs', { workflow_runs: [] }],
  ]);
  const observed = new Set<string>();
  let conditional = 0;
  const fetcher: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (observed.has(path)) {
      expect(new Headers(init?.headers).get('if-none-match')).toBe('"v1"');
      conditional++;
      return new Response(null, { status: 304 });
    }
    observed.add(path);
    return Response.json(values.get(path), { headers: { etag: '"v1"' } });
  };
  for (let boot = 0; boot < 2; boot++) {
    const adapter = createGitHubScm({ ...githubOptions, fetch: fetcher });
    expect(await adapter.waitForCi(pr, { logTailLines: 2 })).toMatchObject({
      status: 'done',
      result: { status: 'passed' },
    });
  }
  expect(conditional).toBe(6);
});

it('honors Retry-After across Boot adapters instead of repeatedly spending quota', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    return Response.json({}, { status: 429, headers: { 'retry-after': '60' } });
  };
  for (let boot = 0; boot < 2; boot++)
    await expect(
      createGitHubScm({ ...githubOptions, fetch: fetcher }).openPr({
        title: 'x',
        body: '',
      }),
    ).rejects.toMatchObject({ refusal: { reason: 'rate_limited' } });
  expect(calls).toBe(1);
});

it.each(['github', 'gitlab'])(
  'stops %s requests before any effect after cancellation',
  async (platform) => {
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    let requests = 0;
    const options = {
      ...githubOptions,
      signal: controller.signal,
      fetch: async () => {
        requests++;
        return Response.json({});
      },
    };
    const adapter =
      platform === 'github'
        ? createGitHubScm(options)
        : createGitLabScm(options);
    await expect(adapter.openPr({ title: 'change', body: '' })).rejects.toThrow(
      'stop',
    );
    expect(requests).toBe(0);
  },
);

it('refuses stale CI rather than reporting a green old head', async () => {
  const transport = scriptedFetch([
    {
      path: '/repos/team/repo/pulls/7',
      value: { ...githubPull, head: { ...githubPull.head, sha: 'new' } },
    },
  ]);
  await expect(
    createGitHubScm({ ...githubOptions, fetch: transport.fetch }).waitForCi(
      pr,
      { logTailLines: 2 },
    ),
  ).rejects.toMatchObject({
    refusal: { reason: 'head_changed', pr: { headSha: 'new' } },
  });
  transport.done();
});

it('does not treat absent CI as passed', async () => {
  const transport = scriptedFetch([
    { path: '/repos/team/repo/pulls/7', value: githubPull },
    {
      path: '/repos/team/repo/commits/abc/check-runs?filter=latest&per_page=100&page=1',
      value: { check_runs: [] },
    },
    {
      path: '/repos/team/repo/commits/abc/statuses?per_page=100&page=1',
      value: [],
    },
    {
      path: '/repos/team/repo/actions/runs?head_sha=abc&per_page=100&page=1',
      value: { workflow_runs: [] },
    },
    { path: '/repos/team/repo/pulls/7', value: githubPull },
  ]);
  expect(
    await createGitHubScm({
      ...githubOptions,
      fetch: transport.fetch,
    }).waitForCi(pr, { logTailLines: 0 }),
  ).toEqual({ status: 'waiting' });
  transport.done();
});
