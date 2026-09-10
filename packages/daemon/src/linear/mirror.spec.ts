import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  LinearRunMirror,
  type LinearMirrorClient,
  type LinearEffectStore,
} from './mirror.js';

// Test-owned persistence survives constructing a new mirror, not a production store.
function fixture() {
  const records = new Map<string, unknown>();
  const store: LinearEffectStore = {
    get: async (key) => structuredClone(records.get(key)),
    put: async (key, value) => {
      records.set(key, structuredClone(value));
    },
  };
  const comments: Awaited<ReturnType<LinearMirrorClient['comments']>> = [];
  const activities: Parameters<LinearMirrorClient['ensureActivity']>[0][] = [];
  const attachments = new Map<
    string,
    Parameters<LinearMirrorClient['maintainAttachment']>[0]
  >();
  const calls: string[] = [];
  const finalPosts: Parameters<LinearMirrorClient['ensureActivity']>[0][] = [];
  const productAbort = new AbortController();
  const record = (call: string) => {
    calls.push(call);
    productAbort.signal.throwIfAborted();
  };
  const createActivity = (
    input: Parameters<LinearMirrorClient['ensureActivity']>[0],
  ) => {
    if (activities.some((activity) => activity.id === input.id))
      throw new Error('duplicate activity ID');
    activities.push(structuredClone(input));
    if (input.content.type === 'response' || input.content.type === 'error') {
      comments.push({
        id: randomUUID(),
        body: String(input.content.body),
        sessionId: input.sessionId,
        issueId: 'issue-test',
        userId: null,
        parentId: null,
        createdAt: '2026-01-01T00:00:01Z',
      });
    }
    return { id: input.id, success: true };
  };
  const finalResponse = {
    postActivity: async (
      input: Parameters<LinearMirrorClient['ensureActivity']>[0],
    ) => {
      calls.push('postActivity:final');
      finalPosts.push(structuredClone(input));
      expect(['response', 'error']).toContain(input.content.type);
      return createActivity(input);
    },
  };
  const client: LinearMirrorClient = {
    postActivity: async (input) => {
      record('postActivity:product');
      return createActivity({ ...input, id: input.id ?? randomUUID() });
    },
    acknowledgeSession: async (id) => {
      record('acknowledge');
      return { id, success: true };
    },
    comments: async () => {
      record('comments');
      return structuredClone(comments);
    },
    ensureComment: async (input) => {
      record('comment');
      if (!comments.some((comment) => comment.id === input.id))
        comments.push({
          ...input,
          sessionId: null,
          userId: null,
          parentId: null,
          createdAt: '2026-01-01T00:00:00Z',
        });
      return { id: input.id, success: true };
    },
    ensureActivity: async (input) => {
      record('activity');
      if (!activities.some((activity) => activity.id === input.id)) {
        createActivity(input);
      }
      return { id: input.id, success: true };
    },
    maintainAttachment: async (input) => {
      record('attachment');
      attachments.set(input.url, input);
      return { id: 'attachment', success: true };
    },
    uploadFile: async () => {
      record('upload');
      return { assetUrl: 'https://assets.example.test/final.png' };
    },
    setIssueState: async (id) => {
      record('state');
      return { id, success: true };
    },
  };
  const options = {
    runId: 'run-test-1',
    issueId: 'issue-test',
    sessionId: 'session-test',
    teamId: 'team-test',
    localOrigin: 'http://localhost:7431',
    iconUrl: 'https://example.test/raccoon.png',
    platform: {
      terminalComments: 'one' as const,
      elicitationComments: 'none' as const,
      evidence: 'test platform fixture',
    },
    client,
    store,
    finalResponse,
  };
  return {
    options,
    client,
    store,
    comments,
    activities,
    attachments,
    calls,
    finalResponse,
    productAbort,
    records,
    finalPosts,
  };
}

