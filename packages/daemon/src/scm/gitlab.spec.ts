import { expect, it } from 'vitest';
import { createGitLabScm } from './index.js';
import { scriptedFetch } from './scm.fixtures.js';

const options = {
  repo: { id: 'service', project: 'team/service', baseBranch: 'main' },
  branch: 'ng-524',
  token: 'fixture',
  apiUrl: 'https://gitlab.test/api/v4',
};
const root = '/api/v4/projects/team%2Fservice';
const mr = {
  id: 100,
  iid: 7,
  project_id: 5,
  source_project_id: 5,
  target_project_id: 5,
  source_branch: 'ng-524',
  target_branch: 'main',
  sha: 'abc',
  title: 'Draft: Change',
  draft: true,
  state: 'opened',
  web_url: 'https://gitlab.test/team/service/-/merge_requests/7',
  detailed_merge_status: 'draft_status',
};
const pr = {
  repo: 'service',
  id: '100',
  number: 7,
  url: mr.web_url,
  sourceBranch: 'ng-524',
  baseBranch: 'main',
  headSha: 'abc',
  state: 'open' as const,
  draft: true,
};

it('finds or creates a native draft MR and reads ready state back after a title-prefix write', async () => {
  const lookup = `${root}/merge_requests?state=all&source_branch=ng-524&target_branch=main&per_page=100&page=1`;
  const transport = scriptedFetch([
    { path: lookup, value: [] },
    {
      path: `${root}/merge_requests`,
      method: 'POST',
      body: {
        title: 'Draft: Change',
        description: 'Plan',
        source_branch: 'ng-524',
        target_branch: 'main',
      },
      value: mr,
    },
    { path: lookup, value: [mr] },
    {
      path: `${root}/merge_requests/7?include_rebase_in_progress=true`,
      value: mr,
    },
    {
      path: `${root}/merge_requests/7`,
      method: 'PUT',
      body: { title: 'Change', description: 'Reviewed' },
      value: { ...mr, draft: false },
    },
    {
      path: `${root}/merge_requests/7?include_rebase_in_progress=true`,
      value: { ...mr, title: 'Change', draft: false },
    },
  ]);
  const adapter = createGitLabScm({ ...options, fetch: transport.fetch });
  expect(await adapter.openPr({ title: 'Change', body: 'Plan' })).toEqual(pr);
  expect(await adapter.openPr({ title: 'Change', body: 'Plan' })).toEqual(pr);
  expect(
    await adapter.markDraft(pr, false, { body: 'Reviewed' }),
  ).toMatchObject({ draft: false });
  transport.done();
});

it.each([true, false])(
  'only offers local base-merge after rebase 403 when ordinary source push is allowed (%s)',
  async (canPush) => {
    const transport = scriptedFetch([
      {
        path: `${root}/merge_requests/7?include_rebase_in_progress=true`,
        value: { ...mr, detailed_merge_status: 'need_rebase' },
      },
      {
        path: `${root}/merge_requests/7/rebase`,
        method: 'PUT',
        status: 403,
        value: {},
      },
      {
        path: `${root}/merge_requests/7?include_rebase_in_progress=true`,
        value: { ...mr, detailed_merge_status: 'need_rebase' },
      },
      {
        path: `${root}/repository/branches/ng-524`,
        value: { name: 'ng-524', can_push: canPush },
      },
    ]);
    const result = createGitLabScm({
      ...options,
      fetch: transport.fetch,
    }).updateBranch(pr);
    if (canPush)
      expect(await result).toEqual({
        status: 'done',
        result: { status: 'local_base_merge_required', pr },
      });
    else
      await expect(result).rejects.toMatchObject({
        refusal: { reason: 'permission_denied', repo: 'service' },
      });
    transport.done();
  },
);

it('refuses a stale local base-merge fallback when rebase 403 raced a source push', async () => {
  const transport = scriptedFetch([
    {
      path: `${root}/merge_requests/7?include_rebase_in_progress=true`,
      value: { ...mr, detailed_merge_status: 'need_rebase' },
    },
    {
      path: `${root}/merge_requests/7/rebase`,
      method: 'PUT',
      status: 403,
      value: {},
    },
    {
      path: `${root}/merge_requests/7?include_rebase_in_progress=true`,
      value: { ...mr, sha: 'def', detailed_merge_status: 'need_rebase' },
    },
  ]);
  await expect(
    createGitLabScm({ ...options, fetch: transport.fetch }).updateBranch(pr),
  ).rejects.toMatchObject({ refusal: { reason: 'head_changed' } });
  transport.done();
});

