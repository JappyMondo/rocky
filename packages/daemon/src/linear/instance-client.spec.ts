import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { rockyPaths } from '../config/paths.js';
import { readCredentials, writeCredentials } from '../config/store.js';
import { createInstanceLinearClient } from './instance-client.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'rocky-linear-transaction-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const paths = rockyPaths(root);
  await writeCredentials(paths, {
    linear: {
      accessToken: 'expired',
      refreshToken: 'old-refresh',
      clientId: 'client',
      clientSecret: 'secret',
      expiresAt: 1,
    },
    repos: { example: { KEEP: 'untouched' } },
  });
  return paths;
}

it('coordinates rotating Linear refresh tokens across independent OS processes', async () => {
  const paths = await fixture();
  let requests = 0;
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests++;
    if (
      new URLSearchParams(body).get('refresh_token') !== 'old-refresh' ||
      requests > 1
    ) {
      response.writeHead(400).end(JSON.stringify({ error: 'invalid_grant' }));
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        access_token: 'shared-access',
        refresh_token: 'rotated-refresh',
        expires_in: 86400,
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing fixture port');
  const script = `
    import { createJiti } from 'jiti';
    const jiti = createJiti(${JSON.stringify(import.meta.url)});
    const { createInstanceLinearClient } = await jiti.import('./instance-client.ts');
    const { rockyPaths } = await jiti.import('../config/paths.ts');
    const client = createInstanceLinearClient(rockyPaths(${JSON.stringify(paths.root)}), {
      fetch: (_url, init) => fetch(${JSON.stringify(`http://127.0.0.1:${address.port}`)}, init),
    });
    console.log(await client.accessToken());
  `;
  const children = await Promise.all(
    Array.from({ length: 3 }, () =>
      promisify(execFile)(process.execPath, [
        '--input-type=module',
        '-e',
        script,
      ]),
    ),
  );
  expect(children.map((child) => child.stdout.trim())).toEqual([
    'shared-access',
    'shared-access',
    'shared-access',
  ]);
  expect(requests).toBe(1);
  expect((await readCredentials(paths)).linear?.refreshToken).toBe(
    'rotated-refresh',
  );
  expect((await readCredentials(paths)).repos.example.KEEP).toBe('untouched');
});

it('keeps the old refresh token when the provider omits a replacement and reuses a fresh token', async () => {
  const paths = await fixture();
  const provider = vi.fn(
    async () =>
      new Response(JSON.stringify({ access_token: 'new', expires_in: 86400 })),
  );
  const client = createInstanceLinearClient(paths, {
    fetch: provider,
    now: () => 1000,
  });
  expect(await client.accessToken()).toBe('new');
  expect(
    await createInstanceLinearClient(paths, {
      fetch: provider,
      now: () => 2000,
    }).accessToken(),
  ).toBe('new');
  expect(provider).toHaveBeenCalledTimes(1);
  expect((await readCredentials(paths)).linear?.refreshToken).toBe(
    'old-refresh',
  );
});

it('leaves credentials intact on refused refresh and releases the lock for recovery', async () => {
  const paths = await fixture();
  const before = await readCredentials(paths);
  const client = createInstanceLinearClient(paths, {
    fetch: async () =>
      new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
  });
  await expect(client.accessToken()).rejects.toThrow('invalid_grant');
  expect(await readCredentials(paths)).toEqual(before);
  await writeCredentials(paths, {
    ...before,
    linear: {
      ...before.linear,
      accessToken: 'recovered',
      expiresAt: undefined,
    },
  });
  expect(await client.accessToken()).toBe('recovered');
});

it('rejects missing tokens, missing refresh configuration and cancelled reads', async () => {
  const paths = await fixture();
  const client = createInstanceLinearClient(paths);
  await writeCredentials(paths, {});
  await expect(client.accessToken()).rejects.toThrow('access token');
  await writeCredentials(paths, {
    linear: { accessToken: 'expired', expiresAt: 1 },
  });
  await expect(client.accessToken()).rejects.toThrow('refresh token');
  await expect(
    createInstanceLinearClient(paths, {
      signal: AbortSignal.abort(),
    }).accessToken(),
  ).rejects.toThrow();
});
