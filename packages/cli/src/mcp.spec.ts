import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readCredentials, rockyPaths, type RockyPaths } from '@rocky/daemon';
import { buildCli } from './cli.js';

let root: string;
let paths: RockyPaths;
let output: string[];
let errors: string[];
const io = {
  out: (line: string) => output.push(line),
  err: (line: string) => errors.push(line),
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'rocky-mcp-cli-'));
  paths = rockyPaths(join(root, 'home'));
  output = [];
  errors = [];
  await mkdir(join(root, '.rocky'));
  await writeFile(
    join(root, '.rocky/mcp.json'),
    JSON.stringify({
      mcpServers: {
        api: { url: 'https://mcp.example/mcp' },
        local: { command: 'true' },
      },
    }),
  );
});
afterEach(async () => {
  vi.unstubAllEnvs();
  process.exitCode = 0;
  await rm(root, { recursive: true, force: true });
});

describe('rocky mcp login', () => {
  it.each(
    process.platform === 'win32'
      ? ['injected']
      : ['injected', 'native', 'cancelled'],
  )(
    'logs in without a daemon using the native browser opener: %s',
    async (mode) => {
      const native = mode !== 'injected';
      const abort = new AbortController();
      const pidFile = join(root, 'opener-pid');
      if (native) {
        const bin = join(root, 'bin');
        await mkdir(bin);
        // Exercise the real OS-process boundary without opening a desktop browser.
        await writeFile(
          join(bin, process.platform === 'darwin' ? 'open' : 'xdg-open'),
          `#!${process.execPath}
import { writeFileSync } from 'node:fs';
const auth = new URL(process.argv.at(-1));
const callback = new URL(auth.searchParams.get('redirect_uri'));
callback.searchParams.set('state', auth.searchParams.get('state'));
callback.searchParams.set('code', 'callback-code');
const response = await fetch(callback);
if (response.status !== 200) process.exitCode = 1;
if (${mode === 'cancelled'}) {
  writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
  setInterval(() => {}, 1000);
}
`,
          { mode: 0o700 },
        );
        vi.stubEnv('PATH', `${bin}${delimiter}${process.env.PATH ?? ''}`);
      }
      const requests: string[] = [];
      const text = await readFile(join(root, '.rocky/mcp.json'), 'utf8');
      const cli = buildCli(io, {
        paths,
        mcp: {
          cwd: root,
          signal: abort.signal,
          fetch: async (input, init) => {
            const url = String(input);
            requests.push(url);
            if (url === 'https://mcp.example/mcp')
              return new Response(null, {
                status: 401,
                headers: {
                  'www-authenticate':
                    'Bearer resource_metadata="https://mcp.example/resource"',
                },
              });
            if (url === 'https://mcp.example/resource')
              return Response.json({
                resource: 'https://mcp.example/mcp',
                authorization_servers: ['https://auth.example'],
              });
            if (url.endsWith('/.well-known/oauth-authorization-server'))
              return Response.json({
                issuer: 'https://auth.example',
                authorization_endpoint: 'https://auth.example/authorize',
                token_endpoint: 'https://auth.example/token',
                response_types_supported: ['code'],
                code_challenge_methods_supported: ['S256'],
                token_endpoint_auth_methods_supported: ['client_secret_post'],
              });
            if (url === 'https://auth.example/token') {
              const form = new URLSearchParams(String(init?.body));
              expect(form.get('client_id')).toBe('cli-client');
              expect(form.get('client_secret')).toBe('PRIVATE-CLIENT');
              expect(form.get('code')).toBe('callback-code');
              expect(
                (form.get('code_verifier') ?? '').length,
              ).toBeGreaterThanOrEqual(43);
              return Response.json({
                access_token: 'PRIVATE-ACCESS',
                refresh_token: 'PRIVATE-REFRESH',
                token_type: 'Bearer',
              });
            }
            throw new Error('unexpected OAuth request');
          },
          openBrowser: native
            ? undefined
            : async (url) => {
                expect(url.hostname).toBe('auth.example');
                const callback = new URL(
                  url.searchParams.get('redirect_uri') ?? '',
                );
                expect(callback.hostname).toBe('127.0.0.1');
                callback.searchParams.set(
                  'state',
                  url.searchParams.get('state') ?? '',
                );
                callback.searchParams.set('code', 'callback-code');
                expect((await fetch(callback)).status).toBe(200);
              },
        },
      });
      const parsing = cli.parseAsync(
        [
          'mcp',
          'login',
          'api',
          '--client-id',
          'cli-client',
          '--client-secret',
          'PRIVATE-CLIENT',
          '--callback-port',
          '0',
        ],
        { from: 'user' },
      );
      if (mode === 'cancelled') {
        let pid: number | undefined;
        try {
          await expect
            .poll(() => readFile(pidFile, 'utf8'), { timeout: 2000 })
            .toMatch(/^\d+$/);
          pid = Number(await readFile(pidFile, 'utf8'));
          abort.abort();
          await parsing;
          expect(process.exitCode).toBe(1);
          expect(errors.join('\n')).toMatch(/timed out|cancelled/);
          expect((await readCredentials(paths)).mcp).toEqual({});
          await expect
            .poll(() => {
              try {
                process.kill(pid ?? 0, 0);
                return true;
              } catch {
                return false;
              }
            })
            .toBe(false);
        } finally {
          abort.abort();
          if (pid !== undefined) {
            try {
              process.kill(pid, 'SIGTERM');
            } catch {
              /* Already reaped. */
            }
          }
          await parsing;
        }
        return;
      }
      await parsing;
      expect(errors).toEqual([]);
      expect(output.join('\n')).toContain('Authenticated MCP server api');
      expect(output.join('\n')).not.toMatch(/PRIVATE|callback-code/);
      expect((await readCredentials(paths)).mcp).toMatchObject({
        'https://mcp.example/mcp': {
          tokens: { access_token: 'PRIVATE-ACCESS' },
        },
      });
      expect(await readFile(join(root, '.rocky/mcp.json'), 'utf8')).toBe(text);
      expect(requests).not.toContain('https://auth.example/register');
    },
  );

  it.each(['missing', 'local'])(
    'fails %s with a named fix rather than opening the browser',
    async (name) => {
      await buildCli(io, {
        paths,
        mcp: {
          cwd: root,
          openBrowser: async () => {
            throw new Error('should not open');
          },
        },
      }).parseAsync(['mcp', 'login', name], { from: 'user' });
      expect(process.exitCode).toBe(1);
      expect(errors.join('\n')).toMatch(/mcp.json.*(unknown MCP server|stdio)/);
      expect(output).toEqual([]);
    },
  );

  it('rejects invalid callback ports before starting login', async () => {
    await expect(
      buildCli(io, { paths, mcp: { cwd: root } }).parseAsync(
        ['mcp', 'login', 'api', '--callback-port', '65536'],
        { from: 'user' },
      ),
    ).rejects.toThrow(/port must be an integer from 0 to 65535/);
  });
});
