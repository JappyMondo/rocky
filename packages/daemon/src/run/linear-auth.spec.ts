import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { rockyPaths } from '../config/paths.js';
import { parseInstanceConfig } from '../config/schema.js';
import { readCredentials, writeCredentials } from '../config/store.js';
import type { RockyLinearClient } from '../linear/client.js';
import { createProductionRuntime } from './production.js';

const captured = vi.hoisted(() => ({ clients: [] as RockyLinearClient[] }));
vi.mock('../linear/client.js', async (original) => {
  const actual = await original<typeof import('../linear/client.js')>();
  return {
    ...actual,
    RockyLinearClient: class extends actual.RockyLinearClient {
      constructor(
        options: ConstructorParameters<typeof actual.RockyLinearClient>[0],
      ) {
        super(options);
        captured.clients.push(this);
      }
    },
  };
});
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  captured.clients.length = 0;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it('persists a run-side refresh and shares it with another runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rocky-linear-refresh-'));
  roots.push(root);
  const paths = rockyPaths(root);
  await writeCredentials(paths, {
    linear: {
      accessToken: 'expired',
      refreshToken: 'refresh-old',
      expiresAt: 1,
      clientId: 'client',
      clientSecret: 'secret',
    },
    repos: { example: { KEEP: 'untouched' } },
  });
  const fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          access_token: 'access-new',
          refresh_token: 'refresh-new',
          expires_in: 86400,
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
  );
  vi.stubGlobal('fetch', fetch);
  for (let i = 0; i < 2; i++)
    createProductionRuntime({
      paths,
      config: () => parseInstanceConfig({}),
      request: async () => {
        throw new Error('No workflow should start');
      },
    });
  await expect(
    Promise.all(captured.clients.map((client) => client.accessToken())),
  ).resolves.toEqual(['access-new', 'access-new']);
  expect((await readCredentials(paths)).linear).toMatchObject({
    accessToken: 'access-new',
    refreshToken: 'refresh-new',
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect((await readCredentials(paths)).repos.example).toEqual({
    KEEP: 'untouched',
  });
});
