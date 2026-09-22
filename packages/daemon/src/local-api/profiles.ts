import { isFlowSource, parseFlow, validateFlow } from '@rocky/local-contracts';
import { flowSettingsFromSource } from '../flow/migration.js';
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
import { sourceControlSchema } from '../config/source-control.js';

import {
  listRepositoryProfiles,
  newRepositoryProfile,
  defaultProfileContent,
  profileWorkflowPath,
  profileReposSchema,
  profileSchema,
  profilePromptsSchema,
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
import {
  configurationView,
  mergeConfiguration,
  configurationPatchSchema,
} from './configuration.js';
import { ConfigError } from '../config/schema.js';
import type { EnvironmentOnboarding } from '../environment/onboarding.js';
import type { RecipeDiscovery } from '../recipe-discovery.js';
import { automationSchema } from '../config/workspace-schema.js';
import {
  proposeConfiguration,
  validateConfiguration,
  defaultFlowSettings,
  materializeConfiguration,
} from '@rocky/local-contracts';
import { parseInstanceConfig } from '../config/schema.js';
import { parseMcpConfig, mcpConfigSchema } from '../mcp/config.js';
import {
  readWorkflowModelSlots,
  validateWorkflowModels,
  workflowModelsSchema,
} from '../config/workflow-models.js';

const id = z.string().regex(/^[A-Za-z0-9._-]+$/);
export const profileEditSchema = z
  .object({
    id,
    remote: z.string().min(1).optional(),
    repos: profileReposSchema.optional(),
    configurationVersion: z.literal(1).optional(),
    automation: automationSchema.optional(),
    routing: z
      .strictObject({
        labels: z.array(z.string().trim().min(1)).min(1),
        teams: z.array(z.string().trim().min(1)),
        revision: z.string(),
      })
      .optional(),
    revision: z.string().optional(),
    models: workflowModelsSchema.optional(),
    promptContents: profilePromptsSchema.optional(),
    sourceControl: sourceControlSchema.optional(),
    workflow: z
      .object({
        source: z.string().min(1),
        triggers: z.array(z.string().min(1)),
      })
      .strict()
      .optional(),
    grants: z
      .object({
        harness: z.enum(['claude-code', 'opencode', 'codex']),
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

function modelMetadata(source: string) {
  try {
    return { modelSlots: readWorkflowModelSlots(source) };
  } catch (error) {
    return {
      modelError: error instanceof Error ? error.message : String(error),
    };
  }
}

function checkedModels(source: string, models: unknown) {
  try {
    return validateWorkflowModels(source, models);
  } catch (error) {
    throw new LocalApiError(
      400,
      'invalid-workflow-models',
      error instanceof Error ? error.message : String(error),
    );
  }
}

function view(profile: RepositoryProfile): RepositoryProfileView {
  const metadata = modelMetadata(profile.workflow.source);
  const slots = metadata.modelSlots;
  const models = slots
    ? Object.fromEntries(
        Object.entries(profile.models ?? {}).filter(([key]) =>
          Object.hasOwn(slots, key),
        ),
      )
    : profile.models;
  return {
    id: profile.id,
    remote: profile.remote,
    ...(profile.repos ? { repos: profile.repos } : {}),
    configurationVersion: profile.configurationVersion,
    automation: profile.automation,
    workflow: profile.workflow,
    models,
    ...metadata,
    grants: profile.grants,
    sourceControl: profile.sourceControl,
    promptContents: profile.prompts,
    prompts: Object.keys(profile.prompts).sort(),
    rules: Object.keys(profile.rules).sort(),
    secretEnv: profile.settings.secretEnv,
    revision: revision(profile),
  };
}

/** The profile editor deliberately exposes workflow settings, never env values. */
export class LocalProfiles {
  constructor(
    private readonly paths: RockyPaths,
    private readonly discovery?: RecipeDiscovery,
    private readonly environment?: EnvironmentOnboarding,
  ) {}

  async verifyEnvironment(profileId: string, action: 'read' | 'start') {
    if (!this.environment)
      throw new LocalApiError(
        503,
        'environment-unavailable',
        'Environment verification is unavailable.',
      );
    const profile = await readRepositoryProfile(this.paths, profileId);
    return action === 'start'
      ? this.environment.start(profile)
      : this.environment.read(profileId);
  }

  async discoverRecipes(
    profileId: string,
    repository: string,
    action: 'read' | 'start' | 'cancel',
  ) {
    if (!this.discovery)
      throw new LocalApiError(
        503,
        'discovery-unavailable',
        'Recipe discovery is unavailable.',
      );
    const profile = await readRepositoryProfile(this.paths, profileId);
    const view = await this.view(profile);
    const repo = view.repos?.find((member) => member.name === repository);
    if (!repo)
      throw new LocalApiError(
        404,
        'unknown-repository',
        'Save this repository in the profile before discovering commands.',
      );
    if (action === 'start') {
      if (!isFlowSource(profile.workflow.source))
        throw new LocalApiError(
          400,
          'unsupported-workflow',
          'Recipe discovery requires a Flow profile.',
        );
      return this.discovery.start(profile, repo);
    }
    return action === 'cancel'
      ? this.discovery.cancel(profileId, repository)
      : this.discovery.read(profileId, repository);
  }

  async configuration(profileId: string) {
    const profile = await readRepositoryProfile(this.paths, profileId);
    return {
      values: configurationView(profile),
      revision: revision(profile),
      schema: z.toJSONSchema(profileSchema, { io: 'input' }),
      mcpSchema: z.toJSONSchema(mcpConfigSchema),
    };
  }

  async configure(profileId: string, input: unknown) {
    const parsed = configurationPatchSchema.safeParse(input);
    if (!parsed.success)
      throw new LocalApiError(
        400,
        'invalid-profile',
        'Supply revision and a JSON merge patch.',
      );
    return updates.run(this.paths.profile(profileId), async () => {
      const existing = await readRepositoryProfile(this.paths, profileId);
      if (revision(existing) !== parsed.data.revision)
        throw new LocalApiError(
          409,
          'profile-changed',
          'Profile changed. Read it again before saving.',
        );
      let next;
      try {
        next = profileSchema.parse(
          mergeConfiguration(existing, parsed.data.patch),
        );
        if (next.id !== profileId) throw new Error('Profile id cannot change.');
        parseMcpConfig(next.mcp);
        if (isFlowSource(next.workflow.source))
          validateFlow(next.workflow.source);
        if (
          next.workflow.source !== existing.workflow.source ||
          JSON.stringify(next.models) !== JSON.stringify(existing.models)
        )
          next.models = checkedModels(next.workflow.source, next.models);
      } catch {
        throw new LocalApiError(
          400,
          'invalid-profile',
          'Invalid profile. Check its schema, workflow, model slots and MCP declarations.',
        );
      }
      if (
        revision(await readRepositoryProfile(this.paths, profileId)) !==
        parsed.data.revision
      )
        throw new LocalApiError(
          409,
          'profile-changed',
          'Profile changed while saving. Read it again.',
        );
      await writeRepositoryProfile(this.paths, next);
      return this.configuration(profileId);
    });
  }

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

  async resetWorkflow(
    profileId: string,
    input: unknown,
  ): Promise<RepositoryProfileView> {
    const parsed = z
      .object({ revision: z.string().min(1), models: workflowModelsSchema })
      .strict()
      .safeParse(input);
    if (!parsed.success)
      throw new LocalApiError(
        400,
        'invalid-profile-reset',
        'Resetting a workflow requires its current revision and explicit model and variant/effort choices for every declared slot.',
      );
    return updates.run(this.paths.profile(profileId), async () => {
      const profile = await readRepositoryProfile(this.paths, profileId);
      if (parsed.data.revision !== revision(profile))
        throw new LocalApiError(
          409,
          'profile-changed',
          'This profile changed. Reload it before resetting; your edits were not applied.',
        );
      const content = await defaultProfileContent(
        Object.values(parsed.data.models)[0],
      );
      let workflow = content.workflow;
      try {
        const flow = parseFlow(content.workflow.source);
        flow.settings = flowSettingsFromSource(profile.workflow.source);
        flow.settings.workspaceSetup = true;
        workflow = {
          ...workflow,
          source:
            JSON.stringify(validateFlow(JSON.stringify(flow)), null, 2) + '\n',
        };
      } catch (error) {
        throw new LocalApiError(
          409,
          'invalid-workflow-config',
          error instanceof Error ? error.message : String(error),
        );
      }
      const models = checkedModels(workflow.source, parsed.data.models);
      return this.view(
        await writeRepositoryProfile(this.paths, {
          ...profile,
          workflow,
          models,
          prompts: content.prompts,
          schemas: content.schemas,
        }),
      );
    });
  }

  modelSlots(input: unknown) {
    const parsed = z
      .strictObject({ source: z.string().min(1) })
      .safeParse(input);
    if (!parsed.success)
      throw new LocalApiError(
        400,
        'invalid-workflow',
        'Supply workflow source.',
      );
    const metadata = modelMetadata(parsed.data.source);
    if (metadata.modelError)
      throw new LocalApiError(
        400,
        'invalid-workflow-models',
        metadata.modelError,
      );
    return metadata;
  }

  async defaults(): Promise<RepositoryProfileDefaults> {
    const config = await readInstanceConfig(this.paths);
    const content = await defaultProfileContent(config.workflowDefaults);
    const suggestion = {
      harness: config.workflowDefaults.harness,
      model: config.workflowDefaults.model,
      effort: config.workflowDefaults.effort,
    };
    return {
      workflow: content.workflow,
      grants: content.grants,
      promptContents: content.prompts,
      prompts: Object.keys(content.prompts).sort(),
      rules: Object.keys(content.rules).sort(),
      secretEnv: content.settings.secretEnv,
      modelSlots: readWorkflowModelSlots(content.workflow.source),
      modelSuggestions: Object.fromEntries(
        Object.keys(readWorkflowModelSlots(content.workflow.source)).map(
          (key) => [key, suggestion],
        ),
      ),
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
    if (
      !profile.configurationVersion &&
      result.repos &&
      isFlowSource(profile.workflow.source)
    ) {
      result.configurationMigration = proposeConfiguration({
        repos: result.repos,
        source: profile.workflow.source,
        settings: profile.settings,
      });
    }
    return result;
  }

  async save(input: unknown): Promise<RepositoryProfileView> {
    let parsed;
    try {
      parsed = profileEditSchema.safeParse(input);
    } catch (error) {
      if (error instanceof ConfigError)
        throw new LocalApiError(400, 'invalid-profile', error.message);
      throw error;
    }
    if (!parsed.success)
      throw new LocalApiError(
        400,
        'invalid-profile',
        'A profile needs a safe id and repositories with unique folder names and remotes. Workflow and harness settings must be valid when provided.',
      );
    return updates.run(this.paths.configFile, () =>
      updates.run(this.paths.profile(parsed.data.id), async () => {
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
        if (!existing && !parsed.data.remote && !parsed.data.repos)
          throw new LocalApiError(
            400,
            'invalid-profile',
            'A new profile needs at least one repository.',
          );
        if (!existing && !parsed.data.models)
          throw new LocalApiError(
            400,
            'model-selection-required',
            'Choose the harness, model and variant/effort for every declared model slot before creating a profile.',
          );
        const base = existing ?? {
          ...newRepositoryProfile({
            id: parsed.data.id,
            remote: parsed.data.remote,
            repos: parsed.data.repos,
          }),
          ...(await defaultProfileContent()),
        };
        let workflow = parsed.data.workflow ?? base.workflow;
        if (isFlowSource(workflow.source)) {
          try {
            validateFlow(workflow.source);
          } catch (error) {
            throw new LocalApiError(
              400,
              'invalid-flow',
              error instanceof Error ? error.message : String(error),
            );
          }
        }
        // Legacy profiles stay editable until explicitly migrated or reset. New
        // workflows and model edits must satisfy the named-slot contract.
        const models =
          !existing ||
          parsed.data.models !== undefined ||
          workflow.source !== base.workflow.source
            ? checkedModels(workflow.source, parsed.data.models ?? base.models)
            : base.models;
        const configurationVersion =
          parsed.data.configurationVersion ?? base.configurationVersion;
        const repos = parsed.data.repos ?? base.repos;
        const automation = parsed.data.automation ?? base.automation;
        if (configurationVersion) {
          if (!repos || !automation)
            throw new LocalApiError(
              400,
              'invalid-configuration',
              'Repositories and automation are required.',
            );
          try {
            validateConfiguration({ repos, automation });
            if (isFlowSource(workflow.source))
              materializeConfiguration(workflow.source, { repos, automation });
          } catch (error) {
            throw new LocalApiError(
              400,
              'invalid-configuration',
              error instanceof Error ? error.message : String(error),
            );
          }
          if (isFlowSource(workflow.source)) {
            const flow = JSON.parse(workflow.source);
            flow.settings = defaultFlowSettings();
            workflow = {
              ...workflow,
              source: JSON.stringify(flow, null, 2) + '\n',
            };
          }
        }
        const config = parsed.data.routing
          ? await readInstanceConfig(this.paths)
          : undefined;
        let nextConfig = config;
        if (config && parsed.data.routing) {
          const route = parsed.data.routing;
          if (
            route.revision !==
            createHash('sha256').update(JSON.stringify(config)).digest('hex')
          )
            throw new LocalApiError(
              409,
              'routing-changed',
              'Routing changed. Reload before saving; no profile edits were applied.',
            );
          const primary = repos?.[0];
          if (!primary)
            throw new LocalApiError(
              400,
              'invalid-routing',
              'Choose a primary repository.',
            );
          const previous = config.repos.find(
            (repo) => repo.profile === base.id,
          );
          const next = {
            ...previous,
            name: primary.name,
            url: primary.url,
            baseBranch: primary.baseBranch,
            label: route.labels[0],
            labels: route.labels.slice(1),
            teams: route.teams,
            profile: base.id,
          };
          // The legacy schema requires a nonempty labels array when present.
          if (!next.labels.length)
            delete (next as { labels?: string[] }).labels;
          try {
            nextConfig = parseInstanceConfig({
              ...config,
              repos: [
                ...config.repos.filter((repo) => repo.profile !== base.id),
                next,
              ],
            });
          } catch {
            throw new LocalApiError(
              400,
              'invalid-routing',
              'Those labels conflict with another repository or group. No profile edits were applied.',
            );
          }
        }
        const saved = await writeRepositoryProfile(this.paths, {
          ...base,
          configurationVersion,
          automation,
          settings: configurationVersion
            ? { env: base.settings.env, secretEnv: base.settings.secretEnv }
            : base.settings,
          sourceControl: parsed.data.sourceControl ?? base.sourceControl,
          remote: parsed.data.remote ?? base.remote,
          ...(parsed.data.repos ? { repos: parsed.data.repos } : {}),
          workflow,
          models,
          grants: parsed.data.grants ?? base.grants,
          prompts: parsed.data.promptContents ?? base.prompts,
        });
        if (nextConfig && config) {
          try {
            await writeInstanceConfig(this.paths, nextConfig);
          } catch (error) {
            if (existing) await writeRepositoryProfile(this.paths, existing);
            throw error;
          }
        }
        return this.view(saved);
      }),
    );
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
        rm(
          profileWorkflowPath(this.paths, {
            id: parsed.data.id,
            workflow: { source: '{}', triggers: [] },
          }),
          { force: true },
        ),
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
    const file = profileWorkflowPath(this.paths, await this.read(profileId));
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
