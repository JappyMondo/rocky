import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  PostActivityOptions,
  WriteResult,
  LinearSessionActivity,
  LinearSessionSummary,
} from './client.js';
import type { StepOutcome } from '../run/replay.js';
import type { AgentSessionEvent } from './events.js';

type RawCheckpointAnswer =
  | { decision: 'approve' }
  | { decision: 'reject'; reason?: string }
  | { decision: 'steer'; message: string };

/** Bound to runner-owned records in the Run's Journal, never a header cache. */
export interface LinearControlStore {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
}

export interface CheckpointDigest {
  prUrl?: string;
  diffStat: string;
  ci: string;
  unresolved: number;
}

export interface CheckpointRequest {
  kind?: 'question';
  options?: string[];
  title: string;
  body: string;
  label?: string;
  digest: CheckpointDigest;
}

/** A Checkpoint identity is a full nested Step key plus its one issued generation. */
export interface CheckpointIdentity {
  stepKey: string;
  generation: string;
}

/** Read-only Checkpoint state for the local product and conflict responses. */
export interface CheckpointSnapshot extends CheckpointIdentity {
  kind?: 'question';
  options?: string[];
  title: string;
  body: string;
  answer?: RawCheckpointAnswer;
  answeredAt?: string;
}

export interface CheckpointAnswerInput extends CheckpointIdentity {
  requestId: string;
  answer: RawCheckpointAnswer;
}

export type CheckpointAnswerResult =
  | { kind: 'accepted'; answer: RawCheckpointAnswer }
  | { kind: 'already-answered'; answer: RawCheckpointAnswer };

export interface SteerTargetSnapshot {
  stepKey: string;
  delivered: boolean;
}

/** A durable receipt, not a claim that a Harness has already acted on it. */
export interface SteerSnapshot {
  id: string;
  source: 'linear' | 'local';
  requestId: string;
  message: string;
  receivedAt: string;
  state: 'held' | 'delivered';
  targets: SteerTargetSnapshot[];
}

const answerSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('approve') }).strict(),
  z
    .object({ decision: z.literal('reject'), reason: z.string().optional() })
    .strict(),
  z.object({ decision: z.literal('steer'), message: z.string() }).strict(),
]);
const checkpointSchema = z
  .object({
    kind: z.literal('question').optional(),
    options: z.array(z.string()).optional(),
    stepKey: z.string(),
    generation: z.string(),
    activityId: z.string(),
    at: z.string(),
    title: z.string(),
    body: z.string(),
    approveValue: z.string(),
    rejectValue: z.string(),
    emitted: z.boolean(),
    answer: answerSchema.optional(),
    answeredAt: z.string().optional(),
  })
  .strict();
