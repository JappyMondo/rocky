import { z } from 'zod';
const id = z.string().regex(/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/);
const positive = z.number().int().min(1).max(86400000);
const common = {
  id,
  name: z.string().min(1),
  cwd: z.string(),
  policy: z.enum(['agent', 'required', 'manual']),
  description: z.string(),
  dependsOn: z.array(z.string()),
  env: z.record(z.string(), z.string()),
  endpointEnv: z
    .record(
      z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
      z.strictObject({
        service: z.string().min(1),
        endpoint: id,
      }),
    )
    .optional(),
};
export const repositoryCommandSchema = z.strictObject({
  ...common,
  purpose: z.enum(['install', 'test', 'lint', 'build', 'other']),
  command: z.string().min(1),
  timeoutMs: positive,
});
export const endpointSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('assigned-port'), url: z.string() }),
  z.strictObject({ kind: z.literal('fixed'), url: z.string() }),
  z.strictObject({
    kind: z.literal('output-regex'),
    pattern: z.string().max(1000),
  }),
  z.strictObject({
    kind: z.literal('json-file'),
    path: z.string(),
    pointer: z.string(),
  }),
  z.strictObject({ kind: z.literal('command'), command: z.string().min(1) }),
]);
export const devServiceSchema = z.strictObject({
  ...common,
  start: z.string().min(1),
  stop: z.string().optional(),
  portEnv: z.string(),

  endpoints: z
    .array(z.strictObject({ name: id, locator: endpointSchema }))
    .min(1),
  readiness: z.strictObject({
    endpoint: id,
    attempts: positive,
    intervalMs: positive,
  }),
});
export const automationSchema = z.strictObject({
  workspaceSetup: z.boolean().optional(),
  pullRequests: z.enum(['lead', 'all-changed']).optional(),
  states: z.strictObject({
    started: z.string().min(1),
    review: z.string().min(1),
    done: z.string().min(1),
  }),
  reviewCap: positive,
  ciCap: positive,
  ciLogLines: positive,
  maxTransitions: positive,
  readiness: z.strictObject({ attempts: positive, intervalMs: positive }),
});

export const environmentRecipeSchema = z.strictObject({
  version: z.literal(1),
  capabilities: z
    .array(
      z.strictObject({
        id,
        kind: z.enum([
          'runtime',
          'dependencies',
          'browser',
          'login',
          'fixture',
          'feature',
        ]),
        baseline: z.boolean(),
        sources: z
          .array(
            z.strictObject({
              path: z.string().min(1),
              section: z.string().max(200).optional(),
            }),
          )
          .min(1)
          .max(20),
        setup: z.array(z.string().min(1)).max(40),
        services: z.array(z.string().min(1)).max(20),
        verify: z.string().min(1),
        checks: z.array(id).min(1).max(40),
        authentication: z
          .strictObject({
            kind: z.enum(['documented-local', 'secret-env']),
            reference: z.string().min(1),
          })
          .optional(),
        fixture: z.enum(['simulated', 'real-integration']).optional(),
      }),
    )
    .max(40),
});
