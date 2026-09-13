import { z } from 'zod';
const text = z.string().trim().min(1).max(16000);
const screenshot = z.object({ path: text, caption: text });
export const ReviewFocus = z.object({
  category: z.enum([
    'security',
    'permissions',
    'routes',
    'data',
    'compatibility',
    'operations',
    'testing',
    'other',
  ]),
  title: text,
  summary: text,
  status: z.enum(['attention', 'verified', 'not-applicable']),
  evidence: z.array(text).min(1).max(30),
});
export const KeyChange = z.object({
  title: text,
  summary: text,
  files: z.array(text).min(1).max(30),
  diff: z.string().max(2_000_000),
  annotations: z
    .array(
      z.object({
        text,
        file: text,
        line: z.number().int().positive().optional(),
      }),
    )
    .max(30),
});
export const ReportContent = z
  .object({
    title: text,
    summary: text,
    deliverable: z.string().max(2_000_000).optional(),
    files: z.array(z.object({ path: text, status: text })).optional(),
    keyChanges: z.array(KeyChange).max(30).optional(),
    reviewFocus: z.array(ReviewFocus).max(30).optional(),
    problems: z
      .array(z.object({ problem: text, solution: text }))
      .min(1)
      .max(30),
    diagrams: z
      .array(z.object({ title: text, description: text, mermaid: text }))
      .max(8),
    verification: z.array(text).max(50),
    limitations: z.array(text).max(250),
    visuallyReviewable: z.boolean(),
    visuals: z
      .array(
        z
          .object({
            group: text,
            variant: text,
            description: text,
            status: z.enum(['captured', 'unavailable']),
            reason: z.string().max(16000),
            screenshots: z.array(screenshot).max(30),
          })
          .refine(
            (v) =>
              v.status === 'captured'
                ? v.screenshots.length > 0
                : v.reason.trim().length > 0 && v.screenshots.length === 0,
            'Each visual variant needs screenshots or an explicit reason it could not be captured',
          ),
      )
      .max(100),
  })
  .refine(
    (r) => !r.visuallyReviewable || r.visuals.length > 0,
    'Visually reviewable changes require a variant inventory',
  );

export const StoredReport = z.object({
  ...ReportContent.shape,
  id: z.string().regex(/^r_[0-9a-f]{32}$/),
  runId: z.string().regex(/^[\w.-]+$/),
  createdAt: z.iso.datetime(),
  pr: z
    .object({
      repo: text,
      number: z.number().int().positive(),
      url: z.url({ protocol: /^https?$/ }),
      headSha: z.string().regex(/^[0-9a-f]{40,64}$/),
      baseSha: z.string().regex(/^[0-9a-f]{40,64}$/),
    })
    .optional(),
  visuals: z
    .array(
      z.object({
        group: text,
        variant: text,
        description: text,
        status: z.enum(['captured', 'unavailable']),
        reason: z.string().max(16000),
        screenshots: z
          .array(
            z.object({
              id: z.string().regex(/^s_[0-9a-f]{32}$/),
              caption: text,
            }),
          )
          .max(30),
      }),
    )
    .max(100),
});
