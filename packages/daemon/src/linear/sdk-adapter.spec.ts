/**
 * The real `@linear/sdk` adapter — the six calls Rocky depends on, and the one
 * place an SDK bump can break it silently.
 *
 * NG-567 flags the agents API as a Developer Preview, so these pin the mapping
 * rather than trusting it: the argument order of `fileUpload`, the enum a
 * signal has to become, and the fields Rocky reads back off each result.
 */
import { describe, expect, it, vi } from 'vitest';

const createAgentActivity = vi.fn(async () => ({ success: true }));
const createComment = vi.fn(async () => ({ success: true }));
const createAttachment = vi.fn(async () => ({ success: true }));
const workflowStates = vi.fn(async () => ({
  nodes: [
    {
      id: 's1',
      name: 'In Review',
      type: 'started',
      position: 2,
      // A real WorkflowState carries far more than Rocky reads; the adapter
      // narrowing to four fields is the thing being asserted.
      description: 'ignored',
      color: '#fff',
    },
  ],
}));
const fileUpload = vi.fn(async () => ({
  success: true,
  uploadFile: {
    uploadUrl: 'https://upload.example.com/signed',
    assetUrl: 'https://uploads.linear.app/asset.png',
    headers: [{ key: 'x-amz-acl', value: 'private' }],
  },
}));

const constructed: { accessToken?: string }[] = [];

vi.mock('@linear/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@linear/sdk')>();

  return {
    ...actual,
    LinearClient: class {
      constructor(options: { accessToken?: string }) {
        constructed.push(options);
      }
      createAgentActivity = createAgentActivity;
      createComment = createComment;
      createAttachment = createAttachment;
      workflowStates = workflowStates;
      fileUpload = fileUpload;
      get viewer() {
        return Promise.resolve({
          id: 'app-user',
          name: 'Rocky (Jan Jaap)',
          email: 'ignored',
        });
      }
    },
  };
});

const { RockyLinearClient } = await import('./client.js');

function client() {
  return new RockyLinearClient({
    auth: async () => ({
      clientId: 'cid',
      clientSecret: 'csec',
      accessToken: 'the-token',
      refreshToken: 'rt',
    }),
    save: vi.fn(async () => undefined),
    fetch: (async () =>
      new Response(null, { status: 200 })) as unknown as typeof fetch,
  });
}

describe('the real SDK adapter', () => {
  it('constructs the SDK with the current access token', async () => {
    await client().viewer();

    expect(constructed.at(-1)).toEqual({ accessToken: 'the-token' });
  });

  it('turns a signal into the SDK`s enum member, not the bare string', async () => {
    await client().postActivity({
      sessionId: 'sess-1',
      content: { type: 'elicitation', body: 'Approve?' },
      signal: 'auth',
    });

    const { AgentActivitySignal } = await import('@linear/sdk');
    expect(createAgentActivity).toHaveBeenCalledWith(
      expect.objectContaining({ signal: AgentActivitySignal.Auth }),
    );
  });

  it('narrows a workflow state to the four fields Rocky reads', async () => {
    expect(await client().workflowStates('team-1')).toEqual([
      { id: 's1', name: 'In Review', type: 'started', position: 2 },
    ]);
  });

  it('passes fileUpload its three positional arguments in Linear`s order', async () => {
    await client().uploadFile({
      filename: 'shot.png',
      contentType: 'image/png',
      data: Buffer.from('png-bytes'),
    });

    // contentType, filename, size — not the alphabetical order it looks like.
    expect(fileUpload).toHaveBeenCalledWith('image/png', 'shot.png', 9);
  });

  it('reads the viewer down to the id and name', async () => {
    expect(await client().viewer()).toEqual({
      id: 'app-user',
      name: 'Rocky (Jan Jaap)',
    });
  });

  it('forwards comments and attachments unchanged', async () => {
    await client().postComment({ issueId: 'issue-1', body: 'Run started' });
    await client().createAttachment({
      issueId: 'issue-1',
      title: 'Rocky',
      url: 'http://127.0.0.1:7625/runs/NG-600-1',
    });

    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({ issueId: 'issue-1', body: 'Run started' }),
    );
    expect(createAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Rocky' }),
    );
  });
});
