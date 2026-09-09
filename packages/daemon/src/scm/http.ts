import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { ScmPr as Pr, ScmRefusal, ScmRefusalReason } from '@rocky/sdk';

export interface ScmRepository {
  id: string;
  project: string;
  baseBranch: string;
}

export interface ScmAdapterOptions {
  repo: ScmRepository;
  branch: string;
  token: string;
  apiUrl?: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

export class ScmError extends Error {
  constructor(
    readonly refusal: ScmRefusal,
    readonly status?: number,
  ) {
    super(`${refusal.repo}: ${refusal.message} ${refusal.fix}`);
    this.name = 'ScmError';
  }
}

export function refuse(
  repo: string,
  reason: ScmRefusalReason,
  message: string,
  fix: string,
  pr?: Pr,
): ScmError {
  return new ScmError({
    refused: true,
    repo,
    reason,
    message,
    fix,
    ...(pr ? { pr } : {}),
  });
}

interface HttpState {
  notBefore: number;
  cache: Map<string, { value: unknown; headers: Headers }>;
}
// Disposable optimizations shared by Boot clients, not a second durable Run store.
// Scope to the transport and credential digest so tokens/accounts never share cache data.
const states = new WeakMap<typeof fetch, Map<string, HttpState>>();

export class ScmHttp {
  readonly root: string;
  private readonly responseHeaders = new Map<string, Headers>();
  private readonly state: HttpState;
  constructor(
    readonly options: ScmAdapterOptions,
    defaultUrl: string,
  ) {
    const url = new URL(options.apiUrl ?? defaultUrl);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== 'https:' &&
        !(
          url.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
        ))
    ) {
      throw new Error(
        'SCM API requires HTTPS, or HTTP on loopback, without URL credentials',
      );
    }
    this.root = url.href.replace(/\/$/, '');
    if (
      !options.token ||
      options.repo.project
        .split('/')
        .some((part) => !part || part === '.' || part === '..')
    )
      throw new Error('SCM requires a token and an unambiguous project path');
    const transport = options.fetch ?? fetch;
    let scoped = states.get(transport);
    if (!scoped) {
      scoped = new Map();
      states.set(transport, scoped);
    }
    const key = `${this.root}:${createHash('sha256').update(options.token).digest('hex')}`;
    let state = scoped.get(key);
    if (!state) {
      state = { notBefore: 0, cache: new Map() };
      const oldestScope = scoped.keys().next().value;
      if (scoped.size >= 256 && oldestScope !== undefined)
        scoped.delete(oldestScope);
      scoped.set(key, state);
    }
    this.state = state;
  }

  private async response(
    method: string,
    path: string,
    body?: unknown,
    signal = this.options.signal,
    log = false,
    timeoutMs = 10_000,
  ): Promise<Response> {
    signal?.throwIfAborted();
    this.options.signal?.throwIfAborted();
    if (this.state.notBefore > Date.now())
      throw refuse(
        this.options.repo.id,
        'rate_limited',
        `Platform rate limit until ${new Date(this.state.notBefore).toISOString()}.`,
        'Keep the Step Parked; retry after the platform reset.',
      );
    const cached =
      method === 'GET' && !log ? this.state.cache.get(path) : undefined;
    const etag = cached?.headers.get('etag');
    const response = await (this.options.fetch ?? fetch)(
      `${this.root}${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${this.options.token}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...(etag ? { 'If-None-Match': etag } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: log ? 'manual' : 'error',
        signal: AbortSignal.any([
          AbortSignal.timeout(timeoutMs),
          ...(signal ? [signal] : []),
          ...(this.options.signal ? [this.options.signal] : []),
        ]),
      },
    );
    signal?.throwIfAborted();
    this.options.signal?.throwIfAborted();
    this.responseHeaders.set(path, response.headers);
    const after = response.headers.get('retry-after');
    const reset =
      response.headers.get('x-ratelimit-reset') ??
      response.headers.get('ratelimit-reset');
    const remaining =
      response.headers.get('x-ratelimit-remaining') ??
      response.headers.get('ratelimit-remaining');
    const limited =
      response.status === 429 ||
      (response.status === 403 && (after !== null || remaining === '0'));
    if (limited || remaining === '0') {
      const afterTime =
        after === null
          ? NaN
          : /^\d+$/.test(after)
            ? Date.now() + Number(after) * 1000
            : Date.parse(after);
      const resetTime = reset ? Number(reset) * 1000 : NaN;
      this.state.notBefore = Math.max(
        Date.now() + (limited ? 1000 : 0),
        Number.isFinite(afterTime)
          ? afterTime
          : Number.isFinite(resetTime)
            ? resetTime
            : Date.now() + 60_000,
      );
    }
    if (limited) {
      await response.body?.cancel();
      throw new ScmError(
        {
          refused: true,
          repo: this.options.repo.id,
          reason: 'rate_limited',
          message: `Platform rate limit until ${new Date(this.state.notBefore).toISOString()}.`,
          fix: 'Keep the Step Parked; retry after the platform reset.',
        },
        response.status,
      );
    }
    if (response.status === 304 && cached) {
      this.responseHeaders.set(path, cached.headers);
      return Response.json(cached.value, { headers: cached.headers });
    }
    if (!response.ok && !(log && response.status === 302)) {
      await response.body?.cancel();
      throw new ScmError(
        {
          refused: true,
          repo: this.options.repo.id,
          reason:
            response.status === 401 || response.status === 403
              ? 'permission_denied'
              : response.status === 409
                ? 'head_changed'
                : [405, 406, 422].includes(response.status)
                  ? 'blocked_status'
                  : 'unavailable',
          message: `SCM API returned HTTP ${response.status}.`,
          fix: 'Verify token API permissions and repository access without changing branch policy.',
        },
        response.status,
      );
    }
    if (method !== 'GET') this.state.cache.clear();
    return response;
  }

  header(path: string, name: string): string | null {
    return this.responseHeaders.get(path)?.get(name) ?? null;
  }

  async request<T>(
    method: string,
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
    signal = this.options.signal,
    timeoutMs?: number,
  ): Promise<T> {
    const response = await this.response(
      method,
      path,
      body,
      signal,
      false,
      timeoutMs,
    );
    let value: unknown;
    try {
      value = response.status === 204 ? undefined : await response.json();
    } catch {
      signal?.throwIfAborted();
      throw refuse(
        this.options.repo.id,
        'invalid_response',
        'SCM returned invalid JSON.',
        'Verify the server API and response format.',
      );
    }
    if (method === 'GET' && response.headers.has('etag')) {
      const oldestCached = this.state.cache.keys().next().value;
      if (this.state.cache.size >= 256 && oldestCached !== undefined)
        this.state.cache.delete(oldestCached);
      this.state.cache.set(path, { value, headers: response.headers });
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success)
      throw refuse(
        this.options.repo.id,
        'invalid_response',
        'SCM response did not match the platform schema.',
        'Verify the server version and supported API.',
      );
    return parsed.data;
  }

  async list<T>(
    path: string,
    schema: z.ZodType<T>,
    field?: string,
    signal = this.options.signal,
  ): Promise<T[]> {
    const result: T[] = [];
    for (let page = 1; page <= 1000; page++) {
      const shape = field
        ? z
            .object({ [field]: z.array(schema) })
            .transform((value) => value[field])
        : z.array(schema);
      const values = await this.request(
        'GET',
        `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`,
        shape,
        undefined,
        signal,
      );
      result.push(...values);
      if (values.length < 100) return result;
    }
    throw refuse(
      this.options.repo.id,
      'unavailable',
      'SCM pagination exceeded its bound.',
      'Narrow the requested resource.',
    );
  }

  async logTail(path: string, lines: number): Promise<string> {
    if (!Number.isSafeInteger(lines) || lines < 0 || lines > 10000)
      throw new Error('logTailLines must be between 0 and 10000');
    if (lines === 0) return '';
    let response = await this.response(
      'GET',
      path,
      undefined,
      this.options.signal,
      true,
    );
    if (response.status === 302) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || new URL(location).protocol !== 'https:')
        throw refuse(
          this.options.repo.id,
          'invalid_response',
          'Invalid job-log redirect.',
          'Verify the platform log endpoint.',
        );
      this.options.signal?.throwIfAborted();
      // Signed log URLs are not API endpoints. Never forward the developer token.
      response = await (this.options.fetch ?? fetch)(location, {
        redirect: 'error',
        signal: AbortSignal.any([
          AbortSignal.timeout(10_000),
          ...(this.options.signal ? [this.options.signal] : []),
        ]),
      });
      if (!response.ok)
        throw refuse(
          this.options.repo.id,
          'unavailable',
          'Job log download failed.',
          'Verify log retention and access.',
        );
    }
    let tail = '';
    if (!response.body) return tail;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        this.options.signal?.throwIfAborted();
        const chunk = await reader.read();
        tail += decoder.decode(chunk.value, { stream: !chunk.done });
        // Keep a bounded suffix while downloading, including a possible final newline.
        tail = tail
          .split('\n')
          .slice(-(lines + 1))
          .join('\n')
          .slice(-2_000_000);
        if (chunk.done) break;
      }
    } finally {
      await reader.cancel();
    }
    return tail.replace(/\n$/, '').split('\n').slice(-lines).join('\n');
  }

  async graphql<T>(
    query: string,
    variables: unknown,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const envelope = await this.request(
      'POST',
      this.root.endsWith('/api/v3') ? '/../graphql' : '/graphql',
      z.object({
        data: z.unknown().optional(),
        errors: z
          .array(z.object({ type: z.string().optional(), message: z.string() }))
          .optional(),
      }),
      { query, variables },
    );
    if (envelope.errors?.length) {
      const denied = envelope.errors.some((error) =>
        ['FORBIDDEN', 'UNAUTHORIZED'].includes(error.type ?? ''),
      );
      throw refuse(
        this.options.repo.id,
        denied ? 'permission_denied' : 'blocked_status',
        envelope.errors
          .map((error) =>
            error.message.replaceAll(this.options.token, '[redacted]'),
          )
          .join('; ')
          .slice(0, 1000),
        'Resolve the named platform blocker or merge manually; Rocky never bypasses it.',
      );
    }
    const parsed = schema.safeParse(envelope.data);
    if (!parsed.success)
      throw refuse(
        this.options.repo.id,
        'invalid_response',
        'GraphQL response did not match the platform schema.',
        'Verify server API support.',
      );
    return parsed.data;
  }
}
