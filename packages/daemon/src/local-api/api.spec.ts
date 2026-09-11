import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RunDetail, SettingsView } from '@rocky/local-contracts';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';

import { rockyPaths } from '../config/paths.js';
import { readInstanceConfig, writeInstanceConfig } from '../config/store.js';
import {
  newRepositoryProfile,
  readRepositoryProfile,
  writeRepositoryProfile,
} from '../config/profiles.js';
import {
  newRunHeader,
  readRunHeader,
  updateRunHeader,
  writeRunHeader,
} from '../run/header.js';
import { appendEntry, openJournal, type JournalEntry } from '../run/journal.js';
import { runBoot } from '../run/replay.js';
import { RunScheduler } from '../run/scheduler.js';
import {
  LocalArtifacts,
  LocalProfiles,
  LocalSettings,
  MAX_TRANSCRIPT_BYTES,
  registerLocalApi,
  type LocalApiOptions,
} from './index.js';

const disposers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const dispose of disposers.reverse()) await dispose();
  disposers.length = 0;
  vi.unstubAllEnvs();
});

async function setup(overrides: Partial<LocalApiOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'rocky-local-api-'));
  disposers.push(() => rm(root, { force: true, recursive: true }));
  const paths = rockyPaths(root);
  const run = newRunHeader({
    runId: 'NG-609-1',
    repo: 'rocky',
    branch: 'issue',
    issue: {
      identifier: 'NG-609',
      title: 'Local product',
      description: 'private issue text',
      labels: [],
      url: 'https://linear.app/example/issue/NG-609',
    },
    now: '2026-09-07T12:00:00.000Z',
  });
  await writeRunHeader(paths, run);
  await writeInstanceConfig(paths, {
    unrelated: { token: 'DO-NOT-RETURN' },
    server: { internal: 'KEEP' },
    repos: [],
    concurrency: { unknown: 12 },
  });
  const artifacts = new LocalArtifacts(paths);
  const app = Fastify();
  disposers.push(() => app.close());
  const settings = new LocalSettings({
    paths,
    boundServer: { host: '127.0.0.1', port: 7625 },
  });
  const options: LocalApiOptions = {
    artifacts,
    settings,
    runs: {
      list: async () => [await readRunHeader(paths, run.runId)],
      get: async (id) =>
        id === run.runId ? readRunHeader(paths, id) : undefined,
      // A non-mutating file snapshot of real Journal writes; production's
      // runtime snapshot seam is intentionally separate from openJournal.
      journal: async (id) => {
        const text = await readFile(paths.run(id).journal, 'utf8').catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return '';
            throw error;
          },
        );
        return text
          .split('\n')
          .slice(0, -1)
          .map((line): JournalEntry => JSON.parse(line));
      },
    },
    ...overrides,
  };
  await registerLocalApi(app, options);
  return { app, options, paths, run, artifacts, settings };
}

async function listen(app: FastifyInstance) {
  return app.listen({ host: '127.0.0.1', port: 0 });
}

it('serves cached workflow diagrams and retries through the guarded profile API', async () => {
  const diagram = {
    sourceHash: 'hash',
    status: 'ready' as const,
    mermaid: 'flowchart TB\n A --> B',
  };
  const diagrams = {
    read: vi.fn(async () => diagram),
    retry: vi.fn(async () => ({
      sourceHash: 'hash',
      status: 'queued' as const,
    })),
  };
  const fixture = await setup({ diagrams });
  fixture.options.profiles = new LocalProfiles(fixture.paths);
  await writeRepositoryProfile(
    fixture.paths,
    newRepositoryProfile({
      id: 'test',
      remote: 'https://github.com/acme/test',
    }),
  );
  expect(
    (await fixture.app.inject('/api/profiles/test/diagram')).json(),
  ).toEqual(diagram);
  expect(diagrams.read).toHaveBeenCalledWith('test');
  expect(
    (
      await fixture.app.inject({
        method: 'POST',
        url: '/api/profiles/test/diagram/retry',
      })
    ).json(),
  ).toEqual({ sourceHash: 'hash', status: 'queued' });
  expect(diagrams.retry).toHaveBeenCalledWith('test');
  expect(
    (
      await fixture.app.inject({
        method: 'POST',
        url: '/api/profiles/test/diagram/retry',
        headers: { 'x-rocky-client-version': 'old' },
      })
    ).statusCode,
  ).toBe(409);
  expect(
    (await fixture.app.inject('/api/profiles/%2e%2e%2fsecret/diagram'))
      .statusCode,
  ).toBe(400);
  expect(
    (await fixture.app.inject('/api/profiles/absent/diagram')).statusCode,
  ).toBe(404);
  fixture.options.diagrams = undefined;
  expect(
    (await fixture.app.inject('/api/profiles/test/diagram')).statusCode,
  ).toBe(503);
});

