import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RockyLinearClient } from './client.js';

function httpClient(fetch: typeof globalThis.fetch, signal?: AbortSignal) {
  return new RockyLinearClient({
    auth: async () => ({ accessToken: 'fake-app-token' }),
    save: async () => undefined,
    fetch,
    signal,
  });
}

const pageInfo = {
  hasNextPage: false,
  hasPreviousPage: false,
  endCursor: null,
  startCursor: null,
};
const at = '2026-09-07T00:00:00.000Z';

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('Unexpected non-injected HTTP request');
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('public SDK over injected HTTP', () => {
  it('rechecks a shared cooldown extended by another in-flight response', async () => {
    vi.useFakeTimers();
    let complete!: (response: Response) => void;
    const delayed = new Promise<Response>((resolve) => {
      complete = resolve;
    });
    const viewer = { data: { viewer: { id: 'app-user', name: 'Rocky' } } };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockReturnValueOnce(delayed)
      .mockResolvedValueOnce(
        Response.json(viewer, {
          headers: {
            'x-ratelimit-requests-remaining': '0',
            'x-ratelimit-requests-reset': String(Date.now() + 100),
          },
        }),
      )
      .mockResolvedValueOnce(Response.json(viewer));
    const client = httpClient(fetch);
    const slow = client.viewer();
    await client.viewer();
    const waiting = client.viewer();
    await vi.advanceTimersByTimeAsync(50);
    complete(
      Response.json(viewer, {
        headers: {
          'x-ratelimit-complexity-remaining': '0',
          'x-ratelimit-complexity-reset': String(Date.now() + 500),
        },
      }),
    );
    await slow;
    await vi.advanceTimersByTimeAsync(50);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(450);
    await waiting;
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('returns the actual attachment ID when create upserts an existing issue URL', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
      Response.json({
        data: {
          attachmentCreate: {
            success: true,
            attachment: { id: 'actual-existing-id' },
          },
        },
      }),
    );
    expect(
      await httpClient(fetch).createAttachment({
        id: 'proposed-id',
        issueId: 'issue-1',
        title: 'Rocky',
        url: 'http://localhost:7625/issues/issue-1',
      }),
    ).toEqual({ id: 'actual-existing-id', success: true });
  });
  it('does not replay a mutation with partial success and a rate-limit error', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () =>
        Response.json({
          data: { commentCreate: { success: true } },
          errors: [
            {
              message: 'Partial rate limit',
              extensions: { code: 'RATELIMITED' },
            },
          ],
        }),
      );
    await expect(
      httpClient(fetch).postComment({ issueId: 'issue-1', body: 'Start' }),
    ).rejects.toThrow(/Partial rate limit/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('verifies the actual activity after a create response is lost, using a global ID lookup', async () => {
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const content = {
      type: 'action',
      action: 'Checked',
      parameter: 'Step 1',
      result: 'Passed',
    };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({ data: { agentActivities: { nodes: [], pageInfo } } }),
      )
      .mockRejectedValueOnce(new Error('connection lost after effect'))
      .mockResolvedValueOnce(
        Response.json({
          data: {
            agentActivities: {
              nodes: [
                {
                  id,
                  createdAt: at,
                  agentSession: { id: 'sess-1' },
                  ephemeral: false,
                  content: {
                    ...content,
                    __typename: 'AgentActivityActionContent',
                  },
                },
              ],
              pageInfo,
            },
          },
        }),
      );
    expect(
      await httpClient(fetch).ensureActivity({
        id,
        sessionId: 'sess-1',
        content,
      }),
    ).toEqual({ id, success: true });
    expect(
      JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).variables,
    ).toEqual({ first: 1, filter: { id: { eq: id } } });
    expect(
      JSON.parse(String(fetch.mock.calls[1]?.[1]?.body)).variables.input,
    ).toEqual({ id, agentSessionId: 'sess-1', content });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('uploads final screenshot bytes unchanged, with every signed header, and returns only the asset URL', async () => {
    const data = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({
          data: {
            fileUpload: {
              success: true,
              uploadFile: {
                uploadUrl: 'https://upload.example.com/signed',
                assetUrl: 'https://uploads.linear.app/final.png',
                headers: [
                  {
                    key: 'Content-Disposition',
                    value: 'attachment; filename="final.png"',
                  },
                  { key: 'x-goog-content-length-range', value: '8,8' },
                  { key: 'cache-control', value: 'public, max-age=31536000' },
                ],
              },
            },
          },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    expect(
      await httpClient(fetch).uploadFile({
        filename: 'final.png',
        contentType: 'image/png',
        data,
      }),
    ).toEqual({ assetUrl: 'https://uploads.linear.app/final.png' });
    const init = fetch.mock.calls[1]?.[1];
    expect(init?.method).toBe('PUT');
    expect(init?.body).toBe(data);
    expect(Object.fromEntries(new Headers(init?.headers))).toEqual({
      'content-type': 'image/png',
      'cache-control': 'public, max-age=31536000',
      'content-disposition': 'attachment; filename="final.png"',
      'x-goog-content-length-range': '8,8',
    });
  });
  it('reads only public session/issue associations and preserves dismissal and lost delegation', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({
          data: {
            agentSession: {
              externalLinks: [],
              id: 'sess-1',
              issue: { id: 'issue-1' },
              appUser: { id: 'app-user' },
              dismissedAt: at,
              status: 'complete',
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          data: {
            issue: {
              sharedAccess: { sharedWithUsers: [] },
              reactions: [],
              id: 'issue-1',
              delegate: null,
            },
          },
        }),
      );
    expect(await httpClient(fetch).session('sess-1')).toEqual({
      id: 'sess-1',
      issueId: 'issue-1',
      appUserId: 'app-user',
      dismissedAt: at,
      delegateId: null,
      status: 'complete',
    });
    expect(
      JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).variables,
    ).toEqual({ id: 'sess-1' });
  });

  it('fails with a named fix when a known session lacks an issue association', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
      Response.json({
        data: {
          agentSession: {
            externalLinks: [],
            id: 'sess-1',
            appUser: { id: 'app-user' },
          },
        },
      }),
    );
    await expect(httpClient(fetch).session('sess-1')).rejects.toThrow(
      /re-delegate.*persist/,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('maps all activity pages, strips GraphQL tags, and retains source comment and signal metadata', async () => {
    const activity = {
      id: 'activity-1',
      createdAt: at,
      agentSession: { id: 'sess-1' },
      sourceComment: { id: 'auto-comment' },
      ephemeral: false,
      signal: 'select',
      signalMetadata: JSON.stringify({ options: [] }),
      content: {
        __typename: 'AgentActivityActionContent',
        type: 'action',
        action: 'Checked',
        parameter: 'Step 1',
        result: null,
      },
    };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({
          data: {
            agentActivities: {
              nodes: [activity],
              pageInfo: { ...pageInfo, hasNextPage: true, endCursor: 'next' },
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          data: { agentActivities: { nodes: [activity], pageInfo } },
        }),
      );
    expect(await httpClient(fetch).activities('sess-1', { since: at })).toEqual(
      [
        {
          id: 'activity-1',
          createdAt: at,
          sessionId: 'sess-1',
          sourceCommentId: 'auto-comment',
          ephemeral: false,
          signal: 'select',
          signalMetadata: { options: [] },
          content: { type: 'action', action: 'Checked', parameter: 'Step 1' },
        },
      ],
    );
    expect(
      JSON.parse(String(fetch.mock.calls[1]?.[1]?.body)).variables,
    ).toEqual({
      first: 100,
      after: 'next',
      filter: {
        agentSessionId: { eq: 'sess-1' },
        createdAt: { gte: '2026-09-06T23:59:59.000Z' },
      },
    });
  });

  it('exposes comment session/user/parent associations without guessing automatic-comment policy', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
      Response.json({
        data: {
          comments: {
            nodes: [
              {
                reactions: [],
                id: 'comment-1',
                issueId: 'issue-1',
                body: 'Approve?',
                createdAt: at,
                agentSession: { id: 'sess-1' },
                user: { id: 'app-user' },
                parentId: 'root',
              },
            ],
            pageInfo,
          },
        },
      }),
    );
    expect(await httpClient(fetch).comments('issue-1')).toEqual([
      {
        id: 'comment-1',
        issueId: 'issue-1',
        body: 'Approve?',
        createdAt: at,
        sessionId: 'sess-1',
        userId: 'app-user',
        parentId: 'root',
      },
    ]);
  });

  it('sends only the public session externalUrls update with ordinary localhost HTTP', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({ data: { agentSessionUpdate: { success: true } } }),
      );
    await httpClient(fetch).acknowledgeSession(
      'sess-1',
      'http://localhost:7625/runs/run-1',
    );
    expect(
      JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).variables,
    ).toEqual({
      id: 'sess-1',
      input: {
        externalUrls: [
          { label: 'Rocky', url: 'http://localhost:7625/runs/run-1' },
        ],
      },
    });
  });

  it('looks up attachment by issue + URL and updates metadata without sending a URL update', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({
          data: {
            issue: {
              sharedAccess: { sharedWithUsers: [] },
              reactions: [],
              id: 'issue-1',
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          data: {
            issue: {
              attachments: {
                nodes: [
                  {
                    id: 'actual',
                    issue: { id: 'issue-1' },
                    url: 'http://localhost:7625/issues/issue-1',
                  },
                ],
                pageInfo,
              },
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          data: {
            attachmentUpdate: { success: true, attachment: { id: 'actual' } },
          },
        }),
      );
    expect(
      await httpClient(fetch).maintainAttachment({
        issueId: 'issue-1',
        title: 'Rocky',
        url: 'http://localhost:7625/issues/issue-1',
        subtitle: 'Run 2',
      }),
    ).toEqual({ id: 'actual', success: true });
    expect(
      JSON.parse(String(fetch.mock.calls[2]?.[1]?.body)).variables,
    ).toEqual({ id: 'actual', input: { title: 'Rocky', subtitle: 'Run 2' } });
  });

  it.each(['requests', 'complexity', 'endpoint-requests'])(
    'honors an exhausted %s budget on a successful response before the next call',
    async (budget) => {
      vi.useFakeTimers();
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(
          Response.json(
            { data: { viewer: { id: 'app-user', name: 'Rocky' } } },
            {
              headers: {
                [`x-ratelimit-${budget}-remaining`]: '0',
                [`x-ratelimit-${budget}-reset`]: String(Date.now() + 2000),
              },
            },
          ),
        )
        .mockResolvedValueOnce(
          Response.json({
            data: { viewer: { id: 'app-user', name: 'Rocky' } },
          }),
        );
      const client = httpClient(fetch);
      await client.viewer();
      const second = client.viewer();
      await vi.advanceTimersByTimeAsync(1999);
      expect(fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await second;
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );

  it('aborts a throttled write without issuing any later mutation', async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      Response.json(
        {
          errors: [{ message: 'limited', extensions: { code: 'RATELIMITED' } }],
        },
        { status: 429, headers: { 'retry-after': '2' } },
      ),
    );
    const result = httpClient(fetch, abort.signal).postComment({
      issueId: 'issue-1',
      body: 'Start',
    });
    const rejected = expect(result).rejects.toThrow(/stop/);
    await vi.advanceTimersByTimeAsync(100);
    abort.abort(new Error('stop'));
    await rejected;
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not retry an ambiguous mutation or a non-rate GraphQL error', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new Error('connection lost'));
    await expect(
      httpClient(fetch).postComment({ issueId: 'issue-1', body: 'Start' }),
    ).rejects.toThrow(/connection lost/);
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockResolvedValueOnce(
      Response.json({ errors: [{ message: 'Forbidden' }] }),
    );
    await expect(
      httpClient(fetch).postComment({ issueId: 'issue-1', body: 'Start' }),
    ).rejects.toThrow(/Forbidden/);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('bounds rate-limit attempts and refuses to retry before a long server cooldown', async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () =>
        Response.json(
          {
            errors: [
              { message: 'limited', extensions: { code: 'RATELIMITED' } },
            ],
          },
          { status: 400 },
        ),
      );
    const result = expect(httpClient(fetch).viewer()).rejects.toThrow(
      /three attempts/,
    );
    await vi.advanceTimersByTimeAsync(5000);
    await result;
    expect(fetch).toHaveBeenCalledTimes(3);
    fetch
      .mockClear()
      .mockImplementation(async () =>
        Response.json({}, { status: 429, headers: { 'retry-after': '3600' } }),
      );
    await expect(httpClient(fetch).viewer()).rejects.toThrow(/retry later/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('honors request throttling before retrying and sends the current app token', async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json(
          {
            errors: [
              { message: 'Rate limited', extensions: { code: 'RATELIMITED' } },
            ],
          },
          { status: 429, headers: { 'retry-after': '2' } },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({ data: { viewer: { id: 'app-user', name: 'Rocky' } } }),
      );
    const client = new RockyLinearClient({
      auth: async () => ({ accessToken: 'fake-app-token' }),
      save: async () => undefined,
      fetch,
    });
    const result = client.viewer();
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toEqual({ id: 'app-user', name: 'Rocky' });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(
      new Headers(fetch.mock.calls[0]?.[1]?.headers).get('authorization'),
    ).toBe('Bearer fake-app-token');
  });
});
