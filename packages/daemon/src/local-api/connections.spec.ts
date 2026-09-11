import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { rockyPaths } from '../config/paths.js';
import {
  newRepositoryProfile,
  readRepositoryProfile,
  writeRepositoryProfile,
} from '../config/profiles.js';
import {
  readCredentials,
  writeCredentials,
  writeInstanceConfig,
} from '../config/store.js';
import { createOAuthCallbackBroker } from '../linear/callback.js';
import { McpAuthError } from '../mcp/auth.js';
import { withAbort } from '../abort.js';
import { LocalConnections } from './connections.js';
import { LocalProfiles } from './profiles.js';
import { LocalArtifacts, LocalSettings, registerLocalApi } from './index.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
async function setup(
  options: ConstructorParameters<typeof LocalConnections>[1] = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'rocky-connections-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const paths = rockyPaths(root);
  await writeInstanceConfig(paths, {});
  await writeCredentials(paths, {
    linear: {
      clientId: 'client',
      clientSecret: 'private-client',
      accessToken: 'access',
      refreshToken: 'refresh',
      redirectUri: 'https://rocky.example/api/linear/oauth/callback',
    },
    mcp: { 'https://oauth.example/mcp': { private: 'KEEP' } },
    repos: { demo: { KEEP: 'unchanged' } },
  });
  await writeRepositoryProfile(paths, {
    ...newRepositoryProfile({
      id: 'demo',
      remote: 'https://github.com/acme/demo.git',
    }),
    mcp: {
      mcpServers: {
        remote: {
          type: 'http',
          url: 'https://api.example/mcp',
          headers: { Authorization: 'Bearer PRIVATE', 'X-Env': '${ENV_TOKEN}' },
        },
        local: { command: 'node', env: { PRIVATE: 'hidden' } },
        oauth: { type: 'http', url: 'https://oauth.example/mcp' },
      },
    },
  });
  const fetch = vi.fn(async (url) =>
    String(url).includes('/oauth/token')
      ? response({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          expires_in: 86400,
        })
      : response({ data: { viewer: { id: 'agent', name: 'Rocky' } } }),
  );
  const oauth = createOAuthCallbackBroker();
  const service = new LocalConnections(paths, { fetch, oauth, ...options });
  cleanups.push(() => service.close());
  return { paths, service, fetch, oauth, profiles: new LocalProfiles(paths) };
}

it('lists profile tools without exposing header/environment credentials and caches a verified Linear status', async () => {
  const f = await setup();
  const first = await f.service.read();
  expect(first.linear.state).toBe('connected');
  expect(
    first.profiles[0].servers.find((server) => server.name === 'oauth')?.auth
      .state,
  ).toBe('saved');
  expect(JSON.stringify(first)).not.toContain('Bearer PRIVATE');
  expect(JSON.stringify(first)).not.toContain('hidden');
  expect(first.profiles[0].servers[0].definition).toMatchObject({
    headers: { Authorization: null, 'X-Env': '${ENV_TOKEN}' },
  });
  await f.service.checkLinear();
  expect(f.fetch).toHaveBeenCalledTimes(1);
  await f.service.checkLinear(true);
  expect(f.fetch).toHaveBeenCalledTimes(2);
});

it('adds, edits and removes servers and grants with stale-write protection and secret preservation', async () => {
  const f = await setup();
  let view = await f.profiles.mcp('demo');
  const before = view.revision;
  view = await f.service.save('demo', 'new', {
    revision: view.revision,
    definition: { type: 'sse', url: 'https://new.example/mcp' },
    allowed: true,
  });
  expect(view.servers.find((server) => server.name === 'new')?.allowed).toBe(
    true,
  );
  await expect(
    f.service.save('demo', 'remote', { revision: before, definition: {} }),
  ).rejects.toMatchObject({ statusCode: 409 });
  const remote = view.servers.find((server) => server.name === 'remote')!;
  view = await f.service.save('demo', 'remote', {
    revision: view.revision,
    definition: remote.definition,
    allowed: false,
  });
  expect(
    JSON.stringify((await readRepositoryProfile(f.paths, 'demo')).mcp),
  ).toContain('Bearer PRIVATE');
  view = await f.service.save('demo', 'local', {
    revision: view.revision,
    definition: {
      type: 'stdio',
      command: 'node',
      args: ['server.js'],
      env: { PRIVATE: null, NEW: 'value' },
    },
    allowed: true,
  });
  view = await f.service.save('demo', 'new', { revision: view.revision }, true);
  expect(view.servers.some((server) => server.name === 'new')).toBe(false);
  expect((await readRepositoryProfile(f.paths, 'demo')).grants.mcp).toEqual([
    'local',
  ]);
  expect(
    (await readRepositoryProfile(f.paths, 'demo')).workflow.source,
  ).toContain('export');
});