it('configures a profile’s Linear label and optional team filter without exposing config editing generally', async () => {
  const fixture = await setup();
  fixture.options.profiles = new LocalProfiles(fixture.paths);
  await writeRepositoryProfile(
    fixture.paths,
    newRepositoryProfile({
      id: 'product',
      repos: [
        { name: 'web', url: 'https://github.com/acme/web', baseBranch: 'main' },
      ],
    }),
  );
  const initial = (
    await fixture.app.inject('/api/profiles/product/routing')
  ).json();
  expect(initial).toMatchObject({
    profileId: 'product',
    labels: ['product'],
    teams: [],
  });
  const saved = await fixture.app.inject({
    method: 'PUT',
    url: '/api/profiles/product/routing',
    payload: {
      labels: ['web-work', 'web-bug'],
      teams: ['Engineering'],
      revision: initial.revision,
    },
  });
  expect(saved.statusCode).toBe(200);
  expect(saved.json()).toMatchObject({
    profileId: 'product',
    labels: ['web-work', 'web-bug'],
    teams: ['Engineering'],
  });
  expect((await readInstanceConfig(fixture.paths)).repos).toEqual([
    expect.objectContaining({
      name: 'web',
      label: 'web-work',
      labels: ['web-bug'],
      profile: 'product',
      teams: ['Engineering'],
    }),
  ]);
  expect(
    (
      await fixture.app.inject({
        method: 'PUT',
        url: '/api/profiles/product/routing',
        payload: { labels: ['other'], teams: [], revision: initial.revision },
      })
    ).statusCode,
  ).toBe(409);
  expect(
    (
      await fixture.app.inject({
        method: 'PUT',
        url: '/api/profiles/product/routing',
        payload: { labels: [], teams: [], revision: saved.json().revision },
      })
    ).statusCode,
  ).toBe(400);
});

it('reflects real scheduler admission and park without maintaining a second API Run index', async () => {
  const fixture = await setup();
  const scheduler = await RunScheduler.open({
    paths: fixture.paths,
    boot: (run) =>
      runBoot({
        journalPath: fixture.paths.run(run.runId).journal,
        workflow: async (ctx) => {
          await ctx.step(
            'checkpoint',
            { label: 'Needs your Answer' },
            async () => ({ status: 'waiting' }),
          );
          return 'merged';
        },
      }),
  });
  disposers.push(() => scheduler.close());
  fixture.options.runs.get = (id) => scheduler.get(id);
  fixture.options.runs.list = async () => {
    const run = await scheduler.get(fixture.run.runId);
    return run ? [run] : [];
  };
  expect((await fixture.app.inject('/api/runs')).json().pollAfterMs).toBe(2000);
  await scheduler.drain();
  await expect
    .poll(async () => (await scheduler.get(fixture.run.runId))?.status)
    .toBe('parked');
  const list = (await fixture.app.inject('/api/runs')).json();
  expect(list).toMatchObject({
    pollAfterMs: 30000,
    runs: [{ status: 'parked', reason: 'checkpoint' }],
  });
  expect(JSON.stringify(list)).not.toContain('private issue text');
  const detail = (
    await fixture.app.inject('/api/runs/NG-609-1')
  ).json<RunDetail>();
  expect(detail.steps).toMatchObject([
    { key: '0', step: 'checkpoint', status: 'waiting' },
  ]);
  expect(detail.controls).toEqual({ answer: false, steer: false });
});

