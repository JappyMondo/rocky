import type { RunSummary, StepView } from '@rocky/local-contracts';

export const isTerminalRun = (status: string) =>
  ['finished', 'failed', 'cancelled'].includes(status);

/** Parking can mean either human input or an automatically retried dependency. */
export function runState(run: RunSummary) {
  if (run.status === 'finished' && run.outcome === 'exhausted')
    return { value: 'failed', label: 'Needs attention' };
  if (run.status !== 'parked') return { value: run.status, label: undefined };
  if (/^scm[.:]waitForCi(?:[:.]|$)/.test(run.reason ?? ''))
    return { value: 'waiting', label: 'Waiting for CI' };
  if (/^(checkpoint|question)(?:[:.]|$)/.test(run.reason ?? ''))
    return { value: 'parked', label: 'Needs your input' };
  return { value: 'waiting', label: 'Waiting' };
}

export function activityName(step: StepView) {
  const name = step.label ?? step.step;
  if (name === 'workspace') return 'Prepare workspace';
  if (name === '$end') return 'Finish run';
  if (/^(scm[.:])?waitForCi/.test(name)) return 'Wait for CI';
  if (/git diff\b/.test(name)) return 'Inspect changes';
  if (/git status\b/.test(name)) return 'Check working tree';
  if (/git rev-parse\b/.test(name)) return 'Read commit';
  if (/git branch\b/.test(name)) return 'Check branch';
  if (/git push\b/.test(name)) return 'Push changes';
  if (name === 'changedFiles') return 'Find changed files';
  if (name === 'load rules') return 'Load review rules';
  return name;
}

export function recentActivity(
  steps: StepView[],
  run: RunSummary,
  expanded: (step: StepView) => boolean,
) {
  return steps.filter(
    (step, index) =>
      index >= steps.length - 5 ||
      expanded(step) ||
      step.status === 'failed' ||
      (!isTerminalRun(run.status) &&
        (step.status === 'running' || step.status === 'waiting')),
  );
}
