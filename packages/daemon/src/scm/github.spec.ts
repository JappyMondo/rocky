import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { createGitHubScm } from './index.js';
import { githubOptions, githubPull, scriptedFetch } from './scm.fixtures.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

it('flips native draft state through GraphQL and updates the content description', async () => {
  const transport = scriptedFetch([
    { path: '/repos/team/repo/pulls/7', value: githubPull },
    {
      path: '/repos/team/repo/pulls/7',
      method: 'PATCH',
      body: { body: 'Reviewed change' },
      value: githubPull,
    },
    { path: '/repos/team/repo/pulls/7', value: githubPull },
    {
      path: '/graphql',
      method: 'POST',
      value: {
        data: {
          markPullRequestReadyForReview: { pullRequest: { id: 'PR_one' } },
        },
      },
    },
    {
      path: '/repos/team/repo/pulls/7',
      value: { ...githubPull, draft: false },
    },
  ]);
  const adapter = createGitHubScm({ ...githubOptions, fetch: transport.fetch });
  const result = await adapter.markDraft(githubPr(), false, {
    body: 'Reviewed change',
  });
  expect(result.draft).toBe(false);
  expect(transport.calls[3].body).toMatchObject({
    variables: { input: { pullRequestId: 'PR_one' } },
  });
  expect(transport.calls[3].body.query).toContain(
    'markPullRequestReadyForReview',
  );
  transport.done();
});

function githubPr() {
  return {
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
}

it('reports failed job and step names and only downloads the requested log tail', async () => {
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
      value: {
        workflow_runs: [
          {
            id: 20,
            name: 'CI',
            head_sha: 'abc',
            status: 'completed',
            conclusion: 'failure',
          },
        ],
      },
    },
    {
      path: '/repos/team/repo/actions/runs/20/jobs?filter=latest&per_page=100&page=1',
      value: {
        jobs: [
          {
            id: 21,
            name: 'test',
            conclusion: 'failure',
            steps: [
              { name: 'Install', conclusion: 'success' },
              { name: 'Test', conclusion: 'failure' },
            ],
          },
          { id: 22, name: 'lint', conclusion: 'success', steps: [] },
        ],
      },
    },
    {
      path: '/repos/team/repo/actions/jobs/21/logs',
      text: 'setup\nold\nassertion\nfailed\n',
    },
    { path: '/repos/team/repo/pulls/7', value: githubPull },
  ]);
  const result = await createGitHubScm({
    ...githubOptions,
    fetch: transport.fetch,
  }).waitForCi(githubPr(), { logTailLines: 2 });
  expect(result).toEqual({
    status: 'done',
    result: {
      status: 'failed',
      headSha: 'abc',
      failedJobs: [
        {
          id: '21',
          name: 'test',
          failedSteps: ['Test'],
          logTail: 'assertion\nfailed',
        },
      ],
    },
  });
  transport.done();
});

