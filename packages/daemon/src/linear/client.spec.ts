/**
 * The Linear API client the later tickets build on: activities, comments,
 * attachments, issue state reads and `fileUpload` (NG-600).
 *
 * The SDK sits behind a narrow seam — `LinearSdkLike` — so these drive the
 * client's own behaviour (token refresh, the caller-supplied id, the presigned
 * PUT) rather than re-testing Linear's SDK.
 */
import { describe, expect, it, vi } from 'vitest';

import { RockyLinearClient } from './client.js';
import type { LinearSdkLike } from './client.js';

function fakeSdk(overrides: Partial<LinearSdkLike> = {}): LinearSdkLike {
  return {
    updateSession: vi.fn(async () => ({ success: true })),
    attachments: vi.fn(async () => ({
      nodes: [],
      pageInfo: { hasNextPage: false },
    })),
    updateAttachment: vi.fn(async () => ({ success: true })),
    comment: vi.fn(async () => null),
    comments: vi.fn(async () => ({
      nodes: [],
      pageInfo: { hasNextPage: false },
    })),
    activity: vi.fn(async () => null),
    activities: vi.fn(async () => ({
      nodes: [],
      pageInfo: { hasNextPage: false },
    })),
    session: vi.fn(async () => ({
      id: 'sess-1',
      issueId: 'issue-1',
      appUserId: 'app-user',
      dismissedAt: null,
      delegateId: 'app-user',
      status: 'active',
    })),
    createAgentActivity: vi.fn(async () => ({ success: true })),
    createComment: vi.fn(async () => ({ success: true })),
    createAttachment: vi.fn(async () => ({ success: true, id: 'actual-id' })),
    workflowStates: vi.fn(async () => ({
      nodes: [],
      pageInfo: { hasNextPage: false },
    })),
    updateIssue: vi.fn(async () => ({ success: true })),
    fileUpload: vi.fn(async () => ({ success: true, uploadFile: null })),
    viewer: Promise.resolve({ id: 'app-user', name: 'Rocky (Jan Jaap)' }),
    ...overrides,
  };
}

/** A client whose token never needs refreshing. */
function clientWith(sdk: LinearSdkLike, deps: Record<string, unknown> = {}) {
  return new RockyLinearClient({
    auth: async () => ({
      clientId: 'cid',
      clientSecret: 'csec',
      redirectUri: 'https://rocky.example.com/api/linear/oauth/callback',
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: undefined,
    }),
    save: vi.fn(async () => undefined),
    createSdk: () => sdk,
    ...deps,
  });
}

