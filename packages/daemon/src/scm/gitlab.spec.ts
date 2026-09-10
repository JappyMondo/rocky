import { expect, it } from 'vitest';
import { createGitLabScm } from './index.js';
import { scriptedFetch as baseScriptedFetch } from './scm.fixtures.js';

const options = {
  repo: { id: 'service', project: 'team/service', baseBranch: 'main' },
  branch: 'ng-524',
  token: 'fixture',
  apiUrl: 'https://gitlab.test/api/v4',
};
const root = '/api/v4/projects/team%2Fservice';
function scriptedFetch(script: Parameters<typeof baseScriptedFetch>[0]) {
  const project = script.find(
    (entry) => entry.path === root && (entry.method ?? 'GET') === 'GET',
  ) ?? { path: root, value: { id: 5, merge_trains_enabled: false } };
  return baseScriptedFetch([
    project,
    ...script.filter((entry) => entry !== project),
  ]);
}
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

it('retries a project lookup after a transient failure', async () => {
  const lookup = `${root}/merge_requests?state=all&source_branch=ng-524&target_branch=main&per_page=100&page=1`;
  const transport = scriptedFetch([
    { path: root, status: 500, value: { message: 'temporary failure' } },
    { path: root, value: { id: 5, merge_trains_enabled: false } },
    { path: lookup, value: [mr] },
  ]);
  const adapter = createGitLabScm({ ...options, fetch: transport.fetch });

  await expect(
    adapter.openPr({ title: 'Change', body: 'Plan' }),
  ).rejects.toMatchObject({
    status: 500,
  });
  await expect(
    adapter.openPr({ title: 'Change', body: 'Plan' }),
  ).resolves.toEqual(pr);
  transport.done();
});

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

it('creates a ready MR only when the caller explicitly requests it', async () => {
  const lookup = `${root}/merge_requests?state=all&source_branch=ng-524&target_branch=main&per_page=100&page=1`;
  const ready = { ...mr, title: 'Change', draft: false };
  const transport = scriptedFetch([
    { path: lookup, value: [] },
    {
      path: `${root}/merge_requests`,
      method: 'POST',
      body: {
        title: 'Change',
        description: 'Seed',
        source_branch: 'ng-524',
        target_branch: 'main',
      },
      value: ready,
    },
  ]);

  await expect(
    createGitLabScm({ ...options, fetch: transport.fetch }).openPr({
      title: 'Change',
      body: 'Seed',
      draft: false,
    }),
  ).resolves.toEqual({ ...pr, draft: false });
  transport.done();
});

it('adopts an MR when a concurrent GitLab creator wins', async () => {
  const lookup = `${root}/merge_requests?state=all&source_branch=ng-524&target_branch=main&per_page=100&page=1`;
  const transport = scriptedFetch([
    { path: lookup, value: [] },
    { path: `${root}/merge_requests`, method: 'POST', status: 409, value: {} },
    { path: lookup, value: [mr] },
  ]);

  await expect(
    createGitLabScm({ ...options, fetch: transport.fetch }).openPr({
      title: 'Change',
      body: 'Plan',
    }),
  ).resolves.toEqual(pr);
  expect(transport.calls.filter((call) => call.method === 'POST')).toHaveLength(
    1,
  );
  transport.done();
});

it('refuses a terminal MR observed after a concurrent GitLab creator wins', async () => {
  const lookup = `${root}/merge_requests?state=all&source_branch=ng-524&target_branch=main&per_page=100&page=1`;
  const transport = scriptedFetch([
    { path: lookup, value: [] },
    { path: `${root}/merge_requests`, method: 'POST', status: 409, value: {} },
    { path: lookup, value: [{ ...mr, state: 'closed' }] },
  ]);

  await expect(
    createGitLabScm({ ...options, fetch: transport.fetch }).openPr({
      title: 'Change',
      body: 'Plan',
    }),
  ).rejects.toMatchObject({ refusal: { reason: 'not_open' } });
  expect(transport.calls.filter((call) => call.method === 'POST')).toHaveLength(
    1,
  );
  transport.done();
});

it('does not recover a non-conflict GitLab create failure', async () => {
  const lookup = `${root}/merge_requests?state=all&source_branch=ng-524&target_branch=main&per_page=100&page=1`;
  const transport = scriptedFetch([
    { path: lookup, value: [] },
    { path: `${root}/merge_requests`, method: 'POST', status: 500, value: {} },
  ]);

  await expect(
    createGitLabScm({ ...options, fetch: transport.fetch }).openPr({
      title: 'Change',
      body: 'Plan',
    }),
  ).rejects.toMatchObject({ status: 500 });
  transport.done();
});

