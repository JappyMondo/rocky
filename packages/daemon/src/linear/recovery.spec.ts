import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Writable } from 'node:stream';
import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { rockyPaths } from '../config/paths.js';
import { createDaemon } from '../server.js';
import { openJournal } from '../run/journal.js';
import { runBoot } from '../run/replay.js';
import { RunScheduler, type SchedulerBoot } from '../run/scheduler.js';
import { RockyLinearClient } from './client.js';
import { LinearRunControl, type LinearControlStore } from './control.js';

interface FixtureGraphqlVariables {
  filter?: { id?: { eq?: string } };
  after?: string;
  input?: {
    id?: string;
    agentSessionId?: string;
    content?: Record<string, unknown>;
    ephemeral?: boolean;
    signal?: string;
    signalMetadata?: Record<string, unknown>;
  };
}

/** Test-only durable boundary; production binds control records into the Journal. */
function testControlStore(path: string): LinearControlStore {
  const read = async (): Promise<Record<string, unknown>> => {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as Record<
        string,
        unknown
      >;
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      )
        return {};
      throw error;
    }
  };
  return {
    async get(key) {
      return structuredClone((await read())[key]);
    },
    async put(key, value) {
      const values = await read();
      values[key] = structuredClone(value);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(values));
    },
  };
}

