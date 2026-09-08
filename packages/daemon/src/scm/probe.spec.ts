import { expect, it } from 'vitest';
import { createGitHubScm, createGitLabScm } from './index.js';
import { githubOptions } from './scm.fixtures.js';

const gitlabOptions = {
  repo: { id: 'member', project: 'team/repo', baseBranch: 'main' },
  branch: 'ng-524',
  token: 'fixture',
};

it('reports denied GitHub contents permission without probing by mutation', async () => {
  const methods: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    methods.push(`${init?.method ?? 'GET'} ${path}`);
    const value =
      path === '/user'
        ? { login: 'dev' }
        : path === '/repos/team/repo'
          ? { private: true, permissions: { push: false } }
          : path === '/graphql'
            ? { data: { repository: { autoMergeAllowed: true } } }
            : path.endsWith('/pulls')
              ? []
              : undefined;
    if (value === undefined) throw new Error(`Unexpected ${path}`);
    return Response.json(value, { headers: { 'x-oauth-scopes': 'repo' } });
  };

  const probe = await createGitHubScm({
    ...githubOptions,
    fetch: fetcher,
  }).probe(new AbortController().signal);

  expect(probe).toMatchObject({
    merge: { status: 'denied' },
    sourcePush: { status: 'denied' },
    draft: { status: 'unknown' },
  });
  expect(methods).toEqual([
    'GET /user',
    'GET /repos/team/repo',
    'POST /graphql',
    'GET /repos/team/repo/pulls',
  ]);
});

it('fails closed for GitHub branch rules and locked branch policy', async () => {
  const fetcher: typeof fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    let value: unknown;
    if (path === '/user') value = { login: 'dev' };
    else if (path === '/repos/team/repo')
      value = { private: true, permissions: { push: true } };
    else if (path.endsWith('/rules/branches/main')) value = [];
    else if (path.endsWith('/branches/main')) value = { protected: true };
    else if (path.endsWith('/branches/main/protection'))
      value = {
        restrictions: { users: [], teams: [] },
        lock_branch: { enabled: true },
      };
    else if (path.endsWith('/rules/branches/ng-524'))
      value = [{ type: 'update' }];
    else if (path === '/graphql')
      value = { data: { repository: { autoMergeAllowed: true } } };
    else if (path.endsWith('/pulls')) value = [];
    else throw new Error(`Unexpected ${path}`);
    return Response.json(value, { headers: { 'x-oauth-scopes': 'repo' } });
  };

  const probe = await createGitHubScm({
    ...githubOptions,
    fetch: fetcher,
  }).probe(new AbortController().signal);

  expect(probe).toMatchObject({
    merge: { status: 'denied', source: expect.stringContaining('locked') },
    sourcePush: {
      status: 'unknown',
      source: expect.stringContaining('restricted'),
    },
  });
});

it('fails closed when GitHub cannot read auto-merge capability', async () => {
  const fetcher: typeof fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    const value =
      path === '/user'
        ? { login: 'dev' }
        : path === '/repos/team/repo'
          ? { private: true, permissions: { push: true } }
          : path.includes('/rules/branches/')
            ? []
            : path.includes('/branches/')
              ? { protected: false }
              : path === '/graphql'
                ? { errors: [{ type: 'FORBIDDEN', message: 'not allowed' }] }
                : path.endsWith('/pulls')
                  ? []
                  : undefined;
    if (value === undefined) throw new Error(`Unexpected ${path}`);
    return Response.json(value, { headers: { 'x-oauth-scopes': 'repo' } });
  };

  const probe = await createGitHubScm({
    ...githubOptions,
    fetch: fetcher,
  }).probe(new AbortController().signal);

  expect(probe.merge).toMatchObject({ status: 'unknown' });
});

it('names unobservable GitLab scope and branch-policy evidence as unknown', async () => {
  const fetcher: typeof fetch = async (url) => {
    const path = new URL(String(url)).pathname.replace(/^\/api\/v4/, '');
    if (path === '/user') return Response.json({ id: 1, username: 'dev' });
    if (path === '/version') return Response.json({ version: '19.1.0-ee' });
    if (path === '/projects/team%2Frepo')
      return Response.json({
        id: 5,
        merge_trains_enabled: false,
        permissions: {
          project_access: { access_level: 30 },
          group_access: null,
        },
      });
    if (path === '/personal_access_tokens/self' || path === '/oauth/token/info')
      return Response.json({}, { status: 404 });
    if (path.endsWith('/protected_branches'))
      return Response.json({}, { status: 403 });
    if (path.includes('/repository/branches/'))
      return Response.json({ protected: false, can_push: true });
    if (path.endsWith('/merge_requests')) return Response.json([]);
    throw new Error(`Unexpected ${path}`);
  };

  const probe = await createGitLabScm({
    ...gitlabOptions,
    fetch: fetcher,
  }).probe(new AbortController().signal);

  expect(probe).toMatchObject({
    merge: { status: 'unknown' },
    sourcePush: { status: 'unknown' },
    rebase: { status: 'unknown' },
    draft: { status: 'unknown' },
  });
});