it.each([
  ['prototype', {}],
  ['new', { definition: {} }],
  ['new', { definition: { type: 'http', url: 'x', headers: { A: null } } }],
  ['new', { definition: { type: 'stdio', command: '', args: [] } }],
  ['new', { definition: { type: 'http', url: 'x', headers: { A: 1 } } }],
])('rejects invalid MCP writes %s %j', async (name, data) => {
  const f = await setup();
  const view = await f.profiles.mcp('demo');
  await expect(
    f.service.save(name === 'prototype' ? 'demo' : 'demo', name, {
      revision: view.revision,
      ...data,
    }),
  ).rejects.toMatchObject({ statusCode: 400 });
});

it('tests tools using the selected profile and forgets URL-scoped credentials without deleting other secrets', async () => {
  const inspectMcp = vi.fn(async () => ['search', 'read']);
  const f = await setup({ inspectMcp });
  expect(await f.service.check('demo', 'local')).toEqual({
    state: 'connected',
    message: 'Connected · 2 tools available',
    tools: ['search', 'read'],
  });
  expect(inspectMcp).toHaveBeenCalledWith(
    expect.objectContaining({ name: 'local' }),
    expect.any(AbortSignal),
    expect.any(Object),
  );
  expect((await f.service.check('demo', 'missing')).state).toBe('error');
  expect((await f.service.check('demo', 'oauth')).state).toBe('login-required');
  inspectMcp.mockRejectedValueOnce(new Error('PRIVATE RESPONSE'));
  expect(JSON.stringify(await f.service.check('demo', 'local'))).not.toContain(
    'PRIVATE RESPONSE',
  );
  await f.service.forget('demo', 'oauth');
  expect((await readCredentials(f.paths)).mcp).toEqual({});
  expect((await readCredentials(f.paths)).repos.demo.KEEP).toBe('unchanged');
  await expect(f.service.forget('demo', 'local')).rejects.toMatchObject({
    statusCode: 400,
  });
});

it('shows revoked Linear authentication separately from network failure and missing configuration', async () => {
  const f = await setup({
    fetch: async () =>
      response({ error_description: 'Refresh token revoked PRIVATE' }, 400),
  });
  const original = await readCredentials(f.paths);
  await writeCredentials(f.paths, {
    ...original,
    linear: { ...original.linear, expiresAt: 1 },
  });
  const state = await f.service.checkLinear();
  expect(state.state).toBe('login-required');
  expect(state.message).not.toContain('PRIVATE');
  expect((await readCredentials(f.paths)).linear?.refreshToken).toBe('refresh');
  await writeCredentials(f.paths, { linear: {} });
  expect((await f.service.checkLinear(true)).state).toBe('not-configured');
  const g = await setup({
    fetch: async () => {
      throw new Error('PRIVATE NETWORK');
    },
  });
  expect((await g.service.checkLinear()).state).toBe('error');
});

it('reauthorizes Linear through the existing state-checked callback and atomically persists new tokens', async () => {
  const f = await setup();
  const login = f.service.startLinear();
  expect(f.service.startLinear().id).toBe(login.id);
  await vi.waitFor(() =>
    expect(f.service.login(login.id).status).toBe('waiting'),
  );
  const url = new URL(f.service.login(login.id).authorizationUrl!);
  expect(url.searchParams.get('actor')).toBe('app');
  expect(f.oauth.deliver({ state: 'wrong', code: 'code' })).toBe(false);
  expect(
    f.oauth.deliver({
      state: url.searchParams.get('state')!,
      code: 'approved',
    }),
  ).toBe(true);
  await vi.waitFor(() =>
    expect(f.service.login(login.id).status).toBe('success'),
  );
  expect((await readCredentials(f.paths)).linear).toMatchObject({
    accessToken: 'new-access',
    refreshToken: 'new-refresh',
    clientSecret: 'private-client',
  });
  expect(
    (await readCredentials(f.paths)).mcp['https://oauth.example/mcp'],
  ).toEqual({ private: 'KEEP' });
  expect(f.service.login(login.id).authorizationUrl).toBeUndefined();
  expect((await f.service.cancel(login.id)).status).toBe('success');
});