it('refuses a created GitLab MR with a different source branch', async () => {
  const lookup = `${root}/merge_requests?state=all&source_branch=ng-524&target_branch=main&per_page=100&page=1`;
  const transport = scriptedFetch([
    { path: lookup, value: [] },
    {
      path: `${root}/merge_requests`,
      method: 'POST',
      value: { ...mr, source_branch: 'other' },
    },
  ]);

  await expect(
    createGitLabScm({ ...options, fetch: transport.fetch }).openPr({
      title: 'Change',
      body: 'Plan',
    }),
  ).rejects.toMatchObject({ refusal: { reason: 'invalid_response' } });
  transport.done();
});

it('converts a ready MR back to a title-prefixed draft', async () => {
  const ready = { ...mr, title: 'Change', draft: false };
  const draft = { ...mr, title: 'Draft: Change', draft: true };
  const transport = scriptedFetch([
    {
      path: `${root}/merge_requests/7?include_rebase_in_progress=true`,
      value: ready,
    },
    {
      path: `${root}/merge_requests/7`,
      method: 'PUT',
      body: { title: 'Draft: Change', description: 'Needs work' },
      value: draft,
    },
    {
      path: `${root}/merge_requests/7?include_rebase_in_progress=true`,
      value: draft,
    },
  ]);

  await expect(
    createGitLabScm({ ...options, fetch: transport.fetch }).markDraft(
      { ...pr, draft: false },
      true,
      { body: 'Needs work' },
    ),
  ).resolves.toMatchObject({ draft: true });
  transport.done();
});

it('refuses closed MR draft mutations and stale draft readback', async () => {
  const closed = scriptedFetch([
    {
      path: `${root}/merge_requests/7?include_rebase_in_progress=true`,
      value: { ...mr, state: 'closed' },
    },
  ]);
  await expect(
    createGitLabScm({ ...options, fetch: closed.fetch }).markDraft(pr, false),
  ).rejects.toMatchObject({ refusal: { reason: 'not_open' } });
  closed.done();

  const ready = { ...mr, title: 'Change', draft: false };
  const stale = scriptedFetch([
    {
      path: `${root}/merge_requests/7?include_rebase_in_progress=true`,
      value: ready,
    },
    {
      path: `${root}/merge_requests/7`,
      method: 'PUT',
      body: { title: 'Draft: Change' },
      value: mr,
    },
    {
      path: `${root}/merge_requests/7?include_rebase_in_progress=true`,
      value: ready,
    },
  ]);
  await expect(
    createGitLabScm({ ...options, fetch: stale.fetch }).markDraft(
      { ...pr, draft: false },
      true,
    ),
  ).rejects.toMatchObject({ refusal: { reason: 'draft_status' } });
  stale.done();
});

it('refuses a terminal matching MR without creating a second review', async () => {
  const lookup = `${root}/merge_requests?state=all&source_branch=ng-524&target_branch=main&per_page=100&page=1`;
  const transport = scriptedFetch([
    { path: lookup, value: [{ ...mr, state: 'closed' }] },
  ]);
  await expect(
    createGitLabScm({ ...options, fetch: transport.fetch }).openPr({
      title: 'Change',
      body: 'Plan',
    }),
  ).rejects.toMatchObject({ refusal: { reason: 'not_open' } });
  expect(transport.calls.some((call) => call.method === 'POST')).toBe(false);
  transport.done();
});

