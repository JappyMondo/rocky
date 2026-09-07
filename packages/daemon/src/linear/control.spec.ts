import { describe, expect, it } from 'vitest';
import {
  LinearRunControl,
  type LinearControlStore,
  type LinearRunControlOptions,
} from './control.js';
import type { LinearSessionActivity, PostActivityOptions } from './client.js';
import type { AgentSessionEvent } from './events.js';

function fixture() {
  const values = new Map<string, unknown>();
  const store: LinearControlStore = {
    async get(key) {
      return structuredClone(values.get(key));
    },
    async put(key, value) {
      values.set(key, structuredClone(value));
    },
  };
  type Activity = PostActivityOptions & { id: string };
  const activities: Activity[] = [];
  const prompts: LinearSessionActivity[] = [];
  const session = {
    id: 'session',
    issueId: 'issue',
    appUserId: 'app',
    delegateId: 'app',
    dismissedAt: null as string | null,
    status: 'stale',
  };
  let clock = Date.parse('2026-09-07T10:00:00Z');
  const client = {
    async activities() {
      return structuredClone(prompts);
    },
    async session() {
      return structuredClone(session);
    },
    async postActivity(input: PostActivityOptions) {
      const id = input.id ?? `ephemeral-${activities.length + 1}`;
      activities.push({ ...structuredClone(input), id });
      return { id, success: true };
    },
    async ensureActivity(input: Activity) {
      if (!activities.some((activity) => activity.id === input.id))
        activities.push(structuredClone(input));
      return { id: input.id, success: true };
    },
  };
  const open = (overrides: Partial<LinearRunControlOptions> = {}) =>
    new LinearRunControl({
      store,
      client,
      runId: 'FIXTURE-1-1',
      sessionId: 'session',
      issueId: 'issue',
      appUserId: 'app',
      runUrl: 'http://localhost:7625/runs/FIXTURE-1-1',
      now: () => clock,
      beforeElicitation: async () => undefined,
      ...overrides,
    });
  return {
    store,
    client,
    activities,
    prompts,
    session,
    open,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const question = {
  title: 'Merge?',
  body: 'Review the changes.',
  digest: {
    prUrl: 'https://example.test/pr/1',
    diffStat: '2 files changed',
    ci: 'passed',
    unresolved: 0,
  },
};

describe('Checkpoint Answer intake', () => {
  it('publishes exact Checkpoint snapshots and returns the durable winning Answer', async () => {
    const f = fixture();
    const control = f.open();

    await control.checkpoint('3/0/2', question);
    const current = (await control.currentCheckpoint())!;
    expect(current).toMatchObject({
      stepKey: '3/0/2',
      title: 'Merge?',
    });
    expect(current.answer).toBeUndefined();

    await expect(
      control.answer({
        requestId: 'wrong-step',
        stepKey: '3/0/3',
        generation: current.generation,
        answer: { decision: 'approve' },
      }),
    ).rejects.toThrow(/Step key/);

    expect(
      await control.answer({
        requestId: 'approved',
        stepKey: current.stepKey,
        generation: current.generation,
        answer: { decision: 'approve' },
      }),
    ).toEqual({ kind: 'accepted', answer: { decision: 'approve' } });
    expect(await control.currentCheckpoint()).toBeUndefined();
    expect(
      await control.checkpointSnapshot({
        stepKey: current.stepKey,
        generation: current.generation,
      }),
    ).toMatchObject({ answer: { decision: 'approve' } });
    expect(
      await control.answer({
        requestId: 'losing-answer',
        stepKey: current.stepKey,
        generation: current.generation,
        answer: { decision: 'reject' },
      }),
    ).toEqual({
      kind: 'already-answered',
      answer: { decision: 'approve' },
    });
  });

  it('parks without retaining work and durably applies only the first cross-surface Answer', async () => {
    const f = fixture();
    const control = f.open();
    expect(await control.checkpoint('0', question)).toEqual({
      status: 'waiting',
    });
    const checkpoint = await control.waiting();
    expect(checkpoint?.stepKey).toBe('0');
    const answers = await Promise.all([
      control.intake({
        source: 'local',
        id: 'request-1',
        generation: checkpoint!.generation,
        answer: { decision: 'approve' },
      }),
      control.intake({
        source: 'linear',
        id: 'activity-1',
        body: checkpoint!.rejectValue,
      }),
    ]);
    expect(answers).toEqual(['accepted', 'already answered']);
    f.advance(3 * 24 * 60 * 60 * 1000);
    expect(await f.open().checkpoint('0', question)).toEqual({
      status: 'done',
      result: { decision: 'approve' },
    });
    expect(
      f.activities.filter(
        (activity) => activity.content.type === 'elicitation',
      ),
    ).toHaveLength(1);
  });

  it('does not let local Compose resolve a waiting Checkpoint before reporting the conflict', async () => {
    const f = fixture();
    const control = f.open();
    await control.checkpoint('0', question);
    const before = await control.currentCheckpoint();

    await expect(
      control.steer({
        requestId: 'compose',
        message: 'use the smaller change',
      }),
    ).rejects.toThrow(/waiting Checkpoint/);

    expect(await control.currentCheckpoint()).toEqual(before);
    expect(await control.pendingSteers()).toEqual([]);
  });

  it('does not let late, duplicated or unknown-generation Answers resolve the next Checkpoint', async () => {
    const f = fixture();
    const control = f.open();
    await control.checkpoint('0', question);
    const first = (await control.waiting())!;
    f.advance(1000);
    await control.intake({
      source: 'local',
      id: 'first',
      generation: first.generation,
      answer: { decision: 'approve' },
    });
    f.advance(1000);
    await control.checkpoint('1', question);
    expect(
      await control.intake({
        source: 'linear',
        id: 'old-option',
        body: first.rejectValue,
      }),
    ).toBe('already answered');
    expect(
      await control.intake({
        source: 'local',
        id: 'unknown',
        generation: 'not-issued',
        answer: { decision: 'reject' },
      }),
    ).toBe('already answered');
    expect(
      await control.intake({
        source: 'linear',
        id: 'late-text',
        createdAt: '2026-09-07T10:00:00.500Z',
        body: 'keep the old version',
      }),
    ).toBe('already answered');
    expect(await control.checkpoint('1', question)).toEqual({
      status: 'waiting',
    });
  });

  it('refuses a second waiting Checkpoint and an elicitation Linear did not confirm', async () => {
    const f = fixture();
    const control = f.open();
    await control.checkpoint('0', question);
    await expect(control.checkpoint('1', question)).rejects.toThrow(
      /already has a waiting Checkpoint/,
    );

    const unconfirmedFixture = fixture();
    const unconfirmed = unconfirmedFixture.open({
      client: {
        ...unconfirmedFixture.client,
        ensureActivity: async ({ id }) => ({ id, success: false }),
      },
    });
    await expect(unconfirmed.checkpoint('0', question)).rejects.toThrow(
      /did not confirm the Checkpoint elicitation/,
    );
  });

  it('stays silent for three days and preserves exact free text in the exclusive Answer', async () => {
    const f = fixture();
    const control = f.open();
    await control.checkpoint('0', question);
    for (let hour = 0; hour < 72; hour++) {
      f.advance(60 * 60 * 1000);
      await f.open().checkpoint('0', question);
    }
    expect(f.activities).toHaveLength(1);
    await control.intake({
      source: 'linear',
      id: 'note',
      body: '  use the simpler approach\n\nDo not trim this.  ',
    });
    expect(await f.open().checkpoint('0', question)).toEqual({
      status: 'done',
      result: {
        decision: 'steer',
        message: '  use the simpler approach\n\nDo not trim this.  ',
      },
    });
  });

  it('does not acknowledge an Answer if its durable write fails', async () => {
    const f = fixture();
    const control = f.open();
    await control.checkpoint('0', question);
    const checkpoint = (await control.waiting())!;
    const put = f.store.put;
    f.store.put = async () => {
      throw new Error('disk full');
    };
    const input = {
      source: 'local' as const,
      id: 'answer',
      generation: checkpoint.generation,
      answer: { decision: 'approve' as const },
    };
    await expect(control.intake(input)).rejects.toThrow('disk full');
    f.store.put = put;
    expect(await f.open().checkpoint('0', question)).toEqual({
      status: 'waiting',
    });
    expect(await control.intake(input)).toBe('accepted');
  });

  it('halts stop immediately, persists a reject, and never resumes product effects', async () => {
    const f = fixture();
    let halted = false;
    let cancelled = false;
    const control = f.open({
      halt: () => {
        halted = true;
      },
      cancel: async () => {
        cancelled = true;
      },
    });
    await control.checkpoint('0', question);
    const stop = control.intake({
      source: 'linear',
      id: 'stop',
      signal: 'stop',
    });
    expect(halted).toBe(true);
    expect(await stop).toBe('accepted');
    expect(cancelled).toBe(true);
    expect(await control.checkpoint('0', question)).toEqual({
      status: 'done',
      result: { decision: 'reject', reason: 'Stopped by the human' },
    });
    await expect(control.checkpoint('1', question)).rejects.toThrow(/stopped/);
    expect(
      await control.intake({
        source: 'local',
        id: 'too-late',
        body: 'change a file',
      }),
    ).toBe('ended');
    expect(f.activities).toHaveLength(1);
  });

  it('recovers stop persisted before the scheduler saw it, without reading Linear', async () => {
    const f = fixture();
    const control = f.open();
    await expect(
      control.intake({ source: 'linear', id: 'stop', signal: 'stop' }),
    ).rejects.toThrow(/scheduler cancellation/);
    let cancelled = false;
    const recovered = f.open({
      halt: () => undefined,
      cancel: () => {
        cancelled = true;
      },
      client: {
        ...f.client,
        session: async () => {
          throw new Error('no network after stop');
        },
      },
    });
    await recovered.reconcile();
    expect(cancelled).toBe(true);
    expect(f.activities).toEqual([]);
  });

  it('recovers an offline Answer through ordinary retry without re-emitting, including session dismissal', async () => {
    const f = fixture();
    const control = f.open();
    await control.checkpoint('0', question);
    const checkpoint = (await control.waiting())!;
    f.advance(3 * 24 * 60 * 60 * 1000);
    f.prompts.push({
      id: 'offline',
      sessionId: 'session',
      createdAt: '2026-09-10T10:00:00Z',
      content: { type: 'prompt', body: checkpoint.approveValue },
      ephemeral: false,
    });
    expect(await f.open().checkpoint('0', question)).toEqual({
      status: 'done',
      result: { decision: 'approve' },
    });
    expect(
      f.activities.filter(
        (activity) => activity.content.type === 'elicitation',
      ),
    ).toHaveLength(1);
    f.advance(1000);
    await control.checkpoint('1', question);
    f.session.dismissedAt = '2026-09-10T10:00:01Z';
    expect(await f.open().checkpoint('1', question)).toEqual({
      status: 'done',
      result: { decision: 'reject', reason: 'Linear delegation was dismissed' },
    });
  });

  it('recovers a missing webhook source time from the original session activity', async () => {
    const f = fixture();
    const control = f.open();
    await control.checkpoint('0', question);
    const checkpoint = await control.waiting();
    if (!checkpoint) throw new Error('expected a waiting Checkpoint');
    f.prompts.push({
      id: 'timestamp-recovery',
      sessionId: 'session',
      createdAt: '2026-09-07T10:00:01.000Z',
      content: { type: 'prompt', body: checkpoint.approveValue },
      ephemeral: false,
    });
    const event: AgentSessionEvent = {
      action: 'prompted',
      sessionId: 'session',
      issueId: 'issue',
      appUserId: 'app',
      organizationId: 'org',
      prompt: {
        activityId: 'timestamp-recovery',
        body: checkpoint.approveValue,
      },
      payload: {} as AgentSessionEvent['payload'],
    };

    await expect(control.prompted(event)).resolves.toBe('accepted');
    expect(await control.checkpoint('0', question)).toEqual({
      status: 'done',
      result: { decision: 'approve' },
    });
  });
});

describe('Steer delivery', () => {
  it('publishes durable Steer receipts with each parallel recipient state', async () => {
    const f = fixture();
    const control = f.open();
    await control.openConversation({
      stepKey: '3/0/0',
      label: 'first',
      group: '3',
    });
    await control.openConversation({
      stepKey: '3/1/0',
      label: 'second',
      group: '3',
    });

    const received = await control.steer({
      requestId: 'local-steer',
      message: 'keep this exact\n\nmessage',
    });
    expect(received).toMatchObject({
      requestId: 'local-steer',
      message: 'keep this exact\n\nmessage',
      state: 'held',
      targets: [
        { stepKey: '3/0/0', delivered: false },
        { stepKey: '3/1/0', delivered: false },
      ],
    });

    const first = (await control.takeSteers('3/0/0'))!;
    await control.delivered('3/0/0', first.ids);
    expect(await f.open().steers()).toMatchObject([
      {
        requestId: 'local-steer',
        state: 'held',
        targets: [
          { stepKey: '3/0/0', delivered: true },
          { stepKey: '3/1/0', delivered: false },
        ],
      },
    ]);

    const second = (await control.takeSteers('3/1/0'))!;
    await control.delivered('3/1/0', second.ids);
    expect(await f.open().steers()).toMatchObject([
      {
        requestId: 'local-steer',
        state: 'delivered',
        targets: [
          { stepKey: '3/0/0', delivered: true },
          { stepKey: '3/1/0', delivered: true },
        ],
      },
    ]);
  });

  it('binds a Steer to a parallel sibling that opens during fan-out startup', async () => {
    const f = fixture();
    const control = f.open();
    await control.openConversation({
      stepKey: '3/0/0',
      label: 'first',
      group: '3',
    });
    await control.steer({
      requestId: 'during-startup',
      message: 'check the empty state too',
    });
    await control.openConversation({
      stepKey: '3/1/0',
      label: 'second',
      group: '3',
    });

    expect((await control.steers())[0]?.targets).toEqual([
      { stepKey: '3/0/0', delivered: false },
      { stepKey: '3/1/0', delivered: false },
    ]);
    const first = await control.takeSteers('3/0/0');
    const second = await control.takeSteers('3/1/0');
    expect(first?.message).toBe('check the empty state too');
    expect(second?.message).toBe('check the empty state too');
  });

  it('retains queued/exec notes across a cold restart and coalesces them only at the next boundary', async () => {
    const f = fixture();
    const control = f.open();
    for (const [id, body] of [
      ['one', '  first  '],
      ['two', 'second\nline'],
      ['three', 'third'],
    ]) {
      expect(await control.intake({ source: 'linear', id, body })).toBe(
        'accepted',
      );
      f.advance(3000);
    }
    expect(await control.pendingSteers()).toEqual([
      '  first  ',
      'second\nline',
      'third',
    ]);
    const restarted = f.open();
    await restarted.openConversation({ stepKey: '2', label: 'implementer' });
    expect(await restarted.pendingSteers()).toHaveLength(3);
    const batch = (await restarted.takeSteers('2'))!;
    expect(batch.message).toBe('  first  \n\nsecond\nline\n\nthird');
    expect(await restarted.takeSteers('2')).toBeUndefined();
    await restarted.delivered('2', batch.ids);
    expect(await f.open().pendingSteers()).toEqual([]);
    expect(
      await restarted.intake({
        source: 'linear',
        id: 'one',
        body: '  first  ',
      }),
    ).toBe('duplicate');
  });

  it('keeps per-recipient acknowledgements through partial parallel delivery and a crash', async () => {
    const f = fixture();
    const control = f.open();
    await control.openConversation({
      stepKey: '3/0/0',
      label: 'first',
      group: '3',
    });
    await control.openConversation({
      stepKey: '3/1/0',
      label: 'second',
      group: '3',
    });
    await control.intake({
      source: 'local',
      id: 'one',
      body: 'use the test account',
    });
    const first = (await control.takeSteers('3/0/0'))!;
    await control.delivered('3/0/0', first.ids);
    const restarted = f.open();
    await restarted.openConversation({
      stepKey: '3/0/0',
      label: 'first',
      group: '3',
    });
    await restarted.openConversation({
      stepKey: '3/1/0',
      label: 'second',
      group: '3',
    });
    expect(await restarted.takeSteers('3/0/0')).toBeUndefined();
    const second = (await restarted.takeSteers('3/1/0'))!;
    expect(second.message).toBe('use the test account');
    await restarted.delivered('3/1/0', second.ids);
    expect(await restarted.pendingSteers()).toEqual([]);
  });

  it('surfaces held words in the Checkpoint without consuming them', async () => {
    const f = fixture();
    const control = f.open();
    await control.intake({
      source: 'local',
      id: 'held',
      body: 'do not deploy yet',
    });
    await control.checkpoint('0', question);
    expect((await control.waiting())?.body).toContain('do not deploy yet');
    expect(await control.pendingSteers()).toEqual(['do not deploy yet']);
  });

  it('releases undelivered work at a settle race to the next Agent, not the closed session', async () => {
    const f = fixture();
    const control = f.open();
    await control.openConversation({ stepKey: '0', label: 'planner' });
    await control.intake({
      source: 'local',
      id: 'last-moment',
      body: 'keep it small',
    });
    await control.closeConversation('0');
    await control.openConversation({ stepKey: '1', label: 'implementer' });
    expect((await control.takeSteers('1'))?.message).toBe('keep it small');
    await expect(control.takeSteers('0')).rejects.toThrow(
      /No live conversation/,
    );
  });

  it('polls live conversations every sixty seconds and deduplicates webhook, poll and Boot intake', async () => {
    const f = fixture();
    const control = f.open();
    await control.openConversation({ stepKey: '0', label: 'reviewer' });
    f.prompts.push({
      id: 'poll-note',
      sessionId: 'session',
      createdAt: '2026-09-07T10:00:01Z',
      content: { type: 'prompt', body: 'a note while the endpoint is dead' },
      ephemeral: false,
    });
    f.advance(59_999);
    await control.tick();
    expect(await control.pendingSteers()).toEqual([]);
    f.advance(1);
    await control.tick();
    expect(await control.pendingSteers()).toEqual([
      'a note while the endpoint is dead',
    ]);
    expect(
      await control.intake({
        source: 'linear',
        id: 'poll-note',
        body: 'a note while the endpoint is dead',
      }),
    ).toBe('duplicate');
    await f.open().reconcile();
    expect(await control.pendingSteers()).toHaveLength(1);
  });

  it('emits held, heard and delivered actions without a comment, response or parked keepalive', async () => {
    const f = fixture();
    const control = f.open();
    await control.intake({
      source: 'local',
      id: 'held',
      body: 'check the heading',
    });
    expect(f.activities[0]?.content).toMatchObject({
      type: 'action',
      action: 'Steer waiting',
    });
    await control.openConversation({ stepKey: '0', label: 'reviewer' });
    await control.intake({
      source: 'linear',
      id: 'live',
      body: 'also the link',
    });
    expect(f.activities.at(-1)?.content).toMatchObject({
      type: 'action',
      result: 'Heard. Finishing the current turn, then taking your note.',
    });
    const batch = (await control.takeSteers('0'))!;
    await control.delivered('0', batch.ids);
    expect(f.activities.at(-1)?.content).toMatchObject({
      type: 'action',
      action: 'Steered the reviewer',
    });
    await control.closeConversation('0');
    await control.checkpoint('1', question);
    const count = f.activities.length;
    f.advance(72 * 60 * 60 * 1000);
    await control.checkpoint('1', question);
    await control.tick();
    expect(f.activities).toHaveLength(count);
    expect(
      f.activities.every((activity) =>
        ['action', 'elicitation'].includes(String(activity.content.type)),
      ),
    ).toBe(true);
  });

  it('does not require ephemeral heard notices to survive an activity readback', async () => {
    const f = fixture();
    f.client.ensureActivity = async (input) => {
      if (input.ephemeral)
        throw new Error('ephemeral activity disappeared before readback');
      return { id: input.id, success: true };
    };
    const control = f.open();
    await control.openConversation({ stepKey: '0', label: 'reviewer' });

    await expect(
      control.intake({ source: 'local', id: 'live', body: 'take this note' }),
    ).resolves.toBe('accepted');
    expect(f.activities.at(-1)).toMatchObject({
      ephemeral: true,
      content: { type: 'action', action: 'Steer heard' },
    });
  });

  it('treats a new prompt after a resolved Checkpoint as a Steer, not a late exclusive Answer', async () => {
    const f = fixture();
    const control = f.open();
    await control.checkpoint('0', question);
    const first = (await control.waiting())!;
    await control.intake({
      source: 'local',
      id: 'approve',
      generation: first.generation,
      answer: { decision: 'approve' },
    });
    f.advance(1000);
    expect(
      await control.intake({
        source: 'linear',
        id: 'after',
        body: 'check this too',
        createdAt: '2026-09-07T10:00:01Z',
      }),
    ).toBe('accepted');
    expect(await control.pendingSteers()).toEqual(['check this too']);
  });
});