describe('activities', () => {
  it('verifies JSON-equivalent optional fields rather than rejecting omitted undefined values', async () => {
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const row = {
      id,
      sessionId: 'sess-1',
      createdAt: '2026-09-07T00:00:00.000Z',
      content: { type: 'action', action: 'Checked', parameter: 'Step 1' },
      ephemeral: false,
      signalMetadata: { options: [] },
    };
    const sdk = fakeSdk({ activity: vi.fn(async () => row) });
    expect(
      await clientWith(sdk).ensureActivity({
        id,
        sessionId: 'sess-1',
        content: { ...row.content, result: undefined },
        signalMetadata: { options: [], unused: undefined },
      }),
    ).toEqual({ id, success: true });
    expect(sdk.createAgentActivity).not.toHaveBeenCalled();
  });
  it('never treats a duplicate-ID error or unverified success as completion', async () => {
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const sdk = fakeSdk({
      createAgentActivity: vi.fn(async () => {
        throw new Error('duplicate ID');
      }),
    });
    const client = clientWith(sdk);
    await expect(
      client.ensureActivity({
        id,
        sessionId: 'sess-1',
        content: { type: 'thought', body: 'Working' },
      }),
    ).rejects.toThrow(/duplicate ID/);
    sdk.createAgentActivity = vi.fn(async () => ({ success: true }));
    await expect(
      client.ensureActivity({
        id,
        sessionId: 'sess-1',
        content: { type: 'thought', body: 'Working' },
      }),
    ).rejects.toThrow(/could not be verified/);
  });

  it('rejects non-UUID effect IDs before any read or write', async () => {
    const sdk = fakeSdk();
    const client = clientWith(sdk);
    await expect(
      client.ensureActivity({
        id: 'not-a-uuid',
        sessionId: 'sess-1',
        content: { type: 'thought', body: 'Working' },
      }),
    ).rejects.toThrow(/UUID-v4/);
    await expect(
      client.ensureComment({
        id: 'not-a-uuid',
        issueId: 'issue-1',
        body: 'Start',
      }),
    ).rejects.toThrow(/UUID-v4/);
    expect(sdk.activity).not.toHaveBeenCalled();
    expect(sdk.comment).not.toHaveBeenCalled();
  });

  it('refuses to verify ephemeral activities that Linear may already have replaced', async () => {
    const sdk = fakeSdk();
    await expect(
      clientWith(sdk).ensureActivity({
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        sessionId: 'sess-1',
        ephemeral: true,
        content: {
          type: 'action',
          action: 'Working',
          parameter: 'Step 1',
        },
      }),
    ).rejects.toThrow(/ephemeral.*postActivity/i);
    expect(sdk.activity).not.toHaveBeenCalled();
    expect(sdk.createAgentActivity).not.toHaveBeenCalled();
  });

  it('refuses a looping pagination cursor instead of returning partial recovery', async () => {
    const sdk = fakeSdk({
      activities: vi.fn(async () => ({
        nodes: [],
        pageInfo: { hasNextPage: true, endCursor: 'stuck' },
      })),
    });
    await expect(clientWith(sdk).activities('sess-1')).rejects.toThrow(
      /pagination did not advance/,
    );
    expect(sdk.activities).toHaveBeenCalledTimes(2);
  });
  it('acknowledges a session using public externalUrls without altering localhost or emitting an activity', async () => {
    const sdk = fakeSdk();
    expect(
      await clientWith(sdk).acknowledgeSession(
        'sess-1',
        'http://localhost:7625/runs/run-1',
      ),
    ).toEqual({ id: 'sess-1', success: true });
    expect(sdk.updateSession).toHaveBeenCalledWith('sess-1', {
      externalUrls: [
        { label: 'Rocky', url: 'http://localhost:7625/runs/run-1' },
      ],
    });
    expect(sdk.createAgentActivity).not.toHaveBeenCalled();
  });
  it('refuses an invented action body instead of sending invalid action content', async () => {
    const sdk = fakeSdk();
    await expect(
      clientWith(sdk).postActivity({
        sessionId: 'sess-1',
        content: { type: 'action', body: 'Done' },
      }),
    ).rejects.toThrow(/action.*parameter/i);
    expect(sdk.createAgentActivity).not.toHaveBeenCalled();
  });
  it('recovers an ambiguously created activity only after verifying its identity and payload', async () => {
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const content = {
      type: 'action',
      action: 'Checked',
      parameter: 'Step 1',
      result: 'Passed',
    };
    const row = {
      id,
      sessionId: 'sess-1',
      content,
      ephemeral: false,
      createdAt: '2026-09-07T00:00:00.000Z',
    };
    const activity = vi.fn().mockResolvedValueOnce(null).mockResolvedValue(row);
    const createAgentActivity = vi.fn(async () => {
      throw new Error('connection lost');
    });
    const client = clientWith(fakeSdk({ activity, createAgentActivity }));
    expect(
      await client.ensureActivity({ id, sessionId: 'sess-1', content }),
    ).toEqual({ id, success: true });
    expect(
      await client.ensureActivity({ id, sessionId: 'sess-1', content }),
    ).toEqual({ id, success: true });
    expect(createAgentActivity).toHaveBeenCalledTimes(1);
    await expect(
      client.ensureActivity({ id, sessionId: 'other-session', content }),
    ).rejects.toThrow(/mismatch/i);
  });
  it('reads every page with a one-second overlap, dedupes IDs and sorts by time then ID', async () => {
    const a = {
      id: 'a',
      sessionId: 'sess-1',
      createdAt: '2026-09-07T00:00:01.000Z',
      content: { type: 'prompt', body: 'first' },
      ephemeral: false,
    };
    const b = {
      ...a,
      id: 'b',
      content: { type: 'prompt', body: 'second' },
      signal: 'stop' as const,
    };
    const activities = vi
      .fn()
      .mockResolvedValueOnce({
        nodes: [b],
        pageInfo: { hasNextPage: true, endCursor: 'page2' },
      })
      .mockResolvedValueOnce({
        nodes: [b, a],
        pageInfo: { hasNextPage: false },
      });
    expect(
      await clientWith(fakeSdk({ activities })).activities('sess-1', {
        since: '2026-09-07T00:00:02.000Z',
      }),
    ).toEqual([a, b]);
    expect(activities.mock.calls).toEqual([
      ['sess-1', { since: '2026-09-07T00:00:01.000Z' }],
      ['sess-1', { since: '2026-09-07T00:00:01.000Z', after: 'page2' }],
    ]);
  });
  it('reads the known session and retains dismissal, owner and delegate identity', async () => {
    const summary = {
      id: 'sess-1',
      issueId: 'issue-1',
      appUserId: 'app-user',
      delegateId: null,
      dismissedAt: '2026-09-07T00:00:00.000Z',
      status: 'complete',
    };
    const client = clientWith(fakeSdk({ session: vi.fn(async () => summary) }));
    expect(await client.session('sess-1')).toEqual(summary);
  });
  it('posts one and returns the id it chose, so no second call is needed', async () => {
    const sdk = fakeSdk();
    const client = clientWith(sdk);

    const result = await client.postActivity({
      sessionId: 'sess-1',
      content: { type: 'thought', body: 'Looking at the ticket' },
      ephemeral: true,
    });

    expect(result.success).toBe(true);
    expect(result.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(sdk.createAgentActivity).toHaveBeenCalledWith({
      id: result.id,
      agentSessionId: 'sess-1',
      content: { type: 'thought', body: 'Looking at the ticket' },
      ephemeral: true,
    });
  });

  it('honours a caller-supplied id, which is what makes a replayed Step idempotent', async () => {
    const sdk = fakeSdk();
    const client = clientWith(sdk);

    await client.postActivity({
      sessionId: 'sess-1',
      content: { type: 'thought', body: 'x' },
      id: 'fixed-id',
    });

    expect(sdk.createAgentActivity).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'fixed-id' }),
    );
  });

  it('refuses an empty body, which Linear accepts and renders as a blank bubble', async () => {
    const sdk = fakeSdk();
    const client = clientWith(sdk);

    await expect(
      client.postActivity({
        sessionId: 'sess-1',
        content: { type: 'thought', body: '   ' },
      }),
    ).rejects.toThrow(/empty/i);
    expect(sdk.createAgentActivity).not.toHaveBeenCalled();
  });

  it('carries a signal and its metadata through untouched', async () => {
    const sdk = fakeSdk();
    const client = clientWith(sdk);

    await client.postActivity({
      sessionId: 'sess-1',
      content: { type: 'elicitation', body: 'Approve?' },
      signal: 'select',
      signalMetadata: { options: [{ label: 'Approve', value: 'approve' }] },
    });

    expect(sdk.createAgentActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        signal: 'select',
        signalMetadata: { options: [{ label: 'Approve', value: 'approve' }] },
      }),
    );
  });
});

