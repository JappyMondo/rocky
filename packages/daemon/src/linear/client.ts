/**
 * The Linear API client the later tickets build on (NG-600): activities,
 * comments, attachments, issue state reads and `fileUpload`.
 *
 * `@linear/sdk` does the GraphQL, but it sits behind `LinearSdkLike` — a
 * listing of exactly the six calls Rocky depends on. The seam is not
 * indirection for its own sake: the agents API is a Developer Preview
 * (NG-567), so the surface Rocky would have to re-check after an SDK bump is
 * worth being able to read in one place. It is also what lets these operations
 * be tested without a network.
 *
 * Everything the SDK does not cover lives here too: the caller-supplied
 * activity id that makes a replayed Step idempotent (NG-574), the presigned
 * `PUT` that `fileUpload` only prepares, and the refresh of a 24-hour access
 * token whose refresh token rotates on use.
 */
import { randomUUID } from 'node:crypto';

import { AgentActivitySignal, LinearClient } from '@linear/sdk';

import { isExpired, refreshTokens, type OAuthTokens } from './oauth.js';

/**
 * The four signals Linear's schema declares. `auth` renders a button to an
 * arbitrary URL and `select` renders clickable options — the two a Checkpoint
 * is built from; `stop` arrives from the human and Rocky must honour it.
 * `continue` is in the schema and documented nowhere (NG-567 §3).
 */
export type LinearActivitySignal = 'auth' | 'continue' | 'select' | 'stop';

/** Written out rather than cast, so the four stay visible next to the type. */
const SDK_SIGNALS: Record<LinearActivitySignal, AgentActivitySignal> = {
  auth: AgentActivitySignal.Auth,
  continue: AgentActivitySignal.Continue,
  select: AgentActivitySignal.Select,
  stop: AgentActivitySignal.Stop,
};

/** One of a team's workflow states, as a Workflow's `setState` reads them. */
export interface WorkflowStateSummary {
  id: string;
  name: string;
  /** `triage` | `backlog` | `unstarted` | `started` | `completed` | … */
  type: string;
  position: number;
}

interface UploadTarget {
  uploadUrl: string;
  assetUrl: string;
  headers: { key: string; value: string }[];
}

/** Exactly the `@linear/sdk` surface Rocky uses. Nothing else is depended on. */
export interface LinearSdkLike {
  createAgentActivity(input: {
    id?: string;
    agentSessionId: string;
    content: Record<string, unknown>;
    ephemeral?: boolean;
    signal?: LinearActivitySignal;
    signalMetadata?: Record<string, unknown>;
  }): Promise<{ success: boolean }>;

  createComment(input: {
    id?: string;
    issueId: string;
    body: string;
    parentId?: string;
  }): Promise<{ success: boolean }>;

  createAttachment(input: {
    id?: string;
    issueId: string;
    title: string;
    url: string;
    subtitle?: string;
    iconUrl?: string;
  }): Promise<{ success: boolean }>;

  workflowStates(variables?: {
    filter?: { team?: { id?: { eq?: string } } };
  }): Promise<{ nodes: WorkflowStateSummary[] }>;

  fileUpload(
    contentType: string,
    filename: string,
    size: number,
  ): Promise<{ success: boolean; uploadFile?: UploadTarget | null }>;

  readonly viewer: Promise<{ id: string; name: string }>;
}

/** What `credentials.json` holds for Linear, as this client needs it. */
export interface StoredLinearAuth {
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
}

export interface RockyLinearClientOptions {
  /** Re-read on demand, never cached — `credentials.json` is hot (NG-578). */
  auth(): Promise<StoredLinearAuth>;
  /** Persist a rotated pair. Losing it costs the machine its install. */
  save(tokens: OAuthTokens): Promise<void>;
  createSdk?: (accessToken: string) => LinearSdkLike;
  fetch?: typeof fetch;
  now?: () => number;
}