it.each([false, true])(
  'ensures guarded auto-merge/queue once but waits for actual merge (queue=%s)',
  async (queue) => {
    const node = {
      id: 'PR_one',
      headRefOid: 'abc',
      state: 'OPEN',
      isDraft: false,
      mergeStateStatus: 'CLEAN',
      reviewDecision: null,
      isMergeQueueEnabled: queue,
      isInMergeQueue: false,
      autoMergeRequest: null,
      repository: {
        autoMergeAllowed: true,
        squashMergeAllowed: true,
        mergeCommitAllowed: false,
        rebaseMergeAllowed: false,
      },
    };
    const operation = queue
      ? 'enqueuePullRequest'
      : 'enablePullRequestAutoMerge';
    const transport = scriptedFetch([
      {
        path: '/repos/team/repo/pulls/7',
        value: { ...githubPull, draft: false },
      },
      { path: '/graphql', method: 'POST', value: { data: { node } } },
      {
        path: '/graphql',
        method: 'POST',
        value: {
          data: {
            [operation]: queue
              ? { mergeQueueEntry: { id: 'Q1', pullRequest: { id: 'PR_one' } } }
              : { pullRequest: { id: 'PR_one' } },
          },
        },
      },
      {
        path: '/repos/team/repo/pulls/7',
        value: { ...githubPull, draft: false },
      },
      {
        path: '/graphql',
        method: 'POST',
        value: {
          data: {
            node: {
              ...node,
              isInMergeQueue: queue,
              autoMergeRequest: queue ? null : { enabledAt: 'now' },
            },
          },
        },
      },
      {
        path: '/repos/team/repo/pulls/7',
        value: { ...githubPull, draft: false },
      },
      {
        path: '/graphql',
        method: 'POST',
        value: { data: { node: { ...node, state: 'MERGED' } } },
      },
    ]);
    const adapter = createGitHubScm({
      ...githubOptions,
      fetch: transport.fetch,
    });
    expect(await adapter.armAutoMerge({ ...githubPr(), draft: false })).toEqual(
      { status: 'waiting' },
    );
    expect(await adapter.armAutoMerge({ ...githubPr(), draft: false })).toEqual(
      { status: 'waiting' },
    );
    expect(
      await adapter.armAutoMerge({ ...githubPr(), draft: false }),
    ).toMatchObject({
      status: 'done',
      result: { status: 'merged', pr: { state: 'merged' } },
    });
    expect(transport.calls[2].body.variables?.input).toMatchObject({
      pullRequestId: 'PR_one',
      expectedHeadOid: 'abc',
    });
    expect(transport.calls[2].body.query).toContain(operation);
    transport.done();
  },
);

it.each([false, true])(
  'refuses an unbound auto-merge response instead of reporting waiting (queue=%s)',
  async (queue) => {
    const node = {
      id: 'PR_one',
      headRefOid: 'abc',
      state: 'OPEN',
      isDraft: false,
      mergeStateStatus: 'CLEAN',
      reviewDecision: null,
      isMergeQueueEnabled: queue,
      isInMergeQueue: false,
      autoMergeRequest: null,
      repository: {
        autoMergeAllowed: true,
        squashMergeAllowed: true,
        mergeCommitAllowed: false,
        rebaseMergeAllowed: false,
      },
    };
    const transport = scriptedFetch([
      {
        path: '/repos/team/repo/pulls/7',
        value: { ...githubPull, draft: false },
      },
      { path: '/graphql', method: 'POST', value: { data: { node } } },
      {
        path: '/graphql',
        method: 'POST',
        value: {
          data: queue
            ? { enqueuePullRequest: { mergeQueueEntry: null } }
            : {
                enablePullRequestAutoMerge: { pullRequest: { id: 'PR_other' } },
              },
        },
      },
    ]);
    await expect(
      createGitHubScm({
        ...githubOptions,
        fetch: transport.fetch,
      }).armAutoMerge({
        ...githubPr(),
        draft: false,
      }),
    ).rejects.toMatchObject({ refusal: { reason: 'invalid_response' } });
    transport.done();
  },
);

it('requests a guarded branch update and waits for the new head instead of treating 202 as success', async () => {
  const transport = scriptedFetch([
    {
      path: '/repos/team/repo/pulls/7',
      value: { ...githubPull, mergeable_state: 'behind' },
    },
    {
      path: '/repos/team/repo/pulls/7/update-branch',
      method: 'PUT',
      body: { expected_head_sha: 'abc' },
      status: 202,
      value: { message: 'Updating' },
    },
    {
      path: '/repos/team/repo/pulls/7',
      value: {
        ...githubPull,
        mergeable_state: 'clean',
        head: { ...githubPull.head, sha: 'updated' },
      },
    },
  ]);
  const adapter = createGitHubScm({ ...githubOptions, fetch: transport.fetch });
  expect(await adapter.updateBranch(githubPr())).toEqual({ status: 'waiting' });
  expect(await adapter.updateBranch(githubPr())).toMatchObject({
    status: 'done',
    result: { status: 'updated', pr: { headSha: 'updated' } },
  });
  transport.done();
});