it('cancels Linear login, handles denial and does not persist after app configuration changes', async () => {
  const f = await setup();
  const first = f.service.startLinear();
  await vi.waitFor(() =>
    expect(f.service.login(first.id).status).toBe('waiting'),
  );
  expect((await f.service.cancel(first.id)).status).toBe('cancelled');
  const second = f.service.startLinear();
  await vi.waitFor(() =>
    expect(f.service.login(second.id).status).toBe('waiting'),
  );
  f.oauth.deliver({
    state: new URL(
      f.service.login(second.id).authorizationUrl!,
    ).searchParams.get('state')!,
    error: 'denied PRIVATE',
  });
  await vi.waitFor(() =>
    expect(f.service.login(second.id).status).toBe('failed'),
  );
  expect(f.service.login(second.id).message).not.toContain('PRIVATE');
  const third = f.service.startLinear();
  await vi.waitFor(() =>
    expect(f.service.login(third.id).status).toBe('waiting'),
  );
  await writeCredentials(f.paths, { linear: { clientId: 'different' } });
  f.oauth.deliver({
    state: new URL(
      f.service.login(third.id).authorizationUrl!,
    ).searchParams.get('state')!,
    code: 'code',
  });
  await vi.waitFor(() =>
    expect(f.service.login(third.id).status).toBe('failed'),
  );
  expect(f.fetch).not.toHaveBeenCalled();
  expect(() => f.service.login('gone')).toThrow('Login expired');
  await expect(f.service.cancel('gone')).rejects.toMatchObject({
    statusCode: 404,
  });
});

it('runs MCP login in the background, preserves advanced settings and cancels before removing a server', async () => {
  const loginMcp = vi.fn(async (_config, name, options) => {
    await options.openBrowser(
      new URL('https://provider.example/authorize'),
      options.signal,
    );
    await withAbort(options.signal, () => new Promise<void>(() => undefined));
    return { server: name, url: 'https://oauth.example/mcp' };
  });
  const f = await setup({ loginMcp });
  const job = f.service.startMcp('demo', 'oauth', {
    clientId: 'registered',
    clientSecret: 'secret',
    callbackPort: 1234,
  });
  await vi.waitFor(() =>
    expect(f.service.login(job.id).status).toBe('waiting'),
  );
  expect(loginMcp).toHaveBeenCalledWith(
    expect.any(Object),
    'oauth',
    expect.objectContaining({ clientId: 'registered', callbackPort: 1234 }),
  );
  const view = await f.profiles.mcp('demo');
  await f.service.save('demo', 'oauth', { revision: view.revision }, true);
  expect(f.service.login(job.id).status).toBe('cancelled');
  expect(() =>
    f.service.startMcp('demo', 'oauth', { callbackPort: -1 }),
  ).toThrow('valid OAuth');
  const bad = f.service.startMcp('demo', 'missing', {});
  await vi.waitFor(() => expect(f.service.login(bad.id).status).toBe('failed'));
});

it('surfaces bounded MCP errors and successful completion', async () => {
  const loginMcp = vi
    .fn()
    .mockRejectedValueOnce(new McpAuthError('oauth', 'OAuth invalid_grant'))
    .mockResolvedValue({ server: 'oauth', url: 'https://oauth.example/mcp' });
  const f = await setup({ loginMcp });
  const a = f.service.startMcp('demo', 'oauth', {});
  await vi.waitFor(() => expect(f.service.login(a.id).status).toBe('failed'));
  expect(f.service.login(a.id).message).toContain('invalid_grant');
  const b = f.service.startMcp('demo', 'oauth', {});
  await vi.waitFor(() => expect(f.service.login(b.id).status).toBe('success'));
});

