import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  exchangeAuthorization,
  extractWWWAuthenticateParams,
  registerClient,
  refreshAuthorization,
  selectClientAuthMethod,
  startAuthorization,
  type AddClientAuthentication,
} from '@modelcontextprotocol/sdk/client/auth.js';
import { OAuthError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { checkResourceAllowed } from '@modelcontextprotocol/sdk/shared/auth-utils.js';
import {
  type OAuthClientInformationMixed,
  type OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { z } from 'zod';

import { rockyPaths, type RockyPaths } from '../config/paths.js';
import { updateCredentials } from '../config/store.js';
import { ConfigError } from '../config/schema.js';
import {
  expandMcpConfig,
  selectMcpServers,
  type McpConfig,
  type McpServer,
} from './config.js';

export class McpAuthError extends Error {
  readonly fatal = true;
  readonly fix: string;
  constructor(
    readonly server: string,
    detail = 'authorization was rejected',
  ) {
    const command = `rocky mcp login ${/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(server) ? server : `-- '${server.replaceAll("'", "'\\''")}'`}`;
    super(
      `MCP server ${JSON.stringify(server)}: ${detail}; run \`${command}\`.`,
    );
    this.name = 'McpAuthError';
    this.fix = command;
  }
}

/** Call on a Harness-reported MCP 401/unauthorized, not on arbitrary tool errors. */
export function mcpUnauthorized(server: string): McpAuthError {
  return new McpAuthError(server);
}

export interface McpAuthOptions {
  paths?: RockyPaths;
  fetch?: typeof fetch;
  now?: () => number;
  signal?: AbortSignal;
  requestTimeoutMs?: number;
}

export interface McpLoginOptions extends McpAuthOptions {
  openBrowser(url: URL): Promise<void>;
  env?: NodeJS.ProcessEnv;
  clientId?: string;
  clientSecret?: string;
  /** Pre-registered clients may need a fixed loopback port. DCR uses port 0. */
  callbackPort?: number;
  timeoutMs?: number;
}

const tokensSchema = z.object({
  access_token: z.string().regex(/^[A-Za-z0-9._~+/-]+=*$/),
  token_type: z.string().refine((value) => value.toLowerCase() === 'bearer'),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().finite().nonnegative().optional(),
  scope: z.string().optional(),
});

const clientSchema = z.object({
  client_id: z.string().min(1),
  client_secret: z.string().min(1).optional(),
  token_endpoint_auth_method: z
    .enum(['none', 'client_secret_basic', 'client_secret_post'])
    .optional(),
});

const storedSchema = z.object({
  issuer: z.string(),
  authorizationEndpoint: z.string(),
  tokenEndpoint: z.string(),
  resource: z.string(),
  client: clientSchema,
  authMethods: z.array(z.string()).optional(),
  tokens: tokensSchema,
  expiresAt: z.number().finite().nonnegative().optional(),
});
type StoredMcpAuth = z.infer<typeof storedSchema>;

function oauthUrl(value: string | URL, name: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new McpAuthError(name, 'invalid OAuth URL');
  }
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new McpAuthError(
      name,
      'OAuth requires HTTPS (HTTP only on loopback), without URL credentials or fragments',
    );
  }
  return url;
}

function oauthFetch(name: string, options: McpAuthOptions): typeof fetch {
  return (input, init) => {
    oauthUrl(input instanceof Request ? input.url : String(input), name);
    const signals = [AbortSignal.timeout(options.requestTimeoutMs ?? 10_000)];
    if (options.signal) signals.push(options.signal);
    if (init?.signal) signals.push(init.signal);
    // Never forward an authorization code, refresh token or client secret on a redirect.
    return (options.fetch ?? fetch)(input, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.any(signals),
    });
  };
}

function authFailure(name: string, error: unknown): McpAuthError {
  if (error instanceof McpAuthError) return error;
  // SDK errors can contain entire HTTP bodies. Only its fixed error code is safe.
  if (error instanceof OAuthError)
    return new McpAuthError(name, `OAuth ${error.errorCode}`);
  return new McpAuthError(
    name,
    'OAuth failed; check connectivity, client settings and credential-file permissions',
  );
}