export class LinearNotConfiguredError extends Error {
  constructor(what: string) {
    super(`Rocky has no ${what} for Linear yet — run \`rocky setup\`.`);
    this.name = 'LinearNotConfiguredError';
  }
}

/** The real adapter. Named so a stack trace says which call was Linear's. */
function defaultSdk(accessToken: string): LinearSdkLike {
  const client = new LinearClient({ accessToken });

  return {
    createAgentActivity: ({ signal, ...input }) =>
      client.createAgentActivity({
        ...input,
        signal: signal === undefined ? undefined : SDK_SIGNALS[signal],
      }),
    createComment: (input) => client.createComment(input),
    createAttachment: (input) => client.createAttachment(input),
    workflowStates: async (variables) => {
      const connection = await client.workflowStates(variables);
      return {
        nodes: connection.nodes.map((state) => ({
          id: state.id,
          name: state.name,
          type: state.type,
          position: state.position,
        })),
      };
    },
    fileUpload: async (contentType, filename, size) => {
      const payload = await client.fileUpload(contentType, filename, size);
      const file = payload.uploadFile;
      return {
        success: payload.success,
        uploadFile: file
          ? {
              uploadUrl: file.uploadUrl,
              assetUrl: file.assetUrl,
              headers: file.headers.map((h) => ({
                key: h.key,
                value: h.value,
              })),
            }
          : null,
      };
    },
    get viewer() {
      return client.viewer.then((user) => ({ id: user.id, name: user.name }));
    },
  };
}

export interface PostActivityOptions {
  sessionId: string;
  content: Record<string, unknown>;
  /** Supply one to make a replayed Step post the same activity, not a second. */
  id?: string;
  /** Only `thought` and `action` may be ephemeral. */
  ephemeral?: boolean;
  signal?: LinearActivitySignal;
  signalMetadata?: Record<string, unknown>;
}

export interface WriteResult {
  id: string;
  success: boolean;
}

