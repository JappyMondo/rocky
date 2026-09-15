import Fastify from 'fastify';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { ReviewReport } from '@rocky/local-contracts';
import { rockyPaths } from '../config/paths.js';
import { LocalArtifacts } from '../local-api/artifacts.js';
import { PublicReviews, registerPublicReviews, REVIEW_CSP } from './public.js';

it('shares only a saved document and its own copied images, with stable private tokens and no app controls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rocky-public-review-'));
  const paths = rockyPaths(root);
  const artifacts = new LocalArtifacts(paths);
  const shares = new PublicReviews(paths);
  const app = Fastify();
  try {
    const shots = paths.run('TEST-1').screenshotsDir;
    await mkdir(shots, { recursive: true });
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    await writeFile(join(shots, 'one.png'), bytes);
    const shot = await artifacts.registerScreenshot(
      'TEST-1',
      'one.png',
      'Visible result',
    );
    const report: ReviewReport = {
      id: `r_${'a'.repeat(32)}`,
      runId: 'TEST-1',
      createdAt: '2026-09-15T10:00:00Z',
      title: 'A clear result',
      summary: 'The requested change.',
      problems: [{ problem: 'Unclear result', solution: 'Show the result.' }],
      diagrams: [],
      verification: [],
      limitations: [],
      visuallyReviewable: true,
      visuals: [
        {
          group: 'Page',
          variant: 'Default',
          description: 'Result',
          status: 'captured',
          reason: '',
          screenshots: [shot],
        },
      ],
    };
    await artifacts.saveReport('TEST-1', report);
    const origin = 'https://review.example.test';
    const urls = await Promise.all(
      Array.from({ length: 8 }, () =>
        new PublicReviews(paths).url(report.runId, report.id, origin),
      ),
    );
    expect(new Set(urls).size).toBe(1);
    const url = await shares.publish(report, origin);
    expect(url).toBe(urls[0]);
    expect(url).toMatch(
      /^https:\/\/review.example.test\/reviews\/[0-9a-f]{64}$/,
    );
    expect(url).not.toContain('TEST-1');
    const other = {
      ...report,
      id: `r_${'b'.repeat(32)}`,
      visuals: [],
      visuallyReviewable: false,
    };
    const otherUrl = await shares.publish(other, origin);
    expect(otherUrl).not.toBe(url);
    const webRoot = join(root, 'web');
    await mkdir(join(webRoot, 'review', 'assets'), { recursive: true });
    await writeFile(
      join(webRoot, 'review', 'review.html'),
      '<html>Standalone review</html>',
    );
    await writeFile(
      join(webRoot, 'review', 'assets', 'mermaid.core-abc.js'),
      'console.log("review")',
    );
    await registerPublicReviews(app, shares, webRoot);
    const path = new URL(url).pathname;
    const page = await app.inject(path);
    expect(page.body).toContain('Standalone review');
    expect(page.headers['content-security-policy']).toBe(REVIEW_CSP);
    expect(page.headers['referrer-policy']).toBe('no-referrer');
    expect(page.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect((await app.inject(`${path}/report.json`)).json()).toEqual(report);
    expect((await app.inject(`${path}/images/${shot.id}`)).rawPayload).toEqual(
      bytes,
    );
    expect(
      (await app.inject(`${new URL(otherUrl).pathname}/images/${shot.id}`))
        .statusCode,
    ).toBe(404);
    expect(
      (await app.inject(`/reviews/${'f'.repeat(64)}/report.json`)).statusCode,
    ).toBe(404);
    expect(
      (await app.inject('/review-assets/assets/mermaid.core-abc.js'))
        .statusCode,
    ).toBe(200);
    expect(
      (await app.inject('/review-assets/assets/missing.js')).statusCode,
    ).toBe(404);
    for (const route of [
      '/api/runs',
      '/api/settings',
      '/api/screenshots/' + shot.id,
      '/reviews',
      '/api/shutdown',
    ])
      expect((await app.inject(route)).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: path })).statusCode).toBe(
      404,
    );
    // Sharing survives routine run retention. Removing a share revokes just that link.
    await rm(paths.run('TEST-1').dir, { recursive: true });
    expect((await app.inject(`${path}/images/${shot.id}`)).rawPayload).toEqual(
      bytes,
    );
    await rm(join(root, 'shared-reviews', path.split('/').at(-1)!), {
      recursive: true,
    });
    expect((await app.inject(path)).statusCode).toBe(404);
    expect((await app.inject(new URL(otherUrl).pathname)).statusCode).toBe(200);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
