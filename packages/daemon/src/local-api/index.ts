import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

import type {
  Answer,
  Checkpoint,
  RunDetail,
  RunList,
  RunSummary,
  Screenshot,
  SteerReceipt,
  StepView,
  Usage,
  UsageTotal,
} from '@rocky/local-contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { RunHeader } from '../run/header.js';
import type { JournalEntry } from '../run/journal.js';
import {
  CLIENT_VERSION_HEADER,
  DAEMON_VERSION,
  VERSION_HEADER,
} from '../version.js';
import {
  ArtifactError,
  LocalArtifacts,
  MAX_TRANSCRIPT_BYTES,
} from './artifacts.js';
import { LocalApiError, LocalSettings } from './settings.js';

export {
  LocalArtifacts,
  ArtifactError,
  MAX_TRANSCRIPT_BYTES,
  parseUnifiedDiff,
} from './artifacts.js';
export { LocalSettings, LocalApiError } from './settings.js';

export interface LocalApiOptions {
  /** The runtime's in-memory index, never a second API-owned Run registry. */
  runs: {
    list(): Promise<RunHeader[]>;
    get(runId: string): Promise<RunHeader | undefined>;
    /** Non-mutating snapshot. NEVER use repairing openJournal on a live writer. */
    journal(runId: string): Promise<readonly JournalEntry[]>;
  };
  artifacts: LocalArtifacts;
  settings: LocalSettings;
  currentCheckpoint?: (runId: string) => Promise<Checkpoint | undefined>;
  answer?: (
    runId: string,
    input: { stepKey: string; generation: string; answer: Answer },
  ) => Promise<
    | { kind: 'accepted'; answer: Answer }
    | { kind: 'already-answered'; answer: Answer }
  >;
  steer?: (
    runId: string,
    input: { requestId: string; message: string },
  ) => Promise<SteerReceipt>;
  steers?: (runId: string) => Promise<SteerReceipt[]>;
  manual?: (input: {
    trigger: string;
    issue: string;
  }) => Promise<
    | { kind: 'started'; runId: string }
    | { kind: 'refused'; reason: string; runId?: string }
  >;
  /** Content/execution presentation metadata, not guessed from arbitrary results. */
  presentStep?: (
    runId: string,
    key: string,
    entry: JournalEntry,
  ) => Promise<{ usage?: Usage; screenshots?: Screenshot[] }>;
}

const segment = z.string().regex(/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,199}$/);
const stepKey = z.string().regex(/^\d+(?:\/\d+\/\d+)*$/);
const TRANSCRIPT_CHUNK_BYTES = 16 * 1024;
const SSE_HEARTBEAT_MS = 10_000;
const SSE_STALLED_SOCKET_MS = 15_000;
const answerSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('approve') }).strict(),
  z
    .object({
      decision: z.literal('reject'),
      reason: z.string().max(32000).optional(),
    })
    .strict(),
  z
    .object({
      decision: z.literal('steer'),
      message: z
        .string()
        .min(1)
        .max(32000)
        .refine((s) => s.trim().length > 0),
    })
    .strict(),
]);

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new LocalApiError(
      400,
      'invalid-request',
      'Invalid request. Check the named Run, Step and payload.',
    );
  return result.data;
}

/** Latest entry per sequence, including full nested branch identity. */
export function journalSteps(
  entries: readonly JournalEntry[],
  prefix = '',
): Array<{ key: string; parentKey?: string; entry: JournalEntry }> {
  const latest = new Map<number, JournalEntry>();
  for (const entry of entries) latest.set(entry.seq, entry);
  return [...latest.values()]
    .sort((a, b) => a.seq - b.seq)
    .flatMap((entry) => {
      const key = `${prefix}${entry.seq}`;
      const parentKey = prefix
        ? prefix.split('/').slice(0, -2).join('/')
        : undefined;
      return [
        { key, parentKey, entry },
        ...(entry.parallel?.branches.flatMap((branch, index) =>
          journalSteps(branch, `${key}/${index}/`),
        ) ?? []),
      ];
    });
}

function summary(run: RunHeader): RunSummary {
  const {
    runId,
    repo,
    branch,
    trigger,
    status,
    outcome,
    reason,
    boots,
    createdAt,
    endedAt,
    artifactsPruned,
    pr,
  } = run;
  return {
    runId,
    repo,
    branch,
    trigger,
    status,
    outcome,
    reason,
    boots,
    createdAt,
    endedAt,
    artifactsPruned,
    pr,
    issue: {
      identifier: run.issue.identifier,
      title: run.issue.title,
      url: run.issue.url,
    },
  };
}

