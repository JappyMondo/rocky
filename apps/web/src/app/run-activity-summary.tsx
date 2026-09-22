import { useEffect, useState } from 'react';
import type { RunDetail, StepView } from '@rocky/local-contracts';
import { activityName, isTerminalRun, runState } from './run-presentation.js';
import { Status } from './ui.js';
import styles from './app.module.css';

export function RunActivitySummary({
  detail,
  reveal,
}: {
  detail: RunDetail;
  reveal: (step: StepView) => void;
}) {
  const { run, steps, checkpoint } = detail;
  const terminal = isTerminalRun(run.status);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (terminal) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [terminal]);
  const needsInput = !terminal && checkpoint && !checkpoint.answer;
  const active = !terminal
    ? steps.filter((step) => ['running', 'waiting'].includes(step.status))
    : [];
  const current =
    active.at(-1) ??
    (run.status === 'failed'
      ? steps.findLast((step) => step.status === 'failed')
      : undefined) ??
    steps.at(-1);
  const state =
    detail.recovery?.status === 'running'
      ? { value: 'running', label: 'Recovering' }
      : needsInput
        ? { value: 'parked', label: 'Needs your input' }
        : runState(run);
  const title = needsInput
    ? checkpoint.title
    : detail.recovery?.status === 'running'
      ? 'Recovery agent is working'
      : run.status === 'finished'
        ? run.outcome === 'exhausted'
          ? 'Workflow stopped with unresolved work'
          : run.outcome === 'rejected'
            ? 'Review rejected'
            : run.outcome === 'merged'
              ? 'Changes merged'
              : 'Run completed'
        : run.status === 'cancelled'
          ? 'Run cancelled'
          : current
            ? `${current.stage ? `${current.stage} · ` : ''}${activityName(current)}`
            : run.status === 'queued'
              ? 'Waiting to start'
              : 'Starting workflow';
  const minutes = Math.max(
    0,
    Math.floor(
      ((terminal ? Date.parse(run.endedAt ?? '') : now) -
        Date.parse(run.createdAt)) /
        60000,
    ),
  );
  return (
    <section className={styles.currentActivity} aria-label="Current run state">
      <div className={styles.currentActivityText}>
        <Status {...state} />
        <strong title={title}>{title}</strong>
        {!terminal && current?.status === 'running' && current.liveSummary && (
          <span className={styles.currentPreview} title={current.liveSummary}>
            {current.liveSummary}
          </span>
        )}
        <small>
          {Number.isFinite(minutes) &&
            `${minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`} elapsed · `}
          {steps.filter((step) => step.status === 'done').length} steps
          completed
          {active.length > 1 && ` · ${active.length} active steps`}
        </small>
      </div>
      {needsInput ? (
        <a className={styles.buttonLink} href="#run-checkpoint">
          View request
        </a>
      ) : current ? (
        <button onClick={() => reveal(current)}>
          {terminal ? 'View latest step' : 'Jump to current activity'}
        </button>
      ) : null}
    </section>
  );
}
