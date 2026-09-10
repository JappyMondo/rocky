/**
 * Linear recovery and effect primitives (NG-600/601). The public SDK owns
 * GraphQL documents and model hydration; Rocky owns transport, pagination,
 * verified effect identity, raw uploads, and serialized credential refresh.
 * Comment-count, Checkpoint, Steer, and stop policy belong to the callers.
 */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import {
  AgentActivitySignal,
  LinearSdk,
  type LinearRequest,
  type AgentActivity,
  type Comment,
} from '@linear/sdk';
import { z } from 'zod';
import { sameActivityContent, sameMarkdown } from './markdown.js';

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

export interface LinearSessionSummary {
  id: string;
  issueId: string;
  appUserId: string;
  dismissedAt: string | null;
  delegateId: string | null;
  status: string;
}

/** The immutable issue facts captured at admission; never hand a Workflow a live SDK model. */
export interface LinearIssueSummary {
  id: string;
  identifier: string;
  title: string;
  description: string;
  url: string;
  labels: string[];
  teamId: string;
}

export interface LinearSessionActivity {
  id: string;
  sessionId: string;
  createdAt: string;
  content: Record<string, unknown> & { type: string };
  ephemeral: boolean;
  signal?: LinearActivitySignal;
  signalMetadata?: Record<string, unknown>;
  sourceCommentId?: string;
}

export interface LinearPage<T> {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor?: string | null };
}

export interface LinearCommentSummary {
  id: string;
  issueId: string | null;
  body: string;
  createdAt: string;
  sessionId: string | null;
  userId: string | null;
  parentId: string | null;
}

export interface MaintainAttachmentOptions {
  issueId: string;
  title: 'Rocky';
  url: string;
  subtitle?: string;
  iconUrl?: string;
  metadata?: Record<string, string | number>;
}

function commentSummary(comment: Comment): LinearCommentSummary {
  return {
    id: comment.id,
    issueId: comment.issueId ?? null,
    body: comment.body,
    createdAt: comment.createdAt.toISOString(),
    sessionId: comment.agentSessionId ?? null,
    userId: comment.userId ?? null,
    parentId: comment.parentId ?? null,
  };
}

function activitySummary(activity: AgentActivity): LinearSessionActivity {
  if (!activity.agentSessionId)
    throw new Error(
      `Linear activity ${activity.id} has no session association; restore app access and retry.`,
    );
  const content = Object.fromEntries(
    Object.entries(activity.content).filter(
      ([key, value]) => key !== '__typename' && value != null,
    ),
  );
  return {
    id: activity.id,
    sessionId: activity.agentSessionId,
    createdAt: activity.createdAt.toISOString(),
    content: { ...content, type: activity.content.type },
    ephemeral: activity.ephemeral,
    ...(activity.signal ? { signal: activity.signal } : {}),
    ...(activity.signalMetadata
      ? { signalMetadata: activity.signalMetadata }
      : {}),
    ...(activity.sourceCommentId
      ? { sourceCommentId: activity.sourceCommentId }
      : {}),
  };
}

async function allPages<T>(
  read: (after?: string) => Promise<LinearPage<T>>,
): Promise<T[]> {
  const nodes: T[] = [];
  const seen = new Set<string>();
  let after: string | undefined;
  for (;;) {
    const page = await read(after);
    nodes.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) return nodes;
    const next = page.pageInfo.endCursor;
    if (!next || seen.has(next))
      throw new Error(
        'Linear pagination did not advance; retry without advancing the durable activity cursor.',
      );
    seen.add(next);
    after = next;
  }
}

interface UploadTarget {
  uploadUrl: string;
  assetUrl: string;
  headers: { key: string; value: string }[];
}

