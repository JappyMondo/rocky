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
): Promise<SourceControlSettings> {
  let overrides = run.profile?.sourceControl;
  if (run.profile) {
    try {
      // Read only connection settings: edits to workflow code must not change replay.
      const profile = JSON.parse(
        await readFile(paths.profile(run.profile.id), 'utf8'),
      );
      overrides = sourceControlSchema.parse(profile.sourceControl ?? {});
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
    overrides,
  );
}
