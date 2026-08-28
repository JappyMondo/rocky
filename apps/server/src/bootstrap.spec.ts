import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Controller, Post, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { FastifyRequest } from 'fastify';
import { APP_OPTIONS, createApp, DOCS_PATH } from './bootstrap';
import { DEFAULT_LOG_LEVEL, DEFAULT_PORT } from './config/deploy-config';
import type { DeployConfig } from './config/deploy-config';

const CONFIG: DeployConfig = {
  encryptionKey: Buffer.alloc(32, 7).toString('base64'),
  baseUrl: 'https://rocky.example.com',
  port: DEFAULT_PORT,
  logLevel: DEFAULT_LOG_LEVEL,
};

describe('the application as the container runs it', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createApp({ ...CONFIG, logLevel: 'fatal' });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers the health endpoint under the api prefix', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  describe('the API docs', () => {
    it('render Swagger UI at /api/docs without authentication', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/${DOCS_PATH}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.body).toContain('swagger-ui');
    });

    it('list the health endpoint in the OpenAPI document', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/${DOCS_PATH}-json`,
      });

      expect(response.statusCode).toBe(200);

      const document = response.json();
      expect(document.paths['/api/health'].get.summary).toBe('Liveness check');
    });
  });
});

describe('serving the built web app', () => {
  let webRoot: string;
  let app: NestFastifyApplication;

  beforeAll(async () => {
    // A stand-in for what `nx build server` copies into dist/public.
    webRoot = mkdtempSync(join(tmpdir(), 'rocky-web-'));
    mkdirSync(join(webRoot, 'assets'));
    writeFileSync(
      join(webRoot, 'index.html'),
      '<!doctype html><title>Rocky</title>',
    );
    writeFileSync(
      join(webRoot, 'assets', 'index.js'),
      'export const rocky = true;',
    );

    app = await createApp({ ...CONFIG, logLevel: 'fatal' }, { webRoot });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
    rmSync(webRoot, { recursive: true, force: true });
  });

  it('serves index.html at the root', async () => {
    const response = await app.inject({ method: 'GET', url: '/' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('<title>Rocky</title>');
  });

  it('serves hashed static assets', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/assets/index.js',
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('export const rocky');
  });

  it('falls back to index.html on a deep link the SPA routes itself', async () => {
    const response = await app.inject({ method: 'GET', url: '/repos/42' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('<title>Rocky</title>');
  });

  it('still answers the API and its docs', async () => {
    expect(
      (await app.inject({ method: 'GET', url: '/api/health' })).json(),
    ).toEqual({ status: 'ok' });
    expect(
      (await app.inject({ method: 'GET', url: `/${DOCS_PATH}` })).statusCode,
    ).toBe(200);
  });

  it('leaves an unknown API route an honest 404, not a page of HTML', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/nope' });

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/json');
  });

  it('does not answer a non-GET with the SPA', async () => {
    const response = await app.inject({ method: 'POST', url: '/repos/42' });

    expect(response.statusCode).toBe(404);
  });
});

describe('raw body access', () => {
  /** Webhook signature verification will need exactly these bytes. */
  @Controller('echo-raw')
  class EchoRawController {
    @Post()
    echo(@Req() request: RawBodyRequest<FastifyRequest>): {
      raw: string | undefined;
      parsed: unknown;
    } {
      return {
        raw: request.rawBody?.toString('utf-8'),
        parsed: request.body,
      };
    }
  }

  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [EchoRawController],
    }).compile();

    // The same APP_OPTIONS the container boots with, so dropping rawBody from
    // it fails here rather than months later on the first webhook.
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
      { ...APP_OPTIONS, logger: false },
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('is enabled in the options the container starts with', () => {
    expect(APP_OPTIONS.rawBody).toBe(true);
  });

  it('hands the handler the bytes exactly as they arrived', async () => {
    // Key order and spacing differ from anything JSON.stringify would produce,
    // which is the whole reason a signature needs the raw bytes.
    const payload = '{"zebra":1,  "apple":2}';

    const response = await app.inject({
      method: 'POST',
      url: '/echo-raw',
      headers: { 'content-type': 'application/json' },
      payload,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      raw: payload,
      parsed: { zebra: 1, apple: 2 },
    });
  });
});