describe('comments and attachments', () => {
  it('dedupes an attachment repeated across pages before validating identity', async () => {
    const row = {
      id: 'actual',
      issueId: 'issue-1',
      url: 'http://localhost:7625/issues/issue-1',
    };
    const attachments = vi
      .fn()
      .mockResolvedValueOnce({
        nodes: [row],
        pageInfo: { hasNextPage: true, endCursor: 'next' },
      })
      .mockResolvedValueOnce({
        nodes: [row],
        pageInfo: { hasNextPage: false },
      });
    const sdk = fakeSdk({ attachments });
    expect(
      await clientWith(sdk).maintainAttachment({
        issueId: row.issueId,
        url: row.url,
        title: 'Rocky',
      }),
    ).toEqual({ id: 'actual', success: true });
    expect(sdk.createAttachment).not.toHaveBeenCalled();
  });
  it('maintains one attachment by issue and stable URL across Runs, using the actual ID', async () => {
    const url = 'http://localhost:7625/issues/issue-1';
    const row = { id: 'actual-id', issueId: 'issue-1', url };
    const attachments = vi
      .fn()
      .mockResolvedValueOnce({ nodes: [], pageInfo: { hasNextPage: false } })
      .mockResolvedValue({ nodes: [row], pageInfo: { hasNextPage: false } });
    const sdk = fakeSdk({ attachments });
    const client = clientWith(sdk);
    expect(
      await client.maintainAttachment({
        issueId: 'issue-1',
        title: 'Rocky',
        url,
        subtitle: 'Run 1',
      }),
    ).toEqual({ id: 'actual-id', success: true });
    expect(
      await client.maintainAttachment({
        issueId: 'issue-1',
        title: 'Rocky',
        url,
        subtitle: 'Run 2',
        iconUrl: 'https://example.com/icon.png',
      }),
    ).toEqual({ id: 'actual-id', success: true });
    expect(sdk.createAttachment).toHaveBeenCalledTimes(1);
    expect(sdk.updateAttachment).toHaveBeenLastCalledWith('actual-id', {
      title: 'Rocky',
      subtitle: 'Run 2',
      iconUrl: 'https://example.com/icon.png',
    });
  });
  it('finds or creates a comment and verifies an ambiguous result, exposing automatic comment associations', async () => {
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const row = {
      id,
      issueId: 'issue-1',
      body: 'Run started',
      createdAt: '2026-09-07T00:00:00.000Z',
      sessionId: 'sess-1',
      userId: 'app-user',
      parentId: null,
    };
    const comment = vi.fn().mockResolvedValueOnce(null).mockResolvedValue(row);
    const createComment = vi.fn(async () => {
      throw new Error('lost response');
    });
    const comments = vi
      .fn()
      .mockResolvedValueOnce({
        nodes: [],
        pageInfo: { hasNextPage: true, endCursor: 'next' },
      })
      .mockResolvedValueOnce({
        nodes: [row],
        pageInfo: { hasNextPage: false },
      });
    const client = clientWith(fakeSdk({ comment, createComment, comments }));
    expect(
      await client.ensureComment({
        id,
        issueId: 'issue-1',
        body: 'Run started',
      }),
    ).toEqual({ id, success: true });
    expect(await client.comments('issue-1')).toEqual([row]);
    await expect(
      client.ensureComment({ id, issueId: 'issue-1', body: 'Different' }),
    ).rejects.toThrow(/mismatch/);
    expect(createComment).toHaveBeenCalledTimes(1);
  });
  it('posts a comment, optionally as a reply in one thread', async () => {
    const sdk = fakeSdk();
    const client = clientWith(sdk);

    await client.postComment({
      issueId: 'issue-1',
      body: 'Run started',
      parentId: 'comment-root',
    });

    expect(sdk.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        issueId: 'issue-1',
        body: 'Run started',
        parentId: 'comment-root',
      }),
    );
  });

  it('creates an attachment keyed by url, which is how it is updated in place', async () => {
    const sdk = fakeSdk();
    const client = clientWith(sdk);

    await client.createAttachment({
      issueId: 'issue-1',
      title: 'Rocky',
      url: 'http://127.0.0.1:7625/runs/NG-600-1',
    });

    expect(sdk.createAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        issueId: 'issue-1',
        url: 'http://127.0.0.1:7625/runs/NG-600-1',
      }),
    );
  });
});

