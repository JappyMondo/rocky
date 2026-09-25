import { z } from 'zod';
import type { RockyPaths } from '../config/paths.js';
import type { RunHeader } from './header.js';
import { readJournal } from './journal.js';

const answer = z.object({
  kind: z.literal('question'),
  stepKey: z.string(),
  title: z.string(),
  body: z.string(),
  answer: z.object({
    decision: z.literal('steer'),
    message: z.string().min(1),
  }),
  answeredAt: z.string().datetime(),
});
const controls = z.object({ checkpoints: z.array(z.unknown()) });

/** Freeze explicit human scope evidence at admission, never merge approvals. */
export async function priorClarifications(
  paths: RockyPaths,
  runs: RunHeader[],
  input: { issue: RunHeader['issue']; repo: string; profile?: { id: string } },
): Promise<NonNullable<RunHeader['issue']['clarifications']>> {
  const result: NonNullable<RunHeader['issue']['clarifications']> = [];
  for (const run of runs) {
    if (
      run.issue.identifier !== input.issue.identifier ||
      !input.issue.url ||
      run.issue.url !== input.issue.url ||
      run.repo !== input.repo ||
      run.profile?.id !== input.profile?.id ||
      !['finished', 'failed', 'cancelled'].includes(run.status)
    )
      continue;
    const journal = await readJournal(paths.run(run.runId).journal);
    const state = controls.safeParse(journal.getControl('linear:control'));
    if (!state.success) continue;
    for (const checkpoint of state.data.checkpoints) {
      const parsed = answer.safeParse(checkpoint);
      if (!parsed.success) continue;
      const value = parsed.data;
      result.push({
        runId: run.runId,
        stepKey: value.stepKey,
        title: value.title,
        question: value.body,
        answer: value.answer.message,
        answeredAt: value.answeredAt,
      });
    }
  }
  return result.sort(
    (a, b) =>
      a.answeredAt.localeCompare(b.answeredAt) ||
      a.runId.localeCompare(b.runId) ||
      a.stepKey.localeCompare(b.stepKey),
  );
}
