export const PING_PATH = '/api/ping';

/** Shared by Doctor and the hourly monitor. Never return remote text/errors. */
export async function readPingIdentity(
  baseUrl: string,
  doFetch: typeof fetch = fetch,
  timeoutMs = 10_000,
): Promise<string> {
  const target = new URL(PING_PATH, baseUrl);
  if (
    !['http:', 'https:'].includes(target.protocol) ||
    target.username ||
    target.password
  ) {
    throw new Error('use an HTTP(S) endpoint without URL credentials');
  }
  let response: Response;
  try {
    response = await doFetch(target.toString(), {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
      headers: { accept: 'application/json' },
    });
  } catch {
    throw new Error(
      'could not be reached (network error, redirect or timeout)',
    );
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`answered ${response.status}`);
  }
  let body: unknown;
  try {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for await (const chunk of response.body ?? []) {
      bytes += chunk.byteLength;
      if (bytes > 1024) throw new Error('ping body too large');
      chunks.push(chunk);
    }
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error(
      'did not return a complete JSON ping response within 1024 bytes and the timeout; check the tunnel target',
    );
  }
  if (
    !body ||
    typeof body !== 'object' ||
    !('instanceId' in body) ||
    typeof body.instanceId !== 'string' ||
    !body.instanceId
  ) {
    throw new Error(
      'answered something that is not this daemon: missing instance identity',
    );
  }
  return body.instanceId;
}