it('recognizes GitLab protected-branch grants and source force-push policy', async () => {
  const fetcher: typeof fetch = async (url) => {
    const path = new URL(String(url)).pathname.replace(/^\/api\/v4/, '');
    if (path === '/user') return Response.json({ id: 1, username: 'dev' });
    if (path === '/version') return Response.json({ version: '19.1.0-ee' });
    if (path === '/projects/team%2Frepo')
      return Response.json({
        id: 5,
        merge_trains_enabled: false,
        permissions: {
          project_access: { access_level: 30 },
          group_access: null,
        },
      });
    if (path === '/personal_access_tokens/self')
      return Response.json({ scopes: ['api'] });
    if (path.endsWith('/protected_branches'))
      return Response.json([
        {
          name: 'main',
          merge_access_levels: [{ access_level: 30 }],
          push_access_levels: [{ access_level: 30 }],
          allow_force_push: false,
        },
        {
          name: 'ng-524',
          merge_access_levels: [],
          push_access_levels: [{ access_level: 30 }],
          allow_force_push: true,
        },
      ]);
    if (path.includes('/repository/branches/'))
      return Response.json({ protected: true, can_push: true });
    if (path.endsWith('/merge_requests')) return Response.json([]);
    throw new Error(`Unexpected ${path}`);
  };

  const probe = await createGitLabScm({
    ...gitlabOptions,
    fetch: fetcher,
  }).probe(new AbortController().signal);

  expect(probe).toMatchObject({
    merge: { status: 'allowed' },
    sourcePush: { status: 'allowed' },
    rebase: { status: 'allowed' },
    draft: { status: 'allowed' },
  });
});

it('names GitLab source push denial rather than offering a rebase fallback', async () => {
  const fetcher: typeof fetch = async (url) => {
    const path = new URL(String(url)).pathname.replace(/^\/api\/v4/, '');
    if (path === '/user') return Response.json({ id: 1, username: 'dev' });
    if (path === '/version') return Response.json({ version: '19.1.0-ee' });
    if (path === '/projects/team%2Frepo')
      return Response.json({
        id: 5,
        merge_trains_enabled: false,
        permissions: {
          project_access: { access_level: 30 },
          group_access: null,
        },
      });
    if (path === '/personal_access_tokens/self')
      return Response.json({ scopes: ['api'] });
    if (path.endsWith('/protected_branches')) return Response.json([]);
    if (path.includes('/repository/branches/'))
      return Response.json({
        protected: false,
        can_push: path.endsWith('/main'),
      });
    if (path.endsWith('/merge_requests')) return Response.json([]);
    throw new Error(`Unexpected ${path}`);
  };

  const probe = await createGitLabScm({
    ...gitlabOptions,
    fetch: fetcher,
  }).probe(new AbortController().signal);

  expect(probe).toMatchObject({
    merge: { status: 'allowed' },
    sourcePush: { status: 'denied' },
    rebase: { status: 'denied' },
  });
});

it('treats GitHub team-restricted target branches as unknown instead of bypassable', async () => {
  const fetcher: typeof fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    let value: unknown;
    if (path === '/user') value = { login: 'dev' };
    else if (path === '/repos/team/repo')
      value = { private: false, permissions: { push: true } };
    else if (path.includes('/rules/branches/')) value = [];
    else if (path.endsWith('/branches/main')) value = { protected: true };
    else if (path.endsWith('/branches/main/protection'))
      value = {
        restrictions: { users: [{ login: 'another-user' }], teams: [{}] },
      };
    else if (path.endsWith('/branches/ng-524')) value = { protected: false };
    else if (path === '/graphql')
      value = { data: { repository: { autoMergeAllowed: true } } };
    else if (path.endsWith('/pulls')) value = [];
    else throw new Error(`Unexpected ${path}`);
    return Response.json(value, {
      headers: { 'x-oauth-scopes': 'public_repo' },
    });
  };

  const probe = await createGitHubScm({
    ...githubOptions,
    fetch: fetcher,
  }).probe(new AbortController().signal);

  expect(probe).toMatchObject({
    merge: {
      status: 'unknown',
      source: expect.stringContaining('team-restricted'),
    },
    sourcePush: { status: 'allowed' },
    draft: { status: 'allowed' },
  });
});

