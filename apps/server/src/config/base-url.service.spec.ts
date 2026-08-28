import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Controller, Get } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { BaseUrlService } from './base-url.service';
import { DeployConfigModule } from './deploy-config.module';
import { DEFAULT_LOG_LEVEL, DEFAULT_PORT } from './deploy-config';
import type { DeployConfig } from './deploy-config';

const CONFIGURED_BASE_URL = 'https://rocky.example.com';

function deployConfig(baseUrl = CONFIGURED_BASE_URL): DeployConfig {
  return {
    encryptionKey: Buffer.alloc(32, 7).toString('base64'),
    baseUrl,
    port: DEFAULT_PORT,
    logLevel: DEFAULT_LOG_LEVEL,
  };
}

describe('BaseUrlService', () => {
  it('builds absolute URLs from the configured base URL', () => {
    const service = new BaseUrlService(deployConfig());

    expect(service.get()).toBe(CONFIGURED_BASE_URL);
    expect(service.absoluteUrl('/api/webhooks/github')).toBe(
      'https://rocky.example.com/api/webhooks/github',
    );
    expect(service.absoluteUrl('api/webhooks/github')).toBe(
      'https://rocky.example.com/api/webhooks/github',
    );
    expect(service.absoluteUrl('')).toBe(CONFIGURED_BASE_URL);
  });

  it('keeps a sub-path base URL so Rocky can live under a shared host', () => {
    const service = new BaseUrlService(
      deployConfig('https://example.com/rocky'),
    );

    expect(service.absoluteUrl('/reports/abc')).toBe(
      'https://example.com/rocky/reports/abc',
    );
  });

  describe('when a request carries headers that claim a different host', () => {
    @Controller('link')
    class LinkController {
      constructor(private readonly baseUrlService: BaseUrlService) {}

      @Get()
      generate(): { url: string } {
        return { url: this.baseUrlService.absoluteUrl('/reports/abc') };
      }
    }

    let app: NestFastifyApplication;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [DeployConfigModule.forRoot(deployConfig())],
        controllers: [LinkController],
      }).compile();

      app = moduleRef.createNestApplication<NestFastifyApplication>(
        new FastifyAdapter(),
        { logger: false },
      );
      await app.init();
      await app.getHttpAdapter().getInstance().ready();
    });

    afterAll(async () => {
      await app.close();
    });

    // A Public report link never expires, so a link built from a header a
    // caller controls would be wrong forever.
    it('ignores them entirely and uses the configured base URL', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/link',
        headers: {
          host: 'attacker.example.net',
          'x-forwarded-host': 'attacker.example.net',
          'x-forwarded-proto': 'http',
          'x-forwarded-for': '10.0.0.1',
          forwarded: 'host=attacker.example.net;proto=http',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        url: 'https://rocky.example.com/reports/abc',
      });
    });
  });

  // The behavioural test above only covers the one call site it exercises.
  // This one holds the rule for the whole server as it grows.
  it('is the only way to build absolute URLs: no source reads Host or X-Forwarded-*', () => {
    const forbidden = [
      /x-forwarded/i,
      /['"`]forwarded['"`]/i,
      /headers\s*(?:\.\s*host\b|\[\s*['"`]host['"`]\s*\])/i,
      /\b(?:req|request)\s*\.\s*host(?:name)?\b/i,
      // Fastify's own switch for believing X-Forwarded-* headers.
      /trustProxy/i,
    ];

    const offenders = productionSources().filter((file) => {
      const code = withoutComments(readFileSync(file, 'utf-8'));
      return forbidden.some((pattern) => pattern.test(code));
    });

    expect(offenders).toEqual([]);
  });
});

/**
 * Documentation is allowed to name the headers it forbids — BaseUrlService's
 * own doc comment does exactly that — so only real code is scanned.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

/** Every non-spec TypeScript file under the server's src directory. */
function productionSources(dir = join(__dirname, '..')): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      return productionSources(full);
    }
    const isSpec = entry.name.endsWith('.spec.ts');
    return entry.isFile() && entry.name.endsWith('.ts') && !isSpec
      ? [full]
      : [];
  });
}