it('refuses a cross-project MR list response before creating a review', async () => {
  const lookup = `${root}/merge_requests?state=all&source_branch=ng-524&target_branch=main&per_page=100&page=1`;
  const transport = scriptedFetch([
    { path: root, value: { id: 5, merge_trains_enabled: false } },
    {
      path: lookup,
      value: [{ ...mr, source_project_id: 6, target_project_id: 6 }],
    },
  ]);
  await expect(
    createGitLabScm({ ...options, fetch: transport.fetch }).openPr({
      title: 'Change',
      body: 'Plan',
    }),
  ).rejects.toMatchObject({ refusal: { reason: 'invalid_response' } });
  expect(transport.calls.some((call) => call.method === 'POST')).toBe(false);
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

it('does not hide a non-404 source branch read failure after rebase refusal', async () => {
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
      status: 500,
      value: {},
    },
  ]);

  await expect(
    createGitLabScm({ ...options, fetch: transport.fetch }).updateBranch(pr),
  ).rejects.toMatchObject({ status: 500 });
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

it.each([
  [{ ...mr, rebase_in_progress: true }, 'waiting'],
  [{ ...mr, detailed_merge_status: 'checking' }, 'waiting'],
  [{ ...mr, detailed_merge_status: 'mergeable' }, 'clean'],
] as const)(
  'reports GitLab branch state %s without a source mutation',
  async (value, expected) => {
    const transport = scriptedFetch([
      {
        path: `${root}/merge_requests/7?include_rebase_in_progress=true`,
        value,
      },
    ]);
    const result = await createGitLabScm({
      ...options,
      fetch: transport.fetch,
    }).updateBranch(pr);
    expect(result).toMatchObject(
      expected === 'waiting'
        ? { status: 'waiting' }
        : { status: 'done', result: { status: 'clean' } },
    );
    expect(transport.calls.some((call) => call.method !== 'GET')).toBe(false);
    transport.done();
  },
);

it('does not update a closed GitLab MR', async () => {
  const transport = scriptedFetch([
    {
      path: `${root}/merge_requests/7?include_rebase_in_progress=true`,
      value: { ...mr, state: 'closed' },
    },
  ]);

  await expect(
    createGitLabScm({ ...options, fetch: transport.fetch }).updateBranch(pr),
  ).rejects.toMatchObject({ refusal: { reason: 'not_open' } });
  expect(transport.calls.some((call) => call.method !== 'GET')).toBe(false);
  transport.done();
});

it('refuses a local base-merge fallback when the GitLab source branch vanished', async () => {
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
    { path: `${root}/repository/branches/ng-524`, status: 404, value: {} },
  ]);

  await expect(
    createGitLabScm({ ...options, fetch: transport.fetch }).updateBranch(pr),
  ).rejects.toMatchObject({ refusal: { reason: 'source_missing' } });
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
      else if (path === root) value = { id: 5, merge_trains_enabled: train };
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
        value = train
          ? {
              id: 9,
              status: 'fresh',
              target_branch: 'main',
              merge_request: { id: 100, iid: 7 },
              pipeline: null,
            }
          : { ...mr, sha: head, draft: false };
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

it.each([
  [{ ...mr, state: 'locked', draft: false }, { status: 'waiting' }],
  [
    { ...mr, state: 'closed', draft: false },
    { refusal: { reason: 'not_open' } },
  ],
] as const)('does not arm a GitLab MR that is %s', async (value, expected) => {
  const transport = scriptedFetch([
    {
      path: `${root}/merge_requests/7?include_rebase_in_progress=true`,
      value,
    },
  ]);
  const arm = createGitLabScm({
    ...options,
    fetch: transport.fetch,
  }).armAutoMerge({ ...pr, draft: false });
  if ('refusal' in expected) await expect(arm).rejects.toMatchObject(expected);
  else await expect(arm).resolves.toEqual(expected);
  expect(transport.calls.some((call) => call.method !== 'GET')).toBe(false);
  transport.done();
});

it('refuses a stale merge-train entry without a train or auto-merge mutation', async () => {
  const transport = scriptedFetch([
    {
      path: `${root}/merge_requests/7?include_rebase_in_progress=true`,
      value: {
        ...mr,
        draft: false,
        detailed_merge_status: 'mergeable',
        merge_when_pipeline_succeeds: false,
      },
    },
    { path: '/api/v4/version', value: { version: '19.1.0-ee' } },
    { path: root, value: { id: 5, merge_trains_enabled: true } },
    {
      path: `${root}/merge_trains/merge_requests/7`,
      value: {
        id: 9,
        status: 'stale',
        target_branch: 'main',
        merge_request: { id: 100, iid: 7 },
        pipeline: null,
      },
    },
  ]);
  await expect(
    createGitLabScm({ ...options, fetch: transport.fetch }).armAutoMerge({
      ...pr,
      draft: false,
    }),
  ).rejects.toMatchObject({ refusal: { reason: 'train_pipeline_dropped' } });
  expect(
    transport.calls.some((call) => ['POST', 'PUT'].includes(call.method)),
  ).toBe(false);
  transport.done();
});

it.each([false, true])(
  'refuses an auto-merge response that is not bound to the requested MR (train=%s)',
  async (train) => {
    const transport = scriptedFetch([
      {
        path: `${root}/merge_requests/7?include_rebase_in_progress=true`,
        value: {
          ...mr,
          draft: false,
          detailed_merge_status: 'mergeable',
          merge_when_pipeline_succeeds: false,
        },
      },
      { path: '/api/v4/version', value: { version: '19.1.0-ee' } },
      { path: root, value: { id: 5, merge_trains_enabled: train } },
      ...(train
        ? [
            {
              path: `${root}/merge_trains/merge_requests/7`,
              status: 404,
              value: {},
            },
            {
              path: `${root}/merge_requests/7?include_rebase_in_progress=true`,
              value: {
                ...mr,
                draft: false,
                detailed_merge_status: 'mergeable',
                merge_when_pipeline_succeeds: false,
              },
            },
            {
              path: `${root}/merge_trains/merge_requests/7`,
              method: 'POST',
              value: {
                id: 9,
                status: 'fresh',
                target_branch: 'other',
                merge_request: { id: 999, iid: 8 },
                pipeline: null,
              },
            },
          ]
        : [
            {
              path: `${root}/merge_requests/7?include_rebase_in_progress=true`,
              value: {
                ...mr,
                draft: false,
                detailed_merge_status: 'mergeable',
                merge_when_pipeline_succeeds: false,
              },
            },
            {
              path: `${root}/merge_requests/7/merge`,
              method: 'PUT',
              value: { ...mr, id: 999, draft: false },
            },
          ]),
    ]);
    await expect(
      createGitLabScm({ ...options, fetch: transport.fetch }).armAutoMerge({
        ...pr,
        draft: false,
      }),
    ).rejects.toMatchObject({ refusal: { reason: 'invalid_response' } });
    transport.done();
  },
);

it('does not hot-loop an already armed head after adapter reconstruction', async () => {
  let arms = 0;
  const fetcher = (): typeof fetch => async (url, _init) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/version'))
      return Response.json({ version: '19.1.0-ee' });
    if (path === root)
      return Response.json({ id: 5, merge_trains_enabled: false });
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

it('revalidates the MR after feature reads and refuses a closure before arming', async () => {
  const transport = scriptedFetch([
    {
      path: `${root}/merge_requests/7?include_rebase_in_progress=true`,
      value: {
        ...mr,
        draft: false,
        detailed_merge_status: 'mergeable',
        merge_when_pipeline_succeeds: false,
      },
    },
    { path: '/api/v4/version', value: { version: '19.1.0-ee' } },
    { path: root, value: { id: 5, merge_trains_enabled: false } },
    {
      path: `${root}/merge_requests/7?include_rebase_in_progress=true`,
      value: {
        ...mr,
        state: 'closed',
        draft: false,
        detailed_merge_status: 'mergeable',
        merge_when_pipeline_succeeds: false,
      },
    },
  ]);
  await expect(
    createGitLabScm({ ...options, fetch: transport.fetch }).armAutoMerge({
      ...pr,
      draft: false,
    }),
  ).rejects.toMatchObject({ refusal: { reason: 'not_open' } });
  expect(
    transport.calls.some((call) => ['POST', 'PUT'].includes(call.method)),
  ).toBe(false);
  transport.done();
});

it.each([
  [
    'merged',
    { state: 'merged' },
    { status: 'done', result: { status: 'merged' } },
  ],
  ['locked', { state: 'locked' }, { status: 'waiting' }],
  ['draft', { draft: true }, { refusal: { reason: 'draft_status' } }],
  [
    'blocked',
    { detailed_merge_status: 'not_approved' },
    { refusal: { reason: 'not_approved' } },
  ],
] as const)(
  'revalidates a %s MR after feature reads before arming',
  async (_name, change, expected) => {
    const initial = {
      ...mr,
      draft: false,
      detailed_merge_status: 'mergeable',
      merge_when_pipeline_succeeds: false,
    };
    const transport = scriptedFetch([
      {
        path: `${root}/merge_requests/7?include_rebase_in_progress=true`,
        value: initial,
      },
      { path: '/api/v4/version', value: { version: '19.1.0-ee' } },
      { path: root, value: { id: 5, merge_trains_enabled: false } },
      {
        path: `${root}/merge_requests/7?include_rebase_in_progress=true`,
        value: { ...initial, ...change },
      },
    ]);
    const arm = createGitLabScm({
      ...options,
      fetch: transport.fetch,
    }).armAutoMerge({ ...pr, draft: false });

    if ('refusal' in expected)
      await expect(arm).rejects.toMatchObject(expected);
    else await expect(arm).resolves.toMatchObject(expected);
    expect(
      transport.calls.some((call) => ['POST', 'PUT'].includes(call.method)),
    ).toBe(false);
    transport.done();
  },
);

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

it('does not retry a job after a concurrent MR closure', async () => {
  const pipeline = { id: 9, sha: 'abc', ref: 'ng-524', status: 'failed' };
  const transport = scriptedFetch([
    {
      path: `${root}/merge_requests/7?include_rebase_in_progress=true`,
      value: { ...mr, head_pipeline: pipeline },
    },
    {
      path: `${root}/merge_requests/7/pipelines?per_page=100&page=1`,
      value: [pipeline],
    },
    {
      path: `${root}/pipelines/9/jobs?include_retried=false&per_page=100&page=1`,
      value: [{ id: 12, name: 'test', status: 'failed', allow_failure: false }],
    },
    {
      path: `${root}/merge_requests/7?include_rebase_in_progress=true`,
      value: { ...mr, state: 'closed', head_pipeline: pipeline },
    },
  ]);
  await expect(
    createGitLabScm({ ...options, fetch: transport.fetch }).retryFailedJobs(pr),
  ).rejects.toMatchObject({ refusal: { reason: 'not_open' } });
  expect(transport.calls.some((call) => call.method === 'POST')).toBe(false);
  transport.done();
});

it('refuses a GitLab retry before CI has created a current pipeline', async () => {
  const transport = scriptedFetch([
    {
      path: `${root}/merge_requests/7?include_rebase_in_progress=true`,
      value: { ...mr, head_pipeline: null },
    },
    {
      path: `${root}/merge_requests/7/pipelines?per_page=100&page=1`,
      value: [],
    },
  ]);

  await expect(
    createGitLabScm({ ...options, fetch: transport.fetch }).retryFailedJobs(pr),
  ).rejects.toMatchObject({ refusal: { reason: 'ci_still_running' } });
  transport.done();
});

it('keeps polling GitLab when there is no current pipeline', async () => {
  const transport = scriptedFetch([
    {
      path: `${root}/merge_requests/7?include_rebase_in_progress=true`,
      value: { ...mr, head_pipeline: null },
    },
    {
      path: `${root}/merge_requests/7/pipelines?per_page=100&page=1`,
      value: [],
    },
  ]);

  await expect(
    createGitLabScm({ ...options, fetch: transport.fetch }).waitForCi(pr, {
      logTailLines: 200,
    }),
  ).resolves.toEqual({ status: 'waiting' });
  transport.done();
});

it('refuses invalid GitLab CI log-tail bounds before reading the MR', async () => {
  await expect(
    createGitLabScm({ ...options, fetch: scriptedFetch([]).fetch }).waitForCi(
      pr,
      { logTailLines: -1 },
    ),
  ).rejects.toThrow('logTailLines must be between 0 and 10000');
});

it('keeps waiting for a successful current pipeline with an unfinished required job', async () => {
  const pipeline = { id: 9, sha: 'abc', ref: 'ng-524', status: 'success' };
  const transport = scriptedFetch([
    {
      path: `${root}/merge_requests/7?include_rebase_in_progress=true`,
      value: { ...mr, head_pipeline: pipeline },
    },
    {
      path: `${root}/merge_requests/7/pipelines?per_page=100&page=1`,
      value: [pipeline],
    },
    {
      path: `${root}/pipelines/9/jobs?include_retried=false&per_page=100&page=1`,
      value: [
        { id: 12, name: 'test', status: 'running', allow_failure: false },
      ],
    },
    {
      path: `${root}/merge_requests/7?include_rebase_in_progress=true`,
      value: { ...mr, head_pipeline: pipeline },
    },
  ]);

  await expect(
    createGitLabScm({ ...options, fetch: transport.fetch }).waitForCi(pr, {
      logTailLines: 20,
    }),
  ).resolves.toEqual({ status: 'waiting' });
  transport.done();
});

it('refuses a GitLab current pipeline from an unrelated older branch', async () => {
  const pipeline = { id: 9, sha: 'old', ref: 'topic', status: 'success' };
  const transport = scriptedFetch([
    {
      path: `${root}/merge_requests/7?include_rebase_in_progress=true`,
      value: { ...mr, head_pipeline: pipeline },
    },
    {
      path: `${root}/merge_requests/7/pipelines?per_page=100&page=1`,
      value: [pipeline],
    },
  ]);

  await expect(
    createGitLabScm({ ...options, fetch: transport.fetch }).waitForCi(pr, {
      logTailLines: 20,
    }),
  ).rejects.toMatchObject({ refusal: { reason: 'head_changed' } });
  transport.done();
});

it.each(['not_approved', 'requested_changes', 'discussions_not_resolved'])(
  'refuses GitLab blocking merge status %s before an auto-merge mutation',
  async (detailed_merge_status) => {
    const transport = scriptedFetch([
      {
        path: `${root}/merge_requests/7?include_rebase_in_progress=true`,
        value: {
          ...mr,
          draft: false,
          detailed_merge_status,
          merge_when_pipeline_succeeds: false,
        },
      },
    ]);
    await expect(
      createGitLabScm({ ...options, fetch: transport.fetch }).armAutoMerge({
        ...pr,
        draft: false,
      }),
    ).rejects.toMatchObject({ refusal: { reason: detailed_merge_status } });
    expect(
      transport.calls.some((call) => ['POST', 'PUT'].includes(call.method)),
    ).toBe(false);
    transport.done();
  },
);

it('uses project-scoped discussions and deduplicates reply-before-record recovery', async () => {
  let reply = '';
  const resolved = false;
  let writes = 0;
  const fetcher: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === root)
      return Response.json({ id: 5, merge_trains_enabled: false });
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
  expect(resolved).toBe(false);
});

it('ignores GitLab discussions that contain only system notes', async () => {
  const transport = scriptedFetch([
    {
      path: `${root}/merge_requests/7?include_rebase_in_progress=true`,
      value: mr,
    },
    {
      path: `${root}/merge_requests/7/discussions?per_page=100&page=1`,
      value: [
        {
          id: 'system',
          notes: [
            {
              id: 1,
              body: 'changed title',
              system: true,
              resolvable: false,
              position: null,
            },
          ],
        },
      ],
    },
  ]);

  await expect(
    createGitLabScm({ ...options, fetch: transport.fetch }).reviewThreads(pr),
  ).resolves.toEqual([]);
  transport.done();
});

it('leaves a GitLab discussion unresolved when a reviewer replies after Rocky posts', async () => {
  let reply = '';
  let reviewerReply = '';
  let resolved = false;
  const fetcher: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === root)
      return Response.json({ id: 5, merge_trains_enabled: false });
    if (path === `${root}/merge_requests/7`) return Response.json(mr);
    const note = {
      id: 1,
      body: 'Fix',
      system: false,
      resolvable: true,
      resolved,
      position: null,
    };
    const discussion = {
      id: 'D1',
      notes: [
        note,
        ...(reply ? [{ ...note, id: 2, body: reply }] : []),
        ...(reviewerReply ? [{ ...note, id: 3, body: reviewerReply }] : []),
      ],
    };
    if (init?.method === 'POST') {
      reply = JSON.parse(String(init.body)).body;
      reviewerReply = 'Please also cover the edge case.';
      return Response.json({ id: 2 });
    }
    if (init?.method === 'PUT') resolved = true;
    return Response.json(
      path.endsWith('/discussions') ? [discussion] : discussion,
    );
  };
  const adapter = createGitLabScm({ ...options, fetch: fetcher });
  const [thread] = await adapter.reviewThreads(pr);
  await adapter.replyToThread(thread, 'Fixed', 'NG-524-2');
  expect(resolved).toBe(false);
});