it('treats accepted rebase as pending and observes completion or conflict on later polls', async () => {
  const transport = scriptedFetch([
    {
      path: `${root}/merge_requests/7?include_rebase_in_progress=true`,
      value: { ...mr, detailed_merge_status: 'need_rebase' },
    },
    {
      path: `${root}/merge_requests/7/rebase`,
      method: 'PUT',
      status: 202,
      value: { rebase_in_progress: true },
    },
    {
      path: `${root}/merge_requests/7?include_rebase_in_progress=true`,
      value: { ...mr, rebase_in_progress: true },
    },
    {
      path: `${root}/merge_requests/7?include_rebase_in_progress=true`,
      value: { ...mr, rebase_in_progress: false, merge_error: 'Conflicts' },
    },
  ]);
  const adapter = createGitLabScm({ ...options, fetch: transport.fetch });
  expect(await adapter.updateBranch(pr)).toEqual({ status: 'waiting' });
  expect(await adapter.updateBranch(pr)).toEqual({ status: 'waiting' });
  expect(await adapter.updateBranch(pr)).toMatchObject({
    status: 'done',
    result: { status: 'conflict' },
  });
  transport.done();
});

it.each([false, true])(
  're-arms after each fix push through guarded platform auto-merge (train=%s)',
  async (train) => {
    let head = 'abc';
    let armed = false;
    let merged = false;
    const arms: unknown[] = [];
    const fetcher: typeof fetch = async (url, init) => {
      const path = new URL(String(url)).pathname;
      let value: unknown;
      if (path.endsWith('/version')) value = { version: '19.1.0-ee' };
      else if (path === root) value = { merge_trains_enabled: train };
      else if (
        (path.endsWith('/merge_requests/7') && init?.method === 'POST') ||
        path.endsWith('/merge_requests/7/merge')
      ) {
        expect(path).toBe(
          train
            ? `${root}/merge_trains/merge_requests/7`
            : `${root}/merge_requests/7/merge`,
        );
        expect(init?.method).toBe(train ? 'POST' : 'PUT');
        arms.push(JSON.parse(String(init?.body)));
        armed = true;
        value = train ? { id: 9 } : { ...mr, sha: head, draft: false };
      } else if (path.includes('/merge_trains/')) {
        if (!armed) return Response.json({}, { status: 404 });
        value = {
          id: 9,
          status: 'fresh',
          target_branch: 'main',
          merge_request: { id: 100, iid: 7 },
          pipeline: null,
        };
      } else
        value = {
          ...mr,
          sha: head,
          draft: false,
          state: merged ? 'merged' : 'opened',
          detailed_merge_status: 'mergeable',
          merge_when_pipeline_succeeds: armed,
        };
      return Response.json(value);
    };
    const adapter = createGitLabScm({ ...options, fetch: fetcher });
    expect(await adapter.armAutoMerge({ ...pr, draft: false })).toEqual({
      status: 'waiting',
    });
    expect(await adapter.armAutoMerge({ ...pr, draft: false })).toEqual({
      status: 'waiting',
    });
    head = 'def';
    armed = false;
    expect(
      await adapter.armAutoMerge({ ...pr, headSha: head, draft: false }),
    ).toEqual({ status: 'waiting' });
    expect(arms).toEqual([
      { sha: 'abc', auto_merge: true },
      { sha: 'def', auto_merge: true },
    ]);
    merged = true;
    expect(
      await adapter.armAutoMerge({ ...pr, headSha: head, draft: false }),
    ).toMatchObject({ status: 'done', result: { status: 'merged' } });
  },
);

