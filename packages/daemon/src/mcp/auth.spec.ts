import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildRedactionSet,
  createRedactor,
  readCredentials,
  rockyPaths,
  updateCredentials,
  type RockyPaths,
} from '../config/index.js';
import {
  loginMcpServer,
  parseMcpConfig,
  preflightMcp,
  readMcpConfig,
  resolveMcpServers,
  mcpUnauthorized,
  McpAuthError,
} from './index.js';

let paths: RockyPaths;
let closeServer: () => Promise<void>;

beforeEach(async () => {
  closeServer = async () => undefined;
  paths = rockyPaths(await mkdtemp(join(tmpdir(), 'rocky-mcp-auth-')));
});
afterEach(async () => {
  await closeServer?.();
  await rm(paths.root, { recursive: true, force: true });
});

async function authorizationServer() {
  let origin = '';
  const challenges = new Map<string, string>();
  const tokenRequests: URLSearchParams[] = [];
  const tokenHeaders: (string | undefined)[] = [];
  const authorizeResources: (string | null)[] = [];
  const requestPaths: string[] = [];
  let registration: Record<string, unknown> = {};
  let issuance = 0;
  const behavior: {
    revoke: boolean;
    omitRefresh: boolean;
    dcr: boolean;
    resource?: string;
    metadata: Record<string, unknown>;
    token?: Record<string, unknown>;
    tokenStatus: number;
    dcrStatus: number;
    discovery: 'oauth' | 'oidc';
    encoding: 'plain' | 'gzip' | 'chunked';
    resourceExtra: Record<string, unknown>;
    registrationExtra: Record<string, unknown>;
  } = {
    revoke: false,
    omitRefresh: false,
    dcr: true,
    metadata: {},
    tokenStatus: 200,
    dcrStatus: 200,
    discovery: 'oauth',
    encoding: 'plain',
    resourceExtra: {},
    registrationExtra: {},
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', origin);
    requestPaths.push(url.pathname);
    res.setHeader('content-type', 'application/json');
    const json = (value: unknown) => {
      const text = JSON.stringify(value);
      if (behavior.encoding === 'gzip') {
        const compressed = gzipSync(text);
        res.setHeader('content-encoding', 'gzip');
        res.setHeader('content-length', compressed.byteLength);
        res.end(compressed);
      } else if (behavior.encoding === 'chunked') {
        res.write(text.slice(0, 100));
        res.end(text.slice(100));
      } else {
        res.end(text);
      }
    };
    if (url.pathname === '/mcp') {
      res.writeHead(401, {
        'www-authenticate': `Bearer resource_metadata="${origin}/resource"`,
      });
      res.end();
    } else if (url.pathname === '/resource') {
      json({
        resource: behavior.resource ?? `${origin}/mcp`,
        authorization_servers: [origin],
        scopes_supported: ['tools', 'offline_access'],
        ...behavior.resourceExtra,
      });
    } else if (
      url.pathname ===
      `/.well-known/${behavior.discovery === 'oauth' ? 'oauth-authorization-server' : 'openid-configuration'}`
    ) {
      json({
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        ...(behavior.dcr && { registration_endpoint: `${origin}/register` }),
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        ...(behavior.discovery === 'oidc' && {
          jwks_uri: `${origin}/keys`,
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
        }),
        ...behavior.metadata,
      });
    } else if (url.pathname === '/register') {
      let body = '';
      for await (const chunk of req) body += chunk;
      registration = JSON.parse(body);
      res.statusCode = behavior.dcrStatus;
      json({
        ...registration,
        client_id: 'fixture-client',
        ...behavior.registrationExtra,
      });
    } else if (url.pathname === '/authorize') {
      authorizeResources.push(url.searchParams.get('resource'));
      const code =
        challenges.size === 0
          ? 'fixture-code'
          : `fixture-code-${challenges.size + 1}`;
      challenges.set(code, url.searchParams.get('code_challenge') ?? '');
      const callback = new URL(url.searchParams.get('redirect_uri') ?? '');
      callback.searchParams.set('code', code);
      callback.searchParams.set('state', url.searchParams.get('state') ?? '');
      res.writeHead(302, { location: callback.href });
      res.end();
    } else if (url.pathname === '/token') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const form = new URLSearchParams(body);
      tokenRequests.push(form);
      tokenHeaders.push(req.headers.authorization);
      if (form.get('grant_type') === 'refresh_token') {
        await new Promise((resolve) => setTimeout(resolve, 15));
        if (
          behavior.revoke ||
          form.get('refresh_token') !== `refresh-${issuance}`
        ) {
          res.writeHead(400);
          res.end(
            JSON.stringify({
              error: 'invalid_grant',
              error_description: 'access-1 refresh-1 PRIVATE-RESPONSE',
            }),
          );
          return;
        }
      }
      if (
        form.get('grant_type') === 'authorization_code' &&
        createHash('sha256')
          .update(form.get('code_verifier') ?? '')
          .digest('base64url') !== challenges.get(form.get('code') ?? '')
      ) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'invalid_grant' }));
        return;
      }
      issuance++;
      res.statusCode = behavior.tokenStatus;
      json(
        behavior.token ?? {
          access_token: `access-${issuance}`,
          ...(!behavior.omitRefresh && {
            refresh_token: `refresh-${issuance}`,
          }),
          token_type: 'Bearer',
          expires_in: 3600,
        },
      );
    } else if (url.pathname === '/redirect-token') {
      res.writeHead(307, { location: `${origin}/stolen-token` });
      res.end();
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('missing address');
  origin = `http://127.0.0.1:${address.port}`;
  closeServer = () =>
    new Promise((resolve, reject) => {
      server.closeAllConnections();
      server.close((error) => (error ? reject(error) : resolve()));
    });
  return {
    origin,
    url: `${origin}/mcp`,
    tokenRequests,
    tokenHeaders,
    authorizeResources,
    requestPaths,
    behavior,
    registration: () => registration,
  };
}

