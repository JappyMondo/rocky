/**
 * The OAuth authorization-code flow, hand-written because `@linear/sdk` covers
 * only the authenticated API and none of the dance that gets a token (NG-600).
 *
 * Two of Linear's rules shape everything here (NG-567 §6): the install has to
 * be `actor=app` or Rocky is not delegatable at all, and `actor=app` cannot
 * also hold the `admin` scope — so Rocky can never manage its own webhook
 * records and takes the one the OAuth client carries instead. Access tokens
 * last 24 hours and refresh tokens rotate on use, which is why `refreshTokens`
 * returns a whole new pair rather than just an access token.
 */

/** Where the developer authorizes. */
const AUTHORIZE_URL = 'https://linear.app/oauth/authorize';

/** Where a code — or a refresh token — becomes an access token. */
const TOKEN_URL = 'https://api.linear.app/oauth/token';

/**
 * `read` is always present; `write` covers state moves, comments and uploads;
 * the two `app:` scopes are opt-in and are what make the app mentionable and
 * assignable. `admin` is deliberately absent — see the module note.
 */
export const ROCKY_SCOPES = [
  'read',
  'write',
  'app:assignable',
  'app:mentionable',
] as const;

/**
 * Refresh this long before the token actually dies. A Run that starts a call at
 * the last second would otherwise get a 401 it did nothing to deserve.
 */
const EXPIRY_SKEW_MS = 60_000;

export class LinearOAuthError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'LinearOAuthError';
  }
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds, or absent when Linear did not say. */
  expiresAt?: number;
  scope?: string;
}

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface OAuthDeps {
  fetch?: typeof fetch;
  now?: () => number;
}

/**
 * Where the developer is sent to authorize. `actor=app` is the whole point: it
 * installs Rocky as its own agent user rather than as the developer, which is
 * what puts "Rocky (Jan Jaap)" in the mention menu — and it is why a workspace
 * admin has to complete the install.
 */
export function authorizeUrl(
  options: Omit<OAuthClient, 'clientSecret'> & { state: string },
): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', options.clientId);
  url.searchParams.set('redirect_uri', options.redirectUri);
  url.searchParams.set('scope', ROCKY_SCOPES.join(','));
  url.searchParams.set('state', options.state);
  url.searchParams.set('actor', 'app');
  return url.toString();
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function postToken(
  form: Record<string, string>,
  deps: OAuthDeps,
): Promise<TokenResponse> {
  const doFetch = deps.fetch ?? fetch;

  let response: Response;
  try {
    response = await doFetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    });
  } catch (error) {
    throw new LinearOAuthError(
      `could not reach Linear to exchange the token — ${String(error)}`,
    );
  }

  let body: TokenResponse;
  try {
    body = (await response.json()) as TokenResponse;
  } catch {
    body = {};
  }

  if (!response.ok || !body.access_token) {
    // Linear's own words beat a bare status code: `invalid_grant` tells the
    // developer their code went stale, which is a different fix from a wrong
    // client secret.
    const said =
      body.error_description ?? body.error ?? `HTTP ${response.status}`;
    throw new LinearOAuthError(
      `Linear refused the token request: ${said}`,
      response.status,
    );
  }

  return body;
}

function toTokens(
  body: TokenResponse,
  deps: OAuthDeps,
  previousRefresh?: string,
): OAuthTokens {
  const now = (deps.now ?? Date.now)();

  return {
    accessToken: body.access_token as string,
    // Rotation means the new one replaces the old; a response without one
    // leaves the old one in place rather than dropping it.
    refreshToken: body.refresh_token ?? previousRefresh,
    expiresAt:
      body.expires_in === undefined ? undefined : now + body.expires_in * 1000,
    scope: body.scope,
  };
}

export async function exchangeCode(
  options: OAuthClient & { code: string },
  deps: OAuthDeps = {},
): Promise<OAuthTokens> {
  const body = await postToken(
    {
      grant_type: 'authorization_code',
      code: options.code,
      client_id: options.clientId,
      client_secret: options.clientSecret,
      redirect_uri: options.redirectUri,
    },
    deps,
  );

  return toTokens(body, deps);
}

export async function refreshTokens(
  options: OAuthClient & { refreshToken: string },
  deps: OAuthDeps = {},
): Promise<OAuthTokens> {
  const body = await postToken(
    {
      grant_type: 'refresh_token',
      refresh_token: options.refreshToken,
      client_id: options.clientId,
      client_secret: options.clientSecret,
    },
    deps,
  );

  return toTokens(body, deps, options.refreshToken);
}

/**
 * A token with no recorded expiry is treated as usable: Rocky learns it is not
 * from the 401, which is the same path a token that expired early takes.
 */
export function isExpired(
  tokens: Pick<OAuthTokens, 'expiresAt'>,
  now: () => number = Date.now,
): boolean {
  if (tokens.expiresAt === undefined) {
    return false;
  }
  return now() >= tokens.expiresAt - EXPIRY_SKEW_MS;
}