export class RockyLinearClient {
  private readonly createSdk: (accessToken: string) => LinearSdkLike;
  private readonly doFetch: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: RockyLinearClientOptions) {
    this.createSdk = options.createSdk ?? defaultSdk;
    this.doFetch = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  /**
   * A fresh SDK per call rather than one held open: the access token is
   * short-lived and rotates, and `credentials.json` is re-read on demand, so
   * caching the client would cache the very thing that goes stale.
   */
  private async sdk(): Promise<LinearSdkLike> {
    return this.createSdk(await this.accessToken());
  }

  /** The current access token, refreshed and persisted first if it has aged out. */
  async accessToken(): Promise<string> {
    const auth = await this.options.auth();

    if (!auth.accessToken) {
      throw new LinearNotConfiguredError('access token');
    }

    if (!isExpired({ expiresAt: auth.expiresAt }, this.now)) {
      return auth.accessToken;
    }

    if (!auth.refreshToken || !auth.clientId || !auth.clientSecret) {
      throw new LinearNotConfiguredError(
        'refresh token and client credentials',
      );
    }

    const tokens = await refreshTokens(
      {
        clientId: auth.clientId,
        clientSecret: auth.clientSecret,
        redirectUri: auth.redirectUri ?? '',
        refreshToken: auth.refreshToken,
      },
      { fetch: this.doFetch, now: this.now },
    );

    await this.options.save(tokens);
    return tokens.accessToken;
  }

  async viewer(): Promise<{ id: string; name: string }> {
    return (await this.sdk()).viewer;
  }

  /**
   * One activity in a session. A whitespace-only body is refused here because
   * Linear accepts it and renders an empty bubble in the thread — server-side
   * validation does not catch it, so Rocky must (NG-567 §2).
   */
  async postActivity(options: PostActivityOptions): Promise<WriteResult> {
    const body = options.content.body;
    if (typeof body === 'string' && body.trim() === '') {
      throw new Error(
        'refusing to post an activity with an empty body — Linear renders it as a blank bubble in the thread.',
      );
    }

    const id = options.id ?? randomUUID();
    const { success } = await (
      await this.sdk()
    ).createAgentActivity({
      id,
      agentSessionId: options.sessionId,
      content: options.content,
      ...(options.ephemeral === undefined
        ? {}
        : { ephemeral: options.ephemeral }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.signalMetadata === undefined
        ? {}
        : { signalMetadata: options.signalMetadata }),
    });

    return { id, success };
  }

  async postComment(options: {
    issueId: string;
    body: string;
    /** Set to reply inside one thread rather than opening another. */
    parentId?: string;
    id?: string;
  }): Promise<WriteResult> {
    const id = options.id ?? randomUUID();
    const { success } = await (
      await this.sdk()
    ).createComment({
      id,
      issueId: options.issueId,
      body: options.body,
      ...(options.parentId === undefined ? {} : { parentId: options.parentId }),
    });

    return { id, success };
  }

  /**
   * A link card, not an image — attachments carry a 20x20px icon at most
   * (NG-567 §4). `url` doubles as the identity, so posting the same one again
   * updates the card in place instead of adding a second.
   */
  async createAttachment(options: {
    issueId: string;
    title: string;
    url: string;
    subtitle?: string;
    iconUrl?: string;
    id?: string;
  }): Promise<WriteResult> {
    const id = options.id ?? randomUUID();
    const { success } = await (
      await this.sdk()
    ).createAttachment({
      id,
      issueId: options.issueId,
      title: options.title,
      url: options.url,
      ...(options.subtitle === undefined ? {} : { subtitle: options.subtitle }),
      ...(options.iconUrl === undefined ? {} : { iconUrl: options.iconUrl }),
    });

    return { id, success };
  }

  async workflowStates(teamId: string): Promise<WorkflowStateSummary[]> {
    const { nodes } = await (
      await this.sdk()
    ).workflowStates({ filter: { team: { id: { eq: teamId } } } });
    return nodes;
  }

  /**
   * Case-insensitive by name, and nothing else. NG-578 put state names in the
   * Workflow rather than in config, so an unknown one is an author's typo: it
   * fails with the team's real names listed, never a fuzzy guess.
   */
  async findWorkflowState(
    teamId: string,
    name: string,
  ): Promise<WorkflowStateSummary> {
    const states = await this.workflowStates(teamId);
    const wanted = name.trim().toLowerCase();
    const found = states.find((state) => state.name.toLowerCase() === wanted);

    if (!found) {
      throw new Error(
        `this team has no workflow state called "${name}" — it has ${states.map((state) => state.name).join(', ')}.`,
      );
    }
    return found;
  }

  /**
   * Two steps, and the second one has to happen server-side: Linear's CSP
   * blocks a browser from performing the presigned `PUT` (NG-567 §4). The
   * returned `assetUrl` is authenticated, so Rocky's own UI cannot hotlink it —
   * it is for Markdown inside a Linear comment.
   */
  async uploadFile(options: {
    filename: string;
    contentType: string;
    data: Uint8Array;
  }): Promise<{ assetUrl: string }> {
    const prepared = await (
      await this.sdk()
    ).fileUpload(
      options.contentType,
      options.filename,
      options.data.byteLength,
    );

    const target = prepared.uploadFile;
    if (!prepared.success || !target) {
      throw new Error(
        `Linear could not prepare an upload for "${options.filename}".`,
      );
    }

    const headers = new Headers({
      'content-type': options.contentType,
      // Required by Linear's upload guide, alongside every header it returned.
      'cache-control': 'public, max-age=31536000',
    });
    for (const header of target.headers) {
      headers.set(header.key, header.value);
    }

    const response = await this.doFetch(target.uploadUrl, {
      method: 'PUT',
      headers,
      body: options.data,
    });

    if (!response.ok) {
      throw new Error(
        `uploading "${options.filename}" to Linear answered ${response.status} — the asset URL would point at nothing.`,
      );
    }

    return { assetUrl: target.assetUrl };
  }
}
