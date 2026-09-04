/**
 * `~/.rocky/config.json` and `~/.rocky/credentials.json` as types (NG-578).
 *
 * Two files, JSON rather than TypeScript: the repo side is code because
 * Workflows are code, but the instance side is data Rocky itself rewrites from
 * the web UI. Hand-editing is legal, which is what every choice below is
 * shaped by — unknown keys survive, and everything that would be ambiguous at
 * routing time is a parse error naming the fix instead.
 */
import { z } from 'zod';

import { DEFAULT_HOST, DEFAULT_PORT } from '../server.js';

/** Thrown for anything wrong with either file, with a readable body. */
export class ConfigError extends Error {
  constructor(
    readonly file: string,
    message: string,
  ) {
    super(`${file}: ${message}`);
    this.name = 'ConfigError';
  }
}

/**
 * The harnesses Rocky ships an adapter for. NG-579 retired "configurable but
 * untested" as a category, so this list is exhaustive and a third harness is
 * an adapter contribution rather than a config key.
 */
export const SHIPPED_HARNESSES = ['claude-code', 'opencode'] as const;

/** Names become directory names under `~/.rocky` — see `paths.ts`. */
const segment = z
  .string()
  .regex(
    /^[A-Za-z0-9._-]+$/,
    'must be letters, digits, dot, dash and underscore only',
  )
  .refine((value) => value !== '.' && value !== '..', 'must not be . or ..');

const nonEmpty = z.string().min(1);

export const repoEntrySchema = z.looseObject({
  name: segment,
  url: nonEmpty,
  baseBranch: nonEmpty,
  /** Required: the Linear label that routes a delegation here. */
  label: nonEmpty,
  /** Optional second filter, ANDed with the label. */
  teams: z.array(nonEmpty).optional(),
  /** Injected into every Run on this repo. Secrets belong in credentials. */
  env: z.record(nonEmpty, z.string()).optional(),
});

export const repoGroupSchema = z.looseObject({
  name: segment,
  label: nonEmpty,
  /** Members, by repo-entry name. */
  repos: z.array(segment).min(1),
  /** The lead: the member whose `.rocky/` a grouped Run executes. */
  workflow: segment,
});

/** Per-harness account override. Values get `${VAR}` expansion (NG-579). */
export const harnessSchema = z.looseObject({
  command: nonEmpty.optional(),
  env: z.record(nonEmpty, z.string()).optional(),
});

/**
 * Who Rocky commits as. NG-580 asks for worktree-local `user.name`/`user.email`
 * = "the configured Rocky identity" but never says where that is configured,
 * and NG-578's `config.json` shape does not name it — so it lands here.
 *
 * Defaulted rather than required, because the alternative to a default is a
 * worktree that falls back to the machine's global git config, which is the one
 * outcome NG-521 rules out. It is deliberately *not* the developer's own
 * address: Rocky is the author, and the human's credit is the
 * `Co-authored-by:` trailer, which NG-580 keeps as prompt content.
 */
export const DEFAULT_IDENTITY = {
  name: 'Rocky',
  email: 'rocky@localhost',
} as const;

export const identitySchema = z.looseObject({
  name: nonEmpty.default(DEFAULT_IDENTITY.name),
  // `rocky@localhost` has no TLD, so `z.email()` would reject the default.
  // The check that earns its keep is the one git does not do: git accepts
  // `user.email = "Rocky"` and writes an unreplyable commit.
  email: nonEmpty
    .regex(/^[^\s<>@]+@[^\s<>@]+$/, 'must look like an email address')
    .default(DEFAULT_IDENTITY.email),
});

export const serverSchema = z.looseObject({
  host: nonEmpty.default(DEFAULT_HOST),
  port: z.number().int().min(0).max(65535).default(DEFAULT_PORT),
});

/** Count-based, two-tier, and editable from the web UI (NG-574). */
export const retentionSchema = z.looseObject({
  keepTerminalRuns: z.number().int().min(1).default(100),
  keepSessionsAndScreenshots: z.number().int().min(1).default(40),
});

const instanceConfigShape = z.looseObject({
  /** The stable public URL Linear's webhook points at. BYO — no tunnel. */
  publicUrl: z.url().optional(),
  // `prefault`, not `default`: the empty object has to be run through the
  // schema for the field defaults inside it to apply.
  server: serverSchema.prefault({}),
  retention: retentionSchema.prefault({}),
  identity: identitySchema.prefault({}),
  repos: z.array(repoEntrySchema).default([]),
  groups: z.array(repoGroupSchema).default([]),
  harnesses: z.record(nonEmpty, harnessSchema).default({}),
});

export type RepoEntry = z.infer<typeof repoEntrySchema>;
export type RepoGroup = z.infer<typeof repoGroupSchema>;
export type RockyIdentity = z.infer<typeof identitySchema>;
export type HarnessConfig = z.infer<typeof harnessSchema>;
export type InstanceConfig = z.infer<typeof instanceConfigShape>;

