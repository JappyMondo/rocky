import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { resolveUiEndpoint } from './ui-endpoint.js';

it('resolves assigned, output-discovered and JSON-file endpoints', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'rocky-ui-endpoint-'));
  await writeFile(join(workspace, 'server.json'), '{"listen":{"port":4312}}');
  await expect(
    resolveUiEndpoint(
      { kind: 'assigned-port', url: 'http://localhost' },
      { port: 4200, log: '', workspace },
    ),
  ).resolves.toBe('http://localhost:4200/');
  await expect(
    resolveUiEndpoint(
      { kind: 'output-regex', pattern: 'Local: (?<url>http://[^ ]+)' },
      { port: 0, log: 'Local: http://127.0.0.1:5173/', workspace },
    ),
  ).resolves.toBe('http://127.0.0.1:5173/');
  await expect(
    resolveUiEndpoint(
      { kind: 'json-file', path: 'server.json', pointer: '/listen/port' },
      { port: 0, log: '', workspace },
    ),
  ).resolves.toBe('http://127.0.0.1:4312/');
  await rm(workspace, { recursive: true, force: true });
});
it('supports fixed and command-discovered endpoints, rejecting invalid ports and protocols', async () => {
  const options = {
    port: 0,
    log: '',
    workspace: '/unused',
    execute: async () => '54321\n',
  };
  await expect(
    resolveUiEndpoint({ kind: 'command', command: 'read-port' }, options),
  ).resolves.toBe('http://127.0.0.1:54321/');
  await expect(
    resolveUiEndpoint({ kind: 'fixed', url: 'https://localhost/app' }, options),
  ).resolves.toBe('https://localhost/app');
  await expect(
    resolveUiEndpoint(
      { kind: 'output-regex', pattern: '(?<port>[0-9]+)' },
      { ...options, log: '99999' },
    ),
  ).resolves.toBeUndefined();
  await expect(
    resolveUiEndpoint({ kind: 'fixed', url: 'file:///etc/passwd' }, options),
  ).resolves.toBeUndefined();
});