/** Exactly the `@linear/sdk` surface Rocky uses. Nothing else is depended on. */
export interface LinearSdkLike {
  issue?(id: string): Promise<LinearIssueSummary>;
  session(id: string): Promise<LinearSessionSummary>;
  updateSession(
    id: string,
    input: { externalUrls: { label: string; url: string }[] },
  ): Promise<{ success: boolean }>;
  activities(
    sessionId: string,
    options: { since?: string; after?: string },
  ): Promise<LinearPage<LinearSessionActivity>>;
  activity(id: string): Promise<LinearSessionActivity | null>;
  comment(id: string): Promise<LinearCommentSummary | null>;
  comments(
    issueId: string,
    after?: string,
  ): Promise<LinearPage<LinearCommentSummary>>;
  attachments(
    issueId: string,
    url: string,
    after?: string,
  ): Promise<LinearPage<{ id: string; issueId: string; url: string }>>;
  updateAttachment(
    id: string,
    input: Omit<MaintainAttachmentOptions, 'issueId' | 'url'>,
  ): Promise<{ success: boolean }>;
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
    metadata?: Record<string, string | number>;
  }): Promise<{ success: boolean; id?: string }>;

  workflowStates(variables?: {
    filter?: { team?: { id?: { eq?: string } } };
    after?: string;
  }): Promise<LinearPage<WorkflowStateSummary>>;
  updateIssue(
    id: string,
    input: { stateId: string },
  ): Promise<{ success: boolean }>;

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
  /** Atomically merge the rotated pair into current credentials, preserving MCP and other sections. */
  save(tokens: OAuthTokens): Promise<void>;
  createSdk?: (accessToken: string) => LinearSdkLike;
  fetch?: typeof fetch;
  now?: () => number;
  /** Aborts this client's HTTP requests and throttling waits, including writes. */
  signal?: AbortSignal;
}

export class LinearNotConfiguredError extends Error {
  constructor(what: string) {
    super(`Rocky has no ${what} for Linear yet — run \`rocky setup\`.`);
    this.name = 'LinearNotConfiguredError';
  }
}