it('exposes explicit terminal-session recovery without making the API a Run registry', async () => {
  const fixture = await setup({
    recoverSession: async (runId) => ({
      runId,
      issueIdentifier: 'NG-609',
      sessionId: 'stale-session',
    }),
  });
  const response = await fixture.app.inject({
    method: 'POST',
    url: '/api/runs/NG-609-1/recover-session',
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({
    runId: 'NG-609-1',
    issueIdentifier: 'NG-609',
    sessionId: 'stale-session',
  });
});

it('exposes only the safe diagnostics for post-acknowledgement intake failures', async () => {
  const fixture = await setup({
    intakeFailures: async () => [
      {
        sessionId: 'session-1',
        action: 'created',
        occurredAt: '2026-09-10T12:00:00.000Z',
        reason:
          'Rocky acknowledged this Linear delivery but could not admit its Run.',
        remediation: 'Open Rocky locally and delegate the issue again.',
      },
    ],
  });

  const response = await fixture.app.inject('/api/intake-failures');
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual([
    {
      sessionId: 'session-1',
      action: 'created',
      occurredAt: '2026-09-10T12:00:00.000Z',
      reason:
        'Rocky acknowledged this Linear delivery but could not admit its Run.',
      remediation: 'Open Rocky locally and delegate the issue again.',
    },
  ]);
});

it('previews the configured default and creates its complete local pipeline for a new profile', async () => {
  const fixture = await setup();
  fixture.options.profiles = new LocalProfiles(fixture.paths);
  await writeInstanceConfig(fixture.paths, {
    workflowDefaults: { harness: 'opencode', model: 'openai/configured-model' },
  });
  const preview = await fixture.app.inject('/api/profile-defaults');
  expect(preview.statusCode).toBe(200);
  expect(preview.json()).toMatchObject({
    workflow: {
      source: expect.stringContaining('openai/configured-model'),
      triggers: ['linear.onDelegate', 'address-pr-conversations'],
    },
    grants: { harness: 'opencode' },
    prompts: expect.arrayContaining(['planner', 'implementer']),
  });
  expect(preview.json()).not.toHaveProperty('settings');
  expect((await fixture.app.inject('/api/profiles')).json()).toEqual({
    profiles: [],
  });
  const repos = [
    { name: 'web', url: 'git@github.com:acme/web.git', baseBranch: 'main' },
    { name: 'api', url: 'git@github.com:acme/api.git', baseBranch: 'develop' },
  ];
  const created = await fixture.app.inject({
    method: 'PUT',
    url: '/api/profiles',
    payload: { id: 'product', repos },
  });
  expect(created.statusCode).toBe(200);
  const stored = await readRepositoryProfile(fixture.paths, 'product');
  expect(stored.workflow).toEqual(preview.json().workflow);
  expect(stored.repos).toEqual(repos);
  expect(stored.prompts.planner).toBeTruthy();
  expect(stored.schemas).toContain('export');
  expect(Object.keys(stored.rules)).toEqual(preview.json().rules);
  expect(stored.settings.secretEnv).toContain('GITHUB_TOKEN');
  // Saving custom workflow text later must not reset it to the template.
  const updated = await fixture.app.inject({
    method: 'PUT',
    url: '/api/profiles',
    payload: {
      id: 'product',
      repos,
      revision: created.json().revision,
      workflow: { source: 'export default [];', triggers: [] },
    },
  });
  expect(updated.statusCode).toBe(200);
  expect(
    (await readRepositoryProfile(fixture.paths, 'product')).workflow.source,
  ).toBe('export default [];');
});

it('edits a secret-free local profile with optimistic concurrency', async () => {
  const fixture = await setup();
  fixture.options.profiles = new LocalProfiles(fixture.paths);
  const create = await fixture.app.inject({
    method: 'PUT',
    url: '/api/profiles',
    payload: {
      id: 'service',
      remote: 'git@github.com:acme/service.git',
      workflow: { source: 'export default [];', triggers: ['custom-workflow'] },
      grants: { harness: 'opencode', capabilities: ['read'], mcp: [] },
    },
  });
  expect(create.statusCode).toBe(200);
  const profile = create.json<{ revision: string; remote: string }>();
  expect(profile.remote).toBe('github.com/acme/service');
  expect(profile).not.toHaveProperty('settings');
  expect((await fixture.app.inject('/api/profiles')).json()).toMatchObject({
    profiles: [{ id: 'service', grants: { harness: 'opencode' } }],
  });
  const updated = await fixture.app.inject({
    method: 'PUT',
    url: '/api/profiles',
    payload: {
      id: 'service',
      remote: 'github.com/acme/service',
      revision: profile.revision,
      workflow: {
        source: 'export default [1];',
        triggers: ['custom-workflow'],
      },
      grants: { harness: 'opencode', capabilities: ['read'], mcp: [] },
    },
  });
  expect(updated.statusCode).toBe(200);
  const stale = await fixture.app.inject({
    method: 'PUT',
    url: '/api/profiles',
    payload: {
      id: 'service',
      remote: 'github.com/acme/service',
      revision: profile.revision,
      workflow: { source: 'export default [2];', triggers: [] },
      grants: { harness: 'opencode', capabilities: [], mcp: [] },
    },
  });
  expect(stale.statusCode).toBe(409);
  expect(stale.json()).toMatchObject({ code: 'profile-changed' });
});

it('edits complete multi-repository membership and rejects ambiguous or unsafe members', async () => {
  const fixture = await setup();
  fixture.options.profiles = new LocalProfiles(fixture.paths);
  const repos = [
    { name: 'web', url: 'git@github.com:acme/web.git', baseBranch: 'main' },
    {
      name: 'api',
      url: 'https://github.com/acme/api.git',
      baseBranch: 'develop',
    },
  ];
  const input = {
    id: 'product',
    repos,
    workflow: { source: 'export default [];', triggers: [] },
    grants: { harness: 'opencode', capabilities: [], mcp: [] },
  };
  const create = await fixture.app.inject({
    method: 'PUT',
    url: '/api/profiles',
    payload: input,
  });
  expect(create.statusCode).toBe(200);
  expect(create.json()).toMatchObject({ repos, remote: 'github.com/acme/web' });
  expect(
    (await fixture.app.inject('/api/profiles/product')).json(),
  ).toMatchObject({ repos });
  const revision = create.json<{ revision: string }>().revision;
  for (const invalid of [
    [],
    [repos[0], repos[0]],
    [{ ...repos[0], name: '../outside' }],
    [{ ...repos[0], url: 'invalid' }],
  ]) {
    const failed = await fixture.app.inject({
      method: 'PUT',
      url: '/api/profiles',
      payload: { ...input, repos: invalid, revision },
    });
    expect(failed.statusCode).toBe(400);
  }
  const updated = await fixture.app.inject({
    method: 'PUT',
    url: '/api/profiles',
    payload: { ...input, repos: [repos[1]], revision },
  });
  expect(updated.statusCode).toBe(200);
  expect(updated.json()).toMatchObject({
    repos: [repos[1]],
    remote: 'github.com/acme/api',
  });
  const stale = await fixture.app.inject({
    method: 'PUT',
    url: '/api/profiles',
    payload: { ...input, revision },
  });
  expect(stale.statusCode).toBe(409);
});

it('keeps a legacy profile’s configured folder, SSH remote and base branch when saving membership', async () => {
  const fixture = await setup();
  const profiles = new LocalProfiles(fixture.paths);
  const original = await profiles.save({
    id: 'pipeline',
    remote: 'github.com/acme/api',
    workflow: { source: 'export default [];', triggers: [] },
    grants: { harness: 'opencode', capabilities: [], mcp: [] },
  });
  const member = {
    name: 'backend',
    url: 'git@github.com:acme/api.git',
    baseBranch: 'develop',
  };
  await writeInstanceConfig(fixture.paths, {
    repos: [{ ...member, label: 'api', profile: 'pipeline' }],
  });
  const loaded = await profiles.read('pipeline');
  expect(loaded.repos).toEqual([member]);
  expect(loaded.revision).toBe(original.revision);
  await expect(
    profiles.save({
      id: loaded.id,
      repos: loaded.repos,
      revision: loaded.revision,
      workflow: loaded.workflow,
      grants: loaded.grants,
    }),
  ).resolves.toMatchObject({ repos: [member] });
});

it('passes an explicit local profile selection through manual admission', async () => {
  const fixture = await setup();
  const manual = vi.fn(async () => ({
    kind: 'started' as const,
    runId: 'NG-123-1',
  }));
  fixture.options.manual = manual;
  const input = { trigger: 'edit', issue: 'NG-123', profileId: 'product' };
  expect(
    (
      await fixture.app.inject({
        method: 'POST',
        url: '/api/triggers',
        payload: input,
      })
    ).statusCode,
  ).toBe(201);
  expect(manual).toHaveBeenCalledWith(input);
});

it('deletes only a current local profile revision', async () => {
  const fixture = await setup();
  fixture.options.profiles = new LocalProfiles(fixture.paths);
  const created = await fixture.app.inject({
    method: 'PUT',
    url: '/api/profiles',
    payload: {
      id: 'disposable',
      remote: 'github.com/acme/disposable',
      workflow: { source: 'export default [];', triggers: [] },
      grants: { harness: 'opencode', capabilities: [], mcp: [] },
    },
  });
  const profile = created.json<{ revision: string }>();
  const stale = await fixture.app.inject({
    method: 'DELETE',
    url: '/api/profiles',
    payload: { id: 'disposable', revision: 'stale' },
  });
  expect(stale.statusCode).toBe(409);
  expect(await fixture.app.inject('/api/profiles/disposable')).toMatchObject({
    statusCode: 200,
  });
  const deleted = await fixture.app.inject({
    method: 'DELETE',
    url: '/api/profiles',
    payload: { id: 'disposable', revision: profile.revision },
  });
  expect(deleted.statusCode).toBe(200);
  expect(deleted.json()).toEqual({ deleted: true });
  expect((await fixture.app.inject('/api/profiles')).json()).toEqual({
    profiles: [],
  });
});

async function editorFixture(script: string) {
  const fixture = await setup();
  fixture.options.profiles = new LocalProfiles(fixture.paths);
  const profile = await fixture.options.profiles.save({
    id: 'service',
    remote: 'github.com/acme/service',
    workflow: { source: 'export default [original];', triggers: [] },
    grants: { harness: 'opencode', capabilities: [], mcp: [] },
  });
  const bin = join(fixture.paths.root, 'bin');
  await mkdir(bin);
  for (const name of ['open', 'xdg-open'])
    await writeFile(join(bin, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  vi.stubEnv('PATH', bin);
  return { ...fixture, profile };
}

it('opens legacy JSON-only workflows as real text files without overwriting editor changes', async () => {
  const fixture = await editorFixture('for file; do :; done\n[ -f "$file" ]');
  const file = fixture.paths.profileWorkflow('service');
  await rm(file);
  const request = {
    method: 'POST' as const,
    url: '/api/profiles/service/open-workflow',
    payload: { editor: 'default' },
  };
  const opened = await fixture.app.inject(request);
  expect(opened.statusCode).toBe(200);
  expect(await readFile(file, 'utf8')).toBe(fixture.profile.workflow.source);
  await writeFile(file, 'export default [editedInEditor];');
  expect((await fixture.app.inject(request)).statusCode).toBe(200);
  expect(await readFile(file, 'utf8')).toBe('export default [editedInEditor];');
});

it('reports a launcher that starts successfully but rejects the editor request', async () => {
  const fixture = await editorFixture('exit 1');
  const result = await fixture.app.inject({
    method: 'POST',
    url: '/api/profiles/service/open-workflow',
    payload: { editor: 'vscode' },
  });
  expect(result.statusCode).toBe(503);
  expect(result.json()).toMatchObject({ code: 'editor-unavailable' });
});

it('reports a missing launcher and refuses unsupported editors before launching', async () => {
  const fixture = await editorFixture('exit 0');
  const request = {
    method: 'POST' as const,
    url: '/api/profiles/service/open-workflow',
  };
  for (const editor of ['arbitrary-command', 'opencode', 'claude-code']) {
    const invalid = await fixture.app.inject({
      ...request,
      payload: { editor },
    });
    expect(invalid.statusCode).toBe(400);
  }
  vi.stubEnv('PATH', join(fixture.paths.root, 'missing-bin'));
  const missing = await fixture.app.inject({
    ...request,
    payload: { editor: 'default' },
  });
  expect(missing.statusCode).toBe(503);
  expect(missing.json()).toMatchObject({ code: 'editor-unavailable' });
});

it('renders a real three-Boot Journal, nested identities, and native usage without invented zeroes', async () => {
  const { app, paths, run, options } = await setup();
  let pass = 0;
  for (let boot = 1; boot <= 3; boot++) {
    await runBoot({
      journalPath: paths.run(run.runId).journal,
      workflow: async (ctx) => {
        await ctx.step('agent', { label: 'planner' }, async () => ({
          status: 'done',
          result: {
            summary: 'Plan retained',
            steps: ['Build the local product'],
          },
        }));
        await ctx.parallel('$parallel', ['a', 'b'], {}, async (branch) =>
          branch.step('agent', { label: 'review' }, async () => ({
            status: 'done',
            result: { summary: 'Checked' },
          })),
        );
        await ctx.step('checkpoint', {}, async () =>
          ++pass < 3
            ? { status: 'waiting' }
            : { status: 'done', result: { decision: 'approve' } },
        );
        return 'merged';
      },
    });
  }
  await updateRunHeader(paths, run.runId, {
    boots: 3,
    status: 'finished',
    outcome: 'merged',
  });
  options.presentStep = async (_id, key) =>
    key === '0' ? { usage: { inputTokens: 0, usd: 0 } } : {};
  const response = await app.inject('/api/runs/NG-609-1');
  const detail = response.json<RunDetail>();
  expect(detail.steps.map((step) => step.key)).toContain('1/0/0');
  expect(detail.steps.find((step) => step.key === '1/1/0')).toMatchObject({
    parentKey: '1',
    completedBeforeCurrentBoot: true,
  });
  expect(detail.steps[0]).toMatchObject({
    boot: 1,
    result: { summary: 'Plan retained' },
  });
  expect(detail.usage).toMatchObject({
    reported: { inputTokens: 0, usd: 0 },
    missing: { inputTokens: 2, usd: 2, outputTokens: 3 },
  });
  expect(detail.usage.reported.outputTokens).toBeUndefined();
  expect(response.headers['x-rocky-version']).toBe('0.0.0');
  expect((await openJournal(paths.run(run.runId).journal)).nextBoot).toBe(4);
});

it('never repairs a partially appended Journal during a poll', async () => {
  const { app, paths, run } = await setup();
  const path = paths.run(run.runId).journal;
  await writeFile(path, '{"still-writing":');
  expect((await app.inject('/api/runs/NG-609-1')).statusCode).toBe(200);
  expect(await readFile(path, 'utf8')).toBe('{"still-writing":');
});

it.each([
  { headers: { host: 'attacker.example' } },
  { headers: { host: 'localhost', origin: 'https://attacker.example' } },
  { headers: { host: 'localhost', origin: 'null' } },
  { headers: { host: 'localhost', 'x-forwarded-host': 'localhost' } },
  { headers: { host: 'localhost', forwarded: 'for=127.0.0.1' } },
  { headers: { host: 'localhost', 'sec-fetch-site': 'cross-site' } },
  { headers: { host: 'localhost' }, remoteAddress: '198.51.100.10' },
])(
  'refuses external/proxied/cross-origin access including reads: %j',
  async (attack) => {
    const { app } = await setup();
    for (const url of [
      '/api/runs',
      '/api/settings',
      '/api/screenshots/unknown',
    ]) {
      const result = await app.inject({ url, ...attack });
      expect(result.statusCode).toBe(403);
      expect(result.headers['x-rocky-version']).toBe('0.0.0');
    }
  },
);

it('allows reads and same-origin edits through private Tailscale while retaining localhost and allowing revocation', async () => {
  let origin: string | undefined = 'https://rocky.tail123.ts.net:7625';
  const { app } = await setup({ tailscaleOrigin: () => origin });
  const headers = {
    host: 'rocky.tail123.ts.net:7625',
    origin,
    'sec-fetch-site': 'same-origin',
  };
  const initial = await app.inject({ url: '/api/settings', headers });
  expect(initial.statusCode).toBe(200);
  expect(
    (
      await app.inject({
        method: 'PATCH',
        url: '/api/settings',
        headers,
        payload: {
          revision: initial.json<SettingsView>().revision,
          patch: { concurrency: { maxRuns: 4 } },
        },
      })
    ).statusCode,
  ).toBe(200);
  expect((await app.inject('/api/runs')).statusCode).toBe(200);
  expect(
    (await app.inject({ url: '/api/runs', headers: { host: headers.host } }))
      .statusCode,
  ).toBe(200);
  origin = undefined;
  expect((await app.inject({ url: '/api/runs', headers })).statusCode).toBe(
    403,
  );
});

it.each([
  { headers: { host: 'other.tail123.ts.net:7625' } },
  { headers: { host: 'rocky.tail123.ts.net:443' } },
  {
    headers: {
      host: 'rocky.tail123.ts.net:7625',
      origin: 'http://rocky.tail123.ts.net:7625',
    },
  },
  {
    headers: {
      host: 'rocky.tail123.ts.net:7625',
      origin: 'https://attacker.example',
    },
  },
  {
    headers: {
      host: 'localhost:7625',
      origin: 'https://rocky.tail123.ts.net:7625',
    },
  },
  {
    headers: {
      host: 'rocky.tail123.ts.net:7625',
      'x-forwarded-for': '100.64.0.1',
    },
  },
  {
    headers: { host: 'rocky.tail123.ts.net:7625', forwarded: 'for=127.0.0.1' },
  },
  {
    headers: {
      host: 'rocky.tail123.ts.net:7625',
      'sec-fetch-site': 'cross-site',
    },
  },
  {
    headers: { host: 'rocky.tail123.ts.net:7625' },
    remoteAddress: '100.64.0.1',
  },
  {
    headers: { host: 'rocky.tail123.ts.net:7625' },
    remoteAddress: '198.51.100.1',
  },
])(
  'Tailscale access still refuses other hosts, origins, forwarders and non-loopback peers: %j',
  async (attack) => {
    const { app } = await setup({
      tailscaleOrigin: () => 'https://rocky.tail123.ts.net:7625',
    });
    for (const method of ['GET', 'PATCH'] as const) {
      expect(
        (await app.inject({ method, url: '/api/settings', ...attack }))
          .statusCode,
      ).toBe(403);
    }
  },
);

it('merges validated settings atomically, preserves unknown fields and detects concurrent/stale edits', async () => {
  const { app, paths, settings } = await setup();
  const initial = (await app.inject('/api/settings')).json<SettingsView>();
  expect(JSON.stringify(initial)).not.toMatch(/DO-NOT-RETURN|unknown|internal/);
  const request = (maxRuns: number) =>
    app.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: {
        revision: initial.revision,
        patch: { concurrency: { maxRuns } },
      },
    });
  const race = await Promise.all([request(5), request(8)]);
  expect(race.map((response) => response.statusCode).sort()).toEqual([
    200, 409,
  ]);
  const current = await settings.read();
  const updated = await app.inject({
    method: 'PATCH',
    url: '/api/settings',
    payload: {
      revision: current.revision,
      patch: { server: { port: 7630 }, retention: { keepTerminalRuns: 150 } },
    },
  });
  expect(updated.json()).toMatchObject({
    restartRequired: true,
    values: {
      server: { port: 7630 },
      concurrency: { maxRuns: current.values.concurrency.maxRuns },
    },
  });
  expect(await readInstanceConfig(paths)).toMatchObject({
    unrelated: { token: 'DO-NOT-RETURN' },
    server: { internal: 'KEEP' },
    concurrency: { unknown: 12 },
  });
  const reopened = new LocalSettings({
    paths,
    boundServer: { host: '127.0.0.1', port: 7630 },
    mcpStatus: async () => [
      {
        name: 'browser',
        status: 'login-required',
        loginCommand: 'rocky mcp login browser',
      },
    ],
  });
  expect(await reopened.read()).toMatchObject({
    restartRequired: false,
    mcp: [{ loginCommand: 'rocky mcp login browser' }],
  });
  for (const patch of [
    { server: { host: '0.0.0.0' } },
    { concurrency: { maxRuns: 0 } },
    { retention: { keepTerminalRuns: 1 } },
    { secrets: 'bad' },
  ]) {
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: '/api/settings',
          payload: { revision: (await settings.read()).revision, patch },
        })
      ).statusCode,
    ).toBe(400);
  }
});

