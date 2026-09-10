import type { ApiError } from '@rocky/local-contracts';

const VERSION = __ROCKY_VERSION__;

export async function api<T>(
  path: string,
  mismatch: (v: string | null) => void,
  init?: RequestInit,
): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set('x-rocky-client-version', VERSION);
  const response = await fetch(path, { ...init, headers });
  const version = response.headers.get('x-rocky-version');
  if (version && version !== VERSION) mismatch(version);
  if (!response.ok)
    throw Object.assign(new Error(`Request failed (${response.status})`), {
      response,
    });
  return response.json() as Promise<T>;
}
export async function apiError(error: unknown, fallback: string) {
  const response = (error as { response?: Response }).response;
  if (!response) return fallback;
  try {
    const body = (await response.json()) as ApiError;
    return body.error ? `${fallback} ${body.error}` : fallback;
  } catch {
    return fallback;
  }
}