const components = [
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheCreationTokens',
  'usd',
] as const;
export function sumUsage(steps: StepView[]): UsageTotal {
  const total: UsageTotal = {
    reported: {},
    missing: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      usd: 0,
    },
  };
  for (const step of steps.filter((step) => step.step === 'agent')) {
    for (const key of components) {
      const value = step.usage?.[key];
      if (value === undefined) total.missing[key]++;
      else total.reported[key] = (total.reported[key] ?? 0) + value;
    }
  }
  return total;
}

function loopback(host: string): boolean {
  return (
    host === 'localhost' ||
    host === '::1' ||
    host === '[::1]' ||
    /^127(?:\.\d{1,3}){3}$/.test(host) ||
    /^::ffff:127(?:\.\d{1,3}){3}$/.test(host)
  );
}

/** Register only on the private listener, never on NG-651's public ingress. */
export async function registerLocalApi(
  app: FastifyInstance,
  options: LocalApiOptions,
): Promise<void> {
  await app.register(async (local) => {
    const streams = new Set<AbortController>();
    local.addHook('preClose', async () => {
      for (const stream of streams) stream.abort();
    });
    local.addHook('onRequest', async (request, reply) => {
      reply
        .header(VERSION_HEADER, DAEMON_VERSION)
        .header('cache-control', 'no-store')
        .header('x-content-type-options', 'nosniff');
      const host = request.headers.host ?? '';
      let url: URL;
      try {
        url = new URL(`http://${host}`);
      } catch {
        return reply
          .code(403)
          .send({ code: 'local-only', error: 'This API is machine-local.' });
      }
      if (
        !loopback(request.raw.socket.remoteAddress ?? '') ||
        !loopback(url.hostname) ||
        request.headers.forwarded !== undefined ||
        Object.keys(request.headers).some((key) =>
          key.startsWith('x-forwarded-'),
        ) ||
        request.headers['sec-fetch-site'] === 'cross-site' ||
        (request.headers.origin !== undefined &&
          request.headers.origin !== url.origin)
      ) {
        return reply.code(403).send({
          code: 'local-only',
          error:
            'This API is machine-local; cross-origin and proxied requests are refused.',
        });
      }
      const clientVersion = request.headers[CLIENT_VERSION_HEADER];
      if (
        request.method !== 'GET' &&
        request.method !== 'HEAD' &&
        clientVersion !== undefined &&
        clientVersion !== DAEMON_VERSION
      ) {
        return reply.code(409).send({
          code: 'version-mismatch',
          error: 'Reload Rocky before changing this Run.',
        });
      }
      return undefined;
    });
    local.setErrorHandler((error, _request, reply) => {
      if (error instanceof LocalApiError || error instanceof ArtifactError) {
        return reply
          .code(error.statusCode)
          .send({ code: error.code, error: error.message });
      }
      const status =
        typeof error === 'object' &&
        error !== null &&
        'statusCode' in error &&
        typeof error.statusCode === 'number'
          ? error.statusCode
          : 500;
      if (status >= 500) local.log.error(error, 'Local service failed');
      return reply.code(status).send({
        code: status < 500 ? 'invalid-request' : 'local-service-error',
        error:
          status < 500
            ? 'Invalid request.'
            : 'Local service failed. See the daemon log.',
      });
    });

    const getRun = async (id: unknown) => {
      const runId = parse(segment, id);
      const run = await options.runs.get(runId);
      if (!run) throw new LocalApiError(404, 'unknown-run', 'Run not found.');
      return run;
    };

    local.get('/api/runs', async (): Promise<RunList> => {
      const runs = (await options.runs.list()).sort(
        (a, b) =>
          b.createdAt.localeCompare(a.createdAt) ||
          b.runId.localeCompare(a.runId),
      );
      return {
        runs: runs.map(summary),
        pollAfterMs: runs.some(
          (run) => run.status === 'running' || run.status === 'queued',
        )
          ? 2000
          : 30000,
      };
    });
    local.get<{ Params: { id: string } }>(
      '/api/runs/:id',
      async (request): Promise<RunDetail> => {
        const run = await getRun(request.params.id);
        const entries = await options.runs.journal(run.runId);
        const steps = await Promise.all(
          journalSteps(entries).map(
            async ({ key, parentKey, entry }): Promise<StepView> => {
              const presentation = await options.presentStep?.(
                run.runId,
                key,
                entry,
              );
              let transcript: StepView['transcript'] = 'unavailable';
              try {
                transcript = (await options.artifacts.transcript(
                  run.runId,
                  key,
                ))
                  ? 'available'
                  : entry.step === 'agent' && entry.status === 'running'
                    ? 'pending'
                    : 'unavailable';
              } catch (error) {
                if (error instanceof ArtifactError && error.statusCode === 410)
                  transcript = 'pruned';
                else throw error;
              }
              if (run.artifactsPruned && entry.step === 'agent')
                transcript = 'pruned';
              return {
                key,
                parentKey,
                seq: entry.seq,
                step: entry.step,
                label: entry.label,
                stage: entry.stage,
                status: entry.status,
                boot: entry.boot,
                startedAt: entry.startedAt,
                ms: entry.ms,
                completedBeforeCurrentBoot:
                  entry.status === 'done' && entry.boot < run.boots,
                result: entry.result,
                error: entry.error && {
                  name: entry.error.name,
                  message: entry.error.message,
                },
                attempts: (entry.attempts ?? []).map((attempt) =>
                  attempt.kind === 'steer'
                    ? {
                        kind: attempt.kind,
                        startedAt: attempt.startedAt,
                        ms: attempt.ms,
                        note: attempt.note,
                      }
                    : {
                        kind: attempt.kind,
                        startedAt: attempt.startedAt,
                        ms: attempt.ms,
                        error: {
                          name: attempt.error.name,
                          message: attempt.error.message,
                        },
                      },
                ),
                transcript,
                usage: presentation?.usage,
                screenshots: presentation?.screenshots ?? [],
              };
            },
          ),
        );
        const checkpoint = await options.currentCheckpoint?.(run.runId);
        const diffs = await options.artifacts.listDiffs(run.runId);
        const steers = (await options.steers?.(run.runId)) ?? [];
        const revision = createHash('sha256')
          .update(JSON.stringify({ entries, diffs, checkpoint, steers }))
          .digest('hex');
        return {
          run: summary(run),
          revision,
          steps,
          checkpoint,
          steers,
          usage: sumUsage(steps),
          diffs,
          controls: {
            answer:
              options.answer !== undefined &&
              options.currentCheckpoint !== undefined,
            steer: options.steer !== undefined,
          },
        };
      },
    );
    local.get<{ Params: { id: string; diffId: string } }>(
      '/api/runs/:id/diffs/:diffId',
      async (request) => {
        const run = await getRun(request.params.id);
        return options.artifacts.readDiff(
          run.runId,
          parse(segment, request.params.diffId),
        );
      },
    );
    local.get<{ Params: { id: string } }>(
      '/api/screenshots/:id',
      async (request, reply) => {
        const artifact = await options.artifacts.readScreenshot(
          request.params.id,
        );
        return reply
          .header('content-security-policy', "default-src 'none'; sandbox")
          .type(artifact.contentType)
          .send(artifact.bytes);
      },
    );
    local.get('/api/settings', () => options.settings.read());
    local.patch('/api/settings', (request) =>
      options.settings.patch(request.body),
    );
    local.post<{ Params: { id: string } }>(
      '/api/runs/:id/answer',
      async (request, reply) => {
        const run = await getRun(request.params.id);
        const input = parse(
          z
            .object({
              stepKey,
              generation: z.string().min(1).max(200),
              answer: answerSchema,
            })
            .strict(),
          request.body,
        );
        if (!options.answer)
          throw new LocalApiError(
            503,
            'answer-unavailable',
            'Checkpoint Answer service is not connected.',
          );
        const result = await options.answer(run.runId, input);
        if (result.kind === 'already-answered')
          return reply.code(409).send({
            code: 'already-answered',
            error: 'Checkpoint already answered.',
            answer: result.answer,
          });
        return result;
      },
    );
    local.post<{ Params: { id: string } }>(
      '/api/runs/:id/steer',
      async (request) => {
        const run = await getRun(request.params.id);
        const input = parse(
          z
            .object({
              requestId: z.string().uuid(),
              message: z
                .string()
                .min(1)
                .max(32000)
                .refine((s) => s.trim().length > 0),
            })
            .strict(),
          request.body,
        );
        if (!options.steer)
          throw new LocalApiError(
            503,
            'steer-unavailable',
            'Shared Steer intake is not connected.',
          );
        return options.steer(run.runId, input);
      },
    );
    local.post('/api/triggers', async (request, reply) => {
      const input = parse(
        z
          .object({
            trigger: segment,
            issue: z.string().regex(/^[A-Za-z][A-Za-z0-9]*-\d+$/),
          })
          .strict(),
        request.body,
      );
      if (!options.manual)
        throw new LocalApiError(
          503,
          'trigger-unavailable',
          'Manual Trigger admission is not connected.',
        );
      const result = await options.manual(input);
      if (result.kind === 'refused')
        return reply.code(409).send({
          code: 'trigger-refused',
          error: result.reason,
          runId: result.runId,
        });
      return reply.code(201).send(result);
    });

    local.get<{
      Params: { id: string; key: string };
      Querystring: { offset?: string };
    }>('/api/runs/:id/steps/:key/transcript', async (request, reply) => {
      const run = await getRun(request.params.id);
      const key = parse(stepKey, request.params.key);
      const locate = async () =>
        journalSteps(await options.runs.journal(run.runId)).find(
          (step) => step.key === key,
        )?.entry;
      const entry = await locate();
      if (!entry)
        throw new LocalApiError(404, 'unknown-step', 'Step not found.');
      const registered = await options.artifacts.transcript(run.runId, key);
      if (!registered)
        throw new LocalApiError(
          404,
          'transcript-unavailable',
          'This Step has no retained Transcript yet.',
        );
      const rawOffset =
        request.headers['last-event-id'] ?? request.query.offset ?? '0';
      const offsetString = parse(z.string().regex(/^\d{1,16}$/), rawOffset);
      let offset = Number(offsetString);
      if (!Number.isSafeInteger(offset))
        throw new LocalApiError(
          400,
          'invalid-offset',
          'Invalid Transcript offset.',
        );
      const file = await open(
        registered.path,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const initial = await file.stat();
        if (!initial.isFile() || initial.nlink !== 1)
          throw new ArtifactError(
            400,
            'unsafe_artifact_path',
            'Transcript must be a regular unlinked artifact file',
          );
        if (initial.size > MAX_TRANSCRIPT_BYTES)
          throw new ArtifactError(
            413,
            'transcript_too_large',
            'Transcript exceeds 100 MiB',
          );
        if (offset > initial.size)
          throw new LocalApiError(
            409,
            'transcript-changed',
            'Transcript offset is beyond the retained stream.',
          );
      } catch (error) {
        await file.close();
        throw error;
      }
      const controller = new AbortController();
      streams.add(controller);
      const abort = () => controller.abort();
      reply.raw.once('close', abort);
      const stream = Readable.from(
        (async function* () {
          try {
            yield ': connected\n\n';
            const bytes = Buffer.alloc(TRANSCRIPT_CHUNK_BYTES);
            let lastSentAt = Date.now();
            while (!controller.signal.aborted) {
              const fileInfo = await file.stat();
              if (fileInfo.size > MAX_TRANSCRIPT_BYTES) {
                yield 'event: unavailable\ndata: {}\n\n';
                return;
              }
              if (fileInfo.size < offset) {
                yield 'event: unavailable\ndata: {}\n\n';
                return;
              }
              const { bytesRead } = await file.read(
                bytes,
                0,
                bytes.length,
                offset,
              );
              if (bytesRead) {
                let end = bytesRead;
                let start = end - 1;
                while (start >= 0 && (bytes[start] & 0xc0) === 0x80) start--;
                if (start >= 0) {
                  const lead = bytes[start];
                  const width =
                    lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
                  if (end - start < width) end = start;
                }
                if (end > 0) {
                  const text = bytes.subarray(0, end).toString('utf8');
                  offset += end;
                  yield `id: ${offset}\nevent: transcript\ndata: ${JSON.stringify({ text, offset })}\n\n`;
                  lastSentAt = Date.now();
                  continue;
                }
              }
              const current = await locate();
              const header = await options.runs.get(run.runId);
              if (
                current?.status !== 'running' ||
                header?.status !== 'running'
              ) {
                if (fileInfo.size > offset && !bytesRead) {
                  await delay(20, undefined, { signal: controller.signal });
                  continue;
                }
                yield 'event: settled\ndata: {}\n\n';
                return;
              }
              if (Date.now() - lastSentAt >= SSE_HEARTBEAT_MS) {
                // Keep an otherwise quiet live turn open without presenting a
                // heartbeat as Transcript content.
                yield ': keepalive\n\n';
                lastSentAt = Date.now();
              }
              await delay(200, undefined, { signal: controller.signal });
            }
          } catch (error) {
            if (!controller.signal.aborted) {
              local.log.error(error, 'Local Transcript reader failed');
              yield 'event: unavailable\ndata: {}\n\n';
            }
          } finally {
            streams.delete(controller);
            reply.raw.off('close', abort);
            await file.close();
          }
        })(),
        { objectMode: false, highWaterMark: 1 },
      );
      controller.signal.addEventListener(
        'abort',
        () => {
          stream.destroy();
          reply.raw.destroy();
        },
        { once: true },
      );
      if (reply.raw.destroyed) controller.abort();
      // Backpressure leaves at most one chunk buffered. Heartbeats keep a quiet
      // Agent turn alive, while a client that stops draining still times out.
      reply.raw.setTimeout(SSE_STALLED_SOCKET_MS, () => {
        controller.abort();
        stream.destroy();
        reply.raw.destroy();
      });
      return reply
        .type('text/event-stream')
        .header('x-accel-buffering', 'no')
        .send(stream);
    });
  });
}