it('routes precise Answer and idempotent Steer payloads unchanged; missing integrations cannot report success', async () => {
  const { app, options } = await setup();
  const body = {
    stepKey: '1/0/2',
    generation: 'current-generation',
    answer: { decision: 'approve' },
  };
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/runs/NG-609-1/answer',
        payload: body,
      })
    ).statusCode,
  ).toBe(503);
  const inputs: unknown[] = [];
  options.answer = async (_id, input) => {
    inputs.push(input);
    return {
      kind: 'already-answered',
      answer: { decision: 'reject', reason: 'Answered in Linear' },
    };
  };
  const answer = await app.inject({
    method: 'POST',
    url: '/api/runs/NG-609-1/answer',
    payload: body,
  });
  expect(inputs).toEqual([body]);
  expect(answer.statusCode).toBe(409);
  expect(answer.json().answer.reason).toBe('Answered in Linear');
  const steer = {
    requestId: '871f9907-a68b-4eb3-b91c-53159f278f8b',
    message: '  Human words\nverbatim  ',
  };
  const receipt = {
    ...steer,
    receivedAt: '2026-09-07',
    state: 'held' as const,
  };
  options.steer = async () => receipt;
  options.steers = async () => [receipt];
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/runs/NG-609-1/steer',
        payload: steer,
      })
    ).json(),
  ).toMatchObject({ ...steer, state: 'held' });
  expect(
    (await app.inject('/api/runs/NG-609-1')).json<RunDetail>().steers,
  ).toEqual([receipt]);
  options.manual = async () => ({
    kind: 'refused',
    reason: 'NG-609-1 is still live',
    runId: 'NG-609-1',
  });
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/triggers',
        payload: { trigger: 'address-pr-conversations', issue: 'NG-609' },
      })
    ).json(),
  ).toMatchObject({ code: 'trigger-refused', runId: 'NG-609-1' });
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/runs/NG-609-1/answer',
        headers: { 'x-rocky-client-version': 'old' },
        payload: body,
      })
    ).json().code,
  ).toBe('version-mismatch');
  expect((await app.inject('/api/runs/%2e%2e%2fsecret')).statusCode).toBe(400);
  expect((await app.inject('/api/runs/absent')).statusCode).toBe(404);
});

