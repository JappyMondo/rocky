import {
  isFlowSource,
  validateFlow,
  flowTriggerNames,
  validateConfiguration,
  materializeConfiguration,
} from '@rocky/local-contracts';
/**
 * Repository profiles are the complete, machine-local coding pipeline.
 *
 * Nothing in this module accepts a checkout path on purpose. A target
 * repository is untrusted input: it cannot select, amend, or grant more to a
 * profile by placing files in `.rocky/` (or anywhere else) in Git.
 */
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { z } from 'zod';
import { sourceControlSchema } from './source-control-schema.js';
import {
  repositoryCommandSchema,
  devServiceSchema,
  environmentRecipeSchema,
  automationSchema,
} from './workspace-schema.js';

import { PUBLIC_MODE, serializeJson, writeAtomic } from '../atomic-write.js';
import { parseMcpConfig, type McpConfig } from '../mcp/config.js';
import type { RockyPaths } from './paths.js';
import { ConfigError } from './schema.js';
import type { WorkflowDefaults } from './schema.js';
import type { WorkflowModels } from '@rocky/local-contracts';
import {
  defaultWorkflowModels,
  validateWorkflowModels,
  workflowModelsSchema,
} from './workflow-models.js';

const segment = z
  .string()
  .regex(
    /^[A-Za-z0-9._-]+$/,
    'must be letters, digits, dot, dash and underscore only',
  )
  .refine((value) => value !== '.' && value !== '..', 'must not be . or ..');
export const profilePromptsSchema = z.record(segment, z.string());

const nonEmpty = z.string().min(1);

/** A portable, canonical comparison key for SSH, HTTPS and file remotes. */
export function canonicalRemote(remote: string): string {
  const value = remote
    .trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/, '');
  if (value.startsWith('file://')) {
    return `file://${value.slice('file://'.length).replace(/^\/+/, '/')}`;
  }
  if (/^[A-Za-z0-9.-]+\/[A-Za-z0-9._/-]+$/.test(value)) {
    return value.toLowerCase();
  }
  try {
    const url = new URL(value);
    if (url.protocol === 'file:') return `file://${url.pathname}`;
    return `${url.host.toLowerCase()}${url.pathname}`.toLowerCase();
  } catch {
    const scp = /^([^@/:]+@)?([^:/]+):(.+)$/.exec(value);
    if (scp) return `${scp[2].toLowerCase()}/${scp[3]}`.toLowerCase();
    throw new ConfigError(
      'profile',
      `remote ${JSON.stringify(remote)} is not a canonical SCM URL; use an SSH, HTTPS, or file remote.`,
    );
  }
}

/** Names are sibling folder names and shared clone identities on this machine. */
export const profileRepoSchema = z.strictObject({
  id: segment.optional(),
  commands: z.array(repositoryCommandSchema).optional(),
  services: z.array(devServiceSchema).optional(),
  environment: environmentRecipeSchema.optional(),
  ci: z.enum(['required', 'none']).optional(),
  sourceControl: sourceControlSchema.optional(),
  name: segment,
  url: nonEmpty.transform((value, ctx) => {
    const url = value.trim();
    try {
      if (/^[a-z]+:\/\//i.test(url)) {
        const parsed = new URL(url);
        if (
          parsed.password ||
          (/^https?:$/.test(parsed.protocol) && parsed.username)
        ) {
          ctx.addIssue({
            code: 'custom',
            message:
              'Use a remote without embedded credentials; Git uses your SSH agent or credential helper.',
          });
          return z.NEVER;
        }
      }
      canonicalRemote(url);
    } catch {
      ctx.addIssue({
        code: 'custom',
        message: 'Use an SSH, HTTPS, or file remote.',
      });
      return z.NEVER;
    }
    // The UI also accepts the canonical host/owner/repo shorthand.
    return /^[A-Za-z0-9.-]+\/[A-Za-z0-9._/-]+$/.test(url)
      ? `https://${url}`
      : url;
  }),
  baseBranch: nonEmpty,
});

export const profileReposSchema = z
  .array(profileRepoSchema)
  .min(1)
  .superRefine((repos, ctx) => {
    const names = new Set<string>();
    const remotes = new Set<string>();
    for (const [index, repo] of repos.entries()) {
      const name = repo.name.toLowerCase();
      const remote = canonicalRemote(repo.url);
      if (names.has(name) || remotes.has(remote))
        ctx.addIssue({
          code: 'custom',
          path: [index],
          message: 'Each repository needs a unique folder name and remote.',
        });
      names.add(name);
      remotes.add(remote);
    }
  });

