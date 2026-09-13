import { stat } from 'node:fs/promises';
import { z } from 'zod';
import { restoreRetryWorkspace } from '../repos/workspace.js';
import type { RepoContext } from '../repos/context.js';
import type { RunHeader } from './header.js';
import type { JournalEntry } from './journal.js';

const workspaceResult = z.object({
  members: z.array(
    z.object({ repo: z.string(), head: z.string().regex(/^[a-f0-9]{40,64}$/) }),
  ),
});
export async function prepareRetryWorkspace(
  repos: RepoContext,
  run: RunHeader,
  entries: readonly JournalEntry[],
): Promise<void> {
  if (!run.execution || run.artifactsPruned)
    throw new Error(
      'This Run no longer has the execution artifacts required to retry. Start a new Run.',
    );
  if (
    !(await stat(repos.paths.run(run.runId).snapshotDir).then(
      (s) => s.isDirectory(),
      () => false,
    ))
  )
    throw new Error('The Workflow snapshot is missing; start a new Run.');
  const workspace = entries.findLast(
    (entry) => entry.step === 'workspace' && entry.status === 'done',
  );
  const recorded = workspaceResult.safeParse(workspace?.result);
  if (!recorded.success)
    throw new Error(
      'No recorded workspace is available for a safe Step retry.',
    );
  await restoreRetryWorkspace(repos, {
    runId: run.runId,
    branch: run.branch,
    members: run.execution.members.map((member) => {
      const saved = recorded.data.members.find(
        (item) => item.repo === member.name,
      );
      if (!saved)
        throw new Error(`No recorded workspace revision for ${member.name}.`);
      return { name: member.name, head: saved.head };
    }),
  });
}
