import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { rockyPaths } from '../config/paths.js';
import { writeInstanceConfig } from '../config/store.js';
import { writePidFile } from '../lifecycle/pidfile.js';
import { runDoctor } from './doctor.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.length = 0;
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'rocky-doctor-endpoint-'));
  roots.push(root);
  const paths = rockyPaths(root);
  await writeInstanceConfig(paths, {
    publicUrl: 'https://public.example',
    server: { port: 4567 },
  });
  return paths;
}

it('requires matching local and public identities, never public health', async () => {
  const paths = await fixture();
  const asked: string[] = [];
  const report = await runDoctor(paths, {
    checkHarness: async (harness) => ({ harness, ok: true, detail: 'fixture' }),
    fetch: async (url, options) => {
      asked.push(String(url));
      expect(options?.redirect).toBe('error');
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      return Response.json({ instanceId: 'local-instance' });
    },
  });
  expect(asked).toEqual([
    'http://127.0.0.1:4567/api/ping',
    'https://public.example/api/ping',
  ]);
  expect(report.find((check) => check.name === 'publicUrl')?.ok).toBe(true);
});

it.each([
  ['wrong instance', () => Response.json({ instanceId: 'someone-else' })],
  ['null', () => Response.json(null)],
  ['missing identity', () => Response.json({})],
  ['empty identity', () => Response.json({ instanceId: '' })],
  ['non-string identity', () => Response.json({ instanceId: 42 })],
  ['malformed JSON', () => new Response('password=secret-not-for-diagnostics')],
  [
    'HTTP failure',
    () => new Response('secret-not-for-diagnostics', { status: 503 }),
  ],
  [
    'redirect',
    () =>
      new Response('', { status: 302, headers: { location: '/api/health' } }),
  ],
  [
    'network failure',
    () => {
      throw new Error('secret-not-for-diagnostics');
    },
  ],
] as const)(
  'fails closed with a named fix for public %s',
  async (_name, response) => {
    const paths = await fixture();
    const report = await runDoctor(paths, {
      checkHarness: async (harness) => ({
        harness,
        ok: true,
        detail: 'fixture',
      }),
      fetch: async (url) =>
        String(url).startsWith('http://127.0.0.1:')
          ? Response.json({ instanceId: 'local-instance' })
          : response(),
    });
    const check = report.find((check) => check.name === 'publicUrl');
    expect(check?.ok).toBe(false);
    expect(check?.fix).toContain('docs/public-endpoint.md');
    expect(JSON.stringify(report)).not.toContain('secret-not-for-diagnostics');
  },
);

it.each([null, {}, { instanceId: '' }])(
  'does not trust the public answer when local identity is unavailable: %j',
  async (local) => {
    const paths = await fixture();
    const asked: string[] = [];
    const report = await runDoctor(paths, {
      checkHarness: async (harness) => ({
        harness,
        ok: true,
        detail: 'fixture',
      }),
      fetch: async (url) => {
        asked.push(String(url));
        return Response.json(local);
      },
    });
    expect(asked).toEqual(['http://127.0.0.1:4567/api/ping']);
    expect(report.find((check) => check.name === 'publicUrl')).toMatchObject({
      ok: false,
      fix: expect.stringContaining('rocky start'),
    });
  },
);

it('uses the live pidfile port after a CLI override, without trusting its URL', async () => {
  const paths = await fixture();
  await writePidFile(paths, {
    pid: process.pid,
    port: 4568,
    host: '0.0.0.0',
    url: 'https://wrong.example',
    version: '0.0.0',
    startedAt: new Date().toISOString(),
  });
  const asked: string[] = [];
  await runDoctor(paths, {
    checkHarness: async (harness) => ({ harness, ok: true, detail: 'fixture' }),
    fetch: async (url) => {
      asked.push(String(url));
      return Response.json({ instanceId: 'same' });
    },
  });
  expect(asked[0]).toBe('http://127.0.0.1:4568/api/ping');
});

it('bounds even a response body that never finishes', async () => {
  const paths = await fixture();
  const report = await runDoctor(paths, {
    timeoutMs: 20,
    checkHarness: async (harness) => ({ harness, ok: true, detail: 'fixture' }),
    fetch: async (url, options) => {
      if (String(url).startsWith('http://'))
        return Response.json({ instanceId: 'same' });
      return new Response(
        new ReadableStream({
          start(controller) {
            options?.signal?.addEventListener('abort', () =>
              controller.error(new Error('secret-not-for-diagnostics')),
            );
          },
        }),
      );
    },
  });
  expect(report.find((check) => check.name === 'publicUrl')?.ok).toBe(false);
  expect(JSON.stringify(report)).not.toContain('secret-not-for-diagnostics');
});

it('rejects URL credentials without sending or printing them', async () => {
  const paths = await fixture();
  await writeInstanceConfig(paths, {
    publicUrl: 'https://user:secret-not-for-diagnostics@public.example',
  });
  const asked: string[] = [];
  const report = await runDoctor(paths, {
    checkHarness: async (harness) => ({ harness, ok: true, detail: 'fixture' }),
    fetch: async (url) => {
      asked.push(String(url));
      return Response.json({ instanceId: 'same' });
    },
  });
  expect(asked).toEqual(['http://127.0.0.1:7625/api/ping']);
  expect(report.find((check) => check.name === 'publicUrl')?.ok).toBe(false);
  expect(JSON.stringify(report)).not.toContain('secret-not-for-diagnostics');
});