export const profileSchema = z
  .strictObject({
    v: z.literal(1),
    id: segment,
    /** Canonical remote identity, not a mutable clone path. */
    remote: nonEmpty.transform(canonicalRemote).optional(),
    /** The first member is the primary repository for default SCM operations. */
    repos: profileReposSchema.optional(),
    configurationVersion: z.literal(1).optional(),
    automation: automationSchema.optional(),
    workflow: z.strictObject({
      source: nonEmpty,
      triggers: z.array(nonEmpty).default([]),
    }),
    models: workflowModelsSchema.optional(),
    sourceControl: sourceControlSchema.optional(),
    prompts: profilePromptsSchema.default({}),
    schemas: z.string().default(''),
    rules: z.record(segment, z.string()).default({}),
    /** Ecosystem MCP declarations, stored locally alongside the pipeline. */
    mcp: z.unknown().default({ mcpServers: {} }),
    grants: z
      .strictObject({
        harness: z
          .enum(['claude-code', 'opencode', 'codex'])
          .default('claude-code'),
        capabilities: z.array(z.enum(['read', 'edit', 'bash'])).default([]),
        mcp: z.array(nonEmpty).default([]),
      })
      .default({ harness: 'claude-code', capabilities: [], mcp: [] }),
    settings: z
      .strictObject({
        buildCommand: z.string().optional(),
        testCommand: z.string().optional(),
        uiCommand: z.string().optional(),
        env: z.record(nonEmpty, z.string()).default({}),
        /** Names only. Values belong in credentials.json / environment/keychain. */
        secretEnv: z.array(nonEmpty).default([]),
      })
      .default({ env: {}, secretEnv: [] }),
  })
  .superRefine((profile, ctx) => {
    if (!profile.repos && !profile.remote)
      ctx.addIssue({
        code: 'custom',
        path: ['repos'],
        message: 'Add at least one repository.',
      });
  })
  .transform((profile) => ({
    ...profile,
    // Preserve the legacy read surface; explicit membership is authoritative.
    remote: profile.repos
      ? canonicalRemote(profile.repos[0].url)
      : (profile.remote as string),
  }));

export type RepositoryProfile = z.infer<typeof profileSchema>;

