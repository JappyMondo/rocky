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
import { afterEach, expect, it } from 'vitest';

import { rockyPaths } from '../config/paths.js';
import { readInstanceConfig, writeInstanceConfig } from '../config/store.js';
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