it.each([
  [
    'an unsupported GitLab version',
    { id: 5, merge_trains_enabled: false },
    '17.10.0-ee',
    'unsupported',
  ],
  [
    'hidden GitLab merge-train configuration',
    { id: 5 },
    '19.1.0-ee',
    'permission_unknown',
  ],
] as const)(
  'refuses %s before requesting auto-merge',
  async (_name, project, version, reason) => {
    const transport = scriptedFetch([
      { path: root, value: project },
      {
        path: `${root}/merge_requests/7?include_rebase_in_progress=true`,
        value: {
          ...mr,
          draft: false,
          detailed_merge_status: 'mergeable',
          merge_when_pipeline_succeeds: false,
        },
      },
      { path: '/api/v4/version', value: { version } },
    ]);

    await expect(
      createGitLabScm({ ...options, fetch: transport.fetch }).armAutoMerge({
        ...pr,
        draft: false,
      }),
    ).rejects.toMatchObject({ refusal: { reason } });
    expect(
      transport.calls.some((call) => ['POST', 'PUT'].includes(call.method)),
    ).toBe(false);
    transport.done();
  },
);

it('verifies a synthetic GitLab pipeline contains the current source head', async () => {
  const pipeline = {
    id: 9,
    sha: 'synthetic',
    ref: 'refs/merge-requests/7/merge',
    status: 'success',
  };
  const transport = scriptedFetch([
    {
      path: `${root}/merge_requests/7?include_rebase_in_progress=true`,
      value: { ...mr, head_pipeline: pipeline },
    },
    {
      path: `${root}/merge_requests/7/pipelines?per_page=100&page=1`,
      value: [pipeline],
    },
    {
      path: `${root}/repository/commits/synthetic`,
      value: { parent_ids: ['abc'] },
    },
    {
      path: `${root}/pipelines/9/jobs?include_retried=false&per_page=100&page=1`,
      value: [],
    },
    {
      path: `${root}/merge_requests/7?include_rebase_in_progress=true`,
      value: { ...mr, head_pipeline: pipeline },
    },
  ]);

  await expect(
    createGitLabScm({ ...options, fetch: transport.fetch }).waitForCi(pr, {
      logTailLines: 0,
    }),
  ).resolves.toEqual({
    status: 'done',
    result: { status: 'passed', headSha: 'abc', failedJobs: [] },
  });
  transport.done();
});

