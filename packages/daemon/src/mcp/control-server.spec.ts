import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, expect, it, vi } from 'vitest';
import { createRockyMcpServer } from './control-server.js';
import { rockyPaths } from '../config/paths.js';
import {
  ensureInstanceLayout,
  readInstanceConfig,
  writeInstanceConfig,
} from '../config/store.js';
import {
  newRepositoryProfile,
  readRepositoryProfile,
  writeRepositoryProfile,
} from '../config/profiles.js';
import {
  LocalArtifacts,
  LocalProfiles,
  LocalSettings,
  registerLocalApi,
  type LocalApiOptions,
} from '../local-api/index.js';
import {
  configurationView,
  mergeConfiguration,
} from '../local-api/configuration.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const dispose of cleanup.reverse()) await dispose();
  cleanup.length = 0;
});
async function setup(readOnly = false) {
  const root = await mkdtemp(join(tmpdir(), 'rocky-control-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const paths = rockyPaths(root);
  await ensureInstanceLayout(paths);
  await writeInstanceConfig(paths, {
    harnesses: {
      opencode: { env: { TOKEN: 'private-token', ACCOUNT: 'private-account' } },
    },
    extension: { password: 'hidden', keep: true },
  });
  await writeRepositoryProfile(paths, {
    ...newRepositoryProfile({
      id: 'demo',
      remote: 'https://github.com/acme/demo',
    }),
    settings: { env: { ACCOUNT: 'private-account' }, secretEnv: ['API_TOKEN'] },
  });
  const app = Fastify();
  cleanup.push(() => app.close());
  const manual = vi.fn<NonNullable<LocalApiOptions['manual']>>(async () => ({
    kind: 'started' as const,
    runId: 'ENG-1-run',
  }));
  await registerLocalApi(app, {
    runs: {
      list: async () => [],
      get: async () => undefined,
      journal: async () => [],
    },
    settings: new LocalSettings({
      paths,
      boundServer: { host: '127.0.0.1', port: 7625 },
    }),
    profiles: new LocalProfiles(paths),
    artifacts: new LocalArtifacts(paths),
    manual,
  });
  const url = new URL(await app.listen({ host: '127.0.0.1', port: 0 }));
  const server = createRockyMcpServer({
    address: async () => ({ host: url.hostname, port: Number(url.port) }),
    readOnly,
  });
  const client = new Client({ name: 'test-agent', version: '1' });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanup.push(
    () => server.close(),
    () => client.close(),
  );
  const call = async (name: string, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as Array<{ type: string; text: string }>;
    return {
      error: result.isError,
      text: content[0].text,
      value: () => JSON.parse(content[0].text),
    };
  };
  return { client, call, paths, manual };
}

it('discovers usable schemas and edits all instance options without disclosing saved secrets', async () => {
  const { client, call, paths } = await setup();
  const catalogue = await client.listTools();
  expect(catalogue.tools.length).toBeGreaterThan(20);
  expect(
    catalogue.tools.find((t) => t.name === 'rocky_trigger')?.annotations
      ?.readOnlyHint,
  ).toBe(false);
  const before = (await call('rocky_config_get')).value();
  expect(before.values.harnesses.opencode.env).toEqual({
    TOKEN: '[redacted]',
    ACCOUNT: '[redacted]',
  });
  expect(before.schema.properties).toHaveProperty('identity');
  const updated = await call('rocky_config_update', {
    revision: before.revision,
    patch: {
      publicUrl: 'https://rocky.example',
      identity: { name: 'Agent Rocky' },
      harnesses: before.values.harnesses,
      server: { port: 7777 },
    },
  });
  expect(updated.error).toBeUndefined();
  expect(updated.value().restartRequired).toBe(true);
  const saved = await readInstanceConfig(paths);
  expect(saved.identity.name).toBe('Agent Rocky');
  expect(saved.harnesses.opencode.env?.TOKEN).toBe('private-token');
  expect(saved.extension).toEqual({ password: 'hidden', keep: true });
  expect(
    (
      await call('rocky_config_update', {
        revision: before.revision,
        patch: { identity: { name: 'Lost update' } },
      })
    ).value().code,
  ).toBe('settings-changed');
  const revision = updated.value().revision;
  expect(
    (
      await call('rocky_config_update', {
        revision,
        patch: { server: { host: '0.0.0.0' } },
      })
    ).error,
  ).toBe(true);
  expect(
    (
      await call('rocky_config_update', {
        revision,
        patch: { retention: { keepTerminalRuns: 1 } },
      })
    ).error,
  ).toBe(true);
});

it('exposes and updates complete profile content with revisions and validation', async () => {
  const { call, paths } = await setup();
  const before = (
    await call('rocky_profile_get', { profileId: 'demo' })
  ).value();
  expect(before.values.settings.env.ACCOUNT).toBe('[redacted]');
  expect(before.values.settings.secretEnv).toEqual(['API_TOKEN']);
  expect(before.schema.properties).toHaveProperty('rules');
  expect(
    before.mcpSchema.properties.mcpServers.additionalProperties.anyOf,
  ).toHaveLength(2);
  const result = await call('rocky_profile_update', {
    profileId: 'demo',
    revision: before.revision,
    patch: {
      settings: { ...before.values.settings, testCommand: 'pnpm test' },
      rules: { review: 'Check changes carefully' },
      schemas: 'export const schema = {};',
      mcp: {
        mcpServers: {
          api: {
            url: 'https://mcp.example',
            headers: { Authorization: 'secret-bearer' },
          },
        },
      },
    },
  });
  expect(result.error).toBeUndefined();
  expect(result.text).not.toContain('secret-bearer');
  const saved = await readRepositoryProfile(paths, 'demo');
  expect(saved.settings.env.ACCOUNT).toBe('private-account');
  expect(saved.settings.testCommand).toBe('pnpm test');
  expect(saved.rules.review).toBe('Check changes carefully');
  expect(
    (
      await call('rocky_profile_update', {
        profileId: 'demo',
        revision: before.revision,
        patch: { rules: {} },
      })
    ).value().code,
  ).toBe('profile-changed');
  expect(
    (
      await call('rocky_profile_update', {
        profileId: 'demo',
        revision: result.value().revision,
        patch: { id: 'renamed' },
      })
    ).error,
  ).toBe(true);
  expect(
    (
      await call('rocky_profile_update', {
        profileId: 'demo',
        revision: result.value().revision,
        patch: { mcp: { mcpServers: { bad: { nonsense: true } } } },
      })
    ).error,
  ).toBe(true);
});

it('admits manual triggers through the daemon and rejects invalid paths and arguments', async () => {
  const { call, manual } = await setup();
  expect((await call('rocky_runs_list')).value().runs).toEqual([]);
  expect(
    (
      await call('rocky_trigger', {
        trigger: 'review',
        issue: 'ENG-1',
        profileId: 'demo',
      })
    ).value(),
  ).toEqual({ kind: 'started', runId: 'ENG-1-run' });
  expect(manual).toHaveBeenCalledWith({
    trigger: 'review',
    issue: 'ENG-1',
    profileId: 'demo',
  });
  expect(
    (await call('rocky_trigger', { trigger: '../escape', issue: 'ENG-1' }))
      .error,
  ).toBe(true);
  expect(manual).toHaveBeenCalledTimes(1);
  manual.mockResolvedValueOnce({
    kind: 'refused',
    reason: 'Issue already has a live run.',
    runId: 'ENG-1-run',
  });
  const refused = await call('rocky_trigger', {
    trigger: 'review',
    issue: 'ENG-1',
  });
  expect(refused.error).toBe(true);
  expect(refused.value()).toMatchObject({
    code: 'trigger-refused',
    runId: 'ENG-1-run',
  });

  expect((await call('rocky_run_get', { runId: 'missing' })).value().code).toBe(
    'unknown-run',
  );
});

it('enforces read-only mode at both discovery and dispatch', async () => {
  const { client, call, manual } = await setup(true);
  expect(
    (await client.listTools()).tools.every((t) => t.annotations?.readOnlyHint),
  ).toBe(true);
  expect(
    (await call('rocky_trigger', { trigger: 'review', issue: 'ENG-1' })).error,
  ).toBe(true);
  expect(manual).not.toHaveBeenCalled();
  expect((await call('rocky_config_get')).error).toBeUndefined();
});

it('preserves masked values by repository name when reordering and rejects prototype keys', () => {
  const saved = [
    { name: 'a', env: { TOKEN: 'first' } },
    { name: 'b', env: { TOKEN: 'second' } },
  ];
  const masked = configurationView(saved) as unknown[];
  expect(mergeConfiguration(saved, [{ name: 'a' }])).toEqual([{ name: 'a' }]);
  expect(mergeConfiguration({ a: 1, b: 2 }, { a: null })).toEqual({ b: 2 });
  expect(mergeConfiguration(saved, masked.reverse())).toEqual(
    [...saved].reverse(),
  );
  expect(() =>
    mergeConfiguration({}, JSON.parse('{"__proto__":{"polluted":true}}')),
  ).toThrow();
  expect(() => mergeConfiguration({}, { token: '[redacted]' })).toThrow();
});
