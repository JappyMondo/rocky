import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';

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
      await rm(this.paths.profile(parsed.data.id));
    });
  }
}