it('refuses GitLab CI based on a synthetic commit that excludes the source head', async () => {
  const pipeline = {
    id: 9,
    sha: 'synthetic',
    ref: 'refs/merge-requests/7/merge',
    status: 'success',
  };
  const transport = scriptedFetch([
    {
      path: `${root}/merge_requests/7?include_rebase_in_progress=true`,
      value: { ...mr, head_pipeline: pipeline },
    },
    {
      path: `${root}/merge_requests/7/pipelines?per_page=100&page=1`,
      value: [pipeline],
    },
    {
      path: `${root}/repository/commits/synthetic`,
      value: { parent_ids: ['another-head'] },
    },
  ]);

  await expect(
    createGitLabScm({ ...options, fetch: transport.fetch }).waitForCi(pr, {
      logTailLines: 0,
    }),
  ).rejects.toMatchObject({ refusal: { reason: 'head_changed' } });
  transport.done();
});

it('refuses a GitLab train pipeline that has already disappeared', async () => {
  const pipeline = {
    id: 9,
    sha: 'abc',
    ref: 'refs/merge-requests/7/train',
    status: 'running',
  };
  const transport = scriptedFetch([
    {
      path: `${root}/merge_requests/7?include_rebase_in_progress=true`,
      value: { ...mr, head_pipeline: pipeline },
    },
    {
      path: `${root}/merge_requests/7/pipelines?per_page=100&page=1`,
      value: [pipeline],
    },
    { path: `${root}/merge_trains/merge_requests/7`, status: 404, value: {} },
  ]);

  await expect(
    createGitLabScm({ ...options, fetch: transport.fetch }).waitForCi(pr, {
      logTailLines: 0,
    }),
  ).rejects.toMatchObject({ refusal: { reason: 'train_pipeline_dropped' } });
  transport.done();
});

