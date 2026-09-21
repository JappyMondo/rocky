import { z } from '@rocky/sdk';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';

export const Plan = z
  .object({ steps: z.array(z.string().min(1)).min(1) })
  .strict();

export const Complaint = z
  .object({
    id: z.string().min(1),
    severity: z.enum(['nit-pick', 'should-fix', 'must-fix']).optional(),
    file: z
      .string()
      .min(1)
      .refine(
        (path) =>
          !isAbsolute(path) &&
          !/^[A-Za-z]:|\\|\0/.test(path) &&
          !path.split('/').includes('..'),
        'Anchor to a workspace-relative file or directory',
      ),
    line: z.number().int().positive().optional(),
    text: z.string().min(1),
    rebuttal: z.string().min(1).optional(),
    quote: z.string().min(1).optional(),
  })
  .strict();

export type Complaint = z.infer<typeof Complaint>;

export function ComplaintFor(key: string) {
  return Complaint.extend({
    id: z
      .string()
      .refine(
        (id) =>
          id.startsWith(`${key}/`) &&
          /^[a-zA-Z0-9_-]+$/.test(id.slice(key.length + 1)),
        `Use ${key}/<local-id>`,
      ),
  });
}

export function ReviewFor(
  key: string,
  ticket?: string,
  previous: readonly { id: string }[] = [],
) {
  const complaint =
    ticket === undefined
      ? ComplaintFor(key).extend({
          severity: z
            .enum(['nit-pick', 'should-fix', 'must-fix'])
            .default('must-fix'),
        })
      : ComplaintFor(key).extend({
          severity: z
            .enum(['nit-pick', 'should-fix', 'must-fix'])
            .default('must-fix'),
          quote: z
            .string()
            .min(1)
            .refine(
              (quote) => ticket.includes(quote),
              'Quote the ticket verbatim',
            ),
        });
  return z.object({
    complaints: z
      .array(complaint)
      .refine(
        (items) => new Set(items.map(({ id }) => id)).size === items.length,
        'Complaint ids must be unique',
      ),
    previousIssues: z
      .array(
        z
          .object({
            id: previous.length
              ? z.enum(previous.map((issue) => issue.id))
              : z.string(),
            status: z.enum(['fixed', 'open', 'dismissed']),
            note: z.string().min(1),
          })
          .strict(),
      )
      .default([])
      .refine(
        (items) =>
          items.length === previous.length &&
          new Set(items.map((item) => item.id)).size === previous.length,
        'Verify every previous issue exactly once using its history id',
      ),
  });
}

export function FixReportFor(complaints: readonly { id: string }[]) {
  const ids = complaints.map(({ id }) => id);
  if (new Set(ids).size !== ids.length)
    throw new Error('Duplicate Complaint ids');
  return z.object({
    resolutions: z
      .array(
        z
          .object({
            id: z.enum(ids),
            status: z.enum(['fixed', 'disagreed']),
            note: z.string().min(1),
          })
          .strict(),
      )
      .refine(
        (resolutions) =>
          resolutions.length === ids.length &&
          new Set(resolutions.map(({ id }) => id)).size === ids.length,
        'Return exactly one Resolution per Complaint id',
      ),
  });
}

export type Resolution = z.infer<
  ReturnType<typeof FixReportFor>
>['resolutions'][number];

export const Check = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
    url: z.string().min(1),
    action: z.string().min(1),
    expected: z.string().min(1),
  })
  .strict();
export type Check = z.infer<typeof Check>;

export const Checks = z.object({
  checks: z
    .array(Check)
    .min(1)
    .refine(
      (checks) => new Set(checks.map(({ id }) => id)).size === checks.length,
      'Check ids must be unique',
    ),
});

export const Observation = z
  .object({
    url: z.string().url(),
    text: z.string().min(1),
    screenshots: z.array(z.string()),
  })
  .strict();