/** The real adapter. Named so a stack trace says which call was Linear's. */
function defaultSdk(request: LinearRequest): LinearSdkLike {
  const client = new LinearSdk(request);

  return {
    issue: async (id) => {
      const issue = await client.issue(id);
      const [labels, team] = await Promise.all([issue.labels(), issue.team]);
      if (!team)
        throw new Error(
          `Linear issue ${id} has no team; delegate an issue in a Rocky-enabled team.`,
        );
      return {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description ?? '',
        url: issue.url,
        labels: labels.nodes.map((label) => label.name),
        teamId: team.id,
      };
    },
    updateSession: (id, input) => client.updateAgentSession(id, input),
    attachments: async (issueId, url, after) => {
      const issue = await client.issue(issueId);
      const page = await issue.attachments({
        first: 100,
        after,
        filter: { url: { eq: url } },
      });
      return {
        nodes: page.nodes.map((row) => ({
          id: row.id,
          issueId: row.issueId ?? '',
          url: row.url,
        })),
        pageInfo: page.pageInfo,
      };
    },
    updateAttachment: (id, input) => client.updateAttachment(id, input),
    comment: async (id) => {
      const page = await client.comments({
        first: 1,
        filter: { id: { eq: id } },
      });
      return page.nodes[0] ? commentSummary(page.nodes[0]) : null;
    },
    comments: async (issueId, after) => {
      const page = await client.comments({
        first: 100,
        after,
        filter: { issue: { id: { eq: issueId } } },
      });
      return { nodes: page.nodes.map(commentSummary), pageInfo: page.pageInfo };
    },
    activity: async (id) => {
      const page = await client.agentActivities({
        first: 1,
        filter: { id: { eq: id } },
      });
      return page.nodes[0] ? activitySummary(page.nodes[0]) : null;
    },
    activities: async (sessionId, { since, after }) => {
      const page = await client.agentActivities({
        first: 100,
        after,
        filter: {
          agentSessionId: { eq: sessionId },
          ...(since ? { createdAt: { gte: since } } : {}),
        },
      });
      return {
        nodes: page.nodes.map(activitySummary),
        pageInfo: page.pageInfo,
      };
    },
    session: async (id) => {
      const session = await client.agentSession(id);
      const issue = await session.issue;
      if (!session.issueId || !session.appUserId || !issue) {
        throw new Error(
          `Linear session ${id} has no issue/app-user association; re-delegate the issue to Rocky and persist the returned session ID.`,
        );
      }
      return {
        id: session.id,
        issueId: session.issueId,
        appUserId: session.appUserId,
        dismissedAt: session.dismissedAt?.toISOString() ?? null,
        delegateId: issue.delegateId ?? null,
        status: session.status,
      };
    },
    createAgentActivity: ({ signal, ...input }) =>
      client.createAgentActivity({
        ...input,
        signal: signal === undefined ? undefined : SDK_SIGNALS[signal],
      }),
    createComment: (input) => client.createComment(input),
    createAttachment: async (input) => {
      const payload = await client.createAttachment(input);
      return { success: payload.success, id: payload.attachmentId };
    },
    updateIssue: (id, input) => client.updateIssue(id, input),
    workflowStates: async (variables) => {
      const connection = await client.workflowStates(variables);
      return {
        pageInfo: connection.pageInfo,
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
  /** Persist before the call; use ensureActivity for verified replay recovery. */
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

function requireEffectId(id: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      id,
    )
  ) {
    throw new Error(
      'Persist a UUID-v4 effect ID before calling the Linear find-or-create operation.',
    );
  }
}

export class RockyLinearClient {
  private readonly createSdk: (accessToken: string) => LinearSdkLike;
  private readonly doFetch: typeof fetch;
  private readonly now: () => number;
  private tokenRead?: Promise<string>;
  private nextRequestAt = 0;

  constructor(private readonly options: RockyLinearClientOptions) {
    this.createSdk =
      options.createSdk ??
      ((token) =>
        defaultSdk((doc, variables) => this.request(token, doc, variables)));
    this.doFetch = (input, init) => {
      options.signal?.throwIfAborted();
      return (options.fetch ?? fetch)(input, {
        ...init,
        ...(options.signal ? { signal: options.signal } : {}),
      });
    };
    this.now = options.now ?? Date.now;
  }

  /**
   * A fresh SDK per call rather than one held open: the access token is
   * short-lived and rotates, and `credentials.json` is re-read on demand, so
   * caching the client would cache the very thing that goes stale.
   */
  private async sdk(): Promise<LinearSdkLike> {
    this.options.signal?.throwIfAborted();
    return this.createSdk(await this.accessToken());
  }

  private async wait(ms: number): Promise<void> {
    const signal = this.options.signal;
    signal?.throwIfAborted();
    if (ms <= 0) return;
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        reject(signal?.reason);
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', abort);
        resolve();
      }, ms);
      signal?.addEventListener('abort', abort, { once: true });
    });
    signal?.throwIfAborted();
  }

  private async request<
    ResponseData,
    Variables extends Record<string, unknown>,
  >(
    token: string,
    query: string,
    variables?: Variables,
  ): Promise<ResponseData> {
    const deadline = this.now() + 30_000;
    for (let attempt = 0; attempt < 3; attempt++) {
      while (this.nextRequestAt > this.now()) {
        if (this.nextRequestAt > deadline)
          throw new Error(
            `Linear rate limit requires waiting until ${new Date(this.nextRequestAt).toISOString()}; retry later with the same effect ID.`,
          );
        await this.wait(this.nextRequestAt - this.now());
      }
      const response = await this.doFetch('https://api.linear.app/graphql', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ query, variables }),
      });
      const retryAfter = response.headers.get('retry-after');
      let retryAt =
        retryAfter === null ? 0 : this.now() + Number(retryAfter) * 1000;
      if (!Number.isFinite(retryAt))
        retryAt = Date.parse(retryAfter ?? '') || 0;
      for (const budget of ['requests', 'complexity', 'endpoint-requests']) {
        if (response.headers.get(`x-ratelimit-${budget}-remaining`) === '0') {
          const reset = Number(
            response.headers.get(`x-ratelimit-${budget}-reset`),
          );
          if (Number.isFinite(reset)) retryAt = Math.max(retryAt, reset);
        }
      }
      this.nextRequestAt = Math.max(this.nextRequestAt, retryAt);
      const parsed = z
        .object({
          data: z.unknown().optional(),
          errors: z
            .array(
              z.object({
                message: z.string().optional(),
                extensions: z
                  .object({
                    code: z.string().optional(),
                    type: z.string().optional(),
                  })
                  .optional(),
              }),
            )
            .optional(),
        })
        .safeParse(await response.json().catch(() => ({})));
      const payload = parsed.success ? parsed.data : {};
      const onlyRateErrors =
        payload.errors?.length &&
        payload.errors.every(
          (error) =>
            error.extensions?.code === 'RATELIMITED' ||
            error.extensions?.type === 'Ratelimited',
        );
      // Partial data or mixed errors may mean a mutation ran. Reconcile, never retry it blindly.
      const limited =
        payload.data == null &&
        (onlyRateErrors ||
          (response.status === 429 && !payload.errors?.length));
      if (limited) {
        this.nextRequestAt = Math.max(
          this.nextRequestAt,
          this.now() + 250 * 2 ** attempt,
        );
        if (attempt < 2) continue;
        throw new Error(
          'Linear rate limit exhausted three attempts; retry later with the same effect ID.',
        );
      }
      if (!response.ok || payload.errors?.length || payload.data == null) {
        throw new Error(
          `Linear API answered ${response.status}: ${payload.errors?.map((error) => error.message).join('; ') || 'missing response data'}`,
        );
      }
      // The generated SDK owns the query's response type and model hydration.
      return payload.data as ResponseData;
    }
    throw new Error('Linear request exhausted its retry budget.');
  }

  /** The current access token, refreshed and persisted first if it has aged out. */
  async accessToken(): Promise<string> {
    if (this.tokenRead) return this.tokenRead;
    const pending = this.readAccessToken();
    this.tokenRead = pending;
    try {
      return await pending;
    } finally {
      this.tokenRead = undefined;
    }
  }

  private async readAccessToken(): Promise<string> {
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

  async session(sessionId: string): Promise<LinearSessionSummary> {
    return (await this.sdk()).session(sessionId);
  }

  async issue(issueId: string): Promise<LinearIssueSummary> {
    const issue = (await this.sdk()).issue;
    if (!issue)
      throw new Error(
        'This Linear client cannot hydrate delegated issues; update Rocky before accepting delegations.',
      );
    return issue(issueId);
  }

  /** Call immediately after durable receipt, before queueing or loading a Workflow. */
  async acknowledgeSession(
    sessionId: string,
    runUrl: string,
  ): Promise<WriteResult> {
    const result = await (
      await this.sdk()
    ).updateSession(sessionId, {
      externalUrls: [{ label: 'Rocky', url: runUrl }],
    });
    if (!result.success)
      throw new Error(
        `Linear could not acknowledge session ${sessionId}; verify the owning app token and session association.`,
      );
    return { id: sessionId, success: true };
  }

  async activities(
    sessionId: string,
    options: { since?: string } = {},
  ): Promise<LinearSessionActivity[]> {
    const since =
      options.since === undefined
        ? undefined
        : new Date(Date.parse(options.since) - 1000).toISOString();
    const sdk = await this.sdk();
    const rows = await allPages((after) =>
      sdk.activities(sessionId, {
        ...(since ? { since } : {}),
        ...(after ? { after } : {}),
      }),
    );
    return [...new Map(rows.map((row) => [row.id, row])).values()].sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
  }

  async ensureActivity(
    options: PostActivityOptions & { id: string },
  ): Promise<WriteResult> {
    if (options.ephemeral)
      throw new Error(
        'Ephemeral activities cannot be verified after replacement; use postActivity without a durable effect ID.',
      );
    requireEffectId(options.id);
    const content: unknown = JSON.parse(JSON.stringify(options.content));
    const signalMetadata: unknown =
      options.signalMetadata === undefined
        ? undefined
        : JSON.parse(JSON.stringify(options.signalMetadata));
    const sdk = await this.sdk();
    let row = await sdk.activity(options.id);
    if (!row) {
      let failure: unknown;
      try {
        const result = await this.postActivity(options);
        if (!result.success)
          failure = new Error(`Linear refused activity ${options.id}.`);
      } catch (error) {
        failure = error;
      }
      row = await sdk.activity(options.id);
      if (!row)
        throw (
          failure ??
          new Error(
            `Linear activity ${options.id} could not be verified; retry with the same persisted ID.`,
          )
        );
    }
    if (
      row.id !== options.id ||
      row.sessionId !== options.sessionId ||
      !sameActivityContent(row.content, content) ||
      row.ephemeral !== (options.ephemeral ?? false) ||
      row.signal !== options.signal ||
      !isDeepStrictEqual(row.signalMetadata, signalMetadata)
    ) {
      throw new Error(
        `Linear activity ${options.id} payload/session mismatch; inspect the persisted effect before retrying.`,
      );
    }
    return { id: row.id, success: true };
  }

  /**
   * One activity in a session. A whitespace-only body is refused here because
   * Linear accepts it and renders an empty bubble in the thread — server-side
   * validation does not catch it, so Rocky must (NG-567 §2).
   */
  async postActivity(options: PostActivityOptions): Promise<WriteResult> {
    if (
      options.content.type === 'action' &&
      (typeof options.content.action !== 'string' ||
        !options.content.action.trim() ||
        typeof options.content.parameter !== 'string' ||
        'body' in options.content ||
        (options.content.result !== undefined &&
          typeof options.content.result !== 'string'))
    ) {
      throw new Error(
        'An action activity requires action and parameter strings, an optional result string, and no body.',
      );
    }
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

  async comments(issueId: string): Promise<LinearCommentSummary[]> {
    const sdk = await this.sdk();
    const rows = await allPages((after) => sdk.comments(issueId, after));
    return [...new Map(rows.map((row) => [row.id, row])).values()].sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
  }

  async ensureComment(options: {
    id: string;
    issueId: string;
    body: string;
  }): Promise<WriteResult> {
    requireEffectId(options.id);
    const sdk = await this.sdk();
    let row = await sdk.comment(options.id);
    if (!row) {
      let failure: unknown;
      try {
        const result = await sdk.createComment(options);
        if (!result.success)
          failure = new Error(`Linear refused comment ${options.id}.`);
      } catch (error) {
        failure = error;
      }
      row = await sdk.comment(options.id);
      if (!row)
        throw (
          failure ??
          new Error(
            `Linear comment ${options.id} could not be verified; retry with the same persisted ID.`,
          )
        );
    }
    if (
      row.id !== options.id ||
      row.issueId !== options.issueId ||
      !sameMarkdown(row.body, options.body) ||
      row.parentId !== null
    ) {
      throw new Error(
        `Linear comment ${options.id} payload/issue mismatch; inspect the persisted effect before retrying.`,
      );
    }
    return { id: row.id, success: true };
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
    const result = await (
      await this.sdk()
    ).createAttachment({
      id,
      issueId: options.issueId,
      title: options.title,
      url: options.url,
      ...(options.subtitle === undefined ? {} : { subtitle: options.subtitle }),
      ...(options.iconUrl === undefined ? {} : { iconUrl: options.iconUrl }),
    });

    if (!result.success || !result.id)
      throw new Error(
        'Linear could not return the actual attachment identity; retry by issue and stable URL.',
      );
    return { id: result.id, success: true };
  }

  async workflowStates(teamId: string): Promise<WorkflowStateSummary[]> {
    const sdk = await this.sdk();
    const rows = await allPages((after) =>
      sdk.workflowStates({
        filter: { team: { id: { eq: teamId } } },
        ...(after ? { after } : {}),
      }),
    );
    return [...new Map(rows.map((row) => [row.id, row])).values()];
  }

  async setIssueState(
    issueId: string,
    teamId: string,
    name: string,
  ): Promise<WriteResult> {
    const state = await this.findWorkflowState(teamId, name);
    const result = await (
      await this.sdk()
    ).updateIssue(issueId, { stateId: state.id });
    if (!result.success)
      throw new Error(
        `Linear could not set issue ${issueId} to ${state.name}.`,
      );
    return { id: issueId, success: true };
  }

  async maintainAttachment(
    options: MaintainAttachmentOptions,
  ): Promise<WriteResult> {
    const sdk = await this.sdk();
    const find = async () => {
      const rows = await allPages((after) =>
        sdk.attachments(options.issueId, options.url, after),
      );
      if (
        new Set(rows.map((row) => row.id)).size > 1 ||
        rows.some(
          (row) => row.issueId !== options.issueId || row.url !== options.url,
        )
      ) {
        throw new Error(
          'Linear attachment identity mismatch; inspect the issue and stable Rocky URL.',
        );
      }
      return rows[0];
    };
    let row = await find();
    if (!row) {
      let failure: unknown;
      try {
        const result = await sdk.createAttachment(options);
        if (!result.success)
          failure = new Error('Linear refused the Rocky attachment.');
      } catch (error) {
        failure = error;
      }
      row = await find();
      if (!row)
        throw (
          failure ??
          new Error(
            'Linear attachment could not be verified; retry with the same stable issue URL.',
          )
        );
    }
    const { issueId: _issueId, url: _url, ...metadata } = options;
    const updated = await sdk.updateAttachment(row.id, metadata);
    if (!updated.success)
      throw new Error(`Linear could not update Rocky attachment ${row.id}.`);
    return { id: row.id, success: true };
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