it('fails closed when GitLab cannot read auto-merge state after feature checks', async () => {
  const transport = scriptedFetch([
    {
      path: `${root}/merge_requests/7?include_rebase_in_progress=true`,
      value: {
        ...mr,
        draft: false,
        detailed_merge_status: 'mergeable',
        merge_when_pipeline_succeeds: false,
      },
    },
    { path: '/api/v4/version', value: { version: '19.1.0-ee' } },
    {
      path: `${root}/merge_requests/7?include_rebase_in_progress=true`,
      value: {
        ...mr,
        draft: false,
        detailed_merge_status: 'mergeable',
      },
    },
  ]);

  await expect(
    createGitLabScm({ ...options, fetch: transport.fetch }).armAutoMerge({
      ...pr,
      draft: false,
    }),
  ).rejects.toMatchObject({ refusal: { reason: 'permission_unknown' } });
  transport.done();
});

it('retains unanchored GitLab discussions and computes resolution from resolvable notes', async () => {
  const transport = scriptedFetch([
    {
      path: `${root}/merge_requests/7?include_rebase_in_progress=true`,
      value: mr,
    },
    {
      path: `${root}/merge_requests/7/discussions?per_page=100&page=1`,
      value: [
        {
          id: 'general',
          notes: [
            {
              id: 1,
              body: 'General review note',
              system: false,
              resolvable: false,
              position: null,
            },
          ],
        },
      ],
    },
  ]);

  await expect(
    createGitLabScm({ ...options, fetch: transport.fetch }).reviewThreads(pr),
  ).resolves.toEqual([
    {
      pr,
      id: 'general',
      body: 'General review note',
      resolved: false,
    },
  ]);
  transport.done();
});

