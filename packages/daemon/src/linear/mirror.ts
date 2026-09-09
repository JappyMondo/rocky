import { createHash, randomUUID } from 'node:crypto';

import { z } from 'zod';

import type { RockyLinearClient } from './client.js';

/** Bound by the execution owner to non-positional records in the single Journal. */
export interface LinearEffectStore {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
}

export type LinearMirrorClient = Pick<
  RockyLinearClient,
  | 'ensureActivity'
  | 'postActivity'
  | 'ensureComment'
  | 'maintainAttachment'
  | 'comments'
  | 'acknowledgeSession'
  | 'uploadFile'
  | 'setIssueState'
>;

export interface LinearRunMirrorOptions {
  runId: string;
  issueId: string;
  sessionId: string;
  teamId: string;
  localOrigin: string;
  /** Optional because Linear rejects some otherwise-valid icon formats (SVG). */
  iconUrl?: string;
  /** Qualification evidence, not an assumption based on schema availability. */
  platform: {
    terminalComments: 'one';
    elicitationComments: 'none' | 'one';
    evidence: string;
  };
  client: LinearMirrorClient;
  /** Separately scoped, pre-authenticated transport: one raw mutation, no reads/retries. */
  finalResponse?: {
    postActivity(
      input: LinearTerminalActivity,
    ): ReturnType<LinearMirrorClient['postActivity']>;
  };
  store: LinearEffectStore;
  /** NG-609 confines and validates paths; this module never opens arbitrary files. */
  readScreenshot?: (path: string) => Promise<Uint8Array>;
}

const startSchema = z.object({
  id: z.uuid(),
  issueId: z.string(),
  body: z.string(),
});
const attachmentSchema = z.object({
  issueId: z.string(),
  title: z.literal('Rocky'),
  url: z.string(),
  iconUrl: z.string().optional(),
  subtitle: z.string(),
});
const actionSchema = z.object({
  id: z.uuid(),
  sessionId: z.string(),
  ephemeral: z.boolean(),
  content: z.object({
    type: z.literal('action'),
    action: z.string(),
    parameter: z.string(),
    result: z.string(),
  }),
});
const presentationSchema = z.object({
  changedSummary: z.string(),
  pullRequests: z
    .array(z.object({ title: z.string(), url: z.string() }))
    .optional(),
  ci: z
    .array(
      z.object({
        name: z.string(),
        status: z.string(),
        url: z.string().optional(),
      }),
    )
    .optional(),
  checks: z
    .array(
      z.object({
        id: z.string(),
        verdict: z.enum(['ok', 'problem']),
        note: z.string(),
      }),
    )
    .optional(),
  finalPassingScreenshots: z
    .array(
      z.object({
        path: z.string(),
        filename: z.string(),
        contentType: z.string(),
      }),
    )
    .optional(),
  unresolvedComplaints: z
    .array(
      z.object({
        id: z.string(),
        file: z.string(),
        line: z.number().optional(),
        description: z.string(),
      }),
    )
    .optional(),
});
const outcomeSchema = z.union([
  z.object({ kind: z.enum(['completed', 'rejected', 'cancelled', 'giveUp']) }),
  z.object({
    kind: z.literal('failed'),
    stepId: z.string().min(1),
    reason: z.string().min(1),
  }),
]);
const closingSchema = z
  .object({ outcome: outcomeSchema, presentation: presentationSchema })
  .refine(
    ({ outcome, presentation }) =>
      outcome.kind === 'cancelled' ||
      !presentation.finalPassingScreenshots?.length ||
      (Boolean(presentation.checks?.length) &&
        presentation.checks?.every((check) => check.verdict === 'ok')),
    'Only screenshots from the final passing sweep may be uploaded.',
  );
const terminalSchema = z.object({
  id: z.uuid(),
  sessionId: z.string(),
  content: z.object({ type: z.enum(['response', 'error']), body: z.string() }),
});
const modeSchema = z.enum([
  'active',
  'parked',
  'stopped',
  'closing',
  'terminal',
]);
type Access = 'working' | 'closing' | 'final';
export type LinearTerminalActivity = z.infer<typeof terminalSchema>;

/** NG-606 supplies interpreted results, not an arbitrary author-written closing body. */
export type RunPresentation = z.infer<typeof presentationSchema>;
export type RunOutcome = z.infer<typeof outcomeSchema>;

