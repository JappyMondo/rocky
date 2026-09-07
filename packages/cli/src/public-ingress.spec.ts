import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { createServer, request, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDaemon,
  rockyPaths,
  runDoctor,
  writeInstanceConfig,
} from '@rocky/daemon';
import { afterEach, expect, it } from 'vitest';

import { createPublicIngress } from './public-ingress.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
});

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanup.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return address.port;
}

// node:http preserves the request target; fetch would normalize our attack cases.
function send(
  port: number,
  method: string,
  path: string,
  body = '',
  signature?: string,
) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          host: 'localhost',
          forwarded: 'for=127.0.0.1;host=localhost;proto=http',
          'x-forwarded-for': '127.0.0.1',
          'x-forwarded-host': 'localhost',
          'x-original-url': '/api/shutdown',
          'x-rewrite-url': '/api/shutdown',
          'x-http-method-override': 'POST',
          'content-type': 'application/json',
          ...(signature ? { 'linear-signature': signature } : {}),
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8').on('data', (chunk: string) => {
          text += chunk;
        });
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: text }),
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

it('only forwards the two exact public method/target pairs, never local controls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rocky-ingress-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'index.html'), '<h1>Local Rocky</h1>');
  await writeFile(join(root, 'app.js'), 'local asset');
  let shutdowns = 0;
  let events = 0;
  const seen: string[] = [];
  const { app, instanceId } = await createDaemon({
    webRoot: root,
    selfPing: false,
    onShutdown: () => {
      shutdowns++;
    },
    webhookSecret: async () => 'fixture-secret',
    onAgentSessionEvent: () => {
      events++;
    },
  });
  app.addHook('onRequest', async (req) => {
    seen.push(req.url);
  });
  // Sentinels for both today's and future local-only product routes.
  for (const path of [
    '/api/runs',
    '/api/settings',
    '/api/runs/r1/screenshots/a.png',
    '/api/future',
  ]) {
    app.all(path, async () => ({ private: true }));
  }
  await app.listen({ port: 0, host: '127.0.0.1' });
  cleanup.push(() => app.close());
  const address = app.server.address();
  if (!address || typeof address === 'string')
    throw new Error('no daemon port');
  const port = await listen(createPublicIngress(address.port));

  expect(await send(port, 'GET', '/api/ping')).toEqual({
    status: 200,
    body: JSON.stringify({ instanceId }),
  });
  const raw = JSON.stringify(
    {
      type: 'AgentSessionEvent',
      action: 'created',
      agentSession: { id: 'session' },
      webhookTimestamp: Date.now(),
    },
    null,
    2,
  );
  const signature = createHmac('sha256', 'fixture-secret')
    .update(raw)
    .digest('hex');
  expect(
    (await send(port, 'POST', '/api/linear/webhook', raw, signature)).status,
  ).toBe(200);
  expect(events).toBe(1);
  expect((await send(port, 'POST', '/api/linear/webhook', raw)).status).toBe(
    401,
  );
  expect(
    (await send(port, 'POST', '/api/linear/webhook', raw, 'bad')).status,
  ).toBe(401);
  expect(events).toBe(1);
  seen.length = 0;

  const paths = rockyPaths(join(root, 'home'));
  await writeInstanceConfig(paths, {
    server: { port: address.port },
    publicUrl: `http://127.0.0.1:${port}`,
  });
  const report = await runDoctor(paths, {
    checkHarness: async (harness) => ({ harness, ok: true, detail: 'fixture' }),
  });
  expect(report.find((check) => check.name === 'publicUrl')?.ok).toBe(true);
  expect(seen).toEqual(['/api/ping', '/api/ping']);
  seen.length = 0;

  const denied = [
    '/',
    '/app.js',
    '/api/health',
    '/api/shutdown',
    '/api/linear/oauth/callback',
    '/api/runs',
    '/api/settings',
    '/api/runs/r1/screenshots/a.png',
    '/api/future',
    '/api/ping/',
    '/api/ping?x=1',
    '/api/ping/suffix',
    '/api/linear/webhook/',
    '/api/linear/webhook?x=1',
    '/api/linear/webhook/suffix',
    '/api/../api/ping',
    '/api/%2e%2e/api/ping',
    '/api/%70ing',
    '/api%2fping',
    '//api/ping',
    '/api//ping',
    '/api\\ping',
    '/API/ping',
    'http://localhost/api/ping',
  ];
  for (const path of denied) {
    for (const method of ['GET', 'POST'])
      expect(
        (await send(port, method, path, method === 'POST' ? '{}' : '')).status,
        `${method} ${path}`,
      ).toBe(404);
  }
  for (const [method, path] of [
    ['HEAD', '/api/ping'],
    ['POST', '/api/ping'],
    ['OPTIONS', '/api/ping'],
    ['GET', '/api/linear/webhook'],
    ['PUT', '/api/linear/webhook'],
    ['DELETE', '/api/linear/webhook'],
  ]) {
    expect((await send(port, method, path)).status).toBe(404);
  }
  expect(seen).toEqual([]);
  expect(shutdowns).toBe(0);
  expect((await send(address.port, 'GET', '/api/health')).status).toBe(200);
  expect((await send(address.port, 'GET', '/')).body).toContain('Local Rocky');
  expect((await send(address.port, 'POST', '/api/shutdown', '{}')).status).toBe(
    200,
  );
  expect(shutdowns).toBe(1);
});

it('strips authority/override and private response headers in both directions', async () => {
  const daemonPort = await listen(
    createServer((req, res) => {
      expect(req.headers['x-original-url']).toBeUndefined();
      expect(req.headers.authorization).toBeUndefined();
      expect(req.headers.forwarded).toBeUndefined();
      expect(req.headers.host).toBe(`127.0.0.1:${daemonPort}`);
      res.writeHead(200, {
        'x-rocky-version': 'private',
        'set-cookie': 'private',
        location: '/api/settings',
      });
      res.end('{"instanceId":"fixture"}');
    }),
  );
  const port = await listen(createPublicIngress(daemonPort));
  const response = await fetch(`http://127.0.0.1:${port}/api/ping`, {
    headers: {
      authorization: 'private',
      'x-original-url': '/api/shutdown',
      forwarded: 'for=127.0.0.1',
    },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('set-cookie')).toBeNull();
  expect(response.headers.get('location')).toBeNull();
  expect(response.headers.get('x-rocky-version')).toBeNull();
  expect(await response.json()).toEqual({ instanceId: 'fixture' });
});

it('fails closed when the daemon is unavailable', async () => {
  const port = await listen(createPublicIngress(0));
  expect((await send(port, 'GET', '/api/ping')).status).toBe(502);
  expect((await send(port, 'POST', '/api/shutdown', '{}')).status).toBe(404);
});