it('recovers a GitLab reply when the note write committed before a conflict response', async () => {
  let reply = '';
  let writes = 0;
  const fetcher: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === root)
      return Response.json({ id: 5, merge_trains_enabled: false });
    if (path === `${root}/merge_requests/7`) return Response.json(mr);
    const note = {
      id: 1,
      body: 'Fix this',
      system: false,
      resolvable: true,
      resolved: false,
      position: { new_path: 'src/app.ts', new_line: 3 },
    };
    const discussion = {
      id: 'D1',
      notes: [note, ...(reply ? [{ ...note, id: 2, body: reply }] : [])],
    };
    if (init?.method === 'POST') {
      writes++;
      reply = JSON.parse(String(init.body)).body;
      return Response.json({}, { status: 422 });
    }
    return Response.json(
      path.endsWith('/discussions') ? [discussion] : discussion,
    );
  };

  const adapter = createGitLabScm({ ...options, fetch: fetcher });
  const [thread] = await adapter.reviewThreads(pr);
  await expect(
    adapter.replyToThread(thread, 'Fixed', 'NG-524-2'),
  ).resolves.toBeUndefined();
  expect(writes).toBe(1);
});

it('reports a failed GitLab pipeline even when its only jobs are allowed to fail', async () => {
  const pipeline = { id: 9, sha: 'abc', ref: 'ng-524', status: 'failed' };
  const transport = scriptedFetch([
    {
      path: `${root}/merge_requests/7?include_rebase_in_progress=true`,
      value: { ...mr, head_pipeline: pipeline },
    },
    {
      path: `${root}/merge_requests/7/pipelines?per_page=100&page=1`,
      value: [pipeline],
    },
    {
      path: `${root}/pipelines/9/jobs?include_retried=false&per_page=100&page=1`,
      value: [
        { id: 12, name: 'optional', status: 'failed', allow_failure: true },
      ],
    },
    {
      path: `${root}/merge_requests/7?include_rebase_in_progress=true`,
      value: { ...mr, head_pipeline: pipeline },
    },
  ]);

  await expect(
    createGitLabScm({ ...options, fetch: transport.fetch }).waitForCi(pr, {
      logTailLines: 0,
    }),
  ).resolves.toMatchObject({
    status: 'done',
    result: {
      status: 'failed',
      failedJobs: [{ id: '9', name: 'Pipeline 9 (failed)', logTail: '' }],
    },
  });
  transport.done();
});