describe('issue state reads', () => {
  it('sets an exact case-insensitive state from a later page and lists all names on a typo', async () => {
    const workflowStates = vi.fn(async (variables) =>
      variables?.after
        ? {
            nodes: [
              { id: 'review', name: 'In Review', type: 'started', position: 2 },
            ],
            pageInfo: { hasNextPage: false },
          }
        : {
            nodes: [
              { id: 'todo', name: 'Todo', type: 'unstarted', position: 1 },
            ],
            pageInfo: { hasNextPage: true, endCursor: 'next' },
          },
    );
    const sdk = fakeSdk({ workflowStates });
    const client = clientWith(sdk);
    expect(
      await client.setIssueState('issue-1', 'team-1', 'in review'),
    ).toEqual({ id: 'issue-1', success: true });
    expect(sdk.updateIssue).toHaveBeenCalledWith('issue-1', {
      stateId: 'review',
    });
    await expect(
      client.setIssueState('issue-1', 'team-1', 'In Reviw'),
    ).rejects.toThrow(/Todo, In Review/);
    expect(sdk.updateIssue).toHaveBeenCalledTimes(1);
  });
  it('lists a team`s states', async () => {
    const nodes = [
      { id: 's1', name: 'In Progress', type: 'started', position: 1 },
      { id: 's2', name: 'In Review', type: 'started', position: 2 },
    ];
    const sdk = fakeSdk({
      workflowStates: vi.fn(async () => ({
        nodes,
        pageInfo: { hasNextPage: false },
      })),
    });

    expect(await clientWith(sdk).workflowStates('team-1')).toEqual(nodes);
    expect(sdk.workflowStates).toHaveBeenCalledWith({
      filter: { team: { id: { eq: 'team-1' } } },
    });
  });

  it('matches a state name case-insensitively, as NG-578 requires', async () => {
    const nodes = [
      { id: 's2', name: 'In Review', type: 'started', position: 2 },
    ];
    const sdk = fakeSdk({
      workflowStates: vi.fn(async () => ({
        nodes,
        pageInfo: { hasNextPage: false },
      })),
    });

    expect(
      await clientWith(sdk).findWorkflowState('team-1', 'in review'),
    ).toEqual(nodes[0]);
  });

  it('names the team`s actual states when one is unknown, never fuzzy-matching', async () => {
    const nodes = [
      { id: 's1', name: 'In Progress', type: 'started', position: 1 },
      { id: 's2', name: 'In Review', type: 'started', position: 2 },
    ];
    const sdk = fakeSdk({
      workflowStates: vi.fn(async () => ({
        nodes,
        pageInfo: { hasNextPage: false },
      })),
    });

    await expect(
      clientWith(sdk).findWorkflowState('team-1', 'Reviewing'),
    ).rejects.toThrow(/In Progress, In Review/);
  });
});

