import { createHash, randomUUID } from 'node:crypto';
import { link, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { platform } from 'node:os';
import { promisify } from 'node:util';

import type { RepositoryProfileView } from '@rocky/local-contracts';
import { z } from 'zod';

import {
  listRepositoryProfiles,
  newRepositoryProfile,
  readRepositoryProfile,
  writeRepositoryProfile,
  type RepositoryProfile,
} from '../config/profiles.js';
import type { RockyPaths } from '../config/paths.js';
import { KeyedMutex } from '../repos/mutex.js';
import { LocalApiError } from './settings.js';
import { PUBLIC_MODE } from '../atomic-write.js';

const id = z.string().regex(/^[A-Za-z0-9._-]+$/);
const editable = z
  .object({
    id,
    remote: z.string().min(1),
    revision: z.string().optional(),
    workflow: z
      .object({
        source: z.string().min(1),
        triggers: z.array(z.string().min(1)),
      })
      .strict(),
    grants: z
      .object({
        harness: z.enum(['claude-code', 'opencode']),
        capabilities: z.array(z.enum(['read', 'edit', 'bash'])),
        mcp: z.array(z.string().min(1)),
      })
      .strict(),
  })
  .strict();

const updates = new KeyedMutex();
const deletion = z.object({ id, revision: z.string().min(1) }).strict();
const editor = z.enum(['default', 'vscode', 'zed']);

function revision(profile: RepositoryProfile): string {
  return createHash('sha256').update(JSON.stringify(profile)).digest('hex');
}

function view(profile: RepositoryProfile): RepositoryProfileView {
  return {
    id: profile.id,
    remote: profile.remote,
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

  async list(): Promise<RepositoryProfileView[]> {
    return (await listRepositoryProfiles(this.paths))
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(view);
  }

  async read(profileId: string): Promise<RepositoryProfileView> {
    return view(await readRepositoryProfile(this.paths, profileId));
  }

  async save(input: unknown): Promise<RepositoryProfileView> {
    const parsed = editable.safeParse(input);
    if (!parsed.success)
      throw new LocalApiError(
        400,
        'invalid-profile',
        'A profile needs a safe id, remote, workflow source, triggers, and OpenCode or Claude Code harness.',
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
        newRepositoryProfile({
          id: parsed.data.id,
          remote: parsed.data.remote,
          workflow: parsed.data.workflow.source,
        });
      const saved = await writeRepositoryProfile(this.paths, {
        ...base,
        remote: parsed.data.remote,
        workflow: parsed.data.workflow,
        grants: parsed.data.grants,
      });
      return view(saved);
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