it('refuses to retry a GitLab merge-train pipeline', async () => {
  const pipeline = {
    id: 9,
    sha: 'abc',
    ref: 'refs/merge-requests/7/train',
    status: 'failed',
  };
  const transport = scriptedFetch([
    {
      path: `${root}/merge_requests/7?include_rebase_in_progress=true`,
      value: { ...mr, head_pipeline: pipeline },
    },
    {
      path: `${root}/merge_requests/7/pipelines?per_page=100&page=1`,
      value: [pipeline],
    },
    {
      path: `${root}/merge_trains/merge_requests/7`,
      value: {
        id: 10,
        status: 'fresh',
        target_branch: 'main',
        merge_request: { id: 100, iid: 7 },
        pipeline,
      },
    },
  ]);

  await expect(
    createGitLabScm({ ...options, fetch: transport.fetch }).retryFailedJobs(pr),
  ).rejects.toMatchObject({ refusal: { reason: 'train_pipeline_dropped' } });
  expect(transport.calls.some((call) => call.method === 'POST')).toBe(false);
  transport.done();
});

it('selects the newest current-head GitLab pipeline and keeps polling while it runs', async () => {
  const older = { id: 8, sha: 'abc', ref: 'ng-524', status: 'success' };
  const current = { id: 9, sha: 'abc', ref: 'ng-524', status: 'running' };
  const transport = scriptedFetch([
    {
      path: `${root}/merge_requests/7?include_rebase_in_progress=true`,
      value: { ...mr, head_pipeline: null },
    },
    {
      path: `${root}/merge_requests/7/pipelines?per_page=100&page=1`,
      value: [older, current],
    },
    {
      path: `${root}/pipelines/9/jobs?include_retried=false&per_page=100&page=1`,
      value: [],
    },
    {
      path: `${root}/merge_requests/7?include_rebase_in_progress=true`,
      value: { ...mr, head_pipeline: null },
    },
  ]);

  await expect(
    createGitLabScm({ ...options, fetch: transport.fetch }).waitForCi(pr, {
      logTailLines: 0,
    }),
  ).resolves.toEqual({ status: 'waiting' });
  transport.done();
});

it('posts one revision report note and recovers its existing marker on retry', async () => {
  const body = '<!-- rocky-review:run:revision -->\nA visual report';
  const transport = scriptedFetch([
    {
      path: `${root}/merge_requests/7?include_rebase_in_progress=true`,
      value: mr,
    },
    { path: `${root}/merge_requests/7/notes?per_page=100&page=1`, value: [] },
    {
      path: `${root}/merge_requests/7/notes`,
      method: 'POST',
      body: { body },
      value: { id: 99 },
    },
    {
      path: `${root}/merge_requests/7?include_rebase_in_progress=true`,
      value: mr,
    },
    {
      path: `${root}/merge_requests/7/notes?per_page=100&page=1`,
      value: [{ id: 99, body }],
    },
  ]);
  const adapter = createGitLabScm({ ...options, fetch: transport.fetch });
  await adapter.postReviewReport(pr, 'A visual report', 'run:revision');
  await adapter.postReviewReport(pr, 'A visual report', 'run:revision');
  transport.done();
});