describe('uploading a file', () => {
  it('asks for a presigned URL, then PUTs the bytes with every header Linear gave', async () => {
    const uploadFile = {
      uploadUrl: 'https://upload.example.com/signed',
      assetUrl: 'https://uploads.linear.app/asset.png',
      headers: [{ key: 'x-amz-acl', value: 'private' }],
    };
    const sdk = fakeSdk({
      fileUpload: vi.fn(async () => ({ success: true, uploadFile })),
    });
    const doFetch = vi.fn(async () => new Response(null, { status: 200 }));

    const data = Buffer.from('png-bytes');
    const result = await clientWith(sdk, {
      fetch: doFetch as unknown as typeof fetch,
    }).uploadFile({
      filename: 'shot.png',
      contentType: 'image/png',
      data,
    });

    expect(result.assetUrl).toBe(uploadFile.assetUrl);
    expect(sdk.fileUpload).toHaveBeenCalledWith(
      'image/png',
      'shot.png',
      data.byteLength,
    );

    const [url, init] = doFetch.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(uploadFile.uploadUrl);
    expect(init.method).toBe('PUT');

    const headers = new Headers(init.headers);
    expect(headers.get('content-type')).toBe('image/png');
    // Linear's upload guide requires this exact value alongside its own headers.
    expect(headers.get('cache-control')).toBe('public, max-age=31536000');
    expect(headers.get('x-amz-acl')).toBe('private');
  });

  it('fails loudly when Linear could not prepare the upload', async () => {
    const sdk = fakeSdk({
      fileUpload: vi.fn(async () => ({ success: false, uploadFile: null })),
    });

    await expect(
      clientWith(sdk).uploadFile({
        filename: 'shot.png',
        contentType: 'image/png',
        data: Buffer.from('x'),
      }),
    ).rejects.toThrow(/could not prepare/i);
  });

  it('fails when the presigned PUT is rejected, rather than returning a dead asset URL', async () => {
    const sdk = fakeSdk({
      fileUpload: vi.fn(async () => ({
        success: true,
        uploadFile: {
          uploadUrl: 'https://upload.example.com/signed',
          assetUrl: 'https://uploads.linear.app/asset.png',
          headers: [],
        },
      })),
    });
    const doFetch = vi.fn(async () => new Response('denied', { status: 403 }));

    await expect(
      clientWith(sdk, { fetch: doFetch as unknown as typeof fetch }).uploadFile(
        {
          filename: 'shot.png',
          contentType: 'image/png',
          data: Buffer.from('x'),
        },
      ),
    ).rejects.toThrow(/403/);
  });
});