it('does not update a retargeted PR handle', async () => {
  const transport = scriptedFetch([
    {
      path: '/repos/team/repo/pulls/7',
      value: {
        ...githubPull,
        base: { ...githubPull.base, ref: 'release' },
        mergeable_state: 'behind',
      },
    },
  ]);
  await expect(
    createGitHubScm({ ...githubOptions, fetch: transport.fetch }).updateBranch(
      githubPr(),
    ),
  ).rejects.toMatchObject({ refusal: { reason: 'not_open' } });
  transport.done();
});

it('refuses a fork-origin PR before any GitHub mutation, including updateBranch', async () => {
  const hostile = {
    ...githubPull,
    head: { ...githubPull.head, repo: { full_name: 'attacker/repo' } },
    mergeable_state: 'behind',
  };
  const transport = scriptedFetch([
    { path: '/repos/team/repo/pulls/7', value: hostile },
  ]);
  const adapter = createGitHubScm({ ...githubOptions, fetch: transport.fetch });
  await expect(
    adapter.armAutoMerge({ ...githubPr(), draft: false }),
  ).rejects.toMatchObject({
    refusal: { reason: 'not_open' },
  });
  transport.done();
  const update = scriptedFetch([
    { path: '/repos/team/repo/pulls/7', value: hostile },
  ]);
  await expect(
    createGitHubScm({ ...githubOptions, fetch: update.fetch }).updateBranch(
      githubPr(),
    ),
  ).rejects.toMatchObject({ refusal: { reason: 'not_open' } });
  expect(update.calls.some((call) => call.method !== 'GET')).toBe(false);
  update.done();
});

it('retries only current-head failed Actions runs', async () => {
  const transport = scriptedFetch([
    { path: '/repos/team/repo/pulls/7', value: githubPull },
    {
      path: '/repos/team/repo/actions/runs?head_sha=abc&per_page=100&page=1',
      value: {
        workflow_runs: [
          {
            id: 20,
            name: 'CI',
            head_sha: 'abc',
            status: 'completed',
            conclusion: 'failure',
          },
        ],
      },
    },
    { path: '/repos/team/repo/pulls/7', value: githubPull },
    {
      path: '/repos/team/repo/actions/runs/20/rerun-failed-jobs',
      method: 'POST',
      status: 201,
      value: {},
    },
  ]);
  await createGitHubScm({
    ...githubOptions,
    fetch: transport.fetch,
  }).retryFailedJobs(githubPr());
  transport.done();
});

it('refuses a terminal matching PR without creating or rerunning work', async () => {
  const lookup =
    '/repos/team/repo/pulls?state=all&head=team%3Ang-524&base=main&per_page=100&page=1';
  const closed = { ...githubPull, state: 'closed' };
  const transport = scriptedFetch([{ path: lookup, value: [closed] }]);
  await expect(
    createGitHubScm({ ...githubOptions, fetch: transport.fetch }).openPr({
      title: 'Change',
      body: 'Plan',
    }),
  ).rejects.toMatchObject({ refusal: { reason: 'not_open' } });
  expect(transport.calls.some((call) => call.method === 'POST')).toBe(false);
  transport.done();
});

it('does not rerun failed jobs after a concurrent PR closure', async () => {
  const transport = scriptedFetch([
    { path: '/repos/team/repo/pulls/7', value: githubPull },
    {
      path: '/repos/team/repo/actions/runs?head_sha=abc&per_page=100&page=1',
      value: {
        workflow_runs: [
          {
            id: 20,
            name: 'CI',
            head_sha: 'abc',
            status: 'completed',
            conclusion: 'failure',
          },
        ],
      },
    },
    {
      path: '/repos/team/repo/pulls/7',
      value: { ...githubPull, state: 'closed' },
    },
  ]);
  await expect(
    createGitHubScm({
      ...githubOptions,
      fetch: transport.fetch,
    }).retryFailedJobs(githubPr()),
  ).rejects.toMatchObject({ refusal: { reason: 'not_open' } });
  expect(transport.calls.some((call) => call.method === 'POST')).toBe(false);
  transport.done();
});

