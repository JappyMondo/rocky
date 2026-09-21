import { readFile } from 'node:fs/promises';
import type { SourceControlSettings } from '@rocky/local-contracts';
import type { RockyPaths } from '../config/paths.js';
import type { InstanceConfig } from '../config/schema.js';
import {
  resolveSourceControl,
  sourceControlSchema,
} from '../config/source-control.js';
import type { RunHeader } from './header.js';

/** Authentication is live configuration; workflow content remains snapshotted. */
export async function currentRunSourceControl(
  paths: RockyPaths,
  config: InstanceConfig,
  run: RunHeader,
  repository?: string,
): Promise<SourceControlSettings> {
  let overrides = run.profile?.sourceControl;
  let repoOverrides = run.profile?.repos?.find(
    (repo) => repo.name === repository,
  )?.sourceControl;
  if (run.profile) {
    try {
      // Read only connection settings: edits to workflow code must not change replay.
      const profile = JSON.parse(
        await readFile(paths.profile(run.profile.id), 'utf8'),
      );
      overrides = sourceControlSchema.parse(profile.sourceControl ?? {});
      if (repository) {
        const frozen = run.profile.repos?.find(
          (repo) => repo.name === repository,
        );
        const current = profile.repos?.find(
          (repo: { id?: string; name: string }) =>
            frozen?.id ? repo.id === frozen.id : repo.name === repository,
        );
        if (current)
          repoOverrides = sourceControlSchema.parse(
            current.sourceControl ?? {},
          );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // Older/imported Runs can outlive their local profile.
    }
  }
  return resolveSourceControl(
    {
      ...config.sourceControl,
      git: { ...config.identity, ...config.sourceControl?.git },
    },
    resolveSourceControl(overrides, repoOverrides),
  );
}