function withTokens(
  auth: Omit<StoredMcpAuth, 'tokens'>,
  tokens: OAuthTokens,
  now: number,
): StoredMcpAuth {
  const parsed = tokensSchema.parse(tokens);
  return {
    ...auth,
    tokens: parsed,
    expiresAt:
      parsed.expires_in === undefined
        ? undefined
        : now + parsed.expires_in * 1000,
  };
}

function tokenAuthentication(
  name: string,
  client: OAuthClientInformationMixed,
  resource: string,
): AddClientAuthentication {
  return (headers, form, _url, metadata) => {
    // Preserve the exact RFC 8707 indicator, including a pathless origin without '/'.
    form.set('resource', resource);
    const supported = metadata?.token_endpoint_auth_methods_supported ?? [];
    const method = selectClientAuthMethod(client, supported);
    if (supported.length > 0 && !supported.includes(method))
      throw new McpAuthError(
        name,
        'unsupported OAuth client authentication method',
      );
    if (method === 'client_secret_basic') {
      if (!client.client_secret)
        throw new McpAuthError(name, 'OAuth client requires --client-secret');
      // RFC 6749 section 2.3.1 encodes each field BEFORE joining it with a colon.
      const encode = (value: string) =>
        new URLSearchParams({ v: value }).toString().slice(2);
      headers.set(
        'Authorization',
        `Basic ${Buffer.from(`${encode(client.client_id)}:${encode(client.client_secret)}`).toString('base64')}`,
      );
    } else {
      form.set('client_id', client.client_id);
      if (method === 'client_secret_post' && client.client_secret)
        form.set('client_secret', client.client_secret);
    }
  };
}