it('streams durable bytes incrementally, resumes from event offsets and closes when the real Step settles', async () => {
  const { app, paths, artifacts, run } = await setup();
  await updateRunHeader(paths, run.runId, { status: 'running', boots: 1 });
  const entry: JournalEntry = {
    v: 1,
    seq: 0,
    step: 'agent',
    boot: 1,
    status: 'running',
    startedAt: '2026-09-07',
  };
  await appendEntry(paths.run(run.runId).journal, entry);
  await mkdir(paths.run(run.runId).sessionsDir, { recursive: true });
  const path = join(paths.run(run.runId).sessionsDir, 'native.jsonl');
  await writeFile(path, 'first\n');
  await artifacts.registerTranscript(run.runId, '0', 'native.jsonl');
  const url = await listen(app);
  const abort = new AbortController();
  const response = await fetch(
    `${url}/api/runs/${run.runId}/steps/0/transcript`,
    { signal: abort.signal },
  );
  expect(response.headers.get('x-rocky-version')).toBe('0.0.0');
  if (!response.body) throw new Error('Expected a Transcript response body');
  const reader = response.body.getReader();
  let text = '';
  while (!text.includes('id: 6'))
    text += new TextDecoder().decode((await reader.read()).value);
  expect(text).toContain('first\\n');
  await appendFile(path, 'second\n');
  while (!text.includes('id: 13'))
    text += new TextDecoder().decode((await reader.read()).value);
  expect(text).toContain('second\\n');
  abort.abort();
  await reader.cancel().catch(() => undefined);
  await appendEntry(paths.run(run.runId).journal, {
    ...entry,
    status: 'done',
    result: { summary: 'Complete' },
  });
  const resumed = await fetch(
    `${url}/api/runs/${run.runId}/steps/0/transcript`,
    { headers: { 'Last-Event-ID': '6' } },
  );
  const resumedText = await resumed.text();
  expect(resumedText).not.toContain('first');
  expect(resumedText).toContain('second');
  expect(resumedText).toContain('event: settled');
  expect(
    (await fetch(`${url}/api/runs/${run.runId}/steps/0/transcript?offset=999`))
      .status,
  ).toBe(409);
});

