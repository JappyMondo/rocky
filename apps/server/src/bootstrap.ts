import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import type { NestApplicationOptions } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
// Side-effect import: @fastify/static augments FastifyReply with sendFile().
import '@fastify/static';
import { AppModule } from './app/app.module';
import { SpaFallbackFilter } from './app/spa-fallback.filter';
import { nestLogLevels } from './config/logging';
import type { DeployConfig } from './config/deploy-config';

export const API_PREFIX = 'api';
export const DOCS_PATH = `${API_PREFIX}/docs`;

/**
 * The options the container starts the app with. Exported so tests exercise
 * the same object rather than restating it.
 */
export const APP_OPTIONS: NestApplicationOptions = {
  // Webhook signature verification needs the bytes exactly as they arrived,
  // and this has to be on before the first route parses a body. Retrofitting
  // it once routes exist means re-bootstrapping all of them.
  rawBody: true,
};

/** `nx build server` copies the built SPA next to the server bundle. */
export const DEFAULT_WEB_ROOT = join(__dirname, 'public');

export interface CreateAppOptions {
  /** Overridable so tests can point at a fixture bundle. */
  webRoot?: string;
}

/**
 * Builds the application exactly as the container runs it, minus listening.
 * Tests use this so what they assert is the real wiring rather than a
 * second copy of it that can drift.
 */
export async function createApp(
  config: DeployConfig,
  { webRoot = DEFAULT_WEB_ROOT }: CreateAppOptions = {},
): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.forRoot(config),
    new FastifyAdapter(),
    { ...APP_OPTIONS, logger: nestLogLevels(config.logLevel) },
  );

  app.setGlobalPrefix(API_PREFIX);
  serveApiDocs(app);
  serveWebApp(app, webRoot);

  return app;
}

/**
 * Swagger UI is public and unauthenticated on purpose: the docs describe the
 * API, they are not a way into it. Calls themselves still need a session or a
 * PAT.
 */
function serveApiDocs(app: NestFastifyApplication): void {
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Rocky API')
      .setDescription(
        'The JSON API behind Rocky. The web UI is just another client of it.',
      )
      .setVersion('0.0.1')
      .build(),
  );

  SwaggerModule.setup(DOCS_PATH, app, document);
}

/**
 * Serves the built SPA as static files. There is no SSR — this is an
 * authenticated dashboard, so SEO is irrelevant and rendering on the server
 * would buy nothing.
 */
function serveWebApp(app: NestFastifyApplication, webRoot: string): void {
  if (!existsSync(join(webRoot, 'index.html'))) {
    new Logger('Bootstrap').warn(
      `No web bundle at ${webRoot}; serving the API only. ` +
        'Run `nx build web`, or `nx serve web` for the dev server.',
    );
    return;
  }

  app.useStaticAssets({ root: webRoot, wildcard: false });

  // Nest owns Fastify's not-found handler, so the SPA fallback goes in a
  // filter rather than in setNotFoundHandler.
  app.useGlobalFilters(new SpaFallbackFilter(API_PREFIX, app.getHttpAdapter()));
}
