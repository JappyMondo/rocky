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
    createAgentActivity: vi.fn(async () => ({ success: true })),
    createComment: vi.fn(async () => ({ success: true })),
    createAttachment: vi.fn(async () => ({ success: true })),
    workflowStates: vi.fn(async () => ({ nodes: [] })),
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
      redirectUri: 'http://127.0.0.1:7625/api/linear/oauth/callback',
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
  it('lists a team`s states', async () => {
    const nodes = [
      { id: 's1', name: 'In Progress', type: 'started', position: 1 },
      { id: 's2', name: 'In Review', type: 'started', position: 2 },
    ];
    const sdk = fakeSdk({ workflowStates: vi.fn(async () => ({ nodes })) });

    expect(await clientWith(sdk).workflowStates('team-1')).toEqual(nodes);
    expect(sdk.workflowStates).toHaveBeenCalledWith({
      filter: { team: { id: { eq: 'team-1' } } },
    });
  });

  it('matches a state name case-insensitively, as NG-578 requires', async () => {
    const nodes = [
      { id: 's2', name: 'In Review', type: 'started', position: 2 },
    ];
    const sdk = fakeSdk({ workflowStates: vi.fn(async () => ({ nodes })) });

    expect(
      await clientWith(sdk).findWorkflowState('team-1', 'in review'),
    ).toEqual(nodes[0]);
  });

  it('names the team`s actual states when one is unknown, never fuzzy-matching', async () => {
    const nodes = [
      { id: 's1', name: 'In Progress', type: 'started', position: 1 },
      { id: 's2', name: 'In Review', type: 'started', position: 2 },
    ];
    const sdk = fakeSdk({ workflowStates: vi.fn(async () => ({ nodes })) });

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
  it('is used as-is while it is still good', async () => {
    const createSdk = vi.fn(() => fakeSdk());
    const save = vi.fn(async () => undefined);

    const client = new RockyLinearClient({
      auth: async () => ({
        clientId: 'cid',
        clientSecret: 'csec',
        redirectUri: 'http://127.0.0.1:7625/api/linear/oauth/callback',
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
        redirectUri: 'http://127.0.0.1:7625/api/linear/oauth/callback',
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