export type WaitingCheckpoint = z.infer<typeof checkpointSchema>;
const stateSchema = z
  .object({
    checkpoints: z.array(checkpointSchema),
    inputs: z.record(z.string(), z.enum(['accepted', 'already answered'])),
    notes: z.array(
      z
        .object({
          id: z.string(),
          source: z.enum(['linear', 'local']),
          sourceId: z.string(),
          note: z.string(),
          at: z.string(),
          targets: z.array(
            z
              .object({
                stepKey: z.string(),
                delivered: z.boolean(),
                active: z.boolean(),
              })
              .strict(),
          ),
          pending: z.boolean(),
          binding: z.boolean(),
          group: z.string().optional(),
        })
        .strict(),
    ),
    stopped: z.boolean(),
    notices: z.array(
      z
        .object({
          id: z.string(),
          action: z.string(),
          result: z.string(),
          ephemeral: z.boolean(),
          sent: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();
type ControlState = z.infer<typeof stateSchema>;
export type IntakeResult =
  'accepted' | 'already answered' | 'duplicate' | 'ended';
export interface ControlInput {
  source: 'linear' | 'local';
  id: string;
  body?: string;
  createdAt?: string;
  signal?: string;
  /** Local Answer calls must bind both parts of the Checkpoint identity. */
  stepKey?: string;
  generation?: string;
  answer?: RawCheckpointAnswer;
  /** Internal guard for local Compose, which cannot resolve a Checkpoint. */
  steerOnly?: boolean;
}
export interface LinearRunControlOptions {
  store: LinearControlStore;
  client: {
    postActivity(input: PostActivityOptions): Promise<WriteResult>;
    ensureActivity(
      input: PostActivityOptions & { id: string },
    ): Promise<WriteResult>;
    activities(
      sessionId: string,
      options?: { since?: string },
    ): Promise<LinearSessionActivity[]>;
    session(sessionId: string): Promise<LinearSessionSummary>;
  };
  runId: string;
  sessionId: string;
  issueId: string;
  appUserId: string;
  runUrl: string;
  /** NG-601's total-comment budget gate, before any elicitation is emitted. */
  beforeElicitation(): Promise<void>;
  parked?(waiting: boolean): Promise<void>;
  now?: () => number;
  /** Synchronous process/network fence; no remote cleanup is permitted. */
  halt?(): void;
  /** Enqueue scheduler cancellation; never await the Boot currently reconciling. */
  cancel?(): void | Promise<void>;
  ended?(): Promise<boolean>;
  wake?(): void;
  onError?(error: unknown): void;
}

export interface LiveConversation {
  /** Full branch-local Step key, stable across a cold retry. */
  stepKey: string;
  label: string;
  group?: string;
}
export interface SteerBatch {
  ids: string[];
  message: string;
}
export const LIVE_STEER_POLL_MS = 60_000;

function pending(note: ControlState['notes'][number]): boolean {
  return (
    note.pending ||
    note.targets.some((target) => target.active && !target.delivered)
  );
}

function checkpointSnapshot(checkpoint: WaitingCheckpoint): CheckpointSnapshot {
  return structuredClone({
    ...(checkpoint.kind ? { kind: checkpoint.kind } : {}),
    ...(checkpoint.options === undefined
      ? {}
      : { options: checkpoint.options }),
    stepKey: checkpoint.stepKey,
    generation: checkpoint.generation,
    title: checkpoint.title,
    body: checkpoint.body,
    ...(checkpoint.answer === undefined ? {} : { answer: checkpoint.answer }),
    ...(checkpoint.answeredAt === undefined
      ? {}
      : { answeredAt: checkpoint.answeredAt }),
  });
}

function steerSnapshot(note: ControlState['notes'][number]): SteerSnapshot {
  return structuredClone({
    id: note.id,
    source: note.source,
    requestId: note.sourceId,
    message: note.note,
    receivedAt: note.at,
    state: pending(note) ? 'held' : 'delivered',
    targets: note.targets.map(({ stepKey, delivered }) => ({
      stepKey,
      delivered,
    })),
  });
}

/** Read-only presentation from durable state, independent of a failed writer. */
export function inspectLinearControl(value: unknown): {
  checkpoint?: CheckpointSnapshot;
  steers: SteerSnapshot[];
} {
  if (value === undefined) return { steers: [] };
  const state = stateSchema.parse(value);
  const checkpoint = state.checkpoints.find((item) => !item.answer);
  return {
    ...(checkpoint ? { checkpoint: checkpointSnapshot(checkpoint) } : {}),
    steers: state.notes.map(steerSnapshot),
  };
}

function sharedConversationGroup(
  conversations: Iterable<LiveConversation>,
): string | undefined {
  const live = [...conversations];
  const group = live[0]?.group;
  return group !== undefined &&
    live.every((conversation) => conversation.group === group)
    ? group
    : undefined;
}

/** One instance per Run; every surface shares its serialized durable intake. */
export class LinearRunControl {
  private serial = Promise.resolve();
  private readonly now: () => number;
  private readonly conversations = new Map<string, LiveConversation>();
  private readonly inFlight = new Map<string, string[]>();
  // A stop fences new work immediately without overtaking an already queued Answer.
  private nextInput = 0;
  private stopInput?: number;
  private stopping = false;
  private nextLivePoll: number;
  private reconciliation?: Promise<void>;

  constructor(private readonly options: LinearRunControlOptions) {
    this.now = options.now ?? Date.now;
    this.nextLivePoll = this.now() + LIVE_STEER_POLL_MS;
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.serial.then(fn);
    this.serial = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async state(): Promise<ControlState> {
    const value = await this.options.store.get('linear:control');
    return value === undefined
      ? { checkpoints: [], inputs: {}, notes: [], stopped: false, notices: [] }
      : stateSchema.parse(value);
  }

  private save(state: ControlState): Promise<void> {
    return this.options.store.put('linear:control', state);
  }

  async waiting(): Promise<WaitingCheckpoint | undefined> {
    return this.exclusive(async () =>
      (await this.state()).checkpoints.find((checkpoint) => !checkpoint.answer),
    );
  }

  /** The only unresolved Checkpoint, for the local decision surface. */
  currentCheckpoint(): Promise<CheckpointSnapshot | undefined> {
    return this.exclusive(async () => {
      const checkpoint = (await this.state()).checkpoints.find(
        (item) => !item.answer,
      );
      return checkpoint === undefined
        ? undefined
        : checkpointSnapshot(checkpoint);
    });
  }

  /** Includes a settled answer so a losing local request can show the winner. */
  checkpointSnapshot(
    identity: CheckpointIdentity,
  ): Promise<CheckpointSnapshot | undefined> {
    return this.exclusive(async () => {
      const checkpoint = (await this.state()).checkpoints.find(
        (item) =>
          item.stepKey === identity.stepKey &&
          item.generation === identity.generation,
      );
      return checkpoint === undefined
        ? undefined
        : checkpointSnapshot(checkpoint);
    });
  }

  async checkpoint(
    stepKey: string,
    request: CheckpointRequest,
  ): Promise<StepOutcome<RawCheckpointAnswer>> {
    const previous = await this.exclusive(async () =>
      (await this.state()).checkpoints.find((item) => item.stepKey === stepKey),
    );
    if (previous?.emitted && !previous.answer && !this.stopping)
      await this.reconcile();
    return this.exclusive(async () => {
      const state = await this.state();
      let checkpoint = state.checkpoints.find(
        (item) => item.stepKey === stepKey,
      );
      if (checkpoint?.answer)
        return { status: 'done', result: checkpoint.answer };
      if (state.stopped || this.stopping)
        throw new Error('The Run has stopped');
      if (!checkpoint) {
        if (state.checkpoints.some((item) => !item.answer))
          throw new Error('A Run already has a waiting Checkpoint');
        const generation = randomUUID();
        const { digest } = request;
        const notes = state.notes.filter(pending);
        const held = notes.length
          ? `\n\nPending Steers (not yet heard by every intended Agent):\n\n${notes.map((note) => note.note).join('\n\n')}`
          : '';
        checkpoint = {
          ...(request.kind ? { kind: request.kind } : {}),
          ...(request.kind && request.options !== undefined
            ? { options: request.options }
            : {}),
          stepKey,
          generation,
          activityId: randomUUID(),
          at: new Date(this.now()).toISOString(),
          title: request.title,
          body:
            request.kind === 'question'
              ? `## ${request.title}\n\n${request.body}\n\n${request.options?.map((option, i) => `${i + 1}. ${option}`).join('\n') ?? ''}\n\nReply with your answer, or [open Rocky](${this.options.runUrl}).`
              : `## ${request.title}\n\n${request.body}\n\nPR: ${digest.prUrl ?? 'none'}\nDiff: ${digest.diffStat}\nCI: ${digest.ci}; unresolved Complaints: ${digest.unresolved}\n\n[Open Rocky](${this.options.runUrl})${held}`,
          approveValue: `rocky:${generation}:approve`,
          rejectValue: `rocky:${generation}:reject`,
          emitted: false,
        };
        state.checkpoints.push(checkpoint);
        await this.save(state);
      }
      if (checkpoint.answer)
        return { status: 'done', result: checkpoint.answer };
      if (!checkpoint.emitted) {
        await this.options.beforeElicitation();
        if (this.stopping) throw new Error('The Run has stopped');
        const result = await this.options.client.ensureActivity({
          id: checkpoint.activityId,
          sessionId: this.options.sessionId,
          content: { type: 'elicitation', body: checkpoint.body },
          ...(checkpoint.kind === 'question'
            ? {}
            : {
                signal: 'select' as const,
                signalMetadata: {
                  options: [
                    { label: 'Approve', value: checkpoint.approveValue },
                    { label: 'Reject', value: checkpoint.rejectValue },
                  ],
                },
              }),
        });
        if (!result.success || result.id !== checkpoint.activityId)
          throw new Error('Linear did not confirm the Checkpoint elicitation');
        checkpoint.emitted = true;
        await this.save(state);
      }
      await this.options.parked?.(true);
      return { status: 'waiting' };
    });
  }

  intake(input: ControlInput): Promise<IntakeResult> {
    if (
      !input.id ||
      (input.createdAt !== undefined &&
        !Number.isFinite(Date.parse(input.createdAt)))
    )
      return Promise.reject(
        new Error(
          'Control intake requires a request/activity ID and valid source time',
        ),
      );
    const inputOrder = ++this.nextInput;
    if (input.signal === 'stop') {
      this.stopInput ??= inputOrder;
      this.stopping = true;
      this.options.halt?.();
    }
    return this.exclusive(async (): Promise<IntakeResult> => {
      const state = await this.state();
      const id = `${input.source}:${input.id}`;
      if (await this.options.ended?.()) return 'ended';
      if (input.signal === 'stop') {
        const checkpoint = state.checkpoints.find((item) => !item.answer);
        if (checkpoint) {
          checkpoint.answer = {
            decision: 'reject',
            reason: 'Stopped by the human',
          };
          checkpoint.answeredAt = new Date(this.now()).toISOString();
        }
        state.stopped = true;
        state.inputs[id] = 'accepted';
        await this.save(state);
        return 'accepted';
      }
      if (
        state.stopped ||
        (this.stopping &&
          (this.stopInput === undefined || inputOrder > this.stopInput))
      )
        return 'ended';
      if (state.inputs[id])
        return state.inputs[id] === 'already answered'
          ? 'already answered'
          : 'duplicate';
      if (
        input.source === 'local' &&
        input.answer !== undefined &&
        (!input.generation || !input.stepKey)
      ) {
        throw new Error(
          'A local Checkpoint Answer requires both its Step key and generation',
        );
      }
      if (input.answer && input.generation && input.stepKey) {
        const issued = state.checkpoints.find(
          (item) => item.generation === input.generation,
        );
        if (!issued || issued.stepKey !== input.stepKey)
          throw new Error(
            `Checkpoint Step key ${input.stepKey} does not match generation ${input.generation}`,
          );
      }
      const issued = state.checkpoints.find(
        (item) =>
          input.body === item.approveValue || input.body === item.rejectValue,
      );
      const createdAt = input.createdAt;
      const checkpoint =
        input.generation !== undefined
          ? state.checkpoints.find(
              (item) =>
                item.generation === input.generation &&
                (input.stepKey === undefined || item.stepKey === input.stepKey),
            )
          : (issued ??
            (createdAt
              ? [...state.checkpoints]
                  .reverse()
                  .find(
                    (item) =>
                      Date.parse(item.at) <= Date.parse(createdAt) &&
                      (!item.answeredAt ||
                        Date.parse(createdAt) <= Date.parse(item.answeredAt)),
                  )
              : state.checkpoints.find((item) => !item.answer)));
      if (input.steerOnly && checkpoint && !checkpoint.answer)
        throw new Error(
          'A waiting Checkpoint accepts free text as its exclusive Answer; submit it with the Checkpoint identity.',
        );
      if (checkpoint?.answer || (input.generation && !checkpoint)) {
        state.inputs[id] = 'already answered';
        await this.save(state);
        return 'already answered';
      }
      if (!checkpoint) {
        if (input.body === undefined)
          throw new Error('A Steer requires verbatim text');
        const group = sharedConversationGroup(this.conversations.values());
        state.notes.push({
          id,
          source: input.source,
          sourceId: input.id,
          note: input.body,
          at: input.createdAt ?? new Date(this.now()).toISOString(),
          targets: [...this.conversations.keys()].map((stepKey) => ({
            stepKey,
            delivered: false,
            active: true,
          })),
          pending: this.conversations.size === 0,
          binding: group !== undefined,
          ...(group === undefined ? {} : { group }),
        });
        state.inputs[id] = 'accepted';
        const live = this.conversations.size > 0;
        state.notices.push({
          id: randomUUID(),
          action: live ? 'Steer heard' : 'Steer waiting',
          result: live
            ? 'Heard. Finishing the current turn, then taking your note.'
            : 'Your note waits for the next Agent.',
          ephemeral: live,
          sent: false,
        });
        await this.save(state);
        return 'accepted';
      }
      const answer =
        input.answer ??
        (input.body === checkpoint.approveValue
          ? { decision: 'approve' as const }
          : input.signal === 'dismissed'
            ? {
                decision: 'reject' as const,
                reason: 'Linear delegation was dismissed',
              }
            : input.body === checkpoint.rejectValue || input.signal === 'stop'
              ? { decision: 'reject' as const }
              : { decision: 'steer' as const, message: input.body ?? '' });
      if (
        checkpoint.kind === 'question' &&
        (answer.decision === 'approve' ||
          (answer.decision === 'steer' && !answer.message.trim()))
      )
        throw new Error('A Question requires a written answer');
      checkpoint.answer = answerSchema.parse(answer);
      checkpoint.answeredAt = new Date(this.now()).toISOString();
      state.inputs[id] = 'accepted';
      state.notices.push({
        id: randomUUID(),
        action: 'Checkpoint answered',
        result: `Answer: ${checkpoint.answer.decision}`,
        ephemeral: false,
        sent: false,
      });
      await this.save(state);
      return 'accepted';
    }).then(async (result) => {
      if (input.signal === 'stop' && result !== 'ended') {
        this.requestCancellation();
      }
      if (input.signal !== 'stop' && result !== 'ended') {
        if (!(await this.waiting())) await this.options.parked?.(false);
        if (result === 'accepted') this.options.wake?.();
        await this.flushNotices();
      }
      return result;
    });
  }

  async prompted(event: AgentSessionEvent): Promise<IntakeResult> {
    if (
      event.sessionId !== this.options.sessionId ||
      event.appUserId !== this.options.appUserId ||
      (event.issueId !== undefined && event.issueId !== this.options.issueId)
    ) {
      throw new Error('Linear prompt does not belong to this Run');
    }
    const prompt = event.prompt;
    if (!prompt) throw new Error('A prompted event requires its activity');
    if (prompt.signal === 'stop')
      return this.intake({
        source: 'linear',
        id: prompt.activityId,
        signal: 'stop',
      });
    let createdAt = prompt.createdAt;
    if (!createdAt) {
      const activity = (
        await this.options.client.activities(this.options.sessionId)
      ).find((item) => item.id === prompt.activityId);
      if (!activity || activity.sessionId !== this.options.sessionId)
        throw new Error(
          'Recover the original Linear prompt timestamp before applying a delayed Answer',
        );
      createdAt = activity.createdAt;
    }
    return this.intake({
      source: 'linear',
      id: prompt.activityId,
      body: prompt.body,
      signal: prompt.signal,
      createdAt,
    });
  }

  private requestCancellation(): void {
    this.stopping = true;
    this.options.halt?.();
    if (!this.options.cancel)
      throw new Error('Wire scheduler cancellation before accepting stop');
    void Promise.resolve(this.options.cancel()).catch((error) =>
      this.options.onError?.(error),
    );
  }

  private flushNotices(): Promise<void> {
    return this.exclusive(async () => {
      const state = await this.state();
      if (
        state.stopped ||
        this.stopping ||
        state.checkpoints.some((checkpoint) => !checkpoint.answer)
      )
        return;
      for (const notice of state.notices) {
        if (notice.sent) continue;
        if (this.stopping || (await this.options.ended?.())) return;
        const input = {
          sessionId: this.options.sessionId,
          content: {
            type: 'action',
            action: notice.action,
            parameter: `Run ${this.options.runId}`,
            result: notice.result,
          },
        };
        try {
          if (notice.ephemeral) {
            const result = await this.options.client.postActivity({
              ...input,
              ephemeral: true,
            });
            if (!result.success)
              throw new Error(
                'Linear did not accept the ephemeral control activity',
              );
          } else {
            const result = await this.options.client.ensureActivity({
              ...input,
              id: notice.id,
            });
            if (!result.success || result.id !== notice.id)
              throw new Error('Linear did not confirm the control activity');
          }
        } catch (error) {
          try {
            this.options.onError?.(error);
          } catch {
            // A reporter must not turn a nonessential notice into a failed receipt.
          }
          return;
        }
        notice.sent = true;
        await this.save(state);
      }
    });
  }

  pendingSteers(): Promise<string[]> {
    return this.exclusive(async () =>
      (await this.state()).notes.filter(pending).map((note) => note.note),
    );
  }

  /** Durable local/Linear receipts, including already delivered recipients. */
  steers(): Promise<SteerSnapshot[]> {
    return this.exclusive(async () =>
      (await this.state()).notes.map(steerSnapshot),
    );
  }

  /** Local compose uses the same durable intake as a Linear prompt. */
  async steer(input: {
    requestId: string;
    message: string;
  }): Promise<SteerSnapshot> {
    const result = await this.intake({
      source: 'local',
      id: input.requestId,
      body: input.message,
      steerOnly: true,
    });
    if (result === 'ended') throw new Error('The Run has ended');
    return this.exclusive(async () => {
      const note = (await this.state()).notes.find(
        (item) => item.id === `local:${input.requestId}`,
      );
      if (!note) throw new Error('The durable Steer receipt is missing');
      return steerSnapshot(note);
    });
  }

  /** Atomically validates an exact Checkpoint identity and exposes a CAS winner. */
  async answer(input: CheckpointAnswerInput): Promise<CheckpointAnswerResult> {
    const result = await this.intake({
      source: 'local',
      id: input.requestId,
      stepKey: input.stepKey,
      generation: input.generation,
      answer: input.answer,
    });
    if (result === 'ended') throw new Error('The Run has ended');
    const checkpoint = await this.checkpointSnapshot(input);
    if (!checkpoint?.answer)
      throw new Error(
        `Checkpoint ${input.stepKey} did not persist an Answer for generation ${input.generation}`,
      );
    return result === 'already answered'
      ? { kind: 'already-answered', answer: checkpoint.answer }
      : { kind: 'accepted', answer: checkpoint.answer };
  }

  openConversation(conversation: LiveConversation): Promise<void> {
    return this.exclusive(async () => {
      if (this.conversations.has(conversation.stepKey))
        throw new Error(`Conversation ${conversation.stepKey} is already live`);
      const state = await this.state();
      if (this.stopping || state.stopped)
        throw new Error('The Run has stopped');
      for (const note of state.notes) {
        const existing = note.targets.find(
          (target) =>
            target.stepKey === conversation.stepKey && !target.delivered,
        );
        if (existing) {
          existing.active = true;
          note.pending = false;
          continue;
        }
        if (
          note.targets.some((target) => target.stepKey === conversation.stepKey)
        )
          continue;
        if (
          note.pending ||
          (note.binding &&
            conversation.group !== undefined &&
            note.group === conversation.group)
        ) {
          note.targets.push({
            stepKey: conversation.stepKey,
            delivered: false,
            active: true,
          });
          note.pending = false;
          note.binding = true;
          if (conversation.group === undefined) delete note.group;
          else note.group = conversation.group;
        }
      }
      await this.save(state);
      this.conversations.set(conversation.stepKey, { ...conversation });
    });
  }

  /** NG-544 calls only at an adapter-proven safe boundary, never on intake. */
  takeSteers(stepKey: string): Promise<SteerBatch | undefined> {
    return this.exclusive(async () => {
      if (!this.conversations.has(stepKey))
        throw new Error(`No live conversation for ${stepKey}`);
      if (this.inFlight.has(stepKey)) return undefined;
      const state = await this.state();
      if (this.stopping || state.stopped) return undefined;
      const notes = state.notes.filter((note) =>
        note.targets.some(
          (target) =>
            target.stepKey === stepKey && target.active && !target.delivered,
        ),
      );
      if (!notes.length) return undefined;
      await this.save(state);
      const ids = notes.map((note) => note.id);
      this.inFlight.set(stepKey, ids);
      return { ids, message: notes.map((note) => note.note).join('\n\n') };
    });
  }

  /** Acknowledgement follows same-session continuation, never mere shutdown. */
  delivered(stepKey: string, ids: readonly string[]): Promise<void> {
    return this.exclusive(async () => {
      const batch = this.inFlight.get(stepKey);
      if (
        !batch ||
        batch.length !== ids.length ||
        batch.some((id, index) => id !== ids[index])
      )
        throw new Error('No matching Steer delivery in flight');
      const state = await this.state();
      for (const note of state.notes)
        if (ids.includes(note.id))
          for (const target of note.targets)
            if (target.stepKey === stepKey && target.active)
              target.delivered = true;
      state.notices.push({
        id: randomUUID(),
        action: `Steered the ${this.conversations.get(stepKey)?.label ?? stepKey}`,
        result: `Delivered ${ids.length} note(s) at Step ${stepKey}.`,
        ephemeral: false,
        sent: false,
      });
      await this.save(state);
      this.inFlight.delete(stepKey);
    }).then(() => this.flushNotices());
  }

  closeConversation(stepKey: string): Promise<void> {
    return this.exclusive(async () => {
      const state = await this.state();
      for (const note of state.notes) {
        for (const target of note.targets) {
          if (target.stepKey !== stepKey || target.delivered || !target.active)
            continue;
          target.active = false;
          note.pending = true;
          note.binding = false;
        }
      }
      await this.save(state);
      this.inFlight.delete(stepKey);
      this.conversations.delete(stepKey);
    });
  }

  /** Read-only while waiting. The same intake handles webhook, local and recovery. */
  reconcile(): Promise<void> {
    if (this.reconciliation) return this.reconciliation;
    const work = async () => {
      const state = await this.exclusive(() => this.state());
      if (await this.options.ended?.()) return;
      if (state.stopped) {
        this.requestCancellation();
        return;
      }
      if (this.stopping) return;
      const session = await this.options.client.session(this.options.sessionId);
      if (
        session.id !== this.options.sessionId ||
        session.issueId !== this.options.issueId ||
        session.appUserId !== this.options.appUserId
      ) {
        throw new Error(
          "Linear session association changed; restore this Run's owned session before recovery",
        );
      }
      if (this.stopping) return;
      if (
        session.dismissedAt ||
        session.delegateId !== this.options.appUserId
      ) {
        const checkpoint = await this.waiting();
        await this.intake({
          source: 'linear',
          id: `dismissed:${session.dismissedAt ?? session.id}`,
          signal: checkpoint ? 'dismissed' : 'stop',
          ...(checkpoint ? { generation: checkpoint.generation } : {}),
        });
        return;
      }
      // A full overlapping scan is safe when caches are lost. IDs in the Journal
      // are the dedupe truth; an activity cursor must never be the only copy.
      const activities = await this.options.client.activities(
        this.options.sessionId,
      );
      for (const activity of activities) {
        if (this.stopping) return;
        if (activity.sessionId !== this.options.sessionId)
          throw new Error('Linear returned an activity from another session');
        if (activity.content.type !== 'prompt') continue;
        if (
          typeof activity.content.body !== 'string' &&
          activity.signal !== 'stop'
        )
          throw new Error(
            `Linear prompt ${activity.id} has no text; retry without advancing recovery`,
          );
        await this.intake({
          source: 'linear',
          id: activity.id,
          createdAt: activity.createdAt,
          ...(typeof activity.content.body === 'string'
            ? { body: activity.content.body }
            : {}),
          ...(activity.signal ? { signal: activity.signal } : {}),
        });
      }
      await this.flushNotices();
    };
    this.reconciliation = work().finally(() => {
      this.reconciliation = undefined;
    });
    return this.reconciliation;
  }

  /** Caller owns the timer; the scheduler already owns five-minute Checkpoint polls. */
  async tick(): Promise<void> {
    if (
      !this.conversations.size ||
      this.stopping ||
      this.now() < this.nextLivePoll
    )
      return;
    this.nextLivePoll = this.now() + LIVE_STEER_POLL_MS;
    await this.reconcile();
  }
}