export function parseRepositoryProfile(
  raw: unknown,
  file = 'profile',
): RepositoryProfile {
  const parsed = profileSchema.safeParse(raw);
  if (!parsed.success)
    throw new ConfigError(file, z.prettifyError(parsed.error));
  if (parsed.data.configurationVersion === 1) {
    if (!parsed.data.repos || !parsed.data.automation)
      throw new ConfigError(
        file,
        'Unified profiles need repositories and automation settings.',
      );
    try {
      validateConfiguration({
        repos: parsed.data.repos,
        automation: parsed.data.automation,
      });
    } catch (error) {
      throw new ConfigError(
        file,
        error instanceof Error ? error.message : String(error),
      );
    }
    if (
      parsed.data.settings.buildCommand ||
      parsed.data.settings.testCommand ||
      parsed.data.settings.uiCommand
    )
      throw new ConfigError(
        file,
        'Unified profiles store commands on repositories, not settings.buildCommand/testCommand/uiCommand.',
      );
  }
  // Parse eagerly so invalid or unsafe MCP input is rejected at profile edit,
  // rather than much later inside an agent attempt.
  parseMcpConfig(parsed.data.mcp, `${file} mcp`);
  if (isFlowSource(parsed.data.workflow.source)) {
    try {
      const flow = validateFlow(parsed.data.workflow.source);
      if (
        parsed.data.configurationVersion &&
        parsed.data.repos &&
        parsed.data.automation
      )
        materializeConfiguration(parsed.data.workflow.source, {
          repos: parsed.data.repos,
          automation: parsed.data.automation,
        });
      parsed.data.workflow.triggers = flowTriggerNames(flow);
    } catch (error) {
      throw new ConfigError(
        file,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  return parsed.data;
}

export function newRepositoryProfile(input: {
  id: string;
  remote?: string;
  repos?: z.input<typeof profileReposSchema>;
  workflow?: string;
}): RepositoryProfile {
  return parseRepositoryProfile(
    {
      v: 1,
      id: input.id,
      remote: input.remote,
      repos: input.repos,
      workflow: {
        source:
          input.workflow ?? 'export const models = {};\nexport default [];',
        triggers: [],
      },
    },
    `profiles/${input.id}.json`,
  );
}

/**
 * The shipped workflow is a local product default, not repository content.
 * It gives `rocky repo add` a runnable first-ticket pipeline while keeping the
 * full workflow, prompts, schemas, rules and MCP declaration in the profile
 * store from its first byte.
 */
export async function newSeedRepositoryProfile(input: {
  id: string;
  remote?: string;
  repos?: z.input<typeof profileReposSchema>;
  models: WorkflowModels;
}): Promise<RepositoryProfile> {
  const models = defaultWorkflowModels(
    workflowModelsSchema.parse(input.models),
  );
  const content = await defaultProfileContent({ ...Object.values(models)[0] });
  validateWorkflowModels(content.workflow.source, models);
  return parseRepositoryProfile(
    {
      ...newRepositoryProfile(input),
      ...content,
      models,
    },
    `profiles/${input.id}.json`,
  );
}

/** The same complete starting pipeline for CLI creation and the local editor. */
export async function defaultProfileContent(
  defaults: WorkflowDefaults = { harness: 'opencode' },
): Promise<Omit<RepositoryProfile, 'v' | 'id' | 'remote' | 'repos'>> {
  // Bundled CLI/API entries live directly in dist; source modules live in src/config.
  const packed = new URL('../content/.rocky/', import.meta.url);
  const directory = fileURLToPath(
    existsSync(packed)
      ? packed
      : new URL('../../content/.rocky/', import.meta.url),
  );
  const [workflow, schemas, mcp, agents, rules] = await Promise.all([
    readFile(join(directory, 'workflow.json'), 'utf8'),
    readFile(join(directory, 'schemas.ts'), 'utf8'),
    readFile(join(directory, 'mcp.json'), 'utf8'),
    readTextDirectory(join(directory, 'agents')),
    readTextDirectory(join(directory, 'rules')),
  ]);
  return {
    workflow: {
      source: workflow,
      triggers: ['linear.onDelegate', 'address-pr-conversations'],
    },
    prompts: agents,
    schemas,
    rules,
    mcp: JSON.parse(mcp) as unknown,
    grants: { harness: defaults.harness, capabilities: [], mcp: [] },
    settings: {
      env: {},
      // References only; values stay in this machine's credentials/environment.
      secretEnv: ['GITHUB_TOKEN', 'GH_TOKEN', 'GITLAB_TOKEN'],
    },
  };
}

async function readTextDirectory(
  directory: string,
): Promise<Record<string, string>> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  const values = await Promise.all(
    entries
      .filter((entry) => entry.endsWith('.md'))
      .sort()
      .map(
        async (entry) =>
          [
            entry.slice(0, -3),
            await readFile(join(directory, entry), 'utf8'),
          ] as const,
      ),
  );
  return Object.fromEntries(values);
}

export async function readRepositoryProfile(
  paths: RockyPaths,
  id: string,
): Promise<RepositoryProfile> {
  const file = paths.profile(id);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new ConfigError(
        file,
        'does not exist. Create it with `rocky repo add` or explicitly import a secret-safe profile.',
      );
    throw new ConfigError(file, 'cannot be read.');
  }
  try {
    const parsed = parseRepositoryProfile(JSON.parse(text), file);
    const workflow = await readFile(
      profileWorkflowPath(paths, parsed),
      'utf8',
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    return workflow === undefined
      ? parsed
      : parseRepositoryProfile(
          { ...parsed, workflow: { ...parsed.workflow, source: workflow } },
          file,
        );
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(file, 'is not valid JSON.');
  }
}

export async function writeRepositoryProfile(
  paths: RockyPaths,
  value: unknown,
): Promise<RepositoryProfile> {
  const candidate = value as { id?: string };
  const id = typeof candidate.id === 'string' ? candidate.id : 'unknown';
  const profile = parseRepositoryProfile(value, paths.profile(id));
  await Promise.all([
    writeAtomic(paths.profile(profile.id), serializeJson(profile), PUBLIC_MODE),
    writeAtomic(
      profileWorkflowPath(paths, profile),
      profile.workflow.source,
      PUBLIC_MODE,
    ),
  ]);
  return profile;
}

/** Explicit export deliberately carries no secret values; only references remain. */
export function exportRepositoryProfile(
  profile: RepositoryProfile,
): RepositoryProfile {
  return structuredClone(profile);
}

export async function listRepositoryProfiles(
  paths: RockyPaths,
): Promise<RepositoryProfile[]> {
  let files: string[];
  try {
    files = await readdir(paths.profilesDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return Promise.all(
    files
      .filter((file) => file.endsWith('.json'))
      .sort()
      .map((file) => readRepositoryProfile(paths, file.slice(0, -5))),
  );
}

/** The only MCP reader for a profile. No repository-local fallback exists. */
export function profileMcpConfig(
  profile: RepositoryProfile,
  file: string,
): McpConfig {
  return parseMcpConfig(profile.mcp, file);
}

/** JSON profiles never consult a leftover TypeScript override. */
export function profileWorkflowPath(
  paths: RockyPaths,
  profile: Pick<RepositoryProfile, 'id' | 'workflow'>,
): string {
  return isFlowSource(profile.workflow.source)
    ? join(paths.profilesDir, 'flows', `${segment.parse(profile.id)}.json`)
    : paths.profileWorkflow(profile.id);
}
