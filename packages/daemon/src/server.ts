import type { AddressInfo } from 'node:net';

import fastifyStatic from '@fastify/static';
import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';

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
}

export interface HealthStatus {
  status: 'ok';
  version: string;
  /** False when the daemon is running without a built web shell beside it. */
  web: boolean;
}

export async function createDaemon(
  options: DaemonOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });
  const webRoot =
    options.webRoot === undefined ? resolveWebRoot() : options.webRoot;

  // The CLI reads this off every response to spot a version mismatch, so it
  // belongs on the whole surface rather than on the health route alone.
  app.addHook('onSend', async (_request, reply) => {
    reply.header(VERSION_HEADER, DAEMON_VERSION);
  });

  app.get('/api/health', async (): Promise<HealthStatus> => {
    return { status: 'ok', version: DAEMON_VERSION, web: Boolean(webRoot) };
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

  return app;
}

export interface RunningDaemon {
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

  const app = await createDaemon(options);
  await app.listen({ host, port: options.port ?? DEFAULT_PORT });

  const port = (app.server.address() as AddressInfo).port;

  return {
    host,
    port,
    url: `http://${host}:${port}`,
    log: app.log,
    close: () => app.close(),
  };
}
