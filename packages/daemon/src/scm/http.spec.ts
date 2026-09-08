import { expect, it } from 'vitest';
import { z } from 'zod';
import { ScmHttp } from './http.js';

const repository = {
  id: 'lead',
  project: 'team/repo',
  baseBranch: 'main',
};

function http(fetch: typeof globalThis.fetch, apiUrl = 'https://scm.test') {
  return new ScmHttp(
    {
      repo: repository,
      branch: 'ng-524',
      token: 'secret-token',
      apiUrl,
      fetch,
    },
    'https://default.test',
  );
}

it('rejects unsafe endpoint and repository configuration before sending a request', () => {
  const fetch: typeof globalThis.fetch = async () => Response.json({});
  expect(() => http(fetch, 'http://scm.test')).toThrow(
    'SCM API requires HTTPS',
  );
  expect(
    () =>
      new ScmHttp(
        {
          repo: { ...repository, project: 'team/../repo' },
          branch: 'ng-524',
          token: 'secret-token',
          fetch,
        },
        'https://default.test',
      ),
  ).toThrow('SCM requires a token and an unambiguous project path');
});

it('refuses invalid JSON and schema mismatches from the platform', async () => {
  const invalidJson = http(async () => new Response('not json'));
  await expect(
    invalidJson.request('GET', '/value', z.object({ ok: z.boolean() })),
  ).rejects.toMatchObject({ refusal: { reason: 'invalid_response' } });

  const invalidShape = http(async () => Response.json({ ok: 'nope' }));
  await expect(
    invalidShape.request('GET', '/value', z.object({ ok: z.boolean() })),
  ).rejects.toMatchObject({ refusal: { reason: 'invalid_response' } });
});

it('handles an empty success response and paginates bounded lists', async () => {
  const empty = http(async () => new Response(null, { status: 204 }));
  await expect(empty.request('POST', '/retry', z.undefined())).resolves.toBe(
    undefined,
  );

  const calls: string[] = [];
  const values = Array.from({ length: 100 }, (_, id) => ({ id }));
  const paged = http(async (url) => {
    const path = new URL(String(url)).pathname + new URL(String(url)).search;
    calls.push(path);
    return Response.json(path.endsWith('page=1') ? values : []);
  });
  await expect(
    paged.list('/items', z.object({ id: z.number() })),
  ).resolves.toHaveLength(100);
  expect(calls).toEqual([
    '/items?per_page=100&page=1',
    '/items?per_page=100&page=2',
  ]);
});

it('tails a secure redirected log without forwarding the developer token', async () => {
  const calls: { url: string; headers: Headers }[] = [];
  const client = http(async (url, init) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers) });
    if (String(url).endsWith('/logs'))
      return new Response(null, {
        status: 302,
        headers: { location: 'https://download.test/log' },
      });
    return new Response('one\ntwo\nthree\n');
  });

  await expect(client.logTail('/logs', 2)).resolves.toBe('two\nthree');
  expect(calls[0]?.headers.get('authorization')).toBe('Bearer secret-token');
  expect(calls[1]?.headers.get('authorization')).toBeNull();
});

it('avoids downloading unnecessary or bodyless log tails', async () => {
  let calls = 0;
  const client = http(async () => {
    calls++;
    return new Response(null);
  });

  await expect(client.logTail('/logs', 0)).resolves.toBe('');
  await expect(client.logTail('/logs', 1)).resolves.toBe('');
  expect(calls).toBe(1);
});

it('bounds both transport scopes and conditional-response cache entries', async () => {
  const fetch: typeof globalThis.fetch = async () =>
    Response.json({ ok: true }, { headers: { etag: 'fixture' } });
  const schema = z.object({ ok: z.boolean() });
  for (let id = 0; id <= 256; id++) {
    const client = new ScmHttp(
      {
        repo: repository,
        branch: 'ng-524',
        token: `secret-token-${id}`,
        fetch,
      },
      'https://default.test',
    );
    await client.request('GET', `/cached-${id}`, schema);
  }
  const cached = http(fetch);
  for (let id = 0; id <= 256; id++)
    await cached.request('GET', `/entry-${id}`, schema);
});

it('refuses unsafe log redirects and redacts GraphQL error tokens', async () => {
  const unsafeRedirect = http(
    async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'http://download.test/log' },
      }),
  );
  await expect(unsafeRedirect.logTail('/logs', 2)).rejects.toMatchObject({
    refusal: { reason: 'invalid_response' },
  });

  const graphql = http(async () =>
    Response.json({
      errors: [{ type: 'FORBIDDEN', message: 'token secret-token is revoked' }],
    }),
  );
  await expect(
    graphql.graphql('query Query { viewer { id } }', {}, z.object({})),
  ).rejects.toMatchObject({
    refusal: {
      reason: 'permission_denied',
      message: expect.stringContaining('[redacted]'),
    },
  });
});

it.each([
  [401, 'permission_denied'],
  [409, 'head_changed'],
  [405, 'blocked_status'],
  [500, 'unavailable'],
] as const)(
  'maps HTTP %i to the named SCM refusal %s',
  async (status, reason) => {
    const client = http(async () => Response.json({}, { status }));
    await expect(
      client.request('GET', '/value', z.object({ ok: z.boolean() })),
    ).rejects.toMatchObject({ status, refusal: { reason } });
  },
);

it('parks after exhausted quota even when the response itself succeeds', async () => {
  let calls = 0;
  const reset = Math.ceil(Date.now() / 1000) + 60;
  const client = http(async () => {
    calls++;
    return Response.json(
      { ok: true },
      {
        headers: {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(reset),
        },
      },
    );
  });

  await expect(
    client.request('GET', '/value', z.object({ ok: z.boolean() })),
  ).resolves.toEqual({ ok: true });
  await expect(
    client.request('GET', '/another-value', z.object({ ok: z.boolean() })),
  ).rejects.toMatchObject({ refusal: { reason: 'rate_limited' } });
  expect(calls).toBe(1);
});

it('keeps malformed GraphQL payloads and unavailable log downloads fail closed', async () => {
  const malformed = http(async () => Response.json({ data: { viewer: null } }));
  await expect(
    malformed.graphql(
      'query Query { viewer { id } }',
      {},
      z.object({ viewer: z.object({ id: z.string() }) }),
    ),
  ).rejects.toMatchObject({ refusal: { reason: 'invalid_response' } });

  const blocked = http(async () =>
    Response.json({
      errors: [{ message: 'merge policy blocks this request' }],
    }),
  );
  await expect(
    blocked.graphql('query Query { viewer { id } }', {}, z.object({})),
  ).rejects.toMatchObject({
    refusal: { reason: 'blocked_status' },
  });

  const download = http(async (url) =>
    String(url).endsWith('/logs')
      ? new Response(null, {
          status: 302,
          headers: { location: 'https://download.test/log' },
        })
      : new Response(null, { status: 404 }),
  );
  await expect(download.logTail('/logs', 1)).rejects.toMatchObject({
    refusal: { reason: 'unavailable' },
  });
  await expect(download.logTail('/logs', -1)).rejects.toThrow(
    'logTailLines must be between 0 and 10000',
  );
});