it('recovers a dead-endpoint Checkpoint by the five-minute poll, queues under a saturated cap, and survives restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rocky-linear-recovery-'));
  const paths = rockyPaths(dir);
  let clock = Date.parse('2026-09-07T10:00:00Z');
  const at = () => new Date(clock).toISOString();
  const remote = Fastify();
  const rows: {
    id: string;
    createdAt: string;
    agentSession: { id: string };
    content: Record<string, unknown>;
    ephemeral: boolean;
    signal?: string;
    signalMetadata?: string;
  }[] = [];
  const pages: unknown[] = [];
  remote.post<{ Body: { query: string; variables: FixtureGraphqlVariables } }>(
    '/graphql',
    async (request) => {
      expect(request.headers.authorization).toBe('Bearer test-owned-app-token');
      const { query, variables: v } = request.body;
      if (query.includes('agentActivityCreate(')) {
        const input = v.input;
        if (!input?.id || !input.agentSessionId || !input.content)
          throw new Error('Fixture agent activity input is incomplete');
        if (!rows.some((row) => row.id === input.id))
          rows.push({
            id: input.id,
            createdAt: at(),
            agentSession: { id: input.agentSessionId },
            content: input.content,
            ephemeral: input.ephemeral ?? false,
            signal: input.signal,
            ...(input.signalMetadata
              ? { signalMetadata: JSON.stringify(input.signalMetadata) }
              : {}),
          });
        return { data: { agentActivityCreate: { success: true } } };
      }
      if (query.includes('agentActivities(')) {
        const id = v.filter?.id?.eq;
        const matching = id ? rows.filter((row) => row.id === id) : rows;
        const start = Number(v.after ?? 0);
        const nodes = matching.slice(start, start + 1);
        const next = start + nodes.length;
        pages.push(v.after);
        return {
          data: {
            agentActivities: {
              nodes,
              pageInfo: {
                hasNextPage: next < matching.length,
                hasPreviousPage: start > 0,
                endCursor: String(next),
                startCursor: String(start),
              },
            },
          },
        };
      }
      if (query.includes('agentSession('))
        return {
          data: {
            agentSession: {
              id: 'session',
              externalLinks: [],
              issue: { id: 'issue' },
              appUser: { id: 'app' },
              dismissedAt: null,
              status: 'stale',
            },
          },
        };
      if (query.includes('issue('))
        return {
          data: {
            issue: {
              id: 'issue',
              reactions: [],
              sharedAccess: { sharedWithUsers: [] },
              delegate: { id: 'app' },
            },
          },
        };
      throw new Error(`Unexpected fixture GraphQL request: ${query}`);
    },
  );
  await remote.listen({ host: '127.0.0.1', port: 0 });
  const address = remote.server.address();
  if (!address || typeof address === 'string')
    throw new Error('fixture address missing');
  const client = new RockyLinearClient({
    auth: async () => ({ accessToken: 'test-owned-app-token' }),
    save: async () => undefined,
    fetch: (url, init) => {
      if (String(url) !== 'https://api.linear.app/graphql')
        throw new Error('fixture refuses non-GraphQL network');
      return fetch(`http://127.0.0.1:${address.port}/graphql`, init);
    },
  });
  let pings = 0;
  const logs: string[] = [];
  const local = await createDaemon({
    webRoot: false,
    selfPing: false,
    publicUrl: () => 'https://dead-endpoint.example.test',
    fetch: async () => {
      pings++;
      return new Response(null, { status: 503 });
    },
    logger: {
      level: 'warn',
      stream: new Writable({
        write(chunk, _encoding, done) {
          logs.push(String(chunk));
          done();
        },
      }),
    },
  });
  await local.endpoint.check();
  const assertOutagePersists = async () => {
    const response = await local.app.inject({
      method: 'GET',
      url: '/api/health',
    });
    expect(response.json().endpoint).toMatchObject({
      configured: true,
      ok: false,
      detail: 'answered 503',
    });
  };
  const input = (identifier: string) => ({
    repo: 'fixture',
    branch: identifier.toLowerCase(),
    issue: {
      identifier,
      title: 'Test only',
      description: '',
      url: '',
      labels: [],
    },
  });
  const controls = new Map<string, LinearRunControl>();
  const entered: string[] = [];
  const release = new Map<string, () => void>();
  const controlFor = async (id: string) => {
    let control = controls.get(id);
    if (!control) {
      const store = testControlStore(
        join(paths.run(id).dir, 'test-control-store.json'),
      );
      control = new LinearRunControl({
        runId: id,
        issueId: 'issue',
        appUserId: 'app',
        sessionId: 'session',
        client,
        store,
        runUrl: `http://localhost:7625/runs/${id}`,
        now: () => clock,
        beforeElicitation: async () => undefined,
        ended: async () =>
          Boolean((await openJournal(paths.run(id).journal)).end),
      });
      controls.set(id, control);
    }
    return control;
  };
  const boot: SchedulerBoot = async (run, kind, signal) => {
    const control =
      run.issue.identifier === 'FIXTURE-1'
        ? await controlFor(run.runId)
        : undefined;
    await control?.reconcile();
    return runBoot({
      journalPath: paths.run(run.runId).journal,
      poll: kind === 'poll',
      signal,
      now: () => clock,
      workflow: async (steps) => {
        if (control)
          await steps.step('checkpoint', {}, () =>
            control.checkpoint('0', {
              title: 'Approve?',
              body: 'A test-owned gate.',
              digest: { ci: 'passed', diffStat: '1 file', unresolved: 0 },
            }),
          );
        await steps.step('work', {}, async () => {
          entered.push(run.runId);
          await new Promise<void>((resolve) => {
            release.set(run.runId, resolve);
            signal.addEventListener('abort', () => resolve(), { once: true });
          });
          return { status: 'done', result: null };
        });
        return 'merged';
      },
    });
  };
  let scheduler = await RunScheduler.open({
    paths,
    maxRuns: 1,
    boot,
    now: () => new Date(clock),
  });
  try {
    await scheduler.delegate(input('FIXTURE-1'));
    await scheduler.drain();
    await expect
      .poll(async () => (await scheduler.get('FIXTURE-1-1'))?.status)
      .toBe('parked');
    const checkpoint = await (await controlFor('FIXTURE-1-1')).waiting();
    if (!checkpoint) throw new Error('Expected the fixture Checkpoint');
    await assertOutagePersists();
    await scheduler.close();
    controls.clear();
    clock += 3 * 24 * 60 * 60 * 1000;
    rows.push({
      id: 'offline-answer',
      createdAt: at(),
      agentSession: { id: 'session' },
      content: { type: 'prompt', body: checkpoint.approveValue },
      ephemeral: false,
    });
    scheduler = await RunScheduler.open({
      paths,
      maxRuns: 1,
      boot,
      now: () => new Date(clock),
    });
    await scheduler.delegate(input('FIXTURE-2'));
    await scheduler.drain();
    await expect.poll(() => entered).toEqual(['FIXTURE-2-1']);
    clock += 300_000;
    await scheduler.tick();
    expect((await scheduler.get('FIXTURE-1-1'))?.status).toBe('queued');
    expect(entered).toEqual(['FIXTURE-2-1']);
    expect(
      (await openJournal(paths.run('FIXTURE-1-1').journal)).latest(0)?.result,
    ).toEqual({ decision: 'approve' });
    expect(pages.some((cursor) => cursor === '1')).toBe(true);
    expect(
      rows.filter((row) => row.content.type === 'elicitation'),
    ).toHaveLength(1);
    await assertOutagePersists();
    // Crash after the Answer is durable but before the queued continuation.
    await scheduler.close();
    controls.clear();
    entered.length = 0;
    scheduler = await RunScheduler.open({
      paths,
      maxRuns: 1,
      boot,
      now: () => new Date(clock),
    });
    await scheduler.drain();
    await expect.poll(() => entered.length).toBe(1);
    const first = entered[0];
    if (!first) throw new Error('Expected a resumed fixture Run');
    release.get(first)?.();
    if (first !== 'FIXTURE-1-1')
      await expect.poll(() => entered).toContain('FIXTURE-1-1');
    release.get('FIXTURE-1-1')?.();
    await expect
      .poll(async () => (await scheduler.get('FIXTURE-1-1'))?.status)
      .toBe('finished');
    expect(entered.filter((id) => id === 'FIXTURE-1-1')).toHaveLength(1);
    expect(
      rows.filter((row) => row.content.type === 'elicitation'),
    ).toHaveLength(1);
    await assertOutagePersists();
    expect(pings).toBe(1);
    expect(logs.join('\n')).toContain('Linear cannot reach Rocky');
  } finally {
    for (const done of release.values()) done();
    await scheduler.close();
    await local.app.close();
    await remote.close();
    await rm(dir, { recursive: true, force: true });
  }
});