it('serves identical screenshot bytes to the HTTP and Linear upload reader and distinguishes pruning', async () => {
  const { app, paths, artifacts, run } = await setup();
  await mkdir(paths.run(run.runId).screenshotsDir, { recursive: true });
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
  await writeFile(
    join(paths.run(run.runId).screenshotsDir, 'evidence.png'),
    bytes,
  );
  const shot = await artifacts.registerScreenshot(
    run.runId,
    'evidence.png',
    'Local evidence',
  );
  const response = await app.inject(`/api/screenshots/${shot.id}`);
  expect(response.statusCode).toBe(200);
  expect(response.rawPayload).toEqual(
    (await artifacts.readScreenshot(shot.id)).bytes,
  );
  expect(response.headers['content-type']).toBe('image/png');
  expect(response.headers['x-content-type-options']).toBe('nosniff');
  await rm(paths.run(run.runId).screenshotsDir, { recursive: true });
  expect((await app.inject(`/api/screenshots/${shot.id}`)).statusCode).toBe(
    410,
  );
  expect(
    (await app.inject('/api/screenshots/s_00000000000000000000000000000000'))
      .statusCode,
  ).toBe(404);
  expect(
    (await app.inject('/api/screenshots/%2e%2e%2fcredentials.json')).statusCode,
  ).toBe(400);
});

