import { createJiti } from 'jiti';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { z } from '@rocky/sdk';

const schemas = await createJiti(import.meta.url, {
  alias: {
    '@rocky/sdk': new URL('../../../sdk/src/index.ts', import.meta.url)
      .pathname,
  },
}).import<{
  Plan: z.ZodType;
  Complaint: z.ZodType;
  FixReportFor: (complaints: { id: string }[]) => z.ZodType;
  ReviewFor: (key: string, ticket?: string) => z.ZodType;
  Checks: z.ZodType;
  CheckResultsFor: (checks: { id: string }[], root: string) => z.ZodType;
}>(new URL('../../content/.rocky/schemas.ts', import.meta.url).pathname);

describe('shipped output contracts', () => {
  it('requires exactly one Resolution for every Complaint, including disagreements', () => {
    const report = schemas.FixReportFor([
      { id: 'review/1/c1' },
      { id: 'review/1/c2' },
    ]);
    const fixed = {
      id: 'review/1/c1',
      status: 'fixed',
      note: 'Added a regression test.',
    };
    const disagreed = {
      id: 'review/1/c2',
      status: 'disagreed',
      note: 'The empty case is valid.',
    };
    expect(report.safeParse({ resolutions: [fixed, disagreed] }).success).toBe(
      true,
    );
    for (const resolutions of [
      [fixed],
      [fixed, fixed],
      [fixed, { ...disagreed, id: 'unknown' }],
    ]) {
      expect(report.safeParse({ resolutions }).success).toBe(false);
    }
    expect(
      schemas.FixReportFor([]).safeParse({ resolutions: [] }).success,
    ).toBe(true);
  });

  it('keeps Plans prediction-free and Complaints anchored, blocking and uniquely namespaced', () => {
    expect(
      schemas.Plan.safeParse({ steps: ['Handle the empty case.'] }).success,
    ).toBe(true);
    expect(
      schemas.Plan.safeParse({ steps: ['Handle it.'], files: ['a.ts'] })
        .success,
    ).toBe(false);
    expect(
      schemas.Plan.safeParse({ steps: ['Handle it.'], touchesUi: true })
        .success,
    ).toBe(false);
    expect(
      schemas.Complaint.safeParse({ id: 'c1', text: 'Missing behavior.' })
        .success,
    ).toBe(false);
    expect(
      schemas.Complaint.safeParse({
        id: 'c1',
        file: '../escape',
        text: 'Missing.',
      }).success,
    ).toBe(false);
    const complaint = {
      id: 'review/2/c1',
      file: 'src/a.ts',
      text: 'Empty input crashes.',
    };
    const review = schemas.ReviewFor('review/2');
    expect(review.safeParse({ complaints: [complaint] }).success).toBe(true);
    for (const complaints of [
      [complaint, complaint],
      [{ ...complaint, id: 'review/1/c1' }],
      [{ ...complaint, severity: 'low' }],
    ]) {
      expect(review.safeParse({ complaints }).success).toBe(false);
    }
    const compliance = schemas.ReviewFor(
      'review/2',
      'Empty input returns an empty list.',
    );
    expect(compliance.safeParse({ complaints: [complaint] }).success).toBe(
      false,
    );
    expect(
      compliance.safeParse({
        complaints: [
          { ...complaint, quote: 'Empty input returns an empty list.' },
        ],
      }).success,
    ).toBe(true);
    expect(
      compliance.safeParse({
        complaints: [{ ...complaint, quote: 'Use tabs.' }],
      }).success,
    ).toBe(false);
  });

  it('requires a complete UI sweep and confines real screenshots by canonical path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rocky-content-schema-'));
    try {
      const root = join(dir, 'screenshots');
      await mkdir(root);
      await writeFile(
        join(root, 'actual.png'),
        'test artifact, not live evidence',
      );
      await writeFile(join(dir, 'outside.png'), 'outside');
      await symlink(join(dir, 'outside.png'), join(root, 'escape.png'));
      const schema = schemas.CheckResultsFor([{ id: 'a' }, { id: 'b' }], root);
      const ok = {
        id: 'a',
        verdict: 'ok',
        note: 'Visible.',
        screenshots: [join(root, 'actual.png')],
        observations: [],
      };
      const problem = {
        id: 'b',
        verdict: 'problem',
        note: 'Clipped.',
        screenshots: [],
        observations: [
          {
            url: 'http://localhost:4000',
            text: 'Button clipped.',
            screenshots: [join(root, 'actual.png')],
          },
        ],
      };
      expect(schema.safeParse({ results: [ok, problem] }).success).toBe(true);
      for (const results of [
        [ok],
        [ok, ok],
        [ok, { ...problem, id: 'unknown' }],
        [ok, { ...problem, observations: [] }],
      ]) {
        expect(schema.safeParse({ results }).success).toBe(false);
      }
      for (const path of [
        join(root, 'missing.png'),
        join(root, 'escape.png'),
        root,
        join(dir, 'outside.png'),
      ]) {
        expect(
          schema.safeParse({
            results: [{ ...ok, screenshots: [path] }, problem],
          }).success,
        ).toBe(false);
      }
      expect(
        schemas.Checks.safeParse({
          checks: [
            { id: 'a', url: '/', action: 'Open page.', expected: 'Visible.' },
            { id: 'a', url: '/', action: 'Open page.', expected: 'Visible.' },
          ],
        }).success,
      ).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