it('fails closed when GitHub branch-policy reads are denied', async () => {
  const fetcher: typeof fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    const value =
      path === '/user'
        ? { login: 'dev' }
        : path === '/repos/team/repo'
          ? { private: true, permissions: { push: true } }
          : path.includes('/rules/branches/')
            ? undefined
            : path === '/graphql'
              ? { data: { repository: { autoMergeAllowed: true } } }
              : path.endsWith('/pulls')
                ? []
                : undefined;
    if (path.includes('/rules/branches/'))
      return Response.json({}, { status: 403 });
    if (value === undefined) throw new Error(`Unexpected ${path}`);
    return Response.json(value, { headers: { 'x-oauth-scopes': 'repo' } });
  };

  const probe = await createGitHubScm({
    ...githubOptions,
    fetch: fetcher,
  }).probe(new AbortController().signal);

  expect(probe).toMatchObject({
    merge: {
      status: 'unknown',
      source: expect.stringContaining('not fully observable'),
    },
    sourcePush: { status: 'unknown' },
  });
});

it('names GitLab group-only merge policy as unverified', async () => {
  const fetcher: typeof fetch = async (url) => {
    const path = new URL(String(url)).pathname.replace(/^\/api\/v4/, '');
    if (path === '/user') return Response.json({ id: 1, username: 'dev' });
    if (path === '/version') return Response.json({ version: '19.1.0-ee' });
    if (path === '/projects/team%2Frepo')
      return Response.json({
        id: 5,
        merge_trains_enabled: false,
        permissions: {
          project_access: { access_level: 30 },
          group_access: null,
        },
      });
    if (path === '/personal_access_tokens/self')
      return Response.json({ scopes: ['api'] });
    if (path.endsWith('/protected_branches'))
      return Response.json([
        {
          name: 'main',
          merge_access_levels: [{ group_id: 42 }],
          push_access_levels: [],
          allow_force_push: false,
        },
      ]);
    if (path.includes('/repository/branches/'))
      return Response.json({
        protected: path.endsWith('/main'),
        can_push: true,
      });
    if (path.endsWith('/merge_requests')) return Response.json([]);
    throw new Error(`Unexpected ${path}`);
  };

  const probe = await createGitLabScm({
    ...gitlabOptions,
    fetch: fetcher,
  }).probe(new AbortController().signal);

  expect(probe).toMatchObject({
    merge: {
      status: 'unknown',
      source: expect.stringContaining('group membership'),
    },
    sourcePush: { status: 'allowed' },
  });
});

it('uses the GitLab OAuth scope fallback and rejects an insufficient project role', async () => {
  const fetcher: typeof fetch = async (url) => {
    const path = new URL(String(url)).pathname.replace(/^\/api\/v4/, '');
    if (path === '/user') return Response.json({ id: 1, username: 'dev' });
    if (path === '/version') return Response.json({ version: '19.1.0-ee' });
    if (path === '/projects/team%2Frepo')
      return Response.json({
        id: 5,
        merge_trains_enabled: false,
        permissions: {
          project_access: { access_level: 20 },
          group_access: null,
        },
      });
    if (path === '/personal_access_tokens/self')
      return Response.json({}, { status: 404 });
    if (path === '/oauth/token/info') return Response.json({ scope: ['api'] });
    if (path.endsWith('/protected_branches')) return Response.json([]);
    if (path.includes('/repository/branches/'))
      return Response.json({ protected: false, can_push: true });
    if (path.endsWith('/merge_requests')) return Response.json([]);
    throw new Error(`Unexpected ${path}`);
  };

  const probe = await createGitLabScm({
    ...gitlabOptions,
    fetch: fetcher,
  }).probe(new AbortController().signal);

  expect(probe).toMatchObject({
    merge: { status: 'denied', source: expect.stringContaining('Developer') },
    sourcePush: { status: 'allowed' },
    draft: { status: 'unknown' },
  });
});

