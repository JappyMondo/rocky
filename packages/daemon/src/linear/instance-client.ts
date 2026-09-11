import type { RockyPaths } from '../config/paths.js';
import { updateCredentials } from '../config/store.js';
import { RockyLinearClient, LinearNotConfiguredError } from './client.js';
import { isExpired, refreshTokens } from './oauth.js';

/** One credential transaction spans read, remote rotation and atomic save. */
export function createInstanceLinearClient(
  paths: RockyPaths,
  options: {
    fetch?: typeof fetch;
    now?: () => number;
    signal?: AbortSignal;
  } = {},
): RockyLinearClient {
  return new RockyLinearClient({
    ...options,
    accessToken: async () => {
      const credentials = await updateCredentials(
        paths,
        async (current) => {
          const auth = current.linear;
          if (!auth?.accessToken)
            throw new LinearNotConfiguredError('access token');
          if (!isExpired(auth, options.now ?? Date.now)) return current;
          if (!auth.refreshToken || !auth.clientId || !auth.clientSecret)
            throw new LinearNotConfiguredError(
              'refresh token and client credentials',
            );
          const signal = AbortSignal.any([
            AbortSignal.timeout(15_000),
            ...(options.signal ? [options.signal] : []),
          ]);
          const tokens = await refreshTokens(
            {
              clientId: auth.clientId,
              clientSecret: auth.clientSecret,
              redirectUri: auth.redirectUri ?? '',
              refreshToken: auth.refreshToken,
            },
            {
              now: options.now,
              fetch: (input, init) =>
                (options.fetch ?? fetch)(input, {
                  ...init,
                  signal,
                  redirect: 'error',
                }),
            },
          );
          return { ...current, linear: { ...auth, ...tokens } };
        },
        { signal: options.signal },
      );
      const token = credentials.linear?.accessToken;
      if (!token) throw new LinearNotConfiguredError('access token');
      return token;
    },
  });
}
