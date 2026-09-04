/**
 * The OAuth half of AC1: the wizard runs the flow locally and writes
 * `credentials.json`. Everything here is the part Linear's SDK does not cover —
 * the authorize URL with `actor=app`, the code exchange, and the rotating
 * refresh that a 24-hour access token makes mandatory (NG-567 §6).
 */
import { describe, expect, it, vi } from 'vitest';

import {
  LinearOAuthError,
  ROCKY_SCOPES,
  authorizeUrl,
  exchangeCode,
  isExpired,
  refreshTokens,
} from './oauth.js';

const app = {
  clientId: 'client-123',
  clientSecret: 'secret-456',
  redirectUri: 'http://127.0.0.1:7625/api/linear/oauth/callback',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('the authorize URL', () => {
  it('installs as the app, which is what makes Rocky delegatable', () => {
    const url = new URL(authorizeUrl({ ...app, state: 'st' }));

    expect(url.origin + url.pathname).toBe(
      'https://linear.app/oauth/authorize',
    );
    expect(url.searchParams.get('actor')).toBe('app');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe(app.clientId);
    expect(url.searchParams.get('redirect_uri')).toBe(app.redirectUri);
    expect(url.searchParams.get('state')).toBe('st');
  });

  it('asks for the scopes an agent needs and no admin scope', () => {
    const scope = new URL(
      authorizeUrl({ ...app, state: 'st' }),
    ).searchParams.get('scope');

    expect(scope).toBe(ROCKY_SCOPES.join(','));
    // `actor=app` and `admin` are mutually exclusive (NG-567 §6); asking for it
    // would fail the install rather than degrade it.
    expect(scope).not.toContain('admin');
    expect(ROCKY_SCOPES).toContain('app:assignable');
    expect(ROCKY_SCOPES).toContain('app:mentionable');
  });
});

describe('exchanging the code', () => {
  it('posts the form Linear expects and returns the tokens', async () => {
    const doFetch = vi.fn(async () =>
      jsonResponse({
        access_token: 'at',
        refresh_token: 'rt',
        expires_in: 86_400,
        scope: 'read,write',
      }),
    );

    const tokens = await exchangeCode(
      { ...app, code: 'the-code' },
      { fetch: doFetch as unknown as typeof fetch, now: () => 1_000_000 },
    );

    expect(tokens).toEqual({
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: 1_000_000 + 86_400_000,
      scope: 'read,write',
    });

    const [url, init] = doFetch.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://api.linear.app/oauth/token');
    expect(init.method).toBe('POST');

    const form = new URLSearchParams(init.body as string);
    expect(Object.fromEntries(form)).toEqual({
      grant_type: 'authorization_code',
      code: 'the-code',
      client_id: app.clientId,
      client_secret: app.clientSecret,
      redirect_uri: app.redirectUri,
    });
  });

  it('reports what Linear said rather than a bare status code', async () => {
    const doFetch = vi.fn(async () =>
      jsonResponse({ error: 'invalid_grant' }, 400),
    );

    await expect(
      exchangeCode(
        { ...app, code: 'stale' },
        { fetch: doFetch as unknown as typeof fetch },
      ),
    ).rejects.toThrow(/invalid_grant/);
  });

  it('says the network failed rather than blaming the code', async () => {
    const doFetch = vi.fn(async () => {
      throw new Error('ENOTFOUND api.linear.app');
    });

    await expect(
      exchangeCode(
        { ...app, code: 'x' },
        { fetch: doFetch as unknown as typeof fetch },
      ),
    ).rejects.toThrow(/could not reach Linear/);
  });

  it('survives a response that is not JSON at all', async () => {
    const doFetch = vi.fn(
      async () => new Response('<html>502 Bad Gateway</html>', { status: 502 }),
    );

    await expect(
      exchangeCode(
        { ...app, code: 'x' },
        { fetch: doFetch as unknown as typeof fetch },
      ),
    ).rejects.toThrow(/HTTP 502/);
  });

  it('refuses a 200 that carries no access token', async () => {
    const doFetch = vi.fn(async () => jsonResponse({ token_type: 'Bearer' }));

    await expect(
      exchangeCode(
        { ...app, code: 'x' },
        { fetch: doFetch as unknown as typeof fetch },
      ),
    ).rejects.toThrow(LinearOAuthError);
  });

  it('leaves expiry unknown when Linear does not say', async () => {
    const doFetch = vi.fn(async () => jsonResponse({ access_token: 'at' }));

    const tokens = await exchangeCode(
      { ...app, code: 'x' },
      { fetch: doFetch as unknown as typeof fetch },
    );

    expect(tokens.expiresAt).toBeUndefined();
  });

  it('is a LinearOAuthError, so the wizard can offer the retry', async () => {
    const doFetch = vi.fn(async () => jsonResponse({ error: 'nope' }, 401));

    await expect(
      exchangeCode(
        { ...app, code: 'x' },
        { fetch: doFetch as unknown as typeof fetch },
      ),
    ).rejects.toBeInstanceOf(LinearOAuthError);
  });
});

describe('refreshing', () => {
  it('sends the refresh grant and keeps the new refresh token', async () => {
    const doFetch = vi.fn(async () =>
      jsonResponse({
        access_token: 'at2',
        refresh_token: 'rt2',
        expires_in: 86_400,
      }),
    );

    const tokens = await refreshTokens(
      { ...app, refreshToken: 'rt1' },
      { fetch: doFetch as unknown as typeof fetch, now: () => 0 },
    );

    expect(tokens.accessToken).toBe('at2');
    // Linear rotates refresh tokens, so keeping the old one loses the machine
    // its install at the next refresh.
    expect(tokens.refreshToken).toBe('rt2');

    const form = new URLSearchParams(
      (doFetch.mock.calls[0] as unknown as [string, RequestInit])[1]
        .body as string,
    );
    expect(form.get('grant_type')).toBe('refresh_token');
    expect(form.get('refresh_token')).toBe('rt1');
  });

  it('keeps the old refresh token when Linear returns none', async () => {
    const doFetch = vi.fn(async () =>
      jsonResponse({ access_token: 'at2', expires_in: 60 }),
    );

    const tokens = await refreshTokens(
      { ...app, refreshToken: 'rt1' },
      { fetch: doFetch as unknown as typeof fetch, now: () => 0 },
    );

    expect(tokens.refreshToken).toBe('rt1');
  });
});

describe('expiry', () => {
  it('treats a token as expired a minute early, so a call never races the clock', () => {
    expect(isExpired({ expiresAt: 100_000 }, () => 0)).toBe(false);
    expect(isExpired({ expiresAt: 100_000 }, () => 99_999)).toBe(true);
    expect(isExpired({ expiresAt: 100_000 }, () => 40_000)).toBe(true);
  });

  it('treats a token with no known expiry as usable until it is refused', () => {
    expect(isExpired({}, () => 0)).toBe(false);
  });
});
