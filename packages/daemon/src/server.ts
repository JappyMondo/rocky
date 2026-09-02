import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import fastifyStatic from '@fastify/static';
import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';

import {
  PING_PATH,
  createEndpointMonitor,
  type EndpointHealth,
  type EndpointMonitor,
} from './endpoint/monitor.js';
import {
  callbackPage,
  createOAuthCallbackBroker,
  type OAuthCallbackBroker,
} from './linear/callback.js';
import type { AgentSessionEventHandler } from './linear/events.js';
import { OAUTH_CALLBACK_PATH } from './linear/manifest.js';
import { registerLinearWebhook } from './linear/webhook.js';
import { DAEMON_VERSION, VERSION_HEADER } from './version.js';
import { resolveWebRoot } from './web-root.js';

/** 7625 spells ROCK on a keypad (NG-578). */
export const DEFAULT_PORT = 7625;

/**
 * Loopback by default. The bind address is configurable to any interface, with
 * the security warning living in the docs — there is no auth in v1 under any
 * binding (NG-578).
 */
export const DEFAULT_HOST = '127.0.0.1';

export interface DaemonOptions {
  host?: string;
  port?: number;
  /**
   * Where the built web shell lives. Omitted, the daemon finds it; `false`
   * runs the API alone, which is what a daemon installed without a built shell
   * beside it does.
   */
  webRoot?: string | false;
  /**
   * `true` for Fastify's default, or a pino option object. NG-594 wires the
   * daemon log through a redacting stream this way, so no secret in either
   * `~/.rocky` file can reach the file on disk.
   */
  logger?: FastifyServerOptions['logger'];
  /**
   * This daemon's identity, echoed by `/api/ping`. The self-ping compares it,
   * which is how a `publicUrl` pointed at somebody else's machine is caught.
   */
  instanceId?: string;
  /** The BYO public URL, read per self-ping so a config reload moves it. */
  publicUrl?: () => string | undefined;
  /** Linear's webhook signing secret, read per delivery (NG-578). */
  webhookSecret?: () => Promise<string | undefined>;
  /** The Run router. See `linear/events.ts` for why this is a seam. */
  onAgentSessionEvent?: AgentSessionEventHandler;
  /** Off in tests that drive the monitor themselves. */
  selfPing?: boolean;
  /** Injected for tests; the self-ping leaves the machine in production. */
  fetch?: typeof fetch;
}

export interface HealthStatus {
  status: 'ok';
  version: string;
  /** False when the daemon is running without a built web shell beside it. */
  web: boolean;
  /** What the web UI banners from and `rocky status` warns from (NG-600). */
  endpoint: EndpointHealth;
}

/** What `/api/ping` answers, and the only thing the tunnel exposes besides the webhook. */
export interface PingResponse {
  instanceId: string;
}

/** The pieces of a running daemon the setup wizard drives. */
export interface DaemonExtras {
  instanceId: string;
  endpoint: EndpointMonitor;
  oauth: OAuthCallbackBroker;
}

/**
 * The Fastify instance and the handles that outlive a request. Two fields
 * rather than one decorated app, because the monitor and the broker are things
 * the *process* drives — the self-ping runs on a timer and the broker is
 * awaited by a wizard — and neither belongs to a route.
 */
export interface CreatedDaemon extends DaemonExtras {
  app: FastifyInstance;
}

export async function createDaemon(
  options: DaemonOptions = {},
): Promise<CreatedDaemon> {
  const app = Fastify({ logger: options.logger ?? false });
  const webRoot =
    options.webRoot === undefined ? resolveWebRoot() : options.webRoot;

  const instanceId = options.instanceId ?? randomUUID();
  const endpoint = createEndpointMonitor({
    publicUrl: options.publicUrl ?? (() => undefined),
    instanceId,
    fetch: options.fetch,
    logWarn: (message) => app.log.warn(message),
    logInfo: (message) => app.log.info(message),
  });
  const oauth = createOAuthCallbackBroker();

  // The CLI reads this off every response to spot a version mismatch, so it
  // belongs on the whole surface rather than on the health route alone.
  app.addHook('onSend', async (_request, reply) => {
    reply.header(VERSION_HEADER, DAEMON_VERSION);
  });

  app.get('/api/health', async (): Promise<HealthStatus> => {
    return {
      status: 'ok',
      version: DAEMON_VERSION,
      web: Boolean(webRoot),
      endpoint: endpoint.health,
    };
  });

  /**
   * The self-ping's target, and the only route besides the webhook that has to
   * be reachable through the public URL. It answers an opaque id and nothing
   * else — enough to prove the tunnel lands on *this* daemon, and no use to
   * anyone who finds the URL.
   */
  app.get(PING_PATH, async (): Promise<PingResponse> => {
    return { instanceId };
  });

  await registerLinearWebhook(app, {
    webhookSecret: options.webhookSecret ?? (async () => undefined),
    onEvent: options.onAgentSessionEvent ?? (() => undefined),
  });

  app.get(OAUTH_CALLBACK_PATH, async (request, reply) => {
    const query = request.query as {
      code?: string;
      state?: string;
      error?: string;
    };
    const delivered = oauth.deliver(query);

    return reply
      .status(delivered ? 200 : 400)
      .type('text/html; charset=utf-8')
      .send(
        callbackPage(
          delivered
            ? 'Rocky is authorized. You can close this tab and go back to the terminal.'
            : 'Rocky was not waiting for this authorization. Start again with <code>rocky setup</code>.',
        ),
      );
  });

  if (webRoot) {
    await app.register(fastifyStatic, { root: webRoot });

    // The web shell is a single-page app: a deep link is a client route, not a
    // missing file. API paths keep their honest 404, and so does anything that
    // did not ask for HTML — a browser's automatic /favicon.ico should get a
    // 404 rather than an HTML body labelled as an icon.
    app.setNotFoundHandler((request, reply) => {
      const wantsHtml = request.headers.accept?.includes('text/html') ?? false;

      if (
        request.method !== 'GET' ||
        request.url.startsWith('/api/') ||
        !wantsHtml
      ) {
        return reply.status(404).send({ error: 'Not found' });
      }
      return reply.sendFile('index.html');
    });
  }

  return { app, instanceId, endpoint, oauth };
}

export interface RunningDaemon extends DaemonExtras {
  host: string;
  /** The port actually bound, which differs from the request when it was 0. */
  port: number;
  url: string;
  /** The daemon's own logger, so the process that started it can use it too. */
  log: FastifyInstance['log'];
  close(): Promise<void>;
}

export async function startDaemon(
  options: DaemonOptions = {},
): Promise<RunningDaemon> {
  const host = options.host ?? DEFAULT_HOST;

  const { app, ...rocky } = await createDaemon(options);
  await app.listen({ host, port: options.port ?? DEFAULT_PORT });

  const port = (app.server.address() as AddressInfo).port;

  // Boot, then hourly. It runs after `listen`, because the first thing the ping
  // does is come back in through the socket it is checking.
  if (options.selfPing !== false) {
    rocky.endpoint.start();
  }

  return {
    host,
    port,
    url: `http://${host}:${port}`,
    log: app.log,
    ...rocky,
    close: async () => {
      rocky.endpoint.stop();
      await app.close();
    },
  };
}