it('does not hot-loop an already armed head after adapter reconstruction', async () => {
  let arms = 0;
  const fetcher = (): typeof fetch => async (url, _init) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/version'))
      return Response.json({ version: '19.1.0-ee' });
    if (path === root) return Response.json({ merge_trains_enabled: false });
    if (path.endsWith('/merge')) {
      arms++;
      return Response.json({ ...mr, draft: false });
    }
    return Response.json({
      ...mr,
      draft: false,
      detailed_merge_status: 'mergeable',
      merge_when_pipeline_succeeds: true,
    });
  };
  const reconstructedOptions = { ...options, token: 'reconstruction-token' };
  await createGitLabScm({
    ...reconstructedOptions,
    fetch: fetcher(),
  }).armAutoMerge({
    ...pr,
    draft: false,
  });
  await createGitLabScm({
    ...reconstructedOptions,
    fetch: fetcher(),
  }).armAutoMerge({
    ...pr,
    draft: false,
  });
  expect(arms).toBe(1);
});

it('reports failed GitLab jobs with capped traces, then retries only failed jobs', async () => {
  const pipeline = { id: 9, sha: 'abc', ref: 'ng-524', status: 'failed' };
  const poll = [
    {
      path: `${root}/merge_requests/7?include_rebase_in_progress=true`,
      value: { ...mr, head_pipeline: pipeline },
    },
    {
      path: `${root}/merge_requests/7/pipelines?per_page=100&page=1`,
      value: [pipeline],
    },
  ];
  const transport = scriptedFetch([
    ...poll,
    {
      path: `${root}/pipelines/9/jobs?include_retried=false&per_page=100&page=1`,
      value: [
        { id: 12, name: 'test', status: 'failed', allow_failure: false },
        { id: 13, name: 'lint', status: 'success', allow_failure: false },
      ],
    },
    { path: `${root}/jobs/12/trace`, text: 'old\nassertion\nfailed\n' },
    {
      path: `${root}/merge_requests/7?include_rebase_in_progress=true`,
      value: { ...mr, head_pipeline: pipeline },
    },
    ...poll,
    {
      path: `${root}/pipelines/9/jobs?include_retried=false&per_page=100&page=1`,
      value: [{ id: 12, name: 'test', status: 'failed', allow_failure: false }],
    },
    {
      path: `${root}/merge_requests/7?include_rebase_in_progress=true`,
      value: { ...mr, head_pipeline: pipeline },
    },
    { path: `${root}/jobs/12/retry`, method: 'POST', value: { id: 14 } },
  ]);
  const adapter = createGitLabScm({ ...options, fetch: transport.fetch });
  expect(await adapter.waitForCi(pr, { logTailLines: 2 })).toEqual({
    status: 'done',
    result: {
      status: 'failed',
      headSha: 'abc',
      failedJobs: [
        {
          id: '12',
          name: 'test',
          failedSteps: [],
          logTail: 'assertion\nfailed',
        },
      ],
    },
  });
  await adapter.retryFailedJobs(pr);
  transport.done();
});

it('uses project-scoped discussions and deduplicates reply-before-record recovery', async () => {
  let reply = '';
  let resolved = false;
  let writes = 0;
  const fetcher: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === `${root}/merge_requests/7`) return Response.json(mr);
    const note = {
      id: 1,
      body: 'Fix',
      system: false,
      resolvable: true,
      resolved,
      position: { new_path: 'src/app.ts', new_line: 3 },
    };
    const discussion = {
      id: 'D1',
      notes: [note, ...(reply ? [{ ...note, id: 2, body: reply }] : [])],
    };
    if (init?.method === 'POST') {
      expect(path).toBe(`${root}/merge_requests/7/discussions/D1/notes`);
      await new Promise((resolve) => setTimeout(resolve, 0));
      writes++;
      reply = JSON.parse(String(init.body)).body;
      return Response.json({ id: 2 });
    }
    if (init?.method === 'PUT') {
      expect(JSON.parse(String(init.body))).toEqual({ resolved: true });
      resolved = true;
    }
    return Response.json(
      path.endsWith('/discussions') ? [discussion] : discussion,
    );
  };
  const adapter = createGitLabScm({ ...options, fetch: fetcher });
  const [thread] = await adapter.reviewThreads(pr);
  expect(thread).toMatchObject({ id: 'D1', pr, path: 'src/app.ts', line: 3 });
  await Promise.all([
    adapter.replyToThread(thread, 'Fixed', 'NG-524-2'),
    createGitLabScm({ ...options, fetch: fetcher }).replyToThread(
      thread,
      'Fixed',
      'NG-524-2',
    ),
  ]);
  expect(writes).toBe(1);
  expect(resolved).toBe(true);
});
