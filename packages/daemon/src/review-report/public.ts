import { createHmac, randomBytes } from 'node:crypto';
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { ReviewReport } from '@rocky/local-contracts';
import type { RockyPaths } from '../config/paths.js';
import { writeAtomic, SECRET_MODE } from '../atomic-write.js';
import { LocalArtifacts } from '../local-api/artifacts.js';
import { resolveWebRoot } from '../web-root.js';

const TOKEN = /^[0-9a-f]{64}$/;
const SHOT = /^s_[0-9a-f]{32}$/;
const ASSET = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,199}\.(?:js|css|woff2)$/;
export const REVIEW_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const missing = () =>
  Object.assign(new Error('Review not found.'), { statusCode: 404 });
interface SharedReview {
  report: ReviewReport;
  images: Record<string, string>;
}

/** A link grants read access to one immutable report and its copied images. */
export class PublicReviews {
  private readonly root: string;
  constructor(private readonly paths: RockyPaths) {
    this.root = join(paths.root, 'shared-reviews');
  }
  async token(runId: string, reportId: string) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const path = join(this.root, '.key');
    const temp = join(this.root, `.key-${randomBytes(16).toString('hex')}`);
    await writeFile(temp, randomBytes(32), { flag: 'wx', mode: SECRET_MODE });
    try {
      // Publish a complete key atomically, even when separate run workers race.
      await link(temp, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    } finally {
      await unlink(temp);
    }
    const key = await readFile(path);
    if (key.length !== 32) throw new Error('Invalid review sharing key.');
    return createHmac('sha256', key)
      .update(JSON.stringify([runId, reportId]))
      .digest('hex');
  }
  async url(runId: string, reportId: string, origin: string) {
    return `${origin.replace(/\/$/, '')}/reviews/${await this.token(runId, reportId)}`;
  }
  async publish(report: ReviewReport, origin: string) {
    const token = await this.token(report.runId, report.id);
    const dir = join(this.root, token);
    const artifacts = new LocalArtifacts(this.paths);
    const images: Record<string, string> = {};
    for (const shot of report.visuals.flatMap((v) => v.screenshots)) {
      if (!SHOT.test(shot.id)) throw new Error('Invalid review image.');
      const { bytes, contentType } = await artifacts.readScreenshot(shot.id);
      await writeAtomic(join(dir, 'images', shot.id), bytes, SECRET_MODE);
      images[shot.id] = contentType;
    }
    // Only the document is shared: no journal, transcripts, run controls or raw artifact API.
    await writeAtomic(
      join(dir, 'report.json'),
      JSON.stringify({ report, images }),
      SECRET_MODE,
    );
    return this.url(report.runId, report.id, origin);
  }
  async read(token: string): Promise<SharedReview> {
    if (!TOKEN.test(token)) throw missing();
    try {
      return JSON.parse(
        await readFile(join(this.root, token, 'report.json'), 'utf8'),
      );
    } catch {
      throw missing();
    }
  }
  async image(token: string, id: string) {
    if (!SHOT.test(id)) throw missing();
    const share = await this.read(token);
    if (!Object.hasOwn(share.images, id)) throw missing();
    try {
      return {
        bytes: await readFile(join(this.root, token, 'images', id)),
        contentType: share.images[id],
      };
    } catch {
      throw missing();
    }
  }
}

export async function registerPublicReviews(
  app: FastifyInstance,
  shares: PublicReviews,
  webRoot = resolveWebRoot(),
) {
  await app.register(async (publicApp) => {
    publicApp.addHook('onRequest', async (_request, reply) => {
      reply
        .header('cache-control', 'no-store')
        .header('x-content-type-options', 'nosniff')
        .header('referrer-policy', 'no-referrer')
        .header('x-robots-tag', 'noindex, nofollow')
        .header('content-security-policy', REVIEW_CSP);
    });
    publicApp.get<{ Params: { token: string } }>(
      '/reviews/:token',
      { logLevel: 'silent' },
      async (request, reply) => {
        await shares.read(request.params.token);
        if (!webRoot) throw missing();
        return reply
          .type('text/html; charset=utf-8')
          .send(await readFile(join(webRoot, 'review', 'review.html')));
      },
    );
    publicApp.get<{ Params: { token: string } }>(
      '/reviews/:token/report.json',
      { logLevel: 'silent' },
      async (request) => (await shares.read(request.params.token)).report,
    );
    publicApp.get<{ Params: { token: string; id: string } }>(
      '/reviews/:token/images/:id',
      { logLevel: 'silent' },
      async (request, reply) => {
        const image = await shares.image(
          request.params.token,
          request.params.id,
        );
        return reply.type(image.contentType).send(image.bytes);
      },
    );
    publicApp.get<{ Params: { file: string } }>(
      '/review-assets/assets/:file',
      { logLevel: 'silent' },
      async (request, reply) => {
        const file = request.params.file;
        if (!ASSET.test(file) || file.includes('..') || !webRoot)
          throw missing();
        const bytes = await readFile(
          join(webRoot, 'review', 'assets', file),
        ).catch(() => {
          throw missing();
        });
        return reply
          .type(
            file.endsWith('.js')
              ? 'text/javascript'
              : file.endsWith('.css')
                ? 'text/css'
                : 'font/woff2',
          )
          .send(bytes);
      },
    );
  });
}