/** CLI-only OAuth. No Workflow import, daemon route, or MCP process is involved. */
export async function loginMcpServer(
  config: McpConfig,
  name: string,
  options: McpLoginOptions,
): Promise<{ server: string; url: string }> {
  const selected = selectMcpServers(config, [name])[0];
  if (selected.config.type === 'stdio')
    throw new ConfigError(
      config.file,
      `MCP server ${name} is stdio; it has no remote OAuth login.`,
    );
  // Login has no Run values; unrelated browser declarations must not be expanded.
  const remote = expandMcpConfig(
    { file: config.file, mcpServers: { [name]: selected.config } },
    { env: options.env },
  ).mcpServers[name];
  if (remote.type === 'stdio') throw new Error('unreachable');
  const signal = AbortSignal.any([
    AbortSignal.timeout(options.timeoutMs ?? 120_000),
    ...(options.signal ? [options.signal] : []),
  ]);
  const doFetch = oauthFetch(name, { ...options, signal });
  const url = oauthUrl(remote.url, name).href;
  try {
    signal.throwIfAborted();
    const response = await doFetch(url, { headers: remote.headers });
    const challenge = extractWWWAuthenticateParams(response);
    await response.body?.cancel();
    const resource = await discoverOAuthProtectedResourceMetadata(
      url,
      { resourceMetadataUrl: challenge.resourceMetadataUrl },
      doFetch,
    );
    if (
      !checkResourceAllowed({
        requestedResource: url,
        configuredResource: resource.resource,
      })
    )
      throw new McpAuthError(
        name,
        'OAuth resource metadata does not match this MCP server',
      );
    const issuer = resource.authorization_servers?.[0];
    if (!issuer)
      throw new McpAuthError(
        name,
        'resource metadata names no authorization server',
      );
    oauthUrl(issuer, name);
    const metadata = await discoverAuthorizationServerMetadata(issuer, {
      fetchFn: doFetch,
    });
    if (!metadata || metadata.issuer !== issuer)
      throw new McpAuthError(
        name,
        'OAuth metadata is missing or its issuer does not match',
      );
    oauthUrl(metadata.authorization_endpoint, name);
    oauthUrl(metadata.token_endpoint, name);
    if (!options.clientId && !metadata.registration_endpoint)
      throw new McpAuthError(
        name,
        'authorization server has no dynamic client registration; use --client-id / --client-secret, or skip Rocky auth with a ${VAR} Authorization header in mcp.json',
      );
    if (options.clientSecret && !options.clientId)
      throw new McpAuthError(name, '--client-secret requires --client-id');

    const state = randomBytes(32).toString('base64url');
    let resolveCode!: (code: string) => void;
    let rejectCode!: (error: Error) => void;
    const code = new Promise<string>((resolve, reject) => {
      resolveCode = resolve;
      rejectCode = reject;
    });
    // The callback may arrive while the browser opener is still resolving.
    void code.catch(() => undefined);
    let callback: URL;
    const callbackServer = createServer((req, res) => {
      res.setHeader('cache-control', 'no-store');
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      let received: URL;
      try {
        received = new URL(req.url ?? '/', callback);
      } catch {
        res.writeHead(400).end('Invalid callback URL.');
        return;
      }
      if (
        req.method !== 'GET' ||
        received.pathname !== '/callback' ||
        req.headers.host !== callback.host
      ) {
        res.writeHead(404).end('Not found.');
        return;
      }
      const receivedState = Buffer.from(
        received.searchParams.get('state') ?? '',
      );
      const expectedState = Buffer.from(state);
      if (
        received.searchParams.getAll('state').length !== 1 ||
        receivedState.length !== expectedState.length ||
        !timingSafeEqual(receivedState, expectedState)
      ) {
        res.writeHead(400).end('Invalid OAuth state.');
        return;
      }
      const authorizationCode = received.searchParams.get('code');
      if (received.searchParams.has('error')) {
        res.writeHead(400).end('Authorization denied. Return to the terminal.');
        rejectCode(new McpAuthError(name, 'authorization was denied'));
      } else if (
        received.searchParams.getAll('code').length === 1 &&
        authorizationCode
      ) {
        res.end('Authorization received. Return to the terminal.');
        resolveCode(authorizationCode);
      } else {
        res.writeHead(400).end('Missing authorization code.');
      }
    });
    const abort = () =>
      rejectCode(new McpAuthError(name, 'login timed out or was cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    try {
      await new Promise<void>((resolve, reject) => {
        callbackServer.once('error', reject);
        callbackServer.listen(options.callbackPort ?? 0, '127.0.0.1', resolve);
      });
      const address = callbackServer.address();
      if (!address || typeof address === 'string')
        throw new Error('missing callback address');
      callback = new URL(`http://127.0.0.1:${address.port}/callback`);
      const scope = challenge.scope ?? resource.scopes_supported?.join(' ');
      let client: OAuthClientInformationMixed;
      if (options.clientId) {
        client = {
          client_id: options.clientId,
          ...(options.clientSecret && { client_secret: options.clientSecret }),
        };
      } else {
        client = await registerClient(issuer, {
          metadata,
          scope,
          clientMetadata: {
            client_name: 'Rocky',
            redirect_uris: [callback.href],
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            token_endpoint_auth_method: 'none',
          },
          fetchFn: doFetch,
        });
      }
      const { authorizationUrl, codeVerifier } = await startAuthorization(
        issuer,
        {
          metadata,
          clientInformation: client,
          redirectUrl: callback,
          state,
          scope,
        },
      );
      authorizationUrl.searchParams.set('resource', resource.resource);
      signal.throwIfAborted();
      const [, authorizationCode] = await Promise.all([
        options.openBrowser(authorizationUrl),
        code,
      ]);
      await updateCredentials(
        options.paths ?? rockyPaths(),
        async (current) => {
          const tokens = await exchangeAuthorization(issuer, {
            metadata,
            clientInformation: client,
            authorizationCode,
            codeVerifier,
            redirectUri: callback.href,
            addClientAuthentication: tokenAuthentication(
              name,
              client,
              resource.resource,
            ),
            fetchFn: doFetch,
          });
          const stored = withTokens(
            {
              issuer,
              authorizationEndpoint: metadata.authorization_endpoint,
              tokenEndpoint: metadata.token_endpoint,
              resource: resource.resource,
              client: clientSchema.parse(client),
              authMethods: metadata.token_endpoint_auth_methods_supported,
            },
            tokens,
            (options.now ?? Date.now)(),
          );
          return {
            ...current,
            mcp: { ...current.mcp, [url]: stored },
          };
        },
      );
      return { server: name, url };
    } finally {
      signal.removeEventListener('abort', abort);
      callbackServer.closeAllConnections();
      await new Promise<void>((resolve) =>
        callbackServer.close(() => resolve()),
      );
    }
  } catch (error) {
    throw authFailure(name, error);
  }
}

async function accessToken(
  name: string,
  url: string,
  options: McpAuthOptions,
  forceRefresh: boolean,
): Promise<string | undefined> {
  let token: string | undefined;
  try {
    await updateCredentials(options.paths ?? rockyPaths(), async (current) => {
      options.signal?.throwIfAborted();
      const key = new URL(url).href;
      if (!Object.hasOwn(current.mcp, key)) return current;
      const stored = storedSchema.parse(current.mcp[key]);
      oauthUrl(key, name);
      oauthUrl(stored.issuer, name);
      oauthUrl(stored.tokenEndpoint, name);
      if (
        !checkResourceAllowed({
          requestedResource: key,
          configuredResource: stored.resource,
        })
      )
        throw new McpAuthError(
          name,
          'stored OAuth resource does not match this MCP server',
        );
      const now = (options.now ?? Date.now)();
      if (
        !forceRefresh &&
        (stored.expiresAt === undefined || now < stored.expiresAt - 60_000)
      ) {
        token = stored.tokens.access_token;
        return current;
      }
      if (!stored.tokens.refresh_token)
        throw new McpAuthError(name, 'stored token cannot refresh');
      const tokens = await refreshAuthorization(stored.issuer, {
        metadata: {
          issuer: stored.issuer,
          authorization_endpoint: stored.authorizationEndpoint,
          token_endpoint: stored.tokenEndpoint,
          response_types_supported: ['code'],
          token_endpoint_auth_methods_supported: stored.authMethods,
        },
        clientInformation: stored.client,
        refreshToken: stored.tokens.refresh_token,
        addClientAuthentication: tokenAuthentication(
          name,
          stored.client,
          stored.resource,
        ),
        fetchFn: oauthFetch(name, options),
      });
      const refreshed = withTokens(stored, tokens, (options.now ?? Date.now)());
      token = refreshed.tokens.access_token;
      return { ...current, mcp: { ...current.mcp, [key]: refreshed } };
    });
    return token;
  } catch (error) {
    throw authFailure(name, error);
  }
}

/** Call once immediately before EACH live attempt, never journal the returned secrets. */
export async function resolveMcpServers(
  config: McpConfig,
  names: readonly string[],
  options: McpAuthOptions = {},
): Promise<McpServer[]> {
  const servers = selectMcpServers(config, names);
  for (const server of servers) {
    if (server.config.type === 'stdio') continue;
    if (
      Object.keys(server.config.headers ?? {}).some(
        (key) => key.toLowerCase() === 'authorization',
      )
    ) {
      oauthUrl(server.config.url, server.name);
      continue;
    }
    const token = await accessToken(
      server.name,
      server.config.url,
      options,
      false,
    );
    if (token)
      server.config.headers = {
        ...server.config.headers,
        Authorization: `Bearer ${token}`,
      };
  }
  return servers;
}

/** Refresh every stored snapshot-named remote token, even if currently unexpired.
 * No request is made for stdio or never-logged-in servers. Returns safe names only.
 */
export async function preflightMcp(
  config: McpConfig,
  options: McpAuthOptions = {},
): Promise<string[]> {
  const signal = AbortSignal.any([
    AbortSignal.timeout(30_000),
    ...(options.signal ? [options.signal] : []),
  ]);
  const checked: string[] = [];
  const seen = new Set<string>();
  for (const { name, config: server } of selectMcpServers(
    config,
    Object.keys(config.mcpServers),
  )) {
    if (server.type === 'stdio') continue;
    const key = new URL(server.url).href;
    if (seen.has(key)) continue;
    seen.add(key);
    if (await accessToken(name, key, { ...options, signal }, true))
      checked.push(name);
  }
  return checked;
}