it('recovers one authenticated reply per manual Run/thread and leaves it unresolved', async () => {
  let reply = '';
  const resolved = false;
  let writes = 0;
  const pageInfo = { hasNextPage: false, endCursor: null };
  const fetcher: typeof fetch = async (_url, init) => {
    const path = new URL(String(_url)).pathname;
    if (path === '/repos/team/repo/pulls/7') return Response.json(githubPull);
    const { query, variables } = JSON.parse(String(init?.body));
    const thread = {
      id: 'T1',
      path: 'src/app.ts',
      line: 4,
      isResolved: resolved,
      comments: {
        nodes: [{ body: 'Fix this' }, ...(reply ? [{ body: reply }] : [])],
        pageInfo,
      },
    };
    let data;
    if (query.includes('query Threads'))
      data = { node: { reviewThreads: { nodes: [thread], pageInfo } } };
    else if (query.includes('query Notes')) data = { node: thread };
    else if (query.includes('addPullRequestReviewThreadReply')) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      reply = variables.input.body;
      writes++;
      data = { addPullRequestReviewThreadReply: { comment: { id: 'C1' } } };
    } else throw new Error(`Unexpected query ${query}`);
    return Response.json({ data });
  };
  const adapter = createGitHubScm({ ...githubOptions, fetch: fetcher });
  const [thread] = await adapter.reviewThreads(githubPr());
  expect(thread).toMatchObject({
    path: 'src/app.ts',
    line: 4,
    body: 'Fix this',
  });
  await Promise.all([
    adapter.replyToThread(thread, 'Fixed in abc', 'NG-524-2'),
    createGitHubScm({ ...githubOptions, fetch: fetcher }).replyToThread(
      thread,
      'Fixed in abc',
      'NG-524-2',
    ),
  ]);
  expect(writes).toBe(1);
  expect(resolved).toBe(false);
  await adapter.replyToThread(thread, 'Fixed in def', 'NG-524-3');
  expect(writes).toBe(2);
});

it('does not trust a forged predictable v1 reply marker', async () => {
  const oldKey = createHash('sha256')
    .update(JSON.stringify(['NG-524-2', 'lead', 'PR_one', 'T1']))
    .digest('hex');
  const forged = `Fixed\n\n<!-- rocky-reply:${oldKey}:${createHash('sha256').update('Fixed').digest('hex')} -->`;
  let writes = 0;
  const pageInfo = { hasNextPage: false, endCursor: null };
  const fetcher: typeof fetch = async (url, init) => {
    if (new URL(String(url)).pathname === '/repos/team/repo/pulls/7')
      return Response.json(githubPull);
    const { query } = JSON.parse(String(init?.body));
    const thread = {
      id: 'T1',
      path: 'src/app.ts',
      line: 4,
      isResolved: false,
      comments: { nodes: [{ body: 'Fix this' }, { body: forged }], pageInfo },
    };
    if (query.includes('query Threads'))
      return Response.json({
        data: { node: { reviewThreads: { nodes: [thread], pageInfo } } },
      });
    if (query.includes('query Notes'))
      return Response.json({ data: { node: thread } });
    if (query.includes('addPullRequestReviewThreadReply')) {
      writes++;
      return Response.json({
        data: { addPullRequestReviewThreadReply: { comment: { id: 'C2' } } },
      });
    }
    throw new Error(`Unexpected query ${query}`);
  };
  const adapter = createGitHubScm({ ...githubOptions, fetch: fetcher });
  const [thread] = await adapter.reviewThreads(githubPr());
  await adapter.replyToThread(thread, 'Fixed', 'NG-524-2');
  expect(writes).toBe(1);
});