it('refuses over-limit Transcript artifacts before opening an SSE reader', async () => {
  const { app, paths, artifacts, run } = await setup();
  await updateRunHeader(paths, run.runId, { status: 'running' });
  await appendEntry(paths.run(run.runId).journal, {
    v: 1,
    seq: 0,
    step: 'agent',
    boot: 1,
    startedAt: '2026-09-07',
    status: 'running',
  });
  await mkdir(paths.run(run.runId).sessionsDir, { recursive: true });
  const path = join(paths.run(run.runId).sessionsDir, 'over-limit.jsonl');
  await writeFile(path, '');
  await truncate(path, MAX_TRANSCRIPT_BYTES + 1);
  await artifacts.registerTranscript(run.runId, '0', 'over-limit.jsonl');

  const response = await app.inject(
    `/api/runs/${run.runId}/steps/0/transcript`,
  );
  expect(response.statusCode).toBe(413);
  expect(response.json()).toMatchObject({ code: 'transcript_too_large' });
});

it('reopens durable UTF-8 Transcripts without losing a character at the chunk boundary', async () => {
  const { app, paths, artifacts, run, options } = await setup();
  await appendEntry(paths.run(run.runId).journal, {
    v: 1,
    seq: 0,
    step: 'agent',
    boot: 1,
    startedAt: '2026-09-07',
    status: 'done',
    result: { summary: 'Finished' },
  });
  await mkdir(paths.run(run.runId).sessionsDir, { recursive: true });
  const text = `${'x'.repeat(16383)}${String.fromCodePoint(0x1f99d)}\nend\n`;
  await writeFile(join(paths.run(run.runId).sessionsDir, 'native'), text);
  await artifacts.registerTranscript(run.runId, '0', 'native');
  const address = await listen(app);
  const response = await fetch(
    `${address}/api/runs/${run.runId}/steps/0/transcript`,
  );
  const events = (await response.text())
    .split('\n')
    .filter((line) => line.startsWith('data: {"text"'))
    .map((line) => JSON.parse(line.slice(6)));
  expect(events.map((event) => event.text).join('')).toBe(text);
  await app.close();
  const next = Fastify();
  disposers.push(() => next.close());
  await registerLocalApi(next, {
    ...options,
    artifacts: new LocalArtifacts(paths),
  });
  const reopened = await listen(next);
  const resumed = await fetch(
    `${reopened}/api/runs/${run.runId}/steps/0/transcript`,
    { headers: { 'last-event-id': String(events[0].offset) } },
  );
  const replay = await resumed.text();
  expect(replay).toContain(String.fromCodePoint(0x1f99d));
  expect(replay).not.toContain('x'.repeat(10));
  expect(replay).toContain('event: settled');
});

it('closes idle live SSE readers before Fastify shutdown waits on their sockets', async () => {
  const { app, paths, artifacts, run } = await setup();
  await updateRunHeader(paths, run.runId, { status: 'running' });
  await appendEntry(paths.run(run.runId).journal, {
    v: 1,
    seq: 0,
    step: 'agent',
    boot: 1,
    startedAt: '2026-09-07',
    status: 'running',
  });
  await mkdir(paths.run(run.runId).sessionsDir, { recursive: true });
  await writeFile(join(paths.run(run.runId).sessionsDir, 'idle'), '');
  await artifacts.registerTranscript(run.runId, '0', 'idle');
  const address = await listen(app);
  const response = await fetch(
    `${address}/api/runs/${run.runId}/steps/0/transcript`,
  );
  const body = response.text().catch(() => 'closed');
  await app.close();
  await body;
});

