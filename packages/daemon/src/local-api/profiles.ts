import { createHash, randomUUID } from 'node:crypto';
import { link, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { platform } from 'node:os';
import { promisify } from 'node:util';

import type {
  RepositoryProfileView,
  RepositoryProfileDefaults,
  ProfileRoutingView,
  McpProfileView,
} from '@rocky/local-contracts';
import { z } from 'zod';

import {
  listRepositoryProfiles,
  newSeedRepositoryProfile,
  defaultProfileContent,
  profileReposSchema,
  canonicalRemote,
  readRepositoryProfile,
  writeRepositoryProfile,
  type RepositoryProfile,
} from '../config/profiles.js';
import type { RockyPaths } from '../config/paths.js';
import { KeyedMutex } from '../repos/mutex.js';
import { LocalApiError } from './settings.js';
import { PUBLIC_MODE } from '../atomic-write.js';
import { readInstanceConfig, writeInstanceConfig } from '../config/store.js';
import { ConfigError } from '../config/schema.js';
import { parseMcpConfig } from '../mcp/config.js';

const id = z.string().regex(/^[A-Za-z0-9._-]+$/);
const editable = z
  .object({
    id,
    remote: z.string().min(1).optional(),
    repos: profileReposSchema.optional(),
    revision: z.string().optional(),
    workflow: z
      .object({
        source: z.string().min(1),
        triggers: z.array(z.string().min(1)),
      })
      .strict()
      .optional(),
    grants: z
      .object({
        harness: z.enum(['claude-code', 'opencode']),
        capabilities: z.array(z.enum(['read', 'edit', 'bash'])),
        mcp: z.array(z.string().min(1)),
      })
      .strict()
      .optional(),
  })
  .strict();

const updates = new KeyedMutex();
const deletion = z.object({ id, revision: z.string().min(1) }).strict();
const editor = z.enum(['default', 'vscode', 'zed']);
const routingInput = z
  .object({
    labels: z.array(z.string().min(1).max(100)).min(1).max(100),
    teams: z.array(z.string().min(1).max(100)).max(100),
    revision: z.string(),
  })
  .strict();

function revision(profile: RepositoryProfile): string {
  return createHash('sha256').update(JSON.stringify(profile)).digest('hex');
}

function view(profile: RepositoryProfile): RepositoryProfileView {
  return {
    id: profile.id,
    remote: profile.remote,
    ...(profile.repos ? { repos: profile.repos } : {}),
    workflow: profile.workflow,
    grants: profile.grants,
    prompts: Object.keys(profile.prompts).sort(),
    rules: Object.keys(profile.rules).sort(),
    secretEnv: profile.settings.secretEnv,
    revision: revision(profile),
  };
}

/** The profile editor deliberately exposes workflow settings, never env values. */
export class LocalProfiles {
  constructor(private readonly paths: RockyPaths) {}

  async mcp(profileId: string): Promise<McpProfileView> {
    const profile = await readRepositoryProfile(this.paths, profileId);
    const config = parseMcpConfig(profile.mcp);
    const hide = (fields: Record<string, string> | undefined) =>
      fields &&
      Object.fromEntries(
        Object.entries(fields).map(([key, value]) => [
          key,
          /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value) ? value : null,
        ]),
      );
    return {
      id: profile.id,
      revision: revision(profile),
      servers: Object.entries(config.mcpServers).map(([name, server]) => ({
        name,
        allowed: profile.grants.mcp.includes(name),
        definition:
          server.type === 'stdio'
            ? { ...server, env: hide(server.env) }
            : { ...server, headers: hide(server.headers) },
        auth: {
          state: 'not-configured',
          message:
            server.type === 'stdio'
              ? 'Local process'
              : 'No saved OAuth credentials',
        },
      })),
    };
  }

  async saveMcp(
    profileId: string,
    name: string,
    input: unknown,
    remove = false,
  ): Promise<McpProfileView> {
    const parsed = z
      .object({
        revision: z.string(),
        definition: z.unknown().optional(),
        allowed: z.boolean().optional(),
      })
      .strict()
      .safeParse(input);
    if (
      !parsed.success ||
      !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(name) ||
      ['__proto__', 'constructor', 'prototype'].includes(name)
    )
      throw new LocalApiError(
        400,
        'invalid-mcp',
        'Enter a valid server name and definition.',
      );
    await updates.run(this.paths.profile(profileId), async () => {
      const profile = await readRepositoryProfile(this.paths, profileId);
      if (revision(profile) !== parsed.data.revision)
        throw new LocalApiError(
          409,
          'profile-changed',
          'This profile changed. Reload before saving MCP settings.',
        );
      const config = parseMcpConfig(profile.mcp);
      if (remove) {
        delete config.mcpServers[name];
        profile.grants.mcp = profile.grants.mcp.filter(
          (value) => value !== name,
        );
      } else {
        const raw = z
          .record(z.string(), z.unknown())
          .safeParse(parsed.data.definition);
        if (!raw.success)
          throw new LocalApiError(
            400,
            'invalid-mcp',
            'Enter a server definition.',
          );
        const definition = { ...raw.data };
        const old = config.mcpServers[name];
        for (const field of ['env', 'headers'] as const) {
          if (definition[field] === undefined) continue;
          const values = z
            .record(z.string(), z.string().nullable())
            .safeParse(definition[field]);
          if (!values.success)
            throw new LocalApiError(
              400,
              'invalid-mcp',
              'Environment and header values must be strings.',
            );
          definition[field] = Object.fromEntries(
            Object.entries(values.data).map(([key, value]) => {
              const previous =
                old && field in old
                  ? (
                      old as {
                        env?: Record<string, string>;
                        headers?: Record<string, string>;
                      }
                    )[field]?.[key]
                  : undefined;
              if (value === null && previous === undefined)
                throw new LocalApiError(
                  400,
                  'invalid-mcp',
                  'A new header or environment entry needs a value.',
                );
              return [key, value ?? previous];
            }),
          );
        }
        try {
          if (
            typeof definition.url === 'string' &&
            !definition.url.includes('${')
          ) {
            const url = new URL(definition.url);
            if (!['http:', 'https:'].includes(url.protocol))
              throw new Error('Invalid MCP URL');
          }
          config.mcpServers[name] = parseMcpConfig({
            mcpServers: { [name]: definition },
          }).mcpServers[name];
        } catch {
          throw new LocalApiError(
            400,
            'invalid-mcp',
            'Use a stdio command or an HTTP/SSE URL with valid arguments, headers and environment values.',
          );
        }
        if (parsed.data.allowed === true && !profile.grants.mcp.includes(name))
          profile.grants.mcp.push(name);
        if (parsed.data.allowed === false)
          profile.grants.mcp = profile.grants.mcp.filter(
            (value) => value !== name,
          );
      }
      await writeRepositoryProfile(this.paths, {
        ...profile,
        mcp: { mcpServers: config.mcpServers },
      });
    });
    return this.mcp(profileId);
  }

  async defaults(): Promise<RepositoryProfileDefaults> {
    const config = await readInstanceConfig(this.paths);
    const content = await defaultProfileContent(config.workflowDefaults);
    return {
      workflow: content.workflow,
      grants: content.grants,
      prompts: Object.keys(content.prompts).sort(),
      rules: Object.keys(content.rules).sort(),
      secretEnv: content.settings.secretEnv,
    };
  }

  async list(): Promise<RepositoryProfileView[]> {
    return Promise.all(
      (await listRepositoryProfiles(this.paths))
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((profile) => this.view(profile)),
    );
  }

  async read(profileId: string): Promise<RepositoryProfileView> {
    try {
      return this.view(await readRepositoryProfile(this.paths, profileId));
    } catch (error) {
      if (
        error instanceof ConfigError &&
        error.message.includes('does not exist.')
      )
        throw new LocalApiError(404, 'unknown-profile', 'Profile not found.');
      throw error;
    }
  }

  async routing(profileId: string): Promise<ProfileRoutingView> {
    const profile = await readRepositoryProfile(this.paths, profileId);
    const config = await readInstanceConfig(this.paths);
    const repo = config.repos.find(
      (candidate) => candidate.profile === profile.id,
    );
    return {
      profileId,
      labels: repo ? [repo.label, ...(repo.labels ?? [])] : [profile.id],
      teams: repo?.teams ?? [],
      revision: createHash('sha256')
        .update(JSON.stringify(config))
        .digest('hex'),
    };
  }

  async saveRouting(
    profileId: string,
    input: unknown,
  ): Promise<ProfileRoutingView> {
    const parsed = routingInput.safeParse(input);
    if (!parsed.success)
      throw new LocalApiError(
        400,
        'invalid-routing',
        'Enter at least one Linear label and optional team names.',
      );
    return updates.run(this.paths.configFile, async () => {
      const profile = await readRepositoryProfile(this.paths, profileId);
      const config = await readInstanceConfig(this.paths);
      const before = createHash('sha256')
        .update(JSON.stringify(config))
        .digest('hex');
      if (before !== parsed.data.revision)
        throw new LocalApiError(
          409,
          'routing-changed',
          'Routing changed. Reload the profile before saving.',
        );
      const primary = profile.repos?.[0] ?? {
        name: profile.id,
        url: profile.remote,
        baseBranch: 'main',
      };
      const index = config.repos.findIndex(
        (candidate) => candidate.profile === profile.id,
      );
      const route = {
        name: primary.name,
        url: primary.url,
        baseBranch: primary.baseBranch,
        label: parsed.data.labels[0].trim(),
        ...(parsed.data.labels.length > 1
          ? {
              labels: parsed.data.labels
                .slice(1)
                .map((label) => label.trim())
                .filter(Boolean),
            }
          : {}),
        profile: profile.id,
        ...(parsed.data.teams.length
          ? {
              teams: parsed.data.teams
                .map((team) => team.trim())
                .filter(Boolean),
            }
          : {}),
      };
      const next = {
        ...config,
        repos:
          index < 0
            ? [...config.repos, route]
            : config.repos.map((candidate, position) =>
                position === index ? { ...candidate, ...route } : candidate,
              ),
      };
      try {
        await writeInstanceConfig(this.paths, next);
      } catch {
        throw new LocalApiError(
          400,
          'invalid-routing',
          'One of those labels is already used by another repository or group. Choose unique labels.',
        );
      }
      return this.routing(profileId);
    });
  }

  private async view(
    profile: RepositoryProfile,
  ): Promise<RepositoryProfileView> {
    const result = view(profile);
    if (!result.repos) {
      const config = await readInstanceConfig(this.paths);
      const member = config.repos.find(
        (repo) =>
          repo.profile === profile.id &&
          canonicalRemote(repo.url) === profile.remote,
      );
      if (member)
        result.repos = [
          { name: member.name, url: member.url, baseBranch: member.baseBranch },
        ];
    }
    return result;
  }

  async save(input: unknown): Promise<RepositoryProfileView> {
    let parsed;
    try {
      parsed = editable.safeParse(input);
    } catch (error) {
      if (error instanceof ConfigError)
        throw new LocalApiError(400, 'invalid-profile', error.message);
      throw error;
    }
    if (!parsed.success || (!parsed.data.remote && !parsed.data.repos))
      throw new LocalApiError(
        400,
        'invalid-profile',
        'A profile needs a safe id and repositories with unique folder names and remotes. Workflow and harness settings must be valid when provided.',
      );
    return updates.run(this.paths.profile(parsed.data.id), async () => {
      let existing: RepositoryProfile | undefined;
      try {
        existing = await readRepositoryProfile(this.paths, parsed.data.id);
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !error.message.includes('does not exist')
        )
          throw error;
      }
      if (existing && parsed.data.revision !== revision(existing))
        throw new LocalApiError(
          409,
          'profile-changed',
          'This profile changed. Reload it before saving; your edits were not applied.',
        );
      if (!existing && parsed.data.revision !== undefined)
        throw new LocalApiError(
          409,
          'profile-changed',
          'This profile no longer exists. Reload before saving.',
        );
      const base =
        existing ??
        (await newSeedRepositoryProfile({
          id: parsed.data.id,
          remote: parsed.data.remote,
          repos: parsed.data.repos,
          defaults: (await readInstanceConfig(this.paths)).workflowDefaults,
        }));
      const saved = await writeRepositoryProfile(this.paths, {
        ...base,
        remote: parsed.data.remote,
        ...(parsed.data.repos ? { repos: parsed.data.repos } : {}),
        workflow: parsed.data.workflow ?? base.workflow,
        grants: parsed.data.grants ?? base.grants,
      });
      return this.view(saved);
    });
  }

  async delete(input: unknown): Promise<void> {
    const parsed = deletion.safeParse(input);
    if (!parsed.success)
      throw new LocalApiError(
        400,
        'invalid-profile-delete',
        'Deleting a profile requires its id and current revision.',
      );
    await updates.run(this.paths.profile(parsed.data.id), async () => {
      let existing: RepositoryProfile;
      try {
        existing = await readRepositoryProfile(this.paths, parsed.data.id);
      } catch (error) {
        if (error instanceof Error && error.message.includes('does not exist'))
          throw new LocalApiError(
            404,
            'profile-not-found',
            'Profile not found.',
          );
        throw error;
      }
      if (parsed.data.revision !== revision(existing))
        throw new LocalApiError(
          409,
          'profile-changed',
          'This profile changed. Reload it before deleting; nothing was removed.',
        );
      await Promise.all([
        rm(this.paths.profile(parsed.data.id)),
        rm(this.paths.profileWorkflow(parsed.data.id), { force: true }),
      ]);
    });
  }

  /** Opens only the known workflow file for an existing local profile. */
  async openWorkflow(profileId: string, requested: unknown): Promise<void> {
    const selected = editor.safeParse(requested);
    if (!selected.success)
      throw new LocalApiError(
        400,
        'invalid-editor',
        'Choose a supported local editor.',
      );
    const file = this.paths.profileWorkflow(profileId);
    await updates.run(this.paths.profile(profileId), async () => {
      const profile = await this.read(profileId);
      // Profiles created before workflow files were introduced still carry
      // their source in JSON. Publish a complete file without replacing any
      // existing file (including edits made outside Rocky).
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, profile.workflow.source, {
          flag: 'wx',
          mode: PUBLIC_MODE,
        });
        await link(temporary, file).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error;
        });
      } finally {
        await rm(temporary, { force: true });
      }
    });
    const apps = {
      vscode: 'Visual Studio Code',
      zed: 'Zed',
    } as const;
    const app = selected.data === 'default' ? undefined : apps[selected.data];
    const command = platform() === 'darwin' ? 'open' : 'xdg-open';
    const args =
      platform() === 'darwin'
        ? app
          ? ['-a', app, file]
          : ['-t', file]
        : [file];
    // Starting `open` is not success: it can subsequently reject a missing
    // file or app. Wait for the launcher to acknowledge the handoff.
    await promisify(execFile)(command, args, {
      timeout: 15_000,
      maxBuffer: 64 * 1024,
    }).catch(() => {
      throw new LocalApiError(
        503,
        'editor-unavailable',
        `Rocky could not open ${app ?? 'the default text editor'}. Check that it is installed, or choose another editor. Workflow: ${file}`,
      );
    });
  }
}