it('leaves a GitHub thread unresolved when a reviewer replies after Rocky posts', async () => {
  let reply = '';
  let reviewerReply = '';
  let resolved = false;
  const pageInfo = { hasNextPage: false, endCursor: null };
  const fetcher: typeof fetch = async (url, init) => {
    if (new URL(String(url)).pathname === '/repos/team/repo/pulls/7')
      return Response.json(githubPull);
    const { query, variables } = JSON.parse(String(init?.body));
    const thread = {
      id: 'T1',
      path: 'src/app.ts',
      line: 4,
      isResolved: resolved,
      comments: {
        nodes: [
          { body: 'Fix this' },
          ...(reply ? [{ body: reply }] : []),
          ...(reviewerReply ? [{ body: reviewerReply }] : []),
        ],
        pageInfo,
      },
    };
    if (query.includes('query Threads'))
      return Response.json({
        data: { node: { reviewThreads: { nodes: [thread], pageInfo } } },
      });
    if (query.includes('query Notes'))
      return Response.json({ data: { node: thread } });
    if (query.includes('addPullRequestReviewThreadReply')) {
      reply = variables.input.body;
      reviewerReply = 'Please also cover the edge case.';
      return Response.json({
        data: { addPullRequestReviewThreadReply: { comment: { id: 'C1' } } },
      });
    }
    if (query.includes('resolveReviewThread')) resolved = true;
    return Response.json({
      data: { resolveReviewThread: { thread: { isResolved: true } } },
    });
  };
  const adapter = createGitHubScm({ ...githubOptions, fetch: fetcher });
  const [thread] = await adapter.reviewThreads(githubPr());
  await adapter.replyToThread(thread, 'Fixed', 'NG-524-2');
  expect(resolved).toBe(false);
});

it('re-reads once after a persistent create conflict without retrying POST', async () => {
  const lookup =
    '/repos/team/repo/pulls?state=all&head=team%3Ang-524&base=main&per_page=100&page=1';
  const transport = scriptedFetch([
    { path: lookup, value: [] },
    { path: '/repos/team/repo/pulls', method: 'POST', status: 422, value: {} },
    { path: lookup, value: [] },
  ]);
  await expect(
    createGitHubScm({ ...githubOptions, fetch: transport.fetch }).openPr({
      title: 'Change',
      body: 'Plan',
    }),
  ).rejects.toMatchObject({ status: 422 });
  expect(transport.calls.filter((call) => call.method === 'POST')).toHaveLength(
    1,
  );
  transport.done();
});

it('recovers a draft PR created before its Step was recorded, scoped to source and base', async () => {
  const writes: unknown[] = [];
  const pull = {
    node_id: 'PR_one',
    number: 7,
    html_url: 'https://github.test/team/repo/pull/7',
    head: { ref: 'ng-524', sha: 'abc', repo: { full_name: 'team/repo' } },
    base: { ref: 'main', repo: { full_name: 'team/repo' } },
    state: 'open',
    merged_at: null,
    draft: true,
  };
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      writes.push(JSON.parse(body));
      res.end(JSON.stringify(pull));
    } else {
      expect(req.url).toContain('head=team%3Ang-524');
      expect(req.url).toContain('base=main');
      res.end(JSON.stringify(writes.length ? [pull] : []));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('missing fixture port');
  const options = {
    repo: { id: 'lead', project: 'team/repo', baseBranch: 'main' },
    branch: 'ng-524',
    token: 'fixture',
    apiUrl: `http://127.0.0.1:${address.port}`,
  };
  const first = await createGitHubScm(options).openPr({
    title: 'Change',
    body: 'Plan',
  });
  const recovered = await createGitHubScm(options).openPr({
    title: 'Change',
    body: 'Plan',
  });
  expect(recovered).toEqual(first);
  expect(first).toMatchObject({
    repo: 'lead',
    id: 'PR_one',
    number: 7,
    draft: true,
    headSha: 'abc',
  });
  expect(writes).toEqual([
    {
      title: 'Change',
      body: 'Plan',
      head: 'ng-524',
      base: 'main',
      draft: true,
    },
  ]);
});