export type Observation = z.infer<typeof Observation>;

export function CheckResultsFor(
  checks: readonly { id: string }[],
  screenshotDir: string,
) {
  const ids = checks.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate Check ids');
  // Resolve both sides: a symlink inside the directory is not proof of provenance.
  const screenshot = z.string().refine((path) => {
    try {
      const canonical = realpathSync(path);
      const inside = relative(realpathSync(screenshotDir), canonical);
      return (
        inside !== '' &&
        inside !== '..' &&
        !inside.startsWith(`..${sep}`) &&
        !isAbsolute(inside) &&
        statSync(canonical).isFile()
      );
    } catch {
      return false;
    }
  }, 'Screenshot must exist inside ROCKY_SCREENSHOT_DIR');
  const common = {
    id: z.enum(ids),
    note: z.string().min(1),
    screenshots: z.array(screenshot),
  };
  return z.object({
    results: z
      .array(
        z.discriminatedUnion('verdict', [
          z
            .object({
              ...common,
              verdict: z.literal('ok'),
              observations: z.array(z.never()).length(0),
            })
            .strict(),
          z
            .object({
              ...common,
              verdict: z.literal('problem'),
              observations: z
                .array(Observation.extend({ screenshots: z.array(screenshot) }))
                .min(1),
            })
            .strict(),
        ]),
      )
      .refine(
        (results) =>
          results.length === ids.length &&
          new Set(results.map(({ id }) => id)).size === ids.length,
        'Return exactly one Check result per Check id',
      ),
  });
}

export const UiTriage = z
  .object({
    isFrontend: z.boolean(),
    recipe: z
      .object({ repository: z.string().min(1), id: z.string().min(1) })
      .strict()
      .optional(),
  })
  .strict();
export const CiFix = z.object({
  action: z.enum(['fixed', 'retry', 'unresolved']),
});

// Explicit ticket instructions select the route; missing fields fail closed.
export const Delivery = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('pull-request'),
      merge: z.boolean(),
      stateChanges: z.boolean(),
    })
    .strict(),
  z
    .object({ kind: z.literal('linear-comment'), stateChanges: z.boolean() })
    .strict(),
]);
export const Deliverable = z
  .object({ body: z.string().trim().min(1) })
  .strict();

export function DeliverableReviewFor(criteria: readonly string[]) {
  return z
    .object({
      assessments: z
        .array(
          z
            .object({
              criterion: z.enum(criteria),
              evidence: z.string().trim().min(1),
              problems: z.array(z.string().trim().min(1)),
            })
            .strict(),
        )
        .refine(
          (items) =>
            items.length === criteria.length &&
            new Set(items.map((item) => item.criterion)).size ===
              criteria.length,
          'Assess every acceptance criterion exactly once',
        ),
      problems: z.array(z.string().trim().min(1)),
    })
    .strict();
}

/** No path from an ambiguous ticket to implementation without a human answer. */
export const Refinement = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('questions'),
    reason: z.string().min(1),
    questions: z.array(z.string().min(1)).min(1).max(3),
  }),
  z.object({
    status: z.literal('clear'),
    delivery: Delivery,
    scope: z.string().min(1),
    decisions: z.array(z.string().min(1)).min(1),
    acceptanceCriteria: z
      .array(z.string().min(1))
      .min(1)
      .refine(
        (items) => new Set(items).size === items.length,
        'Acceptance criteria must be unique',
      ),
    outOfScope: z.array(z.string().min(1)),
  }),
]);

/** Evidence emitted by Rocky's bundled local parser, not an Agent assertion. */
export const DiagramValidation = z.object({
  ok: z.boolean(),
  rendered: z.literal(false),
  sha256: z.string().optional(),
  validator: z.string().optional(),
  diagrams: z.array(
    z.object({
      index: z.number().int().positive(),
      valid: z.boolean(),
      error: z.string().optional(),
    }),
  ),
});