describe('LinearRunMirror', () => {
  it('acknowledges first, starts once across restart, and maintains one issue permalink across Runs', async () => {
    const f = fixture();
    await new LinearRunMirror(f.options).start();
    await new LinearRunMirror(f.options).start();
    expect(f.calls[0]).toBe('acknowledge');
    expect(f.comments).toHaveLength(1);
    expect(f.comments[0].body).toContain(
      'http://localhost:7431/runs/run-test-1',
    );
    expect(f.comments[0].id).toMatch(
      /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/,
    );
    await new LinearRunMirror({
      ...f.options,
      runId: 'run-test-2',
      sessionId: 'session-test-2',
    }).start();
    expect([...f.attachments.values()]).toEqual([
      {
        issueId: 'issue-test',
        title: 'Rocky',
        url: 'http://localhost:7431/issues/issue-test',
        iconUrl: 'https://example.test/raccoon.png',
        subtitle: 'Run run-test-2',
      },
    ]);
  });

  it('creates the run attachment without an icon when none is configured', async () => {
    const f = fixture();
    const { iconUrl: _iconUrl, ...options } = f.options;

    await new LinearRunMirror(options).start();

    expect([...f.attachments.values()][0]).toMatchObject({
      issueId: 'issue-test',
      title: 'Rocky',
      url: 'http://localhost:7431/issues/issue-test',
    });
    expect([...f.attachments.values()][0]).not.toHaveProperty('iconUrl');
  });

  it('coalesces status and persists post/settle actions with summaries and local Transcript links', async () => {
    const f = fixture();
    const mirror = new LinearRunMirror(f.options);
    await mirror.start();
    mirror.status({ stepId: '1', title: 'Implement', summary: 'Starting' });
    mirror.status({
      stepId: '1',
      title: 'Implement',
      summary: 'Checking changes',
    });
    await mirror.flushStatus();
    await mirror.post('plan', 'Implement the requested change.');
    await mirror.settle({
      stepId: '1',
      title: 'Implement',
      outcome: 'completed',
      summary: 'Added validation.',
    });
    await new LinearRunMirror(f.options).settle({
      stepId: '1',
      title: 'Different',
      outcome: 'failed',
      summary: 'Changed on replay',
    });
    expect(f.activities.map((activity) => activity.content)).toEqual([
      {
        type: 'action',
        action: 'Implement',
        parameter: 'Step 1',
        result: 'Checking changes',
      },
      {
        type: 'action',
        action: 'Post',
        parameter: 'Run run-test-1',
        result: 'Implement the requested change.',
      },
      {
        type: 'action',
        action: 'Implement',
        parameter: 'Step 1: completed',
        result:
          'Added validation.\n\n[Transcript](http://localhost:7431/runs/run-test-1/steps/1)',
      },
    ]);
    expect(f.activities.map((activity) => activity.ephemeral)).toEqual([
      true,
      false,
      false,
    ]);
    expect(f.comments).toHaveLength(1);
  });

  it('sends an ephemeral status without requiring durable readback', async () => {
    const f = fixture();
    f.client.ensureActivity = async (input) => {
      if (input.ephemeral)
        throw new Error('ephemeral activity disappeared before readback');
      return { id: input.id, success: true };
    };
    const mirror = new LinearRunMirror(f.options);

    mirror.status({ stepId: '1', title: 'Implement', summary: 'Working' });
    await mirror.flushStatus();

    expect(f.activities).toHaveLength(1);
    expect(f.activities[0]?.ephemeral).toBe(true);
    expect(f.calls).toContain('postActivity:product');
  });

  it('reconciles an ambiguous activity with its persisted UUID and original payload after restart', async () => {
    const f = fixture();
    const ensure = f.client.ensureActivity;
    let fail = true;
    f.client.ensureActivity = async (input) => {
      const result = await ensure(input);
      if (fail) {
        fail = false;
        throw new Error('connection lost after create');
      }
      expect(input).toEqual(f.activities[0]);
      return result;
    };
    await expect(
      new LinearRunMirror(f.options).post('note', 'Original note'),
    ).rejects.toThrow('connection lost');
    await new LinearRunMirror(f.options).post('note', 'Different note');
    expect(f.activities).toHaveLength(1);
    expect(f.activities[0].content.result).toBe('Original note');
  });

  it('uses the terminal auto-comment as the only closing comment, including final passing images', async () => {
    const f = fixture();
    const mirror = new LinearRunMirror({
      ...f.options,
      readScreenshot: async (path) => {
        expect(path).toBe('final/home.png');
        return new Uint8Array([1, 2, 3]);
      },
    });
    await mirror.start();
    await mirror.settle({
      stepId: '2',
      title: 'Inspect UI',
      outcome: 'completed',
      summary: 'All Checks passed.',
    });
    const result = await mirror.finish(
      { kind: 'completed' },
      {
        changedSummary: 'Added input validation.',
        pullRequests: [
          { title: 'Validation', url: 'https://example.test/pull/1' },
        ],
        ci: [{ name: 'Tests', status: 'passed' }],
        checks: [
          { id: 'home', verdict: 'ok', note: 'The form accepts valid input.' },
        ],
        finalPassingScreenshots: [
          {
            path: 'final/home.png',
            filename: 'home.png',
            contentType: 'image/png',
          },
        ],
        unresolvedComplaints: [],
      },
    );
    expect(result).toBeUndefined();
    expect(f.comments).toHaveLength(2);
    expect(f.calls.filter((call) => call === 'comment')).toHaveLength(1);
    expect(f.comments[1].body).toContain('Added input validation.');
    expect(f.comments[1].body).toContain(
      '[Validation](https://example.test/pull/1)',
    );
    expect(f.comments[1].body).toContain('Tests: passed');
    expect(f.comments[1].body).toContain('home: ok');
    expect(f.comments[1].body).toContain(
      '![](https://assets.example.test/final.png)',
    );
    expect(f.activities.at(-1)?.content.type).toBe('response');
    await new LinearRunMirror(f.options).finish(
      { kind: 'completed' },
      { changedSummary: 'Different replay' },
    );
    expect(f.comments).toHaveLength(2);
    expect(f.calls.filter((call) => call === 'upload')).toHaveLength(1);
  });

  it('blocks before closing when automatic elicitation would make a third comment', async () => {
    const f = fixture();
    const mirror = new LinearRunMirror(f.options);
    await mirror.start();
    // Actual platform artifact, not a second explicit Rocky comment.
    f.comments.push({
      id: randomUUID(),
      body: 'Approve this work?',
      sessionId: 'session-test',
      issueId: 'issue-test',
      userId: null,
      parentId: null,
      createdAt: '2026-01-01T00:00:01Z',
    });
    const before = f.activities.length;
    await expect(
      mirror.finish({ kind: 'completed' }, { changedSummary: 'Ready.' }),
    ).rejects.toThrow(/spec\/API gate.*third comment/i);
    expect(f.comments).toHaveLength(2);
    expect(f.activities).toHaveLength(before);
    expect(f.calls).not.toContain('upload');
  });

  it('does not let a pre-existing session-associated comment block a fresh run', async () => {
    const f = fixture();
    // Linear can retain an old activity even after it is hidden/deleted in the
    // issue UI. It was present before this mirror recorded its baseline.
    f.comments.push({
      id: randomUUID(),
      body: 'Historical platform activity',
      sessionId: 'session-test',
      issueId: 'issue-test',
      userId: null,
      parentId: null,
      createdAt: '2026-01-01T00:00:00Z',
    });
    const mirror = new LinearRunMirror(f.options);

    await mirror.start();
    await mirror.finish({ kind: 'completed' }, { changedSummary: 'Ready.' });

    expect(f.comments).toHaveLength(3);
    expect(f.comments.at(-1)?.body).toContain('Ready.');
  });

  it('refuses an elicitation known to auto-comment and rejects unqualified platform behavior', async () => {
    const f = fixture();
    const mirror = new LinearRunMirror({
      ...f.options,
      platform: { ...f.options.platform, elicitationComments: 'one' },
    });
    await mirror.start();
    await expect(mirror.beforeElicitation()).rejects.toThrow(
      /spec\/API gate.*third comment/i,
    );
    expect(f.comments).toHaveLength(1);
    expect(
      () =>
        new LinearRunMirror({
          ...f.options,
          platform: { ...f.options.platform, evidence: '' },
        }),
    ).toThrow(/qualify/);
  });

  it('never repairs a missing auto-comment by adding an explicit closing comment', async () => {
    const f = fixture();
    const ensure = f.client.ensureActivity;
    f.client.ensureActivity = async (input) => {
      const result = await ensure(input);
      if (input.content.type === 'response') f.comments.pop();
      return result;
    };
    const mirror = new LinearRunMirror(f.options);
    await mirror.start();
    await expect(
      mirror.finish({ kind: 'rejected' }, { changedSummary: 'Work retained.' }),
    ).rejects.toThrow(/spec\/API gate/);
    expect(f.comments).toHaveLength(1);
    expect(f.activities.at(-1)?.content.type).toBe('response');
  });

  it('is silent while Parked across restart and drops pending ephemeral updates', async () => {
    const f = fixture();
    const mirror = new LinearRunMirror(f.options);
    await mirror.start();
    mirror.status({ stepId: '3', title: 'Review', summary: 'Working' });
    await mirror.setParked(true);
    const before = [...f.calls];
    await mirror.flushStatus();
    await expect(
      new LinearRunMirror(f.options).post('parked', 'Must not send'),
    ).rejects.toThrow(/Parked/);
    await expect(mirror.start()).rejects.toThrow(/Parked/);
    expect(f.calls).toEqual(before);
    await mirror.setParked(false);
    await mirror.post('resumed', 'Continuing');
    expect(f.activities).toHaveLength(1);
  });

  it('stop fences an in-flight upload continuation, queued effects and restarts except final cancellation', async () => {
    const f = fixture();
    let release!: () => void;
    let entered!: () => void;
    const uploading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.client.uploadFile = async () => {
      f.calls.push('upload');
      entered();
      await wait;
      return { assetUrl: 'https://assets.example.test/orphan.png' };
    };
    const mirror = new LinearRunMirror({
      ...f.options,
      readScreenshot: async () => new Uint8Array([1]),
    });
    await mirror.start();
    const finishing = mirror.finish(
      { kind: 'completed' },
      {
        changedSummary: 'Ready',
        checks: [{ id: 'home', verdict: 'ok', note: 'Passed' }],
        finalPassingScreenshots: [
          {
            path: 'final.png',
            filename: 'final.png',
            contentType: 'image/png',
          },
        ],
      },
    );
    await uploading;
    const stopped = mirror.stop();
    const callsAtStop = [...f.calls];
    release();
    await expect(finishing).rejects.toThrow(/stopped/);
    await stopped;
    await expect(
      new LinearRunMirror(f.options).post('late', 'Too late'),
    ).rejects.toThrow(/stopped/);
    expect(f.calls).toEqual(callsAtStop);
    await new LinearRunMirror(f.options).finish(
      { kind: 'cancelled' },
      { changedSummary: 'Work retained.' },
    );
    expect(f.comments).toHaveLength(2);
    expect(f.comments[1].body).toContain('cancelled');
    expect(f.comments[1].body).not.toContain('orphan.png');
  });

  it('rejects non-passing screenshots before reading or uploading them', async () => {
    const f = fixture();
    const mirror = new LinearRunMirror({
      ...f.options,
      readScreenshot: async () => {
        throw new Error('must not read');
      },
    });
    await mirror.start();
    await expect(
      mirror.finish(
        { kind: 'giveUp' },
        {
          changedSummary: 'Cap burned',
          checks: [{ id: 'home', verdict: 'problem', note: 'Broken' }],
          finalPassingScreenshots: [
            {
              path: 'failed.png',
              filename: 'failed.png',
              contentType: 'image/png',
            },
          ],
        },
      ),
    ).rejects.toThrow(/final passing sweep/);
    expect(f.calls).not.toContain('upload');
  });

  it('delegates exact team-state validation and preserves the selected state on replay', async () => {
    const f = fixture();
    const selected: string[] = [];
    f.client.setIssueState = async (issue, team, name) => {
      expect([issue, team]).toEqual(['issue-test', 'team-test']);
      if (name.toLowerCase() !== 'in review')
        throw new Error(
          'Unknown state. This team has: Todo, In Progress, In Review',
        );
      selected.push(name);
      return { id: issue, success: true };
    };
    await expect(
      new LinearRunMirror(f.options).setState('state-step', 'In Reviw'),
    ).rejects.toThrow('Todo, In Progress, In Review');
    await new LinearRunMirror(f.options).setState(
      'valid-state-step',
      'in review',
    );
    await new LinearRunMirror(f.options).setState('valid-state-step', 'Todo');
    expect(selected).toEqual(['in review']);
  });

  it.each([
    { kind: 'rejected' as const, type: 'response' },
    { kind: 'cancelled' as const, type: 'response' },
    { kind: 'giveUp' as const, type: 'response' },
    {
      kind: 'failed' as const,
      stepId: 'build',
      reason: 'Compiler failed',
      type: 'error',
    },
  ])(
    'closes $kind with the correct terminal semantics and unresolved Complaints',
    async ({ type, ...outcome }) => {
      const f = fixture();
      const mirror = new LinearRunMirror(f.options);
      await mirror.start();
      await mirror.finish(outcome, {
        changedSummary: 'Work retained on the branch.',
        unresolvedComplaints: [
          {
            id: 'complaint-1',
            file: 'src/form.ts',
            line: 12,
            description: 'Validation still fails.',
          },
        ],
      });
      expect(f.activities.at(-1)?.content.type).toBe(type);
      expect(f.comments).toHaveLength(2);
      expect(f.comments[1].body).toContain(
        'complaint-1 (src/form.ts:12): Validation still fails.',
      );
      if (outcome.kind === 'failed')
        expect(f.comments[1].body).toContain('Step build: Compiler failed');
      await expect(mirror.post('after-close', 'Do not reopen')).rejects.toThrow(
        /terminal/,
      );
    },
  );

  it('does not duplicate an automatic closing comment after an ambiguous terminal failure', async () => {
    const f = fixture();
    const mirror = new LinearRunMirror(f.options);
    await mirror.start();
    const ensure = f.client.ensureActivity;
    let fail = true;
    f.client.ensureActivity = async (input) => {
      const result = await ensure(input);
      if (fail) {
        fail = false;
        throw new Error('terminal reply lost');
      }
      return result;
    };
    await expect(
      mirror.finish({ kind: 'completed' }, { changedSummary: 'Original' }),
    ).rejects.toThrow('terminal reply lost');
    await new LinearRunMirror(f.options).finish(
      { kind: 'failed', stepId: 'wrong', reason: 'New data' },
      { changedSummary: 'Changed' },
    );
    expect(f.comments).toHaveLength(2);
    expect(f.comments[1].body).toContain('Original');
    expect(f.comments[1].body).not.toContain('New data');
    expect(f.activities).toHaveLength(1);
  });

  it('does not touch Linear when intent persistence fails', async () => {
    const f = fixture();
    f.store.put = async () => {
      throw new Error('Journal unavailable');
    };
    await expect(
      new LinearRunMirror(f.options).post('note', 'Must persist first'),
    ).rejects.toThrow('Journal unavailable');
    await expect(new LinearRunMirror(f.options).start()).rejects.toThrow(
      'Journal unavailable',
    );
    expect(f.calls).toEqual([]);
  });

  it('keeps the original terminal identity after stop and reports duplicate-ID ambiguity without readback', async () => {
    const f = fixture();
    const mirror = new LinearRunMirror(f.options);
    await mirror.start();
    const ensure = f.client.ensureActivity;
    let hidden: (typeof f.comments)[number] | undefined;
    let fail = true;
    f.client.ensureActivity = async (input) => {
      const result = await ensure(input);
      if (fail) {
        fail = false;
        hidden = f.comments.pop();
        throw new Error('reply lost; comment still propagating');
      }
      if (hidden) {
        f.comments.push(hidden);
        hidden = undefined;
      }
      return result;
    };
    await expect(
      mirror.finish(
        { kind: 'completed' },
        { changedSummary: 'Completed original work.' },
      ),
    ).rejects.toThrow('reply lost');
    await mirror.stop();
    const before = f.calls.length;
    f.productAbort.abort();
    await expect(
      new LinearRunMirror(f.options).finish(
        { kind: 'cancelled' },
        { changedSummary: 'Later stop' },
      ),
    ).rejects.toThrow(/unverified/);
    expect(f.calls.slice(before)).toEqual(['postActivity:final']);
    expect(f.finalPosts).toEqual([f.activities[0]]);
    expect(f.activities).toHaveLength(1);
    if (hidden) f.comments.push(hidden);
    expect(f.comments).toHaveLength(2);
    expect(f.comments[1].body).toContain('Completed original work.');
  });

  it('makes only one raw final-response call after stop, even when the product client is aborted', async () => {
    const f = fixture();
    const mirror = new LinearRunMirror(f.options);
    await mirror.start();
    await mirror.stop();
    f.productAbort.abort();
    const before = f.calls.length;
    await expect(mirror.post('late', 'No')).rejects.toThrow(/stopped/);
    await expect(mirror.setState('late', 'Done')).rejects.toThrow(/stopped/);
    await expect(mirror.beforeElicitation()).rejects.toThrow(/stopped/);
    await expect(mirror.start()).rejects.toThrow(/stopped/);
    await new LinearRunMirror(f.options).finish(
      { kind: 'cancelled' },
      { changedSummary: 'Work retained' },
    );
    await new LinearRunMirror(f.options).finish(
      { kind: 'cancelled' },
      { changedSummary: 'Changed' },
    );
    expect(f.calls.slice(before)).toEqual(['postActivity:final']);
    expect(f.comments).toHaveLength(2);
    expect(f.activities[0].content.type).toBe('response');
  });

  it('requires an explicit final-response-only transport after stop', async () => {
    const f = fixture();
    const mirror = new LinearRunMirror({
      ...f.options,
      finalResponse: undefined,
    });
    await mirror.start();
    await mirror.stop();
    const before = f.calls.length;
    await expect(
      mirror.finish({ kind: 'cancelled' }, { changedSummary: 'Stopped' }),
    ).rejects.toThrow(/final-response-only transport/);
    expect(f.calls.slice(before)).toEqual([]);
  });

  it('only retries a failed strict-stop response when explicitly asked, preserving the frozen payload', async () => {
    const f = fixture();
    const mirror = new LinearRunMirror(f.options);
    await mirror.start();
    await mirror.stop();
    const raw = f.finalResponse.postActivity;
    const attempts: Parameters<typeof raw>[0][] = [];
    let fail = true;
    f.finalResponse.postActivity = async (input) => {
      attempts.push(structuredClone(input));
      if (fail) {
        fail = false;
        f.calls.push('postActivity:final');
        throw new Error('connection lost before reply');
      }
      return raw(input);
    };
    const before = f.calls.length;
    await expect(
      mirror.finish(
        { kind: 'failed', stepId: 'build', reason: 'Build stopped' },
        { changedSummary: 'Original' },
      ),
    ).rejects.toThrow(/unverified/);
    expect(f.calls.slice(before)).toEqual(['postActivity:final']);
    await new LinearRunMirror(f.options).finish(
      { kind: 'cancelled' },
      { changedSummary: 'Changed' },
    );
    expect(f.calls.slice(before)).toEqual([
      'postActivity:final',
      'postActivity:final',
    ]);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(f.activities[0].content.type).toBe('error');
    expect(f.comments).toHaveLength(2);
  });

  it('does not bypass a known third-comment gate after stop', async () => {
    const f = fixture();
    const mirror = new LinearRunMirror(f.options);
    await mirror.start();
    f.comments.push({
      ...f.comments[0],
      id: randomUUID(),
      sessionId: 'session-test',
      body: 'Automatic elicitation',
    });
    await expect(
      mirror.finish({ kind: 'completed' }, { changedSummary: 'Ready' }),
    ).rejects.toThrow(/third comment/);
    await mirror.stop();
    const before = f.calls.length;
    await expect(
      new LinearRunMirror(f.options).finish(
        { kind: 'cancelled' },
        { changedSummary: 'Stopped' },
      ),
    ).rejects.toThrow(/comment budget/);
    expect(f.calls.slice(before)).toEqual([]);
    expect(f.comments).toHaveLength(2);
  });

  it('journals screenshot path/metadata/hash, never bytes, and refuses changed local bytes on replay', async () => {
    const f = fixture();
    let bytes = new Uint8Array([97, 98, 99]);
    const reads: string[] = [];
    const options = {
      ...f.options,
      readScreenshot: async (path: string) => {
        reads.push(path);
        return bytes;
      },
    };
    const presentation = {
      changedSummary: 'Ready',
      checks: [{ id: 'home', verdict: 'ok' as const, note: 'Passed' }],
      finalPassingScreenshots: [
        {
          path: 'final/home.png',
          filename: 'home.png',
          contentType: 'image/png',
        },
      ],
    };
    const mirror = new LinearRunMirror(options);
    await mirror.start();
    let fail = true;
    f.client.uploadFile = async (input) => {
      f.calls.push('upload');
      expect(input).toEqual({
        filename: 'home.png',
        contentType: 'image/png',
        data: new Uint8Array([97, 98, 99]),
      });
      const persisted = JSON.stringify([...f.records.values()]);
      expect(persisted).toContain(
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      );
      expect(persisted).not.toContain('YWJj');
      expect(persisted).not.toContain('[97,98,99]');
      if (fail) {
        fail = false;
        throw new Error('upload reply lost');
      }
      return { assetUrl: 'https://assets.example.test/home.png' };
    };
    await expect(
      mirror.finish({ kind: 'completed' }, presentation),
    ).rejects.toThrow('upload reply lost');
    bytes = new Uint8Array([100]);
    await expect(
      new LinearRunMirror(options).finish(
        { kind: 'completed' },
        { changedSummary: 'Changed' },
      ),
    ).rejects.toThrow(/screenshot.*changed/i);
    expect(f.calls.filter((call) => call === 'upload')).toHaveLength(1);
    bytes = new Uint8Array([97, 98, 99]);
    await new LinearRunMirror(options).finish(
      { kind: 'completed' },
      { changedSummary: 'Changed' },
    );
    expect(reads).toEqual([
      'final/home.png',
      'final/home.png',
      'final/home.png',
    ]);
    expect(f.comments).toHaveLength(2);
  });

  it('fences working emissions when cancellation auto-comment verification must be retried', async () => {
    const f = fixture();
    const mirror = new LinearRunMirror(f.options);
    await mirror.start();
    const ensure = f.client.ensureActivity;
    f.client.ensureActivity = async (input) => {
      const result = await ensure(input);
      f.comments.pop();
      return result;
    };
    await expect(
      mirror.finish({ kind: 'cancelled' }, { changedSummary: 'Work retained' }),
    ).rejects.toThrow(/spec\/API gate/);
    const before = [...f.calls];
    await expect(
      new LinearRunMirror(f.options).post('late', 'Must not reopen'),
    ).rejects.toThrow(/stopped|terminal|closing/);
    expect(f.calls).toEqual(before);
  });

  it('does not retain a local Parked fence when parking a closing Run is rejected', async () => {
    const f = fixture();
    const mirror = new LinearRunMirror(f.options);
    await mirror.start();
    const ensure = f.client.ensureActivity;
    let hidden: (typeof f.comments)[number] | undefined;
    f.client.ensureActivity = async (input) => {
      const result = await ensure(input);
      hidden = f.comments.pop();
      return result;
    };
    await expect(
      mirror.finish({ kind: 'completed' }, { changedSummary: 'Ready' }),
    ).rejects.toThrow(/spec\/API gate/);
    await expect(mirror.setParked(true)).rejects.toThrow(/terminal/);
    if (hidden) f.comments.push(hidden);
    await mirror.finish({ kind: 'completed' }, { changedSummary: 'Ready' });
    expect(f.comments).toHaveLength(2);
  });
});

it('posts scope and report comments once, survives an ambiguous response and preserves the terminal comment budget', async () => {
  const f = fixture();
  const mirror = new LinearRunMirror(f.options);
  await mirror.start();
  const ensure = f.options.client.ensureComment;
  f.options.client.ensureComment = async (input) => {
    await ensure(input);
    return { id: input.id, success: false };
  };
  await expect(
    mirror.comment('scope', '## Agreed scope\n\nKeep existing behavior.'),
  ).rejects.toThrow('did not confirm');
  f.options.client.ensureComment = ensure;
  const restarted = new LinearRunMirror(f.options);
  await restarted.comment(
    'scope',
    '## Agreed scope\n\nKeep existing behavior.',
  );
  await restarted.comment(
    'scope',
    '## Agreed scope\n\nKeep existing behavior.',
  );
  await restarted.comment(
    'report',
    '## Visual report\n\nThe behavior is unchanged.',
  );
  expect(
    f.comments.filter((c) => c.body.includes('Agreed scope')),
  ).toHaveLength(1);
  await restarted.finish(
    { kind: 'completed' },
    { changedSummary: 'Preserved behavior.' },
  );
  expect(f.comments).toHaveLength(4);
});