describe('the access token', () => {
  it('shares one rotating refresh across concurrent calls until persistence finishes', async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        access_token: 'fresh',
        refresh_token: 'rotated',
        expires_in: 86400,
      }),
    );
    const save = vi.fn(async () => undefined);
    const client = new RockyLinearClient({
      auth: async () => ({
        accessToken: 'old',
        refreshToken: 'rt',
        clientId: 'id',
        clientSecret: 'secret',
        expiresAt: 1,
      }),
      save,
      fetch,
      now: () => 500000,
    });
    expect(
      await Promise.all([
        client.accessToken(),
        client.accessToken(),
        client.accessToken(),
      ]),
    ).toEqual(['fresh', 'fresh', 'fresh']);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(1);
  });
  it('is used as-is while it is still good', async () => {
    const createSdk = vi.fn(() => fakeSdk());
    const save = vi.fn(async () => undefined);

    const client = new RockyLinearClient({
      auth: async () => ({
        clientId: 'cid',
        clientSecret: 'csec',
        redirectUri: 'https://rocky.example.com/api/linear/oauth/callback',
        accessToken: 'good',
        refreshToken: 'rt',
        expiresAt: 10_000_000,
      }),
      save,
      createSdk,
      now: () => 0,
    });

    await client.viewer();

    expect(createSdk).toHaveBeenCalledWith('good');
    expect(save).not.toHaveBeenCalled();
  });

  it('is refreshed and persisted when it has expired, because Linear rotates them', async () => {
    const createSdk = vi.fn(() => fakeSdk());
    const save = vi.fn(async () => undefined);
    const doFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            access_token: 'fresh',
            refresh_token: 'rt2',
            expires_in: 86_400,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );

    const client = new RockyLinearClient({
      auth: async () => ({
        clientId: 'cid',
        clientSecret: 'csec',
        redirectUri: 'https://rocky.example.com/api/linear/oauth/callback',
        accessToken: 'stale',
        refreshToken: 'rt',
        expiresAt: 1_000,
      }),
      save,
      createSdk,
      fetch: doFetch as unknown as typeof fetch,
      now: () => 500_000,
    });

    await client.viewer();

    expect(createSdk).toHaveBeenCalledWith('fresh');
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: 'fresh', refreshToken: 'rt2' }),
    );
  });

  it('says what to run when the machine was never set up', async () => {
    const client = new RockyLinearClient({
      auth: async () => ({}),
      save: vi.fn(async () => undefined),
      createSdk: () => fakeSdk(),
    });

    await expect(client.viewer()).rejects.toThrow(/rocky setup/);
  });
});
