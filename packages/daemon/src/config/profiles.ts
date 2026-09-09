/**
 * Repository profiles are the complete, machine-local coding pipeline.
 *
 * Nothing in this module accepts a checkout path on purpose. A target
 * repository is untrusted input: it cannot select, amend, or grant more to a
 * profile by placing files in `.rocky/` (or anywhere else) in Git.
 */
import { readdir, readFile } from 'node:fs/promises';

import { z } from 'zod';

import { PUBLIC_MODE, serializeJson, writeAtomic } from '../atomic-write.js';
import { parseMcpConfig, type McpConfig } from '../mcp/config.js';
import type { RockyPaths } from './paths.js';
import { ConfigError } from './schema.js';

const segment = z
  .string()
  .regex(
    /^[A-Za-z0-9._-]+$/,
    'must be letters, digits, dot, dash and underscore only',
  )
  .refine((value) => value !== '.' && value !== '..', 'must not be . or ..');
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

const profileSchema = z.strictObject({
  v: z.literal(1),
  id: segment,
  /** Canonical remote identity, not a mutable clone path. */
  remote: nonEmpty.transform(canonicalRemote),
  workflow: z.strictObject({
    source: nonEmpty,
    triggers: z.array(nonEmpty).default([]),
  }),
  prompts: z.record(segment, z.string()).default({}),
  schemas: z.string().default(''),
  rules: z.record(segment, z.string()).default({}),
  /** Ecosystem MCP declarations, stored locally alongside the pipeline. */
  mcp: z.unknown().default({ mcpServers: {} }),
  grants: z
    .strictObject({
      harness: z.enum(['claude-code', 'opencode']).default('claude-code'),
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
});

export type RepositoryProfile = z.infer<typeof profileSchema>;

export function parseRepositoryProfile(
  raw: unknown,
  file = 'profile',
): RepositoryProfile {
  const parsed = profileSchema.safeParse(raw);
  if (!parsed.success)
    throw new ConfigError(file, z.prettifyError(parsed.error));
  // Parse eagerly so invalid or unsafe MCP input is rejected at profile edit,
  // rather than much later inside an agent attempt.
  parseMcpConfig(parsed.data.mcp, `${file} mcp`);
  return parsed.data;
}

export function newRepositoryProfile(input: {
  id: string;
  remote: string;
  workflow?: string;
}): RepositoryProfile {
  return parseRepositoryProfile(
    {
      v: 1,
      id: input.id,
      remote: input.remote,
      workflow: {
        source: input.workflow ?? 'export default [];',
        triggers: [],
      },
    },
    `profiles/${input.id}.json`,
  );
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
    return parseRepositoryProfile(JSON.parse(text), file);
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
  await writeAtomic(
    paths.profile(profile.id),
    serializeJson(profile),
    PUBLIC_MODE,
  );
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