describe('Rocky-owned MCP OAuth', () => {
  it.each(['cancel', 'deadline', 'request-timeout'] as const)(
    'honors %s during code exchange even when fetch ignores cancellation, without a late write',
    async (reason) => {
      const as = await authorizationServer();
      const config = parseMcpConfig({ mcpServers: { api: { url: as.url } } });
      await loginMcpServer(config, 'api', {
        paths,
        openBrowser: async (url) => {
          await fetch(url);
        },
      });
      const before = await readFile(paths.credentialsFile, 'utf8');
      let exchanging!: () => void;
      let finish!: () => void;
      const started = new Promise<void>((resolve) => {
        exchanging = resolve;
      });
      const pending = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const abort = new AbortController();
      let callback = '';
      let lateBodyCancelled = false;
      const result = loginMcpServer(config, 'api', {
        paths,
        signal: abort.signal,
        timeoutMs: reason === 'deadline' ? 500 : 5000,
        requestTimeoutMs: reason === 'request-timeout' ? 100 : 5000,
        openBrowser: async (url) => {
          callback = (await fetch(url)).url;
        },
        fetch: async (input, init) => {
          const response = await fetch(input, init);
          if (String(input) === `${as.origin}/token`) {
            const text = await response.text();
            exchanging();
            await pending;
            if (reason === 'cancel')
              return new Response(
                new ReadableStream({
                  start(controller) {
                    controller.enqueue(new TextEncoder().encode(text));
                  },
                  cancel() {
                    lateBodyCancelled = true;
                    throw new Error('PRIVATE late cancel failed');
                  },
                }),
              );
            return new Response(text);
          }
          return response;
        },
      }).catch((error: unknown) => error);
      try {
        await started;
        if (reason === 'cancel') abort.abort();
        expect(
          await Promise.race([result, delay(1200).then(() => 'still waiting')]),
        ).toMatchObject({ name: 'McpAuthError', fix: 'rocky mcp login api' });
        await expect(fetch(callback)).rejects.toThrow();
        await updateCredentials(paths, (current) => current, {
          signal: AbortSignal.timeout(500),
        });
      } finally {
        abort.abort();
        finish();
        await result;
      }
      await delay(30);
      if (reason === 'cancel') expect(lateBodyCancelled).toBe(true);
      expect(await readFile(paths.credentialsFile, 'utf8')).toBe(before);
    },
  );

  it('applies decoded response ceilings during refresh without overwriting the existing credentials', async () => {
    const as = await authorizationServer();
    const config = parseMcpConfig({ mcpServers: { api: { url: as.url } } });
    await loginMcpServer(config, 'api', {
      paths,
      openBrowser: async (url) => {
        await fetch(url);
      },
    });
    const before = await readFile(paths.credentialsFile, 'utf8');
    as.behavior.encoding = 'gzip';
    as.behavior.token = {
      access_token: 'new',
      token_type: 'Bearer',
      scope: 'x'.repeat(8 * 1024 * 1024),
    };
    await expect(preflightMcp(config, { paths })).rejects.toThrow(
      /decoded.*262144/,
    );
    expect(await readFile(paths.credentialsFile, 'utf8')).toBe(before);
  });

  it.each(['client_id', 'client_secret'])(
    'rejects oversized DCR %s before opening the browser',
    async (field) => {
      const as = await authorizationServer();
      as.behavior.registrationExtra[field] = 'a'.repeat(16385);
      let opened = false;
      await expect(
        loginMcpServer(
          parseMcpConfig({ mcpServers: { api: { url: as.url } } }),
          'api',
          {
            paths,
            timeoutMs: 250,
            openBrowser: async (url) => {
              opened = true;
              await fetch(url);
            },
          },
        ),
      ).rejects.toThrow(/rocky mcp login api/);
      expect(opened).toBe(false);
      expect(as.tokenRequests).toEqual([]);
    },
  );
  it.each([
    ['metadata', 'plain'],
    ['metadata', 'gzip'],
    ['metadata', 'chunked'],
    ['resource', 'gzip'],
    ['registration', 'chunked'],
    ['token', 'plain'],
    ['token', 'gzip'],
    ['token-error', 'chunked'],
  ] as const)(
    'bounds decoded %s responses with %s transfer to 256 KiB without storing or echoing them',
    async (target, encoding) => {
      const as = await authorizationServer();
      as.behavior.encoding = encoding;
      const huge = 'PRIVATE-' + 'x'.repeat(8 * 1024 * 1024);
      if (target === 'metadata') as.behavior.metadata.extra = huge;
      else if (target === 'resource') as.behavior.resourceExtra.extra = huge;
      else if (target === 'registration')
        as.behavior.registrationExtra.extra = huge;
      else if (target === 'token')
        as.behavior.token = {
          access_token: 'token',
          token_type: 'Bearer',
          scope: huge,
        };
      else {
        as.behavior.tokenStatus = 400;
        as.behavior.token = { error: 'invalid_grant', error_description: huge };
      }
      const result = await loginMcpServer(
        parseMcpConfig({ mcpServers: { api: { url: as.url } } }),
        'api',
        {
          paths,
          openBrowser: async (url) => {
            await fetch(url);
          },
        },
      ).catch((error: unknown) => error);
      expect(result).toBeInstanceOf(McpAuthError);
      expect(String(result)).toMatch(/decoded.*262144/);
      expect(String(result)).not.toContain('PRIVATE');
      expect((await readCredentials(paths)).mcp).toEqual({});
    },
  );

  it('accepts decoded responses at the 256 KiB ceiling and rejects the next byte', async () => {
    const as = await authorizationServer();
    const config = parseMcpConfig({ mcpServers: { api: { url: as.url } } });
    const payload = { access_token: 'token', token_type: 'Bearer', extra: '' };
    payload.extra = 'x'.repeat(
      262144 - Buffer.byteLength(JSON.stringify(payload)),
    );
    as.behavior.token = payload;
    await loginMcpServer(config, 'api', {
      paths,
      openBrowser: async (url) => {
        await fetch(url);
      },
    });
    const before = await readFile(paths.credentialsFile, 'utf8');
    payload.extra += 'x';
    await expect(
      loginMcpServer(config, 'api', {
        paths,
        openBrowser: async (url) => {
          await fetch(url);
        },
      }),
    ).rejects.toThrow(/decoded.*262144/);
    expect(await readFile(paths.credentialsFile, 'utf8')).toBe(before);
  });

  it.each(['access_token', 'refresh_token', 'scope'])(
    'bounds %s to 16 KiB of UTF-8 without truncating it',
    async (field) => {
      const as = await authorizationServer();
      const config = parseMcpConfig({ mcpServers: { api: { url: as.url } } });
      as.behavior.token = {
        access_token: 'token',
        token_type: 'Bearer',
        [field]: 'a'.repeat(16384),
      };
      await loginMcpServer(config, 'api', {
        paths,
        openBrowser: async (url) => {
          await fetch(url);
        },
      });
      const before = await readFile(paths.credentialsFile, 'utf8');
      as.behavior.token[field] =
        field === 'scope' ? '\u00e9'.repeat(8193) : 'a'.repeat(16385);
      await expect(
        loginMcpServer(config, 'api', {
          paths,
          openBrowser: async (url) => {
            await fetch(url);
          },
        }),
      ).rejects.toThrow(/rocky mcp login api/);
      expect(await readFile(paths.credentialsFile, 'utf8')).toBe(before);
    },
  );

  it('bounds stored entries to 64 KiB even when metadata and individual strings fit', async () => {
    const as = await authorizationServer();
    as.behavior.metadata.token_endpoint_auth_methods_supported = [
      'none',
      ...Array.from({ length: 8 }, () => 'x'.repeat(8192)),
    ];
    await expect(
      loginMcpServer(
        parseMcpConfig({ mcpServers: { api: { url: as.url } } }),
        'api',
        {
          paths,
          openBrowser: async (url) => {
            await fetch(url);
          },
        },
      ),
    ).rejects.toThrow(/credential.*65536/);
    expect((await readCredentials(paths)).mcp).toEqual({});
  });

  it('bounds the MCP credential section to 1 MiB while preserving other logins and unrelated secrets', async () => {
    const as = await authorizationServer();
    const mcp = Object.fromEntries(
      Array.from({ length: 32 }, (_, i) => [
        `https://old-${i}.example/mcp`,
        { opaque: 'x'.repeat(32700) },
      ]),
    );
    expect(Buffer.byteLength(JSON.stringify(mcp, null, 2))).toBeLessThan(
      1048576,
    );
    await updateCredentials(paths, () => ({
      mcp,
      repos: { repo: { KEY: 'kept' } },
      linear: { accessToken: 'kept' },
    }));
    const before = await readFile(paths.credentialsFile, 'utf8');
    as.behavior.token = {
      access_token: 'x'.repeat(16384),
      token_type: 'Bearer',
    };
    await expect(
      loginMcpServer(
        parseMcpConfig({ mcpServers: { api: { url: as.url } } }),
        'api',
        {
          paths,
          openBrowser: async (url) => {
            await fetch(url);
          },
        },
      ),
    ).rejects.toThrow(/MCP credential.*1048576/);
    expect(await readFile(paths.credentialsFile, 'utf8')).toBe(before);
  });
  it.each(['cancel', 'deadline'] as const)(
    'honors %s after callback while the browser opener remains unresolved',
    async (reason) => {
      const as = await authorizationServer();
      let received!: () => void;
      let finishOpener!: () => void;
      const callbackReady = new Promise<void>((resolve) => {
        received = resolve;
      });
      const opener = new Promise<void>((resolve) => {
        finishOpener = resolve;
      });
      const abort = new AbortController();
      let callback = '';
      const result = loginMcpServer(
        parseMcpConfig({ mcpServers: { api: { url: as.url } } }),
        'api',
        {
          paths,
          signal: abort.signal,
          timeoutMs: reason === 'deadline' ? 500 : 5000,
          openBrowser: async (url) => {
            const response = await fetch(url);
            callback = response.url;
            received();
            await opener;
          },
        },
      ).catch((error: unknown) => error);
      try {
        await callbackReady;
        if (reason === 'cancel') {
          await delay(50);
          abort.abort();
        }
        expect(
          await Promise.race([result, delay(1200).then(() => 'still waiting')]),
        ).toMatchObject({ name: 'McpAuthError', fix: 'rocky mcp login api' });
        await expect(fetch(callback)).rejects.toThrow();
        expect(as.tokenRequests).toEqual([]);
      } finally {
        abort.abort();
        finishOpener();
        await result;
      }
      expect((await readCredentials(paths)).mcp).toEqual({});
    },
  );

  it.each(['cancel', 'deadline'] as const)(
    'honors %s after callback while another OS process holds the credential lock',
    async (reason) => {
      const as = await authorizationServer();
      const child = spawn(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
      import { createJiti } from 'jiti';
      const jiti = createJiti(${JSON.stringify(import.meta.url)});
      const { updateCredentials, rockyPaths } = await jiti.import('../config/index.ts');
      await updateCredentials(rockyPaths(${JSON.stringify(paths.root)}), async (current) => {
        process.stdout.write('locked\\n');
        await new Promise(resolve => process.stdin.once('data', resolve));
        return current;
      });
    `,
        ],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
      const exited = once(child, 'exit');
      let received!: () => void;
      const callbackReady = new Promise<void>((resolve) => {
        received = resolve;
      });
      const abort = new AbortController();
      let callback = '';
      let result: Promise<unknown> | undefined;
      try {
        const [ready] = await once(child.stdout, 'data');
        expect(String(ready)).toBe('locked\n');
        result = loginMcpServer(
          parseMcpConfig({ mcpServers: { api: { url: as.url } } }),
          'api',
          {
            paths,
            signal: abort.signal,
            timeoutMs: reason === 'deadline' ? 500 : 5000,
            openBrowser: async (url) => {
              const response = await fetch(url);
              callback = response.url;
              received();
            },
          },
        ).catch((error: unknown) => error);
        await callbackReady;
        if (reason === 'cancel') {
          await delay(50);
          abort.abort();
        }
        expect(
          await Promise.race([result, delay(1200).then(() => 'still waiting')]),
        ).toMatchObject({ name: 'McpAuthError', fix: 'rocky mcp login api' });
        await expect(fetch(callback)).rejects.toThrow();
        expect(as.tokenRequests).toEqual([]);
      } finally {
        abort.abort();
        child.stdin.end('release');
        await exited;
        await result;
      }
      await updateCredentials(paths, (current) => current, {
        signal: AbortSignal.timeout(500),
      });
      expect((await readCredentials(paths)).mcp).toEqual({});
      expect(as.tokenRequests).toEqual([]);
    },
  );
  it.each(['oauth', 'oidc'] as const)(
    'requires advertised S256 through %s discovery before registration or opening the browser',
    async (discovery) => {
      const as = await authorizationServer();
      as.behavior.discovery = discovery;
      const config = parseMcpConfig({ mcpServers: { api: { url: as.url } } });
      let opened = 0;
      for (const methods of [undefined, [], ['plain']]) {
        as.behavior.metadata.code_challenge_methods_supported = methods;
        await expect(
          loginMcpServer(config, 'api', {
            paths,
            openBrowser: async (url) => {
              opened++;
              await fetch(url);
            },
          }),
        ).rejects.toThrow(/advertise.*S256/);
        expect(opened).toBe(0);
        expect(as.requestPaths).not.toContain('/register');
        expect(as.tokenRequests).toEqual([]);
        expect((await readCredentials(paths)).mcp).toEqual({});
      }
      as.behavior.metadata.code_challenge_methods_supported = ['S256'];
      await loginMcpServer(config, 'api', {
        paths,
        openBrowser: async (url) => {
          await fetch(url);
        },
      });
      expect(as.tokenRequests).toHaveLength(1);
    },
  );
  it('logs in via discovery, DCR and PKCE to a private URL-keyed store without rewriting the repo', async () => {
    const as = await authorizationServer();
    const file = join(paths.root, 'mcp.json');
    const text = JSON.stringify({
      mcpServers: {
        api: { url: as.url },
        browser: { command: 'npx', args: ['${ROCKY_SCREENSHOT_DIR}'] },
      },
    });
    await writeFile(file, text);
    const result = await loginMcpServer(await readMcpConfig(file), 'api', {
      paths,
      openBrowser: async (url) => {
        expect((await fetch(url)).status).toBe(200);
      },
    });

    expect(result).toEqual({ server: 'api', url: as.url });
    expect((await readCredentials(paths)).mcp).toMatchObject({
      [as.url]: {
        tokens: { access_token: 'access-1', refresh_token: 'refresh-1' },
      },
    });
    expect(as.registration()).toMatchObject({
      client_name: 'Rocky',
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      scope: 'tools offline_access',
    });
    expect(as.tokenRequests[0].get('resource')).toBe(as.url);
    expect(as.tokenRequests[0].get('code')).toBe('fixture-code');
    expect((await stat(paths.credentialsFile)).mode & 0o777).toBe(0o600);
    expect(await readFile(file, 'utf8')).toBe(text);
    expect(await readFile(paths.credentialsFile, 'utf8')).not.toContain(
      'fixture-code',
    );
  });

  it('shares URL-keyed tokens across repo aliases and serializes expired-token refresh across concurrent attempts', async () => {
    const as = await authorizationServer();
    const first = parseMcpConfig({
      mcpServers: { api: { url: as.url, headers: { 'X-Workspace': 'first' } } },
    });
    const second = parseMcpConfig({
      mcpServers: {
        other: { type: 'sse', url: as.url },
        local: { command: 'true' },
      },
    });
    const options = {
      paths,
      now: () => 0,
      openBrowser: async (url: URL) => {
        await fetch(url);
      },
    };
    await loginMcpServer(first, 'api', options);
    const initial = await resolveMcpServers(first, ['api'], options);
    expect(initial[0].config).toMatchObject({
      headers: { Authorization: 'Bearer access-1', 'X-Workspace': 'first' },
    });

    const expired = { paths, now: () => 4_000_000 };
    const attempts = await Promise.all(
      Array.from({ length: 6 }, () =>
        resolveMcpServers(second, ['other'], expired),
      ),
    );
    for (const attempt of attempts)
      expect(attempt).toEqual([
        {
          name: 'other',
          config: {
            type: 'sse',
            url: as.url,
            headers: { Authorization: 'Bearer access-2' },
          },
        },
      ]);
    expect(
      as.tokenRequests.filter(
        (form) => form.get('grant_type') === 'refresh_token',
      ),
    ).toHaveLength(1);
    expect(initial[0].config).toMatchObject({
      headers: { Authorization: 'Bearer access-1' },
    });
    expect(first.mcpServers.api).toMatchObject({
      headers: { 'X-Workspace': 'first' },
    });

    await loginMcpServer(second, 'other', options);
    expect(
      (await resolveMcpServers(first, ['api'], options))[0].config,
    ).toMatchObject({ headers: { Authorization: 'Bearer access-3' } });
    expect(Object.keys((await readCredentials(paths)).mcp)).toEqual([as.url]);
  });

  it('forces a Preflight refresh even for an unexpired token, and preserves a refresh token omitted by the server', async () => {
    const as = await authorizationServer();
    const config = parseMcpConfig({
      mcpServers: {
        api: { url: as.url },
        alias: { url: as.url },
        unknown: { url: 'https://never-logged-in.example/mcp' },
        local: { command: 'true' },
      },
    });
    const options = {
      paths,
      now: () => 0,
      openBrowser: async (url: URL) => {
        await fetch(url);
      },
    };
    await loginMcpServer(config, 'api', options);
    as.behavior.omitRefresh = true;
    expect(await preflightMcp(config, options)).toEqual(['api']);
    expect((await readCredentials(paths)).mcp).toMatchObject({
      [as.url]: {
        tokens: { access_token: 'access-2', refresh_token: 'refresh-1' },
      },
    });
    expect(as.tokenRequests).toHaveLength(2);
  });

  it('fails revoked credentials and Harness-reported unauthorized Run-fatally with a named fix, never response secrets', async () => {
    const as = await authorizationServer();
    const config = parseMcpConfig({ mcpServers: { api: { url: as.url } } });
    await loginMcpServer(config, 'api', {
      paths,
      now: () => 0,
      openBrowser: async (url) => {
        await fetch(url);
      },
    });
    as.behavior.revoke = true;
    for (const attempt of [
      () => preflightMcp(config, { paths, now: () => 0 }),
      () => resolveMcpServers(config, ['api'], { paths, now: () => 4_000_000 }),
    ]) {
      const error = await attempt().catch((error: unknown) => error);
      expect(error).toBeInstanceOf(McpAuthError);
      expect(error).toMatchObject({ fatal: true, fix: 'rocky mcp login api' });
      expect(String(error)).toContain('invalid_grant');
      expect(String(error)).not.toMatch(/access-1|refresh-1|PRIVATE-RESPONSE/);
    }
    expect(mcpUnauthorized('api')).toMatchObject({
      fatal: true,
      fix: 'rocky mcp login api',
    });
  });

  it('passes never-logged-in servers through and respects an explicit Authorization header without contacting OAuth', async () => {
    const config = parseMcpConfig({
      mcpServers: {
        api: {
          url: 'https://example.com/mcp',
          headers: { authorization: 'Bearer manual' },
        },
        public: { url: 'https://public.example/mcp' },
        local: { command: 'true' },
      },
    });
    const options = {
      paths,
      fetch: async () => {
        throw new Error('must not fetch');
      },
    };
    expect(
      await resolveMcpServers(config, ['api', 'public', 'local'], options),
    ).toEqual([
      {
        name: 'api',
        config: {
          type: 'http',
          url: 'https://example.com/mcp',
          headers: { authorization: 'Bearer manual' },
        },
      },
      {
        name: 'public',
        config: { type: 'http', url: 'https://public.example/mcp' },
      },
      { name: 'local', config: { type: 'stdio', command: 'true' } },
    ]);
    expect(await preflightMcp(config, options)).toEqual([]);
    expect((await readCredentials(paths)).mcp).toEqual({});
  });

  it('names both no-DCR workarounds and supports a pre-registered client without touching repo config', async () => {
    const as = await authorizationServer();
    as.behavior.dcr = false;
    const config = parseMcpConfig({ mcpServers: { api: { url: as.url } } });
    const options = {
      paths,
      openBrowser: async (url: URL) => {
        await fetch(url);
      },
    };
    await expect(loginMcpServer(config, 'api', options)).rejects.toThrow(
      /--client-id \/ --client-secret.*\$\{VAR\} Authorization header/,
    );
    await expect(
      loginMcpServer(config, 'api', { ...options, clientSecret: 'PRIVATE' }),
    ).rejects.not.toThrow('PRIVATE');
    await loginMcpServer(config, 'api', {
      ...options,
      clientId: 'static-client',
    });
    expect(as.tokenRequests[0].get('client_id')).toBe('static-client');
    expect(as.registration()).toEqual({});
  });

  it.each([
    { issuer: 'https://wrong.example' },
    { token_endpoint: 'http://insecure.example/token' },
    { authorization_endpoint: 'http://insecure.example/authorize' },
    { registration_endpoint: 'http://insecure.example/register' },
    { response_types_supported: ['token'] },
    { code_challenge_methods_supported: ['plain'] },
  ])(
    'refuses unsafe or incompatible OAuth metadata before opening the browser',
    async (metadata) => {
      const as = await authorizationServer();
      as.behavior.metadata = metadata;
      await expect(
        loginMcpServer(
          parseMcpConfig({ mcpServers: { api: { url: as.url } } }),
          'api',
          {
            paths,
            openBrowser: async () => {
              throw new Error('PRIVATE browser should not open');
            },
          },
        ),
      ).rejects.toThrow(/rocky mcp login api/);
      expect(as.tokenRequests).toEqual([]);
      expect((await readCredentials(paths)).mcp).toEqual({});
    },
  );

  it.each([
    { access_token: 'SECRET\r\nInjected: yes', token_type: 'Bearer' },
    { access_token: '', token_type: 'Bearer' },
    { access_token: 'SECRET', token_type: 'DPoP' },
    { access_token: 'SECRET', token_type: 'Bearer', expires_in: -1 },
    { error: 'invalid_grant', error_description: 'SECRET' },
  ])(
    'never stores malformed tokens or leaks token responses',
    async (token) => {
      const as = await authorizationServer();
      as.behavior.token = token;
      as.behavior.tokenStatus = 'error' in token ? 400 : 200;
      const error = await loginMcpServer(
        parseMcpConfig({ mcpServers: { api: { url: as.url } } }),
        'api',
        {
          paths,
          openBrowser: async (url) => {
            await fetch(url);
          },
        },
      ).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(McpAuthError);
      expect(String(error)).not.toContain('SECRET');
      expect((await readCredentials(paths)).mcp).toEqual({});
    },
  );

  it('rejects a mismatched resource and a failed DCR without persisting partial client secrets', async () => {
    const as = await authorizationServer();
    const config = parseMcpConfig({ mcpServers: { api: { url: as.url } } });
    const options = {
      paths,
      openBrowser: async (url: URL) => {
        await fetch(url);
      },
    };
    as.behavior.resource = 'https://other.example/mcp';
    await expect(loginMcpServer(config, 'api', options)).rejects.toThrow(
      /resource.*match/,
    );
    as.behavior.resource = undefined;
    as.behavior.dcrStatus = 403;
    await expect(loginMcpServer(config, 'api', options)).rejects.toThrow(
      /rocky mcp login api/,
    );
    expect((await readCredentials(paths)).mcp).toEqual({});
  });

  it('ignores wrong state, duplicate state, missing code and unrelated requests before accepting exactly one callback', async () => {
    const as = await authorizationServer();
    await loginMcpServer(
      parseMcpConfig({ mcpServers: { api: { url: as.url } } }),
      'api',
      {
        paths,
        openBrowser: async (url) => {
          const response = await fetch(url, { redirect: 'manual' });
          const callback = new URL(response.headers.get('location') ?? '');
          const bad = new URL(callback);
          bad.searchParams.set(
            'state',
            '\u00e9'.repeat((callback.searchParams.get('state') ?? '').length),
          );
          expect((await fetch(bad)).status).toBe(400);
          bad.searchParams.set('state', 'wrong');
          expect((await fetch(bad)).status).toBe(400);
          bad.searchParams.set(
            'state',
            'x'.repeat((callback.searchParams.get('state') ?? '').length),
          );
          expect((await fetch(bad)).status).toBe(400);
          bad.search = callback.search;
          bad.searchParams.append(
            'state',
            callback.searchParams.get('state') ?? '',
          );
          expect((await fetch(bad)).status).toBe(400);
          bad.search = callback.search;
          bad.searchParams.delete('code');
          expect((await fetch(bad)).status).toBe(400);
          expect((await fetch(callback, { method: 'POST' })).status).toBe(404);
          expect((await fetch(new URL('/unrelated', callback))).status).toBe(
            404,
          );
          expect((await fetch(callback)).status).toBe(200);
        },
      },
    );
    expect(as.tokenRequests).toHaveLength(1);
  });

  it('denial, browser failure, callback timeout and cancellation leave no credentials or listener', async () => {
    const as = await authorizationServer();
    const config = parseMcpConfig({ mcpServers: { api: { url: as.url } } });
    let callback = '';
    await expect(
      loginMcpServer(config, 'api', {
        paths,
        openBrowser: async (url) => {
          const denied = new URL(url.searchParams.get('redirect_uri') ?? '');
          denied.searchParams.set('state', url.searchParams.get('state') ?? '');
          denied.searchParams.set('error', 'access_denied');
          denied.searchParams.set('error_description', 'PRIVATE-DENIAL');
          callback = denied.href;
          await fetch(denied);
        },
      }),
    ).rejects.toThrow(/authorization was denied/);
    await expect(fetch(callback)).rejects.toThrow();
    await expect(
      loginMcpServer(config, 'api', {
        paths,
        openBrowser: async () => {
          throw new Error('PRIVATE-BROWSER');
        },
      }),
    ).rejects.not.toThrow('PRIVATE-BROWSER');
    await expect(
      loginMcpServer(config, 'api', {
        paths,
        timeoutMs: 80,
        openBrowser: async () => undefined,
      }),
    ).rejects.toThrow(/timed out|cancelled/);
    await expect(
      loginMcpServer(config, 'api', {
        paths,
        signal: AbortSignal.abort(),
        openBrowser: async () => undefined,
      }),
    ).rejects.toThrow(/rocky mcp login api/);
    expect((await readCredentials(paths)).mcp).toEqual({});
  });

  it('Preflight fails non-refreshable or malformed stored tokens and leaves unrelated credentials intact', async () => {
    const as = await authorizationServer();
    as.behavior.token = { access_token: 'no-expiry', token_type: 'Bearer' };
    const config = parseMcpConfig({ mcpServers: { api: { url: as.url } } });
    await updateCredentials(paths, (current) => ({
      ...current,
      linear: { accessToken: 'LINEAR' },
      repos: { repo: { KEY: 'REPO' } },
    }));
    await loginMcpServer(config, 'api', {
      paths,
      openBrowser: async (url) => {
        await fetch(url);
      },
    });
    expect(
      (await resolveMcpServers(config, ['api'], { paths }))[0].config,
    ).toMatchObject({ headers: { Authorization: 'Bearer no-expiry' } });
    await expect(preflightMcp(config, { paths })).rejects.toThrow(
      /cannot refresh/,
    );
    await updateCredentials(paths, (current) => ({
      ...current,
      mcp: { [as.url]: 'CORRUPT-TOKEN' },
    }));
    await expect(preflightMcp(config, { paths })).rejects.not.toThrow(
      'CORRUPT-TOKEN',
    );
    expect(await readCredentials(paths)).toMatchObject({
      linear: { accessToken: 'LINEAR' },
      repos: { repo: { KEY: 'REPO' } },
    });
    const redact = createRedactor(
      buildRedactionSet({}, await readCredentials(paths)),
    );
    expect(redact('LINEAR REPO CORRUPT-TOKEN')).toBe(
      '[redacted] [redacted] [redacted]',
    );
  });

  it.each(['client_secret_basic', 'client_secret_post'])(
    'uses %s and the exact resource indicator for code exchange and refresh',
    async (method) => {
      const as = await authorizationServer();
      as.behavior.dcr = false;
      as.behavior.resource = as.origin;
      as.behavior.metadata.token_endpoint_auth_methods_supported = [method];
      const config = parseMcpConfig({ mcpServers: { api: { url: as.url } } });
      await loginMcpServer(config, 'api', {
        paths,
        clientId: 'client:id',
        clientSecret: 's e:c+ret',
        openBrowser: async (url) => {
          await fetch(url);
        },
      });
      await preflightMcp(config, { paths });
      expect(as.authorizeResources).toEqual([as.origin]);
      for (const [index, request] of as.tokenRequests.entries()) {
        expect(request.get('resource')).toBe(as.origin);
        if (method === 'client_secret_basic') {
          expect(
            Buffer.from(
              as.tokenHeaders[index]?.slice(6) ?? '',
              'base64',
            ).toString(),
          ).toBe('client%3Aid:s+e%3Ac%2Bret');
          expect(request.has('client_secret')).toBe(false);
        } else {
          expect(request.get('client_id')).toBe('client:id');
          expect(request.get('client_secret')).toBe('s e:c+ret');
        }
      }
    },
  );

  it('coordinates rotating refresh tokens across independent OS processes', async () => {
    const as = await authorizationServer();
    const config = parseMcpConfig({ mcpServers: { api: { url: as.url } } });
    await loginMcpServer(config, 'api', {
      paths,
      now: () => 0,
      openBrowser: async (url) => {
        await fetch(url);
      },
    });
    const script = `
      import { createJiti } from 'jiti';
      const jiti = createJiti(${JSON.stringify(import.meta.url)});
      const { resolveMcpServers, parseMcpConfig } = await jiti.import('./index.ts');
      const { rockyPaths } = await jiti.import('../config/index.ts');
      const config = parseMcpConfig({ mcpServers: { alias: { url: ${JSON.stringify(as.url)} } } });
      const result = await resolveMcpServers(config, ['alias'], { paths: rockyPaths(${JSON.stringify(paths.root)}), now: () => 4000000 });
      console.log(JSON.stringify(result));
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
    for (const child of children)
      expect(JSON.parse(child.stdout)[0].config.headers.Authorization).toBe(
        'Bearer access-2',
      );
    expect(
      as.tokenRequests.filter(
        (form) => form.get('grant_type') === 'refresh_token',
      ),
    ).toHaveLength(1);
  });

  it('serializes concurrent login exchanges with persistence, without holding the lock during the browser dance', async () => {
    const as = await authorizationServer();
    const config = parseMcpConfig({ mcpServers: { api: { url: as.url } } });
    const options = {
      paths,
      fetch: async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        const response = await fetch(input, init);
        if (
          String(input) === `${as.origin}/token` &&
          new URLSearchParams(String(init?.body)).get('code') === 'fixture-code'
        )
          await new Promise((resolve) => setTimeout(resolve, 40));
        return response;
      },
      openBrowser: async (url: URL) => {
        await updateCredentials(paths, (current) => ({
          ...current,
          repos: { repo: { KEY: 'unrelated' } },
        }));
        await fetch(url);
      },
    };
    await Promise.all([
      loginMcpServer(config, 'api', options),
      loginMcpServer(config, 'api', options),
    ]);
    expect(
      (await resolveMcpServers(config, ['api'], { paths }))[0].config,
    ).toMatchObject({ headers: { Authorization: 'Bearer access-2' } });
    expect((await readCredentials(paths)).repos).toEqual({
      repo: { KEY: 'unrelated' },
    });
  });

  it('refuses stdio login and unknown names without any OAuth request', async () => {
    const config = parseMcpConfig({
      mcpServers: { local: { command: 'true' } },
    });
    const options = { paths, openBrowser: async () => undefined };
    await expect(loginMcpServer(config, 'local', options)).rejects.toThrow(
      /stdio/,
    );
    await expect(
      resolveMcpServers(config, ['missing'], options),
    ).rejects.toThrow(/mcp.json.*missing.*local/);
    await expect(loginMcpServer(config, 'missing', options)).rejects.toThrow(
      /mcp.json.*missing.*local/,
    );
  });

  it('rejects incomplete client flags and unsupported client authentication', async () => {
    const as = await authorizationServer();
    const config = parseMcpConfig({ mcpServers: { api: { url: as.url } } });
    const options = {
      paths,
      openBrowser: async (url: URL) => {
        await fetch(url);
      },
    };
    await expect(
      loginMcpServer(config, 'api', { ...options, clientSecret: 'PRIVATE' }),
    ).rejects.toThrow(/requires --client-id/);
    as.behavior.metadata.token_endpoint_auth_methods_supported = [
      'private_key_jwt',
    ];
    await expect(
      loginMcpServer(config, 'api', { ...options, clientId: 'static' }),
    ).rejects.toThrow(/unsupported OAuth client authentication/);
    expect(as.tokenRequests).toEqual([]);
  });

  it('bounds refresh requests and never exposes thrown network diagnostics', async () => {
    const as = await authorizationServer();
    const config = parseMcpConfig({ mcpServers: { api: { url: as.url } } });
    await loginMcpServer(config, 'api', {
      paths,
      openBrowser: async (url) => {
        await fetch(url);
      },
    });
    await expect(
      preflightMcp(config, { paths, requestTimeoutMs: 1 }),
    ).rejects.toThrow(/rocky mcp login api/);
    const before = await readFile(paths.credentialsFile, 'utf8');
    await expect(
      preflightMcp(config, {
        paths,
        fetch: async () => {
          throw new Error('PRIVATE-REFRESH');
        },
      }),
    ).rejects.not.toThrow('PRIVATE-REFRESH');
    expect(await readFile(paths.credentialsFile, 'utf8')).toBe(before);
  });

  it('rejects tampered credential URLs or resources without leaking their values', async () => {
    const as = await authorizationServer();
    const config = parseMcpConfig({ mcpServers: { api: { url: as.url } } });
    await loginMcpServer(config, 'api', {
      paths,
      openBrowser: async (url) => {
        await fetch(url);
      },
    });
    const original = (await readCredentials(paths)).mcp[as.url];
    if (original === null || typeof original !== 'object')
      throw new Error('missing stored auth');
    for (const patch of [
      { issuer: 'PRIVATE invalid URL' },
      { resource: 'https://wrong.example/mcp' },
      { tokenEndpoint: 'http://insecure.example/token' },
    ]) {
      await updateCredentials(paths, (current) => ({
        ...current,
        mcp: { [as.url]: { ...original, ...patch } },
      }));
      const error = await preflightMcp(config, { paths }).catch(
        (error: unknown) => error,
      );
      expect(error).toBeInstanceOf(McpAuthError);
      expect(String(error)).not.toContain('PRIVATE');
    }
    expect(as.tokenRequests).toHaveLength(1);
  });

  it('does not forward OAuth credentials on HTTP redirects', async () => {
    const as = await authorizationServer();
    as.behavior.metadata.token_endpoint = `${as.origin}/redirect-token`;
    const config = parseMcpConfig({ mcpServers: { api: { url: as.url } } });
    await expect(
      loginMcpServer(config, 'api', {
        paths,
        clientId: 'client',
        clientSecret: 'PRIVATE',
        openBrowser: async (url) => {
          await fetch(url);
        },
      }),
    ).rejects.toThrow(/rocky mcp login api/);
    expect(as.requestPaths).toContain('/redirect-token');
    expect(as.requestPaths).not.toContain('/stolen-token');
    expect((await readCredentials(paths)).mcp).toEqual({});
  });
});
