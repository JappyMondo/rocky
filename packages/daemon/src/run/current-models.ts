import type { WorkflowModels } from '@rocky/local-contracts';

import { readRepositoryProfile } from '../config/profiles.js';
import { validateWorkflowModels } from '../config/workflow-models.js';
import type { RockyPaths } from '../config/paths.js';
import type { RunHeader } from './header.js';

/**
 * Model selections are live operational configuration. The workflow that
 * names their slots stays fixed for the Run, so a changed profile cannot
 * introduce a new slot into an existing workflow.
 */
export async function currentRunModels(
  paths: RockyPaths,
  run: RunHeader,
): Promise<WorkflowModels | undefined> {
  if (!run.profile) return undefined;

  const profile = await readRepositoryProfile(paths, run.profile.id);
  try {
    return validateWorkflowModels(run.profile.workflow.source, profile.models);
  } catch (error) {
    throw new Error(
      `${run.runId}: current profile ${profile.id} does not configure the Run's model slots: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
