import { readCredentials } from '../config/store.js';
import { sourceControlEnv } from '../config/source-control.js';
import { stat } from 'node:fs/promises';
import { z } from 'zod';
import { restoreRetryWorkspace } from '../repos/workspace.js';
import { repairCloneWorktreeConfig } from '../repos/clone.js';
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
  options: { continueExhausted?: true } = {},
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
  // Allocation itself can fail before there is a workspace revision to restore.
  // Retry that idempotent first step; never use this exception after work began.
  const allocation = entries.findLast((entry) => entry.step === 'workspace');
  if (
    !workspace &&
    allocation?.seq === 0 &&
    allocation.status === 'failed' &&
    entries.every(
      (entry) =>
        (entry.seq === 0 && entry.step === 'workspace') ||
        entry.step === '$end',
    )
  )
    return;
  const recorded = workspaceResult.safeParse(workspace?.result);
  if (!recorded.success)
    throw new Error(
      'No recorded workspace is available for a safe Step retry.',
    );
  for (const member of run.execution.members)
    await repairCloneWorktreeConfig(repos, member.name);
  await restoreRetryWorkspace(
    run.profile?.sourceControl
      ? {
          ...repos,
          sourceControl: run.profile?.sourceControl,
          env: sourceControlEnv(run.profile?.sourceControl, {
            ...process.env,
            ...(await readCredentials(repos.paths)).repos[run.repo],
          }),
        }
      : repos,
    {
      runId: run.runId,
      branch: run.branch,
      ...(options.continueExhausted ? { allowBranchAdvance: true } : {}),
      members: run.execution.members.map((member) => {
        const saved = recorded.data.members.find(
          (item) => item.repo === member.name,
        );
        if (!saved)
          throw new Error(`No recorded workspace revision for ${member.name}.`);
        return { name: member.name, head: saved.head };
      }),
    },
  );
}