it('exposes a terminal failure even when every visible Step completed', async () => {
  const { app, paths, run } = await setup();
  await updateRunHeader(paths, run.runId, {
    status: 'failed',
    error: {
      name: 'Error',
      message: 'ctx.checkpoint requires an adapter',
      stack: 'private stack',
    },
  });
  const response = await app.inject(`/api/runs/${run.runId}`);
  expect(response.json().run.error).toEqual({
    name: 'Error',
    message: 'ctx.checkpoint requires an adapter',
  });
});

it('serves immutable visual reports from run summaries and refuses unknown report IDs', async () => {
  const { app, run, artifacts } = await setup();
  const report = {
    id: `r_${'a'.repeat(32)}`,
    runId: run.runId,
    createdAt: '2026-09-10T10:00:00Z',
    title: 'Processing changes',
    summary: 'Clarification comes before editing.',
    pr: {
      repo: run.repo,
      number: 42,
      url: 'https://github.com/example/app/pull/42',
      headSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
    },
    problems: [{ problem: 'Ambiguous tickets', solution: 'Ask first.' }],
    diagrams: [
      {
        title: 'Flow',
        description: 'A question loop',
        mermaid: 'flowchart LR\n Ticket --> Questions --> Work',
      },
    ],
    verification: ['Question loop tested'],
    limitations: [],
    visuallyReviewable: false,
    visuals: [],
  };
  await artifacts.saveReport(run.runId, report);
  const detail = (await app.inject(`/api/runs/${run.runId}`)).json();
  expect(detail.reports).toEqual([
    {
      id: report.id,
      title: report.title,
      createdAt: report.createdAt,
      pr: report.pr,
    },
  ]);
  const response = await app.inject(
    `/api/runs/${run.runId}/reports/${report.id}`,
  );
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual(report);
  expect(
    (await app.inject(`/api/runs/${run.runId}/reports/r_${'b'.repeat(32)}`))
      .statusCode,
  ).toBe(404);
  expect(
    (await app.inject(`/api/runs/${run.runId}/reports/invalid`)).statusCode,
  ).toBe(400);
  await expect(
    artifacts.saveReport(run.runId, { ...report, summary: 'Changed' }),
  ).rejects.toThrow('cannot be overwritten');
});

it('exposes live agent settings, execution timing, profile and the PR from durable steps', async () => {
  const { app, paths, run, artifacts } = await setup();
  const profile = newRepositoryProfile({
    id: 'product',
    remote: 'https://github.com/example/app.git',
  });
  run.profile = profile;
  run.execution = {
    source: 'repository',
    sourceCommit: 'frozen',
    trigger: { kind: 'linear.onDelegate' },
    members: [
      {
        name: 'rocky',
        path: 'rocky',
        lead: true,
        url: profile.remote,
        baseBranch: 'main',
      },
    ],
  };
  run.status = 'running';
  await writeRunHeader(paths, run);
  const configuration = {
    harness: 'opencode',
    model: 'vendor/model',
    variant: 'high',
    tools: ['read'],
    mcp: [],
    timeoutMs: 60000,
  };
  const entry: JournalEntry = {
    v: 1,
    seq: 0,
    step: 'agent',
    status: 'running',
    boot: 1,
    startedAt: '2026-09-10T10:00:00Z',
    progress: {
      configuration,
      live: {
        output: 'Inspecting the ticket',
        summary: 'Reading requirements',
      },
      usage: { inputTokens: 42 },
    },
  };
  await appendEntry(paths.run(run.runId).journal, entry);
  let detail = (await app.inject(`/api/runs/${run.runId}`)).json<RunDetail>();
  expect(detail.run).toMatchObject({ profileId: 'product', repos: ['rocky'] });
  expect(detail.steps[0]).toMatchObject({
    agent: configuration,
    startedAt: entry.startedAt,
    liveOutput: 'Inspecting the ticket',
    liveSummary: 'Reading requirements',
    transcript: 'pending',
    usage: { inputTokens: 42 },
  });
  await mkdir(paths.run(run.runId).sessionsDir, { recursive: true });
  await writeFile(
    join(paths.run(run.runId).sessionsDir, '0.jsonl'),
    'native transcript',
  );
  await artifacts.registerTranscript(run.runId, '0', '0.jsonl');
  await appendEntry(paths.run(run.runId).journal, {
    ...entry,
    status: 'failed',
    ms: 2400,
    error: {
      name: 'Error',
      message: 'The harness failed',
      stack: 'private stack',
    },
  });
  const pr = {
    number: 42,
    url: 'https://github.com/example/app/pull/42',
    headSha: 'a'.repeat(40),
  };
  await appendEntry(paths.run(run.runId).journal, {
    ...entry,
    seq: 1,
    step: 'scm.openPr',
    status: 'done',
    ms: 200,
    result: pr,
  });
  detail = (await app.inject(`/api/runs/${run.runId}`)).json<RunDetail>();
  expect(detail.run.pr).toEqual(pr);
  expect(detail.steps[0]).toMatchObject({
    ms: 2400,
    transcript: 'available',
    error: { name: 'Error', message: 'The harness failed' },
  });
  expect(detail.steps[0].error).not.toHaveProperty('stack');
  await updateRunHeader(paths, run.runId, { artifactsPruned: true });
  expect(
    (await app.inject(`/api/runs/${run.runId}`)).json<RunDetail>().steps[0]
      .transcript,
  ).toBe('pruned');
});