/** Routing labels are compared case-insensitively, as state names are. */
export function labelKey(label: string): string {
  return label.trim().toLowerCase();
}

/**
 * The checks that need more than one field. Every one of them exists to keep
 * the routing lookup total: a config that parses can always be resolved to at
 * most one destination, so a miss is a genuine miss.
 */
export const instanceConfigSchema = instanceConfigShape.superRefine(
  (config, ctx) => {
    const fail = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: 'custom', path, message });

    const repoNames = new Set<string>();
    for (const [index, repo] of config.repos.entries()) {
      if (repoNames.has(repo.name)) {
        fail(['repos', index, 'name'], `duplicate repo name "${repo.name}"`);
      }
      repoNames.add(repo.name);
    }

    const groupNames = new Set<string>();
    for (const [index, group] of config.groups.entries()) {
      if (groupNames.has(group.name)) {
        fail(['groups', index, 'name'], `duplicate group name "${group.name}"`);
      }
      groupNames.add(group.name);

      for (const [member, memberName] of group.repos.entries()) {
        if (!repoNames.has(memberName)) {
          fail(
            ['groups', index, 'repos', member],
            `"${memberName}" is not one of the repo entries`,
          );
        }
      }

      if (!group.repos.includes(group.workflow)) {
        fail(
          ['groups', index, 'workflow'],
          `workflow "${group.workflow}" must be one of the group's own repos`,
        );
      }
    }

    // One label, one destination — a repo may sit in several groups and stay
    // routable alone, but only because its own label is its own.
    const labels = new Map<string, string>();
    const claim = (label: string, owner: string, path: (string | number)[]) => {
      const key = labelKey(label);
      const taken = labels.get(key);
      if (taken) {
        fail(path, `label "${label}" is already routed to ${taken}`);
        return;
      }
      labels.set(key, owner);
    };

    for (const [index, repo] of config.repos.entries()) {
      claim(repo.label, `repo "${repo.name}"`, ['repos', index, 'label']);
    }
    for (const [index, group] of config.groups.entries()) {
      claim(group.label, `group "${group.name}"`, ['groups', index, 'label']);
    }

    for (const name of Object.keys(config.harnesses)) {
      if (!(SHIPPED_HARNESSES as readonly string[]).includes(name)) {
        fail(
          ['harnesses', name],
          `Rocky ships no adapter for "${name}" — it has ${SHIPPED_HARNESSES.join(' and ')}`,
        );
      }
    }

    if (
      config.retention.keepSessionsAndScreenshots >
      config.retention.keepTerminalRuns
    ) {
      fail(
        ['retention', 'keepSessionsAndScreenshots'],
        `keepSessionsAndScreenshots (${config.retention.keepSessionsAndScreenshots}) cannot exceed keepTerminalRuns (${config.retention.keepTerminalRuns})`,
      );
    }
  },
);

const linearCredentialsSchema = z.looseObject({
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  accessToken: z.string().optional(),
  refreshToken: z.string().optional(),
  webhookSecret: z.string().optional(),
  /**
   * The rest is written by `rocky setup` and by the client when it rotates a
   * token (NG-600). Access tokens last 24 hours and refresh tokens rotate on
   * use, so `expiresAt` is what stops every call finding out by 401.
   */
  expiresAt: z.number().int().optional(),
  scope: z.string().optional(),
  /**
   * Fixed at OAuth-app creation alongside the webhook URL, so it is recorded
   * rather than recomputed: moving the daemon's port breaks re-authorization
   * exactly as it breaks the webhook.
   */
  redirectUri: z.string().optional(),
  /**
   * Rocky's own user id in this workspace. Linear recommends storing it beside
   * the token; it is how a webhook is recognised as this app's (NG-567 §6).
   */
  appUserId: z.string().optional(),
  organizationId: z.string().optional(),
});

export const credentialsSchema = z.looseObject({
  linear: linearCredentialsSchema.optional(),
  /** Per-repo secret env, keyed by repo-entry name. */
  repos: z.record(nonEmpty, z.record(nonEmpty, z.string())).default({}),
  /** MCP tokens keyed by server URL. NG-583 owns the shape inside. */
  mcp: z.record(nonEmpty, z.unknown()).default({}),
});

export type Credentials = z.infer<typeof credentialsSchema>;

function parse<T>(schema: z.ZodType<T>, file: string, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(file, z.prettifyError(result.error));
  }
  return result.data;
}

export function parseInstanceConfig(raw: unknown): InstanceConfig {
  return parse(instanceConfigSchema, 'config.json', raw);
}

export function parseCredentials(raw: unknown): Credentials {
  return parse(credentialsSchema, 'credentials.json', raw);
}
