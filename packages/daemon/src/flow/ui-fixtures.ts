import { z } from '@rocky/sdk';
import type { Check } from './schemas.js';

export function uiFixturesSchema(checks: readonly Check[], commands: string[]) {
  const ids = checks.map((check) => check.id);
  return z.discriminatedUnion('status', [
    z.object({
      status: z.literal('ready'),
      fixtures: z
        .array(
          z.object({
            id: z.enum(ids),
            url: z
              .string()
              .refine(
                (url) => url.startsWith('/') && !url.startsWith('//'),
                'Use a path relative to the verified UI service',
              ),
            instructions: z.string().min(1),
            repository: z.string().min(1),
            source: z.string().min(1),
            executed: z.literal(true),
            screenshot: z.string().min(1),
          }),
        )
        .refine(
          (fixtures) =>
            fixtures.length === ids.length &&
            new Set(fixtures.map((fixture) => fixture.id)).size === ids.length,
          'Provide exactly one prepared fixture for every planned check',
        ),
      summary: z.string(),
    }),
    z.object({
      status: z.literal('setup'),
      commands: z.array(z.enum(commands)).min(1),
      summary: z.string(),
    }),
    z.object({
      status: z.literal('blocked'),
      reason: z.enum(['environment', 'credentials', 'permission', 'external']),
      summary: z.string().min(1),
    }),
  ]);
}
export type UiFixtures = z.infer<ReturnType<typeof uiFixturesSchema>>;

/** Separate from product review: setup, repair, and fresh readiness evidence
 * are bounded here, before an inspector can produce product complaints. */
export async function prepareUiFixtures(options: {
  prepare(attempt: number, previous?: string): Promise<UiFixtures>;
  setup(commands: string[], attempt: number): Promise<void>;
  verify(
    fixtures: Extract<UiFixtures, { status: 'ready' }>['fixtures'],
  ): Promise<void>;
}): Promise<UiFixtures> {
  let previous: string | undefined;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = await options.prepare(attempt, previous);
    if (result.status === 'blocked') {
      if (result.reason !== 'environment') return result;
      previous = result.summary;
      continue;
    }
    if (result.status === 'setup') {
      // Setup must be followed by another preparation/probe pass.
      if (attempt === 3) break;
      await options.setup(result.commands, attempt);
      previous = `Configured setup completed: ${result.commands.join(', ')}. Recheck every fixture against the current services.`;
      continue;
    }
    try {
      await options.verify(result.fixtures);
      return result;
    } catch (error) {
      previous = `Fixture readiness did not verify: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return {
    status: 'blocked',
    reason: 'environment',
    summary:
      previous ??
      'Fixture preparation did not produce verified readiness within its separate recovery allowance.',
  };
}
