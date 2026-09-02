/**
 * The endpoint self-ping (NG-578, NG-600).
 *
 * Rocky manages no tunnel. The public URL is bring-your-own — a cloudflared
 * named tunnel, an ngrok static domain, a Tailscale Funnel — and the only thing
 * the daemon does about it is notice, on boot and every hour, whether Linear
 * could still reach it. There is deliberately **no remediation**: a dead
 * endpoint costs latency and nothing else, because boot reconciliation and the
 * parked polls carry the data (NG-576 §6). What a dead endpoint would really
 * cost is Linear disabling the webhook after enough failed deliveries, and
 * that is a thing to be told about early, not repaired automatically.
 *
 * The ping goes out through the public URL and back in, so it tests the whole
 * path rather than the local socket. It compares an instance id, which is the
 * part that catches the failure a plain 200 would hide: a `publicUrl` copied
 * from a colleague, or a stale tunnel still pointed at another machine.
 */

/** The one route the ping needs, and the only other one the tunnel must front. */
export const PING_PATH = '/api/ping';

/** Boot, then hourly (NG-578). */
export const SELF_PING_INTERVAL_MS = 60 * 60 * 1000;

/** How long to wait before calling the round trip dead. */
const PING_TIMEOUT_MS = 10_000;

export interface EndpointHealth {
  /** False when no `publicUrl` is set — a machine mid-setup, not a failure. */
  configured: boolean;
  ok: boolean;
  /** ISO 8601, absent until the first check has run. */
  checkedAt?: string;
  /** Why it failed, in the words `rocky status` and the UI banner show. */
  detail?: string;
}

export interface EndpointMonitorOptions {
  /** Read per check, so a hot config reload moves the endpoint. */
  publicUrl(): string | undefined;
  /** This daemon's identity for the round trip. */
  instanceId: string;
  fetch?: typeof fetch;
  now?: () => number;
  logWarn?(message: string): void;
  logInfo?(message: string): void;
  intervalMs?: number;
}

export interface EndpointMonitor {
  readonly health: EndpointHealth;
  /** One ping now. */
  check(): Promise<EndpointHealth>;
  /** Ping now, then every hour. */
  start(): void;
  stop(): void;
}

async function ping(
  url: string,
  instanceId: string,
  doFetch: typeof fetch,
): Promise<string | undefined> {
  const target = `${url.replace(/\/$/, '')}${PING_PATH}`;

  let response: Response;
  try {
    response = await doFetch(target, {
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
      headers: { accept: 'application/json' },
    });
  } catch (error) {
    return `could not be reached — ${error instanceof Error ? error.message : String(error)}`;
  }

  if (!response.ok) {
    return `answered ${response.status}`;
  }

  let body: { instanceId?: string };
  try {
    body = (await response.json()) as { instanceId?: string };
  } catch {
    return 'answered something that is not this daemon — check that the tunnel points at Rocky';
  }

  if (body.instanceId !== instanceId) {
    // A 200 from the wrong daemon is the failure a status code cannot show:
    // Linear's webhooks would be arriving on somebody else's machine.
    return 'reached another daemon, not this one — the tunnel is pointed somewhere else';
  }

  return undefined;
}

export function createEndpointMonitor(
  options: EndpointMonitorOptions,
): EndpointMonitor {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const intervalMs = options.intervalMs ?? SELF_PING_INTERVAL_MS;
  const logWarn = options.logWarn ?? (() => undefined);
  const logInfo = options.logInfo ?? (() => undefined);

  let health: EndpointHealth = { configured: false, ok: false };
  let timer: NodeJS.Timeout | undefined;
  /** Whether the current outage has already been logged. */
  let warned = false;

  const check = async (): Promise<EndpointHealth> => {
    const publicUrl = options.publicUrl();

    if (!publicUrl) {
      health = { configured: false, ok: false };
      return health;
    }

    const failure = await ping(publicUrl, options.instanceId, doFetch);
    const checkedAt = new Date(now()).toISOString();

    if (failure) {
      health = { configured: true, ok: false, checkedAt, detail: failure };
      // Once per outage, not once an hour for as long as it lasts: an hourly
      // repeat of the same line is what makes a log stop being read.
      if (!warned) {
        logWarn(
          `Linear cannot reach Rocky: ${publicUrl} ${failure}. Webhooks will not arrive until it is back; Runs still progress, more slowly. See docs/public-endpoint.md.`,
        );
        warned = true;
      }
      return health;
    }

    health = { configured: true, ok: true, checkedAt };
    if (warned) {
      logInfo(`${publicUrl} is reachable again.`);
      warned = false;
    }
    return health;
  };

  return {
    get health() {
      return health;
    },
    check,
    start() {
      void check();
      timer = setInterval(() => void check(), intervalMs);
      // The ping must never be the reason the process stays alive.
      timer.unref?.();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}