it.each([
  [
    'cannot observe the target branch',
    undefined,
    'unknown',
    'Target branch is not observable',
  ],
  [
    'cannot observe protected target grants',
    { protected: true, policies: [] },
    'unknown',
    'Allowed to merge policy is hidden or empty',
  ],
  [
    'proves the account is excluded from protected target grants',
    {
      protected: true,
      policies: [
        {
          name: 'main',
          merge_access_levels: [{ user_id: 2 }],
          push_access_levels: [],
          allow_force_push: false,
        },
      ],
    },
    'denied',
    "Account dev is not in main's Allowed to merge policy",
  ],
] as const)(
  'fails closed when GitLab %s',
  async (_case, target, status, source) => {
    const fetcher: typeof fetch = async (url) => {
      const path = new URL(String(url)).pathname.replace(/^\/api\/v4/, '');
      if (path === '/user') return Response.json({ id: 1, username: 'dev' });
      if (path === '/version') return Response.json({ version: '19.1.0-ee' });
      if (path === '/projects/team%2Frepo')
        return Response.json({
          id: 5,
          merge_trains_enabled: false,
          permissions: {
            project_access: { access_level: 30 },
            group_access: null,
          },
        });
      if (path === '/personal_access_tokens/self')
        return Response.json({ scopes: ['api'] });
      if (path.endsWith('/protected_branches'))
        return Response.json(
          target && 'policies' in target ? target.policies : [],
        );
      if (path.endsWith('/repository/branches/main')) {
        if (!target) return Response.json({}, { status: 404 });
        return Response.json({ protected: target.protected, can_push: true });
      }
      if (path.endsWith('/repository/branches/ng-524'))
        return Response.json({ protected: false, can_push: true });
      if (path.endsWith('/merge_requests')) return Response.json([]);
      throw new Error(`Unexpected ${path}`);
    };

    const probe = await createGitLabScm({
      ...gitlabOptions,
      fetch: fetcher,
    }).probe(new AbortController().signal);

    expect(probe.merge).toMatchObject({
      status,
      source: expect.stringContaining(source),
    });
  },
);

it.each([
  ['GitHub branch policy', 'GET /repos/team/repo/rules/branches/main'],
  ['GitHub completion capability', 'POST /graphql'],
])('propagates unexpected %s failures', async (_case, failure) => {
  const fetcher: typeof fetch = async (url, init) => {
    const path = `${init?.method ?? 'GET'} ${new URL(String(url)).pathname}`;
    if (path.endsWith(failure)) throw new Error('network unavailable');
    const value =
      path === 'GET /user'
        ? { login: 'dev' }
        : path === 'GET /repos/team/repo'
          ? { private: true, permissions: { push: true } }
          : path.includes('/rules/branches/')
            ? []
            : path.includes('/branches/')
              ? { protected: false }
              : path === 'POST /graphql'
                ? { data: { repository: { autoMergeAllowed: true } } }
                : path.endsWith('/pulls')
                  ? []
                  : undefined;
    if (value === undefined) throw new Error(`Unexpected ${path}`);
    return Response.json(value, { headers: { 'x-oauth-scopes': 'repo' } });
  };

  await expect(
    createGitHubScm({ ...githubOptions, fetch: fetcher }).probe(
      new AbortController().signal,
    ),
  ).rejects.toThrow('network unavailable');
});

it.each([
  ['scope lookup', '/personal_access_tokens/self'],
  ['OAuth fallback', '/oauth/token/info'],
  ['protected-branch policy', '/protected_branches'],
  ['source branch lookup', '/repository/branches/main'],
])('propagates unexpected GitLab %s failures', async (_case, failure) => {
  const fetcher: typeof fetch = async (url) => {
    const path = new URL(String(url)).pathname.replace(/^\/api\/v4/, '');
    if (path.endsWith(failure)) throw new Error('network unavailable');
    if (path === '/user') return Response.json({ id: 1, username: 'dev' });
    if (path === '/version') return Response.json({ version: '19.1.0-ee' });
    if (path === '/projects/team%2Frepo')
      return Response.json({
        id: 5,
        merge_trains_enabled: false,
        permissions: {
          project_access: { access_level: 30 },
          group_access: null,
        },
      });
    if (path === '/personal_access_tokens/self')
      return Response.json({}, { status: 404 });
    if (path === '/oauth/token/info') return Response.json({ scope: ['api'] });
    if (path.endsWith('/protected_branches')) return Response.json([]);
    if (path.includes('/repository/branches/'))
      return Response.json({ protected: false, can_push: true });
    if (path.endsWith('/merge_requests')) return Response.json([]);
    throw new Error(`Unexpected ${path}`);
  };

  await expect(
    createGitLabScm({ ...gitlabOptions, fetch: fetcher }).probe(
      new AbortController().signal,
    ),
  ).rejects.toThrow('network unavailable');
});