it('keeps unrelated logins alive on edits and cancels URL aliases before forgetting credentials', async () => {
  const f = await setup({
    loginMcp: async (_config, name, options) => {
      await options?.openBrowser?.(
        new URL('https://provider.example/authorize'),
        options.signal ?? AbortSignal.timeout(5000),
      );
      await withAbort(
        options?.signal,
        () => new Promise<void>(() => undefined),
      );
      return { server: name, url: 'https://oauth.example/mcp' };
    },
  });
  let view = await f.profiles.mcp('demo');
  view = await f.service.save('demo', 'alias', {
    revision: view.revision,
    definition: { type: 'http', url: 'https://oauth.example/mcp' },
  });
  const a = f.service.startMcp('demo', 'oauth', {});
  const b = f.service.startMcp('demo', 'alias', {});
  await vi.waitFor(() =>
    expect([
      f.service.login(a.id).status,
      f.service.login(b.id).status,
    ]).toEqual(['waiting', 'waiting']),
  );
  await f.service.save('demo', 'local', {
    revision: view.revision,
    definition: { type: 'stdio', command: 'updated' },
  });
  expect(f.service.login(a.id).status).toBe('waiting');
  await f.service.forget('demo', 'oauth');
  expect([f.service.login(a.id).status, f.service.login(b.id).status]).toEqual([
    'cancelled',
    'cancelled',
  ]);
  expect((await readCredentials(f.paths)).mcp).toEqual({});
});

it('offers reauthentication for a configured Linear app with missing tokens and rejects missing callback setup', async () => {
  const f = await setup();
  await writeCredentials(f.paths, {
    linear: {
      clientId: 'client',
      clientSecret: 'secret',
      redirectUri: 'https://rocky.example/callback',
    },
  });
  expect((await f.service.checkLinear()).state).toBe('login-required');
  expect(() => new LocalConnections(f.paths).startLinear()).toThrow(
    'callback is unavailable',
  );
  await writeCredentials(f.paths, {});
  const job = f.service.startLinear();
  await vi.waitFor(() => expect(f.service.login(job.id).status).toBe('failed'));
});

it('keeps connection APIs behind the local origin checks', async () => {
  const f = await setup();
  const app = Fastify();
  cleanups.push(() => app.close());
  await registerLocalApi(app, {
    runs: {
      list: async () => [],
      get: async () => undefined,
      journal: async () => [],
    },
    artifacts: new LocalArtifacts(f.paths),
    settings: new LocalSettings({
      paths: f.paths,
      boundServer: { host: '127.0.0.1', port: 7625 },
    }),
    connections: f.service,
  });
  expect(
    (
      await app.inject({
        url: '/api/connections',
        headers: { origin: 'https://evil.example' },
      })
    ).statusCode,
  ).toBe(403);
  expect((await app.inject('/api/connections')).statusCode).toBe(200);
  const check = await app.inject({
    method: 'POST',
    url: '/api/connections/linear/check',
  });
  expect(check.json().state).toBe('connected');
  const login = await app.inject({
    method: 'POST',
    url: '/api/connections/linear/login',
  });
  const id = login.json().id;
  expect((await app.inject(`/api/connections/logins/${id}`)).statusCode).toBe(
    200,
  );
  expect(
    (
      await app.inject({
        method: 'DELETE',
        url: `/api/connections/logins/${id}`,
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await app.inject({
        method: 'PUT',
        url: '/api/connections/profiles/demo/mcp/invalid%20name',
        payload: {},
      })
    ).statusCode,
  ).toBe(400);
  const view = await f.profiles.mcp('demo');
  const saved = await app.inject({
    method: 'PUT',
    url: '/api/connections/profiles/demo/mcp/added',
    payload: {
      revision: view.revision,
      definition: { type: 'stdio', command: 'node' },
    },
  });
  expect(saved.statusCode).toBe(200);
  expect(
    (
      await app.inject({
        method: 'DELETE',
        url: '/api/connections/profiles/demo/mcp/added',
        payload: { revision: saved.json().revision },
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/connections/profiles/demo/mcp/missing/check',
      })
    ).json().state,
  ).toBe('error');
  expect(
    (
      await app.inject({
        method: 'DELETE',
        url: '/api/connections/profiles/demo/mcp/oauth/credentials',
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/connections/profiles/demo/mcp/missing/login',
        payload: {},
      })
    ).statusCode,
  ).toBe(200);
});