export class LinearMirroringGateError extends Error {
  constructor(detail: string) {
    super(`Linear mirroring spec/API gate: ${detail}`);
    this.name = 'LinearMirroringGateError';
  }
}

export interface StepPresentation {
  stepId: string;
  title: string;
  summary: string;
}

export class LinearRunMirror {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly runUrl: string;
  private pendingStatus?: StepPresentation;
  private parked = false;
  private stopped = false;

  constructor(private readonly options: LinearRunMirrorOptions) {
    const origin = new URL(options.localOrigin);
    if (
      origin.protocol !== 'http:' ||
      origin.hostname !== 'localhost' ||
      origin.origin !== options.localOrigin
    ) {
      throw new Error(
        'Linear mirror requires http://localhost:<port> as localOrigin.',
      );
    }
    if (
      options.platform?.terminalComments !== 'one' ||
      !['none', 'one'].includes(options.platform.elicitationComments) ||
      !options.platform.evidence.trim()
    ) {
      throw new LinearMirroringGateError(
        'qualify terminal and elicitation auto-comments before starting a Run.',
      );
    }
    this.runUrl = `${origin.origin}/runs/${encodeURIComponent(options.runId)}`;
  }

  private key(key: string): string {
    return `linear-mirror:${this.options.runId}:${key}`;
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async frozen<T>(
    key: string,
    schema: z.ZodType<T>,
    value: () => NoInfer<T> | Promise<NoInfer<T>>,
  ): Promise<T> {
    const stored = await this.options.store.get(this.key(key));
    if (stored !== undefined) return schema.parse(stored);
    const payload = schema.parse(await value());
    await this.options.store.put(this.key(key), payload);
    return payload;
  }

  private async once(key: string, effect: () => Promise<void>): Promise<void> {
    if ((await this.options.store.get(this.key(`${key}:done`))) === true)
      return;
    await effect();
    await this.options.store.put(this.key(`${key}:done`), true);
  }

  private checkLocal(access: Access): void {
    if (this.parked)
      throw new Error('Linear mirror is Parked; resume before emitting.');
    if (this.stopped && access !== 'final')
      throw new Error(
        'Linear mirror is stopped; only final cancellation confirmation is allowed.',
      );
  }

  private async allowed(access: Access): Promise<void> {
    const stored = await this.options.store.get(this.key('mode'));
    const mode = stored === undefined ? 'active' : modeSchema.parse(stored);
    this.checkLocal(access);
    if (mode === 'parked')
      throw new Error('Linear mirror is Parked; resume before emitting.');
    if (mode === 'stopped' && access !== 'final')
      throw new Error(
        'Linear mirror is stopped; only final cancellation confirmation is allowed.',
      );
    if ((mode === 'closing' || mode === 'terminal') && access === 'working')
      throw new Error('Linear mirror is closing or terminal.');
  }

  private async network<T>(
    effect: () => Promise<T>,
    access: Exclude<Access, 'final'> = 'working',
  ): Promise<T> {
    await this.allowed(access);
    // Stop/park can arrive while the durable guard is being read.
    this.checkLocal(access);
    return effect();
  }

  setParked(parked: boolean): Promise<void> {
    this.parked = parked;
    this.pendingStatus = undefined;
    return this.serialize(async () => {
      const mode = await this.options.store.get(this.key('mode'));
      if (
        this.stopped ||
        mode === 'stopped' ||
        mode === 'closing' ||
        mode === 'terminal'
      ) {
        this.parked = false;
        throw new Error('Cannot park or resume a stopped/terminal Run.');
      }
      await this.options.store.put(
        this.key('mode'),
        parked ? 'parked' : 'active',
      );
    });
  }

  /** Immediate local fence; await completion to persist it before releasing ownership. */
  stop(): Promise<void> {
    this.stopped = true;
    this.parked = false;
    this.pendingStatus = undefined;
    return this.serialize(() =>
      this.options.store.put(this.key('mode'), 'stopped'),
    );
  }

  private async action(
    key: string,
    content: z.infer<typeof actionSchema>['content'],
    ephemeral = false,
  ): Promise<void> {
    await this.allowed('working');
    if (ephemeral) {
      const result = await this.network(() =>
        this.options.client.postActivity({
          sessionId: this.options.sessionId,
          ephemeral: true,
          content,
        }),
      );
      if (!result.success)
        throw new Error('Linear did not accept the ephemeral activity.');
      return;
    }
    const payload = await this.frozen(key, actionSchema, () => ({
      id: randomUUID(),
      sessionId: this.options.sessionId,
      ephemeral: false,
      content,
    }));
    await this.once(key, async () => {
      const result = await this.network(() =>
        this.options.client.ensureActivity(payload),
      );
      if (!result.success || result.id !== payload.id)
        throw new Error('Linear did not confirm the activity.');
    });
  }

  /** Only presentation summaries, never Harness events or Transcript chunks. */
  status(frame: StepPresentation): void {
    if (this.parked || this.stopped) return;
    this.pendingStatus = structuredClone(frame);
  }

  /** The caller schedules flushes at its rate-limited cadence; no keepalive timer. */
  flushStatus(): Promise<void> {
    return this.serialize(async () => {
      const frame = this.pendingStatus;
      this.pendingStatus = undefined;
      if (!frame) return;
      await this.action(
        `status:${randomUUID()}`,
        {
          type: 'action',
          action: frame.title,
          parameter: `Step ${frame.stepId}`,
          result: frame.summary,
        },
        true,
      );
    });
  }

  post(postId: string, summary: string): Promise<void> {
    return this.serialize(() =>
      this.action(`post:${postId}`, {
        type: 'action',
        action: 'Post',
        parameter: `Run ${this.options.runId}`,
        result: summary,
      }),
    );
  }

  setState(stepId: string, name: string): Promise<void> {
    return this.serialize(async () => {
      await this.allowed('working');
      const key = `state:${stepId}`;
      const payload = await this.frozen(
        key,
        z.object({ issueId: z.string(), teamId: z.string(), name: z.string() }),
        () => ({
          issueId: this.options.issueId,
          teamId: this.options.teamId,
          name,
        }),
      );
      await this.once(key, async () => {
        const result = await this.network(() =>
          this.options.client.setIssueState(
            payload.issueId,
            payload.teamId,
            payload.name,
          ),
        );
        if (!result.success || result.id !== payload.issueId)
          throw new Error('Linear did not confirm the issue state.');
      });
    });
  }

  settle(
    frame: StepPresentation & { outcome: 'completed' | 'failed' },
  ): Promise<void> {
    const snapshot = structuredClone(frame);
    if (this.pendingStatus?.stepId === frame.stepId)
      this.pendingStatus = undefined;
    return this.serialize(() =>
      this.action(`settle:${snapshot.stepId}`, {
        type: 'action',
        action: snapshot.title,
        parameter: `Step ${snapshot.stepId}: ${snapshot.outcome}`,
        result: `${snapshot.summary}\n\n[Transcript](${this.runUrl}/steps/${encodeURIComponent(snapshot.stepId)})`,
      }),
    );
  }

  private async commentBudget(
    finalBody?: string,
    requireFinal = false,
    access: Exclude<Access, 'final'> = 'working',
  ): Promise<void> {
    const start = startSchema.parse(
      await this.options.store.get(this.key('start')),
    );
    const baseline = z
      .array(z.string())
      .parse(await this.options.store.get(this.key('baseline')));
    const comments = await this.network(
      () => this.options.client.comments(this.options.issueId),
      access,
    );
    // The baseline is the authoritative pre-run boundary. Linear can retain
    // historical (including subsequently hidden/deleted) activities and can
    // associate one with a later session, but neither must consume this run's
    // comment budget. Without public association, new comments are still
    // conservatively unclassified.
    const relevant = comments.filter(
      (comment) =>
        !baseline.includes(comment.id) &&
        (comment.id === start.id ||
          comment.sessionId === this.options.sessionId ||
          !comment.sessionId),
    );
    const extras = relevant.filter((comment) => comment.id !== start.id);
    if (
      extras.length > 1 ||
      extras.some((comment) => comment.body !== finalBody)
    ) {
      await this.options.store.put(this.key('comment-budget-gate'), true);
      throw new LinearMirroringGateError(
        'an automatic or unclassified comment would cause a third comment; qualify comment attribution/elicitation behavior before continuing.',
      );
    }
    if (requireFinal && (relevant.length !== 2 || extras.length !== 1)) {
      throw new LinearMirroringGateError(
        'the terminal activity has not produced exactly one matching closing auto-comment; re-read after platform propagation, never add an explicit close.',
      );
    }
    await this.options.store.put(this.key('comment-budget-gate'), false);
  }

  /** NG-602 must call before emitting its elicitation, not after parking. */
  beforeElicitation(): Promise<void> {
    return this.serialize(async () => {
      await this.allowed('working');
      if (this.options.platform.elicitationComments === 'one') {
        throw new LinearMirroringGateError(
          'elicitation would introduce an unavoidable third comment; resolve NG-601/NG-602 with the platform before emitting it.',
        );
      }
      await this.commentBudget();
    });
  }

  finish(outcome: RunOutcome, presentation: RunPresentation): Promise<void> {
    const snapshot = structuredClone({ outcome, presentation });
    this.pendingStatus = undefined;
    return this.serialize(async () => {
      if ((await this.options.store.get(this.key('finish:done'))) === true)
        return;
      const strictStop =
        this.stopped ||
        (await this.options.store.get(this.key('mode'))) === 'stopped';
      const access =
        strictStop &&
        (outcome.kind === 'cancelled' || outcome.kind === 'failed')
          ? 'final'
          : 'closing';
      await this.allowed(access);
      if (strictStop) {
        if (
          (await this.options.store.get(this.key('comment-budget-gate'))) ===
            true ||
          (await this.options.store.get(this.key('start:done'))) !== true
        ) {
          throw new LinearMirroringGateError(
            'the recorded comment budget does not permit a strict-stop closing comment; no post-stop queries or additional comments are allowed.',
          );
        }
        if (!this.options.finalResponse)
          throw new LinearMirroringGateError(
            'strict stop requires an explicitly supplied final-response-only transport with independent cancellation scope; do not reuse the aborted product client.',
          );
      }
      await this.options.store.put(
        this.key('mode'),
        strictStop ? 'stopped' : 'closing',
      );
      const previousTerminal = await this.options.store.get(
        this.key('terminal'),
      );
      let terminal =
        previousTerminal === undefined
          ? undefined
          : terminalSchema.parse(previousTerminal);
      if (!strictStop)
        await this.commentBudget(terminal?.content.body, false, 'closing');
      if (!terminal) {
        const prefix =
          outcome.kind === 'cancelled' ? 'cancellation' : 'closing';
        const plan = await this.frozen(prefix, closingSchema, () => snapshot);
        const p = plan.presentation;
        const images: string[] = [];
        for (const [index, screenshot] of (strictStop ||
        plan.outcome.kind === 'cancelled'
          ? []
          : (p.finalPassingScreenshots ?? [])
        ).entries()) {
          const upload = await this.frozen(
            `screenshot:${index}:asset`,
            z.object({ assetUrl: z.string() }),
            async () => {
              if (!this.options.readScreenshot)
                throw new Error(
                  'Linear screenshots require the NG-609 confined byte reader.',
                );
              const data = new Uint8Array(
                await this.options.readScreenshot(screenshot.path),
              );
              const sha256 = createHash('sha256').update(data).digest('hex');
              const reference = await this.frozen(
                `screenshot:${index}:input`,
                z.object({
                  path: z.string(),
                  filename: z.string(),
                  contentType: z.string(),
                  sha256: z.string(),
                }),
                () => ({ ...screenshot, sha256 }),
              );
              if (reference.sha256 !== sha256)
                throw new Error(
                  `Screenshot ${reference.path} changed since its upload intent was recorded; restore the original local artifact before retrying.`,
                );
              return this.network(
                () =>
                  this.options.client.uploadFile({
                    filename: reference.filename,
                    contentType: reference.contentType,
                    data,
                  }),
                'closing',
              );
            },
          );
          images.push(`![](${upload.assetUrl})`);
        }
        const heading =
          plan.outcome.kind === 'failed'
            ? `Rocky Run failed at Step ${plan.outcome.stepId}: ${plan.outcome.reason}`
            : `Rocky Run ${plan.outcome.kind}.`;
        const body = [
          heading,
          `[Open Run](${this.runUrl})`,
          `## What Changed\n${p.changedSummary}`,
          `## Pull Requests\n${p.pullRequests?.map((pr) => `- [${pr.title}](${pr.url})`).join('\n') || 'None.'}`,
          `## CI\n${p.ci?.map((job) => `- ${job.name}: ${job.status}${job.url ? ` ([details](${job.url}))` : ''}`).join('\n') || 'Not reported.'}`,
          `## Check Results\n${p.checks?.map((check) => `- ${check.id}: ${check.verdict}. ${check.note}`).join('\n') || 'No UI sweep reported.'}`,
          ...images,
          `## Unresolved Complaints\n${p.unresolvedComplaints?.map((complaint) => `- ${complaint.id} (${complaint.file}${complaint.line === undefined ? '' : `:${complaint.line}`}): ${complaint.description}`).join('\n') || 'None reported.'}`,
        ].join('\n\n');
        await this.allowed(access);
        terminal = await this.frozen(
          'terminal',
          terminalSchema,
          (): z.infer<typeof terminalSchema> => ({
            id: randomUUID(),
            sessionId: this.options.sessionId,
            content: {
              type: plan.outcome.kind === 'failed' ? 'error' : 'response',
              body,
            },
          }),
        );
      }
      const payload = terminal;
      if (strictStop) {
        const transport = this.options.finalResponse;
        if (!transport)
          throw new LinearMirroringGateError(
            'strict stop requires a final-response-only transport.',
          );
        try {
          await this.once('terminal', async () => {
            await this.allowed('final');
            this.checkLocal('final');
            const result = await transport.postActivity(payload);
            if (!result.success || result.id !== payload.id)
              throw new Error('Raw terminal mutation was not acknowledged.');
          });
        } catch (cause) {
          throw new Error(
            `Strict-stop terminal ${payload.id} outcome is unverified. No readback or automatic retry is allowed; an explicit retry must use this same frozen ID and payload. A duplicate-ID error is not confirmation.`,
            { cause },
          );
        }
      } else {
        await this.once('terminal', async () => {
          await this.commentBudget(payload.content.body, false, 'closing');
          const result = await this.network(
            () => this.options.client.ensureActivity(payload),
            'closing',
          );
          if (!result.success || result.id !== payload.id)
            throw new Error('Linear did not confirm the terminal activity.');
        });
        await this.commentBudget(terminal.content.body, true, 'closing');
      }
      await this.options.store.put(this.key('mode'), 'terminal');
      await this.options.store.put(this.key('finish:done'), true);
    });
  }

  start(): Promise<void> {
    return this.serialize(async () => {
      await this.allowed('working');
      const ack = await this.frozen(
        'ack',
        z.object({ sessionId: z.string(), runUrl: z.string() }),
        () => ({
          sessionId: this.options.sessionId,
          runUrl: this.runUrl,
        }),
      );
      await this.once('ack', async () => {
        const result = await this.network(() =>
          this.options.client.acknowledgeSession(ack.sessionId, ack.runUrl),
        );
        if (!result.success || result.id !== ack.sessionId)
          throw new Error('Linear did not acknowledge the session.');
      });
      await this.frozen('baseline', z.array(z.string()), async () =>
        (
          await this.network(() =>
            this.options.client.comments(this.options.issueId),
          )
        ).map((comment) => comment.id),
      );
      const comment = await this.frozen('start', startSchema, () => ({
        id: randomUUID(),
        issueId: this.options.issueId,
        body: `Rocky started Run ${this.options.runId}.\n\n[Open Run](${this.runUrl})`,
      }));
      await this.once('start', async () => {
        await this.commentBudget();
        const result = await this.network(() =>
          this.options.client.ensureComment(comment),
        );
        if (!result.success || result.id !== comment.id)
          throw new Error('Linear did not confirm the start comment.');
      });
      const attachment = await this.frozen(
        'attachment',
        attachmentSchema,
        (): z.infer<typeof attachmentSchema> => ({
          issueId: this.options.issueId,
          title: 'Rocky',
          url: `${this.options.localOrigin}/issues/${encodeURIComponent(this.options.issueId)}`,
          ...(this.options.iconUrl === undefined
            ? {}
            : { iconUrl: this.options.iconUrl }),
          subtitle: `Run ${this.options.runId}`,
        }),
      );
      await this.once('attachment', async () => {
        if (
          !(
            await this.network(() =>
              this.options.client.maintainAttachment(attachment),
            )
          ).success
        )
          throw new Error('Linear did not confirm the Rocky attachment.');
      });
    });
  }
}
